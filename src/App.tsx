import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  ArrowRight,
  BoxSelect,
  Check,
  ChevronRight,
  Crosshair,
  Disc,
  Download,
  Eraser,
  Eye,
  EyeOff,
  Layers,
  Link2,
  MousePointer2,
  Pause,
  Pentagon,
  Pipette,
  Play,
  Redo2,
  RotateCcw,
  ScanSearch,
  SlidersHorizontal,
  Square,
  Sun,
  Trash,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import { ExportClipModal } from './components/ExportClipModal';
import { OpfsSidebar } from './components/OpfsSidebar';
import { formatTimecode, PlayerTransport } from './components/PlayerTransport';
import { TracksInspector } from './components/TracksInspector';
import { VideoTrackingStage } from './components/VideoTrackingStage';
import {
  DEFAULT_CHAIN_SETTINGS,
  DEFAULT_CHROMA_KEY_SETTINGS,
  DEFAULT_CV_SETTINGS,
  DEFAULT_PITCH_GREEN,
  DEFAULT_POLYGON_SETTINGS,
  DEFAULT_RING_SETTINGS,
  DEFAULT_RING_THICKNESS,
  DEFAULT_SPOTLIGHT_SETTINGS,
  MAX_RING_SIZE,
  MAX_RING_THICKNESS,
  MIN_RING_SIZE,
  MIN_RING_THICKNESS,
  PLAYER_COLORS,
  POLYGON_COLORS,
  RING_COLORS,
  SPOTLIGHT_COLORS,
  type BackgroundPlayerTrackRecord,
  type ChainProperties,
  type ChainSettings,
  type ChromaKeySettings,
  type CirclePosition,
  type CircleStyle,
  type CvTrackerSettings,
  type DetectedPlayerBox,
  type DetectorShapeStats,
  type DetectorSubTool,
  type ImplementedTrackRecord,
  type OpfsVideoEntry,
  type PolygonProperties,
  type PolygonSettings,
  type RingProperties,
  type RingSettings,
  type SpotlightProperties,
  type SpotlightSettings,
  type StorageUsageInfo,
  type ToolMode,
  type TrackedNode,
  type TrackedPlayer,
} from './types/tracking';
import { sampleImplementedTrackAtTime } from './cv/overlayRenderer';
import {
  deleteOpfsVideo,
  getOpfsStorageEstimate,
  getOpfsVideoFile,
  listOpfsVideos,
  saveFileToOpfs,
} from './utils/opfs';
import { generateSampleFootballMatchBlob } from './utils/sampleMatchGenerator';
import { analyzeTrackingCoverage } from './utils/trackingCoverage';

