import { buildChromaTargets, computePixelFgAlphaFast, type ChromaTargets } from './chromaKey';
import type { PlayerDetector } from './playerDetector';
import { CvPlayerTracker, type FrameData } from './playerTracker';
import type {
  BackgroundPlayerTrackRecord,
  ChromaKeySettings,
  CirclePosition,
  CvTrackerSettings,
  DetectedPlayerBox,
} from '../types/tracking';

interface BoxAppearanceModel {
  upperR: number;
  upperG: number;
  upperB: number;
  lowerR: number;
  lowerG: number;
  lowerB: number;
  width: number;
  height: number;
  hasKit: boolean;
}

interface PendingEntryCandidate {
  cx: number;
  cy: number;
  width: number;
  height: number;
  confidence: number;
  hits: number;
  firstTime: number;
  lastTime: number;
}

interface SuppressionZone {
  cx: number;
  cy: number;
  halfW: number;
  halfH: number;
  radius: number;
  time: number;
  app?: BoxAppearanceModel;
}

interface BoxMotionFilter {
  cx: number;
  cy: number;
  w: number;
  h: number;
  vxPx: number;
  vyPx: number;
  vwPx: number;
  vhPx: number;
  lastTime: number;
}

/**
 * Slow, high-accuracy Tracking-by-Detection engine for detected player boxes.
 * - Combines CvPlayerTracker (ZNCC + 2-band HSV + camera pan compensation + Kalman) with
 *   fresh pitch-interior PlayerDetector detections + 1-to-1 torso kit/size/spatial matching.
 * - Applies camera-compensated One-Euro filtering (zero pan lag, zero sprint lag, zero micro-jitter)
 *   plus zero-phase Savitzky-Golay history smoothing and Catmull-Rom replay interpolation.
 * - Removes tracker boxes cleanly when players exit the camera frame.
 * - Detects and starts tracking new players as soon as they enter the frame.
 * - Supports mid-track pause -> erase / draw corrections -> resume from updated boxes.
 */
export class DetectedBoxSlowTracker {
  private cvTracker: CvPlayerTracker;
  private detector: PlayerDetector;
  private histories = new Map<string, CirclePosition[]>();
  private smoothedHistories = new Map<string, CirclePosition[]>();
  private manualKeyframeTimes = new Map<string, number[]>();
  private motionFilters = new Map<string, BoxMotionFilter>();
  private boxSources = new Map<string, 'auto' | 'manual'>();
  private appearances = new Map<string, BoxAppearanceModel>();
  private missCounts = new Map<string, number>();
  private edgeMissCounts = new Map<string, number>();
  private pendingEntries: PendingEntryCandidate[] = [];
  private suppressionZones: SuppressionZone[] = [];
  private fullSweepTimes: number[] = [];
  private entrySeq = 1;

  constructor(detector: PlayerDetector) {
    this.cvTracker = new CvPlayerTracker();
    this.detector = detector;
  }

  reset(): void {
    this.cvTracker.reset();
    this.histories.clear();
    this.smoothedHistories.clear();
    this.manualKeyframeTimes.clear();
    this.motionFilters.clear();
    this.boxSources.clear();
    this.appearances.clear();
    this.missCounts.clear();
    this.edgeMissCounts.clear();
    this.pendingEntries = [];
    this.suppressionZones = [];
    this.fullSweepTimes = [];
  }

  hasHistories(): boolean {
    return this.histories.size > 0;
  }

  syncBoxes(activeIds: string[]): void {
    const keep = new Set(activeIds);
    this.cvTracker.syncPlayers(activeIds);
    for (const id of this.appearances.keys()) {
      if (!keep.has(id)) this.appearances.delete(id);
    }
    for (const id of this.missCounts.keys()) {
      if (!keep.has(id)) this.missCounts.delete(id);
    }
    for (const id of this.edgeMissCounts.keys()) {
      if (!keep.has(id)) this.edgeMissCounts.delete(id);
    }
    for (const id of this.motionFilters.keys()) {
      if (!keep.has(id)) this.motionFilters.delete(id);
    }
  }

  private getSmoothedHistory(boxId: string): CirclePosition[] {
    const raw = this.histories.get(boxId);
    if (!raw || raw.length === 0) return [];
    const cached = this.smoothedHistories.get(boxId);
    if (cached && cached.length === raw.length) {
      return cached;
    }
    const smoothed = zeroPhaseSmoothBoxHistory(raw);
    this.smoothedHistories.set(boxId, smoothed);
    return smoothed;
  }

  getHistory(boxId: string): CirclePosition[] {
    return this.getSmoothedHistory(boxId);
  }

  getAllHistories(): Map<string, CirclePosition[]> {
    const out = new Map<string, CirclePosition[]>();
    for (const id of this.histories.keys()) {
      out.set(id, this.getSmoothedHistory(id));
    }
    return out;
  }

  /**
   * Returns complete background position records for every tracked player across the clip
   * (including players who already exited the frame), sorted by first appearance time.
   */
  getAllTrackRecords(): BackgroundPlayerTrackRecord[] {
    const records: BackgroundPlayerTrackRecord[] = [];
    for (const id of this.histories.keys()) {
      const hist = this.getSmoothedHistory(id);
      if (hist.length === 0) continue;
      records.push({
        id,
        source: this.boxSources.get(id) ?? 'auto',
        firstTime: hist[0].time,
        lastTime: hist[hist.length - 1].time,
        positions: hist.map((pt) => ({ ...pt })),
      });
    }
    records.sort((a, b) => a.firstTime - b.firstTime);
    return records;
  }

  getFullSweepTimes(): number[] {
    return this.fullSweepTimes.slice();
  }

  private recordFullSweepTime(time: number): void {
    if (!Number.isFinite(time) || time < 0) return;
    const n = this.fullSweepTimes.length;
    if (n === 0) {
      this.fullSweepTimes.push(time);
      return;
    }
    const last = this.fullSweepTimes[n - 1];
    if (time > last + 0.015) {
      this.fullSweepTimes.push(time);
      if (this.fullSweepTimes.length > 2400) {
        this.fullSweepTimes = this.fullSweepTimes.slice(-2400);
      }
      return;
    }
    if (Math.abs(time - last) <= 0.015) {
      this.fullSweepTimes[n - 1] = time;
      return;
    }
    if (!this.fullSweepTimes.some((t) => Math.abs(t - time) <= 0.015)) {
      this.fullSweepTimes.push(time);
      this.fullSweepTimes.sort((a, b) => a - b);
      if (this.fullSweepTimes.length > 2400) {
        this.fullSweepTimes = this.fullSweepTimes.slice(-2400);
      }
    }
  }

  /**
   * Called when user erases a box while paused so it is deleted cleanly and
   * auto-entry won't immediately respawn a box on or right next to the erased spot.
   */
  handleUserEraseBox(box: DetectedPlayerBox, time: number): void {
    const prevApp = this.appearances.get(box.id);
    this.cvTracker.removePlayer(box.id);
    this.appearances.delete(box.id);
    this.missCounts.delete(box.id);
    this.edgeMissCounts.delete(box.id);
    this.motionFilters.delete(box.id);
    this.smoothedHistories.delete(box.id);
    this.manualKeyframeTimes.delete(box.id);
    this.histories.delete(box.id);
    this.boxSources.delete(box.id);
    if (this.histories.size === 0) {
      this.fullSweepTimes = [];
    }

    const suppressRadius = Math.max(0.042, Math.hypot(box.width, box.height) * 1.1);
    this.pendingEntries = this.pendingEntries.filter((p) => {
      const dx = Math.abs(p.cx - box.cx);
      const dy = Math.abs(p.cy - box.cy);
      const nearBox =
        dx <= box.width * 0.5 + p.width * 0.5 + 0.024 &&
        dy <= box.height * 0.5 + p.height * 0.5 + 0.024;
      return !nearBox && Math.hypot(dx, dy) > suppressRadius;
    });

    this.suppressionZones = [
      ...this.suppressionZones.filter((z) => Math.abs(time - z.time) <= 6.0).slice(-31),
      {
        cx: box.cx,
        cy: box.cy,
        halfW: box.width * 0.5,
        halfH: box.height * 0.5,
        radius: suppressRadius,
        time,
        app: prevApp,
      },
    ];
  }

