import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, BoxSelect, Check, Eye, EyeOff, Film, ScanSearch, Sparkles, X } from 'lucide-react';
import { ChromaKeyEngine } from '../cv/chromaKey';
import { DetectedBoxSlowTracker } from '../cv/detectedBoxTracker';
import { PlayerDetector } from '../cv/playerDetector';
import {
  createSpotlightParticles,
  drawChainConnectorsShape,
  drawChainShape,
  drawFootRingShape,
  drawMotionTrail,
  drawPlayerBoxShape,
  drawPolygonShape,
  drawSpotlightShape,
  getBoxPixels,
  hexToRgba,
  resolveRingHoleRatio,
  sampleImplementedTrackAtTime,
  stepDisplaySpring,
  updateSpringTarget,
  zeroPhaseSmoothTimeline,
  type ChainConnectorEndpoint,
  type ChainRenderNode,
  type DisplaySpringState,
  type FootRingSpriteCache,
  type PolygonRenderVertex,
  type RenderRect,
  type SpotlightParticle,
} from '../cv/overlayRenderer';
import { CvPlayerTracker } from '../cv/playerTracker';
import { WebGlChromaCompositor } from '../cv/webglChromaCompositor';
import {
  DEFAULT_RING_THICKNESS,
  MAX_RING_SIZE,
  MIN_RING_SIZE,
  type BackgroundPlayerTrackRecord,
  type ChainSettings,
  type ChromaKeySettings,
  type CirclePosition,
  type CircleStyle,
  type CoverageSummary,
  type CvTrackerSettings,
  type DetectedPlayerBox,
  type DetectorShapeStats,
  type DetectorSubTool,
  type ImplementedTrackRecord,
  type PolygonSettings,
  type RingSettings,
  type SpotlightSettings,
  type ToolMode,
  type TrackedNode,
  type TrackedPlayer,
} from '../types/tracking';

interface VideoTrackingStageProps {
  videoUrl: string | null;
  isPlaying: boolean;
  playbackRate: number;
  isLooping: boolean;
  toolMode: ToolMode;
  activeColor: string;
  activeStyle: CircleStyle;
  showTrails: boolean;
  spotlightSettings: SpotlightSettings;
  ringSettings: RingSettings;
  chainSettings: ChainSettings;
  polygonSettings: PolygonSettings;
  selectedPlayerId: string | null;
  selectedNodeId: string | null;
  realigningPlayerId: string | null;
  realigningNodeId: string | null;
  players: TrackedPlayer[];
  cvSettings: CvTrackerSettings;
  chromaKey: ChromaKeySettings;
  isSamplingPitch: boolean;
  seekRequest: { time: number; seq: number } | null;
  reanchorRequest: { playerId: string; nodeId?: string | null; seq: number } | null;
  detectedBoxes: DetectedPlayerBox[];
  implementedTracks: ImplementedTrackRecord[];
  hoveredTrackedPlayerId: string | null;
  selectedDetectedBoxId: string | null;
  showDetectedBoxes: boolean;
  showPlayerBoxBar: boolean;
  detectorSubTool: DetectorSubTool;
  detectRequestSeq: number;
  resetDetectorSeq: number;
  clearDetectedSeq: number;
  eraseSelectedDetectedSeq?: number;
  isSlowTrackingDetected: boolean;
  implementRequest: { seq: number; targetId: string | null } | null;
  videoRefExternal: React.MutableRefObject<HTMLVideoElement | null>;
  onVideoMetadata: (duration: number, width: number, height: number) => void;
  onTimeUpdate: (time: number) => void;
  onPlayStateChange: (playing: boolean) => void;
  onPushUndoSnapshot: () => void;
  onAddPlayerCircle: (pos: CirclePosition) => string;
  onAddSpotlight: (pos: CirclePosition, beamSizeOverride?: number) => string;
  onAddRing: (pos: CirclePosition, ringSizeOverride?: number) => string;
  onAddChainFromRings: (linkedRingIds: string[]) => string;
  onAddPolygon: (nodes: TrackedNode[]) => string;
  onAttachToolToTrack: (trackId: string, style: 'ring' | 'foot-ring' | 'spotlight') => void;
  onUpdatePlayerAnchor: (playerId: string, pos: CirclePosition, extraSizePx?: number) => void;
  onUpdateNodeAnchor: (playerId: string, nodeId: string, pos: CirclePosition) => void;
  onShiftGroupAnchor: (
    playerId: string,
    baseNodes: Array<{ id: string; cx: number; cy: number }>,
    dxNorm: number,
    dyNorm: number,
    time: number
  ) => void;
  onSelectPlayer: (playerId: string | null) => void;
  onSelectNode: (nodeId: string | null) => void;
  onErasePlayer: (playerId: string) => void;
  onCompleteRealign: () => void;
  onPlayersTrackedFrame: (updates: Map<string, CirclePosition>, recordHistory?: boolean) => void;
  onPlayersTrackedBatch?: (historyByPlayer: Map<string, CirclePosition[]>) => void;
  onGenerateSample: () => void;
  onSamplePitchColor: (hex: string) => void;
  onRenderRectWidthChange?: (widthPx: number) => void;
  onDetectedBoxesResult: (boxes: DetectedPlayerBox[], stats: DetectorShapeStats) => void;
  onAddDetectedBoxManual: (box: DetectedPlayerBox, stats: DetectorShapeStats) => void;
  onEraseDetectedBox: (boxId: string, stats: DetectorShapeStats) => void;
  onDetectorStatsChange: (stats: DetectorShapeStats) => void;
  onSelectDetectedBox: (boxId: string | null) => void;
  onDetectedBoxesSync: (boxes: DetectedPlayerBox[]) => void;
  onBackgroundTracksSync: (tracks: BackgroundPlayerTrackRecord[]) => void;
  onFullSweepTimesSync: (times: number[]) => void;
  onSlowTrackStep: (boxes: DetectedPlayerBox[], time: number, progressPct: number) => void;
  onSlowTrackStateChange: (active: boolean) => void;
  onImplementTrackedTracks: (records: BackgroundPlayerTrackRecord[], fullSweepTimes: number[]) => void;
  showCoverageOverlay: boolean;
  coverageSummary: CoverageSummary;
  onToggleCoverageOverlay?: () => void;
  onJumpToNextGap?: () => void;
}

interface PendingRect {
  cx: number;
  cy: number;
  width: number;
  height: number;
  radius: number;
  time: number;
}

type ResizeHandleMode = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w';

interface PendingGroupNode {
  tempId: string;
  pos: CirclePosition;
  attachedTrackId?: string;
  history?: CirclePosition[];
}

interface DragState {
  kind:
    | 'draw'
    | 'spotlight-circle'
    | 'ring-circle'
    | 'polygon-vertex-draw'
    | 'pending-move'
    | 'pending-resize'
    | 'pending-ring-move'
    | 'pending-ring-resize'
    | 'move'
    | 'move-node'
    | 'move-group'
    | 'resize'
    | 'realign'
    | 'detector-draw'
    | 'detector-erase'
    | 'detector-move'
    | 'detector-resize';
  playerId?: string;
  nodeId?: string;
  detectedBoxId?: string;
  dragBoxMeta?: { source: 'auto' | 'manual'; confidence: number };
  startX: number;
  startY: number;
  currX: number;
  currY: number;
  origCx?: number;
  origCy?: number;
  origWidth?: number;
  origHeight?: number;
  origRadius?: number;
  origGroupNodes?: Array<{ id: string; cx: number; cy: number }>;
  resizeMode?: ResizeHandleMode;
  moved: boolean;
}

