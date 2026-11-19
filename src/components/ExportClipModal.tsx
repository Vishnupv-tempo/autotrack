import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Download,
  Film,
  Loader2,
  Minus,
  Plus,
  X,
} from 'lucide-react';
import type {
  ChromaKeySettings,
  CvTrackerSettings,
  ExportProgress,
  ExportResolutionScale,
  TrackedPlayer,
} from '../types/tracking';
import {
  computeExportDimensions,
  exportTrackedVideoClip,
  formatExportTimecode,
  parseFlexibleTimeInput,
  triggerBlobDownload,
} from '../utils/videoExporter';

interface ExportClipModalProps {
  isOpen: boolean;
  onClose: () => void;
  videoUrl: string;
  videoName: string;
  duration: number;
  currentTime: number;
  videoWidth: number;
  videoHeight: number;
  logicalStageWidth: number;
  players: TrackedPlayer[];
  chromaKey: ChromaKeySettings;
  cvSettings: CvTrackerSettings;
  showTrails: boolean;
  onSeekPreview: (time: number) => void;
}

const MIN_CLIP_LEN = 0.1;

export const ExportClipModal: React.FC<ExportClipModalProps> = ({
  isOpen,
  onClose,
  videoUrl,
  videoName,
  duration,
  currentTime,
  videoWidth,
  videoHeight,
  logicalStageWidth,
  players,
  chromaKey,
  cvSettings,
  showTrails,
  onSeekPreview,
}) => {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;

  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(safeDuration || 10);
  const [startDraft, setStartDraft] = useState('00:00.00');
  const [endDraft, setEndDraft] = useState('00:00.00');
  const [inputError, setInputError] = useState<string | null>(null);

  const [fps, setFps] = useState<30 | 60>(30);
  const [resolutionScale, setResolutionScale] = useState<ExportResolutionScale>('native');
  const [progress, setProgress] = useState<ExportProgress>({
    status: 'idle',
    frameIndex: 0,
    totalFrames: 0,
    elapsedMs: 0,
    speedMultiplier: 0,
  });

  const abortControllerRef = useRef<AbortController | null>(null);
  const lastOutputUrlRef = useRef<string | null>(null);
  const rangeBarRef = useRef<HTMLDivElement>(null);
  const [draggingThumb, setDraggingThumb] = useState<'start' | 'end' | null>(null);

  const revokeLastOutputUrl = useCallback(() => {
    if (lastOutputUrlRef.current) {
      URL.revokeObjectURL(lastOutputUrlRef.current);
      lastOutputUrlRef.current = null;
    }
  }, []);

  // Initialize defaults whenever modal opens
  useEffect(() => {
    if (!isOpen) return;
    const initEnd = safeDuration > 0 ? Math.round(safeDuration * 100) / 100 : 10;
    setStartTime(0);
    setEndTime(initEnd);
    setStartDraft(formatExportTimecode(0));
    setEndDraft(formatExportTimecode(initEnd));
    setInputError(null);
    setProgress({
      status: 'idle',
      frameIndex: 0,
      totalFrames: 0,
      elapsedMs: 0,
      speedMultiplier: 0,
    });
  }, [isOpen, safeDuration, videoName]);

  // Cleanup any active export or blob URL on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      revokeLastOutputUrl();
    };
  }, [revokeLastOutputUrl]);

  const applyRange = useCallback(
    (nextStart: number, nextEnd: number) => {
      const maxD = safeDuration > 0 ? safeDuration : Math.max(nextEnd, 1);
      const s = Math.max(0, Math.min(maxD - MIN_CLIP_LEN, Math.round(nextStart * 100) / 100));
      const e = Math.max(s + MIN_CLIP_LEN, Math.min(maxD, Math.round(nextEnd * 100) / 100));
      setStartTime(s);
      setEndTime(e);
      setStartDraft(formatExportTimecode(s));
      setEndDraft(formatExportTimecode(e));
      setInputError(null);
    },
    [safeDuration]
  );

  const commitStartDraft = useCallback(() => {
    const parsed = parseFlexibleTimeInput(startDraft, safeDuration);
    if (parsed === null) {
      setInputError('Enter time as MM:SS.cc or seconds (e.g. 00:12.50 or 12.5).');
      setStartDraft(formatExportTimecode(startTime));
      return;
    }
    const clamped = Math.min(parsed, Math.max(0, endTime - MIN_CLIP_LEN));
    applyRange(clamped, endTime);
    onSeekPreview(clamped);
  }, [startDraft, safeDuration, startTime, endTime, applyRange, onSeekPreview]);

  const commitEndDraft = useCallback(() => {
    const parsed = parseFlexibleTimeInput(endDraft, safeDuration);
    if (parsed === null) {
      setInputError('Enter time as MM:SS.cc or seconds (e.g. 00:18.00 or 18).');
      setEndDraft(formatExportTimecode(endTime));
      return;
    }
    const minEnd = Math.min(safeDuration || parsed, startTime + MIN_CLIP_LEN);
    const clamped = Math.max(minEnd, parsed);
    applyRange(startTime, clamped);
    onSeekPreview(clamped);
  }, [endDraft, safeDuration, startTime, endTime, applyRange, onSeekPreview]);

  // Dragging range bar thumbs
  useEffect(() => {
    if (!draggingThumb || safeDuration <= 0) return;

    const updateFromClientX = (clientX: number) => {
      const bar = rangeBarRef.current;
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      const t = Math.round(ratio * safeDuration * 100) / 100;
      if (draggingThumb === 'start') {
        const clamped = Math.min(t, Math.max(0, endTime - MIN_CLIP_LEN));
        setStartTime(clamped);
        setStartDraft(formatExportTimecode(clamped));
        onSeekPreview(clamped);
      } else {
        const clamped = Math.max(startTime + MIN_CLIP_LEN, Math.min(safeDuration, t));
        setEndTime(clamped);
        setEndDraft(formatExportTimecode(clamped));
        onSeekPreview(clamped);
      }
      setInputError(null);
    };

    const onMove = (e: PointerEvent) => updateFromClientX(e.clientX);
    const onUp = () => setDraggingThumb(null);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [draggingThumb, safeDuration, startTime, endTime, onSeekPreview]);

  const isExporting =
    progress.status === 'preparing' ||
    progress.status === 'encoding' ||
    progress.status === 'finalizing';

  const handleClose = useCallback(() => {
    if (isExporting) {
      abortControllerRef.current?.abort();
    }
    onClose();
  }, [isExporting, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, handleClose]);

  const trackedSpan = useMemo(() => {
    const visible = players.filter((p) => p.visible);
    if (visible.length === 0 || safeDuration <= 0) return null;
    let minIn = Infinity;
    let maxOut = 0;
    for (const p of visible) {
      const effIn = Math.max(0, p.inTime ?? p.anchorTime);
      const effOut =
        p.stopTime !== undefined ? Math.min(safeDuration, p.stopTime) : safeDuration;
      if (effIn < minIn) minIn = effIn;
      if (effOut > maxOut) maxOut = effOut;
    }
    if (!Number.isFinite(minIn) || maxOut - minIn < MIN_CLIP_LEN) return null;
    return { start: minIn, end: maxOut };
  }, [players, safeDuration]);

  const coverageInfo = useMemo(() => {
    const visibleInRange = players.filter((p) => {
      if (!p.visible) return false;
      const effIn = p.inTime ?? p.anchorTime;
      const effOut = p.stopTime ?? (safeDuration > 0 ? safeDuration : endTime);
      return effOut >= startTime - 0.04 && effIn <= endTime + 0.04;
    });

    const hasUntrackedCvTail = visibleInRange.some((p) => {
      if (p.trackWithCv === false) return false;
      const lastHist = p.history.length > 0 ? p.history[p.history.length - 1].time : p.anchorTime;
      const effEnd = Math.min(endTime, p.stopTime ?? endTime);
      return effEnd - lastHist > 0.35;
    });

    return {
      activeCount: visibleInRange.length,
      hasUntrackedCvTail,
    };
  }, [players, startTime, endTime, safeDuration]);

  const exportDims = useMemo(
    () => computeExportDimensions(videoWidth, videoHeight, resolutionScale),
    [videoWidth, videoHeight, resolutionScale]
  );

  const clipDuration = Math.max(MIN_CLIP_LEN, endTime - startTime);
  const estTotalFrames = Math.max(1, Math.round(clipDuration * fps));

  const handleStartExport = async () => {
    if (!videoUrl || safeDuration <= 0 || isExporting) return;

    revokeLastOutputUrl();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const result = await exportTrackedVideoClip({
        videoUrl,
        videoName,
        players,
        chromaKey,
        cvSettings,
        showTrails,
        logicalStageWidth,
        config: {
          startTime,
          endTime,
          fps,
          resolutionScale,
        },
        onProgress: (next) => {
          setProgress(next);
        },
        signal: controller.signal,
      });
      if (result.outputUrl) {
        lastOutputUrlRef.current = result.outputUrl;
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setProgress({
          status: 'cancelled',
          frameIndex: 0,
          totalFrames: estTotalFrames,
          elapsedMs: 0,
          speedMultiplier: 0,
        });
      } else {
        setProgress({
          status: 'error',
          frameIndex: 0,
          totalFrames: estTotalFrames,
          elapsedMs: 0,
          speedMultiplier: 0,
          error: err instanceof Error ? err.message : 'Video export failed.',
        });
      }
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  };

  if (!isOpen) return null;

  const startPct = safeDuration > 0 ? (startTime / safeDuration) * 100 : 0;
  const endPct = safeDuration > 0 ? (endTime / safeDuration) * 100 : 100;
  const playheadPct = safeDuration > 0 ? Math.min(100, Math.max(0, (currentTime / safeDuration) * 100)) : 0;
  const progressPct =
    progress.totalFrames > 0
      ? Math.min(100, Math.round((progress.frameIndex / progress.totalFrames) * 100))
      : 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !isExporting) {
          handleClose();
        }
      }}
    >
      <div className="w-full max-w-[540px] rounded-xl bg-[#0D1218] border border-[#1E2936] shadow-2xl overflow-hidden text-slate-100">
        {/* Modal Header */}
        <div className="px-5 py-3.5 border-b border-[#1E2936] flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2
              id="export-modal-title"
              className="font-display text-base font-semibold tracking-tight text-slate-100"
            >
              Export Video Clip
            </h2>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-400 truncate">
              <span className="truncate max-w-[200px] text-slate-300">{videoName}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">
                {videoWidth || 1280}×{videoHeight || 720}
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">{formatExportTimecode(safeDuration)}</span>
            </div>
          </div>

          <button
            type="button"
            onClick={handleClose}
            aria-label={isExporting ? 'Cancel export and close' : 'Close export dialog'}
            title={isExporting ? 'Cancel export' : 'Close (Esc)'}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-[#19222E] transition-colors shrink-0 focus-visible:outline-2 focus-visible:outline-emerald-400"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 space-y-5">
          {/* Interactive Range Bar + Presets */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-300">Clip Range</span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={isExporting || safeDuration <= 0}
                  onClick={() => applyRange(0, safeDuration)}
                  className="px-2 py-1 rounded bg-[#141B24] hover:bg-[#1D2735] border border-[#243040] text-[10.5px] font-medium text-slate-300 hover:text-white transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
                >
                  Full Clip
                </button>
                <button
                  type="button"
                  disabled={isExporting || safeDuration <= 0}
                  onClick={() =>
                    applyRange(
                      Math.max(0, currentTime - 5),
                      Math.min(safeDuration, currentTime + 5)
                    )
                  }
                  className="px-2 py-1 rounded bg-[#141B24] hover:bg-[#1D2735] border border-[#243040] text-[10.5px] font-medium text-slate-300 hover:text-white transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
                >
                  Playhead ±5s
                </button>
                {trackedSpan && (
                  <button
                    type="button"
                    disabled={isExporting}
                    onClick={() => applyRange(trackedSpan.start, trackedSpan.end)}
                    className="px-2 py-1 rounded bg-[#141B24] hover:bg-[#1D2735] border border-[#243040] text-[10.5px] font-medium text-emerald-300 hover:text-emerald-200 transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
                  >
                    Tracked Span
                  </button>
                )}
              </div>
            </div>

            {/* Dual-Thumb Visual Range Bar */}
            <div
              ref={rangeBarRef}
              className="relative h-9 rounded-lg bg-[#080B0F] border border-[#1E2936] select-none overflow-hidden"
            >
              {/* Active Track Coverage Micro-Spans */}
              {safeDuration > 0 &&
                players
                  .filter((p) => p.visible)
                  .map((p, idx) => {
                    const effIn = Math.max(0, Math.min(safeDuration, p.inTime ?? p.anchorTime));
                    const effOut = Math.max(
                      effIn,
                      Math.min(safeDuration, p.stopTime ?? safeDuration)
                    );
                    return (
                      <div
                        key={p.id}
                        style={{
                          left: `${(effIn / safeDuration) * 100}%`,
                          width: `${((effOut - effIn) / safeDuration) * 100}%`,
                          bottom: `${2 + (idx % 3) * 3}px`,
                          backgroundColor: p.color,
                        }}
                        className="absolute h-[2px] opacity-60 pointer-events-none"
                      />
                    );
                  })}

              {/* Playhead Position Indicator */}
              {safeDuration > 0 && (
                <div
                  style={{ left: `${playheadPct}%` }}
                  className="absolute top-0 bottom-0 w-px bg-slate-400/60 pointer-events-none"
                />
              )}

              {/* Dimmed Out-of-Range Masks */}
              <div
                style={{ width: `${startPct}%` }}
                className="absolute inset-y-0 left-0 bg-black/55 pointer-events-none"
              />
              <div
                style={{ left: `${endPct}%`, right: 0 }}
                className="absolute inset-y-0 bg-black/55 pointer-events-none"
              />

              {/* Selected Range Window */}
              <div
                style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }}
                className="absolute inset-y-0 bg-emerald-500/15 border-y border-emerald-500/50 pointer-events-none"
              />

              {/* Start Thumb */}
              <button
                type="button"
                disabled={isExporting || safeDuration <= 0}
                onPointerDown={(e) => {
                  e.preventDefault();
                  setDraggingThumb('start');
                }}
                aria-label="Drag export start time"
                style={{ left: `${startPct}%` }}
                className="absolute top-0 bottom-0 -translate-x-1/2 w-3.5 cursor-ew-resize flex items-center justify-center group focus-visible:outline-2 focus-visible:outline-emerald-300 z-10 disabled:cursor-not-allowed"
              >
                <span className="w-1.5 h-6 rounded-sm bg-emerald-400 group-hover:bg-emerald-300 shadow" />
              </button>

              {/* End Thumb */}
              <button
                type="button"
                disabled={isExporting || safeDuration <= 0}
                onPointerDown={(e) => {
                  e.preventDefault();
                  setDraggingThumb('end');
                }}
                aria-label="Drag export end time"
                style={{ left: `${endPct}%` }}
                className="absolute top-0 bottom-0 -translate-x-1/2 w-3.5 cursor-ew-resize flex items-center justify-center group focus-visible:outline-2 focus-visible:outline-emerald-300 z-10 disabled:cursor-not-allowed"
              >
                <span className="w-1.5 h-6 rounded-sm bg-emerald-400 group-hover:bg-emerald-300 shadow" />
              </button>
            </div>
          </div>

          {/* Easy Start & End Timecode Inputs */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Start Time */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="export-start-input" className="text-xs font-medium text-slate-300">
                  Start Time
                </label>
                <button
                  type="button"
                  disabled={isExporting || safeDuration <= 0}
                  onClick={() => {
                    const target = Math.min(currentTime, Math.max(0, endTime - MIN_CLIP_LEN));
                    applyRange(target, endTime);
                  }}
                  className="text-[11px] font-medium text-emerald-400 hover:text-emerald-300 transition-colors whitespace-nowrap disabled:opacity-40"
                >
                  Use Playhead
                </button>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={isExporting || startTime <= 0}
                  onClick={() => applyRange(startTime - 0.1, endTime)}
                  aria-label="Decrease start time by 0.1 seconds"
                  title="-0.1s"
                  className="h-9 px-2 rounded-lg bg-[#141B24] hover:bg-[#1D2735] border border-[#243040] text-slate-300 hover:text-white transition-colors disabled:opacity-35"
                >
                  <Minus className="w-3.5 h-3.5" />
                </button>
                <input
                  id="export-start-input"
                  type="text"
                  disabled={isExporting}
                  value={startDraft}
                  onChange={(e) => {
                    setStartDraft(e.target.value);
                    setInputError(null);
                  }}
                  onBlur={commitStartDraft}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur();
                    }
                  }}
                  placeholder="00:00.00"
                  aria-label="Start time in MM:SS.cc or seconds"
                  className="w-full h-9 px-3 rounded-lg bg-[#080B0F] border border-[#243040] focus:border-emerald-500 focus:outline-none font-mono tabular-nums text-sm text-slate-100 text-center disabled:opacity-50"
                />
                <button
                  type="button"
                  disabled={isExporting || startTime >= endTime - MIN_CLIP_LEN}
                  onClick={() => applyRange(startTime + 0.1, endTime)}
                  aria-label="Increase start time by 0.1 seconds"
                  title="+0.1s"
                  className="h-9 px-2 rounded-lg bg-[#141B24] hover:bg-[#1D2735] border border-[#243040] text-slate-300 hover:text-white transition-colors disabled:opacity-35"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* End Time */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="export-end-input" className="text-xs font-medium text-slate-300">
                  End Time
                </label>
                <button
                  type="button"
                  disabled={isExporting || safeDuration <= 0}
                  onClick={() => {
                    const target = Math.max(
                      Math.min(safeDuration, startTime + MIN_CLIP_LEN),
                      currentTime
                    );
                    applyRange(startTime, target);
                  }}
                  className="text-[11px] font-medium text-emerald-400 hover:text-emerald-300 transition-colors whitespace-nowrap disabled:opacity-40"
                >
                  Use Playhead
                </button>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={isExporting || endTime <= startTime + MIN_CLIP_LEN}
                  onClick={() => applyRange(startTime, endTime - 0.1)}
                  aria-label="Decrease end time by 0.1 seconds"
                  title="-0.1s"
                  className="h-9 px-2 rounded-lg bg-[#141B24] hover:bg-[#1D2735] border border-[#243040] text-slate-300 hover:text-white transition-colors disabled:opacity-35"
                >
                  <Minus className="w-3.5 h-3.5" />
                </button>
                <input
                  id="export-end-input"
                  type="text"
                  disabled={isExporting}
                  value={endDraft}
                  onChange={(e) => {
                    setEndDraft(e.target.value);
                    setInputError(null);
                  }}
                  onBlur={commitEndDraft}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur();
                    }
                  }}
                  placeholder="00:10.00"
                  aria-label="End time in MM:SS.cc or seconds"
                  className="w-full h-9 px-3 rounded-lg bg-[#080B0F] border border-[#243040] focus:border-emerald-500 focus:outline-none font-mono tabular-nums text-sm text-slate-100 text-center disabled:opacity-50"
                />
                <button
                  type="button"
                  disabled={isExporting || endTime >= safeDuration}
                  onClick={() => applyRange(startTime, endTime + 0.1)}
                  aria-label="Increase end time by 0.1 seconds"
                  title="+0.1s"
                  className="h-9 px-2 rounded-lg bg-[#141B24] hover:bg-[#1D2735] border border-[#243040] text-slate-300 hover:text-white transition-colors disabled:opacity-35"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>

          {inputError && (
            <p className="text-xs text-amber-300">{inputError}</p>
          )}

          {/* Resolution & Frame Rate Controls */}
          <div className="pt-3 border-t border-[#18212D] flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">Resolution</span>
              <div className="flex items-center p-0.5 rounded-lg bg-[#080B0F] border border-[#1E2936]">
                {(['native', '1080p', '720p'] as ExportResolutionScale[]).map((scale) => (
                  <button
                    key={scale}
                    type="button"
                    disabled={isExporting}
                    onClick={() => setResolutionScale(scale)}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap disabled:opacity-50 ${
                      resolutionScale === scale
                        ? 'bg-[#1D2735] text-emerald-400'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {scale === 'native' ? 'Native' : scale}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">Frame Rate</span>
              <div className="flex items-center p-0.5 rounded-lg bg-[#080B0F] border border-[#1E2936]">
                {([30, 60] as const).map((rate) => (
                  <button
                    key={rate}
                    type="button"
                    disabled={isExporting}
                    onClick={() => setFps(rate)}
                    className={`px-2.5 py-1 rounded-md text-xs font-mono tabular-nums font-medium transition-colors whitespace-nowrap disabled:opacity-50 ${
                      fps === rate
                        ? 'bg-[#1D2735] text-emerald-400'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {rate} fps
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Unboxed Metadata Summary */}
          <div className="space-y-1.5 pt-2 border-t border-[#18212D]">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 font-mono tabular-nums">
              <span className="text-slate-200 font-medium">{clipDuration.toFixed(2)}s clip</span>
              <span aria-hidden="true">·</span>
              <span>
                {exportDims.width}×{exportDims.height}
              </span>
              <span aria-hidden="true">·</span>
              <span>{estTotalFrames} frames</span>
              <span aria-hidden="true">·</span>
              <span>
                {coverageInfo.activeCount}{' '}
                {coverageInfo.activeCount === 1 ? 'active tool' : 'active tools'}
              </span>
            </div>

            {coverageInfo.hasUntrackedCvTail && (
              <p className="text-[11px] text-cyan-300/90 leading-snug">
                Unplayed frames in this range will be auto-tracked during export to match live canvas tracking.
              </p>
            )}
          </div>

          {/* Active Export Progress / Completion / Error State */}
          {isExporting && (
            <div className="pt-3 border-t border-[#1E2936] space-y-2">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="flex items-center gap-2 text-slate-200 font-medium">
                  <Loader2 className="w-3.5 h-3.5 text-emerald-400 animate-spin" />
                  <span>
                    {progress.status === 'preparing'
                      ? 'Preparing encoder...'
                      : progress.status === 'finalizing'
                        ? 'Finalizing MP4...'
                        : 'Encoding MP4...'}
                  </span>
                </span>
                <span className="font-mono tabular-nums text-emerald-400 font-semibold">
                  {progressPct}%
                </span>
              </div>

              <div className="h-2 w-full rounded-full bg-[#080B0F] border border-[#1E2936] overflow-hidden">
                <div
                  style={{ width: `${progressPct}%` }}
                  className="h-full bg-emerald-500 transition-[width] duration-100"
                />
              </div>

              <div className="flex items-center justify-between text-[11px] font-mono tabular-nums text-slate-400">
                <span>
                  {progress.frameIndex} / {progress.totalFrames} frames
                </span>
                <span className="flex items-center gap-2">
                  <span>{(progress.elapsedMs / 1000).toFixed(1)}s elapsed</span>
                  {progress.speedMultiplier > 0 && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-emerald-400">
                        {progress.speedMultiplier.toFixed(1)}x speed
                      </span>
                    </>
                  )}
                </span>
              </div>
            </div>
          )}

          {progress.status === 'complete' && progress.outputUrl && (
            <div className="pt-3 border-t border-[#1E2936] flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <div className="min-w-0">
                  <div className="text-xs font-medium text-slate-100 truncate">
                    {progress.outputFileName}
                  </div>
                  <div className="text-[11px] font-mono tabular-nums text-slate-400">
                    {progress.formatLabel} ·{' '}
                    {((progress.outputSizeBytes ?? 0) / (1024 * 1024)).toFixed(2)} MB ·{' '}
                    {(progress.elapsedMs / 1000).toFixed(1)}s (
                    {progress.speedMultiplier.toFixed(1)}x)
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() =>
                  triggerBlobDownload(
                    progress.outputUrl!,
                    progress.outputFileName ?? 'pitchtrace_export.mp4'
                  )
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#141B24] hover:bg-[#1D2735] border border-[#243040] text-xs font-medium text-emerald-400 whitespace-nowrap shrink-0"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download Again</span>
              </button>
            </div>
          )}

          {progress.status === 'error' && (
            <div className="pt-3 border-t border-[#1E2936] flex items-center gap-2 text-xs text-rose-300">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>{progress.error ?? 'Failed to export video.'}</span>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-5 py-3.5 bg-[#0A0E13] border-t border-[#1E2936] flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <Clock className="w-3.5 h-3.5 text-slate-500 shrink-0" />
            <span>Clean overlays · Smooth tracking</span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {isExporting ? (
              <button
                type="button"
                onClick={() => abortControllerRef.current?.abort()}
                className="px-4 py-2 rounded-lg bg-[#18202B] hover:bg-rose-500/20 border border-[#2A3749] hover:border-rose-500/50 text-xs font-semibold text-rose-200 transition-colors whitespace-nowrap"
              >
                Cancel Export
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleClose}
                  className="px-3.5 py-2 rounded-lg bg-transparent hover:bg-[#18202B] text-xs font-medium text-slate-300 hover:text-white transition-colors whitespace-nowrap"
                >
                  {progress.status === 'complete' ? 'Done' : 'Cancel'}
                </button>
                <button
                  type="button"
                  disabled={!videoUrl || safeDuration <= 0}
                  onClick={handleStartExport}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-semibold transition-colors whitespace-nowrap disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-emerald-300"
                >
                  <Film className="w-3.5 h-3.5" />
                  <span>{progress.status === 'complete' ? 'Export Again' : 'Export MP4'}</span>
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