export default function App() {
  const [videos, setVideos] = useState<OpfsVideoEntry[]>([]);
  const [activeVideoName, setActiveVideoName] = useState<string | null>(null);
  const [activeVideoUrl, setActiveVideoUrl] = useState<string | null>(null);
  const [storageInfo, setStorageInfo] = useState<StorageUsageInfo>({
    usageBytes: 0,
    quotaBytes: 0,
    backend: 'opfs',
  });

  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isGeneratingSample, setIsGeneratingSample] = useState(false);
  const [sampleProgress, setSampleProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Playback state
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isLooping, setIsLooping] = useState(false);
  const [seekRequest, setSeekRequest] = useState<{ time: number; seq: number } | null>(null);
  const [reanchorRequest, setReanchorRequest] = useState<{
    playerId: string;
    nodeId?: string | null;
    seq: number;
  } | null>(null);

  // Tool, Circle & Spotlight Tracking state
  const [toolMode, setToolMode] = useState<ToolMode>('circle');
  const [activeColor, setActiveColor] = useState<string>(PLAYER_COLORS[0].hex);
  const activeStyle: CircleStyle = 'ring';
  const [showTrails, setShowTrails] = useState(true);
  const [spotlightSettings, setSpotlightSettings] = useState<SpotlightSettings>(
    DEFAULT_SPOTLIGHT_SETTINGS
  );
  const [ringSettings, setRingSettings] = useState<RingSettings>(DEFAULT_RING_SETTINGS);
  const [chainSettings, setChainSettings] = useState<ChainSettings>(DEFAULT_CHAIN_SETTINGS);
  const [polygonSettings, setPolygonSettings] = useState<PolygonSettings>(DEFAULT_POLYGON_SETTINGS);
  const [players, setPlayers] = useState<TrackedPlayer[]>([]);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [realigningPlayerId, setRealigningPlayerId] = useState<string | null>(null);
  const [realigningNodeId, setRealigningNodeId] = useState<string | null>(null);
  const [cvSettings, setCvSettings] = useState<CvTrackerSettings>(DEFAULT_CV_SETTINGS);
  const [chromaKey, setChromaKey] = useState<ChromaKeySettings>(DEFAULT_CHROMA_KEY_SETTINGS);
  const [showChromaBar, setShowChromaBar] = useState(false);
  const [isSamplingPitch, setIsSamplingPitch] = useState(false);
  const [needsChromaPrompt, setNeedsChromaPrompt] = useState(false);
  const [detectedBoxes, setDetectedBoxes] = useState<DetectedPlayerBox[]>([]);
  const [backgroundTracks, setBackgroundTracks] = useState<BackgroundPlayerTrackRecord[]>([]);
  const [implementedTracks, setImplementedTracks] = useState<ImplementedTrackRecord[]>([]);
  const [fullSweepTimes, setFullSweepTimes] = useState<number[]>([]);
  const [implementedFullSweepTimes, setImplementedFullSweepTimes] = useState<number[]>([]);
  const [showCoverageOverlay, setShowCoverageOverlay] = useState<boolean>(true);
  const [hoveredTrackedPlayerId, setHoveredTrackedPlayerId] = useState<string | null>(null);
  const [selectedDetectedBoxId, setSelectedDetectedBoxId] = useState<string | null>(null);
  const [showDetectedBoxes, setShowDetectedBoxes] = useState(false);
  const [showPlayerBoxBar, setShowPlayerBoxBar] = useState(false);
  const [detectorSubTool, setDetectorSubTool] = useState<DetectorSubTool>(null);
  const [detectorStats, setDetectorStats] = useState<DetectorShapeStats>({
    positiveCount: 0,
    negativeCount: 0,
    isTrained: false,
  });
  const [detectRequestSeq, setDetectRequestSeq] = useState(0);
  const [resetDetectorSeq, setResetDetectorSeq] = useState(0);
  const [clearDetectedSeq, setClearDetectedSeq] = useState(0);
  const [eraseSelectedDetectedSeq, setEraseSelectedDetectedSeq] = useState(0);
  const [isSlowTrackingDetected, setIsSlowTrackingDetected] = useState(false);
  const [slowTrackProgress, setSlowTrackProgress] = useState(0);
  const [implementRequest, setImplementRequest] = useState<{
    seq: number;
    targetId: string | null;
  } | null>(null);
  const [undoRedoState, setUndoRedoState] = useState({ canUndo: false, canRedo: false });
  const [showSectionMenu, setShowSectionMenu] = useState(false);
  const [showLeftPanel, setShowLeftPanel] = useState(false);
  const [showRightPanel, setShowRightPanel] = useState(true);
  const [showVisionSettings, setShowVisionSettings] = useState(true);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [videoDimensions, setVideoDimensions] = useState<{ width: number; height: number }>({
    width: 1280,
    height: 720,
  });
  const [stageRenderWidth, setStageRenderWidth] = useState(960);

  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const headerFileInputRef = useRef<HTMLInputElement>(null);
  const sectionMenuRef = useRef<HTMLDivElement>(null);
  const activeUrlRef = useRef<string | null>(null);
  const playerCounterRef = useRef(1);
  const spotlightCounterRef = useRef(1);
  const ringCounterRef = useRef(1);
  const chainCounterRef = useRef(1);
  const polygonCounterRef = useRef(1);
  const playersRef = useRef<TrackedPlayer[]>(players);
  playersRef.current = players;
  const undoStackRef = useRef<TrackedPlayer[][]>([]);
  const redoStackRef = useRef<TrackedPlayer[][]>([]);

  const syncUndoRedoFlags = useCallback(() => {
    setUndoRedoState({
      canUndo: undoStackRef.current.length > 0,
      canRedo: redoStackRef.current.length > 0,
    });
  }, []);

  const pushUndoSnapshot = useCallback(() => {
    undoStackRef.current = [...undoStackRef.current.slice(-39), playersRef.current];
    redoStackRef.current = [];
    syncUndoRedoFlags();
  }, [syncUndoRedoFlags]);

  const handleUndo = useCallback(() => {
    if (undoStackRef.current.length === 0) return;
    const prevSnapshot = undoStackRef.current[undoStackRef.current.length - 1];
    undoStackRef.current = undoStackRef.current.slice(0, -1);
    redoStackRef.current = [...redoStackRef.current, playersRef.current];
    setPlayers(prevSnapshot);
    setRealigningPlayerId(null);
    setRealigningNodeId(null);
    setSelectedPlayerId((curr) =>
      curr && prevSnapshot.some((p) => p.id === curr) ? curr : prevSnapshot[prevSnapshot.length - 1]?.id ?? null
    );
    setSelectedNodeId((curr) =>
      curr && prevSnapshot.some((p) => p.nodes?.some((n) => n.id === curr)) ? curr : null
    );
    syncUndoRedoFlags();
  }, [syncUndoRedoFlags]);

  const handleRedo = useCallback(() => {
    if (redoStackRef.current.length === 0) return;
    const nextSnapshot = redoStackRef.current[redoStackRef.current.length - 1];
    redoStackRef.current = redoStackRef.current.slice(0, -1);
    undoStackRef.current = [...undoStackRef.current, playersRef.current];
    setPlayers(nextSnapshot);
    setRealigningPlayerId(null);
    setRealigningNodeId(null);
    setSelectedPlayerId((curr) =>
      curr && nextSnapshot.some((p) => p.id === curr) ? curr : nextSnapshot[nextSnapshot.length - 1]?.id ?? null
    );
    setSelectedNodeId((curr) =>
      curr && nextSnapshot.some((p) => p.nodes?.some((n) => n.id === curr)) ? curr : null
    );
    syncUndoRedoFlags();
  }, [syncUndoRedoFlags]);

  const refreshLibrary = useCallback(async () => {
    const [list, estimate] = await Promise.all([
      listOpfsVideos(),
      getOpfsStorageEstimate(),
    ]);
    setVideos(list);
    setStorageInfo(estimate);
    return list;
  }, []);

  const loadVideoFromOpfs = useCallback(async (fileName: string) => {
    try {
      setErrorMessage(null);
      const file = await getOpfsVideoFile(fileName);
      if (!file) {
        setErrorMessage(`Could not locate "${fileName}" in OPFS.`);
        return;
      }

      if (activeUrlRef.current) {
        URL.revokeObjectURL(activeUrlRef.current);
      }

      const objectUrl = URL.createObjectURL(file);
      activeUrlRef.current = objectUrl;

      setIsPlaying(false);
      setIsExportModalOpen(false);
      setCurrentTime(0);
      setDuration(0);
      setPlayers([]);
      setSelectedPlayerId(null);
      setSelectedNodeId(null);
      setRealigningPlayerId(null);
      setRealigningNodeId(null);
      setIsSamplingPitch(false);
      setNeedsChromaPrompt(false);
      setDetectedBoxes([]);
      setBackgroundTracks([]);
      setImplementedTracks([]);
      setFullSweepTimes([]);
      setImplementedFullSweepTimes([]);
      setHoveredTrackedPlayerId(null);
      setSelectedDetectedBoxId(null);
      setIsSlowTrackingDetected(false);
      setSlowTrackProgress(0);
      setShowDetectedBoxes(false);
      setShowPlayerBoxBar(false);
      setDetectorSubTool(null);
      setDetectorStats({ positiveCount: 0, negativeCount: 0, isTrained: false });
      setResetDetectorSeq((s) => s + 1);
      playerCounterRef.current = 1;
      spotlightCounterRef.current = 1;
      ringCounterRef.current = 1;
      chainCounterRef.current = 1;
      polygonCounterRef.current = 1;
      undoStackRef.current = [];
      redoStackRef.current = [];
      syncUndoRedoFlags();
      setActiveVideoName(fileName);
      setActiveVideoUrl(objectUrl);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Failed to load video from OPFS.'
      );
    }
  }, [syncUndoRedoFlags]);

  // Load OPFS library on mount
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const list = await refreshLibrary();
        if (mounted && list.length > 0) {
          await loadVideoFromOpfs(list[0].name);
        }
      } catch (err) {
        if (mounted) {
          setErrorMessage(
            err instanceof Error ? err.message : 'Unable to access OPFS storage.'
          );
        }
      }
    })();

    return () => {
      mounted = false;
      if (activeUrlRef.current) {
        URL.revokeObjectURL(activeUrlRef.current);
      }
    };
  }, [refreshLibrary, loadVideoFromOpfs]);

  const handleUploadFiles = useCallback(
    async (files: FileList) => {
      const file = files[0];
      if (!file) return;

      setIsUploading(true);
      setUploadProgress(0);
      setErrorMessage(null);

      try {
        const saved = await saveFileToOpfs(file, file.name, setUploadProgress);
        await refreshLibrary();
        await loadVideoFromOpfs(saved.name);
      } catch (err) {
        setErrorMessage(
          err instanceof Error ? err.message : 'Failed to store video file in OPFS.'
        );
      } finally {
        setIsUploading(false);
      }
    },
    [refreshLibrary, loadVideoFromOpfs]
  );

  const handleGenerateSample = useCallback(async () => {
    if (isGeneratingSample) return;
    setIsGeneratingSample(true);
    setSampleProgress(0);
    setErrorMessage(null);

    try {
      const blob = await generateSampleFootballMatchBlob((pct) => {
        setSampleProgress(pct);
      });
      const sampleName = `tactical_match_derby_${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.webm`;
      const saved = await saveFileToOpfs(blob, sampleName);
      await refreshLibrary();
      await loadVideoFromOpfs(saved.name);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Failed to generate sample match video.'
      );
    } finally {
      setIsGeneratingSample(false);
    }
  }, [isGeneratingSample, refreshLibrary, loadVideoFromOpfs]);

  const handleDeleteVideo = useCallback(
    async (fileName: string) => {
      await deleteOpfsVideo(fileName);
      const updated = await refreshLibrary();

      if (fileName === activeVideoName) {
        if (activeUrlRef.current) {
          URL.revokeObjectURL(activeUrlRef.current);
          activeUrlRef.current = null;
        }
        setIsPlaying(false);
        setIsExportModalOpen(false);
        setActiveVideoName(null);
        setActiveVideoUrl(null);
        setPlayers([]);
        setSelectedPlayerId(null);
        setSelectedNodeId(null);
        setRealigningPlayerId(null);
        setRealigningNodeId(null);
        setNeedsChromaPrompt(false);
        setDetectedBoxes([]);
        setBackgroundTracks([]);
        setImplementedTracks([]);
        setFullSweepTimes([]);
        setImplementedFullSweepTimes([]);
        setHoveredTrackedPlayerId(null);
        setSelectedDetectedBoxId(null);
        setIsSlowTrackingDetected(false);
        setSlowTrackProgress(0);
        setShowDetectedBoxes(false);
        setShowPlayerBoxBar(false);
        setDetectorSubTool(null);
        setDetectorStats({ positiveCount: 0, negativeCount: 0, isTrained: false });
        setResetDetectorSeq((s) => s + 1);
        undoStackRef.current = [];
        redoStackRef.current = [];
        syncUndoRedoFlags();
        setCurrentTime(0);
        setDuration(0);

        if (updated.length > 0) {
          await loadVideoFromOpfs(updated[0].name);
        }
      }
    },
    [activeVideoName, refreshLibrary, loadVideoFromOpfs, syncUndoRedoFlags]
  );

  // Playback & Tracking Phase Play/Pause handlers
  const handleTogglePlay = useCallback(() => {
    if (!activeVideoUrl) return;
    setIsSamplingPitch(false);
    if (showPlayerBoxBar) {
      setIsPlaying(false);
      setShowDetectedBoxes(true);
      setIsSlowTrackingDetected((prev) => !prev);
      return;
    }
    setIsSlowTrackingDetected(false);
    setIsPlaying((prev) => !prev);
  }, [activeVideoUrl, showPlayerBoxBar]);

  const handleSeek = useCallback((time: number) => {
    setIsSlowTrackingDetected(false);
    setSeekRequest((prev) => ({ time, seq: (prev?.seq ?? 0) + 1 }));
    setCurrentTime(time);
  }, []);

  const handleStepFrame = useCallback(
    (direction: -1 | 1) => {
      const video = videoElRef.current;
      if (!video || isPlaying || isSlowTrackingDetected) return;
      const frameStep = 1 / 30;
      const target = Math.max(
        0,
        Math.min(duration || Infinity, video.currentTime + direction * frameStep)
      );
      handleSeek(target);
    },
    [isPlaying, isSlowTrackingDetected, duration, handleSeek]
  );

  const handleSkipSeconds = useCallback(
    (deltaSeconds: number) => {
      const video = videoElRef.current;
      const baseTime = video ? video.currentTime : currentTime;
      const maxT = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
      const target = Math.max(0, Math.min(maxT, baseTime + deltaSeconds));
      handleSeek(target);
    },
    [currentTime, duration, handleSeek]
  );

  const handleSamplePitchColor = useCallback((hex: string) => {
    const normalized = hex.toUpperCase();
    setChromaKey((prev) => {
      if (!prev.hasCustomSamples) {
        return {
          ...prev,
          keyColors: [normalized],
          hasCustomSamples: true,
        };
      }
      const alreadyNear = prev.keyColors.some((existing) => hexRgbDistance(existing, normalized) <= 6);
      if (alreadyNear) {
        return prev;
      }
      const nextColors = [...prev.keyColors, normalized].slice(-12);
      return {
        ...prev,
        keyColors: nextColors,
        hasCustomSamples: true,
      };
    });
  }, []);

  const handleRemoveKeyColor = useCallback((index: number) => {
    setChromaKey((prev) => {
      const next = prev.keyColors.filter((_, i) => i !== index);
      if (next.length === 0) {
        return {
          ...prev,
          keyColors: [DEFAULT_PITCH_GREEN],
          hasCustomSamples: false,
        };
      }
      return {
        ...prev,
        keyColors: next,
      };
    });
  }, []);

  const handleRunPlayerDetector = useCallback(() => {
    if (!activeVideoUrl) return;
    setIsPlaying(false);
    setIsSlowTrackingDetected(false);
    setSlowTrackProgress(0);
    setRealigningPlayerId(null);
    setRealigningNodeId(null);

    if (!chromaKey.hasCustomSamples) {
      setShowPlayerBoxBar(false);
      setDetectorSubTool(null);
      setShowChromaBar(true);
      setIsSamplingPitch(true);
      setNeedsChromaPrompt(true);
      setChromaKey((prev) => ({ ...prev, showMask: true }));
      return;
    }

    setNeedsChromaPrompt(false);
    setIsSamplingPitch(false);
    setShowChromaBar(false);
    setSelectedPlayerId(null);
    setSelectedNodeId(null);
    setDetectedBoxes([]);
    setBackgroundTracks([]);
    setFullSweepTimes([]);
    setSelectedDetectedBoxId(null);
    setShowDetectedBoxes(true);
    setShowPlayerBoxBar(true);
    setShowCoverageOverlay(true);
    setDetectRequestSeq((s) => s + 1);
  }, [activeVideoUrl, chromaKey.hasCustomSamples]);

  const handleOpenPlayerBox = useCallback(() => {
    if (!activeVideoUrl) return;
    setIsPlaying(false);
    setRealigningPlayerId(null);
    setRealigningNodeId(null);
    setSelectedPlayerId(null);
    setSelectedNodeId(null);
    setIsSamplingPitch(false);
    setShowChromaBar(false);
    setNeedsChromaPrompt(false);
    setShowDetectedBoxes(true);
    setShowPlayerBoxBar(true);
    setShowCoverageOverlay(true);
    setDetectorSubTool((curr) => (curr === 'drawer' || curr === 'eraser' ? curr : null));
  }, [activeVideoUrl]);

  const handleDetectedBoxesResult = useCallback(
    (boxes: DetectedPlayerBox[], stats: DetectorShapeStats) => {
      setDetectedBoxes(boxes);
      setSelectedDetectedBoxId(null);
      setIsSlowTrackingDetected(false);
      setSlowTrackProgress(0);
      setDetectorStats(stats);
      setShowDetectedBoxes(true);
      setShowPlayerBoxBar(true);
    },
    []
  );

  const handleAddDetectedBoxManual = useCallback(
    (box: DetectedPlayerBox, stats: DetectorShapeStats) => {
      setDetectedBoxes((prev) => [...prev, box]);
      setSelectedDetectedBoxId(null);
      setDetectorStats(stats);
      setShowDetectedBoxes(true);
    },
    []
  );

  const handleEraseDetectedBox = useCallback(
    (boxId: string, stats: DetectorShapeStats) => {
      setDetectedBoxes((prev) => prev.filter((b) => b.id !== boxId));
      setSelectedDetectedBoxId((curr) => (curr === boxId ? null : curr));
      setDetectorStats(stats);
    },
    []
  );

  const handleSlowTrackStep = useCallback(
    (boxes: DetectedPlayerBox[], time: number, progressPct: number) => {
      setDetectedBoxes(boxes);
      setCurrentTime(time);
      setSlowTrackProgress(progressPct);
    },
    []
  );

  const handleImplementTrackedTracks = useCallback(
    (records: BackgroundPlayerTrackRecord[], sweepTimes: number[] = []) => {
      if (records.length === 0) return;

      const isAttachedOverlay = (p: TrackedPlayer) =>
        Boolean(p.attachedTrackId) || Boolean(p.nodes?.some((n) => Boolean(n.attachedTrackId)));
      const removedIds = new Set(
        playersRef.current.filter(isAttachedOverlay).map((p) => p.id)
      );
      if (removedIds.size > 0) {
        pushUndoSnapshot();
      }

      const nextImplemented: ImplementedTrackRecord[] = records.map((rec, i) => ({
        ...rec,
        label: `Player ${i + 1}`,
      }));

      setImplementedTracks(nextImplemented);
      setImplementedFullSweepTimes(sweepTimes);
      setFullSweepTimes([]);
      setHoveredTrackedPlayerId(null);

      if (removedIds.size > 0) {
        setPlayers((prev) =>
          prev
            .filter((p) => !removedIds.has(p.id))
            .map((p) =>
              p.style === 'chain' && p.linkedRingIds
                ? { ...p, linkedRingIds: p.linkedRingIds.filter((rid) => !removedIds.has(rid)) }
                : p
            )
            .filter((p) => !(p.style === 'chain' && p.linkedRingIds && p.linkedRingIds.length < 2))
        );
        setSelectedPlayerId((curr) => (curr && removedIds.has(curr) ? null : curr));
        setSelectedNodeId(null);
      }

      // Hide all tracking bounding boxes and clear temporary detector/tracker buffers after implement
      setIsSlowTrackingDetected(false);
      setSlowTrackProgress(0);
      setShowPlayerBoxBar(false);
      setShowDetectedBoxes(false);
      setDetectorSubTool(null);
      setDetectedBoxes([]);
      setBackgroundTracks([]);
      setSelectedDetectedBoxId(null);
      setClearDetectedSeq((s) => s + 1);
    },
    [pushUndoSnapshot]
  );

  const handleAttachToolToTrack = useCallback(
    (trackId: string, style: 'ring' | 'foot-ring' | 'spotlight') => {
      const track = implementedTracks.find((t) => t.id === trackId);
      if (!track || track.positions.length === 0) return;

      const hist = track.positions.slice();
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

      const currTime = videoElRef.current ? videoElRef.current.currentTime : currentTime;
      const currPos = sampleImplementedTrackAtTime(track, currTime) ?? first;
      const rawStop = hist.length > 1 ? last.time : Math.round((first.time + 10) * 100) / 100;
      const stopTime =
        duration > 0 ? Math.min(duration, Math.max(first.time + 0.1, rawStop)) : rawStop;
      const stamp = Date.now();

      pushUndoSnapshot();
      let created: TrackedPlayer;
      if (style === 'spotlight') {
        const idx = spotlightCounterRef.current++;
        created = {
          id: `spotlight_${stamp}_${idx}`,
          label: `${track.label} · Spot`,
          color: spotlightSettings.color,
          style: 'spotlight',
          visible: true,
          showTrail: false,
          trackWithCv: true,
          attachedTrackId: track.id,
          spotlight: {
            beamSize: spotlightSettings.beamSize,
            intensity: spotlightSettings.intensity,
            rotation: spotlightSettings.rotation,
          },
          anchorTime: first.time,
          inTime: first.time,
          stopTime,
          stopReason: 'manual',
          anchorPosition: first,
          keyframes,
          currentPosition: currPos,
          history: hist,
        };
      } else if (style === 'foot-ring') {
        const idx = ringCounterRef.current++;
        created = {
          id: `ring_${stamp}_${idx}`,
          label: `${track.label} · Ring`,
          color: ringSettings.color,
          style: 'foot-ring',
          visible: true,
          showTrail: false,
          trackWithCv: true,
          attachedTrackId: track.id,
          ring: {
            ringSize: ringSettings.ringSize,
            ringThickness: ringSettings.ringThickness,
            tiltDeg: ringSettings.tiltDeg,
            spinSpeed: ringSettings.spinSpeed,
          },
          anchorTime: first.time,
          inTime: first.time,
          stopTime,
          stopReason: 'manual',
          anchorPosition: first,
          keyframes,
          currentPosition: currPos,
          history: hist,
        };
      } else {
        const idx = playerCounterRef.current++;
        const color =
          playersRef.current.length === 0
            ? activeColor
            : PLAYER_COLORS[(idx - 1) % PLAYER_COLORS.length].hex;
        created = {
          id: `player_${stamp}_${idx}`,
          label: track.label,
          color,
          style: 'ring',
          visible: true,
          showTrail: true,
          trackWithCv: true,
          attachedTrackId: track.id,
          anchorTime: first.time,
          inTime: first.time,
          stopTime,
          stopReason: 'manual',
          anchorPosition: first,
          keyframes,
          currentPosition: currPos,
          history: hist,
        };
      }

      setPlayers((prev) => [...prev, created]);
      setSelectedPlayerId(created.id);
      setSelectedNodeId(null);
    },
    [
      implementedTracks,
      currentTime,
      duration,
      pushUndoSnapshot,
      spotlightSettings,
      ringSettings,
      activeColor,
    ]
  );

  // Circle & Spotlight tool handlers
  const handleAddPlayerCircle = useCallback(
    (pos: CirclePosition): string => {
      const idx = playerCounterRef.current++;
      const color =
        players.length === 0
          ? activeColor
          : PLAYER_COLORS[(idx - 1) % PLAYER_COLORS.length].hex;
      const id = `player_${Date.now()}_${idx}`;
      const rawStop = Math.round((pos.time + 10) * 100) / 100;
      const initialStopTime = duration > 0 ? Math.min(duration, rawStop) : rawStop;

      const newPlayer: TrackedPlayer = {
        id,
        label: `Player ${idx}`,
        color,
        style: activeStyle,
        visible: true,
        showTrail: true,
        trackWithCv: true,
        anchorTime: pos.time,
        inTime: pos.time,
        stopTime: initialStopTime,
        stopReason: 'manual',
        anchorPosition: pos,
        keyframes: [pos],
        currentPosition: pos,
        history: [pos],
      };

      setPlayers((prev) => [...prev, newPlayer]);
      setActiveColor(color);
      return id;
    },
    [activeColor, activeStyle, duration, players.length]
  );

  const handleAddSpotlight = useCallback(
    (pos: CirclePosition, beamSizeOverride?: number): string => {
      const idx = spotlightCounterRef.current++;
      const id = `spotlight_${Date.now()}_${idx}`;
      const effectiveBeamSize = Math.max(
        30,
        Math.min(150, beamSizeOverride ?? spotlightSettings.beamSize)
      );
      const rawStop = Math.round((pos.time + 10) * 100) / 100;
      const initialStopTime = duration > 0 ? Math.min(duration, rawStop) : rawStop;

      const newSpotlight: TrackedPlayer = {
        id,
        label: `Spotlight ${idx}`,
        color: spotlightSettings.color,
        style: 'spotlight',
        visible: true,
        showTrail: false,
        trackWithCv: spotlightSettings.trackWithCv,
        spotlight: {
          beamSize: effectiveBeamSize,
          intensity: spotlightSettings.intensity,
          rotation: spotlightSettings.rotation,
        },
        anchorTime: pos.time,
        inTime: pos.time,
        stopTime: initialStopTime,
        stopReason: 'manual',
        anchorPosition: pos,
        keyframes: [pos],
        currentPosition: pos,
        history: [pos],
      };

      setPlayers((prev) => [...prev, newSpotlight]);
      return id;
    },
    [duration, spotlightSettings]
  );

  const handleAddRing = useCallback(
    (pos: CirclePosition, ringSizeOverride?: number): string => {
      const idx = ringCounterRef.current++;
      const id = `ring_${Date.now()}_${idx}`;
      const effectiveRingSize = Math.max(
        MIN_RING_SIZE,
        Math.min(MAX_RING_SIZE, ringSizeOverride ?? ringSettings.ringSize)
      );
      const rawStop = Math.round((pos.time + 10) * 100) / 100;
      const initialStopTime = duration > 0 ? Math.min(duration, rawStop) : rawStop;

      const newRing: TrackedPlayer = {
        id,
        label: `Ring ${idx}`,
        color: ringSettings.color,
        style: 'foot-ring',
        visible: true,
        showTrail: false,
        trackWithCv: ringSettings.trackWithCv,
        ring: {
          ringSize: effectiveRingSize,
          ringThickness: ringSettings.ringThickness,
          tiltDeg: ringSettings.tiltDeg,
          spinSpeed: ringSettings.spinSpeed,
        },
        anchorTime: pos.time,
        inTime: pos.time,
        stopTime: initialStopTime,
        stopReason: 'manual',
        anchorPosition: pos,
        keyframes: [pos],
        currentPosition: pos,
        history: [pos],
      };

      setPlayers((prev) => [...prev, newRing]);
      return id;
    },
    [duration, ringSettings]
  );

  const handleAddChainFromRings = useCallback(
    (linkedRingIds: string[]): string => {
      const uniqueIds = Array.from(new Set(linkedRingIds));
      const linkedRings = uniqueIds
        .map((rid) => playersRef.current.find((p) => p.id === rid && p.style === 'foot-ring'))
        .filter((p): p is TrackedPlayer => Boolean(p));
      if (linkedRings.length < 2) return '';

      const idx = chainCounterRef.current++;
      const id = `chain_${Date.now()}_${idx}`;
      const minIn = Math.min(...linkedRings.map((r) => r.inTime ?? r.anchorTime));
      const allHaveStop = linkedRings.every((r) => r.stopTime !== undefined);
      const maxStop = allHaveStop
        ? Math.max(...linkedRings.map((r) => r.stopTime!))
        : undefined;
      const basePos: CirclePosition = {
        ...linkedRings[0].currentPosition,
        status: 'anchored',
        time: currentTime,
      };

      const newChain: TrackedPlayer = {
        id,
        label: `Chain ${idx}`,
        color: chainSettings.color,
        style: 'chain',
        visible: true,
        showTrail: false,
        trackWithCv: false,
        linkedRingIds: linkedRings.map((r) => r.id),
        chain: {
          ringSize: chainSettings.ringSize,
          ringThickness: chainSettings.ringThickness,
          tiltDeg: chainSettings.tiltDeg,
          spinSpeed: chainSettings.spinSpeed,
          connectorWidth: chainSettings.connectorWidth,
          dashed: chainSettings.dashed,
        },
        anchorTime: minIn,
        inTime: minIn,
        stopTime: maxStop,
        stopReason: maxStop !== undefined ? 'manual' : undefined,
        anchorPosition: basePos,
        keyframes: [basePos],
        currentPosition: basePos,
        history: [basePos],
      };

      setPlayers((prev) => [...prev, newChain]);
      return id;
    },
    [chainSettings, currentTime]
  );

  const handleAddPolygon = useCallback(
    (nodes: TrackedNode[]): string => {
      const idx = polygonCounterRef.current++;
      const id = `polygon_${Date.now()}_${idx}`;
      const basePos: CirclePosition = nodes[0]?.anchorPosition ?? {
        cx: 0.5,
        cy: 0.5,
        width: 0.04,
        height: 0.08,
        radius: 0.03,
        confidence: 1,
        status: polygonSettings.trackWithCv ? 'tracking' : 'anchored',
        time: currentTime,
      };
      const minAnchor =
        nodes.length > 0 ? Math.min(...nodes.map((n) => n.anchorTime)) : basePos.time;
      const hasAttachedNodes = nodes.some((n) => Boolean(n.attachedTrackId));
      const rawStop =
        nodes.length > 0 && nodes.every((n) => n.stopTime !== undefined)
          ? Math.max(...nodes.map((n) => n.stopTime!))
          : Math.round((minAnchor + 10) * 100) / 100;
      const initialStopTime =
        duration > 0 ? Math.min(duration, Math.max(minAnchor + 0.1, rawStop)) : rawStop;

      const newPolygon: TrackedPlayer = {
        id,
        label: `Polygon ${idx}`,
        color: polygonSettings.borderColor,
        style: 'polygon',
        visible: true,
        showTrail: false,
        trackWithCv: polygonSettings.trackWithCv,
        ...(hasAttachedNodes ? { attachedTrackId: nodes.find((n) => n.attachedTrackId)?.attachedTrackId } : {}),
        polygon: {
          borderColor: polygonSettings.borderColor,
          borderThickness: polygonSettings.borderThickness,
          dashedBorder: polygonSettings.dashedBorder,
          fillColor: polygonSettings.fillColor,
          fillOpacity: polygonSettings.fillOpacity,
          markerSize: polygonSettings.markerSize,
        },
        nodes: nodes.map((n) => ({
          ...n,
          trackWithCv: polygonSettings.trackWithCv,
        })),
        anchorTime: minAnchor,
        inTime: minAnchor,
        stopTime: initialStopTime,
        stopReason: 'manual',
        anchorPosition: basePos,
        keyframes: [basePos],
        currentPosition: basePos,
        history: [basePos],
      };

      setPlayers((prev) => [...prev, newPolygon]);
      return id;
    },
    [currentTime, duration, polygonSettings]
  );

  const handleUpdatePlayerAnchor = useCallback(
    (playerId: string, pos: CirclePosition, extraSizePx?: number) => {
      setPlayers((prev) =>
        prev.map((p) => {
          if (p.id !== playerId) return p;
          const isInitialOrEarlier = pos.time <= p.anchorTime + 0.04;
          const nextKeyframes = [
            ...p.keyframes.filter((kf) => kf.time < pos.time - 0.04),
            pos,
          ];
          const nextSpotlight =
            p.style === 'spotlight' && extraSizePx !== undefined
              ? {
                  beamSize: Math.max(30, Math.min(150, extraSizePx)),
                  intensity: p.spotlight?.intensity ?? spotlightSettings.intensity,
                  rotation: p.spotlight?.rotation ?? spotlightSettings.rotation,
                }
              : p.spotlight;
          const nextRing =
            p.style === 'foot-ring' && extraSizePx !== undefined
              ? {
                  ringSize: Math.max(MIN_RING_SIZE, Math.min(MAX_RING_SIZE, extraSizePx)),
                  ringThickness: p.ring?.ringThickness ?? ringSettings.ringThickness,
                  tiltDeg: p.ring?.tiltDeg ?? ringSettings.tiltDeg,
                  spinSpeed: p.ring?.spinSpeed ?? ringSettings.spinSpeed,
                }
              : p.ring;

          const shouldResumeFromStop =
            p.stopTime !== undefined && pos.time >= p.stopTime - 0.04;
          const rawExtendedStop = Math.round((pos.time + 10) * 100) / 100;
          const extendedStop = duration > 0 ? Math.min(duration, rawExtendedStop) : rawExtendedStop;

          return {
            ...p,
            spotlight: nextSpotlight,
            ring: nextRing,
            anchorTime: isInitialOrEarlier ? pos.time : p.anchorTime,
            inTime:
              p.inTime !== undefined
                ? Math.min(p.inTime, pos.time)
                : isInitialOrEarlier
                  ? pos.time
                  : undefined,
            anchorPosition: isInitialOrEarlier ? pos : p.anchorPosition,
            keyframes: nextKeyframes,
            currentPosition: pos,
            history: [
              ...p.history.filter((pt) => pt.time < pos.time - 0.02),
              pos,
            ],
            ...(shouldResumeFromStop
              ? { stopTime: extendedStop, stopReason: 'manual' as const }
              : {}),
          };
        })
      );
    },
    [
      duration,
      spotlightSettings.intensity,
      spotlightSettings.rotation,
      ringSettings.ringThickness,
      ringSettings.tiltDeg,
      ringSettings.spinSpeed,
    ]
  );

  const handleUpdateNodeAnchor = useCallback(
    (playerId: string, nodeId: string, pos: CirclePosition) => {
      setPlayers((prev) =>
        prev.map((p) => {
          if (p.id !== playerId || !p.nodes) return p;

          const nextNodes = p.nodes.map((node) => {
            if (node.id !== nodeId) return node;
            const isInitialOrEarlier = pos.time <= node.anchorTime + 0.04;
            const nextKeyframes = [
              ...node.keyframes.filter((kf) => kf.time < pos.time - 0.04),
              pos,
            ];
            const shouldResumeNode =
              node.stopTime !== undefined && pos.time >= node.stopTime - 0.04;
            return {
              ...node,
              anchorTime: isInitialOrEarlier ? pos.time : node.anchorTime,
              anchorPosition: isInitialOrEarlier ? pos : node.anchorPosition,
              keyframes: nextKeyframes,
              currentPosition: pos,
              history: [
                ...node.history.filter((pt) => pt.time < pos.time - 0.02),
                pos,
              ],
              ...(shouldResumeNode
                ? { stopTime: undefined, stopReason: undefined }
                : {}),
            };
          });

          const shouldResumeParent =
            p.stopTime !== undefined && pos.time >= p.stopTime - 0.04;
          const rawExtendedStop = Math.round((pos.time + 10) * 100) / 100;
          const extendedStop = duration > 0 ? Math.min(duration, rawExtendedStop) : rawExtendedStop;
          const summaryPos = summarizeNodesPosition(nextNodes, p.currentPosition);

          return {
            ...p,
            nodes: nextNodes,
            anchorTime: Math.min(p.anchorTime, pos.time),
            inTime:
              p.inTime !== undefined
                ? Math.min(p.inTime, pos.time)
                : pos.time < p.anchorTime
                  ? pos.time
                  : undefined,
            currentPosition: summaryPos,
            ...(shouldResumeParent
              ? { stopTime: extendedStop, stopReason: 'manual' as const }
              : {}),
          };
        })
      );
    },
    [duration]
  );

  const handleShiftGroupAnchor = useCallback(
    (
      playerId: string,
      baseNodes: Array<{ id: string; cx: number; cy: number }>,
      dxNorm: number,
      dyNorm: number,
      time: number
    ) => {
      const baseMap = new Map(baseNodes.map((b) => [b.id, b]));
      setPlayers((prev) =>
        prev.map((p) => {
          if (p.id !== playerId || !p.nodes) return p;
          const nextNodes = p.nodes.map((node) => {
            const base = baseMap.get(node.id);
            if (!base) return node;
            const nextCx = Math.max(0.01, Math.min(0.99, base.cx + dxNorm));
            const nextCy = Math.max(0.01, Math.min(0.99, base.cy + dyNorm));
            const shiftedPos: CirclePosition = {
              ...node.currentPosition,
              cx: nextCx,
              cy: nextCy,
              confidence: 1,
              status: node.trackWithCv === false || p.trackWithCv === false ? 'anchored' : 'tracking',
              time,
            };
            const isInitialOrEarlier = time <= node.anchorTime + 0.04;
            const shouldResumeNode =
              node.stopTime !== undefined && time >= node.stopTime - 0.04;
            return {
              ...node,
              anchorTime: isInitialOrEarlier ? time : node.anchorTime,
              anchorPosition: isInitialOrEarlier ? shiftedPos : node.anchorPosition,
              keyframes: [
                ...node.keyframes.filter((kf) => kf.time < time - 0.04),
                shiftedPos,
              ],
              currentPosition: shiftedPos,
              history: [
                ...node.history.filter((pt) => pt.time < time - 0.02),
                shiftedPos,
              ],
              ...(shouldResumeNode
                ? { stopTime: undefined, stopReason: undefined }
                : {}),
            };
          });

          const shouldResumeParent =
            p.stopTime !== undefined && time >= p.stopTime - 0.04;
          const rawExtendedStop = Math.round((time + 10) * 100) / 100;
          const extendedStop = duration > 0 ? Math.min(duration, rawExtendedStop) : rawExtendedStop;
          const summaryPos = summarizeNodesPosition(nextNodes, p.currentPosition);

          return {
            ...p,
            nodes: nextNodes,
            anchorTime: Math.min(p.anchorTime, time),
            inTime:
              p.inTime !== undefined
                ? Math.min(p.inTime, time)
                : time < p.anchorTime
                  ? time
                  : undefined,
            currentPosition: summaryPos,
            ...(shouldResumeParent
              ? { stopTime: extendedStop, stopReason: 'manual' as const }
              : {}),
          };
        })
      );
    },
    [duration]
  );

  const handlePlayersTrackedFrame = useCallback(
    (updates: Map<string, CirclePosition>, recordHistory = true) => {
      setPlayers((prev) =>
        prev.map((p) => {
          if (p.nodes && p.nodes.length > 0) {
            let changed = false;
            const nextNodes = p.nodes.map((node) => {
              const nextPos = updates.get(node.id);
              if (!nextPos) return node;
              changed = true;
              if (!recordHistory) {
                return {
                  ...node,
                  currentPosition: nextPos,
                };
              }
              if (p.stopTime !== undefined && nextPos.time > p.stopTime + 0.02) {
                return node;
              }
              if (node.stopTime !== undefined && nextPos.time > node.stopTime + 0.02) {
                return node;
              }
              const nextHistory = appendPosToHistory(node.history, nextPos);
              if (nextPos.status === 'stopped') {
                return {
                  ...node,
                  stopTime: nextPos.time,
                  stopReason: 'out-of-frame' as const,
                  currentPosition: nextPos,
                  history: nextHistory.filter((pt) => pt.time <= nextPos.time + 0.005),
                };
              }
              return {
                ...node,
                currentPosition: nextPos,
                history: nextHistory,
              };
            });

            if (!changed) return p;

            const summaryPos = summarizeNodesPosition(nextNodes, p.currentPosition);
            const allStopped =
              recordHistory &&
              nextNodes.every((n) => n.stopTime !== undefined);
            if (allStopped) {
              const maxStopTime = Math.max(
                ...nextNodes.map((n) => n.stopTime ?? p.anchorTime)
              );
              const nextParentStop =
                p.stopTime !== undefined ? Math.min(p.stopTime, maxStopTime) : maxStopTime;
              return {
                ...p,
                nodes: nextNodes,
                stopTime: nextParentStop,
                stopReason: 'out-of-frame',
                currentPosition: { ...summaryPos, status: 'stopped', time: nextParentStop },
              };
            }

            return {
              ...p,
              nodes: nextNodes,
              currentPosition: summaryPos,
              history: recordHistory ? appendPosToHistory(p.history, summaryPos) : p.history,
            };
          }

          const nextPos = updates.get(p.id);
          if (!nextPos) return p;

          if (!recordHistory) {
            return {
              ...p,
              currentPosition: nextPos,
            };
          }

          // Never overwrite a stopped player past its registered stopTime
          if (p.stopTime !== undefined && nextPos.time > p.stopTime + 0.02) {
            return p;
          }

          const nextHistory = appendPosToHistory(p.history, nextPos);

          if (nextPos.status === 'stopped') {
            return {
              ...p,
              stopTime: nextPos.time,
              stopReason: 'out-of-frame',
              currentPosition: nextPos,
              history: nextHistory.filter((pt) => pt.time <= nextPos.time + 0.005),
            };
          }

          return {
            ...p,
            currentPosition: nextPos,
            history: nextHistory,
          };
        })
      );
    },
    []
  );

  const handlePlayersTrackedBatch = useCallback(
    (historyByPlayer: Map<string, CirclePosition[]>) => {
      if (historyByPlayer.size === 0) return;
      setPlayers((prev) =>
        prev.map((p) => {
          if (p.nodes && p.nodes.length > 0) {
            let changed = false;
            const nextNodes = p.nodes.map((node) => {
              const batch = historyByPlayer.get(node.id);
              if (!batch || batch.length === 0) return node;
              if (p.stopTime !== undefined && batch[0].time > p.stopTime + 0.02) {
                return node;
              }
              if (node.stopTime !== undefined && batch[0].time > node.stopTime + 0.02) {
                return node;
              }
              changed = true;
              const effectiveStop =
                p.stopTime !== undefined && node.stopTime !== undefined
                  ? Math.min(p.stopTime, node.stopTime)
                  : node.stopTime ?? p.stopTime;
              const applied = applyTrackedBatch(node.history, node.currentPosition, batch, effectiveStop);
              if (applied.stoppedPos) {
                return {
                  ...node,
                  stopTime: applied.stoppedPos.time,
                  stopReason: 'out-of-frame' as const,
                  currentPosition: applied.stoppedPos,
                  history: applied.nextHistory.filter(
                    (pt) => pt.time <= applied.stoppedPos!.time + 0.005
                  ),
                };
              }
              return {
                ...node,
                currentPosition: applied.latestPos,
                history: applied.nextHistory,
              };
            });

            if (!changed) return p;

            const summaryPos = summarizeNodesPosition(nextNodes, p.currentPosition);
            const allStopped = nextNodes.every((n) => n.stopTime !== undefined);
            if (allStopped) {
              const maxStopTime = Math.max(
                ...nextNodes.map((n) => n.stopTime ?? p.anchorTime)
              );
              const nextParentStop =
                p.stopTime !== undefined ? Math.min(p.stopTime, maxStopTime) : maxStopTime;
              return {
                ...p,
                nodes: nextNodes,
                stopTime: nextParentStop,
                stopReason: 'out-of-frame',
                currentPosition: { ...summaryPos, status: 'stopped', time: nextParentStop },
              };
            }

            return {
              ...p,
              nodes: nextNodes,
              currentPosition: summaryPos,
              history: appendPosToHistory(p.history, summaryPos),
            };
          }

          const batch = historyByPlayer.get(p.id);
          if (!batch || batch.length === 0) return p;
          if (p.stopTime !== undefined && batch[0].time > p.stopTime + 0.02) {
            return p;
          }

          const applied = applyTrackedBatch(p.history, p.currentPosition, batch, p.stopTime);

          if (applied.stoppedPos) {
            return {
              ...p,
              stopTime: applied.stoppedPos.time,
              stopReason: 'out-of-frame',
              currentPosition: applied.stoppedPos,
              history: applied.nextHistory.filter(
                (pt) => pt.time <= applied.stoppedPos!.time + 0.005
              ),
            };
          }

          return {
            ...p,
            currentPosition: applied.latestPos,
            history: applied.nextHistory,
          };
        })
      );
    },
    []
  );

  const handleStopTrackingPlayer = useCallback(
    (playerId: string) => {
      const stopAt = videoElRef.current ? videoElRef.current.currentTime : currentTime;
      pushUndoSnapshot();
      setPlayers((prev) =>
        prev.map((p) => {
          if (p.id !== playerId) return p;
          const effectiveStop = Math.max(p.anchorTime, stopAt);
          const keptKeyframes = p.keyframes.filter((kf) => kf.time <= effectiveStop + 0.03);
          const keptHistory = p.history.filter((pt) => pt.time <= effectiveStop + 0.03);
          const lastPt =
            keptHistory[keptHistory.length - 1] ??
            keptKeyframes[keptKeyframes.length - 1] ??
            p.anchorPosition;
          const stoppedPos: CirclePosition = {
            ...lastPt,
            time: effectiveStop,
            status: 'stopped',
          };
          const finalHistory =
            keptHistory.length === 0
              ? [
                  p.anchorPosition,
                  ...(effectiveStop > p.anchorTime + 0.02 ? [stoppedPos] : []),
                ]
              : Math.abs(keptHistory[keptHistory.length - 1].time - effectiveStop) > 0.025
                ? [...keptHistory, stoppedPos]
                : [
                    ...keptHistory.slice(0, -1),
                    { ...keptHistory[keptHistory.length - 1], status: 'stopped' as const },
                  ];

          const nextNodes = p.nodes?.map((node) => {
            const nodeStop = Math.max(node.anchorTime, effectiveStop);
            const nodeKeptKfs = node.keyframes.filter((kf) => kf.time <= nodeStop + 0.03);
            const nodeKeptHist = node.history.filter((pt) => pt.time <= nodeStop + 0.03);
            const nodeLast =
              nodeKeptHist[nodeKeptHist.length - 1] ??
              nodeKeptKfs[nodeKeptKfs.length - 1] ??
              node.anchorPosition;
            const nodeStoppedPos: CirclePosition = {
              ...nodeLast,
              time: nodeStop,
              status: 'stopped',
            };
            const nodeFinalHist =
              nodeKeptHist.length === 0
                ? [
                    node.anchorPosition,
                    ...(nodeStop > node.anchorTime + 0.02 ? [nodeStoppedPos] : []),
                  ]
                : Math.abs(nodeKeptHist[nodeKeptHist.length - 1].time - nodeStop) > 0.025
                  ? [...nodeKeptHist, nodeStoppedPos]
                  : [
                      ...nodeKeptHist.slice(0, -1),
                      { ...nodeKeptHist[nodeKeptHist.length - 1], status: 'stopped' as const },
                    ];
            return {
              ...node,
              keyframes: nodeKeptKfs.length > 0 ? nodeKeptKfs : [node.anchorPosition],
              history: nodeFinalHist,
              stopTime: nodeStop,
              stopReason: 'manual' as const,
              currentPosition: nodeStoppedPos,
            };
          });

          return {
            ...p,
            nodes: nextNodes,
            keyframes: keptKeyframes.length > 0 ? keptKeyframes : [p.anchorPosition],
            history: finalHistory,
            stopTime: effectiveStop,
            stopReason: 'manual',
            currentPosition: stoppedPos,
          };
        })
      );
      if (realigningPlayerId === playerId) {
        setRealigningPlayerId(null);
        setRealigningNodeId(null);
      }
    },
    [currentTime, pushUndoSnapshot, realigningPlayerId]
  );

  const handleResumeTrackingPlayer = useCallback(
    (playerId: string) => {
      const target = playersRef.current.find((p) => p.id === playerId);
      if (!target) return;

      const nowT = videoElRef.current ? videoElRef.current.currentTime : currentTime;
      const oldStop = target.stopTime ?? nowT;
      if (duration > 0 && target.stopTime !== undefined && target.stopTime >= duration - 0.02) {
        return;
      }

      const rawNextStop = Math.round((oldStop + 10) * 100) / 100;
      const nextStop = duration > 0 ? Math.min(duration, rawNextStop) : rawNextStop;

      pushUndoSnapshot();
      setPlayers((prev) =>
        prev.map((p) => {
          if (p.id !== playerId) return p;
          const resumedStatus = p.trackWithCv === false ? ('anchored' as const) : ('tracking' as const);
          const cleanedHistory = p.history.map((pt, idx) =>
            idx === p.history.length - 1 && pt.status === 'stopped'
              ? { ...pt, status: resumedStatus }
              : pt
          );
          const lastPt = cleanedHistory[cleanedHistory.length - 1] ?? p.currentPosition;
          const nextNodes = p.nodes?.map((node) => {
            const nodeStatus =
              node.trackWithCv === false || p.trackWithCv === false
                ? ('anchored' as const)
                : ('tracking' as const);
            const nodeCleanedHistory = node.history.map((pt, idx) =>
              idx === node.history.length - 1 && pt.status === 'stopped'
                ? { ...pt, status: nodeStatus }
                : pt
            );
            const nodeLast = nodeCleanedHistory[nodeCleanedHistory.length - 1] ?? node.currentPosition;
            return {
              ...node,
              stopTime: undefined,
              stopReason: undefined,
              history: nodeCleanedHistory,
              currentPosition: {
                ...nodeLast,
                status: nodeStatus,
              },
            };
          });
          return {
            ...p,
            nodes: nextNodes,
            stopTime: nextStop,
            stopReason: 'manual',
            history: cleanedHistory,
            currentPosition: {
              ...lastPt,
              status: resumedStatus,
            },
          };
        })
      );

      if (target.stopTime !== undefined && nowT > target.stopTime + 0.06) {
        handleSeek(target.stopTime);
      }
    },
    [currentTime, duration, handleSeek, pushUndoSnapshot]
  );

  const handleDeletePlayer = useCallback(
    (id: string) => {
      pushUndoSnapshot();
      setPlayers((prev) =>
        prev
          .filter((p) => p.id !== id)
          .map((p) =>
            p.style === 'chain' && p.linkedRingIds
              ? { ...p, linkedRingIds: p.linkedRingIds.filter((rid) => rid !== id) }
              : p
          )
          .filter((p) => !(p.style === 'chain' && p.linkedRingIds && p.linkedRingIds.length < 2))
      );
      if (selectedPlayerId === id) {
        setSelectedPlayerId(null);
        setSelectedNodeId(null);
      }
      if (realigningPlayerId === id) {
        setRealigningPlayerId(null);
        setRealigningNodeId(null);
      }
    },
    [selectedPlayerId, realigningPlayerId, pushUndoSnapshot]
  );

  const handleStartRealign = useCallback((playerId: string, nodeId?: string | null) => {
    setIsPlaying(false);
    setSelectedPlayerId(playerId);
    setRealigningPlayerId(playerId);
    const targetPlayer = playersRef.current.find((p) => p.id === playerId);
    if (targetPlayer?.nodes && targetPlayer.nodes.length > 0) {
      const resolvedNodeId =
        nodeId && targetPlayer.nodes.some((n) => n.id === nodeId)
          ? nodeId
          : targetPlayer.nodes[0].id;
      setSelectedNodeId(resolvedNodeId);
      setRealigningNodeId(resolvedNodeId);
    } else {
      setSelectedNodeId(null);
      setRealigningNodeId(null);
    }
  }, []);

  const handleTrimPlayerSpan = useCallback(
    (
      playerId: string,
      nextInTime: number | undefined,
      nextStopTime: number | undefined,
      nextStopReason?: 'manual' | 'out-of-frame'
    ) => {
      setPlayers((prev) =>
        prev.map((p) => {
          if (p.id !== playerId) return p;
          const nextNodes = p.nodes?.map((node) => {
            if (nextStopTime === undefined || nextStopTime > (p.stopTime ?? 0)) {
              if (node.stopReason === 'manual') {
                return { ...node, stopTime: undefined, stopReason: undefined };
              }
              return node;
            }
            if (node.stopTime !== undefined && node.stopTime > nextStopTime) {
              return { ...node, stopTime: nextStopTime, stopReason: nextStopReason ?? node.stopReason ?? 'manual' };
            }
            return node;
          });
          return {
            ...p,
            nodes: nextNodes,
            inTime: nextInTime,
            stopTime: nextStopTime,
            stopReason: nextStopTime === undefined ? undefined : nextStopReason ?? p.stopReason ?? 'manual',
          };
        })
      );
    },
    []
  );

  const handleSetInAtPlayhead = useCallback(
    (playerId: string) => {
      const t = videoElRef.current ? videoElRef.current.currentTime : currentTime;
      pushUndoSnapshot();
      setPlayers((prev) =>
        prev.map((p) => {
          if (p.id !== playerId) return p;
          const maxIn =
            p.stopTime !== undefined
              ? Math.max(0, p.stopTime - 0.1)
              : duration > 0
                ? Math.max(0, duration - 0.1)
                : t;
          const clampedIn = Math.max(0, Math.min(maxIn, Math.round(t * 100) / 100));
          return { ...p, inTime: clampedIn };
        })
      );
    },
    [currentTime, duration, pushUndoSnapshot]
  );

  const handleSetOutAtPlayhead = useCallback(
    (playerId: string) => {
      const t = videoElRef.current ? videoElRef.current.currentTime : currentTime;
      pushUndoSnapshot();
      setPlayers((prev) =>
        prev.map((p) => {
          if (p.id !== playerId) return p;
          const effIn = p.inTime ?? p.anchorTime;
          if (duration > 0 && Math.abs(duration - t) <= 0.1) {
            return {
              ...p,
              stopTime: undefined,
              stopReason: undefined,
              nodes: p.nodes?.map((n) =>
                n.stopReason === 'manual' ? { ...n, stopTime: undefined, stopReason: undefined } : n
              ),
            };
          }
          const clampedOut = Math.max(effIn + 0.1, Math.round(t * 100) / 100);
          const nextOut = duration > 0 ? Math.min(duration, clampedOut) : clampedOut;
          return {
            ...p,
            stopTime: nextOut,
            stopReason: 'manual',
            nodes: p.nodes?.map((n) =>
              n.stopTime !== undefined && n.stopTime > nextOut
                ? { ...n, stopTime: nextOut, stopReason: 'manual' }
                : n
            ),
          };
        })
      );
    },
    [currentTime, duration, pushUndoSnapshot]
  );

  // Global keyboard shortcuts for fast tactical analysis
  useEffect(() => {
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

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        handleRedo();
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        handleTogglePlay();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        if (e.shiftKey) {
          handleSkipSeconds(-5);
        } else {
          handleStepFrame(-1);
        }
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        if (e.shiftKey) {
          handleSkipSeconds(5);
        } else {
          handleStepFrame(1);
        }
      } else if (e.key.toLowerCase() === 'b' || e.key.toLowerCase() === 'c') {
        setIsSlowTrackingDetected(false);
        setRealigningPlayerId(null);
        setRealigningNodeId(null);
        setIsSamplingPitch(false);
        setShowChromaBar(false);
        setNeedsChromaPrompt(false);
        setShowPlayerBoxBar(false);
        setDetectorSubTool(null);
        setSelectedPlayerId(null);
        setSelectedNodeId(null);
        setToolMode('circle');
      } else if (e.key.toLowerCase() === 's') {
        setIsSlowTrackingDetected(false);
        setRealigningPlayerId(null);
        setRealigningNodeId(null);
        setIsSamplingPitch(false);
        setShowChromaBar(false);
        setNeedsChromaPrompt(false);
        setShowPlayerBoxBar(false);
        setDetectorSubTool(null);
        setSelectedPlayerId(null);
        setSelectedNodeId(null);
        setToolMode('spotlight');
      } else if (e.key.toLowerCase() === 'g') {
        setIsSlowTrackingDetected(false);
        setRealigningPlayerId(null);
        setRealigningNodeId(null);
        setIsSamplingPitch(false);
        setShowChromaBar(false);
        setNeedsChromaPrompt(false);
        setShowPlayerBoxBar(false);
        setDetectorSubTool(null);
        setSelectedPlayerId(null);
        setSelectedNodeId(null);
        setToolMode('ring');
      } else if (e.key.toLowerCase() === 'l') {
        setIsSlowTrackingDetected(false);
        setRealigningPlayerId(null);
        setRealigningNodeId(null);
        setIsSamplingPitch(false);
        setShowChromaBar(false);
        setNeedsChromaPrompt(false);
        setShowPlayerBoxBar(false);
        setDetectorSubTool(null);
        setSelectedPlayerId(null);
        setSelectedNodeId(null);
        setToolMode('chain');
      } else if (e.key.toLowerCase() === 'p') {
        setIsSlowTrackingDetected(false);
        setRealigningPlayerId(null);
        setRealigningNodeId(null);
        setIsSamplingPitch(false);
        setShowChromaBar(false);
        setNeedsChromaPrompt(false);
        setShowPlayerBoxBar(false);
        setDetectorSubTool(null);
        setSelectedPlayerId(null);
        setSelectedNodeId(null);
        setToolMode('polygon');
      } else if (e.key.toLowerCase() === 'v') {
        setIsSlowTrackingDetected(false);
        setRealigningPlayerId(null);
        setRealigningNodeId(null);
        setIsSamplingPitch(false);
        setShowChromaBar(false);
        setNeedsChromaPrompt(false);
        setShowPlayerBoxBar(false);
        setDetectorSubTool(null);
        setToolMode('select');
      } else if (e.key.toLowerCase() === 'e') {
        setIsSlowTrackingDetected(false);
        setRealigningPlayerId(null);
        setRealigningNodeId(null);
        setIsSamplingPitch(false);
        setShowChromaBar(false);
        setNeedsChromaPrompt(false);
        setShowPlayerBoxBar(false);
        setDetectorSubTool(null);
        setSelectedPlayerId(null);
        setSelectedNodeId(null);
        setToolMode('erase');
      } else if (e.key.toLowerCase() === 'r') {
        const targetId = selectedPlayerId ?? players[0]?.id;
        if (targetId) {
          setIsSlowTrackingDetected(false);
          setIsSamplingPitch(false);
          setShowChromaBar(false);
          setNeedsChromaPrompt(false);
          setShowPlayerBoxBar(false);
          setDetectorSubTool(null);
          if (realigningPlayerId === targetId) {
            setRealigningPlayerId(null);
            setRealigningNodeId(null);
          } else {
            handleStartRealign(targetId, selectedNodeId);
          }
        }
      } else if (e.code === 'Escape' && isSamplingPitch) {
        setIsSamplingPitch(false);
      } else if (e.code === 'Escape' && detectorSubTool) {
        setDetectorSubTool(null);
      } else if (e.code === 'Escape' && showPlayerBoxBar) {
        setIsSlowTrackingDetected(false);
        setShowPlayerBoxBar(false);
      } else if (e.code === 'Escape' && realigningPlayerId) {
        setRealigningPlayerId(null);
        setRealigningNodeId(null);
      } else if (
        (e.code === 'Delete' || e.code === 'Backspace') &&
        showPlayerBoxBar &&
        selectedDetectedBoxId
      ) {
        e.preventDefault();
        setEraseSelectedDetectedSeq((s) => s + 1);
      } else if ((e.code === 'Delete' || e.code === 'Backspace') && selectedPlayerId) {
        e.preventDefault();
        handleDeletePlayer(selectedPlayerId);
      } else if (e.key === '[' && (selectedPlayerId || players[0]?.id)) {
        const targetId = selectedPlayerId ?? players[0]?.id;
        if (targetId) {
          e.preventDefault();
          handleSetInAtPlayhead(targetId);
        }
      } else if (e.key === ']' && (selectedPlayerId || players[0]?.id)) {
        const targetId = selectedPlayerId ?? players[0]?.id;
        if (targetId) {
          e.preventDefault();
          handleSetOutAtPlayhead(targetId);
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    handleTogglePlay,
    handleStepFrame,
    handleSkipSeconds,
    handleUndo,
    handleRedo,
    selectedPlayerId,
    selectedNodeId,
    selectedDetectedBoxId,
    realigningPlayerId,
    isSamplingPitch,
    detectorSubTool,
    showPlayerBoxBar,
    players,
    handleDeletePlayer,
    handleStartRealign,
    handleSetInAtPlayhead,
    handleSetOutAtPlayhead,
  ]);

  // Close '>' section menu on outside click or Escape
  useEffect(() => {
    if (!showSectionMenu) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (sectionMenuRef.current && !sectionMenuRef.current.contains(e.target as Node)) {
        setShowSectionMenu(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowSectionMenu(false);
    };
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKey);
    };
  }, [showSectionMenu]);

  const selectedPlayer = selectedPlayerId
    ? players.find((p) => p.id === selectedPlayerId) ?? null
    : null;
  const editingSelectedBox =
    selectedPlayer &&
    (selectedPlayer.style === 'ring' ||
      selectedPlayer.style === 'halo' ||
      selectedPlayer.style === 'reticle')
      ? selectedPlayer
      : null;
  const editingSelectedRing =
    selectedPlayer?.style === 'foot-ring' ? selectedPlayer : null;
  const editingSelectedChain =
    selectedPlayer?.style === 'chain' ? selectedPlayer : null;
  const editingSelectedPolygon =
    selectedPlayer?.style === 'polygon' ? selectedPlayer : null;
  const editingSelectedSpotlight =
    selectedPlayer?.style === 'spotlight' ? selectedPlayer : null;
  const showBoxSettings = Boolean(editingSelectedBox);
  const showSpotlightSettings =
    Boolean(editingSelectedSpotlight) || (!selectedPlayer && toolMode === 'spotlight');
  const showRingSettings =
    Boolean(editingSelectedRing) || (!selectedPlayer && toolMode === 'ring');
  const showChainSettings =
    Boolean(editingSelectedChain) || (!selectedPlayer && toolMode === 'chain');
  const showPolygonSettings =
    Boolean(editingSelectedPolygon) || (!selectedPlayer && toolMode === 'polygon');
  const showChromaSettings = showChromaBar || isSamplingPitch;
  const realignTarget = realigningPlayerId
    ? players.find((p) => p.id === realigningPlayerId) ?? null
    : null;
  const realignTargetNode =
    realignTarget?.nodes && realigningNodeId
      ? realignTarget.nodes.find((n) => n.id === realigningNodeId) ?? realignTarget.nodes[0] ?? null
      : null;
  const targetStopPlayer = players.find((p) => p.id === selectedPlayerId) ?? players[0] ?? null;
  const isTargetStopped = Boolean(
    targetStopPlayer &&
      targetStopPlayer.stopTime !== undefined &&
      currentTime >= targetStopPlayer.stopTime - 0.05
  );
  const isTargetAtClipEnd = Boolean(
    targetStopPlayer &&
      duration > 0 &&
      targetStopPlayer.stopTime !== undefined &&
      targetStopPlayer.stopTime >= duration - 0.02
  );

  const activeRingProps = editingSelectedRing
    ? {
        ringSize: editingSelectedRing.ring?.ringSize ?? ringSettings.ringSize,
        ringThickness: editingSelectedRing.ring?.ringThickness ?? ringSettings.ringThickness,
        tiltDeg: editingSelectedRing.ring?.tiltDeg ?? ringSettings.tiltDeg,
        spinSpeed: editingSelectedRing.ring?.spinSpeed ?? ringSettings.spinSpeed,
        color: editingSelectedRing.color,
        trackWithCv: editingSelectedRing.trackWithCv !== false,
      }
    : ringSettings;

  const updateActiveRingProps = (patch: Partial<RingSettings>) => {
    if (editingSelectedRing) {
      const targetId = editingSelectedRing.id;
      setPlayers((prev) =>
        prev.map((p) => {
          if (p.id !== targetId) return p;
          const currRing = p.ring ?? {
            ringSize: ringSettings.ringSize,
            ringThickness: ringSettings.ringThickness,
            tiltDeg: ringSettings.tiltDeg,
            spinSpeed: ringSettings.spinSpeed,
          };
          return {
            ...p,
            color: patch.color ?? p.color,
            trackWithCv: patch.trackWithCv ?? p.trackWithCv,
            ring: {
              ringSize: patch.ringSize ?? currRing.ringSize,
              ringThickness:
                patch.ringThickness ?? currRing.ringThickness ?? DEFAULT_RING_THICKNESS,
              tiltDeg: patch.tiltDeg ?? currRing.tiltDeg,
              spinSpeed: patch.spinSpeed ?? currRing.spinSpeed,
            },
          };
        })
      );
    } else {
      setRingSettings((prev) => ({ ...prev, ...patch }));
    }
  };

  const activeChainProps = editingSelectedChain
    ? {
        ringSize: editingSelectedChain.chain?.ringSize ?? chainSettings.ringSize,
        ringThickness: editingSelectedChain.chain?.ringThickness ?? chainSettings.ringThickness,
        tiltDeg: editingSelectedChain.chain?.tiltDeg ?? chainSettings.tiltDeg,
        spinSpeed: editingSelectedChain.chain?.spinSpeed ?? chainSettings.spinSpeed,
        connectorWidth: editingSelectedChain.chain?.connectorWidth ?? chainSettings.connectorWidth,
        dashed: editingSelectedChain.chain?.dashed ?? chainSettings.dashed,
        color: editingSelectedChain.color,
        trackWithCv: editingSelectedChain.trackWithCv !== false,
      }
    : chainSettings;

  const updateActiveChainProps = (patch: Partial<ChainSettings>) => {
    if (editingSelectedChain) {
      const targetId = editingSelectedChain.id;
      setPlayers((prev) =>
        prev.map((p) => {
          if (p.id !== targetId) return p;
          const currChain = p.chain ?? {
            ringSize: chainSettings.ringSize,
            ringThickness: chainSettings.ringThickness,
            tiltDeg: chainSettings.tiltDeg,
            spinSpeed: chainSettings.spinSpeed,
            connectorWidth: chainSettings.connectorWidth,
            dashed: chainSettings.dashed,
          };
          const nextTrack = patch.trackWithCv ?? p.trackWithCv;
          return {
            ...p,
            color: patch.color ?? p.color,
            trackWithCv: nextTrack,
            nodes:
              patch.trackWithCv !== undefined && p.nodes
                ? p.nodes.map((n) => ({ ...n, trackWithCv: patch.trackWithCv! }))
                : p.nodes,
            chain: {
              ringSize: patch.ringSize ?? currChain.ringSize,
              ringThickness:
                patch.ringThickness ?? currChain.ringThickness ?? DEFAULT_RING_THICKNESS,
              tiltDeg: patch.tiltDeg ?? currChain.tiltDeg,
              spinSpeed: patch.spinSpeed ?? currChain.spinSpeed,
              connectorWidth: patch.connectorWidth ?? currChain.connectorWidth,
              dashed: patch.dashed ?? currChain.dashed ?? false,
            },
          };
        })
      );
    } else {
      setChainSettings((prev) => ({ ...prev, ...patch }));
    }
  };

  const activePolygonProps: PolygonSettings = editingSelectedPolygon
    ? {
        borderColor: editingSelectedPolygon.polygon?.borderColor ?? editingSelectedPolygon.color,
        borderThickness:
          editingSelectedPolygon.polygon?.borderThickness ?? polygonSettings.borderThickness,
        dashedBorder: editingSelectedPolygon.polygon?.dashedBorder ?? polygonSettings.dashedBorder,
        fillColor: editingSelectedPolygon.polygon?.fillColor ?? editingSelectedPolygon.color,
        fillOpacity: editingSelectedPolygon.polygon?.fillOpacity ?? polygonSettings.fillOpacity,
        markerSize: editingSelectedPolygon.polygon?.markerSize ?? polygonSettings.markerSize,
        trackWithCv: editingSelectedPolygon.trackWithCv !== false,
      }
    : polygonSettings;

  const updateActivePolygonProps = (patch: Partial<PolygonSettings>) => {
    if (editingSelectedPolygon) {
      const targetId = editingSelectedPolygon.id;
      setPlayers((prev) =>
        prev.map((p) => {
          if (p.id !== targetId) return p;
          const currPoly = p.polygon ?? {
            borderColor: p.color,
            borderThickness: polygonSettings.borderThickness,
            dashedBorder: polygonSettings.dashedBorder,
            fillColor: p.color,
            fillOpacity: polygonSettings.fillOpacity,
            markerSize: polygonSettings.markerSize,
          };
          const nextBorderColor = patch.borderColor ?? currPoly.borderColor;
          return {
            ...p,
            color: nextBorderColor,
            trackWithCv: patch.trackWithCv ?? p.trackWithCv,
            nodes:
              patch.trackWithCv !== undefined && p.nodes
                ? p.nodes.map((n) => ({ ...n, trackWithCv: patch.trackWithCv! }))
                : p.nodes,
            polygon: {
              borderColor: nextBorderColor,
              borderThickness: patch.borderThickness ?? currPoly.borderThickness,
              dashedBorder: patch.dashedBorder ?? currPoly.dashedBorder,
              fillColor: patch.fillColor ?? currPoly.fillColor,
              fillOpacity: patch.fillOpacity ?? currPoly.fillOpacity,
              markerSize: patch.markerSize ?? currPoly.markerSize,
            },
          };
        })
      );
    } else {
      setPolygonSettings((prev) => ({ ...prev, ...patch }));
    }
  };

  const activeSpotlightProps = editingSelectedSpotlight
    ? {
        beamSize: editingSelectedSpotlight.spotlight?.beamSize ?? spotlightSettings.beamSize,
        intensity: editingSelectedSpotlight.spotlight?.intensity ?? spotlightSettings.intensity,
        rotation: editingSelectedSpotlight.spotlight?.rotation ?? spotlightSettings.rotation,
        color: editingSelectedSpotlight.color,
        trackWithCv: editingSelectedSpotlight.trackWithCv !== false,
      }
    : spotlightSettings;

  const updateActiveSpotlightProps = (patch: Partial<SpotlightSettings>) => {
    if (editingSelectedSpotlight) {
      const targetId = editingSelectedSpotlight.id;
      setPlayers((prev) =>
        prev.map((p) => {
          if (p.id !== targetId) return p;
          const currSpot = p.spotlight ?? {
            beamSize: spotlightSettings.beamSize,
            intensity: spotlightSettings.intensity,
            rotation: spotlightSettings.rotation,
          };
          return {
            ...p,
            color: patch.color ?? p.color,
            trackWithCv: patch.trackWithCv ?? p.trackWithCv,
            spotlight: {
              beamSize: patch.beamSize ?? currSpot.beamSize,
              intensity: patch.intensity ?? currSpot.intensity,
              rotation: patch.rotation ?? currSpot.rotation,
            },
          };
        })
      );
    } else {
      setSpotlightSettings((prev) => ({ ...prev, ...patch }));
    }
  };

  const coverageSummary = useMemo(
    () =>
      analyzeTrackingCoverage({
        duration,
        currentTime,
        backgroundTracks,
        implementedTracks,
        detectedBoxes,
        fullSweepTimes:
          backgroundTracks.length > 0 ? fullSweepTimes : implementedFullSweepTimes,
        players,
      }),
    [
      duration,
      currentTime,
      backgroundTracks,
      implementedTracks,
      detectedBoxes,
      fullSweepTimes,
      implementedFullSweepTimes,
      players,
    ]
  );

  return (
    <div className="min-h-screen lg:h-screen flex flex-col bg-[#0B0F14] text-slate-100 overflow-x-hidden">
      {/* Hidden file picker for Header CTA */}
      <input
        ref={headerFileInputRef}
        type="file"
        accept="video/mp4,video/webm,video/quicktime,video/*"
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            handleUploadFiles(e.target.files);
            e.target.value = '';
          }
        }}
      />

      {/* Compact Top Panel: Slim Brand + '>' Menu + Footage Name + Inline Properties + Full-Width All-Tools Strip */}
      <div className="shrink-0 bg-[#0D1218] border-b border-[#1E2936]">
        <header className="h-[32px] px-2.5 border-b border-[#18212D] flex items-center justify-between gap-2 overflow-hidden">
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            <div className="flex items-center gap-1 shrink-0" ref={sectionMenuRef}>
              <a
                href="#tracking-stage"
                className="font-display text-sm font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0"
              >
                PitchTrace
              </a>

              {/* Compact '>' Menu for OPFS Library, Video Stage, Player Tracks, Vision Settings */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowSectionMenu((prev) => !prev)}
                  aria-expanded={showSectionMenu}
                  aria-haspopup="menu"
                  aria-label="Toggle workspace sections"
                  title="Workspace panels & sections"
                  className={`p-0.5 rounded border transition-colors flex items-center justify-center ${
                    showSectionMenu
                      ? 'bg-[#1D2735] border-[#33465E] text-emerald-400'
                      : 'bg-[#121821] border-[#1E2936] text-slate-400 hover:text-slate-100 hover:border-[#2C3A4D]'
                  }`}
                >
                  <ChevronRight
                    className={`w-3 h-3 transition-transform duration-150 ${
                      showSectionMenu ? 'rotate-90' : ''
                    }`}
                  />
                </button>

                {showSectionMenu && (
                  <div
                    role="menu"
                    className="absolute left-0 top-full mt-1 w-44 rounded-lg bg-[#10161E] border border-[#2A3749] shadow-2xl py-1 z-50"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setShowLeftPanel((prev) => !prev);
                        setShowSectionMenu(false);
                      }}
                      className="w-full px-2.5 py-1 text-left text-[11px] flex items-center justify-between gap-2 text-slate-200 hover:bg-[#192330] transition-colors"
                    >
                      <span>OPFS Library</span>
                      <span className="text-[9.5px] font-mono text-slate-400">
                        {showLeftPanel ? 'Expanded' : 'Minimized'}
                      </span>
                    </button>

                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        const bothHidden = !showLeftPanel && !showRightPanel;
                        if (bothHidden) {
                          setShowLeftPanel(true);
                          setShowRightPanel(true);
                        } else {
                          setShowLeftPanel(false);
                          setShowRightPanel(false);
                        }
                        setShowSectionMenu(false);
                      }}
                      className="w-full px-2.5 py-1 text-left text-[11px] flex items-center justify-between gap-2 text-slate-200 hover:bg-[#192330] transition-colors"
                    >
                      <span>Video Stage</span>
                      <span className="text-[9.5px] font-mono text-slate-400">
                        {!showLeftPanel && !showRightPanel ? 'Exit Focus' : 'Focus'}
                      </span>
                    </button>

                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setShowRightPanel((prev) => !prev);
                        setShowSectionMenu(false);
                      }}
                      className="w-full px-2.5 py-1 text-left text-[11px] flex items-center justify-between gap-2 text-slate-200 hover:bg-[#192330] transition-colors"
                    >
                      <span>Player Tracks</span>
                      <span className="text-[9.5px] font-mono text-slate-400">
                        {showRightPanel ? 'Shown' : 'Hidden'}
                      </span>
                    </button>

                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setShowLeftPanel(true);
                        setShowVisionSettings((prev) => !showLeftPanel || !prev);
                        setShowSectionMenu(false);
                      }}
                      className="w-full px-2.5 py-1 text-left text-[11px] flex items-center justify-between gap-2 text-slate-200 hover:bg-[#192330] transition-colors"
                    >
                      <span className="flex items-center gap-1.5">
                        <SlidersHorizontal className="w-3 h-3 text-emerald-400" />
                        <span>Vision Settings</span>
                      </span>
                      <span className="text-[9.5px] font-mono text-slate-400">
                        {showLeftPanel && showVisionSettings ? 'Open' : 'Closed'}
                      </span>
                    </button>
                  </div>
                )}
              </div>
            </div>

            {activeVideoName && (
              <span
                className="hidden sm:inline-block text-[10px] font-mono text-slate-400 truncate max-w-[120px] lg:max-w-[160px] shrink-0"
                title={activeVideoName}
              >
                {activeVideoName}
              </span>
            )}

            {/* Inline Tool / Chroma Key / Player Box / Realign Properties on Top Bar after Footage Name (never resizes video canvas) */}
            {(showChromaSettings ||
              showPlayerBoxBar ||
              realignTarget ||
              showBoxSettings ||
              showChainSettings ||
              showPolygonSettings ||
              showRingSettings ||
              showSpotlightSettings) && (
              <>
                <div className="h-3.5 w-px bg-[#1E2936] shrink-0" aria-hidden="true" />
                <div className="flex-1 min-w-0 flex items-center gap-2 overflow-x-auto no-scrollbar py-0.5 text-[10px]">
                  {showChromaSettings ? (
                    <>
                      <span className="text-[10px] font-semibold text-emerald-400 whitespace-nowrap shrink-0">
                        Chroma Key
                      </span>
                      {needsChromaPrompt && !chromaKey.hasCustomSamples && (
                        <span className="text-[10px] text-amber-300 whitespace-nowrap shrink-0">
                          Click green pitch to sample before detecting
                        </span>
                      )}

                      <div className="flex items-center gap-1 shrink-0">
                        {chromaKey.keyColors.map((hex, index) => (
                          <span
                            key={`${hex}_${index}`}
                            className="inline-flex items-center gap-1 pl-1 pr-0.5 py-[1px] rounded bg-[#141B24] border border-[#243040] text-[9.5px] font-mono tabular-nums text-slate-200"
                          >
                            <span
                              className="w-2 h-2 rounded-sm border border-white/25 shrink-0"
                              style={{ backgroundColor: hex }}
                            />
                            <span>{hex}</span>
                            {(chromaKey.keyColors.length > 1 || chromaKey.hasCustomSamples) && (
                              <button
                                type="button"
                                onClick={() => handleRemoveKeyColor(index)}
                                title={`Remove ${hex}`}
                                aria-label={`Remove sampled color ${hex}`}
                                className="p-0.5 rounded hover:bg-[#1E2936] text-slate-400 hover:text-rose-300"
                              >
                                <X className="w-2.5 h-2.5" />
                              </button>
                            )}
                          </span>
                        ))}

                        <button
                          type="button"
                          disabled={!activeVideoUrl}
                          onClick={() => {
                            setRealigningPlayerId(null);
                            setRealigningNodeId(null);
                            setIsPlaying(false);
                            setIsSamplingPitch((prev) => !prev);
                          }}
                          className={`inline-flex items-center gap-1 px-1.5 py-[1px] rounded border text-[10px] font-medium transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 ${
                            isSamplingPitch
                              ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-300'
                              : 'bg-[#141B24] hover:bg-[#1E2734] border-[#243040] text-slate-200'
                          }`}
                        >
                          <Pipette className="w-2.5 h-2.5" />
                          <span>{isSamplingPitch ? 'Sampling' : '+ Sample'}</span>
                        </button>

                        {isSamplingPitch && (
                          <button
                            type="button"
                            onClick={() => setIsSamplingPitch(false)}
                            title="Finish sampling pitch colors (Esc)"
                            className="inline-flex items-center gap-1 px-1.5 py-[1px] rounded bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-[9.5px] font-semibold whitespace-nowrap shrink-0"
                          >
                            <Check className="w-2.5 h-2.5 stroke-[2.75]" />
                            <span>Done</span>
                          </button>
                        )}

                        {chromaKey.hasCustomSamples && (
                          <button
                            type="button"
                            onClick={() =>
                              setChromaKey((prev) => ({
                                ...prev,
                                keyColors: [DEFAULT_PITCH_GREEN],
                                hasCustomSamples: false,
                              }))
                            }
                            title="Reset pitch colors to default grass green"
                            className="inline-flex items-center gap-1 px-1.5 py-[1px] rounded bg-[#141B24] hover:bg-[#1E2734] border border-[#243040] text-[10px] text-slate-300 transition-colors whitespace-nowrap shrink-0"
                          >
                            <RotateCcw className="w-2.5 h-2.5" />
                            <span>Reset</span>
                          </button>
                        )}
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <label htmlFor="ck-tolerance" className="text-[10px] text-slate-400 whitespace-nowrap">
                          Tol
                        </label>
                        <input
                          id="ck-tolerance"
                          type="range"
                          min={10}
                          max={90}
                          step={1}
                          value={chromaKey.tolerance}
                          onChange={(e) =>
                            setChromaKey((prev) => ({
                              ...prev,
                              tolerance: Number(e.target.value),
                            }))
                          }
                          className="pitch-slider w-12"
                        />
                        <span className="font-mono tabular-nums text-[10px] text-slate-200 w-6 text-right">
                          {chromaKey.tolerance}%
                        </span>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <label htmlFor="ck-softness" className="text-[10px] text-slate-400 whitespace-nowrap">
                          Soft
                        </label>
                        <input
                          id="ck-softness"
                          type="range"
                          min={0}
                          max={40}
                          step={1}
                          value={chromaKey.softness}
                          onChange={(e) =>
                            setChromaKey((prev) => ({
                              ...prev,
                              softness: Number(e.target.value),
                            }))
                          }
                          className="pitch-slider w-12"
                        />
                        <span className="font-mono tabular-nums text-[10px] text-slate-200 w-6 text-right">
                          {chromaKey.softness}%
                        </span>
                      </div>

                      <label className="flex items-center gap-1 cursor-pointer select-none whitespace-nowrap shrink-0">
                        <input
                          type="checkbox"
                          checked={chromaKey.showMask}
                          onChange={(e) =>
                            setChromaKey((prev) => ({
                              ...prev,
                              showMask: e.target.checked,
                            }))
                          }
                          className="accent-fuchsia-500 w-3 h-3 rounded"
                        />
                        <span className="text-[10px] text-slate-300">Mask</span>
                      </label>

                      {needsChromaPrompt && chromaKey.hasCustomSamples && (
                        <button
                          type="button"
                          onClick={handleRunPlayerDetector}
                          className="inline-flex items-center gap-1 px-2 py-[1px] rounded bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-[10px] font-semibold whitespace-nowrap shrink-0"
                        >
                          <ScanSearch className="w-2.5 h-2.5" />
                          <span>Detect Players</span>
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => {
                          setShowChromaBar(false);
                          setIsSamplingPitch(false);
                          setNeedsChromaPrompt(false);
                        }}
                        title="Close Chroma Key properties"
                        aria-label="Close Chroma Key properties"
                        className="p-0.5 rounded hover:bg-[#1E2936] text-slate-400 hover:text-slate-200 transition-colors shrink-0"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </>
                  ) : showPlayerBoxBar ? (
                    <>
                      <span className="text-[10px] font-semibold text-emerald-400 whitespace-nowrap shrink-0">
                        Player Box
                      </span>

                      <span
                        className={`text-[10px] font-mono tabular-nums whitespace-nowrap shrink-0 ${
                          coverageSummary.currentKind === 'full'
                            ? 'text-emerald-300'
                            : coverageSummary.currentKind === 'partial'
                              ? 'text-sky-300'
                              : 'text-slate-400'
                        }`}
                        title={`Coverage at playhead: ${coverageSummary.coveragePct}% of clip tracked`}
                      >
                        {coverageSummary.currentKind === 'full'
                          ? `Full · ${detectedBoxes.length}p`
                          : coverageSummary.currentKind === 'partial'
                            ? `Partial · ${
                                detectedBoxes.filter((b) => b.source === 'manual').length ||
                                detectedBoxes.length
                              } box`
                            : 'Untracked'}
                      </span>

                      <div className="flex items-center p-[1px] rounded bg-[#0B0F14] border border-[#1E2936] shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            setIsSlowTrackingDetected(false);
                            setDetectorSubTool(null);
                            setShowDetectedBoxes(true);
                          }}
                          aria-pressed={detectorSubTool === null}
                          title="Adjust: drag any box to reposition or drag corners to resize with smooth motion blending"
                          className={`inline-flex items-center gap-1 px-1.5 py-[1px] rounded text-[10px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                            detectorSubTool === null
                              ? 'bg-amber-500/20 text-amber-300'
                              : 'text-slate-300 hover:text-slate-100'
                          }`}
                        >
                          <MousePointer2 className="w-2.5 h-2.5" />
                          <span>Adjust</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setIsSlowTrackingDetected(false);
                            setShowDetectedBoxes(true);
                            setDetectorSubTool((curr) => (curr === 'drawer' ? null : 'drawer'));
                          }}
                          aria-pressed={detectorSubTool === 'drawer'}
                          title="Drawer: pause tracking and draw boxes on missed players to continue tracking"
                          className={`inline-flex items-center gap-1 px-1.5 py-[1px] rounded text-[10px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                            detectorSubTool === 'drawer'
                              ? 'bg-sky-500/20 text-sky-300'
                              : 'text-slate-300 hover:text-slate-100'
                          }`}
                        >
                          <BoxSelect className="w-2.5 h-2.5" />
                          <span>Drawer</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setIsSlowTrackingDetected(false);
                            setShowDetectedBoxes(true);
                            setDetectorSubTool((curr) => (curr === 'eraser' ? null : 'eraser'));
                          }}
                          aria-pressed={detectorSubTool === 'eraser'}
                          title="Eraser: pause tracking and remove false-positive boxes before continuing"
                          className={`inline-flex items-center gap-1 px-1.5 py-[1px] rounded text-[10px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                            detectorSubTool === 'eraser'
                              ? 'bg-rose-500/20 text-rose-300'
                              : 'text-slate-300 hover:text-slate-100'
                          }`}
                        >
                          <Eraser className="w-2.5 h-2.5" />
                          <span>Eraser</span>
                        </button>
                      </div>

                      {selectedDetectedBoxId &&
                        detectedBoxes.some((b) => b.id === selectedDetectedBoxId) && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-mono tabular-nums text-amber-300 whitespace-nowrap shrink-0">
                            <span>
                              #{detectedBoxes.findIndex((b) => b.id === selectedDetectedBoxId) + 1}
                            </span>
                            <button
                              type="button"
                              onClick={() => setSelectedDetectedBoxId(null)}
                              title="Clear selection to track all detected players"
                              className="px-1 py-[0.5px] rounded bg-[#141B24] hover:bg-[#1E2734] border border-[#243040] text-[9.5px] text-slate-300"
                            >
                              All
                            </button>
                          </span>
                        )}

                      <button
                        type="button"
                        disabled={
                          !activeVideoUrl ||
                          (detectedBoxes.length === 0 && !chromaKey.hasCustomSamples)
                        }
                        onClick={handleTogglePlay}
                        title={
                          isSlowTrackingDetected
                            ? 'Pause tracking (stay in tracking phase to adjust, draw, or erase boxes)'
                            : 'Play & track frame-by-frame (Space)'
                        }
                        className={`inline-flex items-center gap-1 px-1.5 py-[1px] rounded border text-[10px] font-semibold transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 ${
                          isSlowTrackingDetected
                            ? 'bg-amber-500/20 border-amber-500/50 text-amber-200'
                            : 'bg-[#141B24] hover:bg-[#1E2734] border-[#2C3A4D] text-cyan-300'
                        }`}
                      >
                        {isSlowTrackingDetected ? (
                          <>
                            <Pause className="w-2.5 h-2.5 fill-current" />
                            <span className="font-mono tabular-nums">
                              Pause {slowTrackProgress}%
                            </span>
                          </>
                        ) : (
                          <>
                            <Play className="w-2.5 h-2.5 fill-current" />
                            <span>
                              {selectedDetectedBoxId ? 'Play #Track' : 'Play / Track'}
                            </span>
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        disabled={
                          !activeVideoUrl ||
                          (detectedBoxes.length === 0 && backgroundTracks.length === 0) ||
                          isSlowTrackingDetected
                        }
                        onClick={() =>
                          setImplementRequest((prev) => ({
                            seq: (prev?.seq ?? 0) + 1,
                            targetId: selectedDetectedBoxId,
                          }))
                        }
                        title="Save tracked player trajectories & hide tracking boxes (attach tools later from right panel or top bar)"
                        className="inline-flex items-center gap-1 px-2 py-[1px] rounded bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-[10px] font-semibold transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
                      >
                        <Check className="w-2.5 h-2.5 stroke-[2.75]" />
                        <span>
                          {selectedDetectedBoxId
                            ? `Implement #${
                                detectedBoxes.findIndex(
                                  (b) => b.id === selectedDetectedBoxId
                                ) + 1
                              }`
                            : 'Implement'}
                        </span>
                      </button>

                      <button
                        type="button"
                        disabled={!activeVideoUrl || isSlowTrackingDetected}
                        onClick={handleRunPlayerDetector}
                        title="Re-run pitch-interior player detector using current human-shape training"
                        className="inline-flex items-center gap-1 px-1.5 py-[1px] rounded bg-[#141B24] hover:bg-[#1E2734] border border-[#243040] text-emerald-300 text-[10px] font-medium transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
                      >
                        <ScanSearch className="w-2.5 h-2.5" />
                        <span>{detectorStats.isTrained ? 'Re-Detect' : 'Detect'}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setShowDetectedBoxes((prev) => !prev)}
                        aria-pressed={showDetectedBoxes}
                        title="Show or hide detected player boxes on video"
                        className={`inline-flex items-center gap-1 px-1.5 py-[1px] rounded border text-[10px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                          showDetectedBoxes
                            ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                            : 'bg-[#141B24] border-[#243040] text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        <Eye className="w-2.5 h-2.5" />
                        <span>{showDetectedBoxes ? 'Shown' : 'Hidden'}</span>
                      </button>

                      {detectorStats.isTrained && (
                        <button
                          type="button"
                          disabled={isSlowTrackingDetected}
                          onClick={() => setResetDetectorSeq((s) => s + 1)}
                          title="Reset learned positive/negative shape samples"
                          className="inline-flex items-center gap-1 px-1.5 py-[1px] rounded bg-[#141B24] hover:bg-[#1E2734] border border-[#243040] text-[10px] text-slate-300 transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
                        >
                          <RotateCcw className="w-2.5 h-2.5" />
                          <span>Reset</span>
                        </button>
                      )}

                      {(detectedBoxes.length > 0 || backgroundTracks.length > 0) && (
                        <button
                          type="button"
                          disabled={isSlowTrackingDetected}
                          onClick={() => {
                            setDetectedBoxes([]);
                            setBackgroundTracks([]);
                            setFullSweepTimes([]);
                            setSelectedDetectedBoxId(null);
                            setSlowTrackProgress(0);
                            setClearDetectedSeq((s) => s + 1);
                          }}
                          title="Clear current detected player boxes and background-stored tracks"
                          className="inline-flex items-center gap-1 px-1.5 py-[1px] rounded bg-[#141B24] hover:bg-[#1E2734] border border-[#243040] text-[10px] text-slate-300 transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
                        >
                          <Trash className="w-2.5 h-2.5" />
                          <span>Clear</span>
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => setShowCoverageOverlay((prev) => !prev)}
                        aria-pressed={showCoverageOverlay}
                        title="Toggle spatial coverage mask & untracked player hints on stage (never exported)"
                        className={`inline-flex items-center gap-1 px-1.5 py-[1px] rounded border text-[10px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                          showCoverageOverlay
                            ? 'bg-sky-500/15 border-sky-500/40 text-sky-300'
                            : 'bg-[#141B24] border-[#243040] text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {showCoverageOverlay ? (
                          <Eye className="w-2.5 h-2.5" />
                        ) : (
                          <EyeOff className="w-2.5 h-2.5" />
                        )}
                        <span>Coverage</span>
                      </button>

                      {coverageSummary.nextGapTime !== null && (
                        <button
                          type="button"
                          disabled={isSlowTrackingDetected}
                          onClick={() => handleSeek(coverageSummary.nextGapTime!)}
                          title={`Jump to next untracked gap (${formatTimecode(coverageSummary.nextGapTime)})`}
                          className="inline-flex items-center gap-0.5 px-1.5 py-[1px] rounded bg-[#141B24] hover:bg-[#1E2734] border border-amber-500/35 text-[10px] font-medium text-amber-300 transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
                        >
                          <span>Gap</span>
                          <ArrowRight className="w-2.5 h-2.5" />
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => {
                          setIsSlowTrackingDetected(false);
                          setShowPlayerBoxBar(false);
                          setDetectorSubTool(null);
                        }}
                        title="Exit Tracking Phase"
                        aria-label="Exit Tracking Phase"
                        className="p-0.5 rounded hover:bg-[#1E2936] text-slate-400 hover:text-slate-200 transition-colors shrink-0"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </>
                  ) : realignTarget ? (
                    <>
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: realignTarget.color }}
                      />
                      <span className="text-[10px] text-amber-100 whitespace-nowrap shrink-0">
                        Realign <strong className="font-semibold text-white">{realignTarget.label}</strong>
                        {realignTargetNode ? (
                          <span className="text-amber-300 font-medium"> ({realignTargetNode.label})</span>
                        ) : null}{' '}
                        @ <span className="font-mono text-amber-300">{formatTimecode(currentTime)}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setReanchorRequest((prev) => ({
                            playerId: realignTarget.id,
                            nodeId: realignTargetNode?.id ?? undefined,
                            seq: (prev?.seq ?? 0) + 1,
                          }))
                        }
                        className="inline-flex items-center gap-1 px-1.5 py-[1px] rounded bg-[#18212D] hover:bg-[#223041] border border-[#2C3B4E] text-[9.5px] font-medium text-slate-200 whitespace-nowrap shrink-0"
                      >
                        <Crosshair className="w-2.5 h-2.5 text-emerald-400" />
                        <span>Re-sample</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setRealigningPlayerId(null);
                          setRealigningNodeId(null);
                        }}
                        className="inline-flex items-center gap-1 px-1.5 py-[1px] rounded hover:bg-slate-800 text-slate-300 text-[9.5px] whitespace-nowrap shrink-0"
                      >
                        <X className="w-2.5 h-2.5" />
                        <span>Cancel</span>
                      </button>
                    </>
                  ) : showChainSettings ? (
                    <>
                      <span className="text-[10px] font-semibold text-sky-300 whitespace-nowrap shrink-0">
                        {editingSelectedChain ? editingSelectedChain.label : 'Chain'}
                      </span>

                      {editingSelectedChain?.linkedRingIds && (
                        <span className="text-[10px] font-mono tabular-nums text-slate-400 whitespace-nowrap shrink-0">
                          {editingSelectedChain.linkedRingIds.length} rings
                        </span>
                      )}

                      <div className="flex items-center gap-1 shrink-0">
                        <label htmlFor="ch-link" className="text-[10px] text-slate-400 whitespace-nowrap">
                          Link
                        </label>
                        <input
                          id="ch-link"
                          type="range"
                          min={3}
                          max={26}
                          step={1}
                          value={activeChainProps.connectorWidth}
                          onChange={(e) =>
                            updateActiveChainProps({ connectorWidth: Number(e.target.value) })
                          }
                          className="pitch-slider w-14"
                        />
                        <span className="font-mono tabular-nums text-[10px] text-slate-200 w-7 text-right">
                          {activeChainProps.connectorWidth}px
                        </span>
                      </div>

                      <label className="flex items-center gap-1 cursor-pointer select-none whitespace-nowrap shrink-0">
                        <input
                          type="checkbox"
                          checked={Boolean(activeChainProps.dashed)}
                          onChange={(e) =>
                            updateActiveChainProps({ dashed: e.target.checked })
                          }
                          className="accent-sky-400 w-3 h-3 rounded"
                        />
                        <span className="text-[10px] text-slate-300">Dashed</span>
                      </label>

                      <label className="flex items-center gap-1 cursor-pointer select-none whitespace-nowrap shrink-0">
                        <span className="text-[10px] text-slate-400">Color</span>
                        <input
                          type="color"
                          value={activeChainProps.color}
                          onChange={(e) => updateActiveChainProps({ color: e.target.value })}
                          aria-label="Chain Color"
                          className="w-4 h-4 rounded border border-[#2C3A4D] bg-[#141B24] p-0.5 cursor-pointer"
                        />
                      </label>
                    </>
                  ) : showPolygonSettings ? (
                    <>
                      <span className="text-[10px] font-semibold text-rose-300 whitespace-nowrap shrink-0">
                        {editingSelectedPolygon ? editingSelectedPolygon.label : 'Polygon'}
                      </span>

                      <div className="flex items-center gap-1 shrink-0">
                        <label htmlFor="pg-border" className="text-[10px] text-slate-400 whitespace-nowrap">
                          Border
                        </label>
                        <input
                          id="pg-border"
                          type="range"
                          min={1}
                          max={10}
                          step={0.5}
                          value={activePolygonProps.borderThickness}
                          onChange={(e) =>
                            updateActivePolygonProps({ borderThickness: Number(e.target.value) })
                          }
                          className="pitch-slider w-11"
                        />
                        <span className="font-mono tabular-nums text-[10px] text-slate-200 w-7 text-right">
                          {activePolygonProps.borderThickness}px
                        </span>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <label htmlFor="pg-opacity" className="text-[10px] text-slate-400 whitespace-nowrap">
                          Fill
                        </label>
                        <input
                          id="pg-opacity"
                          type="range"
                          min={0}
                          max={0.75}
                          step={0.05}
                          value={activePolygonProps.fillOpacity}
                          onChange={(e) =>
                            updateActivePolygonProps({ fillOpacity: Number(e.target.value) })
                          }
                          className="pitch-slider w-11"
                        />
                        <span className="font-mono tabular-nums text-[10px] text-slate-200 w-7 text-right">
                          {Math.round(activePolygonProps.fillOpacity * 100)}%
                        </span>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <label htmlFor="pg-marker" className="text-[10px] text-slate-400 whitespace-nowrap">
                          Vertex
                        </label>
                        <input
                          id="pg-marker"
                          type="range"
                          min={2}
                          max={12}
                          step={0.5}
                          value={activePolygonProps.markerSize}
                          onChange={(e) =>
                            updateActivePolygonProps({ markerSize: Number(e.target.value) })
                          }
                          className="pitch-slider w-11"
                        />
                        <span className="font-mono tabular-nums text-[10px] text-slate-200 w-7 text-right">
                          {activePolygonProps.markerSize}px
                        </span>
                      </div>

                      <label className="flex items-center gap-1 cursor-pointer select-none whitespace-nowrap shrink-0">
                        <input
                          type="checkbox"
                          checked={activePolygonProps.dashedBorder}
                          onChange={(e) =>
                            updateActivePolygonProps({ dashedBorder: e.target.checked })
                          }
                          className="accent-rose-500 w-3 h-3 rounded"
                        />
                        <span className="text-[10px] text-slate-300">Dashed</span>
                      </label>

                      <label className="flex items-center gap-1 cursor-pointer select-none whitespace-nowrap shrink-0">
                        <span className="text-[10px] text-slate-400">Stroke</span>
                        <input
                          type="color"
                          value={activePolygonProps.borderColor}
                          onChange={(e) => updateActivePolygonProps({ borderColor: e.target.value })}
                          aria-label="Polygon Border Color"
                          className="w-4 h-4 rounded border border-[#2C3A4D] bg-[#141B24] p-0.5 cursor-pointer"
                        />
                      </label>

                      <label className="flex items-center gap-1 cursor-pointer select-none whitespace-nowrap shrink-0">
                        <span className="text-[10px] text-slate-400">Fill</span>
                        <input
                          type="color"
                          value={activePolygonProps.fillColor}
                          onChange={(e) => updateActivePolygonProps({ fillColor: e.target.value })}
                          aria-label="Polygon Fill Color"
                          className="w-4 h-4 rounded border border-[#2C3A4D] bg-[#141B24] p-0.5 cursor-pointer"
                        />
                      </label>

                      <label className="flex items-center gap-1 cursor-pointer select-none whitespace-nowrap shrink-0">
                        <input
                          type="checkbox"
                          checked={activePolygonProps.trackWithCv}
                          onChange={(e) =>
                            updateActivePolygonProps({ trackWithCv: e.target.checked })
                          }
                          className="accent-emerald-500 w-3 h-3 rounded"
                        />
                        <span className="text-[10px] text-slate-300">Follow CV</span>
                      </label>
                    </>
                  ) : showRingSettings ? (
                    <>
                      <span className="text-[10px] font-semibold text-cyan-300 whitespace-nowrap shrink-0">
                        {editingSelectedRing ? editingSelectedRing.label : '3D Ring'}
                      </span>

                      <div className="flex items-center gap-1 shrink-0">
                        <label htmlFor="rg-size" className="text-[10px] text-slate-400 whitespace-nowrap">
                          Size
                        </label>
                        <input
                          id="rg-size"
                          type="range"
                          min={MIN_RING_SIZE}
                          max={MAX_RING_SIZE}
                          step={2}
                          value={activeRingProps.ringSize}
                          onChange={(e) =>
                            updateActiveRingProps({ ringSize: Number(e.target.value) })
                          }
                          className="pitch-slider w-12"
                        />
                        <span className="font-mono tabular-nums text-[10px] text-slate-200 w-8 text-right">
                          {activeRingProps.ringSize}px
                        </span>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <label htmlFor="rg-thickness" className="text-[10px] text-slate-400 whitespace-nowrap">
                          Thick
                        </label>
                        <input
                          id="rg-thickness"
                          type="range"
                          min={MIN_RING_THICKNESS}
                          max={MAX_RING_THICKNESS}
                          step={2}
                          value={activeRingProps.ringThickness ?? DEFAULT_RING_THICKNESS}
                          onChange={(e) =>
                            updateActiveRingProps({ ringThickness: Number(e.target.value) })
                          }
                          className="pitch-slider w-11"
                        />
                        <span className="font-mono tabular-nums text-[10px] text-slate-200 w-7 text-right">
                          {activeRingProps.ringThickness ?? DEFAULT_RING_THICKNESS}%
                        </span>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <label htmlFor="rg-tilt" className="text-[10px] text-slate-400 whitespace-nowrap">
                          Tilt
                        </label>
                        <input
                          id="rg-tilt"
                          type="range"
                          min={0}
                          max={75}
                          step={1}
                          value={activeRingProps.tiltDeg}
                          onChange={(e) =>
                            updateActiveRingProps({ tiltDeg: Number(e.target.value) })
                          }
                          className="pitch-slider w-11"
                        />
                        <span className="font-mono tabular-nums text-[10px] text-cyan-200 w-6 text-right">
                          {activeRingProps.tiltDeg}°
                        </span>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <label htmlFor="rg-spin" className="text-[10px] text-slate-400 whitespace-nowrap">
                          Spin
                        </label>
                        <input
                          id="rg-spin"
                          type="range"
                          min={1.0}
                          max={5.0}
                          step={0.05}
                          value={activeRingProps.spinSpeed}
                          onChange={(e) =>
                            updateActiveRingProps({ spinSpeed: Number(e.target.value) })
                          }
                          className="pitch-slider w-11"
                        />
                        <span className="font-mono tabular-nums text-[10px] text-slate-200 w-8 text-right">
                          {activeRingProps.spinSpeed.toFixed(2)}s
                        </span>
                      </div>

                      <label className="flex items-center gap-1 cursor-pointer select-none whitespace-nowrap shrink-0">
                        <span className="text-[10px] text-slate-400">Color</span>
                        <input
                          type="color"
                          value={activeRingProps.color}
                          onChange={(e) => updateActiveRingProps({ color: e.target.value })}
                          aria-label="Ring Color"
                          className="w-4 h-4 rounded border border-[#2C3A4D] bg-[#141B24] p-0.5 cursor-pointer"
                        />
                      </label>

                      <label className="flex items-center gap-1 cursor-pointer select-none whitespace-nowrap shrink-0">
                        <input
                          type="checkbox"
                          checked={activeRingProps.trackWithCv}
                          onChange={(e) =>
                            updateActiveRingProps({ trackWithCv: e.target.checked })
                          }
                          className="accent-emerald-500 w-3 h-3 rounded"
                        />
                        <span className="text-[10px] text-slate-300">Follow CV</span>
                      </label>
                    </>
                  ) : showSpotlightSettings ? (
                    <>
                      <span className="text-[10px] font-semibold text-amber-300 whitespace-nowrap shrink-0">
                        {editingSelectedSpotlight ? editingSelectedSpotlight.label : 'Spotlight'}
                      </span>

                      <div className="flex items-center gap-1 shrink-0">
                        <label htmlFor="sp-beam-size" className="text-[10px] text-slate-400 whitespace-nowrap">
                          Beam
                        </label>
                        <input
                          id="sp-beam-size"
                          type="range"
                          min={30}
                          max={150}
                          step={1}
                          value={activeSpotlightProps.beamSize}
                          onChange={(e) =>
                            updateActiveSpotlightProps({ beamSize: Number(e.target.value) })
                          }
                          className="pitch-slider w-12"
                        />
                        <span className="font-mono tabular-nums text-[10px] text-slate-200 w-8 text-right">
                          {activeSpotlightProps.beamSize}px
                        </span>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <label htmlFor="sp-intensity" className="text-[10px] text-slate-400 whitespace-nowrap">
                          Intensity
                        </label>
                        <input
                          id="sp-intensity"
                          type="range"
                          min={0.1}
                          max={1}
                          step={0.05}
                          value={activeSpotlightProps.intensity}
                          onChange={(e) =>
                            updateActiveSpotlightProps({ intensity: Number(e.target.value) })
                          }
                          className="pitch-slider w-11"
                        />
                        <span className="font-mono tabular-nums text-[10px] text-slate-200 w-7 text-right">
                          {activeSpotlightProps.intensity.toFixed(2)}
                        </span>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <label htmlFor="sp-rotation" className="text-[10px] text-slate-400 whitespace-nowrap">
                          Tilt (X)
                        </label>
                        <input
                          id="sp-rotation"
                          type="range"
                          min={0.2}
                          max={1}
                          step={0.05}
                          value={activeSpotlightProps.rotation}
                          onChange={(e) =>
                            updateActiveSpotlightProps({ rotation: Number(e.target.value) })
                          }
                          className="pitch-slider w-11"
                        />
                        <span className="font-mono tabular-nums text-[10px] text-slate-200 w-7 text-right">
                          {activeSpotlightProps.rotation.toFixed(2)}
                        </span>
                      </div>

                      <label className="flex items-center gap-1 cursor-pointer select-none whitespace-nowrap shrink-0">
                        <input
                          type="checkbox"
                          checked={activeSpotlightProps.trackWithCv}
                          onChange={(e) =>
                            updateActiveSpotlightProps({ trackWithCv: e.target.checked })
                          }
                          className="accent-emerald-500 w-3 h-3 rounded"
                        />
                        <span className="text-[10px] text-slate-300">Follow CV</span>
                      </label>
                    </>
                  ) : showBoxSettings && editingSelectedBox ? (
                    <>
                      <span className="text-[10px] font-semibold text-emerald-400 whitespace-nowrap shrink-0">
                        Box
                      </span>

                      <input
                        type="text"
                        value={editingSelectedBox.label}
                        onChange={(e) =>
                          setPlayers((prev) =>
                            prev.map((p) =>
                              p.id === editingSelectedBox.id ? { ...p, label: e.target.value } : p
                            )
                          )
                        }
                        aria-label="Selected player label"
                        className="w-24 bg-[#141B24] border border-[#243040] focus:border-emerald-500/60 rounded px-1.5 py-[1px] text-[10px] font-medium text-slate-100 outline-none shrink-0"
                      />

                      <div className="flex items-center p-[1px] rounded bg-[#0B0F14] border border-[#1E2936] shrink-0">
                        {(
                          [
                            { id: 'ring', label: 'Box' },
                            { id: 'spotlight', label: 'Spotlight' },
                            { id: 'foot-ring', label: '3D Ring' },
                          ] as const
                        ).map((st) => (
                          <button
                            key={st.id}
                            type="button"
                            onClick={() =>
                              setPlayers((prev) =>
                                prev.map((p) => {
                                  if (p.id !== editingSelectedBox.id) return p;
                                  if (st.id === 'spotlight' && !p.spotlight) {
                                    return {
                                      ...p,
                                      style: st.id,
                                      spotlight: {
                                        beamSize: spotlightSettings.beamSize,
                                        intensity: spotlightSettings.intensity,
                                        rotation: spotlightSettings.rotation,
                                      },
                                    };
                                  }
                                  if (st.id === 'foot-ring' && !p.ring) {
                                    return {
                                      ...p,
                                      style: st.id,
                                      ring: {
                                        ringSize: ringSettings.ringSize,
                                        ringThickness: ringSettings.ringThickness,
                                        tiltDeg: ringSettings.tiltDeg,
                                        spinSpeed: ringSettings.spinSpeed,
                                      },
                                    };
                                  }
                                  return { ...p, style: st.id };
                                })
                              )
                            }
                            className={`px-1.5 py-[1px] rounded text-[10px] transition-colors whitespace-nowrap ${
                              editingSelectedBox.style === st.id
                                ? 'bg-[#1D2735] text-slate-100 font-medium'
                                : 'text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            {st.label}
                          </button>
                        ))}
                      </div>

                      <label className="flex items-center gap-1 cursor-pointer select-none whitespace-nowrap shrink-0">
                        <input
                          type="checkbox"
                          checked={editingSelectedBox.showTrail}
                          onChange={(e) =>
                            setPlayers((prev) =>
                              prev.map((p) =>
                                p.id === editingSelectedBox.id
                                  ? { ...p, showTrail: e.target.checked }
                                  : p
                              )
                            )
                          }
                          className="accent-emerald-500 w-3 h-3 rounded"
                        />
                        <span className="text-[10px] text-slate-300">Trail</span>
                      </label>

                      <label className="flex items-center gap-1 cursor-pointer select-none whitespace-nowrap shrink-0">
                        <input
                          type="checkbox"
                          checked={editingSelectedBox.trackWithCv !== false}
                          onChange={(e) =>
                            setPlayers((prev) =>
                              prev.map((p) =>
                                p.id === editingSelectedBox.id
                                  ? { ...p, trackWithCv: e.target.checked }
                                  : p
                              )
                            )
                          }
                          className="accent-emerald-500 w-3 h-3 rounded"
                        />
                        <span className="text-[10px] text-slate-300">Follow CV</span>
                      </label>
                    </>
                  ) : null}
                </div>
              </>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              disabled={!activeVideoUrl || duration <= 0}
              onClick={() => {
                setIsPlaying(false);
                setIsSamplingPitch(false);
                setRealigningPlayerId(null);
                setRealigningNodeId(null);
                setIsExportModalOpen(true);
              }}
              title="Export tracked video clip as MP4"
              className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded bg-[#141B24] hover:bg-[#1E2734] border border-[#243040] text-slate-200 text-[10.5px] font-medium transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-emerald-300"
            >
              <Download className="w-3 h-3 text-emerald-400" />
              <span>Export MP4</span>
            </button>

            <button
              type="button"
              onClick={() => headerFileInputRef.current?.click()}
              className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-[10.5px] font-semibold transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-emerald-300"
            >
              <Upload className="w-3 h-3" />
              <span>Import Match</span>
            </button>
          </div>
        </header>

        {/* All Tools in One Compact Single-Line Top Panel */}
        <div className="h-[29px] px-2.5 bg-[#10151D] flex items-center justify-between gap-1.5 overflow-x-auto no-scrollbar flex-nowrap">
          <div className="flex items-center gap-1 shrink-0">
            {/* Primary Telestration & Tracking Tools */}
            <div className="flex items-center p-[1px] rounded bg-[#0B0F14] border border-[#1E2936]">
              <button
                type="button"
                onClick={() => {
                  setIsSlowTrackingDetected(false);
                  setRealigningPlayerId(null);
                  setRealigningNodeId(null);
                  setIsSamplingPitch(false);
                  setShowChromaBar(false);
                  setNeedsChromaPrompt(false);
                  setShowPlayerBoxBar(false);
                  setDetectorSubTool(null);
                  setSelectedPlayerId(null);
                  setSelectedNodeId(null);
                  setToolMode('circle');
                }}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                  toolMode === 'circle' && !realigningPlayerId && !detectorSubTool
                    ? 'bg-[#1D2735] text-emerald-400'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <BoxSelect className="w-3 h-3" />
                <span>Box (B)</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsSlowTrackingDetected(false);
                  setRealigningPlayerId(null);
                  setRealigningNodeId(null);
                  setIsSamplingPitch(false);
                  setShowChromaBar(false);
                  setNeedsChromaPrompt(false);
                  setShowPlayerBoxBar(false);
                  setDetectorSubTool(null);
                  setSelectedPlayerId(null);
                  setSelectedNodeId(null);
                  setToolMode('spotlight');
                }}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                  toolMode === 'spotlight' && !realigningPlayerId && !detectorSubTool
                    ? 'bg-[#1D2735] text-amber-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Sun className="w-3 h-3" />
                <span>Spotlight (S)</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsSlowTrackingDetected(false);
                  setRealigningPlayerId(null);
                  setRealigningNodeId(null);
                  setIsSamplingPitch(false);
                  setShowChromaBar(false);
                  setNeedsChromaPrompt(false);
                  setShowPlayerBoxBar(false);
                  setDetectorSubTool(null);
                  setSelectedPlayerId(null);
                  setSelectedNodeId(null);
                  setToolMode('ring');
                }}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                  toolMode === 'ring' && !realigningPlayerId && !detectorSubTool
                    ? 'bg-[#1D2735] text-cyan-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Disc className="w-3 h-3" />
                <span>Ring (G)</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsSlowTrackingDetected(false);
                  setRealigningPlayerId(null);
                  setRealigningNodeId(null);
                  setIsSamplingPitch(false);
                  setShowChromaBar(false);
                  setNeedsChromaPrompt(false);
                  setShowPlayerBoxBar(false);
                  setDetectorSubTool(null);
                  setSelectedPlayerId(null);
                  setSelectedNodeId(null);
                  setToolMode('chain');
                }}
                title="Click already-added 3D Rings to connect them with a Chain beam, double-click to finish (L)"
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                  toolMode === 'chain' && !realigningPlayerId && !detectorSubTool
                    ? 'bg-[#1D2735] text-sky-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Link2 className="w-3 h-3" />
                <span>Chain (L)</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsSlowTrackingDetected(false);
                  setRealigningPlayerId(null);
                  setRealigningNodeId(null);
                  setIsSamplingPitch(false);
                  setShowChromaBar(false);
                  setNeedsChromaPrompt(false);
                  setShowPlayerBoxBar(false);
                  setDetectorSubTool(null);
                  setSelectedPlayerId(null);
                  setSelectedNodeId(null);
                  setToolMode('polygon');
                }}
                title="Click to place polygon vertices, click first point or double-click to close — each vertex follows its player (P)"
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                  toolMode === 'polygon' && !realigningPlayerId && !detectorSubTool
                    ? 'bg-[#1D2735] text-rose-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Pentagon className="w-3 h-3" />
                <span>Polygon (P)</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsSlowTrackingDetected(false);
                  setRealigningPlayerId(null);
                  setRealigningNodeId(null);
                  setIsSamplingPitch(false);
                  setShowChromaBar(false);
                  setNeedsChromaPrompt(false);
                  setShowPlayerBoxBar(false);
                  setDetectorSubTool(null);
                  setToolMode('select');
                }}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                  toolMode === 'select' && !realigningPlayerId && !detectorSubTool
                    ? 'bg-[#1D2735] text-cyan-400'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <MousePointer2 className="w-3 h-3" />
                <span>Select (V)</span>
              </button>
              <button
                type="button"
                disabled={players.length === 0}
                onClick={() => {
                  setIsSlowTrackingDetected(false);
                  setShowChromaBar(false);
                  setIsSamplingPitch(false);
                  setNeedsChromaPrompt(false);
                  setShowPlayerBoxBar(false);
                  setDetectorSubTool(null);
                  if (realigningPlayerId) {
                    setRealigningPlayerId(null);
                    setRealigningNodeId(null);
                  } else {
                    const targetId = selectedPlayerId ?? players[0]?.id;
                    if (targetId) handleStartRealign(targetId, selectedNodeId);
                  }
                }}
                title="Relocate a mistracked overlay on the current frame and auto-track remaining frames (R)"
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 ${
                  realigningPlayerId
                    ? 'bg-amber-500/20 text-amber-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Crosshair className="w-3 h-3" />
                <span>Realign (R)</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsSlowTrackingDetected(false);
                  setRealigningPlayerId(null);
                  setRealigningNodeId(null);
                  setIsSamplingPitch(false);
                  setShowChromaBar(false);
                  setNeedsChromaPrompt(false);
                  setShowPlayerBoxBar(false);
                  setDetectorSubTool(null);
                  setSelectedPlayerId(null);
                  setSelectedNodeId(null);
                  setToolMode('erase');
                }}
                title="Click any tracked box, spotlight, ring, chain, or polygon on the stage to erase it (E)"
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                  toolMode === 'erase' && !realigningPlayerId && !detectorSubTool
                    ? 'bg-rose-500/20 text-rose-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Eraser className="w-3 h-3" />
                <span>Erase (E)</span>
              </button>
            </div>

            <div className="h-3.5 w-px bg-[#1E2936] shrink-0" aria-hidden="true" />

            {/* Player Detector & Player Box (requires Chroma Key green pitch sampling first) */}
            <div className="flex items-center p-[1px] rounded bg-[#0B0F14] border border-[#1E2936]">
              <button
                type="button"
                disabled={!activeVideoUrl}
                onClick={handleRunPlayerDetector}
                title={
                  chromaKey.hasCustomSamples
                    ? implementedTracks.length > 0
                      ? 'Re-track players across video (replaces old tracking data when implemented)'
                      : 'Detect all human players inside the chroma-keyed green pitch'
                    : 'Sample green pitch with Chroma Key first to run Player Detector'
                }
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 ${
                  needsChromaPrompt && !chromaKey.hasCustomSamples
                    ? 'bg-amber-500/20 text-amber-300'
                    : 'text-emerald-300 hover:bg-[#1D2735] hover:text-emerald-200'
                }`}
              >
                <ScanSearch className="w-3 h-3" />
                <span>{implementedTracks.length > 0 ? 'Re-track' : 'Player Detector'}</span>
              </button>

              <button
                type="button"
                disabled={!activeVideoUrl}
                onClick={handleOpenPlayerBox}
                aria-pressed={showPlayerBoxBar && showDetectedBoxes}
                title="Show detected player boxes to Adjust (reposition/resize smoothly), Drawer (add missed players), or Eraser (remove false positives)"
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 ${
                  showPlayerBoxBar
                    ? 'bg-[#1D2735] text-emerald-400'
                    : showDetectedBoxes && detectedBoxes.length > 0
                      ? 'text-emerald-300 hover:text-emerald-200'
                      : 'text-slate-300 hover:text-slate-100'
                }`}
              >
                <BoxSelect className="w-3 h-3" />
                <span>Player Box</span>
                {detectedBoxes.length > 0 && (
                  <span className="font-mono tabular-nums text-[9.5px] text-emerald-400">
                    {detectedBoxes.length}
                  </span>
                )}
              </button>
            </div>

            <div className="h-3.5 w-px bg-[#1E2936] shrink-0" aria-hidden="true" />

            {/* Active Swatch Picker (updates selected tool if selected, otherwise creation default) */}
            <div className="flex items-center gap-1 px-0.5 shrink-0">
              {(() => {
                const applySelectedColor = (hex: string) => {
                  if (!selectedPlayer) return;
                  const targetId = selectedPlayer.id;
                  setPlayers((prev) =>
                    prev.map((p) => {
                      if (p.id !== targetId) return p;
                      if (p.style === 'polygon' && p.polygon) {
                        return {
                          ...p,
                          color: hex,
                          polygon: {
                            ...p.polygon,
                            borderColor: hex,
                            fillColor: p.polygon.fillColor === p.color ? hex : p.polygon.fillColor,
                          },
                        };
                      }
                      return { ...p, color: hex };
                    })
                  );
                };

                const swatchMode = selectedPlayer
                  ? selectedPlayer.style === 'spotlight'
                    ? 'spotlight'
                    : selectedPlayer.style === 'foot-ring'
                      ? 'ring'
                      : selectedPlayer.style === 'chain'
                        ? 'chain'
                        : selectedPlayer.style === 'polygon'
                          ? 'polygon'
                          : 'circle'
                  : toolMode;

                if (swatchMode === 'spotlight') {
                  const currentHex = selectedPlayer ? selectedPlayer.color : spotlightSettings.color;
                  return SPOTLIGHT_COLORS.map((swatch) => (
                    <button
                      key={swatch.hex}
                      type="button"
                      onClick={() =>
                        selectedPlayer
                          ? applySelectedColor(swatch.hex)
                          : setSpotlightSettings((prev) => ({ ...prev, color: swatch.hex }))
                      }
                      title={`Spotlight color: ${swatch.name}`}
                      style={{ backgroundColor: swatch.hex }}
                      className={`w-3 h-3 rounded-full transition-transform ${
                        currentHex.toUpperCase() === swatch.hex.toUpperCase()
                          ? 'ring-2 ring-white ring-offset-1 ring-offset-[#10151D] scale-110'
                          : 'opacity-70 hover:opacity-100'
                      }`}
                    />
                  ));
                }
                if (swatchMode === 'ring') {
                  const currentHex = selectedPlayer ? selectedPlayer.color : ringSettings.color;
                  return RING_COLORS.map((swatch) => (
                    <button
                      key={swatch.hex}
                      type="button"
                      onClick={() =>
                        selectedPlayer
                          ? applySelectedColor(swatch.hex)
                          : setRingSettings((prev) => ({ ...prev, color: swatch.hex }))
                      }
                      title={`Ring color: ${swatch.name}`}
                      style={{ backgroundColor: swatch.hex }}
                      className={`w-3 h-3 rounded-full transition-transform ${
                        currentHex.toUpperCase() === swatch.hex.toUpperCase()
                          ? 'ring-2 ring-white ring-offset-1 ring-offset-[#10151D] scale-110'
                          : 'opacity-70 hover:opacity-100'
                      }`}
                    />
                  ));
                }
                if (swatchMode === 'chain') {
                  const currentHex = selectedPlayer ? selectedPlayer.color : chainSettings.color;
                  return RING_COLORS.map((swatch) => (
                    <button
                      key={swatch.hex}
                      type="button"
                      onClick={() =>
                        selectedPlayer
                          ? applySelectedColor(swatch.hex)
                          : setChainSettings((prev) => ({ ...prev, color: swatch.hex }))
                      }
                      title={`Chain color: ${swatch.name}`}
                      style={{ backgroundColor: swatch.hex }}
                      className={`w-3 h-3 rounded-full transition-transform ${
                        currentHex.toUpperCase() === swatch.hex.toUpperCase()
                          ? 'ring-2 ring-white ring-offset-1 ring-offset-[#10151D] scale-110'
                          : 'opacity-70 hover:opacity-100'
                      }`}
                    />
                  ));
                }
                if (swatchMode === 'polygon') {
                  const currentHex = selectedPlayer
                    ? selectedPlayer.polygon?.borderColor ?? selectedPlayer.color
                    : polygonSettings.borderColor;
                  return POLYGON_COLORS.map((swatch) => (
                    <button
                      key={swatch.hex}
                      type="button"
                      onClick={() =>
                        selectedPlayer
                          ? applySelectedColor(swatch.hex)
                          : setPolygonSettings((prev) => ({
                              ...prev,
                              borderColor: swatch.hex,
                              fillColor: swatch.hex,
                            }))
                      }
                      title={`Polygon color: ${swatch.name}`}
                      style={{ backgroundColor: swatch.hex }}
                      className={`w-3 h-3 rounded-full transition-transform ${
                        currentHex.toUpperCase() === swatch.hex.toUpperCase()
                          ? 'ring-2 ring-white ring-offset-1 ring-offset-[#10151D] scale-110'
                          : 'opacity-70 hover:opacity-100'
                      }`}
                    />
                  ));
                }

                const currentHex = selectedPlayer ? selectedPlayer.color : activeColor;
                return PLAYER_COLORS.map((swatch) => (
                  <button
                    key={swatch.hex}
                    type="button"
                    onClick={() =>
                      selectedPlayer ? applySelectedColor(swatch.hex) : setActiveColor(swatch.hex)
                    }
                    title={selectedPlayer ? `Color: ${swatch.name}` : `Next box color: ${swatch.name}`}
                    style={{ backgroundColor: swatch.hex }}
                    className={`w-3 h-3 rounded-full transition-transform ${
                      currentHex.toUpperCase() === swatch.hex.toUpperCase()
                        ? 'ring-2 ring-white ring-offset-1 ring-offset-[#10151D] scale-110'
                        : 'opacity-70 hover:opacity-100'
                    }`}
                  />
                ));
              })()}
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {(coverageSummary.trackedSeconds > 0 ||
              detectedBoxes.length > 0 ||
              implementedTracks.length > 0 ||
              players.length > 0) && (
              <button
                type="button"
                onClick={() => setShowCoverageOverlay((prev) => !prev)}
                aria-pressed={showCoverageOverlay}
                title={`Toggle spatial tracking coverage mask & untracked hints (${coverageSummary.coveragePct}% tracked · never exported)`}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                  showCoverageOverlay
                    ? 'bg-sky-500/12 border-sky-500/35 text-sky-300'
                    : 'bg-[#141B24] border-[#243040] text-slate-400 hover:text-slate-200'
                }`}
              >
                {showCoverageOverlay ? (
                  <Eye className="w-3 h-3" />
                ) : (
                  <EyeOff className="w-3 h-3" />
                )}
                <span>Coverage</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setShowTrails((prev) => !prev)}
              aria-pressed={showTrails}
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                showTrails
                  ? 'bg-emerald-500/12 border-emerald-500/35 text-emerald-400'
                  : 'bg-[#141B24] border-[#243040] text-slate-400 hover:text-slate-200'
              }`}
            >
              <Activity className="w-3 h-3" />
              <span>Trails</span>
            </button>

            {/* Chroma Key Controls */}
            <div className="flex items-center p-[1px] rounded bg-[#0B0F14] border border-[#1E2936]">
              <button
                type="button"
                onClick={() => {
                  setShowChromaBar((prev) => {
                    const next = !prev;
                    if (!next) {
                      setIsSamplingPitch(false);
                      setNeedsChromaPrompt(false);
                    } else {
                      setShowPlayerBoxBar(false);
                      setDetectorSubTool(null);
                    }
                    return next;
                  });
                }}
                aria-pressed={showChromaBar}
                title="Configure pitch chroma key colors (tools always layer between pitch and players)"
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                  showChromaBar
                    ? 'bg-[#1D2735] text-emerald-400'
                    : 'text-slate-300 hover:text-slate-100'
                }`}
              >
                <Layers className="w-3 h-3 text-emerald-400" />
                <span>Chroma Key</span>
                <span className="flex items-center -space-x-1 shrink-0">
                  {chromaKey.keyColors.slice(0, 3).map((hex, i) => (
                    <span
                      key={`${hex}_${i}`}
                      className="w-1.5 h-1.5 rounded-sm border border-white/30"
                      style={{ backgroundColor: hex }}
                    />
                  ))}
                </span>
              </button>

              <button
                type="button"
                disabled={!activeVideoUrl}
                onClick={() => {
                  setRealigningPlayerId(null);
                  setRealigningNodeId(null);
                  setShowPlayerBoxBar(false);
                  setDetectorSubTool(null);
                  setIsPlaying(false);
                  setIsSamplingPitch((prev) => {
                    const next = !prev;
                    if (next) setShowChromaBar(true);
                    return next;
                  });
                }}
                aria-pressed={isSamplingPitch}
                title="Click spots on the pitch to sample multiple turf colors"
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 ${
                  isSamplingPitch
                    ? 'bg-cyan-500/20 text-cyan-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Pipette className="w-3 h-3" />
                <span>Sample</span>
              </button>

              <button
                type="button"
                disabled={!activeVideoUrl}
                onClick={() =>
                  setChromaKey((prev) => ({ ...prev, showMask: !prev.showMask }))
                }
                aria-pressed={chromaKey.showMask}
                title="Highlight the chroma-keyed pitch portion to verify player cutout"
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 ${
                  chromaKey.showMask
                    ? 'bg-fuchsia-500/20 text-fuchsia-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Eye className="w-3 h-3" />
                <span>Mask</span>
              </button>
            </div>

            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleUndo}
                disabled={!undoRedoState.canUndo}
                title="Undo (Ctrl+Z)"
                aria-label="Undo"
                className="p-0.5 rounded bg-[#141B24] hover:bg-[#1E2734] border border-[#243040] text-slate-200 transition-colors shrink-0 disabled:opacity-40"
              >
                <Undo2 className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={handleRedo}
                disabled={!undoRedoState.canRedo}
                title="Redo (Ctrl+Y)"
                aria-label="Redo"
                className="p-0.5 rounded bg-[#141B24] hover:bg-[#1E2734] border border-[#243040] text-slate-200 transition-colors shrink-0 disabled:opacity-40"
              >
                <Redo2 className="w-3 h-3" />
              </button>
            </div>

            <button
              type="button"
              disabled={!targetStopPlayer || (isTargetStopped && isTargetAtClipEnd)}
              onClick={() => {
                if (!targetStopPlayer) return;
                if (isTargetStopped) {
                  handleResumeTrackingPlayer(targetStopPlayer.id);
                } else {
                  handleStopTrackingPlayer(targetStopPlayer.id);
                }
              }}
              title={
                isTargetStopped
                  ? isTargetAtClipEnd
                    ? `${targetStopPlayer?.label ?? 'Player'} already tracks to end of video`
                    : `Resume CV tracking for ${targetStopPlayer?.label ?? 'player'} (+10s)`
                  : 'Stop tracking here — keep already-tracked portion in video data, stop tracking forward'
              }
              className={`flex items-center justify-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 ${
                isTargetStopped
                  ? 'bg-emerald-500/15 hover:bg-emerald-500/25 border-emerald-500/40 text-emerald-300'
                  : 'bg-[#141B24] hover:bg-amber-500/15 border-[#243040] hover:border-amber-500/40 text-amber-300'
              }`}
            >
              {isTargetStopped ? (
                <>
                  <Play className="w-2.5 h-2.5" />
                  <span>Resume +10s</span>
                </>
              ) : (
                <>
                  <Square className="w-2.5 h-2.5 fill-current" />
                  <span>Stop Track</span>
                </>
              )}
            </button>

            <button
              type="button"
              disabled={players.length === 0}
              onClick={() => {
                pushUndoSnapshot();
                setPlayers([]);
                setSelectedPlayerId(null);
                setSelectedNodeId(null);
                setRealigningPlayerId(null);
                setRealigningNodeId(null);
              }}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#141B24] hover:bg-[#1E2734] border border-[#243040] text-slate-300 text-[10px] font-medium transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
            >
              <Trash className="w-2.5 h-2.5" />
              <span>Clear</span>
            </button>
          </div>
        </div>
      </div>

      {/* Main 3-Column Tactical Workstation */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
        <OpfsSidebar
          videos={videos}
          activeVideoName={activeVideoName}
          storageInfo={storageInfo}
          isUploading={isUploading}
          uploadProgress={uploadProgress}
          isGeneratingSample={isGeneratingSample}
          sampleProgress={sampleProgress}
          cvSettings={cvSettings}
          isCollapsed={!showLeftPanel}
          showVisionSettings={showVisionSettings}
          onToggleCollapse={() => setShowLeftPanel((prev) => !prev)}
          onOpenVisionSettings={() => {
            setShowLeftPanel(true);
            setShowVisionSettings(true);
          }}
          onToggleVisionSettings={() => setShowVisionSettings((prev) => !prev)}
          onUpdateSettings={setCvSettings}
          onSelectVideo={loadVideoFromOpfs}
          onUploadFiles={handleUploadFiles}
          onDeleteVideo={handleDeleteVideo}
          onGenerateSample={handleGenerateSample}
        />

        {/* Center Video Stage + Compact Single-Line Transport/Timeline */}
        <main id="tracking-stage" className="flex-1 min-w-0 min-h-0 flex flex-col bg-[#0B0F14] overflow-hidden">
          {/* Unobstructed Video Canvas Stage */}
          <div className="relative flex-1 min-h-[120px] flex flex-col">
            {errorMessage && (
              <div className="absolute top-3 right-3 z-40 max-w-md flex items-center gap-2 px-3 py-1.5 rounded-md bg-rose-950/90 border border-rose-500/50 text-rose-100 text-[11px] shadow-xl">
                <AlertCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                <span className="truncate">{errorMessage}</span>
                <button
                  type="button"
                  onClick={() => setErrorMessage(null)}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-rose-500/20 hover:bg-rose-500/35 text-rose-200 text-[10px] font-medium whitespace-nowrap shrink-0"
                >
                  <X className="w-3 h-3" />
                  <span>Dismiss</span>
                </button>
              </div>
            )}

            <VideoTrackingStage
              videoUrl={activeVideoUrl}
              isPlaying={isPlaying}
              playbackRate={playbackRate}
              isLooping={isLooping}
              toolMode={toolMode}
              activeColor={activeColor}
              activeStyle={activeStyle}
              showTrails={showTrails}
              spotlightSettings={spotlightSettings}
              ringSettings={ringSettings}
              chainSettings={chainSettings}
              polygonSettings={polygonSettings}
              selectedPlayerId={selectedPlayerId}
              selectedNodeId={selectedNodeId}
              realigningPlayerId={realigningPlayerId}
              realigningNodeId={realigningNodeId}
              players={players}
              cvSettings={cvSettings}
              chromaKey={chromaKey}
              isSamplingPitch={isSamplingPitch}
              seekRequest={seekRequest}
              reanchorRequest={reanchorRequest}
              detectedBoxes={detectedBoxes}
              implementedTracks={implementedTracks}
              hoveredTrackedPlayerId={hoveredTrackedPlayerId}
              selectedDetectedBoxId={selectedDetectedBoxId}
              showDetectedBoxes={showDetectedBoxes}
              showPlayerBoxBar={showPlayerBoxBar}
              detectorSubTool={detectorSubTool}
              detectRequestSeq={detectRequestSeq}
              resetDetectorSeq={resetDetectorSeq}
              clearDetectedSeq={clearDetectedSeq}
              eraseSelectedDetectedSeq={eraseSelectedDetectedSeq}
              isSlowTrackingDetected={isSlowTrackingDetected}
              implementRequest={implementRequest}
              videoRefExternal={videoElRef}
              onVideoMetadata={(dur, w, h) => {
                setDuration(dur);
                if (w > 0 && h > 0) {
                  setVideoDimensions({ width: w, height: h });
                }
              }}
              onRenderRectWidthChange={setStageRenderWidth}
              onTimeUpdate={setCurrentTime}
              onPlayStateChange={setIsPlaying}
              onPushUndoSnapshot={pushUndoSnapshot}
              onAddPlayerCircle={handleAddPlayerCircle}
              onAddSpotlight={handleAddSpotlight}
              onAddRing={handleAddRing}
              onAddChainFromRings={handleAddChainFromRings}
              onAddPolygon={handleAddPolygon}
              onAttachToolToTrack={handleAttachToolToTrack}
              onUpdatePlayerAnchor={handleUpdatePlayerAnchor}
              onUpdateNodeAnchor={handleUpdateNodeAnchor}
              onShiftGroupAnchor={handleShiftGroupAnchor}
              onSelectPlayer={(id) => {
                setSelectedPlayerId(id);
                if (!id) setSelectedNodeId(null);
              }}
              onSelectNode={setSelectedNodeId}
              onErasePlayer={handleDeletePlayer}
              onCompleteRealign={() => {
                setRealigningPlayerId(null);
                setRealigningNodeId(null);
              }}
              onPlayersTrackedFrame={handlePlayersTrackedFrame}
              onPlayersTrackedBatch={handlePlayersTrackedBatch}
              onGenerateSample={handleGenerateSample}
              onSamplePitchColor={handleSamplePitchColor}
              onDetectedBoxesResult={handleDetectedBoxesResult}
              onAddDetectedBoxManual={handleAddDetectedBoxManual}
              onEraseDetectedBox={handleEraseDetectedBox}
              onDetectorStatsChange={setDetectorStats}
              onSelectDetectedBox={setSelectedDetectedBoxId}
              onDetectedBoxesSync={setDetectedBoxes}
              onBackgroundTracksSync={setBackgroundTracks}
              onFullSweepTimesSync={setFullSweepTimes}
              onSlowTrackStep={handleSlowTrackStep}
              onSlowTrackStateChange={setIsSlowTrackingDetected}
              onImplementTrackedTracks={handleImplementTrackedTracks}
              showCoverageOverlay={showCoverageOverlay}
              coverageSummary={coverageSummary}
              onToggleCoverageOverlay={() => setShowCoverageOverlay((prev) => !prev)}
              onJumpToNextGap={() => {
                if (coverageSummary.nextGapTime !== null) {
                  handleSeek(coverageSummary.nextGapTime);
                }
              }}
            />
          </div>

          <PlayerTransport
            hasVideo={Boolean(activeVideoUrl)}
            isPlaying={isPlaying || isSlowTrackingDetected}
            currentTime={currentTime}
            duration={duration}
            playbackRate={playbackRate}
            isLooping={isLooping}
            players={players}
            selectedPlayerId={selectedPlayerId}
            coverageSummary={coverageSummary}
            backgroundTracks={backgroundTracks}
            implementedTracks={implementedTracks}
            hoveredTrackedPlayerId={hoveredTrackedPlayerId}
            onHoverTrackedPlayer={setHoveredTrackedPlayerId}
            onTogglePlay={handleTogglePlay}
            onStepFrame={handleStepFrame}
            onSkipSeconds={handleSkipSeconds}
            onSeek={handleSeek}
            onChangeRate={setPlaybackRate}
            onToggleLoop={() => setIsLooping((prev) => !prev)}
            onJumpToStart={() => handleSeek(0)}
            onSelectPlayer={(id) => {
              setSelectedPlayerId(id);
              if (id !== selectedPlayerId) {
                setSelectedNodeId(null);
              }
            }}
            onTogglePlayerVisibility={(id) =>
              setPlayers((prev) =>
                prev.map((p) =>
                  p.id === id ? { ...p, visible: !p.visible } : p
                )
              )
            }
            onPausePlayback={() => {
              setIsPlaying(false);
              setIsSlowTrackingDetected(false);
            }}
            onPushUndoSnapshot={pushUndoSnapshot}
            onTrimPlayerSpan={handleTrimPlayerSpan}
            onSetInAtPlayhead={handleSetInAtPlayhead}
            onSetOutAtPlayhead={handleSetOutAtPlayhead}
          />
        </main>

        {showRightPanel && (
          <TracksInspector
            players={players}
            implementedTracks={implementedTracks}
            coverageSummary={coverageSummary}
            hoveredTrackedPlayerId={hoveredTrackedPlayerId}
            currentTime={currentTime}
            duration={duration}
            selectedPlayerId={selectedPlayerId}
            selectedNodeId={selectedNodeId}
            realigningPlayerId={realigningPlayerId}
            realigningNodeId={realigningNodeId}
            onHoverTrackedPlayer={setHoveredTrackedPlayerId}
            onAttachToolToTrack={handleAttachToolToTrack}
            onRetrackPlayers={handleRunPlayerDetector}
            onSelectPlayer={(id) => {
              if (id !== selectedPlayerId) {
                setSelectedNodeId(null);
              }
              setSelectedPlayerId(id);
            }}
            onSelectNode={setSelectedNodeId}
            onRenamePlayer={(id, label) =>
              setPlayers((prev) =>
                prev.map((p) => (p.id === id ? { ...p, label } : p))
              )
            }
            onChangePlayerColor={(id, color) =>
              setPlayers((prev) =>
                prev.map((p) => {
                  if (p.id !== id) return p;
                  if (p.style === 'polygon' && p.polygon) {
                    return {
                      ...p,
                      color,
                      polygon: {
                        ...p.polygon,
                        borderColor: color,
                        fillColor:
                          p.polygon.fillColor === p.color ? color : p.polygon.fillColor,
                      },
                    };
                  }
                  return { ...p, color };
                })
              )
            }
            onChangePlayerStyle={(id, style) =>
              setPlayers((prev) =>
                prev.map((p) => {
                  if (p.id !== id) return p;
                  if (style === 'spotlight' && !p.spotlight) {
                    return {
                      ...p,
                      style,
                      spotlight: {
                        beamSize: spotlightSettings.beamSize,
                        intensity: spotlightSettings.intensity,
                        rotation: spotlightSettings.rotation,
                      },
                    };
                  }
                  if (style === 'foot-ring' && !p.ring) {
                    return {
                      ...p,
                      style,
                      color: p.style === 'spotlight' ? ringSettings.color : p.color,
                      ring: {
                        ringSize: ringSettings.ringSize,
                        ringThickness: ringSettings.ringThickness,
                        tiltDeg: ringSettings.tiltDeg,
                        spinSpeed: ringSettings.spinSpeed,
                      },
                    };
                  }
                  return { ...p, style };
                })
              )
            }
            onUpdatePlayerSpotlight={(id, nextSpotlight: SpotlightProperties) =>
              setPlayers((prev) =>
                prev.map((p) => (p.id === id ? { ...p, spotlight: nextSpotlight } : p))
              )
            }
            onUpdatePlayerRing={(id, nextRing: RingProperties) =>
              setPlayers((prev) =>
                prev.map((p) => (p.id === id ? { ...p, ring: nextRing } : p))
              )
            }
            onUpdatePlayerChain={(id, nextChain: ChainProperties) =>
              setPlayers((prev) =>
                prev.map((p) => (p.id === id ? { ...p, chain: nextChain } : p))
              )
            }
            onUpdatePlayerPolygon={(id, nextPolygon: PolygonProperties) =>
              setPlayers((prev) =>
                prev.map((p) =>
                  p.id === id
                    ? { ...p, color: nextPolygon.borderColor, polygon: nextPolygon }
                    : p
                )
              )
            }
            onTogglePlayerTrackWithCv={(id) =>
              setPlayers((prev) =>
                prev.map((p) => {
                  if (p.id !== id) return p;
                  const nextTrackWithCv = p.trackWithCv === false ? true : false;
                  return {
                    ...p,
                    trackWithCv: nextTrackWithCv,
                    nodes: p.nodes?.map((n) => ({ ...n, trackWithCv: nextTrackWithCv })),
                  };
                })
              )
            }
            onTogglePlayerVisibility={(id) =>
              setPlayers((prev) =>
                prev.map((p) =>
                  p.id === id ? { ...p, visible: !p.visible } : p
                )
              )
            }
            onStopTrackingPlayer={handleStopTrackingPlayer}
            onResumeTrackingPlayer={handleResumeTrackingPlayer}
            onDeletePlayer={handleDeletePlayer}
            onJumpToAnchor={(t) => {
              setIsPlaying(false);
              handleSeek(t);
            }}
            onSeek={(t) => {
              setIsPlaying(false);
              handleSeek(t);
            }}
            onStartRealign={handleStartRealign}
            onCancelRealign={() => {
              setRealigningPlayerId(null);
              setRealigningNodeId(null);
            }}
          />
        )}
      </div>

      {activeVideoUrl && activeVideoName && (
        <ExportClipModal
          isOpen={isExportModalOpen}
          onClose={() => setIsExportModalOpen(false)}
          videoUrl={activeVideoUrl}
          videoName={activeVideoName}
          duration={duration}
          currentTime={currentTime}
          videoWidth={videoDimensions.width}
          videoHeight={videoDimensions.height}
          logicalStageWidth={stageRenderWidth}
          players={players}
          chromaKey={chromaKey}
          cvSettings={cvSettings}
          showTrails={showTrails}
          onSeekPreview={handleSeek}
        />
      )}
    </div>
  );
}