  /**
   * Called when user manually adds/finds a box while paused so it is immediately ready
   * for replay and subsequent slow tracking.
   */
  handleUserAddBox(
    box: DetectedPlayerBox,
    video: HTMLVideoElement | null,
    chromaKey: ChromaKeySettings
  ): void {
    this.boxSources.set(box.id, box.source);
    const pos: CirclePosition = {
      cx: box.cx,
      cy: box.cy,
      width: box.width,
      height: box.height,
      radius: Math.max(box.width, box.height) * 0.5,
      confidence: box.confidence,
      status: 'anchored',
      time: box.time,
    };
    this.histories.set(box.id, [pos]);
    this.smoothedHistories.delete(box.id);
    this.manualKeyframeTimes.set(box.id, [box.time]);
    this.motionFilters.set(box.id, createBoxMotionFilter(pos));
    this.missCounts.set(box.id, 0);
    this.edgeMissCounts.set(box.id, 0);

    // Clear any prior suppression zone near this new user-drawn box
    this.suppressionZones = this.suppressionZones.filter(
      (z) => Math.hypot(z.cx - box.cx, z.cy - box.cy) > Math.max(z.radius, 0.03)
    );

    if (video && video.readyState >= 2) {
      const frame = this.cvTracker.captureFrame(video);
      if (frame) {
        this.cvTracker.anchorPlayer(box.id, frame, pos, true);
        this.appearances.set(box.id, extractBoxAppearance(frame, box, chromaKey));
      }
    }
  }

  /**
   * Manually repositions or resizes an existing detected/tracked box at `box.time`,
   * applying a C1 cubic smoothstep delta blend over nearby past & future frames
   * (respecting neighboring manual keyframes) and re-anchoring the CV template & appearance.
   */
  handleUserCorrectBox(
    box: DetectedPlayerBox,
    video: HTMLVideoElement | null,
    chromaKey: ChromaKeySettings,
    smoothWindowSec = 0.45
  ): void {
    this.boxSources.set(box.id, box.source);
    const tFix = box.time;
    const correctedPos: CirclePosition = {
      cx: clamp(box.cx, 0.002, 0.998),
      cy: clamp(box.cy, 0.002, 0.998),
      width: clamp(box.width, 0.004, 0.5),
      height: clamp(box.height, 0.008, 0.7),
      radius: Math.max(box.width, box.height) * 0.5,
      confidence: 1,
      status: 'anchored',
      time: tFix,
    };

    const existingHist = this.histories.get(box.id);
    if (!existingHist || existingHist.length === 0) {
      this.histories.set(box.id, [correctedPos]);
    } else {
      const sorted = existingHist.map((pt) => ({ ...pt })).sort((a, b) => a.time - b.time);

      // Locate existing sample within 0.025s of tFix or insert at sorted position
      let matchIdx = -1;
      let bestMatchDt = 0.025;
      for (let i = 0; i < sorted.length; i++) {
        const dt = Math.abs(sorted[i].time - tFix);
        if (dt <= bestMatchDt) {
          bestMatchDt = dt;
          matchIdx = i;
        }
      }

      let baseAtFix: CirclePosition;
      let fixIdx: number;

      if (matchIdx !== -1) {
        baseAtFix = { ...sorted[matchIdx] };
        sorted[matchIdx] = correctedPos;
        fixIdx = matchIdx;
      } else {
        if (tFix <= sorted[0].time) {
          baseAtFix = { ...sorted[0] };
        } else if (tFix >= sorted[sorted.length - 1].time) {
          baseAtFix = { ...sorted[sorted.length - 1] };
        } else {
          baseAtFix = sampleBoxHistoryAtTime(sorted, tFix) ?? { ...sorted[0] };
        }
        fixIdx = sorted.findIndex((pt) => pt.time > tFix);
        if (fixIdx === -1) {
          fixIdx = sorted.length;
        }
        sorted.splice(fixIdx, 0, correctedPos);
      }

      const dCx = correctedPos.cx - baseAtFix.cx;
      const dCy = correctedPos.cy - baseAtFix.cy;
      const dW = correctedPos.width - baseAtFix.width;
      const dH = correctedPos.height - baseAtFix.height;

      const hasDelta =
        Math.abs(dCx) > 1e-6 ||
        Math.abs(dCy) > 1e-6 ||
        Math.abs(dW) > 1e-6 ||
        Math.abs(dH) > 1e-6;

      if (hasDelta && sorted.length > 1) {
        const manualTimes = this.manualKeyframeTimes.get(box.id) ?? [];
        const isProtectedAnchor = (pt: CirclePosition, idx: number): boolean => {
          if (idx === fixIdx) return true;
          if (pt.status === 'anchored') return true;
          return manualTimes.some((mt) => Math.abs(mt - pt.time) <= 0.025);
        };

        // Backward C1 smoothstep blend up to smoothWindowSec (stopping at prior anchor or gap)
        let prevAnchorIdx = -1;
        let backContiguousStartIdx = fixIdx;
        for (let i = fixIdx - 1; i >= 0; i--) {
          if (sorted[i + 1].time - sorted[i].time > 0.35) {
            break;
          }
          backContiguousStartIdx = i;
          if (isProtectedAnchor(sorted[i], i)) {
            prevAnchorIdx = i;
            break;
          }
        }

        if (backContiguousStartIdx < fixIdx) {
          const boundTime =
            prevAnchorIdx !== -1
              ? sorted[prevAnchorIdx].time
              : sorted[backContiguousStartIdx].time;
          const backStartTime = Math.max(boundTime, tFix - smoothWindowSec);
          const spanBack = tFix - backStartTime;

          if (spanBack > 1e-4) {
            const firstBlendIdx = prevAnchorIdx !== -1 ? prevAnchorIdx + 1 : backContiguousStartIdx;
            for (let i = firstBlendIdx; i < fixIdx; i++) {
              const t = sorted[i].time;
              if (t <= backStartTime) continue;
              const u = clamp((t - backStartTime) / spanBack, 0, 1);
              const w = u * u * (3 - 2 * u);
              const nextW = clamp(sorted[i].width + dW * w, 0.004, 0.5);
              const nextH = clamp(sorted[i].height + dH * w, 0.008, 0.7);
              sorted[i] = {
                ...sorted[i],
                cx: clamp(sorted[i].cx + dCx * w, 0.002, 0.998),
                cy: clamp(sorted[i].cy + dCy * w, 0.002, 0.998),
                width: nextW,
                height: nextH,
                radius: Math.max(nextW, nextH) * 0.5,
              };
            }
          }
        }

        // Forward C1 smoothstep blend up to smoothWindowSec (stopping at next anchor or gap)
        let nextAnchorIdx = -1;
        let fwdContiguousEndIdx = fixIdx;
        for (let i = fixIdx + 1; i < sorted.length; i++) {
          if (sorted[i].time - sorted[i - 1].time > 0.35) {
            break;
          }
          fwdContiguousEndIdx = i;
          if (isProtectedAnchor(sorted[i], i)) {
            nextAnchorIdx = i;
            break;
          }
        }

        if (fwdContiguousEndIdx > fixIdx) {
          const boundTime =
            nextAnchorIdx !== -1
              ? sorted[nextAnchorIdx].time
              : sorted[fwdContiguousEndIdx].time;
          const fwdEndTime = Math.min(boundTime, tFix + smoothWindowSec);
          const spanFwd = fwdEndTime - tFix;

          if (spanFwd > 1e-4) {
            const lastBlendIdx = nextAnchorIdx !== -1 ? nextAnchorIdx - 1 : fwdContiguousEndIdx;
            for (let i = fixIdx + 1; i <= lastBlendIdx; i++) {
              const t = sorted[i].time;
              if (t >= fwdEndTime) continue;
              const u = clamp((fwdEndTime - t) / spanFwd, 0, 1);
              const w = u * u * (3 - 2 * u);
              const nextW = clamp(sorted[i].width + dW * w, 0.004, 0.5);
              const nextH = clamp(sorted[i].height + dH * w, 0.008, 0.7);
              sorted[i] = {
                ...sorted[i],
                cx: clamp(sorted[i].cx + dCx * w, 0.002, 0.998),
                cy: clamp(sorted[i].cy + dCy * w, 0.002, 0.998),
                width: nextW,
                height: nextH,
                radius: Math.max(nextW, nextH) * 0.5,
              };
            }
          }
        }
      }

      this.histories.set(box.id, sorted);
    }

    // Record manual keyframe timestamp
    const prevKfs = this.manualKeyframeTimes.get(box.id) ?? [];
    if (!prevKfs.some((kt) => Math.abs(kt - tFix) <= 0.025)) {
      this.manualKeyframeTimes.set(
        box.id,
        [...prevKfs, tFix].sort((a, b) => a - b)
      );
    }

    this.smoothedHistories.delete(box.id);
    this.missCounts.set(box.id, 0);
    this.edgeMissCounts.set(box.id, 0);

    // Clear suppression zones directly on the corrected spot
    this.suppressionZones = this.suppressionZones.filter(
      (z) => Math.hypot(z.cx - correctedPos.cx, z.cy - correctedPos.cy) > Math.max(z.radius, 0.03)
    );

    const prevFilter = this.motionFilters.get(box.id);
    const keepVel =
      prevFilter &&
      Math.hypot(correctedPos.cx - prevFilter.cx, correctedPos.cy - prevFilter.cy) <=
        Math.max(0.06, correctedPos.width * 2.2);

    this.motionFilters.set(box.id, {
      ...createBoxMotionFilter(correctedPos),
      vxPx: keepVel ? prevFilter.vxPx : 0,
      vyPx: keepVel ? prevFilter.vyPx : 0,
    });

    if (video && video.readyState >= 2) {
      const frame = this.cvTracker.captureFrame(video);
      if (frame) {
        const hadTpl = this.cvTracker.hasTemplate(box.id);
        this.cvTracker.anchorPlayer(
          box.id,
          frame,
          correctedPos,
          true,
          Boolean(hadTpl && keepVel)
        );
        this.appearances.set(box.id, extractBoxAppearance(frame, correctedPos, chromaKey));
      }
    }
  }

