import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { ChromaKeyEngine } from '../cv/chromaKey';
import {
  buildSortedNodeTimeline,
  buildSortedPlayerTimeline,
  createDeterministicSpotlightParticles,
  drawChainConnectorsShape,
  drawChainShape,
  drawFootRingShape,
  drawMotionTrail,
  drawPlayerBoxShape,
  drawPolygonShape,
  drawSpotlightShape,
  getBoxPixels,
  sampleNodeTimelineAtTime,
  samplePlayerTimelineAtTime,
  stepDisplaySpring,
  updateSpringTarget,
  type ChainConnectorEndpoint,
  type ChainRenderNode,
  type DisplaySpringState,
  type FootRingSpriteCache,
  type PolygonRenderVertex,
  type RenderRect,
  type SpotlightParticle,
} from '../cv/overlayRenderer';
import { CvPlayerTracker, type FrameData, type PlayerTrackInput } from '../cv/playerTracker';
import { WebGlChromaCompositor } from '../cv/webglChromaCompositor';
import {
  DEFAULT_RING_THICKNESS,
  type ChromaKeySettings,
  type CirclePosition,
  type CvTrackerSettings,
  type ExportConfig,
  type ExportProgress,
  type ExportResolutionScale,
  type TrackedPlayer,
} from '../types/tracking';

export interface ExportClipParams {
  videoUrl: string;
  videoName: string;
  players: TrackedPlayer[];
  chromaKey: ChromaKeySettings;
  cvSettings: CvTrackerSettings;
  showTrails: boolean;
  logicalStageWidth: number;
  config: ExportConfig;
  onProgress: (progress: ExportProgress) => void;
  signal: AbortSignal;
}

/**
 * Parses flexible time inputs such as "01:23.45", "1:23", "00:01:23.5", "12.5", or "12.5s".
 * Returns clamped seconds within [0, duration], or null if invalid.
 */
export function parseFlexibleTimeInput(raw: string, duration: number): number | null {
  const cleaned = raw.trim().replace(/s$/i, '');
  if (!cleaned) return null;

  let seconds: number | null = null;
  if (cleaned.includes(':')) {
    const parts = cleaned.split(':').map((p) => p.trim());
    if (parts.some((p) => p === '' || Number.isNaN(Number(p)))) {
      return null;
    }
    if (parts.length === 2) {
      const mins = Number(parts[0]);
      const secs = Number(parts[1]);
      if (mins < 0 || secs < 0) return null;
      seconds = mins * 60 + secs;
    } else if (parts.length === 3) {
      const hrs = Number(parts[0]);
      const mins = Number(parts[1]);
      const secs = Number(parts[2]);
      if (hrs < 0 || mins < 0 || secs < 0) return null;
      seconds = hrs * 3600 + mins * 60 + secs;
    }
  } else {
    const num = Number(cleaned);
    if (!Number.isNaN(num) && Number.isFinite(num) && num >= 0) {
      seconds = num;
    }
  }

  if (seconds === null || !Number.isFinite(seconds)) return null;
  const maxDur = Number.isFinite(duration) && duration > 0 ? duration : seconds;
  return Math.max(0, Math.min(maxDur, Math.round(seconds * 100) / 100));
}

export function formatExportTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00.00';
  const totalCs = Math.floor(seconds * 100 + 1e-6);
  const mins = Math.floor(totalCs / 6000);
  const secs = Math.floor((totalCs % 6000) / 100);
  const cs = totalCs % 100;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

export function computeExportDimensions(
  videoWidth: number,
  videoHeight: number,
  scale: ExportResolutionScale
): { width: number; height: number } {
  const safeW = Math.max(2, videoWidth || 1280);
  const safeH = Math.max(2, videoHeight || 720);
  const maxHeight = scale === '720p' ? 720 : scale === '1080p' ? 1080 : Infinity;
  const ratio = safeH > maxHeight ? maxHeight / safeH : 1;
  // H.264 / VP9 encoders require even pixel dimensions
  const width = Math.max(2, Math.floor((safeW * ratio) / 2) * 2);
  const height = Math.max(2, Math.floor((safeH * ratio) / 2) * 2);
  return { width, height };
}

export function buildExportFileName(
  sourceName: string,
  startTime: number,
  endTime: number,
  ext: 'mp4' | 'webm'
): string {
  const base = sourceName.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '_') || 'pitchtrace_clip';
  const sTag = startTime.toFixed(1).replace('.', 'p');
  const eTag = endTime.toFixed(1).replace('.', 'p');
  return `${base}_tracked_${sTag}s-${eTag}s.${ext}`;
}