function appendPosToHistory(
  history: CirclePosition[],
  nextPos: CirclePosition
): CirclePosition[] {
  const last = history[history.length - 1];
  if (!last || nextPos.time > last.time + 0.025) {
    return [...history.slice(-2400), nextPos];
  }
  if (nextPos.time < last.time - 0.04) {
    return [
      ...history.filter((pt) => pt.time <= nextPos.time - 0.025).slice(-2400),
      nextPos,
    ];
  }
  if (nextPos.status === 'stopped') {
    return [...history.slice(0, -1), nextPos];
  }
  return history;
}

function applyTrackedBatch(
  history: CirclePosition[],
  currentPosition: CirclePosition,
  batch: CirclePosition[],
  stopLimit: number | undefined
): {
  nextHistory: CirclePosition[];
  latestPos: CirclePosition;
  stoppedPos: CirclePosition | null;
} {
  let nextHistory = history.slice();
  let latestPos = currentPosition;
  let stoppedPos: CirclePosition | null = null;

  for (const nextPos of batch) {
    if (stopLimit !== undefined && nextPos.time > stopLimit + 0.02) {
      break;
    }
    latestPos = nextPos;
    const last = nextHistory[nextHistory.length - 1];
    if (!last || nextPos.time > last.time + 0.025) {
      nextHistory.push(nextPos);
    } else if (nextPos.time < last.time - 0.04) {
      nextHistory = nextHistory.filter((pt) => pt.time <= nextPos.time - 0.025);
      nextHistory.push(nextPos);
    } else if (nextPos.status === 'stopped') {
      nextHistory[Math.max(0, nextHistory.length - 1)] = nextPos;
    }
    if (nextPos.status === 'stopped') {
      stoppedPos = nextPos;
      break;
    }
  }

  if (nextHistory.length > 2401) {
    nextHistory = nextHistory.slice(-2401);
  }

  return { nextHistory, latestPos, stoppedPos };
}