  /**
   * Replays recorded active player boxes at `time`, respecting exact entry and out-of-cam exit spans.
   */
  getBoxesAtTime(fallbackBoxes: DetectedPlayerBox[], time: number): DetectedPlayerBox[] | null {
    if (this.histories.size === 0) return null;

    let minTrackedTime = Infinity;
    let maxTrackedTime = -Infinity;
    for (const hist of this.histories.values()) {
      if (hist.length === 0) continue;
      if (hist[0].time < minTrackedTime) minTrackedTime = hist[0].time;
      const lastT = hist[hist.length - 1].time;
      if (lastT > maxTrackedTime) maxTrackedTime = lastT;
    }

    if (!Number.isFinite(minTrackedTime) || time < minTrackedTime - 0.08 || time > maxTrackedTime + 0.08) {
      return null;
    }

    const fallbackById = new Map(fallbackBoxes.map((b) => [b.id, b]));
    const activeAtTime: DetectedPlayerBox[] = [];

    for (const id of this.histories.keys()) {
      const hist = this.getSmoothedHistory(id);
      if (hist.length === 0) continue;
      const firstT = hist[0].time;
      const lastT = hist[hist.length - 1].time;
      if (time < firstT - 0.06 || time > lastT + 0.06) continue;

      const sampled = sampleBoxHistoryAtTime(hist, time);
      if (!sampled) continue;

      const meta = fallbackById.get(id);
      const kfs = this.manualKeyframeTimes.get(id);
      const isKeyframe = Boolean(kfs?.some((kt) => Math.abs(kt - time) <= 0.035));
      activeAtTime.push({
        id,
        cx: sampled.cx,
        cy: sampled.cy,
        width: sampled.width,
        height: sampled.height,
        confidence: sampled.confidence,
        source: meta?.source ?? this.boxSources.get(id) ?? 'auto',
        time,
        ...(isKeyframe ? { isKeyframe: true } : {}),
      });
    }

    // Also include any unrecorded manual box placed right at this timestamp
    for (const b of fallbackBoxes) {
      if (!this.histories.has(b.id) && Math.abs(b.time - time) <= 0.14) {
        activeAtTime.push(b);
      }
    }

    return activeAtTime;
  }

  /**
   * Seeds templates, initial kit appearance, and start-frame history before slow stepping.
   * Preserves history prior to `frame.time` when resuming after user pause/edit.
   */
  seedFrame(
    video: HTMLVideoElement,
    boxes: DetectedPlayerBox[],
    chromaKey: ChromaKeySettings,
    isFullSweep = false
  ): void {
    const frame = this.cvTracker.captureFrame(video);
    if (!frame) return;

    this.cvTracker.setPrevFrame(frame);
    const activeIds = boxes.map((b) => b.id);
    this.cvTracker.syncPlayers(activeIds);
    this.pendingEntries = [];
    this.fullSweepTimes = this.fullSweepTimes.filter((t) => t < frame.time - 0.025);
    if (isFullSweep) {
      this.recordFullSweepTime(frame.time);
    }

    // Trim future history after resume timestamp for all boxes so paused edits become authoritative forward
    const activeSet = new Set(activeIds);
    for (const [id, hist] of this.histories.entries()) {
      const prior = hist.filter((pt) => pt.time < frame.time - 0.025);
      const kfs = this.manualKeyframeTimes.get(id);
      if (kfs) {
        const keptKfs = kfs.filter((kt) => kt <= frame.time + 0.025);
        if (keptKfs.length > 0) {
          this.manualKeyframeTimes.set(id, keptKfs);
        } else {
          this.manualKeyframeTimes.delete(id);
        }
      }
      if (!activeSet.has(id)) {
        if (prior.length >= 2) {
          this.histories.set(id, prior);
        } else {
          this.histories.delete(id);
          this.boxSources.delete(id);
          this.manualKeyframeTimes.delete(id);
        }
        this.smoothedHistories.delete(id);
        this.motionFilters.delete(id);
      } else {
        this.histories.set(id, prior);
        this.smoothedHistories.delete(id);
      }
    }

    for (const box of boxes) {
      this.boxSources.set(box.id, box.source);
      const pos: CirclePosition = {
        cx: box.cx,
        cy: box.cy,
        width: box.width,
        height: box.height,
        radius: Math.max(box.width, box.height) * 0.5,
        confidence: box.confidence,
        status: 'anchored',
        time: frame.time,
      };

      const prior = this.histories.get(box.id) ?? [];
      let vxPx = 0;
      let vyPx = 0;
      let hasContinuousVel = false;
      if (prior.length >= 2) {
        const pPrev = prior[prior.length - 2];
        const pLast = prior[prior.length - 1];
        const dtPrior = pLast.time - pPrev.time;
        const dtToCurr = frame.time - pLast.time;
        const jumpDist = Math.hypot(pos.cx - pLast.cx, pos.cy - pLast.cy);
        if (
          dtPrior >= 0.015 &&
          dtPrior <= 0.18 &&
          dtToCurr >= 0 &&
          dtToCurr <= 0.18 &&
          jumpDist <= Math.max(0.075, pos.width * 2.2)
        ) {
          vxPx = clamp(((pLast.cx - pPrev.cx) / dtPrior) * frame.width, -350, 350);
          vyPx = clamp(((pLast.cy - pPrev.cy) / dtPrior) * frame.height, -350, 350);
          hasContinuousVel = true;
        }
      }

      this.cvTracker.anchorPlayer(box.id, frame, pos, true, hasContinuousVel);
      this.appearances.set(box.id, extractBoxAppearance(frame, box, chromaKey));
      this.motionFilters.set(box.id, {
        ...createBoxMotionFilter(pos),
        vxPx,
        vyPx,
      });
      this.missCounts.set(box.id, 0);
      this.edgeMissCounts.set(box.id, 0);

      this.histories.set(box.id, [...prior, pos]);
      this.smoothedHistories.delete(box.id);
    }
  }

