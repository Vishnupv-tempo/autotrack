import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsLeft,
  ChevronsRight,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  BackgroundPlayerTrackRecord,
  CoverageSummary,
  ImplementedTrackRecord,
  TrackedPlayer,
} from '../types/tracking';
import { TelestrationTimeline } from './TelestrationTimeline';

interface PlayerTransportProps {
  hasVideo: boolean;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  playbackRate: number;
  isLooping: boolean;
  players: TrackedPlayer[];
  selectedPlayerId: string | null;
  coverageSummary: CoverageSummary;
  backgroundTracks: BackgroundPlayerTrackRecord[];
  implementedTracks: ImplementedTrackRecord[];
  hoveredTrackedPlayerId?: string | null;
  onHoverTrackedPlayer?: (id: string | null) => void;
  onTogglePlay: () => void;
  onStepFrame: (direction: -1 | 1) => void;
  onSkipSeconds: (deltaSeconds: number) => void;
  onSeek: (time: number) => void;
  onChangeRate: (rate: number) => void;
  onToggleLoop: () => void;
  onJumpToStart: () => void;
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
  onSetInAtPlayhead: (playerId: string) => void;
  onSetOutAtPlayhead: (playerId: string) => void;
}

const SPEED_OPTIONS = [0.25, 0.5, 1];
const BASE_MAX_TIMELINE_ZOOM = 16;
const DEFAULT_TIMELINE_HEIGHT = 168;
const MIN_TIMELINE_HEIGHT = 38;
const FALLBACK_MAX_TIMELINE_HEIGHT = 640;

