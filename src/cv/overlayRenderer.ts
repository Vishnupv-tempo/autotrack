import {
  DEFAULT_RING_THICKNESS,
  MAX_RING_THICKNESS,
  MIN_RING_SIZE,
  MIN_RING_THICKNESS,
  type BackgroundPlayerTrackRecord,
  type ChainProperties,
  type CirclePosition,
  type PolygonProperties,
  type RingProperties,
  type TrackedNode,
  type TrackedPlayer,
  type TrackingStatus,
} from '../types/tracking';

export interface RenderRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SpotlightParticle {
  angle0: number;
  speed: number;
}

export type FootRingSpriteCache = Map<
  string,
  { spinDisk: HTMLCanvasElement; staticOverlay: HTMLCanvasElement }
>;

export interface DisplaySpringState {
  cx: number;
  cy: number;
  width: number;
  height: number;
  radius: number;
  vx: number;
  vy: number;
  lastTargetCx: number;
  lastTargetCy: number;
  lastTargetTime: number;
  lastUpdateMs: number;
  tvx: number;
  tvy: number;
}

export function getBoxPixels(
  pos: Pick<CirclePosition, 'cx' | 'cy' | 'width' | 'height' | 'radius'>,
  rect: RenderRect
) {
  const px = rect.x + pos.cx * rect.w;
  const py = rect.y + pos.cy * rect.h;
  const fallbackW = Math.max(24, pos.radius * 2 * rect.w);
  const boxW = Math.max(14, pos.width > 0 ? pos.width * rect.w : fallbackW);
  const boxH = Math.max(20, pos.height > 0 ? pos.height * rect.h : boxW * 1.9);
  const halfW = boxW * 0.5;
  const halfH = boxH * 0.5;
  const rPx = Math.max(12, pos.radius * rect.w);
  return { px, py, boxW, boxH, halfW, halfH, rPx };
}

export function createSpotlightParticles(): SpotlightParticle[] {
  const arr: SpotlightParticle[] = [];
  for (let i = 0; i < 30; i++) {
    arr.push({
      angle0: Math.random() * Math.PI * 2,
      speed: 0.02 + Math.random() * 0.02,
    });
  }
  return arr;
}

export function createDeterministicSpotlightParticles(seedKey: string): SpotlightParticle[] {
  let hash = 2166136261;
  for (let i = 0; i < seedKey.length; i++) {
    hash ^= seedKey.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const nextRand = () => {
    hash += 0x6d2b79f5;
    let t = hash;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const arr: SpotlightParticle[] = [];
  for (let i = 0; i < 30; i++) {
    arr.push({
      angle0: nextRand() * Math.PI * 2,
      speed: 0.02 + nextRand() * 0.02,
    });
  }
  return arr;
}

/**
 * Critically-damped 2nd-order spring stepper shared by live playback and offline export
 * so exported tool motion matches real-time stage playback smoothly without stepping jitter.
 */
export function stepDisplaySpring(
  curr: DisplaySpringState | undefined,
  target: CirclePosition,
  dt: number,
  nowMs: number,
  smoothing: number
): DisplaySpringState {
  if (
    !curr ||
    smoothing <= 0.01 ||
    Math.hypot(target.cx - curr.cx, target.cy - curr.cy) > 0.14
  ) {
    return {
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
    };
  }

  // Critically-damped follower without target extrapolation so 1-frame measurement
  // jitter is never amplified, while smoothed feed-forward velocity prevents pan lag.
  const omega = 12 + (1 - smoothing) * 32;
  const subDt = dt * 0.5;
  const goalX = target.cx;
  const goalY = target.cy;
  const ffVx = curr.tvx * 0.65;
  const ffVy = curr.tvy * 0.65;

  for (let s = 0; s < 2; s++) {
    const ax = omega * omega * (goalX - curr.cx) + 2 * omega * (ffVx - curr.vx);
    const ay = omega * omega * (goalY - curr.cy) + 2 * omega * (ffVy - curr.vy);
    curr.vx += ax * subDt;
    curr.vy += ay * subDt;
    curr.cx += curr.vx * subDt;
    curr.cy += curr.vy * subDt;
  }

  const kSize = 1 - Math.exp(-12 * dt);
  curr.width += (target.width - curr.width) * kSize;
  curr.height += (target.height - curr.height) * kSize;
  curr.radius += (target.radius - curr.radius) * kSize;

  return curr;
}

/**
 * Updates target velocity on an existing DisplaySpringState when a new target sample arrives.
 */
export function updateSpringTarget(
  prev: DisplaySpringState,
  target: CirclePosition,
  nowMs: number
): void {
  const dtVideo = target.time - prev.lastTargetTime;
  const dtWall = (nowMs - prev.lastUpdateMs) / 1000;
  const dt =
    dtVideo > 0.004 && dtVideo < 0.25
      ? dtVideo
      : Math.max(0.012, Math.min(0.15, dtWall));
  const rawVx = Math.max(-1.6, Math.min(1.6, (target.cx - prev.lastTargetCx) / dt));
  const rawVy = Math.max(-1.6, Math.min(1.6, (target.cy - prev.lastTargetCy) / dt));
  prev.tvx = prev.tvx * 0.72 + rawVx * 0.28;
  prev.tvy = prev.tvy * 0.72 + rawVy * 0.28;
  prev.lastTargetCx = target.cx;
  prev.lastTargetCy = target.cy;
  prev.lastTargetTime = target.time;
  prev.lastUpdateMs = nowMs;
}

/**
 * Zero-phase 5-point quadratic Savitzky-Golay smoother for recorded tool timelines.
 * Preserves curves, sprints, endpoints, and user-anchored keyframes with zero phase lag.
 */
export function zeroPhaseSmoothTimeline(timeline: CirclePosition[]): CirclePosition[] {
  const n = timeline.length;
  if (n <= 2) return timeline;

  const out: CirclePosition[] = new Array(n);
  out[0] = timeline[0];
  out[n - 1] = timeline[n - 1];

  const isContinuous = (a: CirclePosition, b: CirclePosition): boolean => {
    const dt = b.time - a.time;
    if (dt <= 0 || dt > 0.14) return false;
    const dist = Math.hypot(b.cx - a.cx, b.cy - a.cy);
    return dist <= Math.max(0.06, Math.max(a.width, b.width) * 1.8);
  };

  for (let i = 1; i < n - 1; i++) {
    const curr = timeline[i];
    if (curr.status === 'anchored') {
      out[i] = curr;
      continue;
    }

    const can3 = isContinuous(timeline[i - 1], curr) && isContinuous(curr, timeline[i + 1]);
    if (!can3) {
      out[i] = curr;
      continue;
    }

    const can5 =
      i >= 2 &&
      i <= n - 3 &&
      isContinuous(timeline[i - 2], timeline[i - 1]) &&
      isContinuous(timeline[i + 1], timeline[i + 2]);

    let sCx: number;
    let sCy: number;
    let sW: number;
    let sH: number;

    if (can5) {
      const pM2 = timeline[i - 2];
      const pM1 = timeline[i - 1];
      const pP1 = timeline[i + 1];
      const pP2 = timeline[i + 2];
      sCx = (-3 * pM2.cx + 12 * pM1.cx + 17 * curr.cx + 12 * pP1.cx - 3 * pP2.cx) / 35;
      sCy = (-3 * pM2.cy + 12 * pM1.cy + 17 * curr.cy + 12 * pP1.cy - 3 * pP2.cy) / 35;
      sW = (pM2.width + 2 * pM1.width + 3 * curr.width + 2 * pP1.width + pP2.width) / 9;
      sH = (pM2.height + 2 * pM1.height + 3 * curr.height + 2 * pP1.height + pP2.height) / 9;
    } else {
      const pM1 = timeline[i - 1];
      const pP1 = timeline[i + 1];
      sCx = 0.25 * pM1.cx + 0.5 * curr.cx + 0.25 * pP1.cx;
      sCy = 0.25 * pM1.cy + 0.5 * curr.cy + 0.25 * pP1.cy;
      sW = 0.25 * pM1.width + 0.5 * curr.width + 0.25 * pP1.width;
      sH = 0.25 * pM1.height + 0.5 * curr.height + 0.25 * pP1.height;
    }

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
      cx: Math.max(0.002, Math.min(0.998, sCx)),
      cy: Math.max(0.002, Math.min(0.998, sCy)),
      width: Math.max(0.004, Math.min(0.5, sW)),
      height: Math.max(0.008, Math.min(0.7, sH)),
      radius: Math.max(sW, sH) * 0.5,
    };
  }

  return out;
}

/**
 * Builds a clean, time-sorted array of recorded tracking samples for offline export.
 * Uses only already-tracked history, keyframes, and anchorPosition (never runs CV).
 */
export function buildSortedPlayerTimeline(player: TrackedPlayer): CirclePosition[] {
  const merged: CirclePosition[] = [];
  if (player.history.length > 0) {
    merged.push(...player.history);
  }
  if (player.keyframes.length > 0) {
    merged.push(...player.keyframes);
  }
  merged.push(player.anchorPosition);

  merged.sort((a, b) => a.time - b.time);

  const deduped: CirclePosition[] = [];
  for (const pt of merged) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(pt.time - prev.time) < 0.004) {
      // Prefer non-stopped or higher-confidence keyframe sample when timestamps coincide
      if (pt.confidence >= prev.confidence) {
        deduped[deduped.length - 1] = pt;
      }
    } else {
      deduped.push(pt);
    }
  }
  return zeroPhaseSmoothTimeline(deduped);
}