  captureFrame(video: HTMLVideoElement): FrameData | null {
    return this.cvTracker.captureFrame(video);
  }

  /**
   * Advances one video frame using joint CV tracking fused with fresh pitch-interior detections.
   * Removes boxes that leave the camera frame and detects/starts tracking new players entering the frame.
   */
  stepFrame(
    video: HTMLVideoElement,
    boxes: DetectedPlayerBox[],
    chromaKey: ChromaKeySettings,
    cvSettings: CvTrackerSettings,
    allowNewEntries = true
  ): DetectedPlayerBox[] {
    if (boxes.length === 0 && !allowNewEntries) return [];
    const currFrame = this.cvTracker.captureFrame(video);
    if (!currFrame) return boxes;
    return this.stepFrameWithFrame(currFrame, boxes, chromaKey, cvSettings, allowNewEntries);
  }

  /**
   * Same exact joint CV + pitch-interior detection step using an already-captured FrameData,
   * avoiding any duplicate canvas drawImage / getImageData and allowing pipelined video seeks.
   */
  stepFrameWithFrame(
    currFrame: FrameData,
    boxes: DetectedPlayerBox[],
    chromaKey: ChromaKeySettings,
    cvSettings: CvTrackerSettings,
    allowNewEntries = true
  ): DetectedPlayerBox[] {
    if (boxes.length === 0 && !allowNewEntries) return [];

    const chromaTargets = buildChromaTargets(chromaKey);
    const prevFrame = this.cvTracker.getPrevFrame();
    const camShift = prevFrame
      ? this.cvTracker.estimateGlobalCameraShift(prevFrame, currFrame)
      : { dx: 0, dy: 0 };

    // Shift suppression zones & pending entries with global camera pan so erased grass/glare
    // spots stay suppressed even while camera pans, expiring after 6.0s
    const camDxNorm = camShift.dx / Math.max(1, currFrame.width);
    const camDyNorm = camShift.dy / Math.max(1, currFrame.height);
    this.suppressionZones = this.suppressionZones
      .map((z) => ({
        ...z,
        cx: z.cx + camDxNorm,
        cy: z.cy + camDyNorm,
      }))
      .filter(
        (z) =>
          Math.abs(currFrame.time - z.time) <= 6.0 &&
          z.cx >= -0.1 &&
          z.cx <= 1.1 &&
          z.cy >= -0.1 &&
          z.cy <= 1.1
      );
    this.pendingEntries = this.pendingEntries.map((p) => ({
      ...p,
      cx: p.cx + camDxNorm,
      cy: p.cy + camDyNorm,
    }));

    // Ensure every active box has an anchored template
    for (const box of boxes) {
      this.boxSources.set(box.id, box.source);
      if (!this.cvTracker.hasTemplate(box.id)) {
        const initPos: CirclePosition = {
          cx: box.cx,
          cy: box.cy,
          width: box.width,
          height: box.height,
          radius: Math.max(box.width, box.height) * 0.5,
          confidence: box.confidence,
          status: 'anchored',
          time: currFrame.time,
        };
        this.cvTracker.anchorPlayer(box.id, currFrame, initPos, true);
        this.appearances.set(box.id, extractBoxAppearance(currFrame, box, chromaTargets));
      }
    }

    const slowSettings: CvTrackerSettings = {
      ...cvSettings,
      searchRadiusPx: Math.max(cvSettings.searchRadiusPx, 52),
      adaptationRate: Math.min(0.08, cvSettings.adaptationRate),
      turfMasking: true,
      cameraCompensation: true,
      collisionAvoidance: true,
      confidenceThreshold: Math.max(0.32, cvSettings.confidenceThreshold - 0.04),
    };

    const cvResults =
      boxes.length > 0
        ? this.cvTracker.trackAllPlayers(
            currFrame,
            boxes.map((box) => ({
              id: box.id,
              prevPos: {
                cx: box.cx,
                cy: box.cy,
                width: box.width,
                height: box.height,
                radius: Math.max(box.width, box.height) * 0.5,
                confidence: box.confidence,
                status: 'tracking' as const,
                time: box.time,
              },
            })),
            camShift,
            slowSettings
          )
        : new Map<string, CirclePosition>();

    // Run fresh pitch-interior detector directly on currFrame.rgba (zero duplicate readback)
    const freshDetections = this.detector.detectPlayersFromRgba(
      currFrame.rgba,
      currFrame.width,
      currFrame.height,
      chromaKey,
      currFrame.time
    );
    const detAppearances = freshDetections.map((det) =>
      extractBoxAppearance(currFrame, det, chromaTargets)
    );

    // Identify crowded tracks near other peers or multiple detections
    const crowdedSet = new Set<string>();
    for (let i = 0; i < boxes.length; i++) {
      const a = cvResults.get(boxes[i].id) ?? boxes[i];
      for (let j = i + 1; j < boxes.length; j++) {
        const b = cvResults.get(boxes[j].id) ?? boxes[j];
        const dxPx = (a.cx - b.cx) * currFrame.width;
        const dyPx = (a.cy - b.cy) * currFrame.height;
        const proxThresh = Math.max(14, (a.width + b.width) * currFrame.width * 1.15);
        if (Math.hypot(dxPx, dyPx) < proxThresh) {
          crowdedSet.add(boxes[i].id);
          crowdedSet.add(boxes[j].id);
        }
      }
    }

    for (const box of boxes) {
      const cvPos = cvResults.get(box.id);
      const predCx = cvPos?.cx ?? box.cx;
      const predCy = cvPos?.cy ?? box.cy;
      let nearDetCount = 0;
      for (const det of freshDetections) {
        const distNorm = Math.hypot(det.cx - predCx, det.cy - predCy);
        if (distNorm < Math.max(0.032, box.height * 0.65)) {
          nearDetCount++;
        }
      }
      if (nearDetCount >= 2) {
        crowdedSet.add(box.id);
      }
    }

    // Greedy 1-to-1 track <-> detection association weighted by position + torso kit + size
    interface MatchEdge {
      boxIdx: number;
      detIdx: number;
      score: number;
    }
    const edges: MatchEdge[] = [];

    for (let bi = 0; bi < boxes.length; bi++) {
      const box = boxes[bi];
      const cvPos = cvResults.get(box.id);
      const predCx = cvPos?.cx ?? box.cx + camShift.dx / currFrame.width;
      const predCy = cvPos?.cy ?? box.cy + camShift.dy / currFrame.height;
      const app = this.appearances.get(box.id);
      const maxGatePx = Math.max(18, box.height * currFrame.height * 0.92);

      for (let di = 0; di < freshDetections.length; di++) {
        const det = freshDetections[di];
        const distPx = Math.hypot(
          (det.cx - predCx) * currFrame.width,
          (det.cy - predCy) * currFrame.height
        );
        if (distPx > maxGatePx) continue;

        const spatialScore = Math.exp(-(distPx * distPx) / Math.max(64, maxGatePx * maxGatePx * 0.32));

        const refW = app?.width ?? box.width;
        const refH = app?.height ?? box.height;
        const sizeRatioH = Math.abs(Math.log(Math.max(0.005, det.height) / Math.max(0.005, refH)));
        const sizeRatioW = Math.abs(Math.log(Math.max(0.004, det.width) / Math.max(0.004, refW)));
        const sizeScore = Math.exp(-(sizeRatioH * 1.45 + sizeRatioW * 0.85));
        if (sizeScore < 0.28) continue;

        let kitScore = 0.7;
        const detApp = detAppearances[di];
        if (app?.hasKit && detApp.hasKit) {
          const upperDist = Math.hypot(
            app.upperR - detApp.upperR,
            app.upperG - detApp.upperG,
            app.upperB - detApp.upperB
          );
          const lowerDist = Math.hypot(
            app.lowerR - detApp.lowerR,
            app.lowerG - detApp.lowerG,
            app.lowerB - detApp.lowerB
          );
          const avgKitDist = upperDist * 0.65 + lowerDist * 0.35;
          if (avgKitDist > 125 && distPx > 6) continue;
          kitScore = Math.exp(-(avgKitDist * avgKitDist) / (72 * 72));
        }

        const totalScore = spatialScore * 0.56 + kitScore * 0.26 + sizeScore * 0.18;
        if (totalScore >= 0.38) {
          edges.push({ boxIdx: bi, detIdx: di, score: totalScore });
        }
      }
    }

    edges.sort((a, b) => b.score - a.score);
    const matchedDetByBox = new Map<number, number>();
    const usedDets = new Set<number>();
    for (const edge of edges) {
      if (matchedDetByBox.has(edge.boxIdx) || usedDets.has(edge.detIdx)) continue;
      matchedDetByBox.set(edge.boxIdx, edge.detIdx);
      usedDets.add(edge.detIdx);
    }

    const updatedBoxes: DetectedPlayerBox[] = [];

    for (let bi = 0; bi < boxes.length; bi++) {
      const box = boxes[bi];
      const cvPos = cvResults.get(box.id) ?? {
        cx: box.cx,
        cy: box.cy,
        width: box.width,
        height: box.height,
        radius: Math.max(box.width, box.height) * 0.5,
        confidence: box.confidence,
        status: 'occluded' as const,
        time: currFrame.time,
      };
      const detIdx = matchedDetByBox.get(bi);
      const det = detIdx !== undefined ? freshDetections[detIdx] : undefined;
      const app = this.appearances.get(box.id);
      const isCrowded = crowdedSet.has(box.id);

      let rawTargetCx = cvPos.cx;
      let rawTargetCy = cvPos.cy;
      let rawTargetW = box.width;
      let rawTargetH = box.height;
      let nextConf = cvPos.confidence;
      let nextStatus: CirclePosition['status'] = cvPos.status;

      if (det && detIdx !== undefined) {
        this.missCounts.set(box.id, 0);
        this.edgeMissCounts.set(box.id, 0);
        const detApp = detAppearances[detIdx];
        const baseW = app?.width ?? box.width;
        const baseH = app?.height ?? box.height;
        const detLooksMerged = det.width > baseW * 1.58 || det.height > baseH * 1.55;

        if (!isCrowded && !detLooksMerged) {
          const driftPx = Math.hypot(
            (det.cx - cvPos.cx) * currFrame.width,
            (det.cy - cvPos.cy) * currFrame.height
          );
          const boxWPx = Math.max(8, box.width * currFrame.width);

          // Motion-first, detector-second fusion:
          // Trust smooth Kalman/CV motion primarily for small limb-swing noise, while
          // ramping detector authority smoothly on genuine rapid cuts or large drift.
          const cutBoost = clamp((driftPx - 2.5) / Math.max(6, boxWPx * 0.4), 0, 1);
          const detWeight = det.confidence >= 0.62 ? 0.34 + cutBoost * 0.22 : 0.28 + cutBoost * 0.14;
          const cvWeight = 1 - detWeight;

          // Stride foot-tuck guard: when a running player lifts/tucks their rear foot,
          // shrinkWrapTight briefly shrinks det.height and pulls det.cy upward.
          // Damp vertical & height authority during sudden silhouette shrink dips.
          const isStrideHeightDip = det.height < box.height * 0.94;
          const detWeightY = isStrideHeightDip ? detWeight * 0.38 : detWeight * 0.62;
          const cvWeightY = 1 - detWeightY;
          const heightAlpha = isStrideHeightDip ? 0.06 : 0.16;

          rawTargetCx = clamp(cvPos.cx * cvWeight + det.cx * detWeight, 0.004, 0.996);
          rawTargetCy = clamp(cvPos.cy * cvWeightY + det.cy * detWeightY, 0.004, 0.996);
          rawTargetW = clamp(box.width * 0.8 + det.width * 0.2, baseW * 0.72, baseW * 1.34);
          rawTargetH = clamp(
            box.height * (1 - heightAlpha) + det.height * heightAlpha,
            baseH * 0.76,
            baseH * 1.32
          );
          nextConf = clamp(Math.max(cvPos.confidence, det.confidence), 0.35, 1);
          nextStatus = cvPos.status === 'stopped' ? 'stopped' : 'tracking';

          if (driftPx > Math.max(boxWPx * 0.45, 6)) {
            this.cvTracker.anchorPlayer(
              box.id,
              currFrame,
              {
                cx: rawTargetCx,
                cy: rawTargetCy,
                width: rawTargetW,
                height: rawTargetH,
                radius: Math.max(rawTargetW, rawTargetH) * 0.5,
                confidence: nextConf,
                status: 'tracking',
                time: currFrame.time,
              },
              true,
              true
            );
          }

          if (app && detApp.hasKit && app.hasKit) {
            app.upperR = app.upperR * 0.88 + detApp.upperR * 0.12;
            app.upperG = app.upperG * 0.88 + detApp.upperG * 0.12;
            app.upperB = app.upperB * 0.88 + detApp.upperB * 0.12;
            app.lowerR = app.lowerR * 0.88 + detApp.lowerR * 0.12;
            app.lowerG = app.lowerG * 0.88 + detApp.lowerG * 0.12;
            app.lowerB = app.lowerB * 0.88 + detApp.lowerB * 0.12;
          }
        } else {
          const isStrideHeightDip = det.height < box.height * 0.94;
          const heightAlpha = detLooksMerged ? 0 : isStrideHeightDip ? 0.04 : 0.1;
          rawTargetCx = clamp(cvPos.cx * 0.74 + det.cx * 0.26, 0.004, 0.996);
          rawTargetCy = clamp(cvPos.cy * 0.84 + det.cy * 0.16, 0.004, 0.996);
          rawTargetW = detLooksMerged
            ? box.width
            : clamp(box.width * 0.88 + det.width * 0.12, baseW * 0.74, baseW * 1.26);
          rawTargetH = detLooksMerged
            ? box.height
            : clamp(
                box.height * (1 - heightAlpha) + det.height * heightAlpha,
                baseH * 0.78,
                baseH * 1.24
              );
          nextConf = clamp(cvPos.confidence * 0.65 + det.confidence * 0.35, 0.3, 1);
          nextStatus = cvPos.status === 'stopped' ? 'stopped' : 'tracking';
        }
      } else {
        const misses = (this.missCounts.get(box.id) ?? 0) + 1;
        this.missCounts.set(box.id, misses);
        rawTargetCx = clamp(cvPos.cx, 0.002, 0.998);
        rawTargetCy = clamp(cvPos.cy, 0.002, 0.998);
        nextConf = clamp(cvPos.confidence * (misses > 5 ? 0.82 : 0.95), 0.12, 0.95);

        const nearEdge =
          rawTargetCx <= 0.032 ||
          rawTargetCx >= 0.968 ||
          rawTargetCy <= 0.038 ||
          rawTargetCy >= 0.962 ||
          rawTargetCx - rawTargetW * 0.5 <= 0.012 ||
          rawTargetCx + rawTargetW * 0.5 >= 0.988 ||
          rawTargetCy - rawTargetH * 0.5 <= 0.015 ||
          rawTargetCy + rawTargetH * 0.5 >= 0.985;

        const edgeMiss = nearEdge ? (this.edgeMissCounts.get(box.id) ?? 0) + 1 : 0;
        this.edgeMissCounts.set(box.id, edgeMiss);

        // Player went out of camera frame -> drop tracker box cleanly
        if (
          cvPos.status === 'stopped' ||
          edgeMiss >= 2 ||
          (misses >= 10 && cvPos.confidence < 0.30)
        ) {
          this.cvTracker.removePlayer(box.id);
          this.appearances.delete(box.id);
          this.missCounts.delete(box.id);
          this.edgeMissCounts.delete(box.id);
          this.motionFilters.delete(box.id);
          continue;
        }

        nextStatus = misses >= 6 && cvPos.confidence < 0.34 ? 'lost' : 'occluded';
      }

      // Final check: if CV reports stopped even after blending, drop box cleanly
      if (nextStatus === 'stopped') {
        this.cvTracker.removePlayer(box.id);
        this.appearances.delete(box.id);
        this.missCounts.delete(box.id);
        this.edgeMissCounts.delete(box.id);
        this.motionFilters.delete(box.id);
        continue;
      }

      // Apply camera-compensated One-Euro filtering to eliminate frame-to-frame jitter
      // while preserving zero-lag responsiveness during fast sprints and camera whip-pans
      const smoothFactor = clamp(cvSettings.smoothing ?? 0.65, 0, 1);
      const prevFilter = this.motionFilters.get(box.id);
      const filtered = stepCameraCompensatedBoxFilter(
        prevFilter,
        rawTargetCx,
        rawTargetCy,
        rawTargetW,
        rawTargetH,
        camShift.dx,
        camShift.dy,
        currFrame.width,
        currFrame.height,
        currFrame.time,
        smoothFactor
      );
      this.motionFilters.set(box.id, filtered);

      const nextCx = clamp(filtered.cx, 0.002, 0.998);
      const nextCy = clamp(filtered.cy, 0.002, 0.998);
      const nextW = filtered.w;
      const nextH = filtered.h;

      const trackedPos: CirclePosition = {
        cx: nextCx,
        cy: nextCy,
        width: nextW,
        height: nextH,
        radius: Math.max(nextW, nextH) * 0.5,
        confidence: Number(nextConf.toFixed(3)),
        status: nextStatus,
        time: currFrame.time,
      };

      let hist = this.histories.get(box.id);
      if (!hist) {
        hist = [trackedPos];
        this.histories.set(box.id, hist);
      } else {
        const last = hist[hist.length - 1];
        if (!last || currFrame.time > last.time + 0.015) {
          if (hist.length >= 2400) {
            hist.shift();
          }
          hist.push(trackedPos);
        } else {
          hist[hist.length - 1] = trackedPos;
        }
      }
      this.smoothedHistories.delete(box.id);

      updatedBoxes.push({
        ...box,
        cx: trackedPos.cx,
        cy: trackedPos.cy,
        width: trackedPos.width,
        height: trackedPos.height,
        confidence: trackedPos.confidence,
        time: currFrame.time,
      });
    }

    // Handle players entering the camera frame (unmatched fresh detections)
    if (allowNewEntries) {
      this.pendingEntries = this.pendingEntries.filter(
        (p) => currFrame.time - p.lastTime <= 0.26 && p.lastTime <= currFrame.time + 0.05
      );

      for (let di = 0; di < freshDetections.length; di++) {
        if (usedDets.has(di)) continue;
        const det = freshDetections[di];

        // Skip if overlaps or sits very close to any already-tracked box on this frame
        const overlapsActive = updatedBoxes.some((active) => {
          if (computeNormBoxIoU(det, active) > 0.12) return true;
          const distPx = Math.hypot(
            (det.cx - active.cx) * currFrame.width,
            (det.cy - active.cy) * currFrame.height
          );
          const minSepPx = Math.max(12, Math.min(det.width, active.width) * currFrame.width * 1.0);
          return distPx < minSepPx;
        });
        if (overlapsActive) continue;

        // Respect user-erased areas (both immediate location and camera-tracked similar appearance)
        const detApp = detAppearances[di];
        const inSuppressedZone = this.suppressionZones.some((z) => {
          const dx = Math.abs(det.cx - z.cx);
          const dy = Math.abs(det.cy - z.cy);
          const nearBox =
            dx <= z.halfW + det.width * 0.5 + 0.024 &&
            dy <= z.halfH + det.height * 0.5 + 0.024;
          const inRadius = Math.hypot(dx, dy) <= z.radius;
          if (!nearBox && !inRadius) return false;
          const dt = Math.abs(currFrame.time - z.time);
          if (dt <= 1.4) return true;
          if (z.app?.hasKit && detApp.hasKit) {
            const kitDist = Math.hypot(
              z.app.upperR - detApp.upperR,
              z.app.upperG - detApp.upperG,
              z.app.upperB - detApp.upperB
            );
            return kitDist <= 58;
          }
          return true;
        });
        if (inSuppressedZone) continue;

        // Match against pending entries across consecutive frames to reject 1-frame noise flashes
        let matchedPending: PendingEntryCandidate | null = null;
        let bestPendingDist = Infinity;
        const maxLinkDist = Math.max(0.04, det.height * 0.72);
        for (const p of this.pendingEntries) {
          const d = Math.hypot(det.cx - p.cx, det.cy - p.cy);
          if (d <= maxLinkDist && d < bestPendingDist) {
            bestPendingDist = d;
            matchedPending = p;
          }
        }

        const nearBorder =
          det.cx <= 0.08 ||
          det.cx >= 0.92 ||
          det.cy <= 0.1 ||
          det.cy >= 0.9;

        if (matchedPending) {
          matchedPending.cx = det.cx;
          matchedPending.cy = det.cy;
          matchedPending.width = det.width;
          matchedPending.height = det.height;
          matchedPending.confidence = Math.max(matchedPending.confidence, det.confidence);
          matchedPending.hits += 1;
          matchedPending.lastTime = currFrame.time;
        } else {
          matchedPending = {
            cx: det.cx,
            cy: det.cy,
            width: det.width,
            height: det.height,
            confidence: det.confidence,
            hits: 1,
            firstTime: currFrame.time,
            lastTime: currFrame.time,
          };
          this.pendingEntries.push(matchedPending);
        }

        // Promote once confirmed across 2 frames (0.1s), or very high-confidence frame-edge entry
        const shouldPromote =
          matchedPending.hits >= 2 || (nearBorder && det.confidence >= 0.78);

        if (shouldPromote) {
          this.pendingEntries = this.pendingEntries.filter((p) => p !== matchedPending);

          const newId = `det_entry_${Date.now()}_${this.entrySeq++}_${Math.random().toString(36).slice(2, 5)}`;
          const newBox: DetectedPlayerBox = {
            id: newId,
            cx: det.cx,
            cy: det.cy,
            width: det.width,
            height: det.height,
            confidence: det.confidence,
            source: 'auto',
            time: currFrame.time,
          };
          const newPos: CirclePosition = {
            cx: newBox.cx,
            cy: newBox.cy,
            width: newBox.width,
            height: newBox.height,
            radius: Math.max(newBox.width, newBox.height) * 0.5,
            confidence: newBox.confidence,
            status: 'tracking',
            time: currFrame.time,
          };

          this.boxSources.set(newId, 'auto');
          this.cvTracker.anchorPlayer(newId, currFrame, newPos, true);
          this.appearances.set(newId, detAppearances[di]);
          this.motionFilters.set(newId, createBoxMotionFilter(newPos));
          this.missCounts.set(newId, 0);
          this.edgeMissCounts.set(newId, 0);
          this.histories.set(newId, [newPos]);
          this.smoothedHistories.delete(newId);
          updatedBoxes.push(newBox);
        }
      }
    }

    if (allowNewEntries) {
      this.recordFullSweepTime(currFrame.time);
    }
    this.cvTracker.setPrevFrame(currFrame);
    return updatedBoxes;
  }
}

