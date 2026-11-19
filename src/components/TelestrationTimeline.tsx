import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BoxSelect,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Crosshair,
  Disc,
  Eye,
  EyeOff,
  Link2,
  Pentagon,
  ScanSearch,
  Sun,
} from 'lucide-react';
import type {
  BackgroundPlayerTrackRecord,
  CircleStyle,
  CoverageSegment,
  CoverageSummary,
  ImplementedTrackRecord,
  TrackedPlayer,
} from '../types/tracking';
import { computeContiguousIntervals } from '../utils/trackingCoverage';

interface TelestrationTimelineProps {
  hasVideo: boolean;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  zoom: number;
  maxZoom: number;
  onZoomChange: (nextZoom: number) => void;
  heightPx: number;
  players: TrackedPlayer[];
  selectedPlayerId: string | null;
  coverageSummary: CoverageSummary;
  backgroundTracks: BackgroundPlayerTrackRecord[];
  implementedTracks: ImplementedTrackRecord[];
  hoveredTrackedPlayerId?: string | null;
  onHoverTrackedPlayer?: (id: string | null) => void;
  onSeek: (time: number) => void;
  onSelectPlayer: (id: string) => void;
  onTogglePlayerVisibility: (id: string) => void;
  onPausePlayback?: () => void;
  onPushUndoSnapshot: () => void;
  onTrimPlayerSpan: (
    playerId: string,
    inTime: number | undefined,
    stopTime: number | undefined,
    stopReason?: 'manual' | 'out-of-frame'
  ) => void;
}

const GUTTER_WIDTH = 136;

type TrimDragState = {
  playerId: string;
  edge: 'in' | 'out';
  startX: number;
  origIn: number;
  origInRaw: number | undefined;
  origOut: number;
  origStopDefined: boolean;
  initialPlayhead: number;
  currentVal: number;
  snappedToEnd: boolean;
  undoPushed: boolean;
};

type HoverTipState = {
  player: TrackedPlayer;
  effIn: number;
  effOut: number;
  isOpenEnd: boolean;
  x: number;
  y: number;
};

