export type ToolMode =
  | 'circle'
  | 'select'
  | 'spotlight'
  | 'ring'
  | 'chain'
  | 'polygon'
  | 'erase';

export type CircleStyle =
  | 'ring'
  | 'halo'
  | 'reticle'
  | 'spotlight'
  | 'foot-ring'
  | 'chain'
  | 'polygon';

export type TrackingStatus = 'anchored' | 'tracking' | 'occluded' | 'lost' | 'stopped';

export interface OpfsVideoEntry {
  name: string;
  size: number;
  lastModified: number;
  type: string;
  storageKind: 'opfs' | 'memory';
}

export interface StorageUsageInfo {
  usageBytes: number;
  quotaBytes: number;
  backend: 'opfs' | 'memory';
}

/**
 * Coordinates are normalized [0..1] relative to video natural width & height
 * so rectangular player boxes stay pinned accurately regardless of canvas CSS sizing.
 * `width` is normalized against video natural width, `height` against video natural height.
 */
export interface CirclePosition {
  cx: number;
  cy: number;
  width: number;
  height: number;
  radius: number;
  confidence: number;
  status: TrackingStatus;
  time: number;
}

export interface SpotlightProperties {
  beamSize: number;
  intensity: number;
  rotation: number;
}

export interface SpotlightSettings extends SpotlightProperties {
  color: string;
  trackWithCv: boolean;
}

export const MIN_RING_SIZE = 16;
export const MAX_RING_SIZE = 180;
export const MIN_RING_THICKNESS = 10;
export const MAX_RING_THICKNESS = 76;
export const DEFAULT_RING_THICKNESS = 44;

export interface RingProperties {
  ringSize: number;
  ringThickness?: number;
  tiltDeg: number;
  spinSpeed: number;
}

export interface RingSettings extends RingProperties {
  ringThickness: number;
  color: string;
  trackWithCv: boolean;
}

export interface ChainProperties extends RingProperties {
  connectorWidth: number;
  dashed?: boolean;
}

export interface ChainSettings extends ChainProperties {
  ringThickness: number;
  color: string;
  trackWithCv: boolean;
  dashed: boolean;
}

export interface PolygonProperties {
  borderColor: string;
  borderThickness: number;
  dashedBorder: boolean;
  fillColor: string;
  fillOpacity: number;
  markerSize: number;
}

export interface PolygonSettings extends PolygonProperties {
  trackWithCv: boolean;
}

export interface TrackedNode {
  id: string;
  label: string;
  trackWithCv: boolean;
  attachedTrackId?: string;
  anchorTime: number;
  anchorPosition: CirclePosition;
  keyframes: CirclePosition[];
  currentPosition: CirclePosition;
  history: CirclePosition[];
  stopTime?: number;
  stopReason?: 'manual' | 'out-of-frame';
}

export interface TrackedPlayer {
  id: string;
  label: string;
  color: string;
  style: CircleStyle;
  visible: boolean;
  showTrail: boolean;
  trackWithCv?: boolean;
  attachedTrackId?: string;
  spotlight?: SpotlightProperties;
  ring?: RingProperties;
  chain?: ChainProperties;
  polygon?: PolygonProperties;
  /** Referenced 3D Foot Ring IDs connected by a Chain tool */
  linkedRingIds?: string[];
  /** Child tracked nodes/vertices for multi-player tools ('chain' and 'polygon') */
  nodes?: TrackedNode[];
  anchorTime: number;
  anchorPosition: CirclePosition;
  /** Optional trimmed In-point time (defaults to anchorTime when undefined) */
  inTime?: number;
  /** Time when tracking was stopped (manually or auto-stopped when player left camera frame) */
  stopTime?: number;
  stopReason?: 'manual' | 'out-of-frame';
  /** Time-sorted manual anchor & realignment keyframes */
  keyframes: CirclePosition[];
  currentPosition: CirclePosition;
  /** Time-sorted keyframe/tracked positions for scrubbing & motion trails */
  history: CirclePosition[];
}

export interface CvTrackerSettings {
  searchRadiusPx: number;
  adaptationRate: number;
  turfMasking: boolean;
  cameraCompensation: boolean;
  collisionAvoidance: boolean;
  confidenceThreshold: number;
  smoothing: number;
}

export interface ChromaKeySettings {
  showMask: boolean;
  keyColors: string[];
  hasCustomSamples: boolean;
  tolerance: number;
  softness: number;
}

export const DEFAULT_PITCH_GREEN = '#2A7836';

export const DEFAULT_CHROMA_KEY_SETTINGS: ChromaKeySettings = {
  showMask: false,
  keyColors: [DEFAULT_PITCH_GREEN],
  hasCustomSamples: false,
  tolerance: 48,
  softness: 14,
};