export function buildSortedNodeTimeline(node: TrackedNode): CirclePosition[] {
  const merged: CirclePosition[] = [];
  if (node.history.length > 0) {
    merged.push(...node.history);
  }
  if (node.keyframes.length > 0) {
    merged.push(...node.keyframes);
  }
  merged.push(node.anchorPosition);

  merged.sort((a, b) => a.time - b.time);

  const deduped: CirclePosition[] = [];
  for (const pt of merged) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(pt.time - prev.time) < 0.004) {
      if (pt.confidence >= prev.confidence) {
        deduped[deduped.length - 1] = pt;
      }
    } else {
      deduped.push(pt);
    }
  }
  return zeroPhaseSmoothTimeline(deduped);
}

export function sampleNodeTimelineAtTime(
  parentPlayer: TrackedPlayer,
  node: TrackedNode,
  sortedTimeline: CirclePosition[],
  time: number
): CirclePosition | null {
  if (!parentPlayer.visible || sortedTimeline.length === 0) return null;

  const startT = parentPlayer.inTime ?? parentPlayer.anchorTime;
  const effStop = parentPlayer.stopTime;
  if (time + 0.04 < startT) return null;
  if (effStop !== undefined && time > effStop + 0.04) return null;

  if (!node.trackWithCv || parentPlayer.trackWithCv === false || sortedTimeline.length === 1) {
    return { ...sortedTimeline[0], time };
  }

  const first = sortedTimeline[0];
  if (time <= first.time) {
    return { ...first, time };
  }

  const last = sortedTimeline[sortedTimeline.length - 1];
  if (time >= last.time) {
    return { ...last, time };
  }

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

  const p0 = sortedTimeline[lo];
  const p1 = sortedTimeline[hi];
  const span = p1.time - p0.time;
  if (span <= 1e-5) {
    return { ...p1, time };
  }
  if (span > 0.6 && p1.status !== 'anchored') {
    return { ...p0, time };
  }

  const u = Math.max(0, Math.min(1, (time - p0.time) / span));
  return {
    cx: p0.cx + (p1.cx - p0.cx) * u,
    cy: p0.cy + (p1.cy - p0.cy) * u,
    width: p0.width + (p1.width - p0.width) * u,
    height: p0.height + (p1.height - p0.height) * u,
    radius: p0.radius + (p1.radius - p0.radius) * u,
    confidence: p0.confidence + (p1.confidence - p0.confidence) * u,
    status: u < 0.5 ? p0.status : p1.status,
    time,
  };
}

/**
 * Checks whether a player has any visible active span overlapping `time`
 * and returns a smoothly interpolated target CirclePosition from already-recorded history.
 */
export function samplePlayerTimelineAtTime(
  player: TrackedPlayer,
  sortedTimeline: CirclePosition[],
  time: number
): CirclePosition | null {
  if (!player.visible || sortedTimeline.length === 0) return null;

  const startT = player.inTime ?? player.anchorTime;
  const effStop = player.stopTime;
  if (time + 0.04 < startT) return null;
  if (effStop !== undefined && time > effStop + 0.04) return null;

  // Static pinned tool or single sample
  if (player.trackWithCv === false || sortedTimeline.length === 1) {
    return { ...sortedTimeline[0], time };
  }

  const first = sortedTimeline[0];
  if (time <= first.time) {
    return { ...first, time };
  }

  const last = sortedTimeline[sortedTimeline.length - 1];
  if (time >= last.time) {
    return { ...last, time };
  }

  // Binary search for bracketing samples [lo, lo+1]
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

  const p0 = sortedTimeline[lo];
  const p1 = sortedTimeline[hi];
  const span = p1.time - p0.time;
  if (span <= 1e-5) {
    return { ...p1, time };
  }

  // If a large untracked gap exists (> 0.6s), hold p0 until near p1 rather than gliding across an untracked gap
  if (span > 0.6 && p1.status !== 'anchored') {
    return { ...p0, time };
  }

  const u = Math.max(0, Math.min(1, (time - p0.time) / span));
  return {
    cx: p0.cx + (p1.cx - p0.cx) * u,
    cy: p0.cy + (p1.cy - p0.cy) * u,
    width: p0.width + (p1.width - p0.width) * u,
    height: p0.height + (p1.height - p0.height) * u,
    radius: p0.radius + (p1.radius - p0.radius) * u,
    confidence: p0.confidence + (p1.confidence - p0.confidence) * u,
    status: u < 0.5 ? p0.status : p1.status,
    time,
  };
}

/**
 * Samples an implemented background player track at `time` via binary search & interpolation.
 * Returns null when the tracked player is not present near `time`.
 */
