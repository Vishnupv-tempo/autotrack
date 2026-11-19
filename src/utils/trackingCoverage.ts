import type {
  BackgroundPlayerTrackRecord,
  CoverageKind,
  CoverageSegment,
  CoverageSummary,
  DetectedPlayerBox,
  ImplementedTrackRecord,
  TimeInterval,
  TrackedPlayer,
} from '../types/tracking';

const SAMPLE_STEP_SEC = 0.05;

/**
 * Merges sorted timestamps into contiguous intervals, splitting whenever
 * consecutive samples are separated by more than `maxGapSec`.
 */
export function computeContiguousIntervals(
  times: number[],
  maxGapSec = 0.35,
  minSpanSec = 0.06
): TimeInterval[] {
  if (times.length === 0) return [];
  const sorted = times.slice().sort((a, b) => a - b);
  const intervals: TimeInterval[] = [];
  let start = sorted[0];
  let prev = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const t = sorted[i];
    if (t - prev > maxGapSec) {
      intervals.push({
        start,
        end: Math.max(start + minSpanSec, prev),
      });
      start = t;
    }
    prev = t;
  }

  intervals.push({
    start,
    end: Math.max(start + minSpanSec, prev),
  });

  return intervals;
}

interface TrackIntervalRecord {
  id: string;
  source: 'auto' | 'manual' | 'tool';
  intervals: TimeInterval[];
}

function isTimeInIntervals(intervals: TimeInterval[], t: number, pad = 0.04): boolean {
  for (let i = 0; i < intervals.length; i++) {
    const iv = intervals[i];
    if (t >= iv.start - pad && t <= iv.end + pad) return true;
    if (iv.start - pad > t) break;
  }
  return false;
}

/**
 * Builds a unified temporal coverage map across the clip, distinguishing:
 * - 'full': full-frame / all-players sweep active
 * - 'partial': only manually drawn boxes, single-#Track, or individual CV telestration tools
 * - 'untracked': no tracked coverage at that time
 */