export const PLAYER_COLORS = [
  { name: 'Amber', hex: '#F59E0B' },
  { name: 'Cyan', hex: '#06B6D4' },
  { name: 'Emerald', hex: '#10B981' },
  { name: 'Rose', hex: '#F43F5E' },
  { name: 'Violet', hex: '#A855F7' },
] as const;

export const SPOTLIGHT_COLORS = [
  { name: 'Broadcast White', hex: '#FFFFFF' },
  ...PLAYER_COLORS,
] as const;

export const RING_COLORS = [
  { name: 'Broadcast Cyan', hex: '#00EAFF' },
  { name: 'Amber', hex: '#F59E0B' },
  { name: 'Emerald', hex: '#10B981' },
  { name: 'Rose', hex: '#F43F5E' },
  { name: 'Violet', hex: '#A855F7' },
  { name: 'Broadcast White', hex: '#FFFFFF' },
] as const;

export const POLYGON_COLORS = [
  { name: 'Crimson', hex: '#FF003C' },
  { name: 'Broadcast Cyan', hex: '#00EAFF' },
  { name: 'Amber', hex: '#F59E0B' },
  { name: 'Emerald', hex: '#10B981' },
  { name: 'Violet', hex: '#A855F7' },
  { name: 'Broadcast White', hex: '#FFFFFF' },
] as const;

export const DEFAULT_SPOTLIGHT_SETTINGS: SpotlightSettings = {
  beamSize: 80,
  intensity: 0.4,
  rotation: 0.9,
  color: '#FFFFFF',
  trackWithCv: true,
};

export const DEFAULT_RING_SETTINGS: RingSettings = {
  ringSize: 112,
  ringThickness: DEFAULT_RING_THICKNESS,
  tiltDeg: 58,
  spinSpeed: 2.35,
  color: '#00EAFF',
  trackWithCv: true,
};

export const DEFAULT_CHAIN_SETTINGS: ChainSettings = {
  ringSize: 112,
  ringThickness: DEFAULT_RING_THICKNESS,
  tiltDeg: 58,
  spinSpeed: 2.35,
  connectorWidth: 10,
  dashed: false,
  color: '#00EAFF',
  trackWithCv: true,
};

export const DEFAULT_POLYGON_SETTINGS: PolygonSettings = {
  borderColor: '#FF003C',
  borderThickness: 3,
  dashedBorder: false,
  fillColor: '#FF003C',
  fillOpacity: 0.2,
  markerSize: 5,
  trackWithCv: true,
};

export const DEFAULT_CV_SETTINGS: CvTrackerSettings = {
  searchRadiusPx: 42,
  adaptationRate: 0.14,
  turfMasking: true,
  cameraCompensation: true,
  collisionAvoidance: true,
  confidenceThreshold: 0.38,
  smoothing: 0.65,
};

export type ExportResolutionScale = 'native' | '1080p' | '720p';

export interface ExportConfig {
  startTime: number;
  endTime: number;
  fps: 30 | 60;
  resolutionScale: ExportResolutionScale;
}

export type ExportStatus =
  | 'idle'
  | 'preparing'
  | 'encoding'
  | 'finalizing'
  | 'complete'
  | 'error'
  | 'cancelled';

export interface ExportProgress {
  status: ExportStatus;
  frameIndex: number;
  totalFrames: number;
  elapsedMs: number;
  speedMultiplier: number;
  outputUrl?: string;
  outputFileName?: string;
  outputSizeBytes?: number;
  formatLabel?: 'MP4 (H.264)' | 'WebM';
  error?: string;
}

export interface DetectedPlayerBox {
  id: string;
  cx: number;
  cy: number;
  width: number;
  height: number;
  confidence: number;
  source: 'auto' | 'manual';
  time: number;
  isKeyframe?: boolean;
}

export interface DetectorShapeStats {
  positiveCount: number;
  negativeCount: number;
  isTrained: boolean;
}

export type DetectorSubTool = 'drawer' | 'eraser' | null;

export interface BackgroundPlayerTrackRecord {
  id: string;
  source: 'auto' | 'manual';
  firstTime: number;
  lastTime: number;
  positions: CirclePosition[];
}

export interface ImplementedTrackRecord extends BackgroundPlayerTrackRecord {
  label: string;
}

export type ImplementOverlayStyle = 'ring' | 'foot-ring' | 'spotlight';

export type CoverageKind = 'full' | 'partial' | 'untracked';

export interface TimeInterval {
  start: number;
  end: number;
}

export interface CoverageSegment {
  start: number;
  end: number;
  kind: CoverageKind;
  playerCount: number;
  autoCount: number;
  manualCount: number;
  toolCount: number;
}

export interface CoverageSummary {
  segments: CoverageSegment[];
  trackedSeconds: number;
  fullSeconds: number;
  partialSeconds: number;
  untrackedSeconds: number;
  coveragePct: number;
  currentKind: CoverageKind;
  currentSegment: CoverageSegment | null;
  nextGapTime: number | null;
  untrackedGapCount: number;
}