export const VideoTrackingStage: React.FC<VideoTrackingStageProps> = ({
  videoUrl,
  isPlaying,
  playbackRate,
  isLooping,
  toolMode,
  activeColor,
  showTrails,
  spotlightSettings,
  ringSettings,
  chainSettings,
  polygonSettings,
  selectedPlayerId,
  selectedNodeId,
  realigningPlayerId,
  realigningNodeId,
  players,
  cvSettings,
  chromaKey,
  isSamplingPitch,
  seekRequest,
  reanchorRequest,
  detectedBoxes,
  implementedTracks,
  hoveredTrackedPlayerId,
  selectedDetectedBoxId,
  showDetectedBoxes,
  showPlayerBoxBar,
  detectorSubTool,
  detectRequestSeq,
  resetDetectorSeq,
  clearDetectedSeq,
  eraseSelectedDetectedSeq = 0,
  isSlowTrackingDetected,
  implementRequest,
  videoRefExternal,
  onVideoMetadata,
  onTimeUpdate,
  onPlayStateChange,
  onPushUndoSnapshot,
  onAddPlayerCircle,
  onAddSpotlight,
  onAddRing,
  onAddChainFromRings,
  onAddPolygon,
  onAttachToolToTrack,
  onUpdatePlayerAnchor,
  onUpdateNodeAnchor,
  onShiftGroupAnchor,
  onSelectPlayer,
  onSelectNode,
  onErasePlayer,
  onCompleteRealign,
  onPlayersTrackedFrame,
  onPlayersTrackedBatch,
  onGenerateSample,
  onSamplePitchColor,
  onRenderRectWidthChange,
  onDetectedBoxesResult,
  onAddDetectedBoxManual,
  onEraseDetectedBox,
  onDetectorStatsChange,
  onSelectDetectedBox,
  onDetectedBoxesSync,
  onBackgroundTracksSync,
  onFullSweepTimesSync,
  onSlowTrackStep,
  onSlowTrackStateChange,
  onImplementTrackedTracks,
  showCoverageOverlay,
  coverageSummary,
  onToggleCoverageOverlay,
  onJumpToNextGap,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const glCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const toolsCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const webglCompositorRef = useRef<WebGlChromaCompositor | null>(null);
  const webglDisabledRef = useRef<boolean>(false);
  const trackerRef = useRef<CvPlayerTracker | null>(null);
  const chromaKeyEngineRef = useRef<ChromaKeyEngine | null>(null);
  const playerDetectorRef = useRef<PlayerDetector | null>(null);
  const detectedBoxTrackerRef = useRef<DetectedBoxSlowTracker | null>(null);

  const playersRef = useRef<TrackedPlayer[]>(players);
  playersRef.current = players;

  const settingsRef = useRef<CvTrackerSettings>(cvSettings);
  settingsRef.current = cvSettings;

  const spotlightSettingsRef = useRef<SpotlightSettings>(spotlightSettings);
  spotlightSettingsRef.current = spotlightSettings;

  const ringSettingsRef = useRef<RingSettings>(ringSettings);
  ringSettingsRef.current = ringSettings;

  const chainSettingsRef = useRef<ChainSettings>(chainSettings);
  chainSettingsRef.current = chainSettings;

  const polygonSettingsRef = useRef<PolygonSettings>(polygonSettings);
  polygonSettingsRef.current = polygonSettings;

  const toolModeRef = useRef<ToolMode>(toolMode);
  toolModeRef.current = toolMode;

  const selectedIdRef = useRef<string | null>(selectedPlayerId);
  selectedIdRef.current = selectedPlayerId;

  const selectedNodeIdRef = useRef<string | null>(selectedNodeId);
  selectedNodeIdRef.current = selectedNodeId;

  const realigningIdRef = useRef<string | null>(realigningPlayerId);
  realigningIdRef.current = realigningPlayerId;

  const realigningNodeIdRef = useRef<string | null>(realigningNodeId);
  realigningNodeIdRef.current = realigningNodeId;

  const showTrailsRef = useRef<boolean>(showTrails);
  showTrailsRef.current = showTrails;

  const chromaKeyRef = useRef<ChromaKeySettings>(chromaKey);
  chromaKeyRef.current = chromaKey;

  const isSamplingPitchRef = useRef<boolean>(isSamplingPitch);
  isSamplingPitchRef.current = isSamplingPitch;

  const sampleHoverRef = useRef<{ x: number; y: number; hex: string } | null>(null);
  const hoveredEraseIdRef = useRef<string | null>(null);
  const hoverCursorRef = useRef<{ x: number; y: number } | null>(null);

  const detectedBoxesRef = useRef<DetectedPlayerBox[]>(detectedBoxes);
  detectedBoxesRef.current = detectedBoxes;
  const implementedTracksRef = useRef<ImplementedTrackRecord[]>(implementedTracks);
  implementedTracksRef.current = implementedTracks;
  const hoveredTrackedPlayerIdRef = useRef<string | null>(hoveredTrackedPlayerId);
  hoveredTrackedPlayerIdRef.current = hoveredTrackedPlayerId;
  const hoveredSnapTrackRef = useRef<{ track: ImplementedTrackRecord; pos: CirclePosition } | null>(null);
  const hoveredChainRingIdRef = useRef<string | null>(null);
  const selectedDetectedBoxIdRef = useRef<string | null>(selectedDetectedBoxId);
  selectedDetectedBoxIdRef.current = selectedDetectedBoxId;
  const showDetectedBoxesRef = useRef<boolean>(showDetectedBoxes);
  showDetectedBoxesRef.current = showDetectedBoxes;
  const showPlayerBoxBarRef = useRef<boolean>(showPlayerBoxBar);
  showPlayerBoxBarRef.current = showPlayerBoxBar;
  const detectorSubToolRef = useRef<DetectorSubTool>(detectorSubTool);
  detectorSubToolRef.current = detectorSubTool;
  const isSlowTrackingDetectedRef = useRef<boolean>(isSlowTrackingDetected);
  isSlowTrackingDetectedRef.current = isSlowTrackingDetected;
  const showCoverageOverlayRef = useRef<boolean>(showCoverageOverlay);
  showCoverageOverlayRef.current = showCoverageOverlay;
  const coverageSummaryRef = useRef<CoverageSummary>(coverageSummary);
  coverageSummaryRef.current = coverageSummary;
  const untrackedGhostCacheRef = useRef<{ key: string; boxes: DetectedPlayerBox[] }>({
    key: '',
    boxes: [],
  });
  const slowTrackUserEditedRef = useRef<boolean>(false);
  const hoveredDetectorEraseIdRef = useRef<string | null>(null);
  const lastDetectSeqRef = useRef<number>(0);
  const lastResetDetectorSeqRef = useRef<number>(0);
  const lastClearDetectedSeqRef = useRef<number>(0);
  const lastEraseSelectedDetectedSeqRef = useRef<number>(0);
  const lastImplementSeqRef = useRef<number>(0);

  const [dragState, setDragState] = useState<DragState | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  dragStateRef.current = dragState;

  const [pendingSpotlight, setPendingSpotlight] = useState<PendingRect | null>(null);
  const pendingSpotlightRef = useRef<PendingRect | null>(null);
  pendingSpotlightRef.current = pendingSpotlight;

  const [pendingRing, setPendingRing] = useState<PendingRect | null>(null);
  const pendingRingRef = useRef<PendingRect | null>(null);
  pendingRingRef.current = pendingRing;

  const [pendingChainRingIds, setPendingChainRingIds] = useState<string[]>([]);
  const pendingChainRingIdsRef = useRef<string[]>([]);
  pendingChainRingIdsRef.current = pendingChainRingIds;

  const [pendingPolygonNodes, setPendingPolygonNodes] = useState<PendingGroupNode[]>([]);
  const pendingPolygonRef = useRef<PendingGroupNode[]>([]);
  pendingPolygonRef.current = pendingPolygonNodes;

  const lastChainClickRef = useRef<{ time: number; x: number; y: number }>({
    time: 0,
    x: 0,
    y: 0,
  });
  const lastPolygonClickRef = useRef<{ time: number; x: number; y: number }>({
    time: 0,
    x: 0,
    y: 0,
  });

  const [stageSize, setStageSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  const isPlayingRef = useRef<boolean>(isPlaying);
  isPlayingRef.current = isPlaying;

  const displayPosRef = useRef<Map<string, DisplaySpringState>>(new Map());
  const particleSeedsRef = useRef<Map<string, SpotlightParticle[]>>(new Map());
  const ringEntranceRef = useRef<Map<string, number>>(new Map());
  const ringScratchRef = useRef<HTMLCanvasElement | null>(null);
  const footRingCacheRef = useRef<FootRingSpriteCache>(new Map());
  const undoPushedForDragRef = useRef<boolean>(false);

  const lastProcessedTimeRef = useRef<number>(-1);
  const chromaFrameEpochRef = useRef<number>(1);
  const needsTrackerReseedRef = useRef<boolean>(false);
  const resolvingDurationRef = useRef<boolean>(false);
  const pendingSeekTimeRef = useRef<number | null>(null);

  // Live playback buffers to avoid triggering React tree re-renders on every video frame
  const livePosRef = useRef<Map<string, CirclePosition>>(new Map());
  const pendingBatchRef = useRef<Map<string, CirclePosition[]>>(new Map());
  const lastUiCommitMsRef = useRef<number>(0);
  const lastReplayCommitMsRef = useRef<number>(0);
  const playbackClockRef = useRef<{ videoTime: number; wallMs: number }>({
    videoTime: 0,
    wallMs: 0,
  });

  // Lazy-init CV tracker, chroma key engine, player detector & slow box tracker
  if (!trackerRef.current && typeof document !== 'undefined') {
    trackerRef.current = new CvPlayerTracker();
  }
  if (!chromaKeyEngineRef.current && typeof document !== 'undefined') {
    chromaKeyEngineRef.current = new ChromaKeyEngine();
  }
  if (!playerDetectorRef.current && typeof document !== 'undefined') {
    playerDetectorRef.current = new PlayerDetector();
  }
  if (
    !detectedBoxTrackerRef.current &&
    typeof document !== 'undefined' &&
    playerDetectorRef.current
  ) {
    detectedBoxTrackerRef.current = new DetectedBoxSlowTracker(playerDetectorRef.current);
  }

  const flushPendingTrackingToReact = useCallback(
    (currTime?: number) => {
      if (pendingBatchRef.current.size > 0) {
        const batchToCommit = pendingBatchRef.current;
        pendingBatchRef.current = new Map();
        if (onPlayersTrackedBatch) {
          onPlayersTrackedBatch(batchToCommit);
        } else {
          const latest = new Map<string, CirclePosition>();
          for (const [id, list] of batchToCommit.entries()) {
            if (list.length > 0) {
              latest.set(id, list[list.length - 1]);
            }
          }
          if (latest.size > 0) {
            onPlayersTrackedFrame(latest, true);
          }
        }
      }
      if (currTime !== undefined) {
        onTimeUpdate(currTime);
      }
      lastUiCommitMsRef.current = performance.now();
    },
    [onPlayersTrackedBatch, onPlayersTrackedFrame, onTimeUpdate]
  );

  // Compute exact rendered video rectangle inside container (matching object-contain)
  const getVideoRenderRect = useCallback((): RenderRect | null => {
    const container = containerRef.current;
    const video = videoRef.current;
    if (!container || !video || !video.videoWidth || !video.videoHeight) return null;

    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    const scale = Math.min(cw / vw, ch / vh);
    const w = vw * scale;
    const h = vh * scale;
    const x = (cw - w) / 2;
    const y = (ch - h) / 2;
    return { x, y, w, h };
  }, []);

  const getActiveDetectedBoxes = useCallback(
    (currTime?: number): DetectedPlayerBox[] => {
      const t = currTime ?? videoRef.current?.currentTime ?? 0;
      const slowTracker = detectedBoxTrackerRef.current;
      const base =
        !isSlowTrackingDetectedRef.current && slowTracker?.hasHistories()
          ? slowTracker.getBoxesAtTime(detectedBoxesRef.current, t) ?? detectedBoxesRef.current
          : detectedBoxesRef.current;

      const drag = dragStateRef.current;
      if (
        !isSlowTrackingDetectedRef.current &&
        drag &&
        (drag.kind === 'detector-move' || drag.kind === 'detector-resize') &&
        drag.detectedBoxId &&
        drag.moved
      ) {
        const rect = getVideoRenderRect();
        if (rect) {
          const nextGeom = computeDraggedDetectedBoxFromDrag(drag, rect);
          return base.map((b) =>
            b.id === drag.detectedBoxId
              ? {
                  ...b,
                  cx: nextGeom.cx,
                  cy: nextGeom.cy,
                  width: nextGeom.width,
                  height: nextGeom.height,
                  isKeyframe: true,
                }
              : b
          );
        }
      }
      return base;
    },
    [getVideoRenderRect]
  );

  // Draw all tracked circles, motion trails, and active drag preview
  const drawOverlay = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const dpr = window.devicePixelRatio || 1;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (cw === 0 || ch === 0) return;

    const stageWidthPx = Math.round(cw * dpr);
    const stageHeightPx = Math.round(ch * dpr);

    if (canvas.width !== stageWidthPx || canvas.height !== stageHeightPx) {
      canvas.width = stageWidthPx;
      canvas.height = stageHeightPx;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cw, ch);

    const rect = getVideoRenderRect();
    if (!rect) {
      ctx.restore();
      return;
    }

    const video = videoRef.current;
    const rawTime = video ? video.currentTime : 0;
    const nowMs = performance.now();
    let currTime = rawTime;
    if (isPlayingRef.current && video && !video.paused && !video.seeking) {
      const clk = playbackClockRef.current;
      if (
        Math.abs(rawTime - clk.videoTime) > 1e-4 ||
        clk.wallMs === 0 ||
        rawTime < clk.videoTime
      ) {
        clk.videoTime = rawTime;
        clk.wallMs = nowMs;
      }
      const rate = Math.max(0.1, Math.min(4, video.playbackRate || 1));
      const subFrameDt = Math.max(0, Math.min(0.05, ((nowMs - clk.wallMs) / 1000) * rate));
      currTime = rawTime + subFrameDt;
    } else if (video) {
      playbackClockRef.current.videoTime = rawTime;
      playbackClockRef.current.wallMs = nowMs;
    }
    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const smoothEnabled =
      isPlayingRef.current && !reduceMotion && (settingsRef.current.smoothing ?? 0.65) > 0.01;

    const ck = chromaKeyRef.current;

    const resolveUnitPosition = (unitId: string, fallbackPos: CirclePosition) => {
      const disp = smoothEnabled ? displayPosRef.current.get(unitId) : undefined;
      const live = livePosRef.current.get(unitId);
      return disp ?? live ?? fallbackPos;
    };

    // Resolve per-player render geometry once for both Tools Layer & Top HUD Layer
    // Only render tools within their active timeline span [inTime ?? anchorTime, stopTime]
    const renderItems = playersRef.current
      .filter((p) => {
        if (!p.visible) return false;
        const livePos = livePosRef.current.get(p.id);
        const effStop =
          p.stopTime ?? (livePos?.status === 'stopped' ? livePos.time : undefined);
        const startT = p.inTime ?? p.anchorTime;
        if (currTime + 0.04 < startT) return false;
        if (effStop !== undefined && currTime > effStop + 0.04) return false;
        return true;
      })
      .map((player) => {
        const pos = resolveUnitPosition(player.id, player.currentPosition);
        const isBeforeAnchor = false;
        const geom = getBoxPixels(pos, rect);
        const isSelected = player.id === selectedIdRef.current;

        const resolvedNodes =
          player.nodes && player.nodes.length > 0
            ? player.nodes.map((node) => {
                const nPos = resolveUnitPosition(node.id, node.currentPosition);
                const nGeom = getBoxPixels(nPos, rect);
                const groundY = Math.min(rect.y + rect.h - 4, nGeom.py + nGeom.halfH * 0.88);
                return {
                  node,
                  pos: nPos,
                  ...nGeom,
                  groundY,
                };
              })
            : null;

        return { player, pos, isBeforeAnchor, ...geom, isSelected, resolvedNodes };
      });

    const drawLayer2Tools = (tctx: CanvasRenderingContext2D) => {
      const activeRingMap = new Map(
        renderItems
          .filter((ri) => ri.player.style === 'foot-ring')
          .map((ri) => [ri.player.id, ri])
      );

      for (const item of renderItems) {
        const { player, isBeforeAnchor, px, py, boxW, boxH, halfH, isSelected, resolvedNodes } =
          item;

        if (player.style === 'chain' && player.linkedRingIds && player.linkedRingIds.length >= 2) {
          const endpoints: ChainConnectorEndpoint[] = [];
          for (const rid of player.linkedRingIds) {
            const ringItem = activeRingMap.get(rid);
            if (!ringItem) continue;
            const groundY = Math.min(rect.y + rect.h - 4, ringItem.py + ringItem.halfH * 0.88);
            endpoints.push({
              x: ringItem.px,
              y: groundY,
              ringSize: ringItem.player.ring?.ringSize ?? 112,
              tiltDeg: ringItem.player.ring?.tiltDeg ?? 58,
              isRing: true,
            });
          }
          if (endpoints.length >= 2) {
            drawChainConnectorsShape(
              tctx,
              rect,
              endpoints,
              player.color,
              player.chain?.connectorWidth ?? 10,
              Boolean(player.chain?.dashed),
              isSelected
            );
          }
          continue;
        }

        if (player.style === 'chain' && resolvedNodes && resolvedNodes.length > 0) {
          if (!ringScratchRef.current && typeof document !== 'undefined') {
            ringScratchRef.current = document.createElement('canvas');
          }
          const chainNodes: ChainRenderNode[] = resolvedNodes.map((rn) => ({
            x: rn.px,
            y: rn.groundY,
            status: (livePosRef.current.get(rn.node.id) ?? rn.node.currentPosition).status,
          }));
          const entranceStart = ringEntranceRef.current.get(player.id);
          drawChainShape(
            tctx,
            rect,
            chainNodes,
            player.color,
            player.chain ?? {
              ringSize: 112,
              ringThickness: DEFAULT_RING_THICKNESS,
              tiltDeg: 58,
              spinSpeed: 2.35,
              connectorWidth: 10,
            },
            isSelected,
            reduceMotion ? 0 : nowMs,
            reduceMotion ? undefined : entranceStart,
            ringScratchRef.current,
            footRingCacheRef.current
          );
          continue;
        }

        if (player.style === 'polygon' && resolvedNodes && resolvedNodes.length > 0) {
          const polyVertices: PolygonRenderVertex[] = resolvedNodes.map((rn) => ({
            x: rn.px,
            y: rn.groundY,
            status: (livePosRef.current.get(rn.node.id) ?? rn.node.currentPosition).status,
          }));
          drawPolygonShape(
            tctx,
            rect,
            polyVertices,
            player.polygon ?? {
              borderColor: player.color,
              borderThickness: 3,
              dashedBorder: false,
              fillColor: player.color,
              fillOpacity: 0.2,
              markerSize: 5,
            },
            isSelected
          );
          continue;
        }

        // Smooth quadratic-spline motion trail from history + uncommitted live batch up to currentTime
        if (showTrailsRef.current && player.showTrail && !isBeforeAnchor) {
          const pendingPts = pendingBatchRef.current.get(player.id);
          const combinedHistory =
            pendingPts && pendingPts.length > 0
              ? [...player.history, ...pendingPts]
              : player.history;
          drawMotionTrail(
            tctx,
            rect,
            px,
            py,
            player.color,
            combinedHistory,
            currTime,
            player.inTime ?? player.anchorTime
          );
        }

        tctx.save();
        if (isBeforeAnchor) {
          tctx.globalAlpha = 0.28;
        }

        if (player.style === 'spotlight') {
          let particles = particleSeedsRef.current.get(player.id);
          if (!particles) {
            particles = createSpotlightParticles();
            particleSeedsRef.current.set(player.id, particles);
          }
          drawSpotlightShape(
            tctx,
            rect,
            px,
            py,
            halfH,
            player,
            isSelected,
            particles,
            reduceMotion ? 0 : nowMs
          );
        } else if (player.style === 'foot-ring') {
          if (!ringScratchRef.current && typeof document !== 'undefined') {
            ringScratchRef.current = document.createElement('canvas');
          }
          const entranceStart = ringEntranceRef.current.get(player.id);
          drawFootRingShape(
            tctx,
            rect,
            px,
            py,
            halfH,
            player,
            isSelected,
            reduceMotion ? 0 : nowMs,
            reduceMotion ? undefined : entranceStart,
            ringScratchRef.current,
            footRingCacheRef.current
          );
        } else {
          drawPlayerBoxShape(tctx, px, py, boxW, boxH, player, isSelected);
        }
        tctx.restore();
      }
    };

    const compositor = webglCompositorRef.current;
    const useWebGl = Boolean(
      compositor && !webglDisabledRef.current && !compositor.isContextLost()
    );

    if (useWebGl && compositor && video && video.readyState >= 2) {
      const hasTools = renderItems.length > 0;
      let toolsCanvas: HTMLCanvasElement | null = null;

      if (hasTools) {
        if (!toolsCanvasRef.current && typeof document !== 'undefined') {
          toolsCanvasRef.current = document.createElement('canvas');
        }
        toolsCanvas = toolsCanvasRef.current;
        if (toolsCanvas) {
          const vw = Math.max(1, Math.round(rect.w * dpr));
          const vh = Math.max(1, Math.round(rect.h * dpr));
          if (toolsCanvas.width !== vw || toolsCanvas.height !== vh) {
            toolsCanvas.width = vw;
            toolsCanvas.height = vh;
          }
          const tctx = toolsCanvas.getContext('2d');
          if (tctx) {
            tctx.setTransform(1, 0, 0, 1, 0, 0);
            tctx.clearRect(0, 0, vw, vh);
            tctx.setTransform(
              vw / rect.w,
              0,
              0,
              vh / rect.h,
              -rect.x * (vw / rect.w),
              -rect.y * (vh / rect.h)
            );
            drawLayer2Tools(tctx);
          }
        }
      }

      compositor.render({
        video,
        frameEpoch: chromaFrameEpochRef.current,
        toolsCanvas,
        hasTools,
        toolsUpdated: hasTools,
        chromaKey: ck,
        stageWidthPx,
        stageHeightPx,
        rect,
        dpr,
      });
    } else {
      // 2D Canvas Fallback when WebGL2 is unavailable
      const needsKeyResult = Boolean(video && video.readyState >= 2);
      const keyResult =
        needsKeyResult && video
          ? chromaKeyEngineRef.current?.processFrame(video, ck, chromaFrameEpochRef.current) ?? null
          : null;

      if (keyResult) {
        ctx.fillStyle = '#070A0E';
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        ctx.drawImage(keyResult.bgCanvas, rect.x, rect.y, rect.w, rect.h);
      }

      if (ck.showMask && keyResult) {
        ctx.drawImage(keyResult.maskCanvas, rect.x, rect.y, rect.w, rect.h);
      }

      drawLayer2Tools(ctx);

      if (keyResult) {
        ctx.drawImage(keyResult.fgCanvas, rect.x, rect.y, rect.w, rect.h);
      }
    }

    // Layer 4: Top HUD Layer (coverage mask & ghost hints, selection resize handles, erase hover highlights, pending previews, sampling loupe)
    const covSummary = coverageSummaryRef.current;
    const hoverPtHud = hoverCursorRef.current;
    const trackedSpatialBoxes: Array<{
      px: number;
      py: number;
      boxW: number;
      boxH: number;
      norm: { cx: number; cy: number; width: number; height: number };
    }> = [];

    if (showCoverageOverlayRef.current) {
      if (
        showDetectedBoxesRef.current ||
        showPlayerBoxBarRef.current ||
        (detectedBoxTrackerRef.current?.hasHistories() ?? false)
      ) {
        const activeDet = getActiveDetectedBoxes(currTime);
        for (const db of activeDet) {
          const dpx = rect.x + db.cx * rect.w;
          const dpy = rect.y + db.cy * rect.h;
          const dbw = Math.max(8, db.width * rect.w);
          const dbh = Math.max(12, db.height * rect.h);
          trackedSpatialBoxes.push({
            px: dpx,
            py: dpy,
            boxW: dbw,
            boxH: dbh,
            norm: { cx: db.cx, cy: db.cy, width: db.width, height: db.height },
          });
        }
      }

      if (!showDetectedBoxesRef.current) {
        for (const tr of implementedTracksRef.current) {
          const sampled = sampleImplementedTrackAtTime(tr, currTime);
          if (!sampled) continue;
          const g = getBoxPixels(sampled, rect);
          trackedSpatialBoxes.push({
            px: g.px,
            py: g.py,
            boxW: g.boxW,
            boxH: g.boxH,
            norm: { cx: sampled.cx, cy: sampled.cy, width: sampled.width, height: sampled.height },
          });
        }
      }

      for (const item of renderItems) {
        if (item.player.trackWithCv === false) continue;
        if (item.resolvedNodes && item.resolvedNodes.length > 0) {
          for (const rn of item.resolvedNodes) {
            trackedSpatialBoxes.push({
              px: rn.px,
              py: rn.py,
              boxW: rn.boxW,
              boxH: rn.boxH,
              norm: {
                cx: rn.pos.cx,
                cy: rn.pos.cy,
                width: rn.pos.width,
                height: rn.pos.height,
              },
            });
          }
        } else {
          trackedSpatialBoxes.push({
            px: item.px,
            py: item.py,
            boxW: item.boxW,
            boxH: item.boxH,
            norm: {
              cx: item.pos.cx,
              cy: item.pos.cy,
              width: item.pos.width,
              height: item.pos.height,
            },
          });
        }
      }

      const hasAnyCoverageContext =
        covSummary.trackedSeconds > 0 ||
        trackedSpatialBoxes.length > 0 ||
        showPlayerBoxBarRef.current;

      if (hasAnyCoverageContext && !isSamplingPitchRef.current) {
        if (covSummary.currentKind === 'partial' && trackedSpatialBoxes.length > 0) {
          // Dim untracked regions outside active tracked windows using even-odd cutout mask
          ctx.save();
          ctx.beginPath();
          ctx.rect(rect.x, rect.y, rect.w, rect.h);
          for (const tb of trackedSpatialBoxes) {
            const padX = 10;
            const padY = 10;
            const cxLeft = Math.max(rect.x, tb.px - tb.boxW * 0.5 - padX);
            const cyTop = Math.max(rect.y, tb.py - tb.boxH * 0.5 - padY);
            const cxRight = Math.min(rect.x + rect.w, tb.px + tb.boxW * 0.5 + padX);
            const cyBottom = Math.min(rect.y + rect.h, tb.py + tb.boxH * 0.5 + padY);
            if (cxRight > cxLeft && cyBottom > cyTop) {
              ctx.roundRect(cxLeft, cyTop, cxRight - cxLeft, cyBottom - cyTop, 6);
            }
          }
          ctx.fillStyle = 'rgba(7, 10, 14, 0.44)';
          ctx.fill('evenodd');

          // Highlight active tracked windows so users immediately see which boxes are tracked
          ctx.strokeStyle = showDetectedBoxesRef.current
            ? 'rgba(56, 189, 248, 0.35)'
            : 'rgba(56, 189, 248, 0.68)';
          ctx.lineWidth = 1.25;
          ctx.setLineDash([4, 3]);
          for (const tb of trackedSpatialBoxes) {
            const padX = 10;
            const padY = 10;
            const cxLeft = Math.max(rect.x, tb.px - tb.boxW * 0.5 - padX);
            const cyTop = Math.max(rect.y, tb.py - tb.boxH * 0.5 - padY);
            const cxRight = Math.min(rect.x + rect.w, tb.px + tb.boxW * 0.5 + padX);
            const cyBottom = Math.min(rect.y + rect.h, tb.py + tb.boxH * 0.5 + padY);
            if (cxRight > cxLeft && cyBottom > cyTop) {
              ctx.beginPath();
              ctx.roundRect(cxLeft, cyTop, cxRight - cxLeft, cyBottom - cyTop, 6);
              ctx.stroke();
            }
          }
          ctx.setLineDash([]);
          ctx.restore();
        } else if (covSummary.currentKind === 'untracked') {
          ctx.save();
          ctx.fillStyle = 'rgba(7, 10, 14, 0.30)';
          ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
          ctx.strokeStyle = 'rgba(148, 163, 184, 0.48)';
          ctx.lineWidth = 1.4;
          ctx.setLineDash([6, 5]);
          ctx.strokeRect(rect.x + 6, rect.y + 6, Math.max(4, rect.w - 12), Math.max(4, rect.h - 12));
          ctx.setLineDash([]);
          ctx.restore();
        } else if (covSummary.currentKind === 'full') {
          ctx.save();
          ctx.strokeStyle = 'rgba(16, 185, 129, 0.44)';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(rect.x + 4, rect.y + 4, Math.max(4, rect.w - 8), Math.max(4, rect.h - 8));
          ctx.restore();
        }
      }

      // Untracked player ghost hints when paused in partial or untracked mode
      if (
        !isPlayingRef.current &&
        !isSlowTrackingDetectedRef.current &&
        covSummary.currentKind !== 'full' &&
        !isSamplingPitchRef.current &&
        video &&
        video.readyState >= 2 &&
        playerDetectorRef.current &&
        (ck.hasCustomSamples || showPlayerBoxBarRef.current)
      ) {
        const ghostKey = `${video.currentSrc || ''}|${Math.round(currTime * 25)}|${chromaFrameEpochRef.current}|${ck.keyColors.join(',')}|${ck.tolerance}|${ck.softness}|${trackedSpatialBoxes.length}|${detectedBoxesRef.current.length}|${implementedTracksRef.current.length}|${playersRef.current.length}`;
        let ghostBoxes = untrackedGhostCacheRef.current.boxes;
        if (untrackedGhostCacheRef.current.key !== ghostKey) {
          const detected = playerDetectorRef.current.detectPlayers(video, ck, currTime);
          ghostBoxes = detected.filter((cand) => {
            return !trackedSpatialBoxes.some((tb) => {
              if (computeNormBoxIoU(cand, tb.norm) > 0.2) return true;
              const dx = Math.abs(cand.cx - tb.norm.cx);
              const dy = Math.abs(cand.cy - tb.norm.cy);
              return dx <= tb.norm.width * 0.7 && dy <= tb.norm.height * 0.7;
            });
          });
          untrackedGhostCacheRef.current = { key: ghostKey, boxes: ghostBoxes };
        }

        if (ghostBoxes.length > 0) {
          const isDrawer = detectorSubToolRef.current === 'drawer';
          ctx.save();
          for (const gb of ghostBoxes) {
            const gx = rect.x + gb.cx * rect.w;
            const gy = rect.y + gb.cy * rect.h;
            const gw = Math.max(8, gb.width * rect.w);
            const gh = Math.max(12, gb.height * rect.h);
            const gLeft = gx - gw * 0.5;
            const gTop = gy - gh * 0.5;
            const isHoverGhost =
              hoverPtHud !== null &&
              hoverPtHud.x >= gLeft - 4 &&
              hoverPtHud.x <= gLeft + gw + 4 &&
              hoverPtHud.y >= gTop - 4 &&
              hoverPtHud.y <= gTop + gh + 4;

            ctx.strokeStyle =
              isDrawer && isHoverGhost
                ? '#38BDF8'
                : isDrawer
                  ? 'rgba(56, 189, 248, 0.78)'
                  : 'rgba(148, 163, 184, 0.72)';
            ctx.lineWidth = isDrawer && isHoverGhost ? 1.8 : 1.2;
            ctx.setLineDash([2, 3]);
            ctx.beginPath();
            ctx.roundRect(gLeft, gTop, gw, gh, 2);
            ctx.stroke();
            ctx.setLineDash([]);

            // Tiny '+' corner badge indicating untracked player candidate
            const plusX = gLeft + 4;
            const plusY = Math.max(rect.y + 6, gTop - 5);
            ctx.fillStyle = 'rgba(11, 15, 20, 0.85)';
            ctx.fillRect(plusX - 4, plusY - 4, 8, 8);
            ctx.strokeStyle = isDrawer ? '#38BDF8' : '#CBD5E1';
            ctx.lineWidth = 1.25;
            ctx.beginPath();
            ctx.moveTo(plusX - 2.5, plusY);
            ctx.lineTo(plusX + 2.5, plusY);
            ctx.moveTo(plusX, plusY - 2.5);
            ctx.lineTo(plusX, plusY + 2.5);
            ctx.stroke();
          }
          ctx.restore();
        }
      }
    }

    const activeRingMapHud = new Map(
      renderItems
        .filter((ri) => ri.player.style === 'foot-ring')
        .map((ri) => [ri.player.id, ri])
    );

    for (const item of renderItems) {
      const { player, isBeforeAnchor, px, py, boxW, boxH, halfW, halfH, isSelected, resolvedNodes } =
        item;
      ctx.save();
      if (isBeforeAnchor) {
        ctx.globalAlpha = 0.28;
      }
      if (player.style === 'chain' && player.linkedRingIds && player.linkedRingIds.length >= 2) {
        const isEraseHover = toolModeRef.current === 'erase' && hoveredEraseIdRef.current === player.id;
        if (isSelected || isEraseHover) {
          ctx.save();
          ctx.strokeStyle = isEraseHover ? '#FB7185' : player.color;
          ctx.lineWidth = isEraseHover ? 2.4 : 1.8;
          ctx.setLineDash([5, 3]);
          for (const rid of player.linkedRingIds) {
            const rItem = activeRingMapHud.get(rid);
            if (!rItem) continue;
            const groundY = Math.min(rect.y + rect.h - 4, rItem.py + rItem.halfH * 0.88);
            const ringR = Math.max(MIN_RING_SIZE / 2, (rItem.player.ring?.ringSize ?? 112) / 2);
            const scaleY = Math.max(
              0.22,
              Math.cos((Math.max(0, Math.min(75, rItem.player.ring?.tiltDeg ?? 58)) * Math.PI) / 180)
            );
            ctx.beginPath();
            ctx.ellipse(rItem.px, groundY, ringR + 5, ringR * scaleY + 4, 0, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.setLineDash([]);
          ctx.restore();
        }
      } else if ((player.style === 'chain' || player.style === 'polygon') && resolvedNodes) {
        if (isSelected) {
          for (let i = 0; i < resolvedNodes.length; i++) {
            const rn = resolvedNodes[i];
            const isNodeSelected = rn.node.id === selectedNodeIdRef.current;
            const nodeColor =
              player.style === 'polygon' ? player.polygon?.borderColor ?? player.color : player.color;

            // Subtle dashed CV tracking box around each player node when selected
            ctx.save();
            ctx.strokeStyle = hexToRgba(nodeColor, isNodeSelected ? 0.85 : 0.42);
            ctx.lineWidth = isNodeSelected ? 1.8 : 1.1;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.roundRect(rn.px - rn.halfW, rn.py - rn.halfH, rn.boxW, rn.boxH, 3);
            ctx.stroke();
            ctx.setLineDash([]);

            // Small draggable handle dot at the node foot center
            ctx.fillStyle = isNodeSelected ? '#10B981' : '#FFFFFF';
            ctx.strokeStyle = nodeColor;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(rn.px, rn.groundY, isNodeSelected ? 5.5 : 4.2, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.restore();
          }
        }
        if (toolModeRef.current === 'erase' && hoveredEraseIdRef.current === player.id) {
          ctx.save();
          ctx.strokeStyle = '#FB7185';
          ctx.lineWidth = 2.4;
          ctx.setLineDash([5, 3]);
          for (const rn of resolvedNodes) {
            ctx.beginPath();
            ctx.arc(rn.px, rn.groundY, player.style === 'chain' ? 28 : 14, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.setLineDash([]);
          ctx.restore();
        }
      } else if (player.style === 'spotlight') {
        drawSpotlightLabelAndHandle(ctx, rect, px, py, halfH, player, isSelected);
      } else if (player.style === 'foot-ring') {
        drawFootRingLabelAndHandle(ctx, rect, px, py, halfH, player, isSelected);
      } else {
        drawPlayerLabelAndHandle(ctx, rect, px, py, halfW, halfH, player, isSelected);
      }
      if (
        player.style !== 'chain' &&
        player.style !== 'polygon' &&
        toolModeRef.current === 'erase' &&
        hoveredEraseIdRef.current === player.id
      ) {
        drawEraseHoverHighlight(ctx, rect, px, py, boxW, boxH, halfH, player);
      }
      ctx.restore();
    }

    // Highlight hovered implemented tracked player (from Right Panel hover)
    const hoveredTrackId = hoveredTrackedPlayerIdRef.current;
    if (hoveredTrackId && !showDetectedBoxesRef.current) {
      const hoveredTrack = implementedTracksRef.current.find((t) => t.id === hoveredTrackId);
      const sampledPos = hoveredTrack ? sampleImplementedTrackAtTime(hoveredTrack, currTime) : null;
      if (hoveredTrack && sampledPos) {
        const g = getBoxPixels(sampledPos, rect);
        ctx.save();
        ctx.fillStyle = hexToRgba('#34D399', 0.14);
        ctx.beginPath();
        ctx.roundRect(g.px - g.halfW, g.py - g.halfH, g.boxW, g.boxH, 4);
        ctx.fill();
        ctx.strokeStyle = '#34D399';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 3]);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.font = '600 10px "JetBrains Mono", monospace';
        const tagW = ctx.measureText(hoveredTrack.label).width + 10;
        const tagX = Math.max(rect.x + 2, Math.min(rect.x + rect.w - tagW - 2, g.px - tagW * 0.5));
        const tagY = Math.max(rect.y + 2, g.py - g.halfH - 18);
        ctx.fillStyle = 'rgba(11, 15, 20, 0.92)';
        ctx.beginPath();
        ctx.roundRect(tagX, tagY, tagW, 15, 3);
        ctx.fill();
        ctx.fillStyle = '#34D399';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(hoveredTrack.label, tagX + tagW * 0.5, tagY + 8);
        ctx.restore();
      }
    }

    // Highlight snap target when hovering near an implemented tracked player with a creation tool
    const drag = dragStateRef.current;
    const hoverSnap = hoveredSnapTrackRef.current;
    const activeCreateTool = toolModeRef.current;
    if (
      hoverSnap &&
      !drag &&
      !detectorSubToolRef.current &&
      !realigningIdRef.current &&
      !isSamplingPitchRef.current &&
      !pendingSpotlightRef.current &&
      !pendingRingRef.current &&
      (activeCreateTool === 'circle' ||
        activeCreateTool === 'spotlight' ||
        activeCreateTool === 'ring' ||
        activeCreateTool === 'polygon')
    ) {
      const g = getBoxPixels(hoverSnap.pos, rect);
      const groundY = Math.min(rect.y + rect.h - 4, g.py + g.halfH * 0.88);
      const snapColor =
        activeCreateTool === 'spotlight'
          ? spotlightSettingsRef.current.color || '#F59E0B'
          : activeCreateTool === 'ring'
            ? ringSettingsRef.current.color || '#00EAFF'
            : activeCreateTool === 'polygon'
              ? polygonSettingsRef.current.borderColor || '#F43F5E'
              : activeColor;

      ctx.save();
      ctx.fillStyle = hexToRgba(snapColor, 0.14);
      ctx.beginPath();
      ctx.roundRect(g.px - g.halfW - 2, g.py - g.halfH - 2, g.boxW + 4, g.boxH + 4, 4);
      ctx.fill();
      ctx.strokeStyle = snapColor;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

      if (activeCreateTool === 'ring' || activeCreateTool === 'spotlight') {
        const previewR =
          activeCreateTool === 'ring'
            ? Math.max(MIN_RING_SIZE / 2, (ringSettingsRef.current.ringSize || 112) / 2)
            : (spotlightSettingsRef.current.beamSize || 80) / 2;
        const previewScaleY =
          activeCreateTool === 'ring'
            ? Math.max(0.22, Math.cos(((ringSettingsRef.current.tiltDeg ?? 58) * Math.PI) / 180))
            : spotlightSettingsRef.current.rotation ?? 0.9;
        ctx.strokeStyle = hexToRgba(snapColor, 0.85);
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.ellipse(g.px, groundY, previewR, previewR * previewScaleY, 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      const snapLabel = `Attach ${hoverSnap.track.label} (${formatStageTimeShort(hoverSnap.track.firstTime)}→${formatStageTimeShort(hoverSnap.track.lastTime)})`;
      ctx.font = '600 10px "JetBrains Mono", monospace';
      const lblW = ctx.measureText(snapLabel).width + 12;
      const lblX = Math.max(rect.x + 2, Math.min(rect.x + rect.w - lblW - 2, g.px - lblW * 0.5));
      const lblY = Math.max(rect.y + 2, g.py - g.halfH - 20);
      ctx.fillStyle = 'rgba(11, 15, 20, 0.94)';
      ctx.beginPath();
      ctx.roundRect(lblX, lblY, lblW, 16, 4);
      ctx.fill();
      ctx.strokeStyle = hexToRgba(snapColor, 0.7);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#F8FAFC';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(snapLabel, lblX + lblW * 0.5, lblY + 8.5);
      ctx.restore();
    } else if (
      !hoverSnap &&
      hoverPtHud &&
      !drag &&
      !detectorSubToolRef.current &&
      !realigningIdRef.current &&
      !isSamplingPitchRef.current &&
      !pendingSpotlightRef.current &&
      !pendingRingRef.current &&
      implementedTracksRef.current.length > 0 &&
      (activeCreateTool === 'circle' ||
        activeCreateTool === 'spotlight' ||
        activeCreateTool === 'ring' ||
        activeCreateTool === 'polygon') &&
      hoverPtHud.x >= rect.x &&
      hoverPtHud.x <= rect.x + rect.w &&
      hoverPtHud.y >= rect.y &&
      hoverPtHud.y <= rect.y + rect.h
    ) {
      const cueText = 'Untracked spot · Live CV';
      ctx.save();
      ctx.font = '500 9.5px "JetBrains Mono", monospace';
      const cueW = ctx.measureText(cueText).width + 10;
      const cueX = Math.max(rect.x + 4, Math.min(rect.x + rect.w - cueW - 4, hoverPtHud.x + 12));
      const cueY = Math.max(rect.y + 4, Math.min(rect.y + rect.h - 20, hoverPtHud.y + 14));
      ctx.fillStyle = 'rgba(11, 15, 20, 0.88)';
      ctx.beginPath();
      ctx.roundRect(cueX, cueY, cueW, 16, 3);
      ctx.fill();
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#CBD5E1';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(cueText, cueX + cueW * 0.5, cueY + 8.5);
      ctx.restore();
    }

    // Draw pending Chain connector (highlights existing 3D Rings + previews beams between picked rings)
    const pendingRingIds = pendingChainRingIdsRef.current;
    const hoverPt = hoverCursorRef.current;
    if (
      toolModeRef.current === 'chain' &&
      !realigningIdRef.current &&
      !isSamplingPitchRef.current &&
      !detectorSubToolRef.current
    ) {
      const cs = chainSettingsRef.current;
      const hoveredChainRingId = hoveredChainRingIdRef.current;

      // Subtle pick target indicators on all visible 3D Rings
      for (const ringItem of activeRingMapHud.values()) {
        const pickedIdx = pendingRingIds.indexOf(ringItem.player.id);
        const isPicked = pickedIdx !== -1;
        const isHovered = hoveredChainRingId === ringItem.player.id;
        const groundY = Math.min(rect.y + rect.h - 4, ringItem.py + ringItem.halfH * 0.88);
        const ringR = Math.max(MIN_RING_SIZE / 2, (ringItem.player.ring?.ringSize ?? 112) / 2);
        const scaleY = Math.max(
          0.22,
          Math.cos((Math.max(0, Math.min(75, ringItem.player.ring?.tiltDeg ?? 58)) * Math.PI) / 180)
        );

        ctx.save();
        ctx.strokeStyle = isPicked
          ? '#10B981'
          : isHovered
            ? cs.color || '#00EAFF'
            : hexToRgba(cs.color || '#00EAFF', 0.45);
        ctx.lineWidth = isPicked || isHovered ? 2.4 : 1.4;
        ctx.setLineDash(isPicked ? [] : [4, 3]);
        ctx.beginPath();
        ctx.ellipse(ringItem.px, groundY, ringR + 5, ringR * scaleY + 4, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);

        if (isPicked) {
          const stepNum = `${pickedIdx + 1}`;
          ctx.fillStyle = '#10B981';
          ctx.beginPath();
          ctx.arc(ringItem.px, groundY - ringR * scaleY - 10, 8, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#06120D';
          ctx.font = '700 10px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(stepNum, ringItem.px, groundY - ringR * scaleY - 9.5);
        }
        ctx.restore();
      }

      if (pendingRingIds.length > 0) {
        const previewEndpoints: ChainConnectorEndpoint[] = [];
        for (const rid of pendingRingIds) {
          const ringItem = activeRingMapHud.get(rid);
          if (!ringItem) continue;
          const groundY = Math.min(rect.y + rect.h - 4, ringItem.py + ringItem.halfH * 0.88);
          previewEndpoints.push({
            x: ringItem.px,
            y: groundY,
            ringSize: ringItem.player.ring?.ringSize ?? 112,
            tiltDeg: ringItem.player.ring?.tiltDeg ?? 58,
            isRing: true,
          });
        }

        const hoveredRingItem =
          hoveredChainRingId &&
          hoveredChainRingId !== pendingRingIds[pendingRingIds.length - 1]
            ? activeRingMapHud.get(hoveredChainRingId)
            : undefined;
        if (hoveredRingItem) {
          const groundY = Math.min(
            rect.y + rect.h - 4,
            hoveredRingItem.py + hoveredRingItem.halfH * 0.88
          );
          previewEndpoints.push({
            x: hoveredRingItem.px,
            y: groundY,
            ringSize: hoveredRingItem.player.ring?.ringSize ?? 112,
            tiltDeg: hoveredRingItem.player.ring?.tiltDeg ?? 58,
            isRing: true,
          });
        } else if (
          hoverPt &&
          hoverPt.x >= rect.x &&
          hoverPt.x <= rect.x + rect.w &&
          hoverPt.y >= rect.y &&
          hoverPt.y <= rect.y + rect.h
        ) {
          previewEndpoints.push({
            x: hoverPt.x,
            y: hoverPt.y,
            ringSize: 0,
            tiltDeg: 58,
            isRing: false,
          });
        }

        if (previewEndpoints.length >= 2) {
          drawChainConnectorsShape(
            ctx,
            rect,
            previewEndpoints,
            cs.color,
            cs.connectorWidth,
            Boolean(cs.dashed),
            false,
            true
          );
        }
      }
    }

    // Draw pending Polygon (in-progress vertices + lines + close preview + live cursor vertex)
    const pendingPoly = pendingPolygonRef.current;
    if (
      toolModeRef.current === 'polygon' &&
      !realigningIdRef.current &&
      !isSamplingPitchRef.current &&
      (pendingPoly.length > 0 ||
        hoverPt !== null ||
        (drag !== null && drag.kind === 'polygon-vertex-draw'))
    ) {
      const ps = polygonSettingsRef.current;
      const previewVerts: PolygonRenderVertex[] = pendingPoly.map((n) => {
        const g = getBoxPixels(n.pos, rect);
        const groundY = Math.min(rect.y + rect.h - 4, g.py + g.halfH * 0.88);
        return { x: g.px, y: groundY, status: 'anchored' };
      });

      let ghostBox: CirclePosition | null = null;
      if (drag && drag.kind === 'polygon-vertex-draw') {
        ghostBox = boxFromDragPoints(drag.startX, drag.startY, drag.currX, drag.currY, rect, currTime);
      } else if (hoverPt && hoverPt.x >= rect.x && hoverPt.x <= rect.x + rect.w && hoverPt.y >= rect.y && hoverPt.y <= rect.y + rect.h) {
        ghostBox = createFootAlignedBox(hoverPt.x, hoverPt.y, rect, currTime);
      }

      if (ghostBox) {
        const gg = getBoxPixels(ghostBox, rect);
        const gGroundY = Math.min(rect.y + rect.h - 4, gg.py + gg.halfH * 0.88);
        previewVerts.push({ x: gg.px, y: gGroundY, status: 'anchored' });
      }

      if (previewVerts.length > 0) {
        drawPolygonShape(ctx, rect, previewVerts, ps, false, true);
      }

      // Highlight first vertex when >= 3 placed so user knows clicking it closes polygon
      if (pendingPoly.length >= 3) {
        const v0 = previewVerts[0];
        ctx.save();
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        ctx.arc(v0.x, v0.y, Math.max(8, ps.markerSize + 5), 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      ctx.save();
      for (let i = 0; i < pendingPoly.length; i++) {
        const g = getBoxPixels(pendingPoly[i].pos, rect);
        ctx.strokeStyle = hexToRgba(ps.borderColor, 0.55);
        ctx.lineWidth = 1.4;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.roundRect(g.px - g.halfW, g.py - g.halfH, g.boxW, g.boxH, 3);
        ctx.stroke();
      }
      if (ghostBox) {
        const gg = getBoxPixels(ghostBox, rect);
        ctx.strokeStyle = hexToRgba(ps.borderColor, 0.72);
        ctx.lineWidth = 1.6;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.roundRect(gg.px - gg.halfW, gg.py - gg.halfH, gg.boxW, gg.boxH, 3);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Draw pending spotlight tracking rectangle (waiting for tick-mark confirmation)
    const pending = pendingSpotlightRef.current;
    const pendingR = pendingRingRef.current;
    if (pending && (!drag || drag.kind !== 'spotlight-circle')) {
      const { px: ppx, py: ppy, boxW: pBoxW, boxH: pBoxH, halfW: pHalfW, halfH: pHalfH } =
        getBoxPixels(pending, rect);
      const ringColor = '#F59E0B';

      ctx.save();
      ctx.fillStyle = hexToRgba(ringColor, 0.14);
      ctx.beginPath();
      ctx.roundRect(ppx - pHalfW, ppy - pHalfH, pBoxW, pBoxH, 4);
      ctx.fill();

      ctx.strokeStyle = 'rgba(11, 15, 20, 0.78)';
      ctx.lineWidth = 4.5;
      ctx.beginPath();
      ctx.roundRect(ppx - pHalfW, ppy - pHalfH, pBoxW, pBoxH, 4);
      ctx.stroke();

      ctx.strokeStyle = ringColor;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.roundRect(ppx - pHalfW, ppy - pHalfH, pBoxW, pBoxH, 4);
      ctx.stroke();
      ctx.setLineDash([]);

      // Center dot & corner resize handles
      ctx.fillStyle = ringColor;
      ctx.beginPath();
      ctx.arc(ppx, ppy, 3, 0, Math.PI * 2);
      ctx.fill();

      drawBoxResizeHandles(ctx, ppx, ppy, pHalfW, pHalfH, ringColor);
      ctx.restore();
    }

    // Draw pending 3D Ring tracking rectangle (waiting for tick-mark confirmation)
    if (pendingR && (!drag || drag.kind !== 'ring-circle')) {
      const { px: ppx, py: ppy, boxW: pBoxW, boxH: pBoxH, halfW: pHalfW, halfH: pHalfH } =
        getBoxPixels(pendingR, rect);
      const previewColor = ringSettingsRef.current.color || '#00EAFF';
      const groundY = Math.min(rect.y + rect.h - 4, ppy + pHalfH * 0.88);
      const footRingR = Math.max(
        MIN_RING_SIZE / 2,
        Math.min(MAX_RING_SIZE / 2, (ringSettingsRef.current.ringSize || 112) / 2)
      );
      const holeRatio = resolveRingHoleRatio(ringSettingsRef.current.ringThickness);
      const scaleY = Math.max(
        0.22,
        Math.cos(((ringSettingsRef.current.tiltDeg ?? 58) * Math.PI) / 180)
      );

      ctx.save();
      // Subtle ghost preview ellipse showing outer & inner thickness where the 3D ring will land
      ctx.strokeStyle = hexToRgba(previewColor, 0.72);
      ctx.lineWidth = Math.max(1.2, Math.min(2, footRingR * 0.14));
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.ellipse(ppx, groundY, footRingR, footRingR * scaleY, 0, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = hexToRgba(previewColor, 0.42);
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.ellipse(
        ppx,
        groundY,
        footRingR * holeRatio,
        footRingR * holeRatio * scaleY,
        0,
        0,
        Math.PI * 2
      );
      ctx.stroke();
      ctx.setLineDash([]);

      // Rectangular sampling box around player body
      ctx.fillStyle = hexToRgba(previewColor, 0.14);
      ctx.beginPath();
      ctx.roundRect(ppx - pHalfW, ppy - pHalfH, pBoxW, pBoxH, 4);
      ctx.fill();

      ctx.strokeStyle = 'rgba(11, 15, 20, 0.78)';
      ctx.lineWidth = 4.5;
      ctx.beginPath();
      ctx.roundRect(ppx - pHalfW, ppy - pHalfH, pBoxW, pBoxH, 4);
      ctx.stroke();

      ctx.strokeStyle = previewColor;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.roundRect(ppx - pHalfW, ppy - pHalfH, pBoxW, pBoxH, 4);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = previewColor;
      ctx.beginPath();
      ctx.arc(ppx, ppy, 3, 0, Math.PI * 2);
      ctx.fill();

      drawBoxResizeHandles(ctx, ppx, ppy, pHalfW, pHalfH, previewColor);
      ctx.restore();
    }

    // Draw active drag preview when drawing a new rectangle, pending spotlight/ring box, or click-realigning
    if (
      drag &&
      (drag.kind === 'draw' ||
        drag.kind === 'spotlight-circle' ||
        drag.kind === 'ring-circle' ||
        drag.kind === 'realign')
    ) {
      const targetPlayer =
        drag.kind === 'realign' && drag.playerId
          ? playersRef.current.find((p) => p.id === drag.playerId)
          : undefined;
      const targetNode =
        targetPlayer?.nodes && realigningNodeIdRef.current
          ? targetPlayer.nodes.find((n) => n.id === realigningNodeIdRef.current)
          : undefined;
      const previewColor =
        drag.kind === 'spotlight-circle'
          ? '#F59E0B'
          : drag.kind === 'ring-circle'
            ? ringSettingsRef.current.color || '#00EAFF'
            : targetPlayer?.style === 'polygon'
              ? targetPlayer.polygon?.borderColor ?? targetPlayer.color
              : targetPlayer?.color ?? activeColor;
      const fallbackPos = targetNode?.currentPosition ?? targetPlayer?.currentPosition;
      const fallbackDims = fallbackPos
        ? {
            width: fallbackPos.width,
            height: fallbackPos.height,
          }
        : undefined;
      const previewPos = boxFromDragPoints(
        drag.startX,
        drag.startY,
        drag.currX,
        drag.currY,
        rect,
        currTime,
        fallbackDims
      );
      const { px: ppx, py: ppy, boxW: pBoxW, boxH: pBoxH, halfW: pHalfW, halfH: pHalfH } =
        getBoxPixels(previewPos, rect);

      ctx.save();
      ctx.fillStyle = hexToRgba(previewColor, 0.16);
      ctx.beginPath();
      ctx.roundRect(ppx - pHalfW, ppy - pHalfH, pBoxW, pBoxH, 4);
      ctx.fill();

      ctx.strokeStyle = previewColor;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.roundRect(ppx - pHalfW, ppy - pHalfH, pBoxW, pBoxH, 4);
      ctx.stroke();

      // Center crosshair dot
      ctx.setLineDash([]);
      ctx.fillStyle = previewColor;
      ctx.beginPath();
      ctx.arc(ppx, ppy, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Draw detected player boxes (Player Box view / Find / Drawer / Eraser / Slow Tracking)
    if (showDetectedBoxesRef.current) {
      const boxesToDraw = getActiveDetectedBoxes(currTime);

      for (let i = 0; i < boxesToDraw.length; i++) {
        const dbox = boxesToDraw[i];
        const dpx = rect.x + dbox.cx * rect.w;
        const dpy = rect.y + dbox.cy * rect.h;
        const dbw = Math.max(4, dbox.width * rect.w);
        const dbh = Math.max(6, dbox.height * rect.h);
        const left = dpx - dbw * 0.5;
        const top = dpy - dbh * 0.5;

        const isEraseHover =
          detectorSubToolRef.current === 'eraser' &&
          hoveredDetectorEraseIdRef.current === dbox.id;
        const isSelectedBox = dbox.id === selectedDetectedBoxIdRef.current;
        const strokeColor = isEraseHover
          ? '#FB7185'
          : isSelectedBox
            ? '#F59E0B'
            : dbox.source === 'manual'
              ? '#38BDF8'
              : '#10B981';

        ctx.save();
        ctx.fillStyle = hexToRgba(strokeColor, isEraseHover ? 0.24 : isSelectedBox ? 0.18 : 0.08);
        ctx.beginPath();
        ctx.roundRect(left, top, dbw, dbh, 2);
        ctx.fill();

        ctx.strokeStyle = 'rgba(11, 15, 20, 0.9)';
        ctx.lineWidth = isSelectedBox ? 3.4 : 2.8;
        ctx.beginPath();
        ctx.roundRect(left, top, dbw, dbh, 2);
        ctx.stroke();

        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = isEraseHover || isSelectedBox ? 2.1 : 1.5;
        if (isEraseHover) {
          ctx.setLineDash([4, 2]);
        }
        ctx.beginPath();
        ctx.roundRect(left, top, dbw, dbh, 2);
        ctx.stroke();
        ctx.setLineDash([]);

        if (isSelectedBox) {
          drawBoxResizeHandles(ctx, dpx, dpy, dbw * 0.5, dbh * 0.5, '#F59E0B');
        }

        if (dbox.isKeyframe) {
          const kx = left + dbw;
          const ky = top - 5;
          ctx.save();
          ctx.translate(kx, Math.max(rect.y + 4, ky));
          ctx.rotate(Math.PI / 4);
          ctx.fillStyle = isSelectedBox ? '#F59E0B' : '#38BDF8';
          ctx.strokeStyle = '#0B0F14';
          ctx.lineWidth = 1.25;
          ctx.fillRect(-2.6, -2.6, 5.2, 5.2);
          ctx.strokeRect(-2.6, -2.6, 5.2, 5.2);
          ctx.restore();
        }

        if (isSelectedBox || isSlowTrackingDetectedRef.current) {
          const tagText = `#${i + 1}`;
          ctx.font = '600 9.5px "JetBrains Mono", monospace';
          const tagW = ctx.measureText(tagText).width + 6;
          const tagY = Math.max(rect.y + 2, top - 14);
          ctx.fillStyle = isSelectedBox ? '#F59E0B' : 'rgba(11, 15, 20, 0.88)';
          ctx.beginPath();
          ctx.roundRect(left, tagY, tagW, 12, 2);
          ctx.fill();
          ctx.fillStyle = isSelectedBox ? '#0B0F14' : '#E2E8F0';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(tagText, left + 3, tagY + 6.2);
        }
        ctx.restore();
      }
    }

    // Draw active drag preview for Player Box Drawer
    if (drag && drag.kind === 'detector-draw') {
      const left = Math.min(drag.startX, drag.currX);
      const top = Math.min(drag.startY, drag.currY);
      const wPx = Math.max(6, Math.abs(drag.currX - drag.startX));
      const hPx = Math.max(8, Math.abs(drag.currY - drag.startY));
      ctx.save();
      ctx.fillStyle = hexToRgba('#38BDF8', 0.16);
      ctx.beginPath();
      ctx.roundRect(left, top, wPx, hPx, 2);
      ctx.fill();
      ctx.strokeStyle = '#38BDF8';
      ctx.lineWidth = 1.8;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.roundRect(left, top, wPx, hPx, 2);
      ctx.stroke();
      ctx.restore();
    }

    // Draw live Pitch Sampling Loupe when Sample Pitch mode is active
    if (isSamplingPitchRef.current && sampleHoverRef.current) {
      const { x: sx, y: sy, hex } = sampleHoverRef.current;
      ctx.save();
      // Outer dark contrast ring
      ctx.strokeStyle = 'rgba(11, 15, 20, 0.88)';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(sx, sy, 18, 0, Math.PI * 2);
      ctx.stroke();

      // Sampled pitch color preview ring
      ctx.strokeStyle = hex;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(sx, sy, 18, 0, Math.PI * 2);
      ctx.stroke();

      // Inner white precision hairline
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.arc(sx, sy, 15, 0, Math.PI * 2);
      ctx.stroke();

      // Crosshair lines
      ctx.beginPath();
      ctx.moveTo(sx - 8, sy);
      ctx.lineTo(sx - 2, sy);
      ctx.moveTo(sx + 2, sy);
      ctx.lineTo(sx + 8, sy);
      ctx.moveTo(sx, sy - 8);
      ctx.lineTo(sx, sy - 2);
      ctx.moveTo(sx, sy + 2);
      ctx.lineTo(sx, sy + 8);
      ctx.stroke();

      // Hex readout pill below loupe
      ctx.font = '600 10px "JetBrains Mono", monospace';
      const labelW = ctx.measureText(hex).width + 22;
      const lx = Math.max(rect.x + 4, Math.min(rect.x + rect.w - labelW - 4, sx - labelW / 2));
      const ly = sy + 25 + 20 > rect.y + rect.h ? sy - 46 : sy + 25;
      ctx.fillStyle = 'rgba(11, 15, 20, 0.92)';
      ctx.beginPath();
      ctx.roundRect(lx, ly, labelW, 20, 4);
      ctx.fill();
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.4)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = hex;
      ctx.fillRect(lx + 5, ly + 5, 10, 10);
      ctx.fillStyle = '#F8FAFC';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(hex, lx + 19, ly + 10.5);
      ctx.restore();
    }

    ctx.restore();
  }, [activeColor, getActiveDetectedBoxes, getVideoRenderRect]);

  // Initialize WebGL2 single-pass chroma key compositor when stage mounts with a video
  useEffect(() => {
    const glCanvas = glCanvasRef.current;
    if (!videoUrl || !glCanvas || webglDisabledRef.current) {
      return;
    }

    let compositor: WebGlChromaCompositor | null = null;
    try {
      compositor = new WebGlChromaCompositor(glCanvas, () => {
        webglDisabledRef.current = true;
        webglCompositorRef.current = null;
        drawOverlay();
      });
      webglCompositorRef.current = compositor;
      drawOverlay();
    } catch {
      webglDisabledRef.current = true;
      webglCompositorRef.current = null;
    }

    return () => {
      if (webglCompositorRef.current === compositor) {
        webglCompositorRef.current = null;
      }
      compositor?.dispose();
    };
  }, [videoUrl, drawOverlay]);

  // Reset tracker & time markers when video source changes
  useEffect(() => {
    trackerRef.current?.reset();
    chromaKeyEngineRef.current?.reset();
    playerDetectorRef.current?.resetTraining();
    detectedBoxTrackerRef.current?.reset();
    webglCompositorRef.current?.resetFrameCache();
    particleSeedsRef.current.clear();
    ringEntranceRef.current.clear();
    displayPosRef.current.clear();
    livePosRef.current.clear();
    pendingBatchRef.current.clear();
    sampleHoverRef.current = null;
    hoveredDetectorEraseIdRef.current = null;
    hoveredSnapTrackRef.current = null;
    hoveredChainRingIdRef.current = null;
    setPendingSpotlight(null);
    setPendingRing(null);
    setPendingChainRingIds([]);
    setPendingPolygonNodes([]);
    hoverCursorRef.current = null;
    lastProcessedTimeRef.current = -1;
    chromaFrameEpochRef.current += 1;
    needsTrackerReseedRef.current = false;
    resolvingDurationRef.current = false;
    pendingSeekTimeRef.current = null;
    untrackedGhostCacheRef.current = { key: '', boxes: [] };
    onBackgroundTracksSync([]);
    onFullSweepTimesSync([]);
    drawOverlay();
  }, [videoUrl, drawOverlay, onBackgroundTracksSync, onFullSweepTimesSync]);

  // Run pitch-interior player detection when requested by App
  useEffect(() => {
    if (detectRequestSeq <= 0 || detectRequestSeq === lastDetectSeqRef.current) return;
    lastDetectSeqRef.current = detectRequestSeq;

    const video = videoRef.current;
    const detector = playerDetectorRef.current;
    if (!video || !detector || video.readyState < 2) return;

    const currT = video.currentTime;
    const autoBoxes = detector.detectPlayers(video, chromaKeyRef.current, currT);
    const keptManual = detectedBoxesRef.current.filter((prevBox) => {
      if (prevBox.source !== 'manual') return false;
      if (Math.abs(prevBox.time - currT) > 0.25) return false;
      return !autoBoxes.some((ab) => computeNormBoxIoU(prevBox, ab) > 0.35);
    });
    const combined = [...autoBoxes, ...keptManual];
    const slowTracker = detectedBoxTrackerRef.current;
    slowTracker?.reset();
    if (slowTracker && combined.length > 0) {
      slowTracker.seedFrame(video, combined, chromaKeyRef.current, autoBoxes.length > 0);
    }
    onBackgroundTracksSync(slowTracker?.getAllTrackRecords() ?? []);
    onFullSweepTimesSync(slowTracker?.getFullSweepTimes() ?? []);
    onDetectedBoxesResult(combined, detector.getStats());
  }, [detectRequestSeq, onDetectedBoxesResult, onBackgroundTracksSync, onFullSweepTimesSync]);

  // Reset detector learned positive/negative shape samples when requested
  useEffect(() => {
    if (resetDetectorSeq <= 0 || resetDetectorSeq === lastResetDetectorSeqRef.current) return;
    lastResetDetectorSeqRef.current = resetDetectorSeq;
    const detector = playerDetectorRef.current;
    if (detector) {
      detector.resetTraining();
      detectedBoxTrackerRef.current?.reset();
      onBackgroundTracksSync([]);
      onFullSweepTimesSync([]);
      onDetectorStatsChange(detector.getStats());
    }
  }, [resetDetectorSeq, onDetectorStatsChange, onBackgroundTracksSync, onFullSweepTimesSync]);

  // Clear recorded slow-track histories when user clicks Clear
  useEffect(() => {
    if (clearDetectedSeq <= 0 || clearDetectedSeq === lastClearDetectedSeqRef.current) return;
    lastClearDetectedSeqRef.current = clearDetectedSeq;
    detectedBoxTrackerRef.current?.reset();
    onBackgroundTracksSync([]);
    onFullSweepTimesSync([]);
    drawOverlay();
  }, [clearDetectedSeq, drawOverlay, onBackgroundTracksSync, onFullSweepTimesSync]);

  // Erase currently selected detected box when user presses Delete/Backspace in Player Box mode
  useEffect(() => {
    if (
      eraseSelectedDetectedSeq <= 0 ||
      eraseSelectedDetectedSeq === lastEraseSelectedDetectedSeqRef.current
    ) {
      return;
    }
    lastEraseSelectedDetectedSeqRef.current = eraseSelectedDetectedSeq;
    const targetId = selectedDetectedBoxIdRef.current;
    if (!targetId) return;

    const video = videoRef.current;
    const currT = video?.currentTime ?? 0;
    const activeBoxes = getActiveDetectedBoxes(currT);
    const hitBox = activeBoxes.find((b) => b.id === targetId);
    if (!hitBox) return;

    slowTrackUserEditedRef.current = true;
    hoveredDetectorEraseIdRef.current = null;
    const detector = playerDetectorRef.current;
    const stats =
      video && detector
        ? detector.trainNegative(video, hitBox, chromaKeyRef.current, currT)
        : detector?.getStats() ?? { positiveCount: 0, negativeCount: 0, isTrained: false };
    detectedBoxTrackerRef.current?.handleUserEraseBox(hitBox, currT);
    detectedBoxesRef.current = activeBoxes.filter((b) => b.id !== hitBox.id);
    onBackgroundTracksSync(detectedBoxTrackerRef.current?.getAllTrackRecords() ?? []);
    onFullSweepTimesSync(detectedBoxTrackerRef.current?.getFullSweepTimes() ?? []);
    onEraseDetectedBox(hitBox.id, stats);
    drawOverlay();
  }, [
    eraseSelectedDetectedSeq,
    getActiveDetectedBoxes,
    drawOverlay,
    onBackgroundTracksSync,
    onFullSweepTimesSync,
    onEraseDetectedBox,
  ]);

  // Keep slow box tracker synchronized when detected boxes are added/erased/cleared
  useEffect(() => {
    if (isSlowTrackingDetectedRef.current) return;
    detectedBoxTrackerRef.current?.syncBoxes(detectedBoxes.map((b) => b.id));
  }, [detectedBoxes]);

  // Frame-by-frame tracking loop for detected players (pipelined decode + CV, zero accuracy loss)
  useEffect(() => {
    if (!isSlowTrackingDetected) return;
    const video = videoRef.current;
    const slowTracker = detectedBoxTrackerRef.current;
    if (!video || !slowTracker || !videoUrl || video.readyState < 2) {
      onSlowTrackStateChange(false);
      return;
    }

    if (!video.paused) {
      video.pause();
    }
    onPlayStateChange(false);

    let cancelled = false;
    let flushedFinal = false;
    let hasProcessedStep = false;
    slowTrackUserEditedRef.current = false;
    let lastMerged: DetectedPlayerBox[] = detectedBoxesRef.current;
    let lastFrameTime = video.currentTime;
    let lastPct = 0;

    const seekAndAwait = (t: number) =>
      new Promise<void>((resolve) => {
        if (cancelled) {
          resolve();
          return;
        }
        let settled = false;
        let timerId = 0;
        const finish = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timerId);
          video.removeEventListener('seeked', finish);
          resolve();
        };
        timerId = window.setTimeout(finish, 900);
        video.addEventListener('seeked', finish, { once: true });
        video.currentTime = t;
      });

    (async () => {
      try {
        const endT =
          Number.isFinite(video.duration) && video.duration > 0 ? video.duration : video.currentTime + 10;

      // If user clicks Play at the very end of the clip, wrap back to 0 cleanly
      if (Number.isFinite(video.duration) && video.duration > 0 && video.currentTime >= video.duration - 0.08) {
        await seekAndAwait(0);
        if (cancelled) return;
      }

      const activeAtResume = slowTracker.hasHistories()
        ? slowTracker.getBoxesAtTime(detectedBoxesRef.current, video.currentTime) ??
          detectedBoxesRef.current
        : detectedBoxesRef.current;
      const targetId = selectedDetectedBoxIdRef.current;
      const initialTargets = targetId
        ? activeAtResume.filter((b) => b.id === targetId)
        : activeAtResume;

      if (targetId && initialTargets.length === 0) {
        onSlowTrackStateChange(false);
        return;
      }

      slowTracker.seedFrame(video, initialTargets, chromaKeyRef.current, !targetId);
      onBackgroundTracksSync(slowTracker.getAllTrackRecords());
      onFullSweepTimesSync(slowTracker.getFullSweepTimes());
      if (!targetId) {
        detectedBoxesRef.current = initialTargets;
        lastMerged = initialTargets;
        onSlowTrackStep(initialTargets, video.currentTime, 0);
      }

      const startT = video.currentTime;
      lastFrameTime = startT;
      let currTargets = initialTargets;
      const stepDt = 0.08;
      const allowNewEntries = !targetId;

      const firstNextT = startT + stepDt;
      if (Number.isFinite(video.duration) && video.duration > 0 && firstNextT >= video.duration - 0.02) {
        onSlowTrackStateChange(false);
        return;
      }

      await seekAndAwait(firstNextT);
      if (cancelled) return;

      let lastUiSyncMs = performance.now();
      let lastYieldMs = performance.now();
      let lastDrawMs = 0;

      while (!cancelled) {
        const currFrame = slowTracker.captureFrame(video);
        if (!currFrame) break;

        const frameTime = currFrame.time;
        const upcomingT = frameTime + stepDt;
        const hasNext = !(
          Number.isFinite(video.duration) &&
          video.duration > 0 &&
          upcomingT >= video.duration - 0.02
        );

        const nowBeforeUpload = performance.now();
        const shouldRenderPreview =
          !hasProcessedStep || !hasNext || nowBeforeUpload - lastDrawMs >= 48;

        if (shouldRenderPreview) {
          // Pre-upload current video frame to GPU/2D cache BEFORE starting next seek
          // so drawOverlay renders the exact frame matching currFrame while video decodes ahead
          chromaFrameEpochRef.current += 1;
          const epoch = chromaFrameEpochRef.current;
          const compositor = webglCompositorRef.current;
          const useWebGl = Boolean(
            compositor && !webglDisabledRef.current && !compositor.isContextLost()
          );
          if (useWebGl && compositor) {
            compositor.uploadVideoFrame(video, epoch);
          } else {
            chromaKeyEngineRef.current?.processFrame(video, chromaKeyRef.current, epoch);
          }
        }

        const nextSeekPromise = hasNext ? seekAndAwait(upcomingT) : null;

        currTargets = slowTracker.stepFrameWithFrame(
          currFrame,
          currTargets,
          chromaKeyRef.current,
          settingsRef.current,
          allowNewEntries
        );

        let merged: DetectedPlayerBox[];
        let targetExited = false;
        if (targetId) {
          const updatedTarget = currTargets.find((b) => b.id === targetId);
          if (updatedTarget) {
            merged = detectedBoxesRef.current.map((b) =>
              b.id === targetId ? updatedTarget : b
            );
            currTargets = [updatedTarget];
          } else {
            merged = detectedBoxesRef.current.filter((b) => b.id !== targetId);
            targetExited = true;
          }
        } else {
          merged = currTargets;
        }

        const pct =
          endT > startT + 0.05
            ? Math.min(100, Math.max(0, Math.round(((frameTime - startT) / (endT - startT)) * 100)))
            : 100;

        if (cancelled || slowTrackUserEditedRef.current) {
          break;
        }

        hasProcessedStep = true;
        lastMerged = merged;
        lastFrameTime = frameTime;
        lastPct = pct;
        detectedBoxesRef.current = merged;
        if (shouldRenderPreview) {
          drawOverlay();
          lastDrawMs = performance.now();
        }

        const now = performance.now();
        if (targetExited || !hasNext || now - lastUiSyncMs >= 350) {
          lastUiSyncMs = now;
          onBackgroundTracksSync(slowTracker.getAllTrackRecords());
          onFullSweepTimesSync(slowTracker.getFullSweepTimes());
          onSlowTrackStep(merged, frameTime, pct);
        }

        if (targetExited) {
          onSelectDetectedBox(null);
          break;
        }

        if (!nextSeekPromise) {
          break;
        }

        await nextSeekPromise;
        if (cancelled) break;

        // Yield briefly only if many frames completed synchronously so Pause stays responsive
        const afterSeekMs = performance.now();
        if (afterSeekMs - lastYieldMs >= 50) {
          lastYieldMs = afterSeekMs;
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, 0);
          });
        }
      }

      } catch (err) {
        console.error('Slow player tracking error:', err);
      }

      if (!flushedFinal && hasProcessedStep && slowTracker.hasHistories()) {
        flushedFinal = true;
        const boxesToCommit = slowTrackUserEditedRef.current ? detectedBoxesRef.current : lastMerged;
        onBackgroundTracksSync(slowTracker.getAllTrackRecords());
        onFullSweepTimesSync(slowTracker.getFullSweepTimes());
        onSlowTrackStep(boxesToCommit, lastFrameTime, lastPct);
      }

      if (!cancelled) {
        onSlowTrackStateChange(false);
      }
    })();

    return () => {
      cancelled = true;
      if (!flushedFinal && hasProcessedStep && slowTracker.hasHistories() && videoRef.current === video) {
        flushedFinal = true;
        const boxesToCommit = slowTrackUserEditedRef.current ? detectedBoxesRef.current : lastMerged;
        onBackgroundTracksSync(slowTracker.getAllTrackRecords());
        onFullSweepTimesSync(slowTracker.getFullSweepTimes());
        onSlowTrackStep(boxesToCommit, lastFrameTime, lastPct);
      }
    };
  }, [
    isSlowTrackingDetected,
    videoUrl,
    onPlayStateChange,
    onSelectDetectedBox,
    onBackgroundTracksSync,
    onFullSweepTimesSync,
    onSlowTrackStep,
    onSlowTrackStateChange,
    drawOverlay,
  ]);

  // Implement tracked player trajectories in background state, clear & hide tracking boxes
  useEffect(() => {
    if (!implementRequest || implementRequest.seq === lastImplementSeqRef.current) return;
    lastImplementSeqRef.current = implementRequest.seq;

    const slowTracker = detectedBoxTrackerRef.current;
    const allRecords = slowTracker?.getAllTrackRecords() ?? [];

    let records: BackgroundPlayerTrackRecord[] = [];
    if (allRecords.length > 0) {
      records = implementRequest.targetId
        ? allRecords.filter((rec) => rec.id === implementRequest.targetId)
        : allRecords;
    }

    if (records.length === 0) {
      const allBoxes = detectedBoxesRef.current;
      const sourceBoxes = implementRequest.targetId
        ? allBoxes.filter((b) => b.id === implementRequest.targetId)
        : allBoxes;

      records = sourceBoxes.map((box) => {
        const recorded = slowTracker?.getHistory(box.id) ?? [];
        const fallbackPos: CirclePosition = {
          cx: box.cx,
          cy: box.cy,
          width: box.width,
          height: box.height,
          radius: Math.max(box.width, box.height) * 0.5,
          confidence: box.confidence,
          status: 'anchored',
          time: box.time,
        };
        const positions = recorded.length > 0 ? recorded.slice() : [fallbackPos];
        return {
          id: box.id,
          source: box.source,
          firstTime: positions[0].time,
          lastTime: positions[positions.length - 1].time,
          positions,
        };
      });
    }

    if (records.length === 0) return;

    const implementedSweepTimes = implementRequest.targetId
      ? []
      : (slowTracker?.getFullSweepTimes() ?? []).slice();
    onImplementTrackedTracks(records, implementedSweepTimes);
    slowTracker?.reset();
    detectedBoxesRef.current = [];
    hoveredDetectorEraseIdRef.current = null;
    onBackgroundTracksSync([]);
    onFullSweepTimesSync([]);
    drawOverlay();
  }, [implementRequest, onImplementTrackedTracks, onBackgroundTracksSync, onFullSweepTimesSync, drawOverlay]);

  useEffect(() => {
    drawOverlay();
  }, [implementedTracks, hoveredTrackedPlayerId, showCoverageOverlay, coverageSummary, drawOverlay]);

  // Clear pending spotlight/ring/chain/polygon if tool switches away or realign starts
  useEffect(() => {
    if (toolMode !== 'spotlight' || realigningPlayerId) {
      setPendingSpotlight(null);
    }
    if (toolMode !== 'ring' || realigningPlayerId) {
      setPendingRing(null);
    }
    if (toolMode !== 'chain' || realigningPlayerId) {
      setPendingChainRingIds([]);
      hoveredChainRingIdRef.current = null;
    }
    if (toolMode !== 'polygon' || realigningPlayerId) {
      setPendingPolygonNodes([]);
    }
    if (toolMode !== 'erase') {
      hoveredEraseIdRef.current = null;
    }
    hoveredSnapTrackRef.current = null;
  }, [toolMode, realigningPlayerId]);

  useEffect(() => {
    if (!isSamplingPitch) {
      sampleHoverRef.current = null;
    }
    chromaFrameEpochRef.current += 1;
    drawOverlay();
  }, [chromaKey, isSamplingPitch, drawOverlay]);

  // Keep overlay synced on resize & player state changes, and prune removed/stopped player templates
  useEffect(() => {
    const tracker = trackerRef.current;
    const currTime = videoRef.current?.currentTime ?? 0;
    const activeUnitIds = new Set<string>();
    const unitPositions: Array<{ id: string; pos: CirclePosition }> = [];

    for (const p of players) {
      const parentStopped = p.stopTime !== undefined && currTime > p.stopTime + 0.03;
      if ((p.style === 'chain' || p.style === 'polygon') && p.nodes) {
        for (const node of p.nodes) {
          const nodeStopped = node.stopTime !== undefined && currTime > node.stopTime + 0.03;
          if (p.trackWithCv !== false && node.trackWithCv && !parentStopped && !nodeStopped) {
            activeUnitIds.add(node.id);
          }
          unitPositions.push({ id: node.id, pos: node.currentPosition });
        }
      } else {
        if (p.trackWithCv !== false && !parentStopped) {
          activeUnitIds.add(p.id);
        }
        unitPositions.push({ id: p.id, pos: p.currentPosition });
      }
    }

    if (tracker) {
      if (players.length === 0) {
        tracker.reset();
      } else {
        tracker.syncPlayers(Array.from(activeUnitIds));
      }
    }

    const activePlayerIds = new Set(players.map((p) => p.id));
    const allUnitIds = new Set(unitPositions.map((u) => u.id));

    for (const id of particleSeedsRef.current.keys()) {
      if (!activePlayerIds.has(id)) {
        particleSeedsRef.current.delete(id);
      }
    }
    for (const id of ringEntranceRef.current.keys()) {
      if (!activePlayerIds.has(id)) {
        ringEntranceRef.current.delete(id);
      }
    }
    for (const id of displayPosRef.current.keys()) {
      if (!allUnitIds.has(id)) {
        displayPosRef.current.delete(id);
      }
    }
    for (const id of livePosRef.current.keys()) {
      if (!allUnitIds.has(id)) {
        livePosRef.current.delete(id);
        pendingBatchRef.current.delete(id);
      }
    }
    const nowMs = performance.now();
    for (const { id, pos } of unitPositions) {
      // Only overwrite livePosRef from React state when paused, when no live batch is pending, or when resumed from stopped
      const existingLive = livePosRef.current.get(id);
      if (
        !isPlaying ||
        !pendingBatchRef.current.has(id) ||
        (existingLive?.status === 'stopped' && pos.status !== 'stopped')
      ) {
        livePosRef.current.set(id, pos);
      }
      const target = livePosRef.current.get(id) ?? pos;
      const prev = displayPosRef.current.get(id);
      if (!isPlaying || !prev || Math.hypot(target.cx - prev.cx, target.cy - prev.cy) > 0.14) {
        displayPosRef.current.set(id, {
          cx: target.cx,
          cy: target.cy,
          width: target.width,
          height: target.height,
          radius: target.radius,
          vx: 0,
          vy: 0,
          lastTargetCx: target.cx,
          lastTargetCy: target.cy,
          lastTargetTime: target.time,
          lastUpdateMs: nowMs,
          tvx: 0,
          tvy: 0,
        });
      } else if (
        target.time !== prev.lastTargetTime ||
        target.cx !== prev.lastTargetCx ||
        target.cy !== prev.lastTargetCy
      ) {
        updateSpringTarget(prev, target, nowMs);
      }
    }
    if (!isPlaying) {
      drawOverlay();
    }
  }, [
    players,
    isPlaying,
    selectedPlayerId,
    selectedNodeId,
    showTrails,
    dragState,
    pendingSpotlight,
    pendingRing,
    pendingChainRingIds,
    pendingPolygonNodes,
    spotlightSettings,
    ringSettings,
    chainSettings,
    polygonSettings,
    toolMode,
    detectedBoxes,
    selectedDetectedBoxId,
    showDetectedBoxes,
    showPlayerBoxBar,
    detectorSubTool,
    isSlowTrackingDetected,
    showCoverageOverlay,
    coverageSummary,
    drawOverlay,
  ]);

  // Unified 60fps render & critically-damped interpolation loop
  const hasVisibleOverlays =
    players.some((p) => p.visible) ||
    (showDetectedBoxes &&
      (detectedBoxes.length > 0 || (detectedBoxTrackerRef.current?.hasHistories() ?? false)));
  const hasAnimatedOverlays =
    players.some(
      (p) => p.visible && (p.style === 'spotlight' || p.style === 'foot-ring' || p.style === 'chain')
    ) ||
    pendingChainRingIds.length > 0 ||
    toolMode === 'chain';
  useEffect(() => {
    if (!videoUrl || (!isPlaying && !hasAnimatedOverlays)) return;
    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion && !isPlaying) return;

    let rafId: number | null = null;
    let lastTs = performance.now();
    let lastDrawnEpoch = -1;

    const tick = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTs) / 1000));
      lastTs = now;

      const smoothing = settingsRef.current.smoothing ?? 0.65;
      if (isPlayingRef.current && !reduceMotion && hasVisibleOverlays) {
        const video = videoRef.current;
        let effTime = video ? video.currentTime : 0;
        if (video && !video.paused && !video.seeking) {
          const clk = playbackClockRef.current;
          if (
            Math.abs(effTime - clk.videoTime) > 1e-4 ||
            clk.wallMs === 0 ||
            effTime < clk.videoTime
          ) {
            clk.videoTime = effTime;
            clk.wallMs = now;
          }
          const rate = Math.max(0.1, Math.min(4, video.playbackRate || 1));
          effTime += Math.max(0, Math.min(0.05, ((now - clk.wallMs) / 1000) * rate));
        }

        for (const p of playersRef.current) {
          if (!p.visible) continue;
          if ((p.style === 'chain' || p.style === 'polygon') && p.nodes) {
            for (const node of p.nodes) {
              const lastH =
                node.history.length > 0 ? node.history[node.history.length - 1] : null;
              let target = livePosRef.current.get(node.id) ?? node.currentPosition;
              if (
                node.trackWithCv &&
                node.history.length > 1 &&
                lastH &&
                effTime < lastH.time - 0.005 &&
                effTime >= node.anchorTime - 0.02
              ) {
                const interp = interpolateHistoryPoint(node.history, effTime);
                if (interp) {
                  target = interp;
                  livePosRef.current.set(node.id, interp);
                }
              }
              const curr = displayPosRef.current.get(node.id);
              if (curr && target.time !== curr.lastTargetTime) {
                updateSpringTarget(curr, target, now);
              }
              const nextSpring = stepDisplaySpring(curr, target, dt, now, smoothing);
              if (nextSpring !== curr) {
                displayPosRef.current.set(node.id, nextSpring);
              }
            }
          } else {
            const lastH = p.history.length > 0 ? p.history[p.history.length - 1] : null;
            let target = livePosRef.current.get(p.id) ?? p.currentPosition;
            if (
              p.trackWithCv !== false &&
              p.history.length > 1 &&
              lastH &&
              effTime < lastH.time - 0.005 &&
              effTime >= p.anchorTime - 0.02
            ) {
              const interp = interpolateHistoryPoint(p.history, effTime);
              if (interp) {
                target = interp;
                livePosRef.current.set(p.id, interp);
              }
            }
            const curr = displayPosRef.current.get(p.id);
            if (curr && target.time !== curr.lastTargetTime) {
              updateSpringTarget(curr, target, now);
            }
            const nextSpring = stepDisplaySpring(curr, target, dt, now, smoothing);
            if (nextSpring !== curr) {
              displayPosRef.current.set(p.id, nextSpring);
            }
          }
        }
      }

      const epoch = chromaFrameEpochRef.current;
      const needsDraw =
        epoch !== lastDrawnEpoch ||
        (!reduceMotion && (hasAnimatedOverlays || (isPlayingRef.current && hasVisibleOverlays)));

      if (needsDraw) {
        lastDrawnEpoch = epoch;
        drawOverlay();
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [videoUrl, isPlaying, hasVisibleOverlays, hasAnimatedOverlays, drawOverlay]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const syncSize = () => {
      setStageSize({ w: container.clientWidth, h: container.clientHeight });
      const rect = getVideoRenderRect();
      if (rect) {
        onRenderRectWidthChange?.(rect.w);
      }
      drawOverlay();
    };
    syncSize();
    const ro = new ResizeObserver(syncSize);
    ro.observe(container);
    return () => ro.disconnect();
  }, [drawOverlay, getVideoRenderRect, onRenderRectWidthChange]);

  // Sync playback rate & loop attribute
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = playbackRate;
    video.loop = isLooping;
  }, [playbackRate, isLooping]);

  // Handle explicit Play / Pause prop transitions
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoUrl) return;

    if (isPlaying) {
      setPendingSpotlight(null);
      setPendingRing(null);
      setPendingChainRingIds([]);
      setPendingPolygonNodes([]);
      // Seed CV tracker with current frame right before playback starts
      const tracker = trackerRef.current;
      if (tracker && video.readyState >= 2) {
        const frame = tracker.captureFrame(video);
        if (frame) {
          tracker.setPrevFrame(frame);
          lastProcessedTimeRef.current = video.currentTime;
          const shouldReseedAll = needsTrackerReseedRef.current;
          needsTrackerReseedRef.current = false;

          for (const p of playersRef.current) {
            if (!p.visible || p.trackWithCv === false) continue;
            if ((p.style === 'chain' || p.style === 'polygon') && p.nodes) {
              if (p.stopTime !== undefined && video.currentTime > p.stopTime + 0.02) continue;
              for (const node of p.nodes) {
                if (!node.trackWithCv) continue;
                if (video.currentTime + 0.04 < node.anchorTime) continue;
                if (node.stopTime !== undefined && video.currentTime > node.stopTime + 0.02) {
                  continue;
                }
                const kfs = node.keyframes.length > 0 ? node.keyframes : [node.anchorPosition];
                const nearKeyframe = kfs.some(
                  (kf) => Math.abs(video.currentTime - kf.time) < 0.06
                );
                if (!tracker.hasTemplate(node.id) || nearKeyframe || shouldReseedAll) {
                  tracker.anchorPlayer(
                    node.id,
                    frame,
                    node.currentPosition,
                    settingsRef.current.turfMasking
                  );
                }
              }
              continue;
            }

            // Do not sample template before anchor or after stopTime
            if (video.currentTime + 0.04 < p.anchorTime) continue;
            if (p.stopTime !== undefined && video.currentTime > p.stopTime + 0.02) continue;

            const kfs = p.keyframes.length > 0 ? p.keyframes : [p.anchorPosition];
            const nearKeyframe = kfs.some(
              (kf) => Math.abs(video.currentTime - kf.time) < 0.06
            );

            // Re-anchor template if missing, scrubbed while paused, or starting at a keyframe
            if (!tracker.hasTemplate(p.id) || nearKeyframe || shouldReseedAll) {
              tracker.anchorPlayer(
                p.id,
                frame,
                p.currentPosition,
                settingsRef.current.turfMasking
              );
            }
          }
        }
      }

      video.play().catch(() => {
        onPlayStateChange(false);
      });
    } else {
      video.pause();
      flushPendingTrackingToReact(video.currentTime);
      chromaFrameEpochRef.current += 1;
      drawOverlay();
    }
  }, [isPlaying, videoUrl, onPlayStateChange, drawOverlay, flushPendingTrackingToReact]);

  // Handle external seek requests (scrubber, frame step, jump to anchor, trim-edge glance)
  useEffect(() => {
    if (!seekRequest) return;
    const video = videoRef.current;
    if (!video) return;
    const targetTime = Math.max(0, seekRequest.time);
    flushPendingTrackingToReact(targetTime);
    setPendingSpotlight(null);
    setPendingRing(null);
    setPendingChainRingIds([]);
    setPendingPolygonNodes([]);
    needsTrackerReseedRef.current = true;
    lastProcessedTimeRef.current = targetTime;
    if (video.seeking) {
      pendingSeekTimeRef.current = targetTime;
    } else {
      pendingSeekTimeRef.current = null;
      video.currentTime = targetTime;
    }
  }, [seekRequest, flushPendingTrackingToReact]);

  // Handle explicit "Re-sample current spot" action
  useEffect(() => {
    if (!reanchorRequest) return;
    const video = videoRef.current;
    const tracker = trackerRef.current;
    if (!video || !tracker) return;

    const target = playersRef.current.find((p) => p.id === reanchorRequest.playerId);
    if (!target) return;

    const frame = tracker.captureFrame(video);
    if (!frame) return;

    if ((target.style === 'chain' || target.style === 'polygon') && target.nodes && target.nodes.length > 0) {
      const targetNodeId = reanchorRequest.nodeId ?? target.nodes[0].id;
      const targetNode = target.nodes.find((n) => n.id === targetNodeId);
      if (!targetNode) return;
      const updatedPos: CirclePosition = {
        ...targetNode.currentPosition,
        confidence: 1,
        status: 'anchored',
        time: video.currentTime,
      };
      tracker.anchorPlayer(targetNode.id, frame, updatedPos, settingsRef.current.turfMasking);
      tracker.setPrevFrame(frame);
      lastProcessedTimeRef.current = video.currentTime;
      needsTrackerReseedRef.current = false;
      onUpdateNodeAnchor(target.id, targetNode.id, updatedPos);
      onCompleteRealign();
      return;
    }

    const updatedPos: CirclePosition = {
      ...target.currentPosition,
      confidence: 1,
      status: 'anchored',
      time: video.currentTime,
    };
    tracker.anchorPlayer(target.id, frame, updatedPos, settingsRef.current.turfMasking);
    tracker.setPrevFrame(frame);
    lastProcessedTimeRef.current = video.currentTime;
    needsTrackerReseedRef.current = false;
    onUpdatePlayerAnchor(target.id, updatedPos);
    onCompleteRealign();
  }, [reanchorRequest, onUpdatePlayerAnchor, onUpdateNodeAnchor, onCompleteRealign]);

  // Process a single video frame for CV tracking
  const processCurrentVideoFrame = useCallback(() => {
    const video = videoRef.current;
    const tracker = trackerRef.current;
    if (!video || !tracker || video.readyState < 2) return;

    const currTime = video.currentTime;
    // Skip duplicate CV tracking on identical timestamps
    if (!needsTrackerReseedRef.current && Math.abs(currTime - lastProcessedTimeRef.current) < 0.004) {
      return;
    }

    interface ActiveTrackUnit {
      id: string;
      anchorTime: number;
      anchorPosition: CirclePosition;
      currentPosition: CirclePosition;
      history: CirclePosition[];
    }

    const activeUnits: ActiveTrackUnit[] = [];
    for (const p of playersRef.current) {
      const parentLive = livePosRef.current.get(p.id);
      const parentEffStop =
        p.stopTime ?? (parentLive?.status === 'stopped' ? parentLive.time : undefined);
      const parentStopped = parentEffStop !== undefined && currTime > parentEffStop + 0.02;

      if ((p.style === 'chain' || p.style === 'polygon') && p.nodes) {
        for (const node of p.nodes) {
          const livePos = livePosRef.current.get(node.id);
          const effStop =
            node.stopTime ?? (livePos?.status === 'stopped' ? livePos.time : undefined);
          const nodeStopped = parentStopped || (effStop !== undefined && currTime > effStop + 0.02);
          if (p.visible && p.trackWithCv !== false && node.trackWithCv && !nodeStopped) {
            activeUnits.push({
              id: node.id,
              anchorTime: node.anchorTime,
              anchorPosition: node.anchorPosition,
              currentPosition: node.currentPosition,
              history: node.history,
            });
          } else if (nodeStopped) {
            tracker.removePlayer(node.id);
          }
        }
      } else {
        const isStopped = parentStopped;
        if (p.visible && p.trackWithCv !== false && !isStopped) {
          activeUnits.push({
            id: p.id,
            anchorTime: p.anchorTime,
            anchorPosition: p.anchorPosition,
            currentPosition: p.currentPosition,
            history: p.history,
          });
        } else if (isStopped) {
          tracker.removePlayer(p.id);
        }
      }
    }

    if (activeUnits.length === 0) {
      lastProcessedTimeRef.current = currTime;
      needsTrackerReseedRef.current = false;
      const nowMs = performance.now();
      if (nowMs - lastUiCommitMsRef.current >= 160) {
        flushPendingTrackingToReact(currTime);
      }
      return;
    }

    const currFrame = tracker.captureFrame(video);
    if (!currFrame) return;

    const prevTime = lastProcessedTimeRef.current;
    lastProcessedTimeRef.current = currTime;

    // Detect if user jumped backward during playback (e.g. looping) or scrubbed while playing
    const jumpedBackward = prevTime >= 0 && currTime < prevTime - 0.12;
    const updates = new Map<string, CirclePosition>();
    const replayUpdates = new Map<string, CirclePosition>();

    if (jumpedBackward || needsTrackerReseedRef.current) {
      needsTrackerReseedRef.current = false;
      pendingBatchRef.current.clear();
      for (const unit of activeUnits) {
        if (currTime + 0.04 < unit.anchorTime) {
          const resetPos = { ...unit.anchorPosition, time: currTime };
          livePosRef.current.set(unit.id, resetPos);
          updates.set(unit.id, resetPos);
        } else {
          const histPos =
            interpolateHistoryPoint(unit.history, currTime) ??
            findClosestHistoryPoint(unit.history, currTime) ??
            unit.anchorPosition;
          tracker.anchorPlayer(unit.id, currFrame, histPos, settingsRef.current.turfMasking);
          livePosRef.current.set(unit.id, histPos);
          updates.set(unit.id, histPos);
        }
      }
      tracker.setPrevFrame(currFrame);
      if (updates.size > 0) {
        onPlayersTrackedFrame(updates, false);
      }
      onTimeUpdate(currTime);
      lastUiCommitMsRef.current = performance.now();
      return;
    }

    // Standard forward frame-to-frame joint CV tracking
    const prevFrame = tracker.getPrevFrame();
    const camShift =
      prevFrame && settingsRef.current.cameraCompensation
        ? tracker.estimateGlobalCameraShift(prevFrame, currFrame)
        : { dx: 0, dy: 0 };

    const trackInputs: Array<{ id: string; prevPos: CirclePosition }> = [];

    for (const unit of activeUnits) {
      // Only track once video reaches or passes the unit's anchor frame
      if (currTime + 0.02 < unit.anchorTime) {
        continue;
      }

      const currKnownPos = livePosRef.current.get(unit.id) ?? unit.currentPosition;

      // If this unit already has recorded history covering currTime (e.g. after seeking backward or implemented tracks),
      // interpolate smoothly instead of snapping to the nearest sample
      const lastRecorded = unit.history.length > 0 ? unit.history[unit.history.length - 1] : null;
      if (
        unit.history.length > 1 &&
        lastRecorded &&
        currTime < lastRecorded.time - 0.005
      ) {
        const recorded = interpolateHistoryPoint(unit.history, currTime);
        if (recorded) {
          livePosRef.current.set(unit.id, recorded);
          replayUpdates.set(unit.id, recorded);
          const disp = displayPosRef.current.get(unit.id);
          if (disp) {
            updateSpringTarget(disp, recorded, performance.now());
          }
          continue;
        }
      }

      // If we haven't initialized a template yet (e.g. unit just crossed anchorTime), anchor now
      if (!tracker.hasTemplate(unit.id)) {
        tracker.anchorPlayer(unit.id, currFrame, currKnownPos, settingsRef.current.turfMasking);
        continue;
      }

      trackInputs.push({ id: unit.id, prevPos: currKnownPos });
    }

    const nowMs = performance.now();
    if (replayUpdates.size > 0 && nowMs - lastReplayCommitMsRef.current >= 160) {
      lastReplayCommitMsRef.current = nowMs;
      onPlayersTrackedFrame(replayUpdates, false);
    }

    let hitStopTransition = false;

    if (trackInputs.length > 0) {
      const jointResults = tracker.trackAllPlayers(
        currFrame,
        trackInputs,
        camShift,
        settingsRef.current
      );
      for (const [id, nextPos] of jointResults.entries()) {
        livePosRef.current.set(id, nextPos);
        let list = pendingBatchRef.current.get(id);
        if (!list) {
          list = [];
          pendingBatchRef.current.set(id, list);
        }
        list.push(nextPos);
        if (nextPos.status === 'stopped') {
          hitStopTransition = true;
        }

        // Feed spring interpolation target directly from live CV output without waiting for React state
        const disp = displayPosRef.current.get(id);
        if (disp) {
          updateSpringTarget(disp, nextPos, nowMs);
        }
      }
    }

    tracker.setPrevFrame(currFrame);

    // Commit to React state periodically (~5-6 Hz) or immediately when a unit auto-stops
    if (hitStopTransition || nowMs - lastUiCommitMsRef.current >= 180) {
      flushPendingTrackingToReact(currTime);
    }
  }, [flushPendingTrackingToReact, onPlayersTrackedFrame, onTimeUpdate]);

  // Attach requestVideoFrameCallback (or rAF time polling fallback) during playback
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !isPlaying) return;

    let cancelled = false;
    let rvfcId: number | null = null;
    let rafId: number | null = null;
    let lastFallbackTime = -1;
    lastUiCommitMsRef.current = performance.now();

    const videoWithRvfc = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
      cancelVideoFrameCallback?: (id: number) => void;
    };

    if (typeof videoWithRvfc.requestVideoFrameCallback === 'function') {
      const onFrame = () => {
        if (cancelled) return;
        chromaFrameEpochRef.current += 1;
        processCurrentVideoFrame();
        rvfcId = videoWithRvfc.requestVideoFrameCallback!(onFrame);
      };
      rvfcId = videoWithRvfc.requestVideoFrameCallback(onFrame);
    } else {
      const onRaf = () => {
        if (cancelled) return;
        if (Math.abs(video.currentTime - lastFallbackTime) >= 0.004) {
          lastFallbackTime = video.currentTime;
          chromaFrameEpochRef.current += 1;
        }
        processCurrentVideoFrame();
        rafId = requestAnimationFrame(onRaf);
      };
      rafId = requestAnimationFrame(onRaf);
    }

    return () => {
      cancelled = true;
      if (rvfcId !== null && typeof videoWithRvfc.cancelVideoFrameCallback === 'function') {
        videoWithRvfc.cancelVideoFrameCallback(rvfcId);
      }
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [isPlaying, processCurrentVideoFrame]);

  const confirmPendingSpotlight = useCallback(() => {
    const pending = pendingSpotlightRef.current;
    const video = videoRef.current;
    const tracker = trackerRef.current;
    if (!pending || !video) return;

    const anchorPos: CirclePosition = {
      cx: pending.cx,
      cy: pending.cy,
      width: pending.width,
      height: pending.height,
      radius: pending.radius,
      confidence: 1,
      status: 'anchored',
      time: video.currentTime,
    };

    onPushUndoSnapshot();
    const newId = onAddSpotlight(anchorPos);
    onSelectPlayer(newId);

    if (tracker && spotlightSettingsRef.current.trackWithCv) {
      const frame = tracker.captureFrame(video);
      if (frame) {
        tracker.anchorPlayer(newId, frame, anchorPos, settingsRef.current.turfMasking);
        tracker.setPrevFrame(frame);
        lastProcessedTimeRef.current = video.currentTime;
        needsTrackerReseedRef.current = false;
      }
    }

    setPendingSpotlight(null);
  }, [onAddSpotlight, onPushUndoSnapshot, onSelectPlayer]);

  const cancelPendingSpotlight = useCallback(() => {
    setPendingSpotlight(null);
  }, []);

  const confirmPendingRing = useCallback(() => {
    const pending = pendingRingRef.current;
    const video = videoRef.current;
    const tracker = trackerRef.current;
    if (!pending || !video) return;

    const anchorPos: CirclePosition = {
      cx: pending.cx,
      cy: pending.cy,
      width: pending.width,
      height: pending.height,
      radius: pending.radius,
      confidence: 1,
      status: 'anchored',
      time: video.currentTime,
    };

    onPushUndoSnapshot();
    const newId = onAddRing(anchorPos);
    ringEntranceRef.current.set(newId, performance.now());
    onSelectPlayer(newId);

    if (tracker && ringSettingsRef.current.trackWithCv) {
      const frame = tracker.captureFrame(video);
      if (frame) {
        tracker.anchorPlayer(newId, frame, anchorPos, settingsRef.current.turfMasking);
        tracker.setPrevFrame(frame);
        lastProcessedTimeRef.current = video.currentTime;
        needsTrackerReseedRef.current = false;
      }
    }

    setPendingRing(null);
  }, [onAddRing, onPushUndoSnapshot, onSelectPlayer]);

  const cancelPendingRing = useCallback(() => {
    setPendingRing(null);
  }, []);

  const confirmPendingChain = useCallback(() => {
    const ringIds = pendingChainRingIdsRef.current;
    if (ringIds.length < 2) return;

    onPushUndoSnapshot();
    const newId = onAddChainFromRings(ringIds);
    if (newId) {
      onSelectPlayer(newId);
      onSelectNode(null);
    }

    setPendingChainRingIds([]);
    lastChainClickRef.current = { time: 0, x: 0, y: 0 };
  }, [onAddChainFromRings, onPushUndoSnapshot, onSelectNode, onSelectPlayer]);

  const cancelPendingChain = useCallback(() => {
    setPendingChainRingIds([]);
    lastChainClickRef.current = { time: 0, x: 0, y: 0 };
  }, []);

  const undoLastChainRing = useCallback(() => {
    setPendingChainRingIds((prev) => prev.slice(0, -1));
  }, []);

  const confirmPendingPolygon = useCallback(() => {
    const vertsToCommit = pendingPolygonRef.current;
    const video = videoRef.current;
    const tracker = trackerRef.current;
    if (!video || vertsToCommit.length < 3) return;

    const ps = polygonSettingsRef.current;
    const stamp = Date.now();
    const currTime = video.currentTime;
    const trackedNodes: TrackedNode[] = vertsToCommit.map((n, i) => {
      const hist = n.history && n.history.length > 0 ? n.history.slice() : null;
      if (hist) {
        const first = hist[0];
        const last = hist[hist.length - 1];
        const keyframes: CirclePosition[] = [first];
        let lastKfTime = first.time;
        for (let k = 1; k < hist.length - 1; k++) {
          if (hist[k].time - lastKfTime >= 0.75) {
            keyframes.push(hist[k]);
            lastKfTime = hist[k].time;
          }
        }
        if (hist.length > 1) {
          keyframes.push(last);
        }
        const currPos =
          interpolateHistoryPoint(hist, currTime) ?? { ...n.pos, time: currTime };
        const stopTime = hist.length > 1 ? last.time : undefined;
        return {
          id: `pnode_${stamp}_${i}_${Math.random().toString(36).slice(2, 6)}`,
          label: `Vertex ${i + 1}`,
          trackWithCv: ps.trackWithCv,
          attachedTrackId: n.attachedTrackId,
          anchorTime: first.time,
          anchorPosition: first,
          stopTime,
          stopReason: stopTime !== undefined ? 'manual' : undefined,
          keyframes,
          currentPosition: currPos,
          history: hist,
        };
      }
      return {
        id: `pnode_${stamp}_${i}_${Math.random().toString(36).slice(2, 6)}`,
        label: `Vertex ${i + 1}`,
        trackWithCv: ps.trackWithCv,
        anchorTime: currTime,
        anchorPosition: { ...n.pos, time: currTime },
        keyframes: [{ ...n.pos, time: currTime }],
        currentPosition: { ...n.pos, time: currTime },
        history: [{ ...n.pos, time: currTime }],
      };
    });

    onPushUndoSnapshot();
    const newId = onAddPolygon(trackedNodes);
    onSelectPlayer(newId);
    onSelectNode(trackedNodes[0]?.id ?? null);

    if (tracker && ps.trackWithCv) {
      const nodesNeedingSeed = trackedNodes.filter(
        (tn) => !tn.attachedTrackId || tn.history.length <= 1
      );
      if (nodesNeedingSeed.length > 0) {
        const frame = tracker.captureFrame(video);
        if (frame) {
          for (const tn of nodesNeedingSeed) {
            tracker.anchorPlayer(
              tn.id,
              frame,
              tn.anchorPosition,
              settingsRef.current.turfMasking
            );
          }
          tracker.setPrevFrame(frame);
          lastProcessedTimeRef.current = currTime;
          needsTrackerReseedRef.current = false;
        }
      }
    }

    setPendingPolygonNodes([]);
    lastPolygonClickRef.current = { time: 0, x: 0, y: 0 };
  }, [onAddPolygon, onPushUndoSnapshot, onSelectNode, onSelectPlayer]);

  const cancelPendingPolygon = useCallback(() => {
    setPendingPolygonNodes([]);
    lastPolygonClickRef.current = { time: 0, x: 0, y: 0 };
  }, []);

  const undoLastPolygonVertex = useCallback(() => {
    setPendingPolygonNodes((prev) => prev.slice(0, -1));
  }, []);

  // Enter confirms, Backspace pops last node, and Esc cancels any unconfirmed overlay
  useEffect(() => {
    const hasPendingGroup = pendingChainRingIds.length > 0 || pendingPolygonNodes.length > 0;
    if (!pendingSpotlight && !pendingRing && !hasPendingGroup) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (pendingSpotlight) {
          confirmPendingSpotlight();
        } else if (pendingRing) {
          confirmPendingRing();
        } else if (pendingChainRingIds.length >= 2) {
          confirmPendingChain();
        } else if (pendingPolygonNodes.length >= 3) {
          confirmPendingPolygon();
        }
      } else if (e.key === 'Backspace' && hasPendingGroup) {
        e.preventDefault();
        e.stopPropagation();
        if (pendingChainRingIds.length > 0) {
          undoLastChainRing();
        } else if (pendingPolygonNodes.length > 0) {
          undoLastPolygonVertex();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (pendingSpotlight) {
          cancelPendingSpotlight();
        } else if (pendingRing) {
          cancelPendingRing();
        } else if (pendingChainRingIds.length > 0) {
          cancelPendingChain();
        } else if (pendingPolygonNodes.length > 0) {
          cancelPendingPolygon();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [
    pendingSpotlight,
    pendingRing,
    pendingChainRingIds.length,
    pendingPolygonNodes.length,
    confirmPendingSpotlight,
    cancelPendingSpotlight,
    confirmPendingRing,
    cancelPendingRing,
    confirmPendingChain,
    cancelPendingChain,
    undoLastChainRing,
    confirmPendingPolygon,
    cancelPendingPolygon,
    undoLastPolygonVertex,
  ]);

  // Pointer interaction for Circle, Spotlight, Ring, Chain, Polygon & Select/Adjust Tools
  const getCanvasCoords = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const bounds = canvas.getBoundingClientRect();
    return {
      x: e.clientX - bounds.left,
      y: e.clientY - bounds.top,
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!videoUrl) return;
    if (e.button === 2) {
      if (pendingChainRingIdsRef.current.length > 0) {
        cancelPendingChain();
      } else if (pendingPolygonRef.current.length > 0) {
        cancelPendingPolygon();
      }
      return;
    }

    const rect = getVideoRenderRect();
    if (!rect) return;

    const { x, y } = getCanvasCoords(e);
    // Ignore clicks outside the video frame letterbox
    if (x < rect.x || x > rect.x + rect.w || y < rect.y || y > rect.y + rect.h) {
      return;
    }

    // If Sample Pitch mode is active, sample pitch color at click position and stay active for multi-color sampling
    if (isSamplingPitchRef.current) {
      const video = videoRef.current;
      if (video && chromaKeyEngineRef.current) {
        const normX = clamp01((x - rect.x) / rect.w);
        const normY = clamp01((y - rect.y) / rect.h);
        const sampled = chromaKeyEngineRef.current.samplePitchColorAt(
          video,
          normX,
          normY,
          chromaFrameEpochRef.current
        );
        if (sampled) {
          onSamplePitchColor(sampled.hex);
        }
      }
      return;
    }

    undoPushedForDragRef.current = false;

    // Pause playback or slow-tracking immediately if user clicks to adjust boxes or place tools
    if (isPlaying) {
      onPlayStateChange(false);
    }
    if (isSlowTrackingDetectedRef.current) {
      isSlowTrackingDetectedRef.current = false;
      onSlowTrackStateChange(false);
    }

    const activeDetectedBoxes = getActiveDetectedBoxes(videoRef.current?.currentTime ?? 0);

    // Player Box Eraser / Drawer tools (paused in tracking phase)
    if (detectorSubToolRef.current === 'eraser') {
      const hitBox = findHitDetectedBox(x, y, rect, activeDetectedBoxes);
      if (hitBox) {
        slowTrackUserEditedRef.current = true;
        hoveredDetectorEraseIdRef.current = null;
        const video = videoRef.current;
        const detector = playerDetectorRef.current;
        const currT = video?.currentTime ?? 0;
        const stats =
          video && detector
            ? detector.trainNegative(video, hitBox, chromaKeyRef.current, currT)
            : detector?.getStats() ?? { positiveCount: 0, negativeCount: 0, isTrained: false };
        detectedBoxTrackerRef.current?.handleUserEraseBox(hitBox, currT);
        detectedBoxesRef.current = activeDetectedBoxes.filter((b) => b.id !== hitBox.id);
        onBackgroundTracksSync(detectedBoxTrackerRef.current?.getAllTrackRecords() ?? []);
        onFullSweepTimesSync(detectedBoxTrackerRef.current?.getFullSweepTimes() ?? []);
        onEraseDetectedBox(hitBox.id, stats);
        drawOverlay();
      }
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragState({
        kind: 'detector-erase',
        startX: x,
        startY: y,
        currX: x,
        currY: y,
        moved: false,
      });
      return;
    }

    if (detectorSubToolRef.current === 'drawer') {
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragState({
        kind: 'detector-draw',
        startX: x,
        startY: y,
        currX: x,
        currY: y,
        moved: false,
      });
      return;
    }

    // Player Box Adjust mode (or Select mode while detected boxes are visible): select, move, or corner-resize
    if (
      showDetectedBoxesRef.current &&
      detectorSubToolRef.current === null &&
      (showPlayerBoxBarRef.current || toolModeRef.current === 'select')
    ) {
      const selId = selectedDetectedBoxIdRef.current;
      const selBox = selId ? activeDetectedBoxes.find((b) => b.id === selId) ?? null : null;
      if (selBox) {
        const handleHit = hitTestDetectedBoxHandle(x, y, rect, selBox);
        if (handleHit) {
          e.currentTarget.setPointerCapture(e.pointerId);
          const nextDrag: DragState = {
            kind: 'detector-resize',
            detectedBoxId: selBox.id,
            dragBoxMeta: { source: selBox.source, confidence: selBox.confidence },
            startX: x,
            startY: y,
            currX: x,
            currY: y,
            origCx: selBox.cx,
            origCy: selBox.cy,
            origWidth: selBox.width,
            origHeight: selBox.height,
            resizeMode: handleHit,
            moved: false,
          };
          dragStateRef.current = nextDrag;
          setDragState(nextDrag);
          return;
        }
      }

      const hitDet = findHitDetectedBox(x, y, rect, activeDetectedBoxes);
      if (hitDet) {
        onSelectDetectedBox(hitDet.id);
        e.currentTarget.setPointerCapture(e.pointerId);
        const nextDrag: DragState = {
          kind: 'detector-move',
          detectedBoxId: hitDet.id,
          dragBoxMeta: { source: hitDet.source, confidence: hitDet.confidence },
          startX: x,
          startY: y,
          currX: x,
          currY: y,
          origCx: hitDet.cx,
          origCy: hitDet.cy,
          origWidth: hitDet.width,
          origHeight: hitDet.height,
          moved: false,
        };
        dragStateRef.current = nextDrag;
        setDragState(nextDrag);
        return;
      }

      if (showPlayerBoxBarRef.current) {
        onSelectDetectedBox(null);
        return;
      }
    }

    // If click-to-realign mode is active for a specific player/node, clicking or dragging anywhere relocates it
    if (realigningIdRef.current) {
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragState({
        kind: 'realign',
        playerId: realigningIdRef.current,
        nodeId: realigningNodeIdRef.current ?? undefined,
        startX: x,
        startY: y,
        currX: x,
        currY: y,
        moved: false,
      });
      return;
    }

    const currTime = videoRef.current?.currentTime ?? 0;

    // Erase tool: clicking any active overlay erases it from registered video data
    if (toolMode === 'erase') {
      const hit = findHitOverlay(x, y, rect, playersRef.current, currTime);
      if (hit) {
        hoveredEraseIdRef.current = null;
        if (hit.player.nodes) {
          for (const n of hit.player.nodes) {
            trackerRef.current?.removePlayer(n.id);
          }
        }
        trackerRef.current?.removePlayer(hit.player.id);
        onErasePlayer(hit.player.id);
      }
      return;
    }

    // Chain tool: click existing already-added 3D Rings to connect them, double-click (or click Finish) to lock chain
    if (toolMode === 'chain') {
      const now = performance.now();
      const last = lastChainClickRef.current;
      if (
        now - last.time <= 340 &&
        Math.hypot(x - last.x, y - last.y) <= 14 &&
        pendingChainRingIdsRef.current.length >= 2
      ) {
        confirmPendingChain();
        return;
      }

      const hitRing = findHitFootRing(x, y, rect, playersRef.current, currTime);
      if (hitRing) {
        lastChainClickRef.current = { time: now, x, y };
        const currentPicked = pendingChainRingIdsRef.current;
        if (currentPicked[currentPicked.length - 1] !== hitRing.id) {
          setPendingChainRingIds((prev) =>
            prev[prev.length - 1] === hitRing.id ? prev : [...prev, hitRing.id]
          );
        }
      }
      return;
    }

    // Polygon tool: click/drag on players to place vertices, click vertex 0 or double-click to close
    if (toolMode === 'polygon') {
      if (pendingPolygonRef.current.length >= 3) {
        const v0Geom = getBoxPixels(pendingPolygonRef.current[0].pos, rect);
        const v0GroundY = Math.min(rect.y + rect.h - 4, v0Geom.py + v0Geom.halfH * 0.88);
        if (Math.hypot(x - v0Geom.px, y - v0GroundY) <= 14) {
          confirmPendingPolygon();
          return;
        }
      }

      const now = performance.now();
      const last = lastPolygonClickRef.current;
      if (
        now - last.time <= 340 &&
        Math.hypot(x - last.x, y - last.y) <= 14 &&
        pendingPolygonRef.current.length >= 3
      ) {
        confirmPendingPolygon();
        return;
      }

      e.currentTarget.setPointerCapture(e.pointerId);
      setDragState({
        kind: 'polygon-vertex-draw',
        startX: x,
        startY: y,
        currX: x,
        currY: y,
        moved: false,
      });
      return;
    }

    // In Spotlight tool mode, user draws/adjusts a player rectangle first, then clicks the tick mark to convert to Spotlight
    if (toolMode === 'spotlight') {
      const pending = pendingSpotlightRef.current;
      if (pending) {
        const pHit = hitTestRectBox(x, y, pending, rect);
        if (pHit === 'inside') {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragState({
            kind: 'pending-move',
            startX: x,
            startY: y,
            currX: x,
            currY: y,
            origCx: pending.cx,
            origCy: pending.cy,
            origWidth: pending.width,
            origHeight: pending.height,
            origRadius: pending.radius,
            moved: false,
          });
          return;
        }
        if (pHit !== null) {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragState({
            kind: 'pending-resize',
            startX: x,
            startY: y,
            currX: x,
            currY: y,
            origCx: pending.cx,
            origCy: pending.cy,
            origWidth: pending.width,
            origHeight: pending.height,
            origRadius: pending.radius,
            resizeMode: pHit,
            moved: false,
          });
          return;
        }
      }

      const hit = findHitOverlay(x, y, rect, playersRef.current, currTime);
      if (hit && hit.zone !== 'node' && (hit.zone === 'edge' || e.shiftKey)) {
        onSelectPlayer(hit.player.id);
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragState({
          kind: hit.zone === 'edge' ? 'resize' : 'move',
          playerId: hit.player.id,
          startX: x,
          startY: y,
          currX: x,
          currY: y,
          origCx: hit.player.currentPosition.cx,
          origCy: hit.player.currentPosition.cy,
          origWidth: hit.player.currentPosition.width,
          origHeight: hit.player.currentPosition.height,
          origRadius: hit.player.currentPosition.radius,
          resizeMode: hit.resizeMode,
          moved: false,
        });
        return;
      }

      e.currentTarget.setPointerCapture(e.pointerId);
      setDragState({
        kind: 'spotlight-circle',
        startX: x,
        startY: y,
        currX: x,
        currY: y,
        moved: false,
      });
      return;
    }

    // In Ring tool mode, user draws/adjusts a player rectangle first, then clicks the tick mark to place the 3D foot ring
    if (toolMode === 'ring') {
      const pending = pendingRingRef.current;
      if (pending) {
        const pHit = hitTestRectBox(x, y, pending, rect);
        if (pHit === 'inside') {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragState({
            kind: 'pending-ring-move',
            startX: x,
            startY: y,
            currX: x,
            currY: y,
            origCx: pending.cx,
            origCy: pending.cy,
            origWidth: pending.width,
            origHeight: pending.height,
            origRadius: pending.radius,
            moved: false,
          });
          return;
        }
        if (pHit !== null) {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragState({
            kind: 'pending-ring-resize',
            startX: x,
            startY: y,
            currX: x,
            currY: y,
            origCx: pending.cx,
            origCy: pending.cy,
            origWidth: pending.width,
            origHeight: pending.height,
            origRadius: pending.radius,
            resizeMode: pHit,
            moved: false,
          });
          return;
        }
      }

      const hit = findHitOverlay(x, y, rect, playersRef.current, currTime);
      if (hit && hit.zone !== 'node' && (hit.zone === 'edge' || e.shiftKey)) {
        onSelectPlayer(hit.player.id);
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragState({
          kind: hit.zone === 'edge' ? 'resize' : 'move',
          playerId: hit.player.id,
          startX: x,
          startY: y,
          currX: x,
          currY: y,
          origCx: hit.player.currentPosition.cx,
          origCy: hit.player.currentPosition.cy,
          origWidth: hit.player.currentPosition.width,
          origHeight: hit.player.currentPosition.height,
          origRadius: hit.player.currentPosition.radius,
          resizeMode: hit.resizeMode,
          moved: false,
        });
        return;
      }

      e.currentTarget.setPointerCapture(e.pointerId);
      setDragState({
        kind: 'ring-circle',
        startX: x,
        startY: y,
        currX: x,
        currY: y,
        moved: false,
      });
      return;
    }

    // Check if clicking near an existing overlay's node, edge/corner (resize), or interior (select/move)
    const hit = findHitOverlay(x, y, rect, playersRef.current, currTime);

    if (
      toolMode === 'select' ||
      (hit && hit.zone === 'edge') ||
      (hit && toolMode === 'circle' && hit.zone === 'inside' && e.shiftKey)
    ) {
      if (hit) {
        onSelectPlayer(hit.player.id);
        if (hit.zone === 'node' && hit.nodeId && hit.player.nodes) {
          const targetNode = hit.player.nodes.find((n) => n.id === hit.nodeId);
          onSelectNode(hit.nodeId);
          if (targetNode) {
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragState({
              kind: 'move-node',
              playerId: hit.player.id,
              nodeId: hit.nodeId,
              startX: x,
              startY: y,
              currX: x,
              currY: y,
              origCx: targetNode.currentPosition.cx,
              origCy: targetNode.currentPosition.cy,
              origWidth: targetNode.currentPosition.width,
              origHeight: targetNode.currentPosition.height,
              origRadius: targetNode.currentPosition.radius,
              moved: false,
            });
            return;
          }
        } else if (hit.player.style === 'chain' || hit.player.style === 'polygon') {
          onSelectNode(null);
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragState({
            kind: 'move-group',
            playerId: hit.player.id,
            startX: x,
            startY: y,
            currX: x,
            currY: y,
            origGroupNodes: (hit.player.nodes ?? []).map((n) => ({
              id: n.id,
              cx: n.currentPosition.cx,
              cy: n.currentPosition.cy,
            })),
            moved: false,
          });
          return;
        }

        onSelectNode(null);
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragState({
          kind: hit.zone === 'edge' ? 'resize' : 'move',
          playerId: hit.player.id,
          startX: x,
          startY: y,
          currX: x,
          currY: y,
          origCx: hit.player.currentPosition.cx,
          origCy: hit.player.currentPosition.cy,
          origWidth: hit.player.currentPosition.width,
          origHeight: hit.player.currentPosition.height,
          origRadius: hit.player.currentPosition.radius,
          resizeMode: hit.resizeMode,
          moved: false,
        });
      } else {
        onSelectPlayer(null);
        onSelectNode(null);
      }
      return;
    }

    // In Box Tool mode, allow dragging selected box directly even while Box Tool is active
    if (hit && hit.player.id === selectedIdRef.current && hit.zone === 'inside') {
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragState({
        kind: 'move',
        playerId: hit.player.id,
        startX: x,
        startY: y,
        currX: x,
        currY: y,
        origCx: hit.player.currentPosition.cx,
        origCy: hit.player.currentPosition.cy,
        origWidth: hit.player.currentPosition.width,
        origHeight: hit.player.currentPosition.height,
        origRadius: hit.player.currentPosition.radius,
        moved: false,
      });
      return;
    }

    // Start drawing a brand new player rectangle
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragState({
      kind: 'draw',
      startX: x,
      startY: y,
      currX: x,
      currY: y,
      moved: false,
    });
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = getCanvasCoords(e);
    hoverCursorRef.current = { x, y };

    if (isSamplingPitchRef.current) {
      const rect = getVideoRenderRect();
      const video = videoRef.current;
      if (
        rect &&
        video &&
        chromaKeyEngineRef.current &&
        x >= rect.x &&
        x <= rect.x + rect.w &&
        y >= rect.y &&
        y <= rect.y + rect.h
      ) {
        const normX = clamp01((x - rect.x) / rect.w);
        const normY = clamp01((y - rect.y) / rect.h);
        const sampled = chromaKeyEngineRef.current.samplePitchColorAt(
          video,
          normX,
          normY,
          chromaFrameEpochRef.current
        );
        sampleHoverRef.current = sampled ? { x, y, hex: sampled.hex } : null;
      } else {
        sampleHoverRef.current = null;
      }
      drawOverlay();
      return;
    }

    if (!dragState) {
      const rect = getVideoRenderRect();
      const currTime = videoRef.current?.currentTime ?? 0;

      if (detectorSubToolRef.current === 'eraser' && showDetectedBoxesRef.current) {
        if (canvasRef.current && canvasRef.current.style.cursor) {
          canvasRef.current.style.cursor = '';
        }
        const activeBoxes = getActiveDetectedBoxes(currTime);
        const hitBox = rect ? findHitDetectedBox(x, y, rect, activeBoxes) : null;
        const nextHover = hitBox?.id ?? null;
        if (hoveredDetectorEraseIdRef.current !== nextHover) {
          hoveredDetectorEraseIdRef.current = nextHover;
          drawOverlay();
        }
        return;
      }

      if (
        showDetectedBoxesRef.current &&
        detectorSubToolRef.current === null &&
        (showPlayerBoxBarRef.current || toolModeRef.current === 'select')
      ) {
        const activeBoxes = getActiveDetectedBoxes(currTime);
        const selId = selectedDetectedBoxIdRef.current;
        const selBox = selId ? activeBoxes.find((b) => b.id === selId) ?? null : null;
        const handleHit = rect && selBox ? hitTestDetectedBoxHandle(x, y, rect, selBox) : null;
        let nextCursor = '';
        if (handleHit) {
          nextCursor = resizeCursorForMode(handleHit);
        } else if (rect && findHitDetectedBox(x, y, rect, activeBoxes)) {
          nextCursor = 'move';
        }
        if (canvasRef.current && canvasRef.current.style.cursor !== nextCursor) {
          canvasRef.current.style.cursor = nextCursor;
        }
        if (showPlayerBoxBarRef.current) {
          return;
        }
      } else if (canvasRef.current && canvasRef.current.style.cursor) {
        canvasRef.current.style.cursor = '';
      }

      if (toolModeRef.current === 'erase') {
        const hit = rect ? findHitOverlay(x, y, rect, playersRef.current, currTime) : null;
        const nextHoverId = hit?.player.id ?? null;
        if (hoveredEraseIdRef.current !== nextHoverId) {
          hoveredEraseIdRef.current = nextHoverId;
          drawOverlay();
        }
        return;
      }

      if (toolModeRef.current === 'chain' && !detectorSubToolRef.current && !realigningIdRef.current) {
        const hitRing = rect ? findHitFootRing(x, y, rect, playersRef.current, currTime) : null;
        hoveredChainRingIdRef.current = hitRing?.id ?? null;
        hoveredSnapTrackRef.current = null;
        drawOverlay();
        return;
      }

      if (hoveredChainRingIdRef.current) {
        hoveredChainRingIdRef.current = null;
      }

      if (
        !detectorSubToolRef.current &&
        !realigningIdRef.current &&
        (toolModeRef.current === 'circle' ||
          toolModeRef.current === 'spotlight' ||
          toolModeRef.current === 'ring' ||
          toolModeRef.current === 'polygon')
      ) {
        const prevSnapId = hoveredSnapTrackRef.current?.track.id ?? null;
        const nextSnap =
          rect && !pendingSpotlightRef.current && !pendingRingRef.current
            ? findNearestImplementedTrack(x, y, rect, implementedTracksRef.current, currTime)
            : null;
        hoveredSnapTrackRef.current = nextSnap;
        const nextSnapId = nextSnap?.track.id ?? null;
        if (
          prevSnapId !== nextSnapId ||
          toolModeRef.current === 'polygon' ||
          implementedTracksRef.current.length > 0
        ) {
          drawOverlay();
        }
        return;
      }

      if (hoveredSnapTrackRef.current) {
        hoveredSnapTrackRef.current = null;
        drawOverlay();
      } else if (showCoverageOverlayRef.current && detectorSubToolRef.current === 'drawer') {
        drawOverlay();
      }
      return;
    }
    const rect = getVideoRenderRect();
    if (!rect) return;

    if (dragState.kind === 'detector-erase') {
      const currT = videoRef.current?.currentTime ?? 0;
      const activeBoxes = getActiveDetectedBoxes(currT);
      const hitBox = findHitDetectedBox(x, y, rect, activeBoxes);
      if (hitBox) {
        slowTrackUserEditedRef.current = true;
        hoveredDetectorEraseIdRef.current = null;
        const video = videoRef.current;
        const detector = playerDetectorRef.current;
        const stats =
          video && detector
            ? detector.trainNegative(video, hitBox, chromaKeyRef.current, currT)
            : detector?.getStats() ?? { positiveCount: 0, negativeCount: 0, isTrained: false };
        detectedBoxTrackerRef.current?.handleUserEraseBox(hitBox, currT);
        detectedBoxesRef.current = activeBoxes.filter((b) => b.id !== hitBox.id);
        onBackgroundTracksSync(detectedBoxTrackerRef.current?.getAllTrackRecords() ?? []);
        onFullSweepTimesSync(detectedBoxTrackerRef.current?.getFullSweepTimes() ?? []);
        onEraseDetectedBox(hitBox.id, stats);
        drawOverlay();
      }
      return;
    }

    if (dragState.kind === 'detector-move' || dragState.kind === 'detector-resize') {
      const movedDet = dragState.moved || Math.hypot(x - dragState.startX, y - dragState.startY) >= 3;
      const nextDrag: DragState = { ...dragState, currX: x, currY: y, moved: movedDet };
      dragStateRef.current = nextDrag;
      setDragState(nextDrag);
      drawOverlay();
      return;
    }

    const moved = dragState.moved || Math.hypot(x - dragState.startX, y - dragState.startY) >= 5;

    if (
      dragState.kind === 'draw' ||
      dragState.kind === 'detector-draw' ||
      dragState.kind === 'spotlight-circle' ||
      dragState.kind === 'ring-circle' ||
      dragState.kind === 'polygon-vertex-draw' ||
      dragState.kind === 'realign'
    ) {
      setDragState({ ...dragState, currX: x, currY: y, moved });
      return;
    }

    const video = videoRef.current;
    const currTime = video ? video.currentTime : 0;

    if (dragState.kind === 'pending-move') {
      const dxNorm = (x - dragState.startX) / rect.w;
      const dyNorm = (y - dragState.startY) / rect.h;
      setPendingSpotlight({
        cx: clamp01((dragState.origCx ?? 0.5) + dxNorm),
        cy: clamp01((dragState.origCy ?? 0.5) + dyNorm),
        width: dragState.origWidth ?? 0.032,
        height: dragState.origHeight ?? 0.095,
        radius: dragState.origRadius ?? 0.032,
        time: currTime,
      });
      setDragState({ ...dragState, currX: x, currY: y, moved });
      return;
    }

    if (dragState.kind === 'pending-resize') {
      const resized = resizeRectByHandle(
        x,
        y,
        rect,
        dragState.origCx ?? 0.5,
        dragState.origCy ?? 0.5,
        dragState.origWidth ?? 0.032,
        dragState.origHeight ?? 0.095,
        dragState.resizeMode ?? 'se',
        currTime
      );
      setPendingSpotlight(resized);
      setDragState({ ...dragState, currX: x, currY: y, moved });
      return;
    }

    if (dragState.kind === 'pending-ring-move') {
      const dxNorm = (x - dragState.startX) / rect.w;
      const dyNorm = (y - dragState.startY) / rect.h;
      setPendingRing({
        cx: clamp01((dragState.origCx ?? 0.5) + dxNorm),
        cy: clamp01((dragState.origCy ?? 0.5) + dyNorm),
        width: dragState.origWidth ?? 0.032,
        height: dragState.origHeight ?? 0.095,
        radius: dragState.origRadius ?? 0.032,
        time: currTime,
      });
      setDragState({ ...dragState, currX: x, currY: y, moved });
      return;
    }

    if (dragState.kind === 'pending-ring-resize') {
      const resized = resizeRectByHandle(
        x,
        y,
        rect,
        dragState.origCx ?? 0.5,
        dragState.origCy ?? 0.5,
        dragState.origWidth ?? 0.032,
        dragState.origHeight ?? 0.095,
        dragState.resizeMode ?? 'se',
        currTime
      );
      setPendingRing(resized);
      setDragState({ ...dragState, currX: x, currY: y, moved });
      return;
    }

    if (moved && !undoPushedForDragRef.current) {
      undoPushedForDragRef.current = true;
      onPushUndoSnapshot();
    }

    if (dragState.kind === 'move-node' && dragState.playerId && dragState.nodeId) {
      const dxNorm = (x - dragState.startX) / rect.w;
      const dyNorm = (y - dragState.startY) / rect.h;
      const nextPos: CirclePosition = {
        cx: clamp01((dragState.origCx ?? 0.5) + dxNorm),
        cy: clamp01((dragState.origCy ?? 0.5) + dyNorm),
        width: dragState.origWidth ?? 0.032,
        height: dragState.origHeight ?? 0.095,
        radius: dragState.origRadius ?? 0.032,
        confidence: 1,
        status: 'anchored',
        time: currTime,
      };
      onUpdateNodeAnchor(dragState.playerId, dragState.nodeId, nextPos);
      setDragState({ ...dragState, currX: x, currY: y, moved });
      return;
    }

    if (dragState.kind === 'move-group' && dragState.playerId && dragState.origGroupNodes) {
      const dxNorm = (x - dragState.startX) / rect.w;
      const dyNorm = (y - dragState.startY) / rect.h;
      onShiftGroupAnchor(dragState.playerId, dragState.origGroupNodes, dxNorm, dyNorm, currTime);
      setDragState({ ...dragState, currX: x, currY: y, moved });
      return;
    }

    if (dragState.kind === 'move' && dragState.playerId) {
      const dxNorm = (x - dragState.startX) / rect.w;
      const dyNorm = (y - dragState.startY) / rect.h;
      const nextCx = clamp01((dragState.origCx ?? 0.5) + dxNorm);
      const nextCy = clamp01((dragState.origCy ?? 0.5) + dyNorm);
      const nextPos: CirclePosition = {
        cx: nextCx,
        cy: nextCy,
        width: dragState.origWidth ?? 0.032,
        height: dragState.origHeight ?? 0.095,
        radius: dragState.origRadius ?? 0.032,
        confidence: 1,
        status: 'anchored',
        time: currTime,
      };
      onUpdatePlayerAnchor(dragState.playerId, nextPos);
      setDragState({ ...dragState, currX: x, currY: y, moved });
      return;
    }

    if (dragState.kind === 'resize' && dragState.playerId) {
      const targetPlayer = playersRef.current.find((p) => p.id === dragState.playerId);
      const centerPx = rect.x + (dragState.origCx ?? 0.5) * rect.w;
      const bodyPy = rect.y + (dragState.origCy ?? 0.5) * rect.h;
      const origHalfH = Math.max(10, ((dragState.origHeight ?? 0.095) * rect.h) * 0.5);

      if (targetPlayer?.style === 'spotlight') {
        // Resize visual spotlight beam width only; keep underlying CV sampling rectangle intact
        const groundY = Math.min(rect.y + rect.h - 4, bodyPy + origHalfH * 0.88);
        const rot = targetPlayer.spotlight?.rotation ?? 0.9;
        const dyScaled = (y - groundY) / Math.max(0.2, rot);
        const newBeamRadiusPx = Math.max(15, Math.min(75, Math.hypot(x - centerPx, dyScaled)));
        const nextPos: CirclePosition = {
          cx: dragState.origCx ?? 0.5,
          cy: dragState.origCy ?? 0.5,
          width: dragState.origWidth ?? 0.032,
          height: dragState.origHeight ?? 0.095,
          radius: dragState.origRadius ?? 0.032,
          confidence: 1,
          status: 'anchored',
          time: currTime,
        };
        onUpdatePlayerAnchor(dragState.playerId, nextPos, Math.round(newBeamRadiusPx * 2));
      } else if (targetPlayer?.style === 'foot-ring') {
        // Resize visual 3D foot ring diameter only; keep underlying CV sampling rectangle intact
        const groundY = Math.min(rect.y + rect.h - 4, bodyPy + origHalfH * 0.88);
        const scaleY = Math.max(
          0.22,
          Math.cos(((targetPlayer.ring?.tiltDeg ?? 58) * Math.PI) / 180)
        );
        const dyScaled = (y - groundY) / scaleY;
        const newRingRadiusPx = Math.max(
          MIN_RING_SIZE / 2,
          Math.min(MAX_RING_SIZE / 2, Math.hypot(x - centerPx, dyScaled))
        );
        const nextPos: CirclePosition = {
          cx: dragState.origCx ?? 0.5,
          cy: dragState.origCy ?? 0.5,
          width: dragState.origWidth ?? 0.032,
          height: dragState.origHeight ?? 0.095,
          radius: dragState.origRadius ?? 0.032,
          confidence: 1,
          status: 'anchored',
          time: currTime,
        };
        onUpdatePlayerAnchor(dragState.playerId, nextPos, Math.round(newRingRadiusPx * 2));
      } else {
        const nextPos = resizeRectByHandle(
          x,
          y,
          rect,
          dragState.origCx ?? 0.5,
          dragState.origCy ?? 0.5,
          dragState.origWidth ?? 0.032,
          dragState.origHeight ?? 0.095,
          dragState.resizeMode ?? 'se',
          currTime
        );
        onUpdatePlayerAnchor(dragState.playerId, nextPos);
      }
      setDragState({ ...dragState, currX: x, currY: y, moved });
    }
  };

  const handlePointerLeave = () => {
    let needsRedraw = false;
    if (hoverCursorRef.current) {
      hoverCursorRef.current = null;
      if (toolModeRef.current === 'chain' || toolModeRef.current === 'polygon') {
        needsRedraw = true;
      }
    }
    if (sampleHoverRef.current) {
      sampleHoverRef.current = null;
      needsRedraw = true;
    }
    if (hoveredEraseIdRef.current) {
      hoveredEraseIdRef.current = null;
      needsRedraw = true;
    }
    if (hoveredDetectorEraseIdRef.current) {
      hoveredDetectorEraseIdRef.current = null;
      needsRedraw = true;
    }
    if (hoveredSnapTrackRef.current) {
      hoveredSnapTrackRef.current = null;
      needsRedraw = true;
    }
    if (hoveredChainRingIdRef.current) {
      hoveredChainRingIdRef.current = null;
      needsRedraw = true;
    }
    if (canvasRef.current && canvasRef.current.style.cursor) {
      canvasRef.current.style.cursor = '';
    }
    if (needsRedraw) {
      drawOverlay();
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragState) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }

    const rect = getVideoRenderRect();
    const video = videoRef.current;
    const tracker = trackerRef.current;
    const { x, y } = getCanvasCoords(e);

    if (
      (dragState.kind === 'detector-move' || dragState.kind === 'detector-resize') &&
      dragState.detectedBoxId &&
      rect &&
      video
    ) {
      if (dragState.moved) {
        const finalDrag: DragState = { ...dragState, currX: x, currY: y };
        const nextGeom = computeDraggedDetectedBoxFromDrag(finalDrag, rect);
        const correctedBox: DetectedPlayerBox = {
          id: dragState.detectedBoxId,
          cx: nextGeom.cx,
          cy: nextGeom.cy,
          width: nextGeom.width,
          height: nextGeom.height,
          confidence: 1,
          source: dragState.dragBoxMeta?.source ?? 'auto',
          time: video.currentTime,
          isKeyframe: true,
        };
        slowTrackUserEditedRef.current = true;
        dragStateRef.current = null;
        detectedBoxTrackerRef.current?.handleUserCorrectBox(
          correctedBox,
          video,
          chromaKeyRef.current
        );
        const synced = getActiveDetectedBoxes(video.currentTime);
        const hasCorrected = synced.some((b) => b.id === correctedBox.id);
        const nextBoxes = hasCorrected
          ? synced
          : detectedBoxesRef.current.map((b) => (b.id === correctedBox.id ? correctedBox : b));
        detectedBoxesRef.current = nextBoxes;
        onDetectedBoxesSync(nextBoxes);
        onBackgroundTracksSync(detectedBoxTrackerRef.current?.getAllTrackRecords() ?? []);
        onFullSweepTimesSync(detectedBoxTrackerRef.current?.getFullSweepTimes() ?? []);
        drawOverlay();
      }
    } else if (dragState.kind === 'detector-draw' && rect && video) {
      const dist = Math.hypot(x - dragState.startX, y - dragState.startY);
      const clickedGhost =
        dist < 5 && showCoverageOverlayRef.current
          ? untrackedGhostCacheRef.current.boxes.find((gb) => {
              const gx = rect.x + gb.cx * rect.w;
              const gy = rect.y + gb.cy * rect.h;
              const hw = Math.max(8, (gb.width * rect.w) * 0.5) + 6;
              const hh = Math.max(12, (gb.height * rect.h) * 0.5) + 6;
              return (
                dragState.startX >= gx - hw &&
                dragState.startX <= gx + hw &&
                dragState.startY >= gy - hh &&
                dragState.startY <= gy + hh
              );
            }) ?? null
          : null;
      const rawBox =
        dist >= 5
          ? {
              cx: clamp01(((Math.min(dragState.startX, x) + Math.max(dragState.startX, x)) * 0.5 - rect.x) / rect.w),
              cy: clamp01(((Math.min(dragState.startY, y) + Math.max(dragState.startY, y)) * 0.5 - rect.y) / rect.h),
              width: Math.max(8, Math.min(rect.w * 0.45, Math.abs(x - dragState.startX))) / rect.w,
              height: Math.max(12, Math.min(rect.h * 0.7, Math.abs(y - dragState.startY))) / rect.h,
            }
          : clickedGhost
            ? {
                cx: clickedGhost.cx,
                cy: clickedGhost.cy,
                width: clickedGhost.width,
                height: clickedGhost.height,
              }
            : {
                cx: clamp01((dragState.startX - rect.x) / rect.w),
                cy: clamp01((dragState.startY - rect.y) / rect.h),
                width: Math.max(14, rect.w * 0.022) / rect.w,
                height: Math.max(28, rect.h * 0.068) / rect.h,
              };

      const detector = playerDetectorRef.current;
      const trained = detector
        ? detector.trainPositive(video, rawBox, chromaKeyRef.current)
        : {
            tightened: rawBox,
            stats: { positiveCount: 0, negativeCount: 0, isTrained: false },
          };
      const newBox: DetectedPlayerBox = {
        id: `det_manual_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        cx: trained.tightened.cx,
        cy: trained.tightened.cy,
        width: trained.tightened.width,
        height: trained.tightened.height,
        confidence: 1,
        source: 'manual',
        time: video.currentTime,
      };
      slowTrackUserEditedRef.current = true;
      detectedBoxTrackerRef.current?.handleUserAddBox(newBox, video, chromaKeyRef.current);
      detectedBoxesRef.current = [...detectedBoxesRef.current, newBox];
      onBackgroundTracksSync(detectedBoxTrackerRef.current?.getAllTrackRecords() ?? []);
      onFullSweepTimesSync(detectedBoxTrackerRef.current?.getFullSweepTimes() ?? []);
      onAddDetectedBoxManual(newBox, trained.stats);
      drawOverlay();
    } else if (dragState.kind === 'spotlight-circle' && rect && video) {
      const dist = Math.hypot(x - dragState.startX, y - dragState.startY);
      const snap =
        dist < 6
          ? findNearestImplementedTrack(
              dragState.startX,
              dragState.startY,
              rect,
              implementedTracksRef.current,
              video.currentTime
            )
          : null;
      if (snap) {
        hoveredSnapTrackRef.current = null;
        onAttachToolToTrack(snap.track.id, 'spotlight');
      } else {
        const box = boxFromDragPoints(dragState.startX, dragState.startY, x, y, rect, video.currentTime);
        setPendingSpotlight(box);
      }
    } else if (dragState.kind === 'ring-circle' && rect && video) {
      const dist = Math.hypot(x - dragState.startX, y - dragState.startY);
      const snap =
        dist < 6
          ? findNearestImplementedTrack(
              dragState.startX,
              dragState.startY,
              rect,
              implementedTracksRef.current,
              video.currentTime
            )
          : null;
      if (snap) {
        hoveredSnapTrackRef.current = null;
        onAttachToolToTrack(snap.track.id, 'foot-ring');
      } else {
        const box = boxFromDragPoints(dragState.startX, dragState.startY, x, y, rect, video.currentTime);
        setPendingRing(box);
      }
    } else if (dragState.kind === 'polygon-vertex-draw' && rect && video) {
      const dist = Math.hypot(x - dragState.startX, y - dragState.startY);
      let box: CirclePosition;
      let attachedTrackId: string | undefined;
      let history: CirclePosition[] | undefined;

      if (dist >= 6) {
        box = boxFromDragPoints(dragState.startX, dragState.startY, x, y, rect, video.currentTime);
      } else {
        // Snap onto an existing player/node CV box, detected box, or implemented tracked player
        const existingHit = findHitOverlay(x, y, rect, playersRef.current, video.currentTime);
        const detBoxesAtTime =
          showDetectedBoxesRef.current && detectedBoxTrackerRef.current?.hasHistories()
            ? detectedBoxTrackerRef.current.getBoxesAtTime(
                detectedBoxesRef.current,
                video.currentTime
              ) ?? detectedBoxesRef.current
            : detectedBoxesRef.current;
        const detHit = showDetectedBoxesRef.current
          ? findHitDetectedBox(x, y, rect, detBoxesAtTime)
          : null;
        const implSnap = findNearestImplementedTrack(
          dragState.startX,
          dragState.startY,
          rect,
          implementedTracksRef.current,
          video.currentTime
        );

        if (existingHit?.zone === 'node' && existingHit.nodeId && existingHit.player.nodes) {
          const matchedNode = existingHit.player.nodes.find((n) => n.id === existingHit.nodeId);
          box = matchedNode
            ? { ...matchedNode.currentPosition, confidence: 1, status: 'anchored', time: video.currentTime }
            : createFootAlignedBox(dragState.startX, dragState.startY, rect, video.currentTime);
          if (matchedNode?.attachedTrackId && matchedNode.history.length > 0) {
            attachedTrackId = matchedNode.attachedTrackId;
            history = matchedNode.history.slice();
          }
        } else if (
          existingHit &&
          existingHit.player.style !== 'chain' &&
          existingHit.player.style !== 'polygon'
        ) {
          box = {
            ...existingHit.player.currentPosition,
            confidence: 1,
            status: 'anchored',
            time: video.currentTime,
          };
          if (existingHit.player.attachedTrackId && existingHit.player.history.length > 0) {
            attachedTrackId = existingHit.player.attachedTrackId;
            history = existingHit.player.history.slice();
          }
        } else if (detHit) {
          box = {
            cx: detHit.cx,
            cy: detHit.cy,
            width: detHit.width,
            height: detHit.height,
            radius: Math.max(detHit.width, detHit.height) * 0.5,
            confidence: 1,
            status: 'anchored',
            time: video.currentTime,
          };
        } else if (implSnap) {
          box = {
            ...implSnap.pos,
            confidence: 1,
            status: 'anchored',
            time: video.currentTime,
          };
          attachedTrackId = implSnap.track.id;
          history = implSnap.track.positions.slice();
        } else {
          box = createFootAlignedBox(dragState.startX, dragState.startY, rect, video.currentTime);
        }
      }

      const newNode: PendingGroupNode = {
        tempId: `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        pos: box,
        attachedTrackId,
        history,
      };
      lastPolygonClickRef.current = {
        time: performance.now(),
        x: dragState.startX,
        y: dragState.startY,
      };
      setPendingPolygonNodes((prev) => [...prev, newNode]);
    } else if (dragState.kind === 'draw' && rect && video) {
      const dist = Math.hypot(x - dragState.startX, y - dragState.startY);
      const snap =
        dist < 6
          ? findNearestImplementedTrack(
              dragState.startX,
              dragState.startY,
              rect,
              implementedTracksRef.current,
              video.currentTime
            )
          : null;
      if (snap) {
        hoveredSnapTrackRef.current = null;
        onAttachToolToTrack(snap.track.id, 'ring');
      } else {
        const anchorPos = boxFromDragPoints(dragState.startX, dragState.startY, x, y, rect, video.currentTime);

        onPushUndoSnapshot();
        const newId = onAddPlayerCircle(anchorPos);
        onSelectPlayer(newId);

        // Immediately extract rectangular CV template from the paused frame!
        if (tracker) {
          const frame = tracker.captureFrame(video);
          if (frame) {
            tracker.anchorPlayer(newId, frame, anchorPos, settingsRef.current.turfMasking);
            tracker.setPrevFrame(frame);
            lastProcessedTimeRef.current = video.currentTime;
            needsTrackerReseedRef.current = false;
          }
        }
      }
    } else if (dragState.kind === 'realign' && dragState.playerId && rect && video) {
      const target = playersRef.current.find((p) => p.id === dragState.playerId);
      if ((target?.style === 'chain' || target?.style === 'polygon') && target.nodes && target.nodes.length > 0) {
        let targetNode = dragState.nodeId
          ? target.nodes.find((n) => n.id === dragState.nodeId)
          : selectedNodeIdRef.current
            ? target.nodes.find((n) => n.id === selectedNodeIdRef.current)
            : undefined;
        if (!targetNode) {
          let bestDist = Infinity;
          for (const n of target.nodes) {
            const g = getBoxPixels(n.currentPosition, rect);
            const gY = Math.min(rect.y + rect.h - 4, g.py + g.halfH * 0.88);
            const d = Math.hypot(dragState.startX - g.px, dragState.startY - gY);
            if (d < bestDist) {
              bestDist = d;
              targetNode = n;
            }
          }
        }
        if (targetNode) {
          const realignedPos =
            Math.hypot(x - dragState.startX, y - dragState.startY) >= 6
              ? boxFromDragPoints(dragState.startX, dragState.startY, x, y, rect, video.currentTime, {
                  width: targetNode.currentPosition.width,
                  height: targetNode.currentPosition.height,
                })
              : createFootAlignedBox(dragState.startX, dragState.startY, rect, video.currentTime);

          onPushUndoSnapshot();
          onUpdateNodeAnchor(target.id, targetNode.id, realignedPos);
          onSelectPlayer(target.id);
          onSelectNode(targetNode.id);
          onCompleteRealign();

          if (tracker && target.trackWithCv !== false && targetNode.trackWithCv) {
            const frame = tracker.captureFrame(video);
            if (frame) {
              tracker.anchorPlayer(
                targetNode.id,
                frame,
                realignedPos,
                settingsRef.current.turfMasking
              );
              tracker.setPrevFrame(frame);
              lastProcessedTimeRef.current = video.currentTime;
              needsTrackerReseedRef.current = false;
            }
          }
        }
      } else {
        const realignedPos = boxFromDragPoints(
          dragState.startX,
          dragState.startY,
          x,
          y,
          rect,
          video.currentTime,
          target
            ? {
                width: target.currentPosition.width,
                height: target.currentPosition.height,
              }
            : undefined
        );

        onPushUndoSnapshot();
        onUpdatePlayerAnchor(dragState.playerId, realignedPos);
        onSelectPlayer(dragState.playerId);
        onCompleteRealign();

        if (tracker && target?.trackWithCv !== false) {
          const frame = tracker.captureFrame(video);
          if (frame) {
            tracker.anchorPlayer(
              dragState.playerId,
              frame,
              realignedPos,
              settingsRef.current.turfMasking
            );
            tracker.setPrevFrame(frame);
            lastProcessedTimeRef.current = video.currentTime;
            needsTrackerReseedRef.current = false;
          }
        }
      }
    } else if (dragState.kind === 'move-node' && dragState.playerId && dragState.nodeId && rect && video) {
      const targetPlayer = playersRef.current.find((p) => p.id === dragState.playerId);
      const targetNode = targetPlayer?.nodes?.find((n) => n.id === dragState.nodeId);
      if (dragState.moved) {
        const dxNorm = (x - dragState.startX) / rect.w;
        const dyNorm = (y - dragState.startY) / rect.h;
        const finalPos: CirclePosition = {
          cx: clamp01((dragState.origCx ?? 0.5) + dxNorm),
          cy: clamp01((dragState.origCy ?? 0.5) + dyNorm),
          width: dragState.origWidth ?? 0.032,
          height: dragState.origHeight ?? 0.095,
          radius: dragState.origRadius ?? 0.032,
          confidence: 1,
          status: 'anchored',
          time: video.currentTime,
        };
        onUpdateNodeAnchor(dragState.playerId, dragState.nodeId, finalPos);
        if (tracker && targetPlayer?.trackWithCv !== false && targetNode?.trackWithCv) {
          const frame = tracker.captureFrame(video);
          if (frame) {
            tracker.anchorPlayer(dragState.nodeId, frame, finalPos, settingsRef.current.turfMasking);
            tracker.setPrevFrame(frame);
            lastProcessedTimeRef.current = video.currentTime;
            needsTrackerReseedRef.current = false;
          }
        }
      }
    } else if (
      dragState.kind === 'move-group' &&
      dragState.playerId &&
      dragState.origGroupNodes &&
      rect &&
      video
    ) {
      const targetPlayer = playersRef.current.find((p) => p.id === dragState.playerId);
      if (dragState.moved && targetPlayer?.nodes) {
        const dxNorm = (x - dragState.startX) / rect.w;
        const dyNorm = (y - dragState.startY) / rect.h;
        onShiftGroupAnchor(
          dragState.playerId,
          dragState.origGroupNodes,
          dxNorm,
          dyNorm,
          video.currentTime
        );
        if (tracker && targetPlayer.trackWithCv !== false) {
          const frame = tracker.captureFrame(video);
          if (frame) {
            for (const baseNode of dragState.origGroupNodes) {
              const currNode = targetPlayer.nodes.find((n) => n.id === baseNode.id);
              if (!currNode || !currNode.trackWithCv) continue;
              const shiftedPos: CirclePosition = {
                ...currNode.currentPosition,
                cx: clamp01(baseNode.cx + dxNorm),
                cy: clamp01(baseNode.cy + dyNorm),
                confidence: 1,
                status: 'anchored',
                time: video.currentTime,
              };
              tracker.anchorPlayer(currNode.id, frame, shiftedPos, settingsRef.current.turfMasking);
            }
            tracker.setPrevFrame(frame);
            lastProcessedTimeRef.current = video.currentTime;
            needsTrackerReseedRef.current = false;
          }
        }
      }
    } else if ((dragState.kind === 'move' || dragState.kind === 'resize') && dragState.playerId && rect && video) {
      const targetPlayer = playersRef.current.find((p) => p.id === dragState.playerId);
      if (dragState.moved) {
        let finalPos: CirclePosition;
        let extraSizePx: number | undefined;
        if (dragState.kind === 'move') {
          const dxNorm = (x - dragState.startX) / rect.w;
          const dyNorm = (y - dragState.startY) / rect.h;
          finalPos = {
            cx: clamp01((dragState.origCx ?? 0.5) + dxNorm),
            cy: clamp01((dragState.origCy ?? 0.5) + dyNorm),
            width: dragState.origWidth ?? 0.032,
            height: dragState.origHeight ?? 0.095,
            radius: dragState.origRadius ?? 0.032,
            confidence: 1,
            status: 'anchored',
            time: video.currentTime,
          };
        } else if (targetPlayer?.style === 'spotlight') {
          const centerPx = rect.x + (dragState.origCx ?? 0.5) * rect.w;
          const bodyPy = rect.y + (dragState.origCy ?? 0.5) * rect.h;
          const origHalfH = Math.max(10, ((dragState.origHeight ?? 0.095) * rect.h) * 0.5);
          const groundY = Math.min(rect.y + rect.h - 4, bodyPy + origHalfH * 0.88);
          const rot = targetPlayer.spotlight?.rotation ?? 0.9;
          const dyScaled = (y - groundY) / Math.max(0.2, rot);
          const newBeamRadiusPx = Math.max(15, Math.min(75, Math.hypot(x - centerPx, dyScaled)));
          extraSizePx = Math.round(newBeamRadiusPx * 2);
          finalPos = {
            cx: dragState.origCx ?? 0.5,
            cy: dragState.origCy ?? 0.5,
            width: dragState.origWidth ?? 0.032,
            height: dragState.origHeight ?? 0.095,
            radius: dragState.origRadius ?? 0.032,
            confidence: 1,
            status: 'anchored',
            time: video.currentTime,
          };
        } else if (targetPlayer?.style === 'foot-ring') {
          const centerPx = rect.x + (dragState.origCx ?? 0.5) * rect.w;
          const bodyPy = rect.y + (dragState.origCy ?? 0.5) * rect.h;
          const origHalfH = Math.max(10, ((dragState.origHeight ?? 0.095) * rect.h) * 0.5);
          const groundY = Math.min(rect.y + rect.h - 4, bodyPy + origHalfH * 0.88);
          const scaleY = Math.max(
            0.22,
            Math.cos(((targetPlayer.ring?.tiltDeg ?? 58) * Math.PI) / 180)
          );
          const dyScaled = (y - groundY) / scaleY;
          const newRingRadiusPx = Math.max(
            MIN_RING_SIZE / 2,
            Math.min(MAX_RING_SIZE / 2, Math.hypot(x - centerPx, dyScaled))
          );
          extraSizePx = Math.round(newRingRadiusPx * 2);
          finalPos = {
            cx: dragState.origCx ?? 0.5,
            cy: dragState.origCy ?? 0.5,
            width: dragState.origWidth ?? 0.032,
            height: dragState.origHeight ?? 0.095,
            radius: dragState.origRadius ?? 0.032,
            confidence: 1,
            status: 'anchored',
            time: video.currentTime,
          };
        } else {
          finalPos = resizeRectByHandle(
            x,
            y,
            rect,
            dragState.origCx ?? 0.5,
            dragState.origCy ?? 0.5,
            dragState.origWidth ?? 0.032,
            dragState.origHeight ?? 0.095,
            dragState.resizeMode ?? 'se',
            video.currentTime
          );
        }

        onUpdatePlayerAnchor(dragState.playerId, finalPos, extraSizePx);
        if (
          tracker &&
          targetPlayer?.trackWithCv !== false &&
          (dragState.kind === 'move' ||
            (targetPlayer?.style !== 'spotlight' && targetPlayer?.style !== 'foot-ring'))
        ) {
          const frame = tracker.captureFrame(video);
          if (frame) {
            tracker.anchorPlayer(
              dragState.playerId,
              frame,
              finalPos,
              settingsRef.current.turfMasking
            );
            tracker.setPrevFrame(frame);
            lastProcessedTimeRef.current = video.currentTime;
            needsTrackerReseedRef.current = false;
          }
        }
      }
    }

    undoPushedForDragRef.current = false;
    setDragState(null);
  };

  return (
    <div
      ref={containerRef}
      className="relative flex-1 min-h-[180px] bg-[#070A0E] overflow-hidden flex items-center justify-center select-none"
    >
      {videoUrl ? (
        <>
          <video
            ref={(el) => {
              videoRef.current = el;
              videoRefExternal.current = el;
            }}
            src={videoUrl}
            playsInline
            preload="auto"
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              if (v.duration === Infinity) {
                resolvingDurationRef.current = true;
                v.currentTime = 1e10;
              } else {
                onVideoMetadata(v.duration, v.videoWidth, v.videoHeight);
                const rect = getVideoRenderRect();
                if (rect) onRenderRectWidthChange?.(rect.w);
                chromaFrameEpochRef.current += 1;
                drawOverlay();
              }
            }}
            onDurationChange={(e) => {
              const v = e.currentTarget;
              if (Number.isFinite(v.duration) && v.duration > 0) {
                onVideoMetadata(v.duration, v.videoWidth, v.videoHeight);
              }
            }}
              onTimeUpdate={(e) => {
                const v = e.currentTarget;
                if (resolvingDurationRef.current) {
                  resolvingDurationRef.current = false;
                  if (Number.isFinite(v.duration) && v.duration > 0) {
                    onVideoMetadata(v.duration, v.videoWidth, v.videoHeight);
                  }
                  v.currentTime = 0;
                  return;
                }
                onTimeUpdate(v.currentTime);
                if (!isPlaying && !isSlowTrackingDetectedRef.current) {
                  // If user stepped/scrubbed while paused, look up historical position without mutating history
                  needsTrackerReseedRef.current = true;
                  lastProcessedTimeRef.current = v.currentTime;
                  chromaFrameEpochRef.current += 1;
                  if (
                    showDetectedBoxesRef.current &&
                    detectedBoxTrackerRef.current?.hasHistories()
                  ) {
                    const replayedDet = detectedBoxTrackerRef.current.getBoxesAtTime(
                      detectedBoxesRef.current,
                      v.currentTime
                    );
                    if (replayedDet && !areDetectedBoxListsClose(detectedBoxesRef.current, replayedDet)) {
                      detectedBoxesRef.current = replayedDet;
                      onDetectedBoxesSync(replayedDet);
                    }
                  }
                  const activePlayers = playersRef.current.filter((p) => p.trackWithCv !== false);
                  const updates = new Map<string, CirclePosition>();
                  for (const p of activePlayers) {
                    if ((p.style === 'chain' || p.style === 'polygon') && p.nodes) {
                      for (const node of p.nodes) {
                        if (!node.trackWithCv) continue;
                        if (node.stopTime !== undefined && v.currentTime > node.stopTime + 0.04) {
                          const lastPt = node.history[node.history.length - 1] ?? node.anchorPosition;
                          updates.set(node.id, { ...lastPt, status: 'stopped', time: node.stopTime });
                          continue;
                        }
                        const exactKf = findClosestHistoryPoint(node.keyframes, v.currentTime);
                        if (exactKf && Math.abs(exactKf.time - v.currentTime) < 0.04) {
                          updates.set(node.id, { ...exactKf, time: v.currentTime });
                        } else if (v.currentTime < node.anchorTime - 0.04) {
                          updates.set(node.id, { ...node.anchorPosition, time: v.currentTime });
                        } else {
                          const interp =
                            node.history.length > 1
                              ? interpolateHistoryPoint(node.history, v.currentTime)
                              : null;
                          if (interp) {
                            updates.set(node.id, interp);
                          } else {
                            const pt = findClosestHistoryPoint(node.history, v.currentTime);
                            if (pt && Math.abs(pt.time - v.currentTime) < 0.25) {
                              updates.set(node.id, pt);
                            }
                          }
                        }
                      }
                      continue;
                    }
                    if (p.stopTime !== undefined && v.currentTime > p.stopTime + 0.04) {
                      const lastPt = p.history[p.history.length - 1] ?? p.anchorPosition;
                      updates.set(p.id, { ...lastPt, status: 'stopped', time: p.stopTime });
                      continue;
                    }
                    const exactKf = findClosestHistoryPoint(p.keyframes, v.currentTime);
                    if (exactKf && Math.abs(exactKf.time - v.currentTime) < 0.04) {
                      updates.set(p.id, { ...exactKf, time: v.currentTime });
                    } else if (v.currentTime < p.anchorTime - 0.04) {
                      updates.set(p.id, { ...p.anchorPosition, time: v.currentTime });
                    } else {
                      const interp =
                        p.history.length > 1
                          ? interpolateHistoryPoint(p.history, v.currentTime)
                          : null;
                      if (interp) {
                        updates.set(p.id, interp);
                      } else {
                        const pt = findClosestHistoryPoint(p.history, v.currentTime);
                        if (pt && Math.abs(pt.time - v.currentTime) < 0.25) {
                          updates.set(p.id, pt);
                        }
                      }
                    }
                  }
                  if (updates.size > 0) {
                    onPlayersTrackedFrame(updates, false);
                  }
                  drawOverlay();
                }
              }}
              onLoadedData={() => {
                chromaFrameEpochRef.current += 1;
                drawOverlay();
              }}
              onCanPlay={() => {
                chromaFrameEpochRef.current += 1;
                drawOverlay();
              }}
              onSeeked={(e) => {
                const v = e.currentTarget;
                if (!isPlayingRef.current && !isSlowTrackingDetectedRef.current) {
                  needsTrackerReseedRef.current = true;
                  lastProcessedTimeRef.current = v.currentTime;
                  if (
                    showDetectedBoxesRef.current &&
                    detectedBoxTrackerRef.current?.hasHistories()
                  ) {
                    const replayedDet = detectedBoxTrackerRef.current.getBoxesAtTime(
                      detectedBoxesRef.current,
                      v.currentTime
                    );
                    if (replayedDet && !areDetectedBoxListsClose(detectedBoxesRef.current, replayedDet)) {
                      detectedBoxesRef.current = replayedDet;
                      onDetectedBoxesSync(replayedDet);
                    }
                  }
                  const activePlayers = playersRef.current.filter((p) => p.trackWithCv !== false);
                  const updates = new Map<string, CirclePosition>();
                  for (const p of activePlayers) {
                    if ((p.style === 'chain' || p.style === 'polygon') && p.nodes) {
                      for (const node of p.nodes) {
                        if (!node.trackWithCv) continue;
                        if (node.stopTime !== undefined && v.currentTime > node.stopTime + 0.04) {
                          const lastPt = node.history[node.history.length - 1] ?? node.anchorPosition;
                          updates.set(node.id, { ...lastPt, status: 'stopped', time: node.stopTime });
                          continue;
                        }
                        const exactKf = findClosestHistoryPoint(node.keyframes, v.currentTime);
                        if (exactKf && Math.abs(exactKf.time - v.currentTime) < 0.04) {
                          updates.set(node.id, { ...exactKf, time: v.currentTime });
                        } else if (v.currentTime < node.anchorTime - 0.04) {
                          updates.set(node.id, { ...node.anchorPosition, time: v.currentTime });
                        } else {
                          const interp =
                            node.history.length > 1
                              ? interpolateHistoryPoint(node.history, v.currentTime)
                              : null;
                          if (interp) {
                            updates.set(node.id, interp);
                          } else {
                            const pt = findClosestHistoryPoint(node.history, v.currentTime);
                            if (pt && Math.abs(pt.time - v.currentTime) < 0.25) {
                              updates.set(node.id, pt);
                            }
                          }
                        }
                      }
                      continue;
                    }
                    if (p.stopTime !== undefined && v.currentTime > p.stopTime + 0.04) {
                      const lastPt = p.history[p.history.length - 1] ?? p.anchorPosition;
                      updates.set(p.id, { ...lastPt, status: 'stopped', time: p.stopTime });
                      continue;
                    }
                    const exactKf = findClosestHistoryPoint(p.keyframes, v.currentTime);
                    if (exactKf && Math.abs(exactKf.time - v.currentTime) < 0.04) {
                      updates.set(p.id, { ...exactKf, time: v.currentTime });
                    } else if (v.currentTime < p.anchorTime - 0.04) {
                      updates.set(p.id, { ...p.anchorPosition, time: v.currentTime });
                    } else {
                      const interp =
                        p.history.length > 1
                          ? interpolateHistoryPoint(p.history, v.currentTime)
                          : null;
                      if (interp) {
                        updates.set(p.id, interp);
                      } else {
                        const pt = findClosestHistoryPoint(p.history, v.currentTime);
                        if (pt && Math.abs(pt.time - v.currentTime) < 0.25) {
                          updates.set(p.id, pt);
                        }
                      }
                    }
                  }
                  if (updates.size > 0) {
                    onPlayersTrackedFrame(updates, false);
                  }
                }
                chromaFrameEpochRef.current += 1;
                drawOverlay();
                if (pendingSeekTimeRef.current !== null) {
                  const nextSeek = pendingSeekTimeRef.current;
                  pendingSeekTimeRef.current = null;
                  if (Math.abs(v.currentTime - nextSeek) > 0.008) {
                    v.currentTime = nextSeek;
                  }
                }
              }}
              onPause={(e) => {
                const v = e.currentTarget;
                if (
                  !isSlowTrackingDetectedRef.current &&
                  showDetectedBoxesRef.current &&
                  detectedBoxTrackerRef.current?.hasHistories()
                ) {
                  const replayedDet = detectedBoxTrackerRef.current.getBoxesAtTime(
                    detectedBoxesRef.current,
                    v.currentTime
                  );
                  if (replayedDet && !areDetectedBoxListsClose(detectedBoxesRef.current, replayedDet)) {
                    detectedBoxesRef.current = replayedDet;
                    onDetectedBoxesSync(replayedDet);
                  }
                }
              }}
              onEnded={() => {
                flushPendingTrackingToReact(videoRef.current?.currentTime);
                if (!isLooping) {
                  onPlayStateChange(false);
                }
              }}
            className="w-full h-full object-contain pointer-events-none opacity-0"
          />

          {/* Single-pass WebGL2 GPU compositor for Layer 1 (video), Layer 1.5 (mask), Layer 2 (tools), Layer 3 (players) */}
          <canvas
            ref={glCanvasRef}
            className="absolute inset-0 w-full h-full pointer-events-none"
          />

          {/* Top 2D Canvas for Layer 4 HUD (labels, handles, previews, sampling loupe) & Fallback 2D mode */}
          <canvas
            ref={canvasRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerLeave={handlePointerLeave}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onContextMenu={(e) => {
              e.preventDefault();
            }}
            className={`absolute inset-0 w-full h-full touch-none ${
              isSamplingPitch ||
              realigningPlayerId ||
              detectorSubTool === 'drawer' ||
              (!showPlayerBoxBar &&
                !detectorSubTool &&
                (toolMode === 'circle' ||
                  toolMode === 'spotlight' ||
                  toolMode === 'ring' ||
                  toolMode === 'chain' ||
                  toolMode === 'polygon'))
                ? 'cursor-crosshair'
                : 'cursor-pointer'
            }`}
          />

          {/* Floating Tick Confirmation for Pending Spotlight Box */}
          {pendingSpotlight && (!dragState || dragState.kind !== 'spotlight-circle') && (() => {
            const rect = getVideoRenderRect();
            if (!rect || stageSize.w === 0) return null;
            const { px: ppx, py: ppy, halfH: pHalfH } = getBoxPixels(pendingSpotlight, rect);
            const barLeft = Math.max(78, Math.min(stageSize.w - 78, ppx));
            const barTop = ppy - pHalfH - 44 >= 8 ? ppy - pHalfH - 44 : Math.min(stageSize.h - 44, ppy + pHalfH + 10);

            return (
              <div
                style={{ left: `${barLeft}px`, top: `${barTop}px` }}
                className="absolute -translate-x-1/2 z-30 flex items-center gap-1.5 bg-[#0B0F14]/95 backdrop-blur-sm border border-amber-500/50 px-2 py-1.5 rounded-lg shadow-xl"
              >
                <button
                  type="button"
                  onClick={confirmPendingSpotlight}
                  title="Convert box to tracked Spotlight (Enter)"
                  aria-label="Confirm Spotlight"
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-semibold transition-colors whitespace-nowrap"
                >
                  <Check className="w-3.5 h-3.5 stroke-[2.75]" />
                  <span>Spotlight</span>
                </button>
                <button
                  type="button"
                  onClick={cancelPendingSpotlight}
                  title="Discard selection box (Esc)"
                  aria-label="Cancel Spotlight box"
                  className="p-1 rounded hover:bg-[#1E2936] text-slate-400 hover:text-slate-100 transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })()}

          {/* Floating Tick Confirmation for Pending Ring Box */}
          {pendingRing && (!dragState || dragState.kind !== 'ring-circle') && (() => {
            const rect = getVideoRenderRect();
            if (!rect || stageSize.w === 0) return null;
            const { px: ppx, py: ppy, halfH: pHalfH } = getBoxPixels(pendingRing, rect);
            const barLeft = Math.max(78, Math.min(stageSize.w - 78, ppx));
            const barTop = ppy - pHalfH - 44 >= 8 ? ppy - pHalfH - 44 : Math.min(stageSize.h - 44, ppy + pHalfH + 10);

            return (
              <div
                style={{ left: `${barLeft}px`, top: `${barTop}px` }}
                className="absolute -translate-x-1/2 z-30 flex items-center gap-1.5 bg-[#0B0F14]/95 backdrop-blur-sm border border-cyan-400/50 px-2 py-1.5 rounded-lg shadow-xl"
              >
                <button
                  type="button"
                  onClick={confirmPendingRing}
                  title="Place 3D Ring around player's feet and track (Enter)"
                  aria-label="Confirm Ring"
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-semibold transition-colors whitespace-nowrap"
                >
                  <Check className="w-3.5 h-3.5 stroke-[2.75]" />
                  <span>Ring</span>
                </button>
                <button
                  type="button"
                  onClick={cancelPendingRing}
                  title="Discard selection box (Esc)"
                  aria-label="Cancel Ring box"
                  className="p-1 rounded hover:bg-[#1E2936] text-slate-400 hover:text-slate-100 transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })()}

          {/* Floating Controls for Pending Chain (Connecting Existing 3D Rings) */}
          {toolMode === 'chain' && pendingChainRingIds.length === 0 && (() => {
            const t = videoRef.current?.currentTime ?? 0;
            const visibleFootRings = players.filter((p) => {
              if (!p.visible || p.style !== 'foot-ring') return false;
              const startT = p.inTime ?? p.anchorTime;
              if (t + 0.04 < startT) return false;
              if (p.stopTime !== undefined && t > p.stopTime + 0.04) return false;
              return true;
            });
            return (
              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 bg-[#0B0F14]/92 backdrop-blur-sm border border-cyan-400/35 px-3 py-1.5 rounded-lg shadow-xl text-[11px] text-slate-300 whitespace-nowrap pointer-events-none">
                {visibleFootRings.length < 2
                  ? 'Add at least 2 3D Rings first, then click them here to connect'
                  : 'Click an existing 3D Ring to start a Chain link'}
              </div>
            );
          })()}

          {pendingChainRingIds.length > 0 && (
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 bg-[#0B0F14]/95 backdrop-blur-sm border border-cyan-400/45 px-2.5 py-1.5 rounded-lg shadow-xl text-xs">
              <span className="text-[11px] font-mono tabular-nums text-cyan-200 whitespace-nowrap">
                Chain · {pendingChainRingIds.length} {pendingChainRingIds.length === 1 ? 'ring' : 'rings'}
              </span>
              {pendingChainRingIds.length >= 2 ? (
                <button
                  type="button"
                  onClick={confirmPendingChain}
                  title="Finish Chain connector (Enter or Double-click)"
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-[11px] font-semibold transition-colors whitespace-nowrap"
                >
                  <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                  <span>Finish Chain</span>
                </button>
              ) : (
                <span className="text-[10.5px] text-slate-400 whitespace-nowrap">
                  Click next 3D Ring
                </span>
              )}
              <button
                type="button"
                onClick={undoLastChainRing}
                title="Undo last ring (Backspace)"
                className="px-2 py-1 rounded bg-[#141C26] hover:bg-[#1E2936] text-slate-200 text-[11px] transition-colors whitespace-nowrap"
              >
                Undo
              </button>
              <button
                type="button"
                onClick={cancelPendingChain}
                title="Cancel Chain (Esc or Right-click)"
                aria-label="Cancel Chain"
                className="p-1 rounded hover:bg-[#1E2936] text-slate-400 hover:text-slate-100 transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Floating Controls for Pending Polygon */}
          {pendingPolygonNodes.length > 0 && (
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 bg-[#0B0F14]/95 backdrop-blur-sm border border-rose-400/45 px-2.5 py-1.5 rounded-lg shadow-xl text-xs">
              <span className="text-[11px] font-mono tabular-nums text-rose-200 whitespace-nowrap">
                Polygon · {pendingPolygonNodes.length}{' '}
                {pendingPolygonNodes.length === 1 ? 'vertex' : 'vertices'}
              </span>
              {pendingPolygonNodes.length >= 3 ? (
                <button
                  type="button"
                  onClick={confirmPendingPolygon}
                  title="Close Polygon & track each vertex (Enter, Double-click, or click 1st vertex)"
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-[11px] font-semibold transition-colors whitespace-nowrap"
                >
                  <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                  <span>Close Polygon</span>
                </button>
              ) : (
                <span className="text-[10.5px] text-slate-400 whitespace-nowrap">
                  Click {3 - pendingPolygonNodes.length} more{' '}
                  {3 - pendingPolygonNodes.length === 1 ? 'vertex' : 'vertices'}
                </span>
              )}
              <button
                type="button"
                onClick={undoLastPolygonVertex}
                title="Undo last vertex (Backspace)"
                className="px-2 py-1 rounded bg-[#141C26] hover:bg-[#1E2936] text-slate-200 text-[11px] transition-colors whitespace-nowrap"
              >
                Undo
              </button>
              <button
                type="button"
                onClick={cancelPendingPolygon}
                title="Cancel Polygon (Esc or Right-click)"
                aria-label="Cancel Polygon"
                className="p-1 rounded hover:bg-[#1E2936] text-slate-400 hover:text-slate-100 transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Non-Exported Stage Coverage HUD Bar (top-left) */}
          {(coverageSummary.trackedSeconds > 0 ||
            detectedBoxes.length > 0 ||
            implementedTracks.length > 0 ||
            players.length > 0 ||
            showPlayerBoxBar) && (() => {
            const seg = coverageSummary.currentSegment;
            const kind = coverageSummary.currentKind;
            const framePlayerCount =
              seg && seg.playerCount > 0
                ? seg.playerCount
                : detectedBoxes.length > 0
                  ? detectedBoxes.length
                  : implementedTracks.length;
            const partialTotal =
              seg && seg.playerCount + seg.toolCount > 0
                ? seg.playerCount + seg.toolCount
                : Math.max(detectedBoxes.length, players.filter((p) => p.trackWithCv !== false).length);

            return (
              <div className="absolute top-2.5 left-2.5 z-20 flex items-center gap-2 bg-[#0B0F14]/90 backdrop-blur-sm border border-[#243040] px-2 py-1 rounded-md shadow-lg text-[10.5px] whitespace-nowrap">
                {kind === 'full' ? (
                  <span className="inline-flex items-center gap-1 text-emerald-300 font-medium">
                    <ScanSearch className="w-3 h-3 text-emerald-400 shrink-0" />
                    <span>
                      Full Players Tracked
                      {framePlayerCount > 0 ? ` · ${framePlayerCount}p` : ''}
                    </span>
                  </span>
                ) : kind === 'partial' ? (
                  <span className="inline-flex items-center gap-1 text-sky-300 font-medium">
                    <BoxSelect className="w-3 h-3 text-sky-400 shrink-0" />
                    <span>
                      Partial ·{' '}
                      <span className="font-mono tabular-nums">
                        {partialTotal} {partialTotal === 1 ? 'Drawn Box' : 'Drawn Boxes'}
                      </span>
                    </span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-slate-300 font-medium">
                    <AlertTriangle className="w-3 h-3 text-slate-400 shrink-0" />
                    <span>Untracked Area</span>
                  </span>
                )}

                <span className="text-slate-600" aria-hidden="true">
                  ·
                </span>
                <span className="font-mono tabular-nums text-slate-300">
                  {coverageSummary.coveragePct}% clip
                </span>

                {onToggleCoverageOverlay && (
                  <button
                    type="button"
                    onClick={onToggleCoverageOverlay}
                    aria-pressed={showCoverageOverlay}
                    title={
                      showCoverageOverlay
                        ? 'Hide spatial coverage mask & untracked player hints'
                        : 'Show spatial coverage mask & untracked player hints'
                    }
                    className={`inline-flex items-center gap-1 px-1.5 py-[1px] rounded border text-[10px] font-medium transition-colors ${
                      showCoverageOverlay
                        ? 'bg-sky-500/15 border-sky-500/40 text-sky-200'
                        : 'bg-[#141B24] border-[#243040] text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {showCoverageOverlay ? (
                      <Eye className="w-2.5 h-2.5" />
                    ) : (
                      <EyeOff className="w-2.5 h-2.5" />
                    )}
                    <span>Mask</span>
                  </button>
                )}

                {coverageSummary.nextGapTime !== null && onJumpToNextGap && (
                  <button
                    type="button"
                    onClick={onJumpToNextGap}
                    title={`Jump to next untracked gap at ${formatStageTimeShort(coverageSummary.nextGapTime)}`}
                    className="inline-flex items-center gap-1 px-1.5 py-[1px] rounded bg-[#141B24] hover:bg-[#1E2734] border border-[#243040] text-[10px] font-medium text-amber-300 hover:text-amber-200 transition-colors"
                  >
                    <span>Next Gap</span>
                    <ArrowRight className="w-2.5 h-2.5" />
                  </button>
                )}
              </div>
            );
          })()}
        </>
      ) : (
        /* Empty Stage Onboarding */
        <div className="max-w-md px-6 py-10 text-center">
          <div className="w-12 h-12 rounded-xl bg-[#141C26] border border-[#243040] flex items-center justify-center mx-auto mb-4">
            <Film className="w-6 h-6 text-emerald-400" />
          </div>
          <h2 className="text-lg font-semibold text-slate-100 tracking-tight">
            Load a Football Match Clip into OPFS
          </h2>
          <p className="mt-2 text-sm text-slate-400 leading-relaxed">
            Import a match video from your computer or generate a tactical sample match directly in your browser&apos;s Origin Private File System.
          </p>

          <div className="mt-6 grid grid-cols-3 gap-3 text-left">
            <div className="p-3 rounded-lg bg-[#121821] border border-[#1E2936]">
              <div className="text-xs font-semibold text-slate-200">1. Load Video</div>
              <div className="mt-1 text-[11px] text-slate-400 leading-snug">
                Stored locally in OPFS for instant seeking.
              </div>
            </div>
            <div className="p-3 rounded-lg bg-[#121821] border border-[#1E2936]">
              <div className="text-xs font-semibold text-slate-200">2. Box Players</div>
              <div className="mt-1 text-[11px] text-slate-400 leading-snug">
                Pause at a moment &amp; drag rectangles around players.
              </div>
            </div>
            <div className="p-3 rounded-lg bg-[#121821] border border-[#1E2936]">
              <div className="text-xs font-semibold text-slate-200">3. Auto Track</div>
              <div className="mt-1 text-[11px] text-slate-400 leading-snug">
                Click Play for real-time CV tracking.
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={onGenerateSample}
            className="mt-6 inline-flex items-center gap-2 px-4 py-2.5 rounded-md bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-semibold transition-colors whitespace-nowrap focus-visible:outline-2 focus-visible:outline-emerald-300"
          >
            <Sparkles className="w-4 h-4" />
            <span>Generate Sample Match to OPFS</span>
          </button>
        </div>
      )}
    </div>
  );
};

function boxFromDragPoints(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  rect: RenderRect,
  time: number,
  fallbackDims?: { width: number; height: number }
): CirclePosition {
  const dist = Math.hypot(x2 - x1, y2 - y1);
  if (dist < 6) {
    const defaultW = fallbackDims && fallbackDims.width > 0
      ? fallbackDims.width * rect.w
      : Math.max(24, rect.w * 0.032);
    const defaultH = fallbackDims && fallbackDims.height > 0
      ? fallbackDims.height * rect.h
      : Math.max(48, defaultW * 2.1);
    const width = Math.max(14, Math.min(rect.w * 0.45, defaultW)) / rect.w;
    const height = Math.max(20, Math.min(rect.h * 0.7, defaultH)) / rect.h;
    return {
      cx: clamp01((x1 - rect.x) / rect.w),
      cy: clamp01((y1 - rect.y) / rect.h),
      width,
      height,
      radius: Math.max(width * 0.5, (height * rect.h * 0.28) / rect.w),
      confidence: 1,
      status: 'anchored',
      time,
    };
  }

  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  const top = Math.min(y1, y2);
  const bottom = Math.max(y1, y2);
  const boxW = Math.max(14, Math.min(rect.w * 0.45, right - left));
  const boxH = Math.max(20, Math.min(rect.h * 0.7, bottom - top));
  const width = boxW / rect.w;
  const height = boxH / rect.h;

  return {
    cx: clamp01(((left + right) * 0.5 - rect.x) / rect.w),
    cy: clamp01(((top + bottom) * 0.5 - rect.y) / rect.h),
    width,
    height,
    radius: Math.max(width * 0.5, (boxH * 0.28) / rect.w),
    confidence: 1,
    status: 'anchored',
    time,
  };
}

function resizeRectByHandle(
  x: number,
  y: number,
  rect: RenderRect,
  origCx: number,
  origCy: number,
  origWidth: number,
  origHeight: number,
  mode: ResizeHandleMode,
  time: number
): CirclePosition {
  const centerPx = rect.x + origCx * rect.w;
  const centerPy = rect.y + origCy * rect.h;
  let halfW = Math.max(7, (origWidth * rect.w) * 0.5);
  let halfH = Math.max(10, (origHeight * rect.h) * 0.5);

  if (mode === 'e' || mode === 'w' || mode === 'ne' || mode === 'nw' || mode === 'se' || mode === 'sw') {
    halfW = Math.max(7, Math.min(rect.w * 0.225, Math.abs(x - centerPx)));
  }
  if (mode === 'n' || mode === 's' || mode === 'ne' || mode === 'nw' || mode === 'se' || mode === 'sw') {
    halfH = Math.max(10, Math.min(rect.h * 0.35, Math.abs(y - centerPy)));
  }

  const width = (halfW * 2) / rect.w;
  const height = (halfH * 2) / rect.h;

  return {
    cx: origCx,
    cy: origCy,
    width,
    height,
    radius: Math.max(width * 0.5, (halfH * 2 * 0.28) / rect.w),
    confidence: 1,
    status: 'anchored',
    time,
  };
}

function drawBoxResizeHandles(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  halfW: number,
  halfH: number,
  color: string
) {
  const corners = [
    [px - halfW, py - halfH],
    [px + halfW, py - halfH],
    [px - halfW, py + halfH],
    [px + halfW, py + halfH],
  ];
  ctx.fillStyle = '#FFFFFF';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  for (const [hx, hy] of corners) {
    ctx.beginPath();
    ctx.rect(hx - 3.5, hy - 3.5, 7, 7);
    ctx.fill();
    ctx.stroke();
  }
}

function drawPlayerLabelAndHandle(
  ctx: CanvasRenderingContext2D,
  _rect: RenderRect,
  px: number,
  py: number,
  halfW: number,
  halfH: number,
  player: TrackedPlayer,
  isSelected: boolean
) {
  if (isSelected) {
    drawBoxResizeHandles(ctx, px, py, halfW, halfH, player.color);
  }
}

function drawSpotlightLabelAndHandle(
  ctx: CanvasRenderingContext2D,
  rect: RenderRect,
  px: number,
  py: number,
  halfH: number,
  player: TrackedPlayer,
  isSelected: boolean
) {
  if (!isSelected) return;
  const sp = player.spotlight ?? { beamSize: 80, intensity: 0.4, rotation: 0.9 };
  const beamRadius = sp.beamSize / 2;
  const groundY = Math.min(rect.y + rect.h - 4, py + halfH * 0.88);

  // Selection resize handle on right edge of spotlight ground ring when selected
  ctx.fillStyle = '#FFFFFF';
  ctx.strokeStyle = player.color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(px + beamRadius, groundY, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function drawFootRingLabelAndHandle(
  ctx: CanvasRenderingContext2D,
  rect: RenderRect,
  px: number,
  py: number,
  halfH: number,
  player: TrackedPlayer,
  isSelected: boolean
) {
  if (!isSelected) return;
  const rp = player.ring ?? {
    ringSize: 112,
    ringThickness: DEFAULT_RING_THICKNESS,
    tiltDeg: 58,
    spinSpeed: 2.35,
  };
  const ringR = Math.max(MIN_RING_SIZE / 2, rp.ringSize / 2);
  const groundY = Math.min(rect.y + rect.h - 4, py + halfH * 0.88);
  const handleR = ringR < 16 ? 3.5 : 4.5;

  // Selection resize handle on right edge of foot ring when selected
  ctx.fillStyle = '#FFFFFF';
  ctx.strokeStyle = player.color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(px + ringR, groundY, handleR, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function drawEraseHoverHighlight(
  ctx: CanvasRenderingContext2D,
  rect: RenderRect,
  px: number,
  py: number,
  boxW: number,
  boxH: number,
  halfH: number,
  player: TrackedPlayer
) {
  ctx.save();
  ctx.strokeStyle = '#FB7185';
  ctx.lineWidth = 2.5;
  ctx.setLineDash([5, 3]);
  if (player.style === 'spotlight') {
    const sp = player.spotlight ?? { beamSize: 80, intensity: 0.4, rotation: 0.9 };
    const groundY = Math.min(rect.y + rect.h - 4, py + halfH * 0.88);
    const beamR = sp.beamSize / 2;
    ctx.beginPath();
    ctx.ellipse(px, groundY, beamR + 4, beamR * sp.rotation + 4, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (player.style === 'foot-ring') {
    const rp = player.ring ?? { ringSize: 112, tiltDeg: 58, spinSpeed: 2.35 };
    const groundY = Math.min(rect.y + rect.h - 4, py + halfH * 0.88);
    const ringR = rp.ringSize / 2;
    const scaleY = Math.max(0.22, Math.cos((Math.max(0, Math.min(75, rp.tiltDeg)) * Math.PI) / 180));
    ctx.beginPath();
    ctx.ellipse(px, groundY, ringR + 4, ringR * scaleY + 4, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.roundRect(px - boxW * 0.5 - 4, py - boxH * 0.5 - 4, boxW + 8, boxH + 8, 5);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();
}

function hitTestRectBox(
  x: number,
  y: number,
  pos: Pick<CirclePosition, 'cx' | 'cy' | 'width' | 'height' | 'radius'>,
  rect: RenderRect
): 'inside' | ResizeHandleMode | null {
  const { px, py, halfW, halfH } = getBoxPixels(pos, rect);
  const left = px - halfW;
  const right = px + halfW;
  const top = py - halfH;
  const bottom = py + halfH;
  const cornerTol = 9;
  const edgeTol = 7;

  const nearLeft = Math.abs(x - left) <= cornerTol;
  const nearRight = Math.abs(x - right) <= cornerTol;
  const nearTop = Math.abs(y - top) <= cornerTol;
  const nearBottom = Math.abs(y - bottom) <= cornerTol;

  if (nearLeft && nearTop) return 'nw';
  if (nearRight && nearTop) return 'ne';
  if (nearLeft && nearBottom) return 'sw';
  if (nearRight && nearBottom) return 'se';

  if (y >= top - edgeTol && y <= bottom + edgeTol) {
    if (Math.abs(x - left) <= edgeTol) return 'w';
    if (Math.abs(x - right) <= edgeTol) return 'e';
  }
  if (x >= left - edgeTol && x <= right + edgeTol) {
    if (Math.abs(y - top) <= edgeTol) return 'n';
    if (Math.abs(y - bottom) <= edgeTol) return 's';
  }

  if (x >= left && x <= right && y >= top && y <= bottom) {
    return 'inside';
  }
  return null;
}

function findHitOverlay(
  x: number,
  y: number,
  rect: RenderRect,
  players: TrackedPlayer[],
  currTime: number
): {
  player: TrackedPlayer;
  zone: 'inside' | 'edge' | 'node';
  resizeMode?: ResizeHandleMode;
  nodeId?: string;
} | null {
  for (let i = players.length - 1; i >= 0; i--) {
    const p = players[i];
    if (!p.visible) continue;
    const startT = p.inTime ?? p.anchorTime;
    if (currTime + 0.03 < startT) continue;
    if (p.stopTime !== undefined && currTime > p.stopTime + 0.03) continue;

    if (p.style === 'chain' && p.linkedRingIds && p.linkedRingIds.length >= 2) {
      const connTol = Math.max(12, (p.chain?.connectorWidth ?? 10) + 6);
      const pts: Array<{ x: number; y: number }> = [];
      for (const rid of p.linkedRingIds) {
        const ringPlayer = players.find((r) => r.id === rid && r.visible && r.style === 'foot-ring');
        if (!ringPlayer) continue;
        const rStart = ringPlayer.inTime ?? ringPlayer.anchorTime;
        if (currTime + 0.04 < rStart) continue;
        if (ringPlayer.stopTime !== undefined && currTime > ringPlayer.stopTime + 0.04) continue;
        const g = getBoxPixels(ringPlayer.currentPosition, rect);
        const groundY = Math.min(rect.y + rect.h - 4, g.py + g.halfH * 0.88);
        pts.push({ x: g.px, y: groundY });
      }
      for (let k = 1; k < pts.length; k++) {
        if (pointToSegmentDistance(x, y, pts[k - 1].x, pts[k - 1].y, pts[k].x, pts[k].y) <= connTol) {
          return { player: p, zone: 'inside' };
        }
      }
      continue;
    }

    if (p.style === 'chain' && p.nodes && p.nodes.length > 0) {
      const ringR = (p.chain?.ringSize ?? 112) / 2;
      const scaleY = Math.max(
        0.22,
        Math.cos((Math.max(0, Math.min(75, p.chain?.tiltDeg ?? 58)) * Math.PI) / 180)
      );
      const pts: Array<{ x: number; y: number }> = [];
      for (const node of p.nodes) {
        const g = getBoxPixels(node.currentPosition, rect);
        const groundY = Math.min(rect.y + rect.h - 4, g.py + g.halfH * 0.88);
        pts.push({ x: g.px, y: groundY });
        const ellipseDist = Math.hypot(x - g.px, (y - groundY) / scaleY);
        if (
          ellipseDist <= Math.max(18, ringR) ||
          (x >= g.px - g.halfW && x <= g.px + g.halfW && y >= g.py - g.halfH && y <= g.py + g.halfH)
        ) {
          return { player: p, zone: 'node', nodeId: node.id };
        }
      }
      const connTol = Math.max(12, p.chain?.connectorWidth ?? 10);
      for (let k = 1; k < pts.length; k++) {
        if (pointToSegmentDistance(x, y, pts[k - 1].x, pts[k - 1].y, pts[k].x, pts[k].y) <= connTol) {
          return { player: p, zone: 'inside' };
        }
      }
      continue;
    }

    if (p.style === 'polygon' && p.nodes && p.nodes.length > 0) {
      const markerR = p.polygon?.markerSize ?? 5;
      const verts: Array<{ x: number; y: number }> = [];
      for (const node of p.nodes) {
        const g = getBoxPixels(node.currentPosition, rect);
        const groundY = Math.min(rect.y + rect.h - 4, g.py + g.halfH * 0.88);
        verts.push({ x: g.px, y: groundY });
        if (
          Math.hypot(x - g.px, y - groundY) <= Math.max(12, markerR + 7) ||
          (x >= g.px - g.halfW && x <= g.px + g.halfW && y >= g.py - g.halfH && y <= g.py + g.halfH)
        ) {
          return { player: p, zone: 'node', nodeId: node.id };
        }
      }
      for (let k = 0; k < verts.length; k++) {
        const next = verts[(k + 1) % verts.length];
        if (pointToSegmentDistance(x, y, verts[k].x, verts[k].y, next.x, next.y) <= 10) {
          return { player: p, zone: 'inside' };
        }
      }
      if (verts.length >= 3 && pointInPolygon(x, y, verts)) {
        return { player: p, zone: 'inside' };
      }
      continue;
    }

    const { px, py, halfW, halfH } = getBoxPixels(p.currentPosition, rect);

    if (p.style === 'spotlight') {
      const groundY = Math.min(rect.y + rect.h - 4, py + halfH * 0.88);
      const beamR = (p.spotlight?.beamSize ?? 80) / 2;
      const rot = p.spotlight?.rotation ?? 0.9;
      const ellipseDist = Math.hypot(x - px, (y - groundY) / Math.max(0.2, rot));
      if (Math.abs(ellipseDist - beamR) <= 8) {
        return { player: p, zone: 'edge' };
      }
      if (
        ellipseDist < beamR ||
        (x >= px - halfW && x <= px + halfW && y >= py - halfH && y <= py + halfH)
      ) {
        return { player: p, zone: 'inside' };
      }
      continue;
    }

    if (p.style === 'foot-ring') {
      const groundY = Math.min(rect.y + rect.h - 4, py + halfH * 0.88);
      const ringR = Math.max(MIN_RING_SIZE / 2, (p.ring?.ringSize ?? 112) / 2);
      const scaleY = Math.max(
        0.22,
        Math.cos((Math.max(0, Math.min(75, p.ring?.tiltDeg ?? 58)) * Math.PI) / 180)
      );
      const ellipseDist = Math.hypot(x - px, (y - groundY) / scaleY);
      const handleHitDist = Math.hypot(x - (px + ringR), y - groundY);
      const handleTol = Math.min(8, Math.max(4, ringR * 0.5));
      const edgeBand = Math.min(7, Math.max(3, ringR * 0.35));
      if (handleHitDist <= handleTol || Math.abs(ellipseDist - ringR) <= edgeBand) {
        return { player: p, zone: 'edge' };
      }
      if (
        ellipseDist < Math.max(12, ringR) ||
        (x >= px - halfW && x <= px + halfW && y >= py - halfH && y <= py + halfH)
      ) {
        return { player: p, zone: 'inside' };
      }
      continue;
    }

    const hit = hitTestRectBox(x, y, p.currentPosition, rect);
    if (hit === 'inside') {
      return { player: p, zone: 'inside' };
    }
    if (hit !== null) {
      return { player: p, zone: 'edge', resizeMode: hit };
    }
  }
  return null;
}

function createFootAlignedBox(
  x: number,
  y: number,
  rect: RenderRect,
  time: number
): CirclePosition {
  const defaultW = Math.max(24, rect.w * 0.032);
  const defaultH = Math.max(48, defaultW * 2.1);
  const halfH = defaultH * 0.5;
  const bodyPy = y - halfH * 0.88;
  const width = Math.max(14, Math.min(rect.w * 0.45, defaultW)) / rect.w;
  const height = Math.max(20, Math.min(rect.h * 0.7, defaultH)) / rect.h;
  return {
    cx: clamp01((x - rect.x) / rect.w),
    cy: clamp01((bodyPy - rect.y) / rect.h),
    width,
    height,
    radius: Math.max(width * 0.5, (height * rect.h * 0.28) / rect.w),
    confidence: 1,
    status: 'anchored',
    time,
  };
}

function pointToSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-6) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function pointInPolygon(x: number, y: number, verts: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const xi = verts[i].x;
    const yi = verts[i].y;
    const xj = verts[j].x;
    const yj = verts[j].y;
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-6) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function findClosestHistoryPoint(
  history: CirclePosition[],
  targetTime: number
): CirclePosition | null {
  if (history.length === 0) return null;
  let best = history[0];
  let bestDiff = Math.abs(history[0].time - targetTime);
  for (let i = 1; i < history.length; i++) {
    const diff = Math.abs(history[i].time - targetTime);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = history[i];
    }
  }
  return best;
}

const smoothedHistoryCache = new WeakMap<CirclePosition[], CirclePosition[]>();

function getSmoothedHistoryArray(raw: CirclePosition[]): CirclePosition[] {
  if (raw.length <= 2) return raw;
  let cached = smoothedHistoryCache.get(raw);
  if (!cached) {
    cached = zeroPhaseSmoothTimeline(raw);
    smoothedHistoryCache.set(raw, cached);
  }
  return cached;
}

function interpolateHistoryPoint(
  rawHistory: CirclePosition[],
  targetTime: number
): CirclePosition | null {
  const history = getSmoothedHistoryArray(rawHistory);
  const n = history.length;
  if (n === 0) return null;
  if (n === 1) {
    return Math.abs(history[0].time - targetTime) <= 0.14 ? { ...history[0], time: targetTime } : null;
  }

  const first = history[0];
  if (targetTime <= first.time) {
    return first.time - targetTime <= 0.14 ? { ...first, time: targetTime } : null;
  }

  const last = history[n - 1];
  if (targetTime >= last.time) {
    return targetTime - last.time <= 0.14 ? { ...last, time: targetTime } : null;
  }

  let lo = 0;
  let hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (history[mid].time <= targetTime) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const p1 = history[lo];
  const p2 = history[hi];
  const span = p2.time - p1.time;
  if (span <= 1e-5) return { ...p2, time: targetTime };
  if (span > 0.35) {
    return Math.abs(targetTime - p1.time) <= Math.abs(p2.time - targetTime)
      ? { ...p1, time: targetTime }
      : { ...p2, time: targetTime };
  }

  const u = Math.max(0, Math.min(1, (targetTime - p1.time) / span));
  let cx: number;
  let cy: number;
  if (
    lo >= 1 &&
    lo + 2 < n &&
    p1.time - history[lo - 1].time <= 0.14 &&
    history[lo + 2].time - p2.time <= 0.14
  ) {
    const p0 = history[lo - 1];
    const p3 = history[lo + 2];
    const u2 = u * u;
    const u3 = u2 * u;
    const crCx =
      0.5 *
      (2 * p1.cx +
        (-p0.cx + p2.cx) * u +
        (2 * p0.cx - 5 * p1.cx + 4 * p2.cx - p3.cx) * u2 +
        (-p0.cx + 3 * p1.cx - 3 * p2.cx + p3.cx) * u3);
    const crCy =
      0.5 *
      (2 * p1.cy +
        (-p0.cy + p2.cy) * u +
        (2 * p0.cy - 5 * p1.cy + 4 * p2.cy - p3.cy) * u2 +
        (-p0.cy + 3 * p1.cy - 3 * p2.cy + p3.cy) * u3);
    cx = Math.max(Math.min(p1.cx, p2.cx) - 0.006, Math.min(Math.max(p1.cx, p2.cx) + 0.006, crCx));
    cy = Math.max(Math.min(p1.cy, p2.cy) - 0.006, Math.min(Math.max(p1.cy, p2.cy) + 0.006, crCy));
  } else {
    cx = p1.cx + (p2.cx - p1.cx) * u;
    cy = p1.cy + (p2.cy - p1.cy) * u;
  }

  const width = p1.width + (p2.width - p1.width) * u;
  const height = p1.height + (p2.height - p1.height) * u;
  const radius = p1.radius + (p2.radius - p1.radius) * u;
  const confidence = p1.confidence + (p2.confidence - p1.confidence) * u;

  return {
    cx,
    cy,
    width,
    height,
    radius,
    confidence,
    status: u < 0.5 ? p1.status : p2.status,
    time: targetTime,
  };
}

function findHitDetectedBox(
  x: number,
  y: number,
  rect: RenderRect,
  boxes: DetectedPlayerBox[]
): DetectedPlayerBox | null {
  const pad = 6;
  for (let i = boxes.length - 1; i >= 0; i--) {
    const b = boxes[i];
    const px = rect.x + b.cx * rect.w;
    const py = rect.y + b.cy * rect.h;
    const hw = Math.max(4, (b.width * rect.w) * 0.5) + pad;
    const hh = Math.max(5, (b.height * rect.h) * 0.5) + pad;
    if (x >= px - hw && x <= px + hw && y >= py - hh && y <= py + hh) {
      return b;
    }
  }
  return null;
}

function hitTestDetectedBoxHandle(
  x: number,
  y: number,
  rect: RenderRect,
  box: Pick<DetectedPlayerBox, 'cx' | 'cy' | 'width' | 'height'>
): ResizeHandleMode | null {
  const px = rect.x + box.cx * rect.w;
  const py = rect.y + box.cy * rect.h;
  const dbw = Math.max(4, box.width * rect.w);
  const dbh = Math.max(6, box.height * rect.h);
  const left = px - dbw * 0.5;
  const right = px + dbw * 0.5;
  const top = py - dbh * 0.5;
  const bottom = py + dbh * 0.5;
  const cornerTol = Math.min(7, Math.max(4.5, Math.min(dbw, dbh) * 0.34));

  const nearLeft = Math.abs(x - left) <= cornerTol;
  const nearRight = Math.abs(x - right) <= cornerTol;
  const nearTop = Math.abs(y - top) <= cornerTol;
  const nearBottom = Math.abs(y - bottom) <= cornerTol;

  if (nearLeft && nearTop) return 'nw';
  if (nearRight && nearTop) return 'ne';
  if (nearLeft && nearBottom) return 'sw';
  if (nearRight && nearBottom) return 'se';

  const edgeTol = 4.5;
  if (dbw >= 20 && Math.abs(x - px) <= dbw * 0.3) {
    if (Math.abs(y - top) <= edgeTol) return 'n';
    if (Math.abs(y - bottom) <= edgeTol) return 's';
  }
  if (dbh >= 22 && Math.abs(y - py) <= dbh * 0.3) {
    if (Math.abs(x - left) <= edgeTol) return 'w';
    if (Math.abs(x - right) <= edgeTol) return 'e';
  }
  return null;
}

function resizeDetectedBoxByHandle(
  x: number,
  y: number,
  rect: RenderRect,
  origCx: number,
  origCy: number,
  origWidth: number,
  origHeight: number,
  mode: ResizeHandleMode
): { cx: number; cy: number; width: number; height: number } {
  const left = rect.x + (origCx - origWidth * 0.5) * rect.w;
  const right = rect.x + (origCx + origWidth * 0.5) * rect.w;
  const top = rect.y + (origCy - origHeight * 0.5) * rect.h;
  const bottom = rect.y + (origCy + origHeight * 0.5) * rect.h;

  const minW = 10;
  const maxW = rect.w * 0.45;
  const minH = 14;
  const maxH = rect.h * 0.7;

  let newLeft = left;
  let newRight = right;
  let newTop = top;
  let newBottom = bottom;

  if (mode === 'nw' || mode === 'sw' || mode === 'w') {
    newLeft = Math.max(rect.x, right - maxW, Math.min(right - minW, x));
  } else if (mode === 'ne' || mode === 'se' || mode === 'e') {
    newRight = Math.min(rect.x + rect.w, left + maxW, Math.max(left + minW, x));
  }

  if (mode === 'nw' || mode === 'ne' || mode === 'n') {
    newTop = Math.max(rect.y, bottom - maxH, Math.min(bottom - minH, y));
  } else if (mode === 'sw' || mode === 'se' || mode === 's') {
    newBottom = Math.min(rect.y + rect.h, top + maxH, Math.max(top + minH, y));
  }

  return {
    cx: clamp01(((newLeft + newRight) * 0.5 - rect.x) / rect.w),
    cy: clamp01(((newTop + newBottom) * 0.5 - rect.y) / rect.h),
    width: Math.max(minW, newRight - newLeft) / rect.w,
    height: Math.max(minH, newBottom - newTop) / rect.h,
  };
}

function computeDraggedDetectedBoxFromDrag(
  drag: DragState,
  rect: RenderRect
): { cx: number; cy: number; width: number; height: number } {
  const origCx = drag.origCx ?? 0.5;
  const origCy = drag.origCy ?? 0.5;
  const origWidth = drag.origWidth ?? 0.022;
  const origHeight = drag.origHeight ?? 0.068;

  if (drag.kind === 'detector-resize') {
    return resizeDetectedBoxByHandle(
      drag.currX,
      drag.currY,
      rect,
      origCx,
      origCy,
      origWidth,
      origHeight,
      drag.resizeMode ?? 'se'
    );
  }

  const dxNorm = (drag.currX - drag.startX) / rect.w;
  const dyNorm = (drag.currY - drag.startY) / rect.h;
  return {
    cx: clamp01(origCx + dxNorm),
    cy: clamp01(origCy + dyNorm),
    width: origWidth,
    height: origHeight,
  };
}

function resizeCursorForMode(mode: ResizeHandleMode): string {
  if (mode === 'nw' || mode === 'se') return 'nwse-resize';
  if (mode === 'ne' || mode === 'sw') return 'nesw-resize';
  if (mode === 'n' || mode === 's') return 'ns-resize';
  return 'ew-resize';
}

function areDetectedBoxListsClose(a: DetectedPlayerBox[], b: DetectedPlayerBox[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ba = a[i];
    const bb = b[i];
    if (
      ba.id !== bb.id ||
      Math.abs(ba.cx - bb.cx) > 2e-4 ||
      Math.abs(ba.cy - bb.cy) > 2e-4 ||
      Math.abs(ba.width - bb.width) > 2e-4 ||
      Math.abs(ba.height - bb.height) > 2e-4
    ) {
      return false;
    }
  }
  return true;
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

function findHitFootRing(
  x: number,
  y: number,
  rect: RenderRect,
  players: TrackedPlayer[],
  currTime: number
): TrackedPlayer | null {
  for (let i = players.length - 1; i >= 0; i--) {
    const p = players[i];
    if (!p.visible || p.style !== 'foot-ring') continue;
    const startT = p.inTime ?? p.anchorTime;
    if (currTime + 0.04 < startT) continue;
    if (p.stopTime !== undefined && currTime > p.stopTime + 0.04) continue;
    const { px, py, halfW, halfH } = getBoxPixels(p.currentPosition, rect);
    const groundY = Math.min(rect.y + rect.h - 4, py + halfH * 0.88);
    const ringR = Math.max(MIN_RING_SIZE / 2, (p.ring?.ringSize ?? 112) / 2);
    const scaleY = Math.max(
      0.22,
      Math.cos((Math.max(0, Math.min(75, p.ring?.tiltDeg ?? 58)) * Math.PI) / 180)
    );
    const ellipseDist = Math.hypot(x - px, (y - groundY) / scaleY);
    if (
      ellipseDist <= Math.max(18, ringR + 10) ||
      (x >= px - halfW - 6 && x <= px + halfW + 6 && y >= py - halfH - 6 && y <= py + halfH + 6)
    ) {
      return p;
    }
  }
  return null;
}

function findNearestImplementedTrack(
  x: number,
  y: number,
  rect: RenderRect,
  tracks: ImplementedTrackRecord[],
  currTime: number
): { track: ImplementedTrackRecord; pos: CirclePosition } | null {
  if (tracks.length === 0) return null;
  let best: { track: ImplementedTrackRecord; pos: CirclePosition } | null = null;
  let bestDist = Infinity;

  for (const track of tracks) {
    const pos = sampleImplementedTrackAtTime(track, currTime);
    if (!pos) continue;
    const g = getBoxPixels(pos, rect);
    const groundY = Math.min(rect.y + rect.h - 4, g.py + g.halfH * 0.88);
    const insidePad =
      x >= g.px - g.halfW - 14 &&
      x <= g.px + g.halfW + 14 &&
      y >= g.py - g.halfH - 14 &&
      y <= g.py + g.halfH + 14;
    const dBody = Math.hypot(x - g.px, y - g.py);
    const dFoot = Math.hypot(x - g.px, y - groundY);
    const d = Math.min(dBody, dFoot);
    const maxSnapPx = Math.max(38, g.halfH * 0.95);
    if ((insidePad || d <= maxSnapPx) && d < bestDist) {
      bestDist = d;
      best = { track, pos };
    }
  }
  return best;
}

function formatStageTimeShort(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const totalSec = Math.floor(seconds + 1e-6);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function clamp01(v: number): number {
  return Math.max(0.01, Math.min(0.99, v));
}