export function sampleImplementedTrackAtTime(
  track: Pick<BackgroundPlayerTrackRecord, 'firstTime' | 'lastTime' | 'positions'>,
  time: number
): CirclePosition | null {
  const pts = track.positions;
  if (pts.length === 0) return null;
  if (time + 0.12 < track.firstTime || time - 0.12 > track.lastTime) {
    return null;
  }
  if (pts.length === 1 || time <= pts[0].time) {
    return { ...pts[0], time };
  }
  const last = pts[pts.length - 1];
  if (time >= last.time) {
    return { ...last, time };
  }

  let lo = 0;
  let hi = pts.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].time <= time) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const p0 = pts[lo];
  const p1 = pts[hi];
  const span = p1.time - p0.time;
  if (span <= 1e-5) {
    return { ...p1, time };
  }
  if (span > 0.6) {
    return Math.abs(time - p0.time) <= Math.abs(p1.time - time)
      ? { ...p0, time }
      : { ...p1, time };
  }
  const u = Math.max(0, Math.min(1, (time - p0.time) / span));
  return {
    cx: p0.cx + (p1.cx - p0.cx) * u,
    cy: p0.cy + (p1.cy - p0.cy) * u,
    width: p0.width + (p1.width - p0.width) * u,
    height: p0.height + (p1.height - p0.height) * u,
    radius: p0.radius + (p1.radius - p0.radius) * u,
    confidence: p0.confidence + (p1.confidence - p0.confidence) * u,
    status: u < 0.5 ? p0.status : p1.status,
    time,
  };
}