export const PlayerTransport: React.FC<PlayerTransportProps> = ({
  hasVideo,
  isPlaying,
  currentTime,
  duration,
  playbackRate,
  isLooping,
  players,
  selectedPlayerId,
  coverageSummary,
  backgroundTracks,
  implementedTracks,
  hoveredTrackedPlayerId = null,
  onHoverTrackedPlayer,
  onTogglePlay,
  onStepFrame,
  onSkipSeconds,
  onSeek,
  onChangeRate,
  onToggleLoop,
  onJumpToStart,
  onSelectPlayer,
  onTogglePlayerVisibility,
  onPausePlayback,
  onPushUndoSnapshot,
  onTrimPlayerSpan,
  onSetInAtPlayhead,
  onSetOutAtPlayhead,
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [timelineExpanded, setTimelineExpanded] = useState(true);
  const [timelineHeight, setTimelineHeight] = useState(DEFAULT_TIMELINE_HEIGHT);
  const [maxTimelineHeight, setMaxTimelineHeight] = useState(FALLBACK_MAX_TIMELINE_HEIGHT);
  const [resizingTimeline, setResizingTimeline] = useState<{
    startY: number;
    startHeight: number;
  } | null>(null);

  useEffect(() => {
    const parentEl = rootRef.current?.parentElement;
    if (!parentEl) return;

    const syncMaxHeight = () => {
      const parentH = parentEl.clientHeight;
      if (parentH > 0) {
        // Reserve at least 120px for the video stage + 26px transport + 12px handles/borders
        const computedMax = Math.max(MIN_TIMELINE_HEIGHT + 80, parentH - 158);
        setMaxTimelineHeight(computedMax);
      }
    };

    syncMaxHeight();
    const ro = new ResizeObserver(syncMaxHeight);
    ro.observe(parentEl);
    return () => ro.disconnect();
  }, []);

  const effectiveTimelineHeight = Math.max(
    MIN_TIMELINE_HEIGHT,
    Math.min(maxTimelineHeight, timelineHeight)
  );

  const startTimelineResize = useCallback(
    (clientY: number) => {
      setResizingTimeline({ startY: clientY, startHeight: effectiveTimelineHeight });
    },
    [effectiveTimelineHeight]
  );

  useEffect(() => {
    if (!resizingTimeline) return;

    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';

    const onPointerMove = (e: PointerEvent) => {
      const deltaY = resizingTimeline.startY - e.clientY;
      const next = Math.max(
        MIN_TIMELINE_HEIGHT,
        Math.min(maxTimelineHeight, resizingTimeline.startHeight + deltaY)
      );
      setTimelineHeight(Math.round(next));
    };

    const onPointerUp = () => {
      setResizingTimeline(null);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [resizingTimeline, maxTimelineHeight]);

  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const clampedTime = safeDuration > 0 ? Math.min(Math.max(0, currentTime), safeDuration) : 0;
  const estimatedFrame = Math.round(clampedTime * 30);

  const tenSecZoom =
    safeDuration > 10 ? Math.round((safeDuration / 10) * 100) / 100 : 1;
  const maxTimelineZoom =
    safeDuration > 0 ? Math.max(BASE_MAX_TIMELINE_ZOOM, tenSecZoom) : BASE_MAX_TIMELINE_ZOOM;

  useEffect(() => {
    setTimelineZoom(1);
  }, [safeDuration]);

  const activeAtPlayhead = players.filter((p) => {
    const effIn = p.inTime ?? p.anchorTime;
    const effOut = p.stopTime ?? (safeDuration > 0 ? safeDuration : effIn);
    return p.visible && clampedTime >= effIn - 0.03 && clampedTime <= effOut + 0.03;
  }).length;

  const selectedPlayer =
    players.find((p) => p.id === selectedPlayerId) ?? players[0] ?? null;

  const zoomSliderValue =
    maxTimelineZoom > 1
      ? Math.round((Math.log(Math.max(1, timelineZoom)) / Math.log(maxTimelineZoom)) * 100)
      : 0;
  const isZoomed = timelineZoom > 1.02;
  const visibleWindowSec = safeDuration > 0 ? safeDuration / Math.max(1, timelineZoom) : 0;
  const isTenSecZoom = safeDuration > 10.2 && Math.abs(visibleWindowSec - 10) < 0.2;

  const handleZoomSlider = (pct: number) => {
    if (pct <= 1) {
      setTimelineZoom(1);
      return;
    }
    if (pct >= 99) {
      setTimelineZoom(maxTimelineZoom);
      return;
    }
    const raw = Math.pow(maxTimelineZoom, pct / 100);
    setTimelineZoom(Math.round(raw * 100) / 100);
  };

  const stepZoom = (factor: number) => {
    setTimelineZoom((prev) => {
      const next = Math.max(1, Math.min(maxTimelineZoom, prev * factor));
      return next < 1.05 ? 1 : Math.round(next * 100) / 100;
    });
  };

  const cycleSpeed = () => {
    const idx = SPEED_OPTIONS.indexOf(playbackRate);
    const next = SPEED_OPTIONS[(idx + 1) % SPEED_OPTIONS.length];
    onChangeRate(next);
  };

  return (
    <div
      ref={rootRef}
      className="w-full max-w-full bg-[#10161E] border-t border-[#1E2936] select-none shrink-0 overflow-hidden"
    >
      {/* Top-edge splitter so dragging the stage/dock border also resizes timeline */}
      {timelineExpanded && (
        <div
          aria-hidden="true"
          title="Drag up/down to resize timeline (double-click to reset)"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            startTimelineResize(e.clientY);
          }}
          onDoubleClick={() => setTimelineHeight(DEFAULT_TIMELINE_HEIGHT)}
          className={`h-[4px] w-full cursor-ns-resize touch-none transition-colors ${
            resizingTimeline
              ? 'bg-emerald-500/35'
              : 'bg-transparent hover:bg-emerald-500/25'
          }`}
        />
      )}

      {/* Strictly Single-Line Compact Transport & Timecode Strip */}
      <div className="h-[26px] px-2 w-full flex items-center justify-between gap-1.5 flex-nowrap overflow-hidden">
        {/* Left: Compact Transport Controls */}
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={onJumpToStart}
            disabled={!hasVideo}
            title="Return to start"
            aria-label="Return to start"
            className="w-5 h-5 rounded bg-[#18202B] hover:bg-[#222D3D] text-slate-300 hover:text-white flex items-center justify-center transition-colors disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-emerald-400"
          >
            <RotateCcw className="w-2.5 h-2.5" />
          </button>

          <button
            type="button"
            onClick={() => onSkipSeconds(-5)}
            disabled={!hasVideo}
            title="Back 5 seconds (Shift+Left Arrow)"
            className="h-5 px-1.5 rounded bg-[#18202B] hover:bg-[#222D3D] text-slate-200 text-[9.5px] font-mono font-medium flex items-center gap-0.5 transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-emerald-400"
          >
            <ChevronsLeft className="w-2.5 h-2.5" />
            <span>5s</span>
          </button>

          <button
            type="button"
            onClick={() => onStepFrame(-1)}
            disabled={!hasVideo || isPlaying}
            title="Previous frame (Left Arrow)"
            className="h-5 px-1.5 rounded bg-[#18202B] hover:bg-[#222D3D] text-slate-200 text-[9.5px] font-mono font-medium flex items-center gap-0.5 transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-emerald-400"
          >
            <ChevronLeft className="w-2.5 h-2.5" />
            <span>1f</span>
          </button>

          <button
            type="button"
            onClick={onTogglePlay}
            disabled={!hasVideo}
            title={isPlaying ? 'Pause (Space)' : 'Play & Track (Space)'}
            className="h-5 px-2 rounded bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-[10px] font-semibold flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-emerald-300"
          >
            {isPlaying ? (
              <>
                <Pause className="w-2.5 h-2.5 fill-current" />
                <span>Pause</span>
              </>
            ) : (
              <>
                <Play className="w-2.5 h-2.5 fill-current" />
                <span>Play</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => onStepFrame(1)}
            disabled={!hasVideo || isPlaying}
            title="Next frame (Right Arrow)"
            className="h-5 px-1.5 rounded bg-[#18202B] hover:bg-[#222D3D] text-slate-200 text-[9.5px] font-mono font-medium flex items-center gap-0.5 transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-emerald-400"
          >
            <span>1f</span>
            <ChevronRight className="w-2.5 h-2.5" />
          </button>

          <button
            type="button"
            onClick={() => onSkipSeconds(5)}
            disabled={!hasVideo}
            title="Forward 5 seconds (Shift+Right Arrow)"
            className="h-5 px-1.5 rounded bg-[#18202B] hover:bg-[#222D3D] text-slate-200 text-[9.5px] font-mono font-medium flex items-center gap-0.5 transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-emerald-400"
          >
            <span>5s</span>
            <ChevronsRight className="w-2.5 h-2.5" />
          </button>
        </div>

        {/* Center: Compact Single-Line Timecode, Coverage Mode & Active Counter */}
        <div className="flex items-center gap-1.5 text-[10px] font-mono tabular-nums whitespace-nowrap min-w-0 truncate">
          <span className="text-slate-100 font-semibold">
            {formatTimecode(clampedTime)}
            <span className="text-slate-500 font-normal">/{formatTimecode(safeDuration)}</span>
          </span>
          {(coverageSummary.trackedSeconds > 0 || players.length > 0) && (
            <>
              <span className="hidden lg:inline text-slate-600" aria-hidden="true">
                ·
              </span>
              <span
                className={`hidden lg:inline font-sans font-medium ${
                  coverageSummary.currentKind === 'full'
                    ? 'text-emerald-400'
                    : coverageSummary.currentKind === 'partial'
                      ? 'text-sky-400'
                      : 'text-slate-400'
                }`}
                title={`Tracked clip coverage: ${coverageSummary.coveragePct}% (Full ${coverageSummary.fullSeconds.toFixed(1)}s · Boxes ${coverageSummary.partialSeconds.toFixed(1)}s · Untracked ${coverageSummary.untrackedSeconds.toFixed(1)}s)`}
              >
                {coverageSummary.currentKind === 'full'
                  ? 'Full'
                  : coverageSummary.currentKind === 'partial'
                    ? 'Boxes'
                    : 'Untracked'}{' '}
                <span className="font-mono tabular-nums text-slate-400">
                  {coverageSummary.coveragePct}%
                </span>
              </span>
              {coverageSummary.nextGapTime !== null && (
                <button
                  type="button"
                  onClick={() => onSeek(coverageSummary.nextGapTime!)}
                  title={`Jump to next untracked gap (${formatTimecode(coverageSummary.nextGapTime)})`}
                  className="hidden xl:inline-flex items-center gap-0.5 text-[9.5px] font-sans text-amber-300 hover:text-amber-200 underline-offset-2 hover:underline shrink-0"
                >
                  <span>Gap</span>
                  <ArrowRight className="w-2.5 h-2.5" />
                </button>
              )}
            </>
          )}
          <span className="hidden xl:inline text-slate-600" aria-hidden="true">
            ·
          </span>
          <span className="hidden xl:inline text-slate-400">F{estimatedFrame}</span>
          <span className="hidden 2xl:inline text-slate-600" aria-hidden="true">
            ·
          </span>
          <span className="hidden 2xl:inline text-slate-400">
            <span className="text-emerald-400 font-medium">{activeAtPlayhead}</span>
            <span className="text-slate-500">/{players.length}</span>
          </span>
        </div>

        {/* Right: Quick In/Out, Modern Continuous Zoom, Speed, Loop & Collapse */}
        <div className="flex items-center gap-1 shrink-0">
          <div className="hidden md:flex items-center p-[1px] rounded bg-[#0B0F14] border border-[#1E2936]">
            <button
              type="button"
              disabled={!hasVideo || !selectedPlayer}
              onClick={() => selectedPlayer && onSetInAtPlayhead(selectedPlayer.id)}
              title="Set selected tool In-point to playhead ([)"
              className="px-1.5 py-[1px] text-[9.5px] font-mono text-slate-300 hover:text-emerald-300 hover:bg-[#1A222E] rounded transition-colors disabled:opacity-35 whitespace-nowrap"
            >
              In [
            </button>
            <button
              type="button"
              disabled={!hasVideo || !selectedPlayer}
              onClick={() => selectedPlayer && onSetOutAtPlayhead(selectedPlayer.id)}
              title="Set selected tool Out-point to playhead (])"
              className="px-1.5 py-[1px] text-[9.5px] font-mono text-slate-300 hover:text-amber-300 hover:bg-[#1A222E] rounded transition-colors disabled:opacity-35 whitespace-nowrap"
            >
              Out ]
            </button>
          </div>

          {/* Modern Continuous Timeline Zoom */}
          <div
            className="flex items-center gap-0.5 px-1 py-[1px] rounded bg-[#0B0F14] border border-[#1E2936]"
            title={
              safeDuration > 0
                ? `Timeline zoom (${visibleWindowSec.toFixed(1)}s visible width · Ctrl/Alt+Scroll or Ruler Scroll)`
                : 'Timeline zoom (or Ctrl/Alt + Scroll / Ruler Scroll)'
            }
          >
            <button
              type="button"
              onClick={() => stepZoom(1 / 1.4)}
              disabled={!hasVideo || timelineZoom <= 1.01}
              aria-label="Zoom out timeline"
              title="Zoom out"
              className="p-0.5 rounded text-slate-400 hover:text-slate-100 disabled:opacity-35 transition-colors"
            >
              <ZoomOut className="w-2.5 h-2.5" />
            </button>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={zoomSliderValue}
              disabled={!hasVideo}
              onChange={(e) => handleZoomSlider(Number(e.target.value))}
              aria-label="Timeline zoom"
              className="pitch-slider w-11 sm:w-14 disabled:opacity-40"
            />
            <button
              type="button"
              onClick={() => stepZoom(1.4)}
              disabled={!hasVideo || timelineZoom >= maxTimelineZoom}
              aria-label="Zoom in timeline"
              title="Zoom in"
              className="p-0.5 rounded text-slate-400 hover:text-slate-100 disabled:opacity-35 transition-colors"
            >
              <ZoomIn className="w-2.5 h-2.5" />
            </button>
            <button
              type="button"
              onClick={() => setTimelineZoom(1)}
              disabled={!hasVideo || !isZoomed}
              title={isZoomed ? 'Reset zoom to Fit' : 'Fitted to clip duration'}
              className={`min-w-[24px] px-1 py-[1px] text-[9.5px] font-mono tabular-nums rounded text-center transition-colors whitespace-nowrap ${
                isZoomed
                  ? 'bg-[#1D2735] text-cyan-300 font-semibold hover:bg-[#253244]'
                  : 'text-slate-400'
              }`}
            >
              {isZoomed
                ? timelineZoom >= 100
                  ? `${Math.round(timelineZoom)}x`
                  : `${timelineZoom.toFixed(1)}x`
                : 'Fit'}
            </button>
            {safeDuration > 10.2 && (
              <button
                type="button"
                onClick={() => setTimelineZoom(isTenSecZoom ? 1 : tenSecZoom)}
                disabled={!hasVideo}
                title={
                  isTenSecZoom
                    ? '10s view active (click to fit full clip)'
                    : 'Zoom so one whole timeline width equals 10 seconds'
                }
                className={`px-1 py-[1px] text-[9.5px] font-mono tabular-nums rounded transition-colors whitespace-nowrap ${
                  isTenSecZoom
                    ? 'bg-emerald-500/20 text-emerald-300 font-semibold'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-[#1A222E]'
                }`}
              >
                10s
              </button>
            )}
          </div>

          {/* Segmented speed on xl+, compact single cycle button on smaller widths */}
          <div className="hidden xl:flex items-center p-[1px] rounded bg-[#0B0F14] border border-[#1E2936]">
            {SPEED_OPTIONS.map((rate) => (
              <button
                key={rate}
                type="button"
                onClick={() => onChangeRate(rate)}
                disabled={!hasVideo}
                className={`px-1 py-[1px] text-[9.5px] font-mono tabular-nums rounded transition-colors whitespace-nowrap disabled:opacity-40 ${
                  playbackRate === rate
                    ? 'bg-[#1D2735] text-emerald-400 font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {rate}x
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={cycleSpeed}
            disabled={!hasVideo}
            title="Cycle playback speed (0.25x / 0.5x / 1x)"
            className="xl:hidden h-5 px-1.5 rounded bg-[#0B0F14] border border-[#1E2936] text-[9.5px] font-mono tabular-nums text-emerald-400 font-semibold hover:bg-[#18202B] transition-colors whitespace-nowrap disabled:opacity-40"
          >
            {playbackRate}x
          </button>

          <button
            type="button"
            onClick={onToggleLoop}
            disabled={!hasVideo}
            title="Loop clip"
            aria-label="Loop clip"
            aria-pressed={isLooping}
            className={`w-5 h-5 rounded border flex items-center justify-center transition-colors disabled:opacity-40 ${
              isLooping
                ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400'
                : 'bg-[#18202B] border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Repeat className="w-2.5 h-2.5" />
          </button>

          <button
            type="button"
            onClick={() => setTimelineExpanded((prev) => !prev)}
            title={timelineExpanded ? 'Collapse tool tracks' : 'Expand tool tracks'}
            aria-label={timelineExpanded ? 'Collapse tool tracks' : 'Expand tool tracks'}
            aria-expanded={timelineExpanded}
            className="w-5 h-5 rounded bg-[#18202B] hover:bg-[#222D3D] text-slate-300 hover:text-white flex items-center justify-center transition-colors"
          >
            {timelineExpanded ? (
              <ChevronDown className="w-2.5 h-2.5" />
            ) : (
              <ChevronUp className="w-2.5 h-2.5" />
            )}
          </button>
        </div>
      </div>

      {/* Resizable Fixed-Space Multi-Track Timeline (or slim progress bar when collapsed) */}
      {timelineExpanded ? (
        <div className="relative">
          {/* Drag Handle to Resize Timeline Height */}
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Drag to resize timeline height"
            aria-valuemin={MIN_TIMELINE_HEIGHT}
            aria-valuemax={maxTimelineHeight}
            aria-valuenow={effectiveTimelineHeight}
            title="Drag up/down to resize timeline (double-click to reset)"
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              startTimelineResize(e.clientY);
            }}
            onDoubleClick={() => setTimelineHeight(DEFAULT_TIMELINE_HEIGHT)}
            className={`relative h-2 w-full cursor-ns-resize touch-none flex items-center justify-center border-t transition-colors ${
              resizingTimeline
                ? 'bg-emerald-500/20 border-emerald-400/70'
                : 'bg-[#0E141C] border-[#1E2936] hover:bg-[#16202C] hover:border-emerald-500/40'
            }`}
          >
            <span
              className={`w-12 h-[3px] rounded-full transition-colors ${
                resizingTimeline ? 'bg-emerald-400' : 'bg-slate-500/80'
              }`}
            />
            {resizingTimeline && (
              <span className="pointer-events-none absolute right-2 text-[9px] font-mono tabular-nums text-emerald-300 bg-[#080B0F]/90 px-1.5 py-[1px] rounded border border-emerald-500/40">
                {effectiveTimelineHeight}px
              </span>
            )}
          </div>

          <TelestrationTimeline
            hasVideo={hasVideo}
            isPlaying={isPlaying}
            currentTime={currentTime}
            duration={duration}
            zoom={timelineZoom}
            maxZoom={maxTimelineZoom}
            onZoomChange={setTimelineZoom}
            heightPx={effectiveTimelineHeight}
            players={players}
            selectedPlayerId={selectedPlayerId}
            coverageSummary={coverageSummary}
            backgroundTracks={backgroundTracks}
            implementedTracks={implementedTracks}
            hoveredTrackedPlayerId={hoveredTrackedPlayerId}
            onHoverTrackedPlayer={onHoverTrackedPlayer}
            onSeek={onSeek}
            onSelectPlayer={onSelectPlayer}
            onTogglePlayerVisibility={onTogglePlayerVisibility}
            onPausePlayback={onPausePlayback}
            onPushUndoSnapshot={onPushUndoSnapshot}
            onTrimPlayerSpan={onTrimPlayerSpan}
          />
        </div>
      ) : (
        <div className="px-3 pb-1.5">
          <div className="relative h-2 bg-[#1A222E] rounded-full overflow-hidden">
            {safeDuration > 0 &&
              coverageSummary.segments.map((seg, idx) => {
                const leftPct = (seg.start / safeDuration) * 100;
                const widthPct = Math.max(0.25, ((seg.end - seg.start) / safeDuration) * 100);
                if (seg.kind === 'untracked') {
                  return (
                    <div
                      key={`cov_mini_${idx}`}
                      style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                      className="absolute bottom-0 h-[3px] bg-slate-700/40"
                    />
                  );
                }
                if (seg.kind === 'partial') {
                  return (
                    <div
                      key={`cov_mini_${idx}`}
                      style={{
                        left: `${leftPct}%`,
                        width: `${widthPct}%`,
                        backgroundImage:
                          'repeating-linear-gradient(135deg, rgba(56,189,248,0.85) 0px, rgba(56,189,248,0.85) 3px, rgba(14,165,233,0.3) 3px, rgba(14,165,233,0.3) 6px)',
                      }}
                      className="absolute bottom-0 h-[3px]"
                    />
                  );
                }
                return (
                  <div
                    key={`cov_mini_${idx}`}
                    style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                    className="absolute bottom-0 h-[3px] bg-emerald-400/90"
                  />
                );
              })}
            <div
              className="h-full bg-emerald-500/45 transition-[width] duration-75"
              style={{ width: `${safeDuration > 0 ? (clampedTime / safeDuration) * 100 : 0}%` }}
            />
            {safeDuration > 0 &&
              players.map((p) => {
                const effIn = p.inTime ?? p.anchorTime;
                const effOut = p.stopTime ?? safeDuration;
                return (
                  <div
                    key={`${p.id}_mini`}
                    style={{
                      left: `${(effIn / safeDuration) * 100}%`,
                      width: `${((effOut - effIn) / safeDuration) * 100}%`,
                      minWidth: '2px',
                      backgroundColor: p.color,
                    }}
                    className="absolute top-0 h-[2px] opacity-85"
                  />
                );
              })}
            <input
              type="range"
              min={0}
              max={safeDuration || 1}
              step={0.01}
              value={safeDuration > 0 ? clampedTime : 0}
              disabled={!hasVideo || safeDuration === 0}
              onChange={(e) => onSeek(parseFloat(e.target.value))}
              aria-label="Collapsed video timeline scrubber"
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
          </div>
        </div>
      )}
    </div>
  );
};

export function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00.00';
  const totalCs = Math.floor(seconds * 100 + 1e-6);
  const mins = Math.floor(totalCs / 6000);
  const secs = Math.floor((totalCs % 6000) / 100);
  const cs = totalCs % 100;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