function extractBoxAppearance(
  frame: FrameData,
  box: { cx: number; cy: number; width: number; height: number },
  chromaKeyOrTargets: ChromaKeySettings | ChromaTargets
): BoxAppearanceModel {
  const targets =
    'invRange' in chromaKeyOrTargets
      ? chromaKeyOrTargets
      : buildChromaTargets(chromaKeyOrTargets);
  const bw = Math.max(4, Math.round(box.width * frame.width));
  const bh = Math.max(6, Math.round(box.height * frame.height));
  const x0 = clamp(Math.round(box.cx * frame.width - bw * 0.5), 0, frame.width - 1);
  const y0 = clamp(Math.round(box.cy * frame.height - bh * 0.5), 0, frame.height - 1);
  const x1 = clamp(x0 + bw - 1, x0, frame.width - 1);
  const y1 = clamp(y0 + bh - 1, y0, frame.height - 1);

  const midY = y0 + Math.round((y1 - y0 + 1) * 0.52);
  let uR = 0;
  let uG = 0;
  let uB = 0;
  let uCount = 0;
  let lR = 0;
  let lG = 0;
  let lB = 0;
  let lCount = 0;

  for (let y = y0; y <= y1; y++) {
    const row = y * frame.width;
    for (let x = x0; x <= x1; x++) {
      const idx = (row + x) * 4;
      const r = frame.rgba[idx];
      const g = frame.rgba[idx + 1];
      const b = frame.rgba[idx + 2];
      const fgAlpha = computePixelFgAlphaFast(r, g, b, targets);
      if (fgAlpha < 0.45) continue;
      if (y <= midY) {
        uR += r;
        uG += g;
        uB += b;
        uCount++;
      } else {
        lR += r;
        lG += g;
        lB += b;
        lCount++;
      }
    }
  }

  if (uCount === 0 && lCount === 0) {
    return {
      upperR: 128,
      upperG: 128,
      upperB: 128,
      lowerR: 128,
      lowerG: 128,
      lowerB: 128,
      width: box.width,
      height: box.height,
      hasKit: false,
    };
  }

  const ur = uCount > 0 ? uR / uCount : lR / lCount;
  const ug = uCount > 0 ? uG / uCount : lG / lCount;
  const ub = uCount > 0 ? uB / uCount : lB / lCount;
  const lr = lCount > 0 ? lR / lCount : ur;
  const lg = lCount > 0 ? lG / lCount : ug;
  const lb = lCount > 0 ? lB / lCount : ub;

  return {
    upperR: ur,
    upperG: ug,
    upperB: ub,
    lowerR: lr,
    lowerG: lg,
    lowerB: lb,
    width: box.width,
    height: box.height,
    hasKit: true,
  };
}