export function analyzeTrackingCoverage(params: {
  duration: number;
  currentTime: number;
  backgroundTracks: BackgroundPlayerTrackRecord[];
  implementedTracks: ImplementedTrackRecord[];
  detectedBoxes: DetectedPlayerBox[];
  fullSweepTimes: number[];
  players: TrackedPlayer[];
}): CoverageSummary {
  const {
    duration,
    currentTime,
    backgroundTracks,
    implementedTracks,
    detectedBoxes,
    fullSweepTimes,
    players,
  } = params;

  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  if (safeDuration <= 0) {
    return {
      segments: [],
      trackedSeconds: 0,
      fullSeconds: 0,
      partialSeconds: 0,
      untrackedSeconds: 0,
      coveragePct: 0,
      currentKind: 'untracked',
      currentSegment: null,
      nextGapTime: null,
      untrackedGapCount: 0,
    };
  }

  const activeRecords =
    backgroundTracks.length > 0 ? backgroundTracks : implementedTracks;

  const trackIntervals: TrackIntervalRecord[] = [];
  for (const rec of activeRecords) {
    const times = rec.positions.map((p) => p.time);
    const intervals = computeContiguousIntervals(times, 0.35, 0.08);
    if (intervals.length > 0) {
      trackIntervals.push({
        id: rec.id,
        source: rec.source,
        intervals,
      });
    }
  }

  // Include current-frame paused detected boxes that haven't been stepped yet
  const recordedIds = new Set(trackIntervals.map((r) => r.id));
  for (const box of detectedBoxes) {
    if (recordedIds.has(box.id)) continue;
    trackIntervals.push({
      id: box.id,
      source: box.source,
      intervals: [
        {
          start: Math.max(0, box.time - 0.06),
          end: Math.min(safeDuration, box.time + 0.06),
        },
      ],
    });
  }

  // Include CV-tracked manual telestration tools (Box, Spotlight, 3D Ring, Polygon)
  const toolIntervals: TrackIntervalRecord[] = [];
  for (const p of players) {
    if (p.trackWithCv === false || p.attachedTrackId) continue;
    if (p.nodes && p.nodes.length > 0) {
      const nodeTimes = p.nodes.flatMap((n) => n.history.map((pt) => pt.time));
      const ivs = computeContiguousIntervals(nodeTimes, 0.35, 0.08);
      if (ivs.length > 0) {
        toolIntervals.push({ id: p.id, source: 'tool', intervals: ivs });
      }
    } else if (p.history.length > 0) {
      const ivs = computeContiguousIntervals(
        p.history.map((pt) => pt.time),
        0.35,
        0.08
      );
      if (ivs.length > 0) {
        toolIntervals.push({ id: p.id, source: 'tool', intervals: ivs });
      }
    }
  }

  const fullSweepIntervals = computeContiguousIntervals(fullSweepTimes, 0.3, 0.08);
  const autoRecordCount = trackIntervals.filter((r) => r.source === 'auto').length;

  const numBins = Math.max(1, Math.min(1200, Math.ceil(safeDuration / SAMPLE_STEP_SEC)));
  const binDur = safeDuration / numBins;

  const segments: CoverageSegment[] = [];

  for (let i = 0; i < numBins; i++) {
    const binStart = i * binDur;
    const binEnd = Math.min(safeDuration, (i + 1) * binDur);
    const tMid = (binStart + binEnd) * 0.5;

    let autoCount = 0;
    let manualCount = 0;
    let toolCount = 0;

    for (let r = 0; r < trackIntervals.length; r++) {
      const rec = trackIntervals[r];
      if (isTimeInIntervals(rec.intervals, tMid)) {
        if (rec.source === 'auto') autoCount++;
        else manualCount++;
      }
    }

    for (let ti = 0; ti < toolIntervals.length; ti++) {
      if (isTimeInIntervals(toolIntervals[ti].intervals, tMid)) {
        toolCount++;
      }
    }

    const playerCount = autoCount + manualCount;
    const isFullSweepAtT = isTimeInIntervals(fullSweepIntervals, tMid, 0.06);

    let kind: CoverageKind = 'untracked';
    if (
      (isFullSweepAtT && (autoCount >= 1 || playerCount >= 2)) ||
      (autoCount >= 2 && autoRecordCount >= 2)
    ) {
      kind = 'full';
    } else if (playerCount > 0 || toolCount > 0) {
      kind = 'partial';
    }

    const prev = segments[segments.length - 1];
    if (
      prev &&
      prev.kind === kind &&
      (kind === 'untracked' ||
        (Math.abs(prev.playerCount - playerCount) <= 1 &&
          (prev.toolCount > 0) === (toolCount > 0)))
    ) {
      prev.end = binEnd;
      prev.playerCount = Math.max(prev.playerCount, playerCount);
      prev.autoCount = Math.max(prev.autoCount, autoCount);
      prev.manualCount = Math.max(prev.manualCount, manualCount);
      prev.toolCount = Math.max(prev.toolCount, toolCount);
    } else {
      segments.push({
        start: binStart,
        end: binEnd,
        kind,
        playerCount,
        autoCount,
        manualCount,
        toolCount,
      });
    }
  }

  // Merge adjacent segments of the same kind for clean visual blocks
  const mergedSegments: CoverageSegment[] = [];
  for (const seg of segments) {
    const last = mergedSegments[mergedSegments.length - 1];
    if (last && last.kind === seg.kind) {
      last.end = seg.end;
      last.playerCount = Math.max(last.playerCount, seg.playerCount);
      last.autoCount = Math.max(last.autoCount, seg.autoCount);
      last.manualCount = Math.max(last.manualCount, seg.manualCount);
      last.toolCount = Math.max(last.toolCount, seg.toolCount);
    } else {
      mergedSegments.push({ ...seg });
    }
  }

  let fullSeconds = 0;
  let partialSeconds = 0;
  let untrackedSeconds = 0;
  let untrackedGapCount = 0;

  for (const seg of mergedSegments) {
    const dur = Math.max(0, seg.end - seg.start);
    if (seg.kind === 'full') fullSeconds += dur;
    else if (seg.kind === 'partial') partialSeconds += dur;
    else {
      untrackedSeconds += dur;
      if (dur >= 0.08) untrackedGapCount++;
    }
  }

  const trackedSeconds = fullSeconds + partialSeconds;
  const coveragePct =
    safeDuration > 0 ? Math.min(100, Math.round((trackedSeconds / safeDuration) * 100)) : 0;

  const clampedT = Math.max(0, Math.min(safeDuration, currentTime));
  const currentSegment =
    mergedSegments.find((s) => clampedT >= s.start - 0.02 && clampedT <= s.end + 0.02) ?? null;
  const currentKind: CoverageKind = currentSegment?.kind ?? 'untracked';

  const untrackedGaps = mergedSegments.filter(
    (s) => s.kind === 'untracked' && s.end - s.start >= 0.08
  );
  const nextGapAhead = untrackedGaps.find((g) => g.start > clampedT + 0.08);
  const nextGapTime =
    nextGapAhead?.start ??
    (untrackedGaps.length > 0 && currentKind !== 'untracked' ? untrackedGaps[0].start : null);

  return {
    segments: mergedSegments,
    trackedSeconds,
    fullSeconds,
    partialSeconds,
    untrackedSeconds,
    coveragePct,
    currentKind,
    currentSegment,
    nextGapTime,
    untrackedGapCount,
  };
}