export function triggerBlobDownload(url: string, fileName: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

interface SupportedVideoCodec {
  muxerCodec: 'avc' | 'vp9';
  encoderConfig: VideoEncoderConfig;
  formatLabel: 'MP4 (H.264)' | 'WebM';
}

async function selectSupportedWebCodecsConfig(
  width: number,
  height: number,
  fps: number
): Promise<SupportedVideoCodec | null> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    return null;
  }

  const bitrate = Math.round(
    Math.max(2_500_000, Math.min(20_000_000, width * height * fps * 0.14))
  );

  const avcCandidates =
    width * height > 1920 * 1080
      ? ['avc1.640033', 'avc1.64002a', 'avc1.4d002a', 'avc1.42001f']
      : ['avc1.64002a', 'avc1.4d002a', 'avc1.4d001f', 'avc1.42001f', 'avc1.42E01E'];

  const accelerations: HardwareAcceleration[] = ['prefer-hardware', 'no-preference'];

  for (const hardwareAcceleration of accelerations) {
    for (const codec of avcCandidates) {
      const cfg: VideoEncoderConfig = {
        codec,
        width,
        height,
        framerate: fps,
        bitrate,
        hardwareAcceleration,
        avc: { format: 'avc' },
      };
      try {
        const res = await VideoEncoder.isConfigSupported(cfg);
        if (res.supported) {
          return {
            muxerCodec: 'avc',
            encoderConfig: res.config ?? cfg,
            formatLabel: 'MP4 (H.264)',
          };
        }
      } catch {
        // Try next candidate
      }
    }
  }

  // Fallback within MP4 container to VP9 if H.264 VideoEncoder isn't present
  for (const hardwareAcceleration of accelerations) {
    const cfg: VideoEncoderConfig = {
      codec: 'vp09.00.10.08',
      width,
      height,
      framerate: fps,
      bitrate,
      hardwareAcceleration,
    };
    try {
      const res = await VideoEncoder.isConfigSupported(cfg);
      if (res.supported) {
        return {
          muxerCodec: 'vp9',
          encoderConfig: res.config ?? cfg,
          formatLabel: 'MP4 (H.264)',
        };
      }
    } catch {
      // Ignore
    }
  }

  return null;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Export cancelled by user.', 'AbortError');
  }
}

async function loadOffscreenVideo(videoUrl: string, signal: AbortSignal): Promise<HTMLVideoElement> {
  throwIfAborted(signal);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.src = videoUrl;

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Export cancelled by user.', 'AbortError'));
    };
    const onError = () => {
      cleanup();
      reject(new Error('Failed to decode source video for export.'));
    };
    const onLoadedData = () => {
      if (video.duration === Infinity) {
        const onResolvedDuration = () => {
          video.removeEventListener('seeked', onResolvedDuration);
          cleanup();
          resolve();
        };
        video.addEventListener('seeked', onResolvedDuration, { once: true });
        video.currentTime = 1e10;
      } else {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      video.removeEventListener('loadeddata', onLoadedData);
      video.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };

    if (video.readyState >= 2 && video.duration !== Infinity) {
      resolve();
      return;
    }

    video.addEventListener('loadeddata', onLoadedData, { once: true });
    video.addEventListener('error', onError, { once: true });
    signal.addEventListener('abort', onAbort, { once: true });
    video.load();
  });

  return video;
}

async function seekVideoToTime(
  video: HTMLVideoElement,
  targetTime: number,
  signal: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  const maxDur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : targetTime + 1;
  const clamped = Math.max(0, Math.min(Math.max(0, maxDur - 0.002), targetTime));

  if (Math.abs(video.currentTime - clamped) < 0.0008 && video.readyState >= 2 && !video.seeking) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('canplay', onCanPlay);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onCanPlay = () => {
      if (!video.seeking && video.readyState >= 2) {
        finish();
      }
    };
    const onSeeked = () => {
      if (video.readyState >= 2) {
        finish();
      } else {
        video.addEventListener('canplay', onCanPlay, { once: true });
      }
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('canplay', onCanPlay);
      reject(new DOMException('Export cancelled by user.', 'AbortError'));
    };
    const timer = window.setTimeout(finish, 2000);

    video.addEventListener('seeked', onSeeked, { once: true });
    signal.addEventListener('abort', onAbort, { once: true });
    video.currentTime = clamped;
  });
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForEncoderQueue(encoder: VideoEncoder, signal: AbortSignal): Promise<void> {
  while (encoder.encodeQueueSize > 8) {
    throwIfAborted(signal);
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
}

/**
 * Checks whether a sorted recorded timeline has an actual tracked/keyframe bracket at time `t`
 * (without needing to extrapolate past the last recorded point or bridge a large untracked gap).
 */
function hasRecordedSampleCoveringTime(sortedTimeline: CirclePosition[], time: number): boolean {
  if (sortedTimeline.length <= 1) return false;
  const first = sortedTimeline[0];
  const last = sortedTimeline[sortedTimeline.length - 1];
  if (time < first.time - 0.03 || time > last.time + 0.03) return false;
  if (time <= first.time || time >= last.time) return true;

  let lo = 0;
  let hi = sortedTimeline.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedTimeline[mid].time <= time) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const span = sortedTimeline[hi].time - sortedTimeline[lo].time;
  return span <= 0.45;
}