export const TelestrationTimeline: React.FC<TelestrationTimelineProps> = ({
  hasVideo,
  isPlaying,
  currentTime,
  duration,
  zoom,
  maxZoom,
  onZoomChange,
  heightPx,
  players,
  selectedPlayerId,
  coverageSummary,
  backgroundTracks,
  implementedTracks,
  hoveredTrackedPlayerId,
  onHoverTrackedPlayer,
  onSeek,
  onSelectPlayer,
  onTogglePlayerVisibility,
  onPausePlayback,
  onPushUndoSnapshot,
  onTrimPlayerSpan,
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const prevZoomRef = useRef<number>(zoom);
  const pendingScrollAnchorRef = useRef<{ time: number; viewportOffsetPx: number } | null>(null);
  const [viewportWidth, setViewportWidth] = useState(640);
  const [tickWindowScrollPx, setTickWindowScrollPx] = useState(0);
  const [filterMode, setFilterMode] = useState<'all' | 'now'>('all');
  const [showTrackedPlayersRows, setShowTrackedPlayersRows] = useState(false);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [trimDrag, setTrimDrag] = useState<TrimDragState | null>(null);
  const trimDragRef = useRef<TrimDragState | null>(null);
  const [hoverTip, setHoverTip] = useState<HoverTipState | null>(null);
  const [coverageTip, setCoverageTip] = useState<{
    seg: CoverageSegment;
    x: number;
    y: number;
  } | null>(null);

  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const clampedTime = safeDuration > 0 ? Math.min(Math.max(0, currentTime), safeDuration) : 0;

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const sync = () => {
      const avail = Math.max(180, el.clientWidth - GUTTER_WIDTH);
      setViewportWidth(avail);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const laneWidth = Math.max(viewportWidth, Math.round(viewportWidth * zoom));
  const playheadPct = safeDuration > 0 ? (clampedTime / safeDuration) * 100 : 0;
  const playheadPx = (playheadPct / 100) * laneWidth;

  // Keep cursor-anchor or playhead-anchor stationary across zoom changes
  useLayoutEffect(() => {
    const scroller = scrollContainerRef.current;
    const prevZoom = prevZoomRef.current;
    prevZoomRef.current = zoom;
    if (!scroller || safeDuration <= 0 || Math.abs(prevZoom - zoom) < 0.001) return;

    const newLaneW = Math.max(viewportWidth, Math.round(viewportWidth * zoom));
    if (zoom <= 1.001) {
      scroller.scrollLeft = 0;
      setTickWindowScrollPx(0);
      pendingScrollAnchorRef.current = null;
      return;
    }

    const anchor = pendingScrollAnchorRef.current;
    pendingScrollAnchorRef.current = null;

    if (anchor) {
      const targetX = (anchor.time / safeDuration) * newLaneW;
      const nextLeft = Math.max(0, targetX - anchor.viewportOffsetPx);
      scroller.scrollLeft = nextLeft;
      setTickWindowScrollPx(nextLeft);
      return;
    }

    const oldLaneW = Math.max(viewportWidth, Math.round(viewportWidth * prevZoom));
    const oldPlayheadPx = (clampedTime / safeDuration) * oldLaneW;
    const oldScrollLeft = scroller.scrollLeft;
    const playheadInView =
      oldPlayheadPx >= oldScrollLeft - 8 && oldPlayheadPx <= oldScrollLeft + viewportWidth + 8;

    let nextLeft: number;
    if (playheadInView) {
      const offsetInView = oldPlayheadPx - oldScrollLeft;
      const newPlayheadPx = (clampedTime / safeDuration) * newLaneW;
      nextLeft = Math.max(0, newPlayheadPx - offsetInView);
    } else {
      const centerRatio = (oldScrollLeft + viewportWidth * 0.5) / Math.max(1, oldLaneW);
      nextLeft = Math.max(0, centerRatio * newLaneW - viewportWidth * 0.5);
    }
    scroller.scrollLeft = nextLeft;
    setTickWindowScrollPx(nextLeft);
  }, [zoom, viewportWidth, safeDuration, clampedTime]);

  // Modern wheel/pinch zoom (Ctrl/Cmd/Alt + Wheel anywhere, or plain Wheel on ruler) + Shift+Wheel pan
  useEffect(() => {
    const scroller = scrollContainerRef.current;
    if (!scroller) return;

    const onWheel = (e: WheelEvent) => {
      if (!hasVideo || safeDuration <= 0) return;
      const isOverRuler = rulerRef.current?.contains(e.target as Node) ?? false;
      const wantsZoom = e.ctrlKey || e.metaKey || e.altKey || (isOverRuler && Math.abs(e.deltaY) >= Math.abs(e.deltaX));

      if (wantsZoom) {
        e.preventDefault();
        const rect = scroller.getBoundingClientRect();
        const cursorViewportX = Math.max(0, Math.min(viewportWidth, e.clientX - rect.left - GUTTER_WIDTH));
        const currLaneW = Math.max(viewportWidth, Math.round(viewportWidth * zoom));
        const cursorTime = ((scroller.scrollLeft + cursorViewportX) / Math.max(1, currLaneW)) * safeDuration;
        const factor = Math.exp(-e.deltaY * 0.0028);
        const clampedZoom = Math.max(1, Math.min(maxZoom, Math.round(zoom * factor * 100) / 100));
        const nextZoom = clampedZoom < 1.03 && zoom > clampedZoom ? 1 : clampedZoom;
        if (Math.abs(nextZoom - zoom) >= 0.01) {
          pendingScrollAnchorRef.current = {
            time: Math.max(0, Math.min(safeDuration, cursorTime)),
            viewportOffsetPx: cursorViewportX,
          };
          onZoomChange(nextZoom);
        }
        return;
      }

      if (e.shiftKey && zoom > 1.01) {
        e.preventDefault();
        scroller.scrollLeft += e.deltaY;
      }
    };

    scroller.addEventListener('wheel', onWheel, { passive: false });
    return () => scroller.removeEventListener('wheel', onWheel);
  }, [hasVideo, safeDuration, viewportWidth, zoom, maxZoom, onZoomChange]);

  // Keep playhead in view while playing when zoomed in
  useEffect(() => {
    if (!isPlaying || zoom <= 1.01 || safeDuration <= 0) return;
    const scroller = scrollContainerRef.current;
    if (!scroller) return;
    const viewLeft = scroller.scrollLeft;
    const viewRight = viewLeft + viewportWidth;
    if (playheadPx < viewLeft + 24 || playheadPx > viewRight - 36) {
      scroller.scrollLeft = Math.max(0, playheadPx - viewportWidth * 0.25);
    }
  }, [isPlaying, zoom, safeDuration, playheadPx, viewportWidth]);

  // Adaptive zoom-aware ruler ticks with viewport windowing & collision-free label placement
  const rulerTicks = useMemo(() => {
    if (safeDuration <= 0 || laneWidth <= 0) {
      return {
        major: [] as number[],
        labeledMajors: [] as { t: number; align: 'left' | 'right'; text: string }[],
        minor: [] as number[],
      };
    }

    const candidates = [
      0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600,
    ];
    const pxPerSec = laneWidth / safeDuration;

    const step =
      candidates.find((c) => {
        const isCenti = c < 0.25;
        const isSub = c < 1;
        const estLabelW = isCenti ? 54 : isSub ? 44 : safeDuration >= 3600 ? 48 : 34;
        const minSpacingPx = estLabelW + 42;
        return c * pxPerSec >= minSpacingPx;
      }) ?? candidates[candidates.length - 1];

    const subDecimals = step < 1;
    const centiDecimals = step < 0.25;
    const estLabelW = centiDecimals ? 54 : subDecimals ? 44 : safeDuration >= 3600 ? 48 : 34;

    const minorDivs = step === 0.05 ? 2 : 4;
    const minorStep = step / minorDivs;
    const major: number[] = [];
    const minor: number[] = [];

    const winMinTime =
      zoom <= 1.01
        ? 0
        : Math.max(0, ((tickWindowScrollPx - viewportWidth) / laneWidth) * safeDuration);
    const winMaxTime =
      zoom <= 1.01
        ? safeDuration
        : Math.min(
            safeDuration,
            ((tickWindowScrollPx + viewportWidth * 2) / laneWidth) * safeDuration
          );

    const firstMajorIdx = Math.max(0, Math.floor(winMinTime / step));
    const lastMajorIdx = Math.ceil(winMaxTime / step);
    for (let i = firstMajorIdx; i <= lastMajorIdx; i++) {
      const t = Number((i * step).toFixed(3));
      if (t > safeDuration + 0.0005) break;
      major.push(t);
    }

    const firstMinorIdx = Math.max(1, Math.floor(winMinTime / minorStep));
    const lastMinorIdx = Math.ceil(winMaxTime / minorStep);
    for (let i = firstMinorIdx; i <= lastMinorIdx; i++) {
      const t = Number((i * minorStep).toFixed(3));
      if (t >= safeDuration - 0.0005) break;
      if (i % minorDivs !== 0) minor.push(t);
    }

    const labeledMajors: { t: number; align: 'left' | 'right'; text: string }[] = [];
    let lastLabelRightPx = -Infinity;
    const minGapPx = 14;

    for (const t of major) {
      const xPx = (t / safeDuration) * laneWidth;
      const text = formatRulerTime(t, subDecimals, centiDecimals);
      const labelW = Math.max(estLabelW, text.length * 6.2);

      const leftStart = xPx + 4;
      const leftEnd = leftStart + labelW;
      if (leftStart >= lastLabelRightPx + minGapPx && leftEnd <= laneWidth - 4) {
        labeledMajors.push({ t, align: 'left', text });
        lastLabelRightPx = leftEnd;
        continue;
      }

      const rightStart = xPx - labelW - 4;
      if (xPx > laneWidth - labelW - 10 && rightStart >= lastLabelRightPx + minGapPx) {
        labeledMajors.push({ t, align: 'right', text });
        lastLabelRightPx = xPx - 4;
      }
    }

    return { major, labeledMajors, minor };
  }, [safeDuration, laneWidth, zoom, tickWindowScrollPx, viewportWidth]);

  const timeFromClientX = useCallback(
    (clientX: number, targetEl: HTMLElement): number => {
      if (safeDuration <= 0) return 0;
      const rect = targetEl.getBoundingClientRect();
      const relX = Math.max(0, Math.min(rect.width, clientX - rect.left));
      return (relX / Math.max(1, rect.width)) * safeDuration;
    },
    [safeDuration]
  );

  // Ruler / empty-lane scrubbing
  const handleScrubPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!hasVideo || safeDuration <= 0 || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsScrubbing(true);
    onSeek(timeFromClientX(e.clientX, e.currentTarget));
  };

  const handleScrubPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isScrubbing) return;
    onSeek(timeFromClientX(e.clientX, e.currentTarget));
  };

  const handleScrubPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isScrubbing) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setIsScrubbing(false);
  };

  const isTrimming = trimDrag !== null;

  // Global window pointer handlers for smooth In/Out edge trimming + live canvas frame glancing
  useEffect(() => {
    if (!isTrimming || safeDuration <= 0) return;

    const onPointerMove = (e: PointerEvent) => {
      const session = trimDragRef.current;
      if (!session) return;

      const dx = e.clientX - session.startX;
      const dt = (dx / Math.max(1, laneWidth)) * safeDuration;
      const snapThresholdSec = (7 / Math.max(1, laneWidth)) * safeDuration;

      if (!session.undoPushed && Math.abs(dx) >= 2) {
        onPushUndoSnapshot();
        session.undoPushed = true;
      }

      if (session.edge === 'in') {
        let nextIn = Math.max(0, Math.min(session.origOut - 0.1, session.origIn + dt));
        if (
          Math.abs(nextIn - session.initialPlayhead) <= snapThresholdSec &&
          session.initialPlayhead < session.origOut - 0.1
        ) {
          nextIn = session.initialPlayhead;
        }
        nextIn = Math.round(nextIn * 100) / 100;
        const preserveStop = session.origStopDefined ? session.origOut : undefined;
        session.currentVal = nextIn;
        onTrimPlayerSpan(session.playerId, nextIn, preserveStop);
        onSeek(nextIn);
        setTrimDrag({ ...session });
      } else {
        let nextOut = Math.max(
          session.origIn + 0.1,
          Math.min(safeDuration, session.origOut + dt)
        );
        let snapEnd = false;
        if (Math.abs(safeDuration - nextOut) <= Math.max(0.08, snapThresholdSec)) {
          nextOut = safeDuration;
          snapEnd = true;
        } else if (
          Math.abs(nextOut - session.initialPlayhead) <= snapThresholdSec &&
          session.initialPlayhead > session.origIn + 0.1
        ) {
          nextOut = session.initialPlayhead;
        }
        nextOut = Math.round(nextOut * 100) / 100;
        session.currentVal = nextOut;
        session.snappedToEnd = snapEnd;
        onTrimPlayerSpan(
          session.playerId,
          session.origInRaw,
          snapEnd ? undefined : nextOut,
          snapEnd ? undefined : 'manual'
        );
        const glanceTime = snapEnd ? Math.max(0, safeDuration - 0.02) : nextOut;
        onSeek(glanceTime);
        setTrimDrag({ ...session });
      }
    };

    const onPointerUp = () => {
      trimDragRef.current = null;
      setTrimDrag(null);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [isTrimming, laneWidth, safeDuration, onPushUndoSnapshot, onTrimPlayerSpan, onSeek]);

  const visiblePlayers = useMemo(() => {
    if (filterMode === 'all') return players;
    return players.filter((p) => {
      const effIn = p.inTime ?? p.anchorTime;
      const effOut = p.stopTime ?? (safeDuration > 0 ? safeDuration : Math.max(effIn, clampedTime));
      return clampedTime >= effIn - 0.03 && clampedTime <= effOut + 0.03;
    });
  }, [players, filterMode, clampedTime, safeDuration]);

  const activeNowCount = useMemo(() => {
    return players.filter((p) => {
      const effIn = p.inTime ?? p.anchorTime;
      const effOut = p.stopTime ?? (safeDuration > 0 ? safeDuration : Math.max(effIn, clampedTime));
      return clampedTime >= effIn - 0.03 && clampedTime <= effOut + 0.03;
    }).length;
  }, [players, clampedTime, safeDuration]);

  const activePlayerTrackRows = useMemo(() => {
    const source = backgroundTracks.length > 0 ? backgroundTracks : implementedTracks;
    return source.map((rec, idx) => {
      const label =
        'label' in rec && typeof rec.label === 'string' && rec.label
          ? rec.label
          : `Player ${idx + 1}`;
      const intervals = computeContiguousIntervals(
        rec.positions.map((pt) => pt.time),
        0.35,
        0.08
      );
      return { rec, label, intervals };
    });
  }, [backgroundTracks, implementedTracks]);

  return (
    <div className="relative bg-[#0B0F14] border-t border-[#1E2936] select-none">
      {/* Fixed-Space Scrollable Multi-Track Timeline Grid */}
      <div
        ref={scrollContainerRef}
        onScroll={(e) => {
          const nextLeft = e.currentTarget.scrollLeft;
          if (Math.abs(nextLeft - tickWindowScrollPx) > viewportWidth * 0.4) {
            setTickWindowScrollPx(nextLeft);
          }
        }}
        style={{ height: `${heightPx}px` }}
        className="overflow-auto relative"
      >
        <div
          className="relative flex flex-col"
          style={{ width: `${GUTTER_WIDTH + laneWidth}px`, minWidth: '100%', minHeight: '100%' }}
        >
          {/* Sticky Top Row: Corner Filter + Timecode Ruler */}
          <div className="sticky top-0 z-30 shrink-0 flex h-[18px] bg-[#0D1218] border-b border-[#1E2936]">
            {/* Sticky Left Corner */}
            <div
              style={{ width: `${GUTTER_WIDTH}px` }}
              className="sticky left-0 z-40 shrink-0 h-full px-2 bg-[#0D1218] border-r border-[#1E2936] flex items-center justify-between gap-1"
            >
              <span className="text-[9.5px] font-semibold tracking-tight text-slate-300 whitespace-nowrap">
                Tracks{' '}
                <span className="font-mono tabular-nums text-slate-400">
                  ({players.length})
                </span>
              </span>

              <div className="flex items-center p-[1px] rounded bg-[#080B0F] border border-[#1E2936]">
                <button
                  type="button"
                  onClick={() => setFilterMode('all')}
                  className={`px-1 py-[1px] text-[9px] rounded leading-none transition-colors ${
                    filterMode === 'all'
                      ? 'bg-[#1D2735] text-slate-100 font-medium'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  All
                </button>
                <button
                  type="button"
                  onClick={() => setFilterMode('now')}
                  title="Show only tools active at current playhead"
                  className={`px-1 py-[1px] text-[9px] rounded leading-none font-mono tabular-nums transition-colors ${
                    filterMode === 'now'
                      ? 'bg-[#1D2735] text-emerald-400 font-medium'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Now {activeNowCount}
                </button>
              </div>
            </div>

            {/* Ruler Scrub Surface */}
            <div
              ref={rulerRef}
              style={{ width: `${laneWidth}px` }}
              onPointerDown={handleScrubPointerDown}
              onPointerMove={handleScrubPointerMove}
              onPointerUp={handleScrubPointerUp}
              onPointerCancel={handleScrubPointerUp}
              className="relative h-full bg-[#0D1218] cursor-ew-resize overflow-hidden shrink-0"
              title="Click/drag to scrub · Scroll wheel to zoom"
            >
              {/* Overview Density Micro-Spans along top 2px of ruler */}
              {safeDuration > 0 &&
                players.map((p) => {
                  const effIn = Math.max(0, Math.min(safeDuration, p.inTime ?? p.anchorTime));
                  const effOut = Math.max(
                    effIn,
                    Math.min(safeDuration, p.stopTime ?? safeDuration)
                  );
                  const leftPct = (effIn / safeDuration) * 100;
                  const widthPct = ((effOut - effIn) / safeDuration) * 100;
                  return (
                    <div
                      key={`${p.id}_ov`}
                      style={{
                        left: `${leftPct}%`,
                        width: `${widthPct}%`,
                        minWidth: '2px',
                        backgroundColor: p.color,
                      }}
                      className="absolute top-0 h-[2px] opacity-60 pointer-events-none"
                    />
                  );
                })}

              {/* Minor Ticks */}
              {safeDuration > 0 &&
                rulerTicks.minor.map((t) => {
                  const pct = (t / safeDuration) * 100;
                  return (
                    <div
                      key={`min_${t}`}
                      style={{ left: `${pct}%` }}
                      className="absolute bottom-0 h-1 w-px bg-[#243040] pointer-events-none"
                    />
                  );
                })}

              {/* Major Ticks (lines drawn at every major step) */}
              {safeDuration > 0 &&
                rulerTicks.major.map((t) => (
                  <div
                    key={`maj_line_${t}`}
                    style={{ left: `${(t / safeDuration) * 100}%` }}
                    className="absolute bottom-0 h-2 w-px bg-slate-500/70 pointer-events-none"
                  />
                ))}

              {/* Collision-free Major Tick Labels */}
              {safeDuration > 0 &&
                rulerTicks.labeledMajors.map(({ t, align, text }) => (
                  <span
                    key={`maj_lbl_${t}`}
                    style={{ left: `${(t / safeDuration) * 100}%` }}
                    className={`absolute top-[1px] text-[9.5px] leading-none font-mono tabular-nums text-slate-400 whitespace-nowrap pointer-events-none ${
                      align === 'right' ? '-translate-x-full pr-1' : 'pl-1'
                    }`}
                  >
                    {text}
                  </span>
                ))}

              {/* Ruler Playhead Cap */}
              {safeDuration > 0 && (
                <div
                  style={{ left: `${playheadPct}%` }}
                  className="absolute top-0 bottom-0 -translate-x-1/2 pointer-events-none z-20"
                >
                  <div className="w-2 h-1.5 bg-emerald-400 [clip-path:polygon(0_0,100%_0,50%_100%)] mx-auto" />
                  <div className="w-[1.5px] h-full bg-emerald-400 mx-auto" />
                </div>
              )}
            </div>
          </div>

          {/* Sticky Coverage Lane Row: Full Players vs Partial Drawn Boxes vs Untracked Gaps */}
          {safeDuration > 0 && (
            <div className="sticky top-[18px] z-25 shrink-0 flex h-[22px] bg-[#0B1017] border-b border-[#1E2936]">
              <div
                style={{ width: `${GUTTER_WIDTH}px` }}
                className="sticky left-0 z-30 shrink-0 h-full px-1.5 bg-[#0C1219] border-r border-[#1E2936] flex items-center justify-between gap-1"
              >
                {activePlayerTrackRows.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setShowTrackedPlayersRows((prev) => !prev)}
                    aria-expanded={showTrackedPlayersRows}
                    title={
                      showTrackedPlayersRows
                        ? 'Collapse per-player tracking intervals'
                        : `Expand ${activePlayerTrackRows.length} tracked player rows`
                    }
                    className="flex items-center gap-0.5 text-[9.5px] font-semibold text-slate-200 hover:text-emerald-300 transition-colors min-w-0 truncate"
                  >
                    {showTrackedPlayersRows ? (
                      <ChevronDown className="w-2.5 h-2.5 shrink-0 text-emerald-400" />
                    ) : (
                      <ChevronRight className="w-2.5 h-2.5 shrink-0 text-slate-400" />
                    )}
                    <span className="truncate">Coverage</span>
                  </button>
                ) : (
                  <span className="text-[9.5px] font-semibold text-slate-300 truncate">
                    Coverage
                  </span>
                )}

                <div className="flex items-center gap-1 shrink-0">
                  <span className="text-[9px] font-mono tabular-nums text-slate-400">
                    {coverageSummary.coveragePct}%
                  </span>
                  {coverageSummary.nextGapTime !== null && (
                    <button
                      type="button"
                      onClick={() => onSeek(coverageSummary.nextGapTime!)}
                      title={`Jump to next untracked gap (${formatShortTime(coverageSummary.nextGapTime)})`}
                      className="inline-flex items-center gap-0.5 px-1 py-[1px] rounded bg-[#141D28] hover:bg-[#1E2B3A] border border-[#253345] text-[8.5px] font-medium text-amber-300 transition-colors whitespace-nowrap"
                    >
                      <span>Gap</span>
                      <ArrowRight className="w-2 h-2" />
                    </button>
                  )}
                </div>
              </div>

              <div
                style={{ width: `${laneWidth}px` }}
                onPointerDown={handleScrubPointerDown}
                onPointerMove={handleScrubPointerMove}
                onPointerUp={handleScrubPointerUp}
                onPointerCancel={handleScrubPointerUp}
                onMouseLeave={() => setCoverageTip(null)}
                className="relative h-full shrink-0 cursor-ew-resize overflow-hidden bg-[#090D13]"
              >
                {coverageSummary.segments.map((seg, idx) => {
                  const leftPct = (seg.start / safeDuration) * 100;
                  const widthPct = Math.max(0.25, ((seg.end - seg.start) / safeDuration) * 100);
                  const approxPx = (widthPct / 100) * laneWidth;

                  if (seg.kind === 'full') {
                    return (
                      <div
                        key={`cov_${idx}`}
                        style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                        onMouseMove={(e) => setCoverageTip({ seg, x: e.clientX, y: e.clientY })}
                        className="absolute top-[2px] bottom-[2px] bg-emerald-500/24 border-y-2 border-emerald-400 flex items-center px-1.5 overflow-hidden"
                      >
                        {approxPx >= 64 && (
                          <span className="inline-flex items-center gap-1 text-[8.5px] font-mono tabular-nums text-emerald-200 whitespace-nowrap pointer-events-none">
                            <ScanSearch className="w-2.5 h-2.5 text-emerald-300 shrink-0" />
                            <span>
                              Full{seg.playerCount > 0 ? ` · ${seg.playerCount}p` : ''}
                            </span>
                          </span>
                        )}
                      </div>
                    );
                  }

                  if (seg.kind === 'partial') {
                    const count = seg.playerCount + seg.toolCount;
                    return (
                      <div
                        key={`cov_${idx}`}
                        style={{
                          left: `${leftPct}%`,
                          width: `${widthPct}%`,
                          backgroundImage:
                            'repeating-linear-gradient(-45deg, rgba(56, 189, 248, 0.24) 0px, rgba(56, 189, 248, 0.24) 5px, rgba(245, 158, 11, 0.16) 5px, rgba(245, 158, 11, 0.16) 10px)',
                        }}
                        onMouseMove={(e) => setCoverageTip({ seg, x: e.clientX, y: e.clientY })}
                        className="absolute top-[2px] bottom-[2px] border-t border-b border-dashed border-sky-400/80 flex items-center px-1.5 overflow-hidden"
                      >
                        {approxPx >= 62 && (
                          <span className="inline-flex items-center gap-1 text-[8.5px] font-mono tabular-nums text-sky-200 whitespace-nowrap pointer-events-none">
                            <BoxSelect className="w-2.5 h-2.5 text-sky-300 shrink-0" />
                            <span>Boxes · {count}</span>
                          </span>
                        )}
                      </div>
                    );
                  }

                  return (
                    <div
                      key={`cov_${idx}`}
                      style={{
                        left: `${leftPct}%`,
                        width: `${widthPct}%`,
                        backgroundImage:
                          'repeating-linear-gradient(-45deg, rgba(148, 163, 184, 0.08) 0px, rgba(148, 163, 184, 0.08) 4px, transparent 4px, transparent 9px)',
                      }}
                      onMouseMove={(e) => setCoverageTip({ seg, x: e.clientX, y: e.clientY })}
                      className="absolute top-[3px] bottom-[3px] border-b border-dashed border-slate-700/80 flex items-center px-1.5 overflow-hidden"
                    >
                      {approxPx >= 68 && (
                        <span className="inline-flex items-center gap-1 text-[8.5px] font-mono text-slate-500 whitespace-nowrap pointer-events-none">
                          <AlertTriangle className="w-2.5 h-2.5 text-slate-500 shrink-0" />
                          <span>Untracked</span>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Collapsible Individual Tracked Player Interval Rows */}
          {safeDuration > 0 &&
            showTrackedPlayersRows &&
            activePlayerTrackRows.map(({ rec, label, intervals }) => {
              const isAuto = rec.source === 'auto';
              const isHov = hoveredTrackedPlayerId === rec.id;
              return (
                <div
                  key={`tr_row_${rec.id}`}
                  onMouseEnter={() => onHoverTrackedPlayer?.(rec.id)}
                  onMouseLeave={() => onHoverTrackedPlayer?.(null)}
                  className={`flex shrink-0 h-[17px] border-b border-[#161E29] transition-colors ${
                    isHov ? 'bg-[#15222E]' : 'bg-[#0A0E14]'
                  }`}
                >
                  <div
                    style={{ width: `${GUTTER_WIDTH}px` }}
                    className={`sticky left-0 z-20 shrink-0 h-full px-1.5 border-r border-[#1E2936] flex items-center justify-between gap-1 ${
                      isHov ? 'bg-[#172430]' : 'bg-[#0C1118]'
                    }`}
                  >
                    <div className="flex items-center gap-1 min-w-0 flex-1 pl-2">
                      {isAuto ? (
                        <ScanSearch className="w-2.5 h-2.5 text-emerald-400 shrink-0" />
                      ) : (
                        <BoxSelect className="w-2.5 h-2.5 text-sky-400 shrink-0" />
                      )}
                      <span className="text-[9.5px] text-slate-300 truncate">{label}</span>
                    </div>
                    <span
                      className={`text-[8.5px] font-mono shrink-0 ${
                        isAuto ? 'text-emerald-400/85' : 'text-sky-400/85'
                      }`}
                    >
                      {isAuto ? 'Auto' : 'Box'}
                    </span>
                  </div>

                  <div
                    style={{ width: `${laneWidth}px` }}
                    onPointerDown={handleScrubPointerDown}
                    onPointerMove={handleScrubPointerMove}
                    onPointerUp={handleScrubPointerUp}
                    className="relative h-full shrink-0 cursor-ew-resize"
                  >
                    {intervals.map((iv, ivIdx) => {
                      const lPct = (iv.start / safeDuration) * 100;
                      const wPct = Math.max(0.25, ((iv.end - iv.start) / safeDuration) * 100);
                      return (
                        <button
                          key={`${rec.id}_iv_${ivIdx}`}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSeek(iv.start);
                          }}
                          title={`${label} (${isAuto ? 'Auto-detected' : 'Drawn Box'}) tracked ${formatShortTime(iv.start)} → ${formatShortTime(iv.end)} — click to jump`}
                          style={{ left: `${lPct}%`, width: `${wPct}%` }}
                          className={`absolute top-[3px] bottom-[3px] rounded-[2px] border transition-colors ${
                            isAuto
                              ? 'bg-emerald-500/25 border-emerald-400/70 hover:bg-emerald-500/40'
                              : 'bg-sky-500/25 border-sky-400/75 hover:bg-sky-500/40'
                          }`}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}

          {/* Continuous Playhead Line behind sticky left gutter & across all lanes */}
          {safeDuration > 0 && (
            <div
              style={{ left: `${GUTTER_WIDTH + playheadPx}px` }}
              className="pointer-events-none absolute top-[18px] bottom-0 w-[1.5px] -ml-[0.75px] bg-emerald-400/90 z-10"
            />
          )}

          {/* Track Rows or Empty State */}
          {players.length === 0 ? (
            <div className="flex shrink-0 items-center h-7 bg-[#0B0F14]">
              <div
                style={{ width: `${GUTTER_WIDTH}px` }}
                className="sticky left-0 z-20 shrink-0 h-full px-2 bg-[#0E131A] border-r border-[#1E2936] flex items-center text-[10px] text-slate-500"
              >
                No active tools
              </div>
              <div
                style={{ width: `${laneWidth}px` }}
                onPointerDown={handleScrubPointerDown}
                onPointerMove={handleScrubPointerMove}
                onPointerUp={handleScrubPointerUp}
                className="h-full px-2.5 flex items-center text-[10px] text-slate-400 cursor-ew-resize"
              >
                {hasVideo
                  ? 'Add a Box (B), Spotlight (S), 3D Ring (G), Chain (L), or Polygon (P) on the video to visualize its timeline span, In/Out period, and keyframes.'
                  : 'Load or generate a match video to inspect timeline tracks.'}
              </div>
            </div>
          ) : visiblePlayers.length === 0 ? (
            <div className="flex shrink-0 items-center h-7 bg-[#0B0F14]">
              <div
                style={{ width: `${GUTTER_WIDTH}px` }}
                className="sticky left-0 z-20 shrink-0 h-full px-2 bg-[#0E131A] border-r border-[#1E2936] flex items-center text-[10px] text-slate-500"
              >
                0 active at {formatShortTime(clampedTime)}
              </div>
              <div
                style={{ width: `${laneWidth}px` }}
                onPointerDown={handleScrubPointerDown}
                onPointerMove={handleScrubPointerMove}
                onPointerUp={handleScrubPointerUp}
                className="h-full px-2.5 flex items-center gap-2 text-[10px] text-slate-400"
              >
                <span>No telestration tools overlap this frame.</span>
                <button
                  type="button"
                  onClick={() => setFilterMode('all')}
                  className="text-emerald-400 hover:underline font-medium"
                >
                  Show all ({players.length})
                </button>
              </div>
            </div>
          ) : (
            visiblePlayers.map((player, rowIdx) => {
              const isSelected = player.id === selectedPlayerId;
              const effIn = Math.max(
                0,
                Math.min(safeDuration || player.anchorTime, player.inTime ?? player.anchorTime)
              );
              const effOut =
                player.stopTime !== undefined
                  ? Math.max(effIn, Math.min(safeDuration || player.stopTime, player.stopTime))
                  : safeDuration > 0
                    ? safeDuration
                    : effIn;
              const isOpenEnd = player.stopTime === undefined;
              const spanDur = Math.max(0, effOut - effIn);
              const isActiveAtPlayhead =
                clampedTime >= effIn - 0.03 && clampedTime <= effOut + 0.03;

              const leftPct = safeDuration > 0 ? (effIn / safeDuration) * 100 : 0;
              const widthPct =
                safeDuration > 0
                  ? Math.max(0, ((effOut - effIn) / safeDuration) * 100)
                  : 100;

              // Gap-accurate CV tracked history intervals inside the span
              const rawHistTimes =
                player.nodes && player.nodes.length > 0
                  ? player.nodes.flatMap((n) => n.history.map((pt) => pt.time))
                  : player.history.map((pt) => pt.time);
              const cvIntervals =
                player.trackWithCv !== false && spanDur > 0.01
                  ? computeContiguousIntervals(
                      rawHistTimes.filter((t) => t >= effIn - 0.04 && t <= effOut + 0.04),
                      0.35,
                      0.06
                    )
                  : [];

              const kfs =
                player.keyframes.length > 0 ? player.keyframes : [player.anchorPosition];

              const rowBg = isSelected
                ? 'bg-[#151E29]'
                : rowIdx % 2 === 0
                  ? 'bg-[#0C1016]'
                  : 'bg-[#0F141C]';

              return (
                <div
                  key={player.id}
                  onClick={() => onSelectPlayer(player.id)}
                  className={`group flex shrink-0 h-[19px] border-b border-[#18212D] transition-colors ${rowBg} hover:bg-[#141D28]`}
                >
                  {/* Sticky Left Track Header */}
                  <div
                    style={{ width: `${GUTTER_WIDTH}px` }}
                    className={`sticky left-0 z-20 shrink-0 h-full px-1.5 border-r border-[#1E2936] flex items-center justify-between gap-1 cursor-pointer ${
                      isSelected ? 'bg-[#172230]' : 'bg-[#0E131B] group-hover:bg-[#131B25]'
                    }`}
                  >
                    <div className="flex items-center gap-1 min-w-0 flex-1">
                      <ToolTypeIcon
                        styleType={player.style}
                        color={player.color}
                        dimmed={!player.visible}
                      />
                      <span
                        className={`text-[10px] truncate ${
                          !player.visible
                            ? 'text-slate-500 line-through'
                            : isSelected
                              ? 'text-slate-100 font-semibold'
                              : isActiveAtPlayhead
                                ? 'text-slate-200 font-medium'
                                : 'text-slate-400'
                        }`}
                      >
                        {player.label}
                      </span>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <span
                        className={`text-[8.5px] font-mono uppercase tracking-tight ${
                          player.trackWithCv === false ? 'text-amber-400/80' : 'text-slate-500'
                        }`}
                        title={
                          player.trackWithCv === false
                            ? 'Pinned static position'
                            : 'Auto CV player tracking'
                        }
                      >
                        {player.trackWithCv === false ? 'PIN' : 'CV'}
                      </span>
                      <span className="text-[9.5px] font-mono tabular-nums text-slate-400 w-[28px] text-right">
                        {spanDur.toFixed(1)}s
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onTogglePlayerVisibility(player.id);
                        }}
                        title={player.visible ? 'Hide tool' : 'Show tool'}
                        aria-label={player.visible ? `Hide ${player.label}` : `Show ${player.label}`}
                        className="p-0.5 rounded text-slate-500 hover:text-slate-200 transition-colors"
                      >
                        {player.visible ? (
                          <Eye className="w-2.5 h-2.5" />
                        ) : (
                          <EyeOff className="w-2.5 h-2.5 text-slate-600" />
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Right Timeline Track Lane */}
                  <div
                    style={{ width: `${laneWidth}px` }}
                    onPointerDown={(e) => {
                      // Scrub if clicking empty background of track lane
                      if (e.target === e.currentTarget) {
                        onSelectPlayer(player.id);
                        handleScrubPointerDown(e);
                      }
                    }}
                    onPointerMove={handleScrubPointerMove}
                    onPointerUp={handleScrubPointerUp}
                    className="relative h-full shrink-0 cursor-ew-resize"
                  >
                    {/* Subtle vertical tick grid lines */}
                    {safeDuration > 0 &&
                      rulerTicks.major.map((t) => (
                        <div
                          key={`grid_${t}`}
                          style={{ left: `${(t / safeDuration) * 100}%` }}
                          className="absolute inset-y-0 w-px bg-[#161F2B] pointer-events-none"
                        />
                      ))}

                    {/* Active Span Bar (From -> To) */}
                    {safeDuration > 0 && (
                      <div
                        style={{
                          left: `${leftPct}%`,
                          width: `${widthPct}%`,
                          minWidth: '2px',
                          backgroundColor: hexToRgba(
                            player.color,
                            !player.visible ? 0.06 : isSelected ? 0.28 : 0.17
                          ),
                          borderColor: hexToRgba(
                            player.color,
                            !player.visible ? 0.25 : isSelected ? 0.9 : 0.52
                          ),
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectPlayer(player.id);
                        }}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          onSelectPlayer(player.id);
                          onSeek(effIn);
                        }}
                        onMouseMove={(e) => {
                          setHoverTip({
                            player,
                            effIn,
                            effOut,
                            isOpenEnd,
                            x: e.clientX,
                            y: e.clientY,
                          });
                        }}
                        onMouseLeave={() => setHoverTip(null)}
                        className={`absolute top-[2px] bottom-[2px] rounded-[3px] border flex items-center overflow-visible cursor-pointer transition-opacity ${
                          !player.visible ? 'opacity-50' : ''
                        }`}
                      >
                        {/* Gap-Accurate CV Tracked History Coverage Strip along bottom of bar */}
                        {player.trackWithCv !== false && spanDur > 0.01 && (
                          <>
                            <div className="absolute left-0 right-0 bottom-0 h-[1px] border-b border-dashed border-slate-500/45 pointer-events-none" />
                            {cvIntervals.map((iv, ivIdx) => {
                              const ivStart = Math.max(effIn, iv.start);
                              const ivEnd = Math.min(effOut, iv.end);
                              if (ivEnd <= ivStart) return null;
                              const ivLeftPct = Math.max(0, ((ivStart - effIn) / spanDur) * 100);
                              const ivWidthPct = Math.max(
                                0.5,
                                Math.min(100 - ivLeftPct, ((ivEnd - ivStart) / spanDur) * 100)
                              );
                              return (
                                <div
                                  key={`${player.id}_cviv_${ivIdx}`}
                                  style={{
                                    left: `${ivLeftPct}%`,
                                    width: `${ivWidthPct}%`,
                                    backgroundColor: player.color,
                                  }}
                                  className="absolute bottom-0 h-[2px] opacity-90 pointer-events-none"
                                />
                              );
                            })}
                          </>
                        )}

                        {/* Glanceable In -> Out (Duration) Text inside Span Bar */}
                        <div className="px-1.5 w-full overflow-hidden flex items-center gap-1 pointer-events-none">
                          <span
                            className="text-[9px] font-medium whitespace-nowrap truncate"
                            style={{ color: isSelected ? '#F8FAFC' : '#E2E8F0' }}
                          >
                            {formatStyleShort(player.style)}
                          </span>
                          <span className="text-[9px] font-mono tabular-nums text-slate-300/90 whitespace-nowrap truncate">
                            {formatShortTime(effIn)} → {isOpenEnd ? 'End' : formatShortTime(effOut)}{' '}
                            <span className="text-slate-400">({spanDur.toFixed(2)}s)</span>
                          </span>
                        </div>

                        {/* Left Edge Trim Handle (In-point) */}
                        <div
                          role="slider"
                          aria-label={`Trim ${player.label} start time`}
                          aria-valuemin={0}
                          aria-valuemax={effOut}
                          aria-valuenow={effIn}
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            if (isPlaying) {
                              onPausePlayback?.();
                            }
                            onSelectPlayer(player.id);
                            onSeek(effIn);
                            const nextSession: TrimDragState = {
                              playerId: player.id,
                              edge: 'in',
                              startX: e.clientX,
                              origIn: effIn,
                              origInRaw: player.inTime,
                              origOut: effOut,
                              origStopDefined: player.stopTime !== undefined,
                              initialPlayhead: clampedTime,
                              currentVal: effIn,
                              snappedToEnd: false,
                              undoPushed: false,
                            };
                            trimDragRef.current = nextSession;
                            setTrimDrag(nextSession);
                          }}
                          title="Drag to crop start time (glances start frame on canvas)"
                          className="absolute -left-[1px] top-0 bottom-0 w-[8px] cursor-ew-resize group/handle flex items-center justify-start pl-[1px] z-20"
                        >
                          <span
                            style={{ backgroundColor: player.color }}
                            className={`w-[3px] h-[11px] rounded-[1px] border border-[#0B0F14]/70 transition-all ${
                              trimDrag?.playerId === player.id && trimDrag.edge === 'in'
                                ? 'opacity-100 scale-y-110 ring-1 ring-white/80'
                                : 'opacity-80 group-hover/handle:opacity-100 group-hover/handle:scale-y-110'
                            }`}
                          />
                        </div>

                        {/* Right Edge Trim Handle (Out-point) */}
                        <div
                          role="slider"
                          aria-label={`Trim ${player.label} end time`}
                          aria-valuemin={effIn}
                          aria-valuemax={safeDuration}
                          aria-valuenow={effOut}
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            if (isPlaying) {
                              onPausePlayback?.();
                            }
                            onSelectPlayer(player.id);
                            const initialGlance =
                              player.stopTime === undefined
                                ? Math.max(0, safeDuration - 0.02)
                                : effOut;
                            onSeek(initialGlance);
                            const nextSession: TrimDragState = {
                              playerId: player.id,
                              edge: 'out',
                              startX: e.clientX,
                              origIn: effIn,
                              origInRaw: player.inTime,
                              origOut: effOut,
                              origStopDefined: player.stopTime !== undefined,
                              initialPlayhead: clampedTime,
                              currentVal: effOut,
                              snappedToEnd: player.stopTime === undefined,
                              undoPushed: false,
                            };
                            trimDragRef.current = nextSession;
                            setTrimDrag(nextSession);
                          }}
                          title="Drag to crop end time (glances end frame on canvas)"
                          className="absolute -right-[1px] top-0 bottom-0 w-[8px] cursor-ew-resize group/handle flex items-center justify-end pr-[1px] z-20"
                        >
                          <span
                            style={{ backgroundColor: player.color }}
                            className={`w-[3px] h-[11px] rounded-[1px] border border-[#0B0F14]/70 transition-all ${
                              trimDrag?.playerId === player.id && trimDrag.edge === 'out'
                                ? 'opacity-100 scale-y-110 ring-1 ring-white/80'
                                : 'opacity-80 group-hover/handle:opacity-100 group-hover/handle:scale-y-110'
                            }`}
                          />
                        </div>

                        {/* Live Trim Floating Readout */}
                        {trimDrag && trimDrag.playerId === player.id && (
                          <div
                            className={`pointer-events-none absolute -top-5 z-40 px-1.5 py-0.5 rounded bg-[#070A0E] border border-[#2C3A4D] text-[9.5px] font-mono tabular-nums text-slate-100 whitespace-nowrap shadow-lg ${
                              trimDrag.edge === 'in' ? 'left-0' : 'right-0'
                            }`}
                          >
                            {trimDrag.edge === 'in'
                              ? `In ${formatShortTime(trimDrag.currentVal)}`
                              : trimDrag.snappedToEnd
                                ? 'Out End'
                                : `Out ${formatShortTime(trimDrag.currentVal)}`}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Anchor & Realignment Keyframe Markers on the Lane */}
                    {safeDuration > 0 &&
                      kfs
                        .filter((kf) => kf.time >= effIn - 0.03 && kf.time <= effOut + 0.03)
                        .map((kf, idx) => {
                          const kfPct = Math.max(0, Math.min(100, (kf.time / safeDuration) * 100));
                          const isRealign = idx > 0;
                          return (
                            <button
                              key={`${player.id}_tkf_${idx}`}
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onSelectPlayer(player.id);
                                onSeek(kf.time);
                              }}
                              title={`${player.label} ${isRealign ? 'realigned' : 'anchored'} at ${formatShortTime(kf.time)} — click to jump`}
                              style={{
                                left: `${kfPct}%`,
                                backgroundColor: isRealign ? '#F59E0B' : player.color,
                              }}
                              className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 z-[15] border border-[#0B0F14] hover:scale-125 transition-transform ${
                                isRealign ? 'w-1.5 h-1.5 rotate-45 rounded-[1px]' : 'w-1.5 h-1.5 rounded-full'
                              }`}
                            />
                          );
                        })}

                    {/* Stop Marker Cap when stopped before clip end */}
                    {safeDuration > 0 && player.stopTime !== undefined && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectPlayer(player.id);
                          onSeek(player.stopTime!);
                        }}
                        title={`${player.label} ${
                          player.stopReason === 'out-of-frame' ? 'out of camera' : 'stopped'
                        } at ${formatShortTime(player.stopTime)} — click to jump`}
                        style={{
                          left: `${Math.max(0, Math.min(100, (player.stopTime / safeDuration) * 100))}%`,
                          borderColor:
                            player.stopReason === 'out-of-frame' ? '#F43F5E' : player.color,
                        }}
                        className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 z-[15] w-1.5 h-1.5 bg-[#0B0F14] border-2 rounded-[1px] hover:scale-125 transition-transform"
                      />
                    )}
                  </div>
                </div>
              );
            })
          )}

          {/* Filler Lane so sticky gutter, grid lines, scrub target, and playhead fill full timeline height */}
          <div className="flex flex-1 min-h-0 bg-[#0B0F14]">
            <div
              style={{ width: `${GUTTER_WIDTH}px` }}
              className="sticky left-0 z-20 shrink-0 bg-[#0D1217] border-r border-[#1E2936]"
            />
            <div
              style={{ width: `${laneWidth}px` }}
              onPointerDown={handleScrubPointerDown}
              onPointerMove={handleScrubPointerMove}
              onPointerUp={handleScrubPointerUp}
              onPointerCancel={handleScrubPointerUp}
              className="relative shrink-0 cursor-ew-resize"
            >
              {safeDuration > 0 &&
                rulerTicks.major.map((t) => (
                  <div
                    key={`fill_grid_${t}`}
                    style={{ left: `${(t / safeDuration) * 100}%` }}
                    className="absolute inset-y-0 w-px bg-[#161F2B]/70 pointer-events-none"
                  />
                ))}
            </div>
          </div>
        </div>
      </div>

      {/* Rich Glanceable Hover Tooltip (Fixed so it never clips inside scroll container) */}
      {hoverTip && !trimDrag && (
        <div
          style={{
            left: Math.min(window.innerWidth - 240, Math.max(12, hoverTip.x + 12)),
            top: Math.max(12, hoverTip.y - 50),
          }}
          className="pointer-events-none fixed z-50 px-2 py-1 rounded bg-[#0A0E14]/95 border border-[#2A3749] shadow-xl text-[10px] text-slate-200 space-y-0.5"
        >
          <div className="flex items-center gap-2 font-semibold">
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: hoverTip.player.color }}
            />
            <span>{hoverTip.player.label}</span>
            <span className="text-slate-400 font-normal">
              · {formatStyleShort(hoverTip.player.style)}
            </span>
          </div>
          <div className="font-mono tabular-nums text-[10px] text-slate-300">
            {formatShortTime(hoverTip.effIn)} →{' '}
            {hoverTip.isOpenEnd ? `${formatShortTime(hoverTip.effOut)} (End)` : formatShortTime(hoverTip.effOut)}
            <span className="text-emerald-400 ml-1.5">
              {(hoverTip.effOut - hoverTip.effIn).toFixed(2)}s
            </span>
          </div>
          <div className="text-[10px] text-slate-400">
            {hoverTip.player.keyframes.length} keyframe
            {hoverTip.player.keyframes.length === 1 ? '' : 's'} ·{' '}
            {hoverTip.player.trackWithCv === false ? 'Pinned static' : 'CV auto-track'} · Drag edges
            to trim
          </div>
        </div>
      )}

      {/* Coverage Segment Hover Tooltip */}
      {coverageTip && !trimDrag && !hoverTip && (
        <div
          style={{
            left: Math.min(window.innerWidth - 250, Math.max(12, coverageTip.x + 12)),
            top: Math.max(12, coverageTip.y - 54),
          }}
          className="pointer-events-none fixed z-50 px-2 py-1 rounded bg-[#0A0E14]/95 border border-[#2A3749] shadow-xl text-[10px] text-slate-200 space-y-0.5"
        >
          <div className="flex items-center gap-1.5 font-semibold">
            {coverageTip.seg.kind === 'full' ? (
              <>
                <ScanSearch className="w-3 h-3 text-emerald-400 shrink-0" />
                <span className="text-emerald-300">Full Players Tracked</span>
              </>
            ) : coverageTip.seg.kind === 'partial' ? (
              <>
                <BoxSelect className="w-3 h-3 text-sky-400 shrink-0" />
                <span className="text-sky-300">Partial · Drawn Boxes / Tools</span>
              </>
            ) : (
              <>
                <AlertTriangle className="w-3 h-3 text-slate-400 shrink-0" />
                <span className="text-slate-300">Untracked Area</span>
              </>
            )}
          </div>
          <div className="font-mono tabular-nums text-[10px] text-slate-300">
            {formatShortTime(coverageTip.seg.start)} → {formatShortTime(coverageTip.seg.end)}
            <span className="text-slate-400 ml-1.5">
              ({Math.max(0, coverageTip.seg.end - coverageTip.seg.start).toFixed(2)}s)
            </span>
          </div>
          <div className="text-[10px] text-slate-400 font-mono tabular-nums">
            {coverageTip.seg.kind === 'untracked'
              ? 'No tracked players or CV tools in this range'
              : `${coverageTip.seg.autoCount} auto · ${coverageTip.seg.manualCount} drawn box · ${coverageTip.seg.toolCount} CV tool`}
          </div>
        </div>
      )}
    </div>
  );
};

const ToolTypeIcon: React.FC<{
  styleType: CircleStyle;
  color: string;
  dimmed?: boolean;
}> = ({ styleType, color, dimmed }) => {
  const cls = `w-3 h-3 shrink-0 ${dimmed ? 'opacity-40' : ''}`;
  const st = { color };
  if (styleType === 'spotlight') return <Sun className={cls} style={st} />;
  if (styleType === 'foot-ring') return <Disc className={cls} style={st} />;
  if (styleType === 'chain') return <Link2 className={cls} style={st} />;
  if (styleType === 'polygon') return <Pentagon className={cls} style={st} />;
  if (styleType === 'reticle') return <Crosshair className={cls} style={st} />;
  if (styleType === 'halo') return <CircleDot className={cls} style={st} />;
  return <BoxSelect className={cls} style={st} />;
};

function formatStyleShort(style: CircleStyle): string {
  switch (style) {
    case 'ring':
      return 'Box';
    case 'halo':
      return 'Halo';
    case 'reticle':
      return 'Reticle';
    case 'spotlight':
      return 'Spotlight';
    case 'foot-ring':
      return '3D Ring';
    case 'chain':
      return 'Chain';
    case 'polygon':
      return 'Polygon';
  }
}

function formatShortTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00.00';
  const totalCs = Math.floor(seconds * 100 + 1e-6);
  const mins = Math.floor(totalCs / 6000);
  const secs = Math.floor((totalCs % 6000) / 100);
  const cs = totalCs % 100;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function formatRulerTime(seconds: number, subDecimals: boolean, centiDecimals: boolean): string {
  if (centiDecimals) {
    const totalCs = Math.round(seconds * 100);
    const mins = Math.floor(totalCs / 6000);
    const secs = Math.floor((totalCs % 6000) / 100);
    const cs = totalCs % 100;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }
  if (subDecimals) {
    const totalTenths = Math.round(seconds * 10);
    const mins = Math.floor(totalTenths / 600);
    const secs = Math.floor((totalTenths % 600) / 10);
    const tenths = totalTenths % 10;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths}`;
  }
  const totalSecs = Math.round(seconds);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function hexToRgba(hex: string, alpha: number): string {
  let clean = hex.replace('#', '');
  if (clean.length === 3) {
    clean = clean
      .split('')
      .map((c) => c + c)
      .join('');
  }
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${Number.isNaN(r) ? 255 : r}, ${Number.isNaN(g) ? 255 : g}, ${
    Number.isNaN(b) ? 255 : b
  }, ${alpha})`;
}