function summarizeNodesPosition(
  nodes: TrackedNode[],
  fallback: CirclePosition
): CirclePosition {
  if (nodes.length === 0) return fallback;
  let sumCx = 0;
  let sumCy = 0;
  let sumConf = 0;
  let maxTime = fallback.time;
  let hasTracking = false;
  let hasAnchored = false;
  let hasOccluded = false;
  let hasLost = false;
  let allStopped = true;

  for (const node of nodes) {
    const pos = node.currentPosition;
    sumCx += pos.cx;
    sumCy += pos.cy;
    sumConf += pos.confidence;
    if (pos.time > maxTime) maxTime = pos.time;
    if (pos.status !== 'stopped') allStopped = false;
    if (pos.status === 'tracking') hasTracking = true;
    else if (pos.status === 'anchored') hasAnchored = true;
    else if (pos.status === 'occluded') hasOccluded = true;
    else if (pos.status === 'lost') hasLost = true;
  }

  const status: CirclePosition['status'] = allStopped
    ? 'stopped'
    : hasTracking
      ? 'tracking'
      : hasOccluded
        ? 'occluded'
        : hasLost
          ? 'lost'
          : hasAnchored
            ? 'anchored'
            : fallback.status;

  const first = nodes[0].currentPosition;
  return {
    cx: sumCx / nodes.length,
    cy: sumCy / nodes.length,
    width: first.width,
    height: first.height,
    radius: first.radius,
    confidence: sumConf / nodes.length,
    status,
    time: maxTime,
  };
}

function hexRgbDistance(hexA: string, hexB: string): number {
  const a = hexA.replace('#', '');
  const b = hexB.replace('#', '');
  const ar = parseInt(a.slice(0, 2), 16) || 0;
  const ag = parseInt(a.slice(2, 4), 16) || 0;
  const ab = parseInt(a.slice(4, 6), 16) || 0;
  const br = parseInt(b.slice(0, 2), 16) || 0;
  const bg = parseInt(b.slice(2, 4), 16) || 0;
  const bb = parseInt(b.slice(4, 6), 16) || 0;
  return Math.hypot(ar - br, ag - bg, ab - bb);
}