function createBoxMotionFilter(pos: Pick<CirclePosition, 'cx' | 'cy' | 'width' | 'height' | 'time'>): BoxMotionFilter {
  return {
    cx: pos.cx,
    cy: pos.cy,
    w: pos.width,
    h: pos.height,
    vxPx: 0,
    vyPx: 0,
    vwPx: 0,
    vhPx: 0,
    lastTime: pos.time,
  };
}

function oneEuroAlpha(dt: number, cutoffHz: number): number {
  const tau = 1 / (2 * Math.PI * Math.max(0.05, cutoffHz));
  return 1 / (1 + tau / Math.max(1e-4, dt));
}

function stepCameraCompensatedBoxFilter(
  prev: BoxMotionFilter | undefined,
  rawCx: number,
  rawCy: number,
  rawW: number,
  rawH: number,
  camDxPx: number,
  camDyPx: number,
  frameW: number,
  frameH: number,
  time: number,
  smoothFactor: number
): BoxMotionFilter {
  if (!prev || smoothFactor <= 0.01 || time <= prev.lastTime) {
    return {
      cx: rawCx,
      cy: rawCy,
      w: rawW,
      h: rawH,
      vxPx: 0,
      vyPx: 0,
      vwPx: 0,
      vhPx: 0,
      lastTime: time,
    };
  }

  const dt = clamp(time - prev.lastTime, 0.012, 0.18);

  // Advance previous smoothed center by global camera shift BEFORE filtering so
  // even fast whip-pans experience zero camera lag or false velocity spikes.
  const camCompCx = prev.cx + camDxPx / Math.max(1, frameW);
  const camCompCy = prev.cy + camDyPx / Math.max(1, frameH);

  let relDxPx = (rawCx - camCompCx) * frameW;
  let relDyPx = (rawCy - camCompCy) * frameH;
  const relDistPx = Math.hypot(relDxPx, relDyPx);

  // If jump is huge (e.g., seek/re-acquire), snap cleanly instead of trailing
  if (relDistPx > Math.max(42, rawW * frameW * 2.4)) {
    return {
      cx: rawCx,
      cy: rawCy,
      w: rawW,
      h: rawH,
      vxPx: 0,
      vyPx: 0,
      vwPx: 0,
      vhPx: 0,
      lastTime: time,
    };
  }

  // Decoupled soft sub-pixel deadbands so horizontal sprint speed never disables Y-axis damping
  const deadbandXPx = smoothFactor * 1.6;
  if (Math.abs(relDxPx) < deadbandXPx && Math.abs(prev.vxPx) < 36) {
    const shrinkX = Math.abs(relDxPx) / Math.max(1e-4, deadbandXPx);
    relDxPx *= shrinkX * shrinkX;
  }
  const deadbandYPx = smoothFactor * 2.2;
  if (Math.abs(relDyPx) < deadbandYPx && Math.abs(prev.vyPx) < 28) {
    const shrinkY = Math.abs(relDyPx) / Math.max(1e-4, deadbandYPx);
    relDyPx *= shrinkY * shrinkY;
  }

  const alphaD = oneEuroAlpha(dt, 1.2);
  const instVx = relDxPx / dt;
  const instVy = relDyPx / dt;
  const vxPx = prev.vxPx + alphaD * (instVx - prev.vxPx);
  const vyPx = prev.vyPx + alphaD * (instVy - prev.vyPx);

  // Decoupled per-axis One-Euro cutoffs:
  // Horizontal sprints/cuts ramp fcX cleanly while stride bobbing cancels in vyPx without
  // getting blown open by horizontal velocity.
  const minCutoffX = Math.max(0.55, 2.8 - smoothFactor * 2.75); // ~1.0 Hz at default 0.65 smoothing
  const betaX = 0.048;
  const alphaX = oneEuroAlpha(dt, minCutoffX + betaX * Math.abs(vxPx));

  const minCutoffY = Math.max(0.42, 2.1 - smoothFactor * 2.1); // ~0.74 Hz at default smoothing
  const betaY = 0.032;
  const alphaY = oneEuroAlpha(dt, minCutoffY + betaY * Math.abs(vyPx));

  const nextCx = camCompCx + (alphaX * relDxPx) / Math.max(1, frameW);
  const nextCy = camCompCy + (alphaY * relDyPx) / Math.max(1, frameH);

  // Heavily damped One-Euro filter + micro-deadband for box width & height
  // so arm/leg swings don't pump box dimensions or groundY every stride
  let dWPx = (rawW - prev.w) * frameW;
  let dHPx = (rawH - prev.h) * frameH;
  const sizeDeadband = smoothFactor * 2.2;
  if (Math.abs(dWPx) < sizeDeadband) {
    dWPx *= Math.abs(dWPx) / Math.max(1e-4, sizeDeadband);
  }
  if (Math.abs(dHPx) < sizeDeadband) {
    dHPx *= Math.abs(dHPx) / Math.max(1e-4, sizeDeadband);
  }

  const vwPx = prev.vwPx + alphaD * (dWPx / dt - prev.vwPx);
  const vhPx = prev.vhPx + alphaD * (dHPx / dt - prev.vhPx);
  const minCutoffSize = Math.max(0.22, 1.25 - smoothFactor * 1.25); // ~0.44 Hz at default smoothing
  const betaSize = 0.0025;
  const alphaW = oneEuroAlpha(dt, minCutoffSize + betaSize * Math.abs(vwPx));
  const alphaH = oneEuroAlpha(dt, minCutoffSize + betaSize * Math.abs(vhPx));

  const nextW = prev.w + (alphaW * dWPx) / Math.max(1, frameW);
  const nextH = prev.h + (alphaH * dHPx) / Math.max(1, frameH);

  return {
    cx: nextCx,
    cy: nextCy,
    w: nextW,
    h: nextH,
    vxPx,
    vyPx,
    vwPx,
    vhPx,
    lastTime: time,
  };
}