interface TrackUnitRuntime {
  id: string;
  visible: boolean;
  trackWithCv: boolean;
  anchorPosition: CirclePosition;
  recorded: CirclePosition[];
  keyframes: CirclePosition[];
  runtimeHistory: CirclePosition[];
  lastRecordedTime: number;
  lastTrackedPos: CirclePosition;
  stoppedInExport: boolean;
  effIn: number;
  effAnchor: number;
  effStop?: number;
  sampleAtTime: (t: number) => CirclePosition | null;
}

interface ExportPlayerRuntime extends TrackUnitRuntime {
  player: TrackedPlayer;
  isGroup: boolean;
  nodeRuntimes: TrackUnitRuntime[];
}

/**
 * Exports a trimmed clip [startTime, endTime] with clean telestration overlays
 * (no labels, no handles, no chroma mask) and smooth critically-damped tracking
 * matching live playback. Automatically runs CvPlayerTracker on any untracked frames
 * so exported clips always track players smoothly just like the live canvas.
 */
export async function exportTrackedVideoClip(
  params: ExportClipParams
): Promise<ExportProgress> {
  const {
    videoUrl,
    videoName,
    players,
    chromaKey,
    cvSettings,
    showTrails,
    logicalStageWidth,
    config,
    onProgress,
    signal,
  } = params;

  const startWallMs = performance.now();
  const safeStart = Math.max(0, config.startTime);
  const safeEnd = Math.max(safeStart + 0.1, config.endTime);
  const clipDuration = safeEnd - safeStart;
  const fps = config.fps;
  const totalFrames = Math.max(1, Math.round(clipDuration * fps));

  onProgress({
    status: 'preparing',
    frameIndex: 0,
    totalFrames,
    elapsedMs: 0,
    speedMultiplier: 0,
  });

  let video: HTMLVideoElement | null = null;
  let glCompositor: WebGlChromaCompositor | null = null;
  let encoder: VideoEncoder | null = null;

  try {
    video = await loadOffscreenVideo(videoUrl, signal);
    throwIfAborted(signal);

    const { width: outW, height: outH } = computeExportDimensions(
      video.videoWidth,
      video.videoHeight,
      config.resolutionScale
    );

    const codecSupport = await selectSupportedWebCodecsConfig(outW, outH, fps);

    // Offscreen compositing canvases
    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = outW;
    outputCanvas.height = outH;

    const toolsCanvas = document.createElement('canvas');
    toolsCanvas.width = outW;
    toolsCanvas.height = outH;
    const toolsCtx = toolsCanvas.getContext('2d');
    if (!toolsCtx) {
      throw new Error('Failed to initialize 2D overlay canvas for export.');
    }

    let useWebGl = true;
    let fallback2DChroma: ChromaKeyEngine | null = null;
    let fallback2DCtx: CanvasRenderingContext2D | null = null;
    try {
      glCompositor = new WebGlChromaCompositor(
        outputCanvas,
        () => {
          useWebGl = false;
        },
        { preserveDrawingBuffer: true }
      );
    } catch {
      useWebGl = false;
    }
    if (!useWebGl) {
      fallback2DChroma = new ChromaKeyEngine();
      fallback2DCtx = outputCanvas.getContext('2d');
      if (!fallback2DCtx) {
        throw new Error('Failed to initialize compositing canvas for export.');
      }
    }

    // Preserve visual proportions of rings, spotlight beams & line weights relative to stage
    const logicalW = Math.max(320, logicalStageWidth || 960);
    const logicalH = logicalW * (outH / outW);
    const logicalRect: RenderRect = { x: 0, y: 0, w: logicalW, h: logicalH };
    const scaleX = outW / logicalW;
    const scaleY = outH / logicalH;

    // Clean export never renders the magenta chroma inspection mask
    const exportChromaKey: ChromaKeySettings = {
      ...chromaKey,
      showMask: false,
    };

    // Pre-build per-player & per-node runtime tracking state, deterministic particles, and ring caches
    const visiblePlayers = players.filter((p) => p.visible);
    const hasAnyCvPlayer = visiblePlayers.some((p) => p.trackWithCv !== false);
    const exportTracker = hasAnyCvPlayer ? new CvPlayerTracker() : null;

    const playerRuntimes = new Map<string, ExportPlayerRuntime>();
    const unitRuntimeMap = new Map<string, TrackUnitRuntime>();
    const particleSeeds = new Map<string, SpotlightParticle[]>();
    const footRingCache: FootRingSpriteCache = new Map();
    const ringScratchCanvas = document.createElement('canvas');

    for (const p of visiblePlayers) {
      const recorded = buildSortedPlayerTimeline(p);
      const keyframes = [...p.keyframes].sort((a, b) => a.time - b.time);
      const lastRecorded = recorded[recorded.length - 1] ?? p.anchorPosition;
      const isGroup = (p.style === 'chain' || p.style === 'polygon') && Boolean(p.nodes && p.nodes.length > 0);
      const nodeRuntimes: TrackUnitRuntime[] = [];

      if (isGroup && p.nodes) {
        for (const node of p.nodes) {
          const nRec = buildSortedNodeTimeline(node);
          const nKfs = [...node.keyframes].sort((a, b) => a.time - b.time);
          const nLast = nRec[nRec.length - 1] ?? node.anchorPosition;
          const nStop =
            p.stopTime !== undefined && node.stopTime !== undefined
              ? Math.min(p.stopTime, node.stopTime)
              : node.stopTime ?? p.stopTime;
          const nrt: TrackUnitRuntime = {
            id: node.id,
            visible: p.visible,
            trackWithCv: p.trackWithCv !== false && node.trackWithCv,
            anchorPosition: node.anchorPosition,
            recorded: nRec,
            keyframes: nKfs,
            runtimeHistory: [...nRec],
            lastRecordedTime: nLast.time,
            lastTrackedPos: nLast,
            stoppedInExport: false,
            effIn: p.inTime ?? node.anchorTime,
            effAnchor: node.anchorTime,
            effStop: nStop,
            sampleAtTime: (t: number) => sampleNodeTimelineAtTime(p, node, nRec, t),
          };
          nodeRuntimes.push(nrt);
          unitRuntimeMap.set(node.id, nrt);
        }
      }

      const rt: ExportPlayerRuntime = {
        id: p.id,
        visible: p.visible,
        trackWithCv: p.trackWithCv !== false,
        anchorPosition: p.anchorPosition,
        player: p,
        isGroup,
        nodeRuntimes,
        recorded,
        keyframes,
        runtimeHistory: [...recorded],
        lastRecordedTime: lastRecorded.time,
        lastTrackedPos: lastRecorded,
        stoppedInExport: false,
        effIn: p.inTime ?? p.anchorTime,
        effAnchor: p.anchorTime,
        effStop: p.stopTime,
        sampleAtTime: (t: number) => samplePlayerTimelineAtTime(p, recorded, t),
      };
      playerRuntimes.set(p.id, rt);
      if (!isGroup) {
        unitRuntimeMap.set(p.id, rt);
      }
      if (p.style === 'spotlight') {
        particleSeeds.set(p.id, createDeterministicSpotlightParticles(p.id));
      }
    }

    // Spring state initialization & pre-warming before startTime so frame 0 glides smoothly
    const springStates = new Map<string, DisplaySpringState>();
    const smoothing = cvSettings.smoothing ?? 0.65;
    const dt = 1 / fps;
    let prevStepTime = -Infinity;

    /**
     * Resolves every visible player/node position at timestamp `t` (using recorded history
     * where available, and running CvPlayerTracker on decoded frames wherever unplayed/untracked),
     * steps critically-damped springs, and optionally paints Layer 2 overlays onto `toolsCanvas`.
     */
    const stepToolsAtTime = (
      t: number,
      drawTools: boolean,
      sourceVideo: HTMLVideoElement | null
    ): boolean => {
      const nowMs = Math.max(1, t * 1000);
      const resolvedTargets = new Map<string, CirclePosition>();
      const trackInputs: PlayerTrackInput[] = [];
      let currFrame: FrameData | null = null;

      const ensureCurrFrame = (): FrameData | null => {
        if (!currFrame && exportTracker && sourceVideo && sourceVideo.readyState >= 2) {
          currFrame = exportTracker.captureFrame(sourceVideo);
        }
        return currFrame;
      };

      for (const rt of unitRuntimeMap.values()) {
        if (rt.stoppedInExport) {
          springStates.delete(rt.id);
          continue;
        }
        if (rt.effStop !== undefined && t > rt.effStop + 0.04) {
          springStates.delete(rt.id);
          exportTracker?.removePlayer(rt.id);
          continue;
        }
        // Before both visual in-point and anchor time, skip completely
        if (t + 0.04 < rt.effIn && t + 0.02 < rt.effAnchor) {
          springStates.delete(rt.id);
          continue;
        }

        // Static tool (Follow CV disabled)
        if (!rt.trackWithCv) {
          if (t + 0.04 < rt.effIn) continue;
          const staticTarget = rt.sampleAtTime(t) ?? { ...rt.anchorPosition, time: t };
          resolvedTargets.set(rt.id, staticTarget);
          continue;
        }

        // In-point trimmed earlier than anchorTime: hold anchorPosition until anchorTime arrives
        if (t + 0.02 < rt.effAnchor) {
          const preAnchorPos = { ...rt.anchorPosition, time: t };
          resolvedTargets.set(rt.id, preAnchorPos);
          continue;
        }

        // Check if we just hit/crossed a manual keyframe (realignment / manual move)
        const crossedKf = rt.keyframes.find(
          (kf) =>
            (prevStepTime < kf.time - 0.005 && kf.time <= t + 0.02) ||
            (prevStepTime === -Infinity && Math.abs(kf.time - t) <= 0.04)
        );

        const coveredByRecorded = hasRecordedSampleCoveringTime(rt.recorded, t);
        if (coveredByRecorded) {
          const recTarget = rt.sampleAtTime(t);
          if (recTarget) {
            resolvedTargets.set(rt.id, recTarget);
            rt.lastTrackedPos = recTarget;

            // Keep CV tracker primed as we approach the end of recorded history (or pass a keyframe)
            if (
              exportTracker &&
              sourceVideo &&
              (t >= rt.lastRecordedTime - 0.14 || crossedKf || !exportTracker.hasTemplate(rt.id))
            ) {
              const frame = ensureCurrFrame();
              if (frame) {
                exportTracker.anchorPlayer(
                  rt.id,
                  frame,
                  crossedKf ?? recTarget,
                  cvSettings.turfMasking
                );
              }
            }
            continue;
          }
        }

        // Untracked frame: use CvPlayerTracker on the live decoded video frame
        if (!exportTracker || !sourceVideo) {
          const fallbackTarget = { ...rt.lastTrackedPos, time: t };
          resolvedTargets.set(rt.id, fallbackTarget);
          continue;
        }

        const frame = ensureCurrFrame();
        if (!frame) {
          resolvedTargets.set(rt.id, { ...rt.lastTrackedPos, time: t });
          continue;
        }

        // Re-anchor cleanly if crossing a manual keyframe in an untracked span
        if (crossedKf && t > rt.lastRecordedTime - 0.04) {
          exportTracker.anchorPlayer(rt.id, frame, crossedKf, cvSettings.turfMasking);
          const kfPos = { ...crossedKf, time: t };
          rt.lastTrackedPos = kfPos;
          resolvedTargets.set(rt.id, kfPos);
          continue;
        }

        // First frame at/after anchor without an initialized template: anchor here, track from next frame
        if (!exportTracker.hasTemplate(rt.id)) {
          const seedPos = rt.lastTrackedPos ?? rt.anchorPosition;
          exportTracker.anchorPlayer(rt.id, frame, seedPos, cvSettings.turfMasking);
          const anchoredTarget = { ...seedPos, time: t };
          rt.lastTrackedPos = anchoredTarget;
          resolvedTargets.set(rt.id, anchoredTarget);
          continue;
        }

        trackInputs.push({ id: rt.id, prevPos: rt.lastTrackedPos });
      }

      if (trackInputs.length > 0 && exportTracker && currFrame) {
        const prevFrame = exportTracker.getPrevFrame();
        const camShift =
          prevFrame && cvSettings.cameraCompensation
            ? exportTracker.estimateGlobalCameraShift(prevFrame, currFrame)
            : { dx: 0, dy: 0 };

        const jointResults = exportTracker.trackAllPlayers(
          currFrame,
          trackInputs,
          camShift,
          cvSettings
        );

        for (const [id, nextPos] of jointResults.entries()) {
          const rt = unitRuntimeMap.get(id);
          if (!rt) continue;
          const posAtT: CirclePosition = { ...nextPos, time: t };
          resolvedTargets.set(id, posAtT);
          rt.lastTrackedPos = posAtT;

          const lastH = rt.runtimeHistory[rt.runtimeHistory.length - 1];
          if (!lastH || posAtT.time > lastH.time + 0.015) {
            rt.runtimeHistory.push(posAtT);
          }

          if (nextPos.status === 'stopped') {
            rt.stoppedInExport = true;
            exportTracker.removePlayer(id);
          }
        }
      }

      if (exportTracker && currFrame) {
        exportTracker.setPrevFrame(currFrame);
      }
      prevStepTime = t;

      // Step critically-damped springs toward resolved targets
      const resolvedUnitPosMap = new Map<string, CirclePosition>();
      for (const rt of unitRuntimeMap.values()) {
        const target = resolvedTargets.get(rt.id);
        if (!target) continue;

        const prevSpring = springStates.get(rt.id);
        if (
          prevSpring &&
          (target.cx !== prevSpring.lastTargetCx ||
            target.cy !== prevSpring.lastTargetCy ||
            target.time !== prevSpring.lastTargetTime)
        ) {
          updateSpringTarget(prevSpring, target, nowMs);
        }

        const nextSpring =
          !rt.trackWithCv || smoothing <= 0.01
            ? stepDisplaySpring(undefined, target, dt, nowMs, 0)
            : stepDisplaySpring(prevSpring, target, dt, nowMs, smoothing);
        springStates.set(rt.id, nextSpring);

        resolvedUnitPosMap.set(rt.id, {
          cx: nextSpring.cx,
          cy: nextSpring.cy,
          width: nextSpring.width,
          height: nextSpring.height,
          radius: nextSpring.radius,
          confidence: target.confidence,
          status: target.status,
          time: t,
        });
      }

      if (!drawTools) return false;

      const visibleRuntimes: ExportPlayerRuntime[] = [];
      for (const rt of playerRuntimes.values()) {
        const isVisibleAtTime =
          t + 0.04 >= rt.effIn && (rt.effStop === undefined || t <= rt.effStop + 0.04);
        if (!isVisibleAtTime) continue;
        if (rt.player.style === 'chain' && rt.player.linkedRingIds && rt.player.linkedRingIds.length >= 2) {
          const activeLinked = rt.player.linkedRingIds.filter((rid) => resolvedUnitPosMap.has(rid));
          if (activeLinked.length >= 2) {
            visibleRuntimes.push(rt);
          }
        } else if (rt.isGroup) {
          if (rt.nodeRuntimes.length > 0) {
            visibleRuntimes.push(rt);
          }
        } else if (resolvedUnitPosMap.has(rt.id)) {
          visibleRuntimes.push(rt);
        }
      }

      if (visibleRuntimes.length === 0) return false;

      toolsCtx.setTransform(1, 0, 0, 1, 0, 0);
      toolsCtx.clearRect(0, 0, outW, outH);
      toolsCtx.setTransform(scaleX, 0, 0, scaleY, 0, 0);

      for (const rt of visibleRuntimes) {
        const player = rt.player;

        if (player.style === 'chain' && player.linkedRingIds && player.linkedRingIds.length >= 2) {
          const endpoints: ChainConnectorEndpoint[] = [];
          for (const rid of player.linkedRingIds) {
            const ringPos = resolvedUnitPosMap.get(rid);
            const ringRt = playerRuntimes.get(rid);
            if (!ringPos || !ringRt) continue;
            const g = getBoxPixels(ringPos, logicalRect);
            const groundY = Math.min(logicalRect.y + logicalRect.h - 4, g.py + g.halfH * 0.88);
            endpoints.push({
              x: g.px,
              y: groundY,
              ringSize: ringRt.player.ring?.ringSize ?? 112,
              tiltDeg: ringRt.player.ring?.tiltDeg ?? 58,
              isRing: true,
            });
          }
          if (endpoints.length >= 2) {
            drawChainConnectorsShape(
              toolsCtx,
              logicalRect,
              endpoints,
              player.color,
              player.chain?.connectorWidth ?? 10,
              Boolean(player.chain?.dashed),
              false,
              false
            );
          }
          continue;
        }

        if (rt.isGroup) {
          if (player.style === 'chain') {
            const chainNodes: ChainRenderNode[] = rt.nodeRuntimes.map((nrt) => {
              const nPos = resolvedUnitPosMap.get(nrt.id) ?? nrt.lastTrackedPos;
              const g = getBoxPixels(nPos, logicalRect);
              const groundY = Math.min(logicalRect.y + logicalRect.h - 4, g.py + g.halfH * 0.88);
              return { x: g.px, y: groundY, status: nPos.status };
            });
            drawChainShape(
              toolsCtx,
              logicalRect,
              chainNodes,
              player.color,
              player.chain ?? {
                ringSize: 112,
                ringThickness: DEFAULT_RING_THICKNESS,
                tiltDeg: 58,
                spinSpeed: 2.35,
                connectorWidth: 10,
              },
              false,
              nowMs,
              rt.effIn * 1000,
              ringScratchCanvas,
              footRingCache
            );
          } else if (player.style === 'polygon') {
            const polyVertices: PolygonRenderVertex[] = rt.nodeRuntimes.map((nrt) => {
              const nPos = resolvedUnitPosMap.get(nrt.id) ?? nrt.lastTrackedPos;
              const g = getBoxPixels(nPos, logicalRect);
              const groundY = Math.min(logicalRect.y + logicalRect.h - 4, g.py + g.halfH * 0.88);
              return { x: g.px, y: groundY, status: nPos.status };
            });
            drawPolygonShape(
              toolsCtx,
              logicalRect,
              polyVertices,
              player.polygon ?? {
                borderColor: player.color,
                borderThickness: 3,
                dashedBorder: false,
                fillColor: player.color,
                fillOpacity: 0.2,
                markerSize: 5,
              },
              false
            );
          }
          continue;
        }

        const pos = resolvedUnitPosMap.get(rt.id)!;
        const { status, confidence } = pos;
        const { px, py, boxW, boxH, halfH } = getBoxPixels(pos, logicalRect);

        if (showTrails && player.showTrail) {
          drawMotionTrail(toolsCtx, logicalRect, px, py, player.color, rt.runtimeHistory, t, rt.effIn);
        }

        toolsCtx.save();
        if (player.style === 'spotlight') {
          const particles =
            particleSeeds.get(player.id) ?? createDeterministicSpotlightParticles(player.id);
          drawSpotlightShape(
            toolsCtx,
            logicalRect,
            px,
            py,
            halfH,
            player,
            false,
            particles,
            nowMs,
            status
          );
        } else if (player.style === 'foot-ring') {
          const entranceStartMs = rt.effIn * 1000;
          drawFootRingShape(
            toolsCtx,
            logicalRect,
            px,
            py,
            halfH,
            player,
            false,
            nowMs,
            entranceStartMs,
            ringScratchCanvas,
            footRingCache,
            status
          );
        } else {
          drawPlayerBoxShape(
            toolsCtx,
            px,
            py,
            boxW,
            boxH,
            player,
            false,
            status,
            confidence
          );
        }
        toolsCtx.restore();
      }

      return true;
    };

    // Pre-roll CV tracking before safeStart if any CV player/node starts before safeStart and lacks history up to safeStart
    let cvPreRollStart = Infinity;
    for (const rt of unitRuntimeMap.values()) {
      if (!rt.trackWithCv) continue;
      if (rt.effStop !== undefined && rt.effStop < safeStart - 0.04) continue;
      if (rt.effAnchor < safeStart - 0.04 && rt.lastRecordedTime < safeStart - 0.08) {
        const startNeed = Math.max(rt.effAnchor, rt.lastRecordedTime);
        if (startNeed < cvPreRollStart) {
          cvPreRollStart = startNeed;
        }
      }
    }

    if (Number.isFinite(cvPreRollStart) && cvPreRollStart < safeStart - 0.04) {
      const preStep = Math.min(dt, 1 / 25);
      for (let wt = cvPreRollStart; wt < safeStart - 1e-4; wt += preStep) {
        throwIfAborted(signal);
        await seekVideoToTime(video, wt, signal);
        stepToolsAtTime(wt, false, video);
      }
    } else if (visiblePlayers.length > 0 && smoothing > 0.01) {
      // Pre-warm spring velocity from recorded history up to 0.45s before safeStart
      const warmupStart = Math.max(0, safeStart - 0.45);
      for (let wt = warmupStart; wt < safeStart - 1e-4; wt += dt) {
        stepToolsAtTime(wt, false, null);
      }
    }

    const renderCompositedFrame = (frameEpoch: number, t: number) => {
      if (!video) return;
      const hasTools = stepToolsAtTime(t, true, video);

      if (useWebGl && glCompositor && !glCompositor.isContextLost()) {
        glCompositor.render({
          video,
          frameEpoch,
          toolsCanvas: hasTools ? toolsCanvas : null,
          hasTools,
          toolsUpdated: hasTools,
          chromaKey: exportChromaKey,
          stageWidthPx: outW,
          stageHeightPx: outH,
          rect: { x: 0, y: 0, w: outW, h: outH },
          dpr: 1,
        });
      } else if (fallback2DCtx && fallback2DChroma) {
        const keyResult = fallback2DChroma.processFrame(video, exportChromaKey, frameEpoch);
        fallback2DCtx.clearRect(0, 0, outW, outH);
        if (keyResult) {
          fallback2DCtx.drawImage(keyResult.bgCanvas, 0, 0, outW, outH);
        } else {
          fallback2DCtx.drawImage(video, 0, 0, outW, outH);
        }
        if (hasTools) {
          fallback2DCtx.drawImage(toolsCanvas, 0, 0, outW, outH);
        }
        if (keyResult) {
          fallback2DCtx.drawImage(keyResult.fgCanvas, 0, 0, outW, outH);
        }
      }
    };

    // Fast Path: Offline WebCodecs VideoEncoder + MP4 Muxer
    if (codecSupport) {
      const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: {
          codec: codecSupport.muxerCodec,
          width: outW,
          height: outH,
          frameRate: fps,
        },
        fastStart: 'in-memory',
      });

      let encoderError: Error | null = null;
      encoder = new VideoEncoder({
        output: (chunk, meta) => {
          muxer.addVideoChunk(chunk, meta);
        },
        error: (err) => {
          encoderError = err instanceof Error ? err : new Error(String(err));
        },
      });
      encoder.configure(codecSupport.encoderConfig);

      let lastProgressEmitMs = 0;
      const frameDurationUs = Math.round(1_000_000 / fps);

      for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
        throwIfAborted(signal);
        if (encoderError) throw encoderError;

        const t = Math.min(safeEnd, safeStart + frameIdx / fps);
        await seekVideoToTime(video, t, signal);
        throwIfAborted(signal);

        await waitForEncoderQueue(encoder, signal);
        if (encoderError) throw encoderError;

        renderCompositedFrame(frameIdx + 1, t);

        const timestampUs = Math.round((frameIdx / fps) * 1_000_000);
        const videoFrame = new VideoFrame(outputCanvas, {
          timestamp: timestampUs,
          duration: frameDurationUs,
        });
        try {
          encoder.encode(videoFrame, { keyFrame: frameIdx % (fps * 2) === 0 });
        } finally {
          videoFrame.close();
        }

        const nowMs = performance.now();
        if (nowMs - lastProgressEmitMs >= 55 || frameIdx === totalFrames - 1) {
          lastProgressEmitMs = nowMs;
          const elapsedMs = nowMs - startWallMs;
          const encodedMediaSec = (frameIdx + 1) / fps;
          const speedMultiplier = elapsedMs > 20 ? encodedMediaSec / (elapsedMs / 1000) : 0;
          onProgress({
            status: 'encoding',
            frameIndex: frameIdx + 1,
            totalFrames,
            elapsedMs,
            speedMultiplier,
            formatLabel: codecSupport.formatLabel,
          });
          await yieldToEventLoop();
        }
      }

      onProgress({
        status: 'finalizing',
        frameIndex: totalFrames,
        totalFrames,
        elapsedMs: performance.now() - startWallMs,
        speedMultiplier:
          performance.now() - startWallMs > 20
            ? clipDuration / ((performance.now() - startWallMs) / 1000)
            : 0,
        formatLabel: codecSupport.formatLabel,
      });

      await encoder.flush();
      if (encoderError) throw encoderError;
      encoder.close();
      encoder = null;

      muxer.finalize();
      const mp4Blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
      const outputUrl = URL.createObjectURL(mp4Blob);
      const outputFileName = buildExportFileName(videoName, safeStart, safeEnd, 'mp4');
      triggerBlobDownload(outputUrl, outputFileName);

      const finalElapsedMs = performance.now() - startWallMs;
      const doneState: ExportProgress = {
        status: 'complete',
        frameIndex: totalFrames,
        totalFrames,
        elapsedMs: finalElapsedMs,
        speedMultiplier: finalElapsedMs > 20 ? clipDuration / (finalElapsedMs / 1000) : 0,
        outputUrl,
        outputFileName,
        outputSizeBytes: mp4Blob.size,
        formatLabel: 'MP4 (H.264)',
      };
      onProgress(doneState);
      return doneState;
    }

    // Graceful Fallback: MediaRecorder WebM when WebCodecs isn't available
    if (typeof MediaRecorder === 'undefined') {
      throw new Error(
        'This browser does not support WebCodecs VideoEncoder or MediaRecorder video export.'
      );
    }

    const mimeCandidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mimeType =
      mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm';
    const stream = outputCanvas.captureStream(fps);
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: Math.round(
        Math.max(2_500_000, Math.min(16_000_000, outW * outH * fps * 0.14))
      ),
    });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    const stoppedPromise = new Promise<Blob>((resolve, reject) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
      recorder.onerror = () => reject(new Error('MediaRecorder failed during export fallback.'));
    });

    recorder.start(250);
    const frameMs = 1000 / fps;
    let lastProgressEmitMs = 0;

    for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
      throwIfAborted(signal);
      const t = Math.min(safeEnd, safeStart + frameIdx / fps);
      await seekVideoToTime(video, t, signal);
      renderCompositedFrame(frameIdx + 1, t);

      const nowMs = performance.now();
      if (nowMs - lastProgressEmitMs >= 55 || frameIdx === totalFrames - 1) {
        lastProgressEmitMs = nowMs;
        onProgress({
          status: 'encoding',
          frameIndex: frameIdx + 1,
          totalFrames,
          elapsedMs: nowMs - startWallMs,
          speedMultiplier: 1,
          formatLabel: 'WebM',
        });
      }
      await new Promise((r) => setTimeout(r, frameMs));
    }

    recorder.stop();
    const webmBlob = await stoppedPromise;
    const outputUrl = URL.createObjectURL(webmBlob);
    const outputFileName = buildExportFileName(videoName, safeStart, safeEnd, 'webm');
    triggerBlobDownload(outputUrl, outputFileName);

    const finalElapsedMs = performance.now() - startWallMs;
    const doneState: ExportProgress = {
      status: 'complete',
      frameIndex: totalFrames,
      totalFrames,
      elapsedMs: finalElapsedMs,
      speedMultiplier: finalElapsedMs > 20 ? clipDuration / (finalElapsedMs / 1000) : 1,
      outputUrl,
      outputFileName,
      outputSizeBytes: webmBlob.size,
      formatLabel: 'WebM',
    };
    onProgress(doneState);
    return doneState;
  } finally {
    if (encoder) {
      try {
        if (encoder.state !== 'closed') encoder.close();
      } catch {
        // Ignore close errors
      }
    }
    glCompositor?.dispose();
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  }
}