export function drawMotionTrail(
  ctx: CanvasRenderingContext2D,
  rect: RenderRect,
  px: number,
  py: number,
  color: string,
  historyPoints: CirclePosition[],
  currTime: number,
  minTime = -Infinity
): void {
  if (historyPoints.length <= 1) return;
  const trailPoints = historyPoints.filter(
    (pt) => pt.time <= currTime + 0.03 && pt.time >= minTime - 0.03
  );
  if (trailPoints.length <= 1) return;

  const slice = trailPoints.slice(-45);
  const pts = slice.map((pt, idx) =>
    idx === slice.length - 1
      ? { x: px, y: py }
      : { x: rect.x + pt.cx * rect.w, y: rect.y + pt.cy * rect.h }
  );

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 2.5;
  let prevMidX = pts[0].x;
  let prevMidY = pts[0].y;
  for (let i = 1; i < pts.length; i++) {
    const alpha = (i / (pts.length - 1)) * 0.72;
    ctx.strokeStyle = hexToRgba(color, alpha);
    ctx.beginPath();
    ctx.moveTo(prevMidX, prevMidY);
    if (i < pts.length - 1) {
      const midX = (pts[i].x + pts[i + 1].x) * 0.5;
      const midY = (pts[i].y + pts[i + 1].y) * 0.5;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
      prevMidX = midX;
      prevMidY = midY;
    } else {
      ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

export function drawPlayerBoxShape(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  boxW: number,
  boxH: number,
  player: TrackedPlayer,
  isSelected: boolean,
  statusOverride?: TrackingStatus,
  confidenceOverride?: number
): void {
  const { color, style, currentPosition } = player;
  const status = statusOverride ?? currentPosition.status;
  const confidence = confidenceOverride ?? currentPosition.confidence;
  const halfW = boxW * 0.5;
  const halfH = boxH * 0.5;
  const left = px - halfW;
  const top = py - halfH;
  const isLostOrOccluded = status === 'occluded' || status === 'lost';

  ctx.fillStyle = hexToRgba(color, style === 'halo' ? 0.07 : 0.11);
  ctx.beginPath();
  ctx.roundRect(left, top, boxW, boxH, 4);
  ctx.fill();

  if (style === 'ring') {
    ctx.strokeStyle = 'rgba(11, 15, 20, 0.72)';
    ctx.lineWidth = isSelected ? 4.8 : 3.8;
    ctx.beginPath();
    ctx.roundRect(left, top, boxW, boxH, 4);
    ctx.stroke();

    ctx.strokeStyle = color;
    ctx.lineWidth = isSelected ? 2.8 : 2.1;
    if (isLostOrOccluded) {
      ctx.setLineDash([5, 4]);
    }
    ctx.beginPath();
    ctx.roundRect(left, top, boxW, boxH, 4);
    ctx.stroke();
    ctx.setLineDash([]);
  } else if (style === 'halo') {
    ctx.strokeStyle = hexToRgba(color, 0.45);
    ctx.lineWidth = 1.5;
    if (isLostOrOccluded) {
      ctx.setLineDash([4, 3]);
    }
    ctx.beginPath();
    ctx.roundRect(left, top, boxW, boxH, 4);
    ctx.stroke();
    ctx.setLineDash([]);

    const groundY = py + halfH * 0.88;
    const rx = Math.max(15, halfW * 1.18);
    const ry = Math.max(6, rx * 0.36);
    ctx.strokeStyle = 'rgba(11, 15, 20, 0.75)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.ellipse(px, groundY, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = color;
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.ellipse(px, groundY, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.strokeStyle = hexToRgba(color, 0.3);
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.rect(left, top, boxW, boxH);
    ctx.stroke();

    const bLenX = Math.max(5, Math.min(12, halfW * 0.55));
    const bLenY = Math.max(6, Math.min(14, halfH * 0.4));

    ctx.strokeStyle = 'rgba(11, 15, 20, 0.75)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(left, top + bLenY);
    ctx.lineTo(left, top);
    ctx.lineTo(left + bLenX, top);
    ctx.moveTo(left + boxW - bLenX, top);
    ctx.lineTo(left + boxW, top);
    ctx.lineTo(left + boxW, top + bLenY);
    ctx.moveTo(left + boxW, top + boxH - bLenY);
    ctx.lineTo(left + boxW, top + boxH);
    ctx.lineTo(left + boxW - bLenX, top + boxH);
    ctx.moveTo(left + bLenX, top + boxH);
    ctx.lineTo(left, top + boxH);
    ctx.lineTo(left, top + boxH - bLenY);
    ctx.stroke();

    ctx.strokeStyle = color;
    ctx.lineWidth = isSelected ? 2.6 : 2.1;
    if (isLostOrOccluded) {
      ctx.setLineDash([4, 3]);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    const barW = Math.max(4, (boxW - 6) * Math.max(0.1, confidence));
    ctx.fillStyle = hexToRgba(color, 0.9);
    ctx.fillRect(left + 3, top + 2.5, barW, 2);
  }
}

export function drawSpotlightShape(
  ctx: CanvasRenderingContext2D,
  rect: RenderRect,
  px: number,
  py: number,
  halfH: number,
  player: TrackedPlayer,
  isSelected: boolean,
  particles: SpotlightParticle[],
  nowMs: number,
  statusOverride?: TrackingStatus
): void {
  const sp = player.spotlight ?? { beamSize: 80, intensity: 0.4, rotation: 0.9 };
  const beamWidth = sp.beamSize;
  const groundY = Math.min(rect.y + rect.h - 4, py + halfH * 0.88);
  const status = statusOverride ?? player.currentPosition.status;
  const isDashed = status === 'occluded' || status === 'lost';

  drawSpotlightBeamAndRing(
    ctx,
    rect,
    px,
    groundY,
    beamWidth,
    sp.intensity,
    sp.rotation,
    player.color,
    false,
    isSelected,
    isDashed,
    particles,
    nowMs
  );
}

function drawSpotlightBeamAndRing(
  ctx: CanvasRenderingContext2D,
  rect: RenderRect,
  px: number,
  py: number,
  beamWidth: number,
  intensity: number,
  rotation: number,
  color: string,
  ghost: boolean,
  isSelected: boolean,
  isDashed: boolean,
  particles: SpotlightParticle[],
  nowMs: number
): void {
  const alpha = ghost ? 0.4 : 1.0;
  const topY = rect.y;
  const bottomY = py;
  const ringRadius = beamWidth / 2;

  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();

  const grad = ctx.createLinearGradient(px, topY, px, bottomY);
  grad.addColorStop(0, hexToRgba(color, 0));
  grad.addColorStop(0.5, hexToRgba(color, intensity * 0.25 * alpha));
  grad.addColorStop(1, hexToRgba(color, 0.05 * alpha));

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(px - ringRadius, topY);
  ctx.lineTo(px + ringRadius, topY);
  ctx.lineTo(px + ringRadius, bottomY);
  ctx.lineTo(px - ringRadius, bottomY);
  ctx.closePath();
  ctx.fill();

  ctx.save();
  ctx.translate(px, bottomY);
  ctx.scale(1, rotation);

  const ringGrad = ctx.createRadialGradient(0, 0, ringRadius * 0.3, 0, 0, ringRadius * 1.3);
  ringGrad.addColorStop(0, hexToRgba(color, 0.9 * alpha));
  ringGrad.addColorStop(0.6, hexToRgba(color, 0.3 * alpha));
  ringGrad.addColorStop(1, hexToRgba(color, 0));

  ctx.fillStyle = ringGrad;
  ctx.beginPath();
  ctx.arc(0, 0, ringRadius * 1.2, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = hexToRgba(
    color,
    Math.min(1, (isSelected ? 0.95 : 0.8) * Math.max(0.35, intensity)) * alpha
  );
  ctx.lineWidth = isSelected ? 2.5 : 2;
  if (isDashed) {
    ctx.setLineDash([5, 4]);
  }
  ctx.beginPath();
  ctx.arc(0, 0, ringRadius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  if (!ghost && particles.length > 0) {
    const frameUnits = nowMs / 16.6667;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const angle = p.angle0 + p.speed * frameUnits;
      const ppx = Math.cos(angle) * ringRadius;
      const ppy = Math.sin(angle) * ringRadius * 0.15;
      const flicker = 0.5 + 0.5 * Math.sin(nowMs * 0.005 + i);

      ctx.fillStyle = hexToRgba(color, 0.6 * flicker * alpha);
      ctx.beginPath();
      ctx.arc(ppx, ppy, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
  ctx.restore();
}

export function resolveRingHoleRatio(ringThickness?: number): number {
  const thicknessPct = Math.max(
    MIN_RING_THICKNESS,
    Math.min(MAX_RING_THICKNESS, ringThickness ?? DEFAULT_RING_THICKNESS)
  );
  return 1 - thicknessPct / 100;
}

function getCachedFootRingSprites(
  cache: FootRingSpriteCache | undefined,
  baseColor: string,
  ringDiam: number,
  holeRatio: number,
  isSelected: boolean,
  isDashed: boolean
): { spinDisk: HTMLCanvasElement; staticOverlay: HTMLCanvasElement } | null {
  if (typeof document === 'undefined') return null;

  const pad = 16;
  const ss = ringDiam < 40 ? 3 : 2;
  const logicalSize = Math.ceil(ringDiam + pad * 2);
  const pixelSize = logicalSize * ss;
  const half = logicalSize / 2;
  const R = ringDiam / 2;
  const innerR = R * holeRatio;
  const bandW = Math.max(1.2, R - innerR);
  const holePctKey = Math.round(holeRatio * 1000);

  const spinKey = `spin|${baseColor}|${ringDiam}|${holePctKey}`;
  const staticKey = `static|${ringDiam}|${holePctKey}|${isSelected ? 1 : 0}|${isDashed ? 1 : 0}`;
  const fullKey = `${spinKey}|${staticKey}`;

  const hit = cache?.get(fullKey);
  if (hit) return hit;

  let spinDisk: HTMLCanvasElement | undefined;
  if (cache) {
    for (const [k, v] of cache.entries()) {
      if (k.startsWith(spinKey)) {
        spinDisk = v.spinDisk;
        break;
      }
    }
  }

  if (!spinDisk) {
    spinDisk = document.createElement('canvas');
    spinDisk.width = pixelSize;
    spinDisk.height = pixelSize;
    const sctx = spinDisk.getContext('2d');
    if (sctx) {
      const deepColor = shiftHexColor(baseColor, -24);
      const darkColor = shiftHexColor(baseColor, -48);
      const lightColor = shiftHexColor(baseColor, 30);
      const hotColor = shiftHexColor(baseColor, 58);

      sctx.scale(ss, ss);
      sctx.translate(half, half);

      sctx.beginPath();
      sctx.arc(0, 0, R, 0, Math.PI * 2);
      sctx.clip();

      if (typeof sctx.createConicGradient === 'function') {
        const conic = sctx.createConicGradient((-22 * Math.PI) / 180, 0, 0);
        conic.addColorStop(0 / 360, hotColor);
        conic.addColorStop(22 / 360, lightColor);
        conic.addColorStop(72 / 360, baseColor);
        conic.addColorStop(128 / 360, deepColor);
        conic.addColorStop(184 / 360, darkColor);
        conic.addColorStop(248 / 360, baseColor);
        conic.addColorStop(304 / 360, lightColor);
        conic.addColorStop(1, hotColor);
        sctx.fillStyle = conic;
      } else {
        const fallbackGrad = sctx.createLinearGradient(-R, -R, R, R);
        fallbackGrad.addColorStop(0, hotColor);
        fallbackGrad.addColorStop(0.5, baseColor);
        fallbackGrad.addColorStop(1, darkColor);
        sctx.fillStyle = fallbackGrad;
      }
      sctx.fillRect(-R - 2, -R - 2, R * 2 + 4, R * 2 + 4);

      const spotX = -R * 0.32;
      const spotY = -R * 0.56;
      const spotGrad = sctx.createRadialGradient(spotX, spotY, 0, spotX, spotY, R * 0.62);
      spotGrad.addColorStop(0, 'rgba(255, 255, 255, 0.92)');
      spotGrad.addColorStop(0.28, 'rgba(255, 255, 255, 0.24)');
      spotGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
      sctx.fillStyle = spotGrad;
      sctx.fillRect(-R, -R, R * 2, R * 2);

      if (typeof sctx.createConicGradient === 'function') {
        const sweep = sctx.createConicGradient((18 * Math.PI) / 180, 0, 0);
        sweep.addColorStop(0, 'rgba(255, 255, 255, 0)');
        sweep.addColorStop(34 / 360, 'rgba(255, 255, 255, 0)');
        sweep.addColorStop(48 / 360, 'rgba(255, 255, 255, 0.76)');
        sweep.addColorStop(74 / 360, 'rgba(255, 255, 255, 0)');
        sweep.addColorStop(180 / 360, 'rgba(255, 255, 255, 0)');
        sweep.addColorStop(216 / 360, 'rgba(255, 255, 255, 0.28)');
        sweep.addColorStop(250 / 360, 'rgba(255, 255, 255, 0)');
        sweep.addColorStop(1, 'rgba(255, 255, 255, 0)');
        sctx.fillStyle = sweep;
        sctx.fillRect(-R - 2, -R - 2, R * 2 + 4, R * 2 + 4);
      }

      const bevelInset = Math.min(bandW * 0.45, Math.max(0.8, R * 0.14));
      const bevelW = Math.min(bandW * 0.48, Math.max(0.75, R * 0.12));
      if (R - bevelInset > innerR * 0.85) {
        sctx.lineWidth = bevelW;
        sctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
        sctx.beginPath();
        sctx.arc(0, 0, R - bevelInset, Math.PI * 0.75, Math.PI * 1.85);
        sctx.stroke();
        sctx.strokeStyle = 'rgba(0, 0, 0, 0.24)';
        sctx.beginPath();
        sctx.arc(0, 0, R - bevelInset, -Math.PI * 0.15, Math.PI * 0.75);
        sctx.stroke();
      }
    }
  }

  let staticOverlay: HTMLCanvasElement | undefined;
  if (cache) {
    for (const [k, v] of cache.entries()) {
      if (k.endsWith(staticKey)) {
        staticOverlay = v.staticOverlay;
        break;
      }
    }
  }

  if (!staticOverlay) {
    staticOverlay = document.createElement('canvas');
    staticOverlay.width = pixelSize;
    staticOverlay.height = pixelSize;
    const stx = staticOverlay.getContext('2d');
    if (stx) {
      stx.scale(ss, ss);
      stx.translate(half, half);

      stx.save();
      stx.beginPath();
      stx.arc(0, 0, R, 0, Math.PI * 2);
      stx.arc(0, 0, innerR, 0, Math.PI * 2, true);
      stx.clip('evenodd');

      const bodyShade = stx.createLinearGradient(0, -R, 0, R);
      bodyShade.addColorStop(0, 'rgba(255, 255, 255, 0.28)');
      bodyShade.addColorStop(0.35, 'rgba(255, 255, 255, 0)');
      bodyShade.addColorStop(0.7, 'rgba(0, 0, 0, 0)');
      bodyShade.addColorStop(1, 'rgba(0, 0, 0, 0.34)');
      stx.fillStyle = bodyShade;
      stx.fillRect(-R, -R, R * 2, R * 2);

      const glassGrad = stx.createLinearGradient(-R * 0.7, -R * 0.7, R * 0.7, R * 0.7);
      glassGrad.addColorStop(0, 'rgba(255, 255, 255, 0.42)');
      glassGrad.addColorStop(0.28, 'rgba(255, 255, 255, 0)');
      glassGrad.addColorStop(0.62, 'rgba(0, 0, 0, 0)');
      glassGrad.addColorStop(1, 'rgba(0, 0, 0, 0.22)');
      stx.fillStyle = glassGrad;
      stx.fillRect(-R, -R, R * 2, R * 2);
      stx.restore();

      const innerShadowW = Math.min(4, Math.max(0.8, bandW * 0.24));
      stx.strokeStyle = 'rgba(0, 0, 0, 0.26)';
      stx.lineWidth = innerShadowW;
      stx.beginPath();
      stx.arc(0, 0, innerR + innerShadowW * 0.5, 0, Math.PI * 2);
      stx.stroke();

      const innerRimW = Math.min(1.6, Math.max(0.6, bandW * 0.1));
      stx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
      stx.lineWidth = innerRimW;
      stx.beginPath();
      stx.arc(0, 0, innerR + innerRimW * 0.35, 0, Math.PI * 2);
      stx.stroke();

      const outerEdgeW = Math.min(isSelected ? 2.2 : 1.4, Math.max(0.75, bandW * 0.16));
      if (isDashed) {
        stx.setLineDash([Math.max(3, R * 0.15), Math.max(2, R * 0.1)]);
      }
      stx.strokeStyle = isSelected ? 'rgba(255, 255, 255, 0.85)' : 'rgba(255, 255, 255, 0.55)';
      stx.lineWidth = outerEdgeW;
      stx.beginPath();
      stx.arc(0, 0, R - outerEdgeW * 0.5, 0, Math.PI * 2);
      stx.stroke();
      stx.setLineDash([]);
    }
  }

  const entry = { spinDisk, staticOverlay };
  if (cache) {
    if (cache.size >= 24) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey) cache.delete(oldestKey);
    }
    cache.set(fullKey, entry);
  }
  return entry;
}

export function drawFootRingAt(
  ctx: CanvasRenderingContext2D,
  rect: RenderRect,
  px: number,
  groundY: number,
  color: string,
  rp: RingProperties,
  isSelected: boolean,
  nowMs: number,
  entranceStartMs: number | undefined,
  scratchCanvas: HTMLCanvasElement | null,
  spriteCache?: FootRingSpriteCache,
  isDashed = false,
  spinPhaseOffset = 0
): void {
  const ringDiam = Math.max(MIN_RING_SIZE, rp.ringSize);
  const ringRadius = ringDiam / 2;
  const holeRatio = resolveRingHoleRatio(rp.ringThickness);
  const tiltDeg = Math.max(0, Math.min(75, rp.tiltDeg));
  const scaleY = Math.max(0.22, Math.cos((tiltDeg * Math.PI) / 180));
  const spinSpeed = Math.max(0.8, rp.spinSpeed || 2.35);

  let entranceScale = 1;
  let entranceAlpha = 1;
  if (entranceStartMs !== undefined && nowMs > 0) {
    const elapsed = Math.max(0, nowMs - entranceStartMs);
    if (elapsed < 420) {
      const t = elapsed / 420;
      if (t < 0.58) {
        const u = t / 0.58;
        const easeOut = 1 - Math.pow(1 - u, 3);
        entranceScale = 0.52 + (1.08 - 0.52) * easeOut;
        entranceAlpha = Math.min(1, u * 1.4);
      } else {
        const u = (t - 0.58) / 0.42;
        const easeSettle = 1 - Math.pow(1 - u, 2);
        entranceScale = 1.08 + (1.0 - 1.08) * easeSettle;
        entranceAlpha = 1;
      }
    }
  }

  const baseColor = color || '#00EAFF';
  const darkColor = shiftHexColor(baseColor, -48);

  const effR = ringRadius * entranceScale;
  const effRy = effR * scaleY;

  ctx.save();
  ctx.globalAlpha *= entranceAlpha;

  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();

  ctx.save();
  ctx.translate(px, groundY + effRy * 0.22);
  ctx.scale(1, Math.max(0.24, scaleY * 0.72));
  const shadowGrad = ctx.createRadialGradient(0, 0, effR * 0.25, 0, 0, effR * 1.08);
  shadowGrad.addColorStop(0, 'rgba(0, 0, 0, 0.52)');
  shadowGrad.addColorStop(0.55, 'rgba(0, 0, 0, 0.24)');
  shadowGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = shadowGrad;
  ctx.beginPath();
  ctx.arc(0, 0, effR * 1.08, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.translate(px, groundY);
  ctx.scale(1, scaleY);
  const glowGrad = ctx.createRadialGradient(0, 0, effR * holeRatio, 0, 0, effR * 1.38);
  glowGrad.addColorStop(0, hexToRgba(baseColor, 0));
  glowGrad.addColorStop(0.55, hexToRgba(baseColor, isSelected ? 0.36 : 0.26));
  glowGrad.addColorStop(1, hexToRgba(baseColor, 0));
  ctx.fillStyle = glowGrad;
  ctx.beginPath();
  ctx.arc(0, 0, effR * 1.38, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const bandW = Math.max(1.2, effR * (1 - holeRatio));
  const extrudeY = Math.min(
    Math.max(0.85, bandW * 0.55),
    Math.max(0.9, (1 - scaleY) * Math.min(6.5, effR * 0.16))
  );
  ctx.save();
  ctx.translate(px, groundY + extrudeY);
  ctx.scale(1, scaleY);
  ctx.fillStyle = hexToRgba(darkColor, 0.78);
  ctx.beginPath();
  ctx.arc(0, 0, effR, 0, Math.PI * 2);
  ctx.arc(0, 0, effR * holeRatio, 0, Math.PI * 2, true);
  ctx.fill('evenodd');
  ctx.restore();

  const pad = 16;
  const ss = ringDiam < 40 ? 3 : 2;
  const logicalSize = Math.ceil(ringDiam + pad * 2);
  const pixelSize = logicalSize * ss;
  const offCanvas =
    scratchCanvas ?? (typeof document !== 'undefined' ? document.createElement('canvas') : null);
  const sprites = getCachedFootRingSprites(
    spriteCache,
    baseColor,
    ringDiam,
    holeRatio,
    isSelected,
    isDashed
  );

  if (offCanvas && sprites) {
    if (offCanvas.width !== pixelSize || offCanvas.height !== pixelSize) {
      offCanvas.width = pixelSize;
      offCanvas.height = pixelSize;
    }
    const octx = offCanvas.getContext('2d');
    if (octx) {
      octx.save();
      octx.clearRect(0, 0, pixelSize, pixelSize);
      octx.scale(ss, ss);
      const half = logicalSize / 2;
      const innerR = ringRadius * holeRatio;
      const spinAngle =
        nowMs > 0 ? ((nowMs / 1000) / spinSpeed) * Math.PI * 2 + spinPhaseOffset : spinPhaseOffset;

      octx.translate(half, half);

      octx.save();
      octx.rotate(spinAngle);
      octx.drawImage(sprites.spinDisk, -half, -half, logicalSize, logicalSize);
      octx.restore();

      octx.globalCompositeOperation = 'destination-out';
      octx.fillStyle = '#000';
      octx.beginPath();
      octx.arc(0, 0, innerR, 0, Math.PI * 2);
      octx.fill();
      octx.globalCompositeOperation = 'source-over';

      octx.drawImage(sprites.staticOverlay, -half, -half, logicalSize, logicalSize);

      octx.restore();

      ctx.save();
      ctx.translate(px, groundY);
      ctx.scale(entranceScale, scaleY * entranceScale);
      ctx.drawImage(offCanvas, -logicalSize / 2, -logicalSize / 2, logicalSize, logicalSize);
      ctx.restore();
    }
  }

  ctx.restore();
}

export function drawFootRingShape(
  ctx: CanvasRenderingContext2D,
  rect: RenderRect,
  px: number,
  py: number,
  halfH: number,
  player: TrackedPlayer,
  isSelected: boolean,
  nowMs: number,
  entranceStartMs: number | undefined,
  scratchCanvas: HTMLCanvasElement | null,
  spriteCache?: FootRingSpriteCache,
  statusOverride?: TrackingStatus
): void {
  const rp = player.ring ?? {
    ringSize: 112,
    ringThickness: DEFAULT_RING_THICKNESS,
    tiltDeg: 58,
    spinSpeed: 2.35,
  };
  const groundY = Math.min(rect.y + rect.h - 4, py + halfH * 0.88);
  const status = statusOverride ?? player.currentPosition.status;
  const isDashed = status === 'occluded' || status === 'lost';
  drawFootRingAt(
    ctx,
    rect,
    px,
    groundY,
    player.color,
    rp,
    isSelected,
    nowMs,
    entranceStartMs,
    scratchCanvas,
    spriteCache,
    isDashed
  );
}

export interface ChainRenderNode {
  x: number;
  y: number;
  status?: TrackingStatus;
}

/**
 * Draws a Chain of 3D Foot Rings linked by gradient connectors from outer edge to outer edge,
 * matching the ring design we already have while projecting connectors cleanly onto the tilted ground plane.
 */
export function drawChainShape(
  ctx: CanvasRenderingContext2D,
  rect: RenderRect,
  nodes: ChainRenderNode[],
  color: string,
  chainProps: ChainProperties,
  isSelected: boolean,
  nowMs: number,
  entranceStartMs: number | undefined,
  scratchCanvas: HTMLCanvasElement | null,
  spriteCache?: FootRingSpriteCache,
  isPreview = false
): void {
  if (nodes.length === 0) return;

  const baseColor = color || '#00EAFF';
  const cA = baseColor;
  const cB = shiftHexColor(baseColor, -30);
  const cC = shiftHexColor(baseColor, -10);
  const ringDiam = Math.max(MIN_RING_SIZE, chainProps.ringSize || 112);
  const ringRadius = ringDiam / 2;
  const tiltDeg = Math.max(0, Math.min(75, chainProps.tiltDeg ?? 58));
  const scaleY = Math.max(0.22, Math.cos((tiltDeg * Math.PI) / 180));
  const connThickness = Math.max(2, Math.min(24, chainProps.connectorWidth || 10)) * Math.max(0.55, scaleY * 0.9);

  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();

  if (isPreview) {
    ctx.globalAlpha *= 0.85;
  }

  // 1. Draw connectors between consecutive rings' outer tilted ellipse edges
  for (let i = 1; i < nodes.length; i++) {
    const prev = nodes[i - 1];
    const curr = nodes[i];
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 4) continue;

    // Exact outer edge intersection along the tilted ground-plane ellipse
    const u = Math.atan2(dy / scaleY, dx);
    const edgeOffsetX = ringRadius * Math.cos(u);
    const edgeOffsetY = ringRadius * scaleY * Math.sin(u);

    const startX = prev.x + edgeOffsetX;
    const startY = prev.y + edgeOffsetY;
    const endX = curr.x - edgeOffsetX;
    const endY = curr.y - edgeOffsetY;

    // Skip if rings overlap past each other's outer edges
    const segDx = endX - startX;
    const segDy = endY - startY;
    if (segDx * dx + segDy * dy <= 4) continue;

    const segLen = Math.hypot(segDx, segDy);
    const angleRad = Math.atan2(segDy, segDx);

    ctx.save();
    ctx.translate(startX, startY);
    ctx.rotate(angleRad);

    // Subtle ground drop shadow
    ctx.save();
    ctx.translate(0, Math.max(2, (1 - scaleY) * 4));
    ctx.fillStyle = 'rgba(0, 0, 0, 0.34)';
    ctx.beginPath();
    ctx.roundRect(0, -connThickness * 0.5, segLen, connThickness, connThickness * 0.5);
    ctx.fill();
    ctx.restore();

    // Ambient connector glow
    ctx.save();
    ctx.shadowColor = hexToRgba(baseColor, 0.38);
    ctx.shadowBlur = 10;
    const linGrad = ctx.createLinearGradient(0, 0, segLen, 0);
    linGrad.addColorStop(0, cA);
    linGrad.addColorStop(0.4, cB);
    linGrad.addColorStop(0.7, cC);
    linGrad.addColorStop(1, cA);
    ctx.fillStyle = linGrad;
    ctx.beginPath();
    ctx.roundRect(0, -connThickness * 0.5, segLen, connThickness, connThickness * 0.5);
    ctx.fill();
    ctx.restore();

    // Top specular glass highlight & crisp border matching 3D rings
    const bevelGrad = ctx.createLinearGradient(0, -connThickness * 0.5, 0, connThickness * 0.5);
    bevelGrad.addColorStop(0, 'rgba(255, 255, 255, 0.32)');
    bevelGrad.addColorStop(0.45, 'rgba(255, 255, 255, 0.04)');
    bevelGrad.addColorStop(1, 'rgba(0, 0, 0, 0.24)');
    ctx.fillStyle = bevelGrad;
    ctx.beginPath();
    ctx.roundRect(0, -connThickness * 0.5, segLen, connThickness, connThickness * 0.5);
    ctx.fill();

    ctx.strokeStyle = isSelected ? 'rgba(255, 255, 255, 0.72)' : 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = isSelected ? 1.3 : 0.9;
    ctx.beginPath();
    ctx.roundRect(0, -connThickness * 0.5, segLen, connThickness, connThickness * 0.5);
    ctx.stroke();

    ctx.restore();
  }

  // 2. Draw each 3D Foot Ring with slight per-node spin variation
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isDashed = node.status === 'occluded' || node.status === 'lost';
    const speedVar = 0.85 + ((i * 37) % 10) * 0.05;
    const nodeRingProps: RingProperties = {
      ringSize: chainProps.ringSize,
      ringThickness: chainProps.ringThickness ?? DEFAULT_RING_THICKNESS,
      tiltDeg: chainProps.tiltDeg,
      spinSpeed: Math.max(0.8, (chainProps.spinSpeed || 2.35) / speedVar),
    };
    drawFootRingAt(
      ctx,
      rect,
      node.x,
      node.y,
      baseColor,
      nodeRingProps,
      isSelected,
      nowMs,
      entranceStartMs,
      scratchCanvas,
      spriteCache,
      isDashed,
      i * 0.85
    );
  }

  ctx.restore();
}

export interface ChainConnectorEndpoint {
  x: number;
  y: number;
  ringSize: number;
  tiltDeg: number;
  /** When false (e.g., cursor point during preview), terminate right at (x, y) without ring radius offset */
  isRing?: boolean;
}

/**
 * Draws ONLY the 3D-perspective connector beams between already-added 3D Foot Rings,
 * terminating cleanly at each linked ring's outer tilted-ellipse edge.
 */
export function drawChainConnectorsShape(
  ctx: CanvasRenderingContext2D,
  rect: RenderRect,
  endpoints: ChainConnectorEndpoint[],
  color: string,
  connectorWidth: number,
  dashed: boolean,
  isSelected: boolean,
  isPreview = false
): void {
  if (endpoints.length < 2) return;

  const baseColor = color || '#00EAFF';
  const cA = baseColor;
  const cB = shiftHexColor(baseColor, -30);
  const cC = shiftHexColor(baseColor, -10);

  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();

  if (isPreview) {
    ctx.globalAlpha *= 0.85;
  }

  for (let i = 1; i < endpoints.length; i++) {
    const prev = endpoints[i - 1];
    const curr = endpoints[i];
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 4) continue;

    const prevTilt = Math.max(0, Math.min(75, prev.tiltDeg ?? 58));
    const prevScaleY = Math.max(0.22, Math.cos((prevTilt * Math.PI) / 180));
    const prevR = prev.isRing === false ? 0 : Math.max(MIN_RING_SIZE, prev.ringSize || 112) / 2;

    const currTilt = Math.max(0, Math.min(75, curr.tiltDeg ?? 58));
    const currScaleY = Math.max(0.22, Math.cos((currTilt * Math.PI) / 180));
    const currR = curr.isRing === false ? 0 : Math.max(MIN_RING_SIZE, curr.ringSize || 112) / 2;

    const uPrev = Math.atan2(dy / prevScaleY, dx);
    const startX = prev.x + prevR * Math.cos(uPrev);
    const startY = prev.y + prevR * prevScaleY * Math.sin(uPrev);

    const uCurr = Math.atan2(dy / currScaleY, dx);
    const endX = curr.x - currR * Math.cos(uCurr);
    const endY = curr.y - currR * currScaleY * Math.sin(uCurr);

    const segDx = endX - startX;
    const segDy = endY - startY;
    if (segDx * dx + segDy * dy <= 4) continue;

    const segLen = Math.hypot(segDx, segDy);
    const angleRad = Math.atan2(segDy, segDx);
    const avgScaleY = (prevScaleY + currScaleY) * 0.5;
    const connThickness =
      Math.max(2, Math.min(26, connectorWidth || 10)) * Math.max(0.55, avgScaleY * 0.9);

    ctx.save();
    ctx.translate(startX, startY);
    ctx.rotate(angleRad);

    if (dashed || isPreview) {
      const dashLen = Math.max(6, connThickness * 1.35);
      const gapLen = Math.max(4, connThickness * 0.85);

      // Ground drop shadow for dashed beam
      ctx.save();
      ctx.translate(0, Math.max(2, (1 - avgScaleY) * 4));
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.34)';
      ctx.lineWidth = connThickness;
      ctx.lineCap = 'round';
      ctx.setLineDash([dashLen, gapLen]);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(segLen, 0);
      ctx.stroke();
      ctx.restore();

      // Glowing dashed gradient connector
      ctx.save();
      ctx.shadowColor = hexToRgba(baseColor, 0.38);
      ctx.shadowBlur = 10;
      const linGrad = ctx.createLinearGradient(0, 0, segLen, 0);
      linGrad.addColorStop(0, cA);
      linGrad.addColorStop(0.5, cC);
      linGrad.addColorStop(1, cA);
      ctx.strokeStyle = linGrad;
      ctx.lineWidth = connThickness;
      ctx.lineCap = 'round';
      ctx.setLineDash([dashLen, gapLen]);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(segLen, 0);
      ctx.stroke();
      ctx.restore();

      if (isSelected) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)';
        ctx.lineWidth = Math.max(1.2, connThickness * 0.24);
        ctx.lineCap = 'round';
        ctx.setLineDash([dashLen, gapLen]);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(segLen, 0);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    } else {
      // Subtle ground drop shadow
      ctx.save();
      ctx.translate(0, Math.max(2, (1 - avgScaleY) * 4));
      ctx.fillStyle = 'rgba(0, 0, 0, 0.34)';
      ctx.beginPath();
      ctx.roundRect(0, -connThickness * 0.5, segLen, connThickness, connThickness * 0.5);
      ctx.fill();
      ctx.restore();

      // Ambient connector glow + gradient body
      ctx.save();
      ctx.shadowColor = hexToRgba(baseColor, 0.38);
      ctx.shadowBlur = 10;
      const linGrad = ctx.createLinearGradient(0, 0, segLen, 0);
      linGrad.addColorStop(0, cA);
      linGrad.addColorStop(0.4, cB);
      linGrad.addColorStop(0.7, cC);
      linGrad.addColorStop(1, cA);
      ctx.fillStyle = linGrad;
      ctx.beginPath();
      ctx.roundRect(0, -connThickness * 0.5, segLen, connThickness, connThickness * 0.5);
      ctx.fill();
      ctx.restore();

      // Top specular highlight & crisp border matching 3D rings
      const bevelGrad = ctx.createLinearGradient(0, -connThickness * 0.5, 0, connThickness * 0.5);
      bevelGrad.addColorStop(0, 'rgba(255, 255, 255, 0.32)');
      bevelGrad.addColorStop(0.45, 'rgba(255, 255, 255, 0.04)');
      bevelGrad.addColorStop(1, 'rgba(0, 0, 0, 0.24)');
      ctx.fillStyle = bevelGrad;
      ctx.beginPath();
      ctx.roundRect(0, -connThickness * 0.5, segLen, connThickness, connThickness * 0.5);
      ctx.fill();

      ctx.strokeStyle = isSelected ? 'rgba(255, 255, 255, 0.85)' : 'rgba(255, 255, 255, 0.28)';
      ctx.lineWidth = isSelected ? 1.5 : 0.9;
      ctx.beginPath();
      ctx.roundRect(0, -connThickness * 0.5, segLen, connThickness, connThickness * 0.5);
      ctx.stroke();
    }

    ctx.restore();
  }

  ctx.restore();
}

export interface PolygonRenderVertex {
  x: number;
  y: number;
  status?: TrackingStatus;
}

/**
 * Draws a tactical Polygon (fill, solid/dashed border, and vertex markers with white glow border).
 * When `isPreview` is true, renders in-progress lines + markers (plus closing line preview if >= 3 vertices).
 */
export function drawPolygonShape(
  ctx: CanvasRenderingContext2D,
  rect: RenderRect,
  vertices: PolygonRenderVertex[],
  props: PolygonProperties,
  isSelected: boolean,
  isPreview = false
): void {
  if (vertices.length === 0) return;

  const borderColor = props.borderColor || '#FF003C';
  const fillColor = props.fillColor || borderColor;
  const thickness = Math.max(1, Math.min(12, props.borderThickness || 3));
  const markerR = Math.max(3, Math.min(14, props.markerSize || 5));
  const fillOpacity = Math.max(0, Math.min(1, props.fillOpacity ?? 0.2));

  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();

  // Fill when >= 3 vertices
  if (vertices.length >= 3) {
    ctx.beginPath();
    ctx.moveTo(vertices[0].x, vertices[0].y);
    for (let i = 1; i < vertices.length; i++) {
      ctx.lineTo(vertices[i].x, vertices[i].y);
    }
    ctx.closePath();

    ctx.save();
    ctx.globalAlpha *= isPreview ? fillOpacity * 0.65 : fillOpacity;
    ctx.fillStyle = fillColor;
    ctx.fill();
    ctx.restore();

    // Border (dark contrast backing + colored stroke)
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (props.dashedBorder) {
      ctx.setLineDash([7, 5]);
    }
    ctx.globalAlpha *= isPreview ? 0.72 : 1;
    ctx.strokeStyle = 'rgba(11, 15, 20, 0.55)';
    ctx.lineWidth = thickness + 2;
    ctx.stroke();

    ctx.strokeStyle = borderColor;
    ctx.lineWidth = isSelected ? thickness + 0.8 : thickness;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  } else if (vertices.length === 2) {
    // Open line segment preview for 2 vertices
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(vertices[0].x, vertices[0].y);
    ctx.lineTo(vertices[1].x, vertices[1].y);
    ctx.lineCap = 'round';
    if (props.dashedBorder) {
      ctx.setLineDash([7, 5]);
    }
    ctx.globalAlpha *= 0.8;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = thickness;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // Vertex marker dots with crisp white glow border
  for (let i = 0; i < vertices.length; i++) {
    const v = vertices[i];
    const isLostOrOccluded = v.status === 'occluded' || v.status === 'lost';
    ctx.save();
    ctx.globalAlpha *= isPreview ? 0.85 : 1;

    // Subtle ground shadow under vertex dot
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.beginPath();
    ctx.arc(v.x, v.y + 1.5, markerR + 1, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = borderColor;
    ctx.beginPath();
    ctx.arc(v.x, v.y, markerR, 0, Math.PI * 2);
    ctx.fill();

    if (isLostOrOccluded) {
      ctx.setLineDash([3, 2]);
    }
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = isSelected ? 1.8 : 1.25;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  ctx.restore();
}

export function shiftHexColor(hex: string, amt: number): string {
  let clean = hex.replace('#', '');
  if (clean.length === 3) {
    clean = clean
      .split('')
      .map((c) => c + c)
      .join('');
  }
  const rRaw = parseInt(clean.slice(0, 2), 16);
  const gRaw = parseInt(clean.slice(2, 4), 16);
  const bRaw = parseInt(clean.slice(4, 6), 16);
  const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v + (amt / 100) * 255)));
  const r = clampByte(Number.isNaN(rRaw) ? 0 : rRaw);
  const g = clampByte(Number.isNaN(gRaw) ? 234 : gRaw);
  const b = clampByte(Number.isNaN(bRaw) ? 255 : bRaw);
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

export function hexToRgba(hex: string, alpha: number): string {
  let clean = hex.replace('#', '');
  if (clean.length === 3) {
    clean = clean
      .split('')
      .map((c) => c + c)
      .join('');
  }
  const rRaw = parseInt(clean.slice(0, 2), 16);
  const gRaw = parseInt(clean.slice(2, 4), 16);
  const bRaw = parseInt(clean.slice(4, 6), 16);
  const r = Number.isNaN(rRaw) ? 255 : rRaw;
  const g = Number.isNaN(gRaw) ? 255 : gRaw;
  const b = Number.isNaN(bRaw) ? 255 : bRaw;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