const GAUSS_9 = [1, 3, 6, 9, 11, 9, 6, 3, 1];
const GAUSS_7 = [1, 3, 6, 8, 6, 3, 1];
const GAUSS_5 = [1, 3, 5, 3, 1];

/**
 * Zero-phase multi-scale history smoother:
 * - Uses 5-point quadratic Savitzky-Golay on `cx` to preserve sharp lateral cuts with zero lag.
 * - Uses up to 9-point (~0.40s stride-span) zero-phase Gaussian smoothing on `cy`, `width`, and
 *   `height` to eliminate vertical running-stride bobbing while preserving steady vertical travel.
 * Preserves endpoints and manually anchored keyframes.
 */
function zeroPhaseSmoothBoxHistory(history: CirclePosition[]): CirclePosition[] {
  const n = history.length;
  if (n <= 2) return history.slice();

  const out: CirclePosition[] = new Array(n);
  out[0] = history[0];
  out[n - 1] = history[n - 1];

  const isContinuous = (a: CirclePosition, b: CirclePosition): boolean => {
    const dt = b.time - a.time;
    if (dt <= 0 || dt > 0.18) return false;
    const dist = Math.hypot(b.cx - a.cx, b.cy - a.cy);
    return dist <= Math.max(0.075, Math.max(a.width, b.width) * 2.1);
  };

  for (let i = 1; i < n - 1; i++) {
    const curr = history[i];
    if (curr.status === 'anchored') {
      out[i] = curr;
      continue;
    }

    const can3 = isContinuous(history[i - 1], curr) && isContinuous(curr, history[i + 1]);
    if (!can3) {
      out[i] = curr;
      continue;
    }

    const can5 =
      i >= 2 &&
      i <= n - 3 &&
      isContinuous(history[i - 2], history[i - 1]) &&
      isContinuous(history[i + 1], history[i + 2]);

    let sCx: number;
    if (can5) {
      const pM2 = history[i - 2];
      const pM1 = history[i - 1];
      const pP1 = history[i + 1];
      const pP2 = history[i + 2];
      sCx = (-3 * pM2.cx + 12 * pM1.cx + 17 * curr.cx + 12 * pP1.cx - 3 * pP2.cx) / 35;
    } else {
      const pM1 = history[i - 1];
      const pP1 = history[i + 1];
      sCx = 0.25 * pM1.cx + 0.5 * curr.cx + 0.25 * pP1.cx;
    }

    // Determine largest symmetric continuous radius (up to 4 => 9-point stride window) for cy/size
    let maxRadius = 1;
    if (can5) {
      maxRadius = 2;
      if (
        i >= 3 &&
        i <= n - 4 &&
        isContinuous(history[i - 3], history[i - 2]) &&
        isContinuous(history[i + 2], history[i + 3])
      ) {
        maxRadius = 3;
        if (
          i >= 4 &&
          i <= n - 5 &&
          isContinuous(history[i - 4], history[i - 3]) &&
          isContinuous(history[i + 3], history[i + 4])
        ) {
          maxRadius = 4;
        }
      }
    }

    let sCy = 0;
    let sW = 0;
    let sH = 0;
    if (maxRadius >= 2) {
      const kernel = maxRadius === 4 ? GAUSS_9 : maxRadius === 3 ? GAUSS_7 : GAUSS_5;
      let wSum = 0;
      for (let k = -maxRadius; k <= maxRadius; k++) {
        const pt = history[i + k];
        const w = kernel[k + maxRadius];
        sCy += pt.cy * w;
        sW += pt.width * w;
        sH += pt.height * w;
        wSum += w;
      }
      const inv = 1 / wSum;
      sCy *= inv;
      sW *= inv;
      sH *= inv;
    } else {
      const pM1 = history[i - 1];
      const pP1 = history[i + 1];
      sCy = 0.25 * pM1.cy + 0.5 * curr.cy + 0.25 * pP1.cy;
      sW = 0.25 * pM1.width + 0.5 * curr.width + 0.25 * pP1.width;
      sH = 0.25 * pM1.height + 0.5 * curr.height + 0.25 * pP1.height;
    }

    // Safety clamp: smoothing may never pull a box off a sharp cut
    const maxShift = Math.max(0.008, curr.width * 0.35);
    const dx = sCx - curr.cx;
    const dy = sCy - curr.cy;
    const shift = Math.hypot(dx, dy);
    if (shift > maxShift && shift > 1e-6) {
      const scale = maxShift / shift;
      sCx = curr.cx + dx * scale;
      sCy = curr.cy + dy * scale;
    }

    out[i] = {
      ...curr,
      cx: clamp(sCx, 0.002, 0.998),
      cy: clamp(sCy, 0.002, 0.998),
      width: clamp(sW, 0.004, 0.5),
      height: clamp(sH, 0.008, 0.7),
      radius: Math.max(sW, sH) * 0.5,
    };
  }

  return out;
}

function catmullRomValue(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/**
 * Smoothly interpolates recorded box positions at arbitrary replay timestamps (30/60fps)
 * using Catmull-Rom cubic interpolation on continuous spans (eliminating 20Hz stepping).
 */
function sampleBoxHistoryAtTime(history: CirclePosition[], time: number): CirclePosition | null {
  const n = history.length;
  if (n === 0) return null;

  const first = history[0];
  if (time <= first.time) {
    return first.time - time <= 0.08 ? { ...first, time } : null;
  }

  const last = history[n - 1];
  if (time >= last.time) {
    return time - last.time <= 0.08 ? { ...last, time } : null;
  }

  let lo = 0;
  let hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (history[mid].time <= time) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const p1 = history[lo];
  const p2 = history[lo + 1];
  const span = p2.time - p1.time;
  if (span <= 1e-5) {
    return { ...p2, time };
  }
  if (span > 0.35) {
    return Math.abs(time - p1.time) <= Math.abs(p2.time - time)
      ? { ...p1, time }
      : { ...p2, time };
  }

  const u = clamp((time - p1.time) / span, 0, 1);

  let cx: number;
  let cy: number;
  if (
    lo >= 1 &&
    lo + 2 < n &&
    p1.time - history[lo - 1].time <= 0.18 &&
    history[lo + 2].time - p2.time <= 0.18
  ) {
    const p0 = history[lo - 1];
    const p3 = history[lo + 2];
    const minX = Math.min(p1.cx, p2.cx) - 0.006;
    const maxX = Math.max(p1.cx, p2.cx) + 0.006;
    const minY = Math.min(p1.cy, p2.cy) - 0.006;
    const maxY = Math.max(p1.cy, p2.cy) + 0.006;
    cx = clamp(catmullRomValue(p0.cx, p1.cx, p2.cx, p3.cx, u), minX, maxX);
    cy = clamp(catmullRomValue(p0.cy, p1.cy, p2.cy, p3.cy, u), minY, maxY);
  } else {
    cx = p1.cx + (p2.cx - p1.cx) * u;
    cy = p1.cy + (p2.cy - p1.cy) * u;
  }

  const width = p1.width + (p2.width - p1.width) * u;
  const height = p1.height + (p2.height - p1.height) * u;
  const confidence = p1.confidence + (p2.confidence - p1.confidence) * u;

  return {
    cx,
    cy,
    width,
    height,
    radius: Math.max(width, height) * 0.5,
    confidence,
    status: u < 0.5 ? p1.status : p2.status,
    time,
  };
}

function computeNormBoxIoU(
  a: Pick<DetectedPlayerBox, 'cx' | 'cy' | 'width' | 'height'>,
  b: Pick<DetectedPlayerBox, 'cx' | 'cy' | 'width' | 'height'>
): number {
  const ax0 = a.cx - a.width * 0.5;
  const ay0 = a.cy - a.height * 0.5;
  const ax1 = a.cx + a.width * 0.5;
  const ay1 = a.cy + a.height * 0.5;
  const bx0 = b.cx - b.width * 0.5;
  const by0 = b.cy - b.height * 0.5;
  const bx1 = b.cx + b.width * 0.5;
  const by1 = b.cy + b.height * 0.5;

  const ix0 = Math.max(ax0, bx0);
  const iy0 = Math.max(ay0, by0);
  const ix1 = Math.min(ax1, bx1);
  const iy1 = Math.min(ay1, by1);
  if (ix1 <= ix0 || iy1 <= iy0) return 0;

  const inter = (ix1 - ix0) * (iy1 - iy0);
  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  return inter / Math.max(1e-6, areaA + areaB - inter);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
