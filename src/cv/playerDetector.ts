import {
  buildChromaTargets,
  computePixelFgAlphaFast,
  type ChromaTargets,
} from './chromaKey';
import type {
  ChromaKeySettings,
  DetectedPlayerBox,
  DetectorShapeStats,
} from '../types/tracking';

const MAX_DETECT_WIDTH = 760;

interface ShapeSample {
  features: Float32Array; // 11 normalized human-shape features
  boxWNorm: number;
  boxHNorm: number;
  meanFgAlpha: number;
  highAlphaFrac: number;
  nonTurfFrac: number;
  popFrac: number;
  fgRgb: [number, number, number];
  bgRgb: [number, number, number];
}

interface ErasedSpot {
  cx: number;
  cy: number;
  halfW: number;
  halfH: number;
  radius: number;
  time: number;
}

interface CandidateRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface AnalysisGrid {
  w: number;
  h: number;
  data: Uint8ClampedArray;
  fg: Uint8Array; // 1 = non-pitch foreground (chalk suppressed), 0 = turf / ignored
  fgAlpha: Float32Array;
  inPitchField: Uint8Array;
}

interface DetectorScratchPool {
  total: number;
  fgAlpha: Float32Array;
  rawFg: Uint8Array;
  rawTurf: Uint8Array;
  chalkOut: Uint8Array;
  chromatic: Uint8Array;
  whiteAchromatic: Uint8Array;
  bridged: Uint8Array;
  fullPitch: Uint8Array;
  ccVisited: Uint8Array;
  ccQueue: Int32Array;
  gridTotal: number;
  gTurf: Uint8Array;
  gMorphTmp: Uint8Array;
  gOpened: Uint8Array;
  gDilated: Uint8Array;
  gClosed: Uint8Array;
  gVisited: Uint8Array;
  gKept: Uint8Array;
  gQueue: Int32Array;
  gOutside: Uint8Array;
}

/**
 * Minimal-infrastructure client-side Player Detector.
 * Uses the user's sampled Chroma Key turf model to isolate the playable green pitch,
 * segments foreground subjects inside the pitch, splits close/touching players via
 * head-contour & upper-body valley + kit-color discontinuity analysis, tight-shrinks
 * boxes to pixel bounds, and scores each candidate with a trainable human-shape model.
 */
export class PlayerDetector {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private positiveSamples: ShapeSample[] = [];
  private negativeSamples: ShapeSample[] = [];
  private erasedSpots: ErasedSpot[] = [];
  private scratch: DetectorScratchPool | null = null;

  constructor() {
    this.canvas = document.createElement('canvas');
    const context = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      throw new Error('Could not initialize 2D context for PlayerDetector');
    }
    this.ctx = context;
  }

  private getScratch(w: number, h: number): DetectorScratchPool {
    const total = w * h;
    const gw = Math.max(16, Math.ceil(w / 2));
    const gh = Math.max(12, Math.ceil(h / 2));
    const gridTotal = gw * gh;

    if (!this.scratch || this.scratch.total !== total || this.scratch.gridTotal !== gridTotal) {
      this.scratch = {
        total,
        fgAlpha: new Float32Array(total),
        rawFg: new Uint8Array(total),
        rawTurf: new Uint8Array(total),
        chalkOut: new Uint8Array(total),
        chromatic: new Uint8Array(total),
        whiteAchromatic: new Uint8Array(total),
        bridged: new Uint8Array(total),
        fullPitch: new Uint8Array(total),
        ccVisited: new Uint8Array(total),
        ccQueue: new Int32Array(total),
        gridTotal,
        gTurf: new Uint8Array(gridTotal),
        gMorphTmp: new Uint8Array(gridTotal),
        gOpened: new Uint8Array(gridTotal),
        gDilated: new Uint8Array(gridTotal),
        gClosed: new Uint8Array(gridTotal),
        gVisited: new Uint8Array(gridTotal),
        gKept: new Uint8Array(gridTotal),
        gQueue: new Int32Array(gridTotal),
        gOutside: new Uint8Array(gridTotal),
      };
    }
    return this.scratch;
  }

  getStats(): DetectorShapeStats {
    return {
      positiveCount: this.positiveSamples.length,
      negativeCount: this.negativeSamples.length,
      isTrained: this.positiveSamples.length + this.negativeSamples.length > 0,
    };
  }

  resetTraining(): void {
    this.positiveSamples = [];
    this.negativeSamples = [];
    this.erasedSpots = [];
  }

  markErasedSpot(
    box: { cx: number; cy: number; width: number; height: number },
    time: number
  ): void {
    const radius = Math.max(0.032, Math.hypot(box.width, box.height) * 0.95);
    this.erasedSpots = [
      ...this.erasedSpots.filter((s) => Math.abs(time - s.time) <= 2.5).slice(-31),
      {
        cx: box.cx,
        cy: box.cy,
        halfW: box.width * 0.5,
        halfH: box.height * 0.5,
        radius,
        time,
      },
    ];
  }

  /**
   * Captures current video frame and runs pitch-interior human detection.
   */
  detectPlayers(
    video: HTMLVideoElement,
    chromaKey: ChromaKeySettings,
    time: number
  ): DetectedPlayerBox[] {
    const grid = this.buildAnalysisGrid(video, chromaKey);
    if (!grid) return [];
    return this.detectPlayersOnGrid(grid, time);
  }

  /**
   * Runs pitch-interior human detection directly on an already-captured RGBA buffer
   * (zero duplicate canvas drawImage / getImageData GPU-to-CPU readback).
   */
  detectPlayersFromRgba(
    rgba: Uint8ClampedArray,
    w: number,
    h: number,
    chromaKey: ChromaKeySettings,
    time: number
  ): DetectedPlayerBox[] {
    if (w < 16 || h < 16 || rgba.length < w * h * 4) return [];
    const grid = this.buildAnalysisGridFromRgba(rgba, w, h, chromaKey);
    return this.detectPlayersOnGrid(grid, time);
  }

  private detectPlayersOnGrid(grid: AnalysisGrid, time: number): DetectedPlayerBox[] {
    const { w, h, fg, inPitchField } = grid;
    const pool = this.getScratch(w, h);

    // 1. Vertical-only morphological closing (bridge 1-2px detached head/shorts/socks gaps
    //    WITHOUT bridging close side-by-side players horizontally)
    const bridged = bridgeVerticalGapsOnly(fg, inPitchField, w, h, pool.bridged);

    // 2. 4-connected components strictly inside playable pitch
    const rawComponents = extractConnectedComponents(
      bridged,
      inPitchField,
      w,
      h,
      pool.ccVisited,
      pool.ccQueue
    );

    // Estimate expected player scale from learned samples or pitch frame height
    const learnedHeightNorm = this.getLearnedMedianHeight();
    const learnedWidthNorm = this.getLearnedMedianWidth();
    const expH = learnedHeightNorm
      ? clamp(learnedHeightNorm * h, 10, h * 0.36)
      : clamp(h * 0.072, 14, h * 0.24);
    const expW = learnedWidthNorm
      ? clamp(learnedWidthNorm * w, 5, w * 0.14)
      : clamp(expH * 0.48, 7, w * 0.1);

    // 3. Split close / touching players & shrink-wrap every sub-box tightly
    const splitCandidates: CandidateRect[] = [];
    for (const comp of rawComponents) {
      const compW = comp.x1 - comp.x0 + 1;
      const compH = comp.y1 - comp.y0 + 1;
      // Discard massive stadium/background artifacts right away
      if (compW > w * 0.42 && compH > h * 0.42) continue;
      if (compW < 3 || compH < 7) continue;

      const subs = splitClosePlayersRecursive(comp, bridged, grid.data, w, h, expW, expH, 0);
      for (const sub of subs) {
        const tight = shrinkWrapTight(sub, bridged, grid.fgAlpha, w);
        if (tight) {
          splitCandidates.push(tight);
        }
      }
    }

    // 4. Score candidates using human shape prior + online positive/negative training
    const minHeightPx = Math.max(9, Math.round(h * 0.025));
    const maxHeightPx = Math.round(h * 0.44);
    const minWidthPx = Math.max(4, Math.round(w * 0.006));
    const maxWidthPx = Math.round(w * 0.16);

    const scored: Array<{
      rect: CandidateRect;
      confidence: number;
    }> = [];

    for (const rect of splitCandidates) {
      const bw = rect.x1 - rect.x0 + 1;
      const bh = rect.y1 - rect.y0 + 1;
      if (bh < minHeightPx || bh > maxHeightPx) continue;
      if (bw < minWidthPx || bw > maxWidthPx) continue;

      const aspect = bh / bw;
      // Reject wide banners/scorebugs (aspect < 0.78) and ultra-thin vertical poles (aspect > 5.0)
      if (aspect < 0.78 || aspect > 5.0) continue;

      // Reject small round balls (tiny compact square-ish blobs)
      if (aspect < 1.2 && bh < Math.max(13, h * 0.032)) continue;

      const sample = extractShapeSample(rect, grid);
      if (!sample) continue;

      const detCx = (rect.x0 + rect.x1 + 1) / (2 * w);
      const detCy = (rect.y0 + rect.y1 + 1) / (2 * h);
      const detHalfW = (bw / w) * 0.5;
      const detHalfH = (bh / h) * 0.5;
      const nearErasedSpot = this.erasedSpots.some((spot) => {
        if (Math.abs(time - spot.time) > 0.75) return false;
        const dx = Math.abs(detCx - spot.cx);
        const dy = Math.abs(detCy - spot.cy);
        return (
          Math.hypot(dx, dy) <= spot.radius ||
          (dx <= spot.halfW + detHalfW + 0.018 && dy <= spot.halfH + detHalfH + 0.018)
        );
      });
      if (nearErasedSpot) continue;

      const conf = this.scoreHumanShape(sample);
      const threshold = this.negativeSamples.length > 0 ? 0.51 : 0.49;
      if (conf >= threshold) {
        scored.push({ rect, confidence: conf });
      }
    }

    // 5. Gentle NMS: only suppress heavy duplicate overlaps (IoU > 0.52) so close players stay separate
    scored.sort((a, b) => b.confidence - a.confidence);
    const kept: Array<{ rect: CandidateRect; confidence: number }> = [];
    for (const item of scored) {
      let overlapsExisting = false;
      for (const existing of kept) {
        if (computeIoU(item.rect, existing.rect) > 0.52) {
          overlapsExisting = true;
          break;
        }
      }
      if (!overlapsExisting) {
        kept.push(item);
      }
    }

    // Sort left-to-right for predictable visual ordering
    kept.sort((a, b) => a.rect.x0 - b.rect.x0);

    const stamp = Date.now();
    return kept.map((item, index) => {
      const { x0, y0, x1, y1 } = item.rect;
      const normW = Math.max(0.008, (x1 - x0 + 1) / w);
      const normH = Math.max(0.015, (y1 - y0 + 1) / h);
      const cx = clamp((x0 + x1 + 1) / (2 * w), 0.005, 0.995);
      const cy = clamp((y0 + y1 + 1) / (2 * h), 0.005, 0.995);
      return {
        id: `det_${stamp}_${index}_${Math.random().toString(36).slice(2, 6)}`,
        cx,
        cy,
        width: normW,
        height: normH,
        confidence: Number(item.confidence.toFixed(3)),
        source: 'auto',
        time,
      };
    });
  }

  /**
   * Trains the detector with a positive human example drawn by the user via Drawer.
   * Also tight-shrinks the drawn box around pitch foreground pixels when possible.
   */
  trainPositive(
    video: HTMLVideoElement,
    box: { cx: number; cy: number; width: number; height: number },
    chromaKey: ChromaKeySettings
  ): { tightened: { cx: number; cy: number; width: number; height: number }; stats: DetectorShapeStats } {
    const grid = this.buildAnalysisGrid(video, chromaKey);
    if (!grid) {
      return { tightened: box, stats: this.getStats() };
    }

    const { w, h, fg, fgAlpha } = grid;
    const rawRect = normBoxToGridRect(box, w, h);
    const tight = shrinkWrapTight(rawRect, fg, fgAlpha, w) ?? rawRect;

    const sample = extractShapeSample(tight, grid);
    if (sample) {
      this.positiveSamples = [...this.positiveSamples.slice(-47), sample];
    }
    this.erasedSpots = this.erasedSpots.filter(
      (s) => Math.hypot(s.cx - box.cx, s.cy - box.cy) > Math.max(s.radius, 0.03)
    );

    const tightW = Math.max(0.008, (tight.x1 - tight.x0 + 1) / w);
    const tightH = Math.max(0.015, (tight.y1 - tight.y0 + 1) / h);
    const tightCx = clamp((tight.x0 + tight.x1 + 1) / (2 * w), 0.005, 0.995);
    const tightCy = clamp((tight.y0 + tight.y1 + 1) / (2 * h), 0.005, 0.995);

    // Return tightened box only if it wasn't collapsed weirdly (preserves user intent while keeping tight)
    const keepTight =
      tightW >= box.width * 0.35 &&
      tightH >= box.height * 0.35;

    return {
      tightened: keepTight
        ? { cx: tightCx, cy: tightCy, width: tightW, height: tightH }
        : box,
      stats: this.getStats(),
    };
  }

  /**
   * Trains the detector with a negative example erased by the user via Eraser
   * (e.g. pitch glare, grass patch, chalk mark, ad-board fragment falsely marked as a player).
   */
  trainNegative(
    video: HTMLVideoElement,
    box: { cx: number; cy: number; width: number; height: number },
    chromaKey: ChromaKeySettings,
    time?: number
  ): DetectorShapeStats {
    this.markErasedSpot(box, time ?? video.currentTime ?? 0);
    const grid = this.buildAnalysisGrid(video, chromaKey);
    if (!grid) return this.getStats();

    const rawRect = normBoxToGridRect(box, grid.w, grid.h);
    const tight = shrinkWrapTight(rawRect, grid.fg, grid.fgAlpha, grid.w);
    const rawArea = (rawRect.x1 - rawRect.x0 + 1) * (rawRect.y1 - rawRect.y0 + 1);
    const tightArea = tight ? (tight.x1 - tight.x0 + 1) * (tight.y1 - tight.y0 + 1) : 0;
    const sampleRect = tight && tightArea >= rawArea * 0.28 ? tight : rawRect;

    const sample = extractShapeSample(sampleRect, grid);
    if (sample) {
      this.negativeSamples = [...this.negativeSamples.slice(-63), sample];
    }
    return this.getStats();
  }

  /**
   * Locates and tight-shrinks a single human player around a normalized click point (normX, normY)
   * inside the chroma-keyed green pitch, also adding a positive shape sample.
   */
  findPlayerAtPoint(
    video: HTMLVideoElement,
    chromaKey: ChromaKeySettings,
    normX: number,
    normY: number,
    time: number
  ): { box: DetectedPlayerBox; stats: DetectorShapeStats } | null {
    const grid = this.buildAnalysisGrid(video, chromaKey);
    if (!grid) return null;

    const { w, h, fg, fgAlpha, inPitchField, data } = grid;
    const gx = clamp(Math.round(normX * (w - 1)), 0, w - 1);
    const gy = clamp(Math.round(normY * (h - 1)), 0, h - 1);

    const pool = this.getScratch(w, h);
    const bridged = bridgeVerticalGapsOnly(fg, inPitchField, w, h, pool.bridged);

    const learnedHeightNorm = this.getLearnedMedianHeight();
    const learnedWidthNorm = this.getLearnedMedianWidth();
    const expH = learnedHeightNorm
      ? clamp(learnedHeightNorm * h, 10, h * 0.36)
      : clamp(h * 0.072, 14, h * 0.24);
    const expW = learnedWidthNorm
      ? clamp(learnedWidthNorm * w, 5, w * 0.14)
      : clamp(expH * 0.48, 7, w * 0.1);

    const rawComponents = extractConnectedComponents(
      bridged,
      inPitchField,
      w,
      h,
      pool.ccVisited,
      pool.ccQueue
    );
    const candidates: CandidateRect[] = [];

    for (const comp of rawComponents) {
      const compW = comp.x1 - comp.x0 + 1;
      const compH = comp.y1 - comp.y0 + 1;
      if (compW > w * 0.42 && compH > h * 0.42) continue;
      if (compW < 3 || compH < 6) continue;

      // Only inspect components within reasonable distance of click to keep it snappy
      const pad = Math.max(18, Math.round(expH * 0.45));
      if (
        gx < comp.x0 - pad ||
        gx > comp.x1 + pad ||
        gy < comp.y0 - pad ||
        gy > comp.y1 + pad
      ) {
        continue;
      }

      const subs = splitClosePlayersRecursive(comp, bridged, data, w, h, expW, expH, 0);
      for (const sub of subs) {
        const tight = shrinkWrapTight(sub, bridged, fgAlpha, w);
        if (tight) candidates.push(tight);
      }
    }

    // Also probe local foreground pixels directly around the click in case player was fragmented (< 16 px)
    let bestRect: CandidateRect | null = null;
    let bestRank = Infinity;
    let bestConf = 0.55;

    for (const rect of candidates) {
      const bw = rect.x1 - rect.x0 + 1;
      const bh = rect.y1 - rect.y0 + 1;
      if (bh < 7 || bw < 3 || bh > h * 0.48 || bw > w * 0.2) continue;
      const aspect = bh / bw;
      if (aspect < 0.62 || aspect > 5.4) continue;

      const sample = extractShapeSample(rect, grid);
      if (!sample) continue;
      const conf = this.scoreHumanShape(sample);
      if (conf < 0.32) continue;

      const inside =
        gx >= rect.x0 - 4 && gx <= rect.x1 + 4 && gy >= rect.y0 - 4 && gy <= rect.y1 + 4;
      const dx = gx < rect.x0 ? rect.x0 - gx : gx > rect.x1 ? gx - rect.x1 : 0;
      const dy = gy < rect.y0 ? rect.y0 - gy : gy > rect.y1 ? gy - rect.y1 : 0;
      const edgeDist = Math.hypot(dx, dy);
      if (edgeDist > 18) continue;

      const centerDist = Math.hypot(gx - (rect.x0 + rect.x1) * 0.5, gy - (rect.y0 + rect.y1) * 0.5);
      const rank = (inside ? 0 : edgeDist * 3 + 20) + centerDist * 0.35 - conf * 12;
      if (rank < bestRank) {
        bestRank = rank;
        bestRect = rect;
        bestConf = conf;
      }
    }

    // Fallback: local foreground seed search inside a tight pitch window around click
    if (!bestRect) {
      const searchR = Math.max(10, Math.round(expW * 0.75));
      let seedIdx = -1;
      let minSeedDist = Infinity;
      for (let dy = -searchR; dy <= searchR; dy++) {
        const yy = gy + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -searchR; dx <= searchR; dx++) {
          const xx = gx + dx;
          if (xx < 0 || xx >= w) continue;
          const idx = yy * w + xx;
          if (bridged[idx] && inPitchField[idx]) {
            const d = dx * dx + dy * dy;
            if (d < minSeedDist) {
              minSeedDist = d;
              seedIdx = idx;
            }
          }
        }
      }

      if (seedIdx !== -1) {
        const localWin = Math.max(24, Math.round(expH * 1.4));
        const wx0 = Math.max(0, gx - localWin);
        const wx1 = Math.min(w - 1, gx + localWin);
        const wy0 = Math.max(0, gy - localWin);
        const wy1 = Math.min(h - 1, gy + localWin);
        const comp = floodFillLocalComponent(seedIdx, bridged, inPitchField, w, wx0, wy0, wx1, wy1);
        if (comp) {
          const subs = splitClosePlayersRecursive(comp, bridged, data, w, h, expW, expH, 0);
          for (const sub of subs) {
            const tight = shrinkWrapTight(sub, bridged, fgAlpha, w) ?? sub;
            const bw = tight.x1 - tight.x0 + 1;
            const bh = tight.y1 - tight.y0 + 1;
            if (bh < 6 || bw < 3) continue;
            const centerDist = Math.hypot(
              gx - (tight.x0 + tight.x1) * 0.5,
              gy - (tight.y0 + tight.y1) * 0.5
            );
            const sample = extractShapeSample(tight, grid);
            const conf = sample ? this.scoreHumanShape(sample) : 0.45;
            if (centerDist < bestRank) {
              bestRank = centerDist;
              bestRect = tight;
              bestConf = Math.max(0.45, conf);
            }
          }
        }
      }
    }

    if (!bestRect) return null;

    const sample = extractShapeSample(bestRect, grid);
    if (sample) {
      this.positiveSamples = [...this.positiveSamples.slice(-47), sample];
    }

    const normW = Math.max(0.008, (bestRect.x1 - bestRect.x0 + 1) / w);
    const normH = Math.max(0.015, (bestRect.y1 - bestRect.y0 + 1) / h);
    const cx = clamp((bestRect.x0 + bestRect.x1 + 1) / (2 * w), 0.005, 0.995);
    const cy = clamp((bestRect.y0 + bestRect.y1 + 1) / (2 * h), 0.005, 0.995);

    return {
      box: {
        id: `det_find_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        cx,
        cy,
        width: normW,
        height: normH,
        confidence: Number(Math.max(0.5, bestConf).toFixed(3)),
        source: 'manual',
        time,
      },
      stats: this.getStats(),
    };
  }

  private getLearnedMedianHeight(): number | null {
    if (this.positiveSamples.length === 0) return null;
    const sorted = this.positiveSamples.map((s) => s.boxHNorm).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  private getLearnedMedianWidth(): number | null {
    if (this.positiveSamples.length === 0) return null;
    const sorted = this.positiveSamples.map((s) => s.boxWNorm).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  private scoreHumanShape(sample: ShapeSample): number {
    const f = sample.features;
    // Feature vector layout:
    // 0: aspectRatioNorm (aspect / 2.2, clamped)
    // 1: normW * 10
    // 2: normH * 6
    // 3: fillRatio
    // 4: headOcc (top 0..22% centered)
    // 5: torsoOcc (22..58%)
    // 6: legOcc (58..100%)
    // 7: symmetry (0..1)
    // 8: verticalEdgeScore (0..1)
    // 9: pitchCollar (0..1)
    // 10: turfContrast (0..1)

    const aspect = f[0] * 2.2;
    const normH = f[2] / 6;
    const fill = f[3];
    const headOcc = f[4];
    const torsoOcc = f[5];
    const legOcc = f[6];
    const symmetry = f[7];
    const vertEdge = f[8];
    const pitchCollar = f[9];
    const turfContrast = f[10];

    // 1. Human proportion prior: upright silhouette (ideal aspect ~1.35..2.8)
    let aspectScore = 0;
    if (aspect >= 1.2 && aspect <= 3.0) {
      aspectScore = 1.0;
    } else if (aspect >= 0.85 && aspect < 1.2) {
      aspectScore = 0.55 + ((aspect - 0.85) / 0.35) * 0.45;
    } else if (aspect > 3.0 && aspect <= 4.4) {
      aspectScore = Math.max(0.25, 1.0 - ((aspect - 3.0) / 1.4) * 0.75);
    }

    // 2. Silhouette fill ratio prior: human bodies occupy ~32%-76% of tight box
    let fillScore = 0;
    if (fill >= 0.28 && fill <= 0.78) {
      fillScore = 1.0;
    } else if (fill >= 0.18 && fill < 0.28) {
      fillScore = 0.45 + ((fill - 0.18) / 0.1) * 0.55;
    } else if (fill > 0.78 && fill <= 0.9) {
      fillScore = 1.0 - ((fill - 0.78) / 0.12) * 0.65;
    } else {
      fillScore = 0.15;
    }

    // 3. 3-zone anatomy check (head, torso, legs present; torso >= head * 0.55)
    const hasHead = headOcc >= 0.14 ? 1 : headOcc / 0.14;
    const hasTorso = torsoOcc >= 0.32 ? 1 : torsoOcc / 0.32;
    const hasLegs = legOcc >= 0.16 ? 1 : legOcc / 0.16;
    const torsoDominance = torsoOcc >= headOcc * 0.55 ? 1 : 0.45;
    const anatomyScore =
      hasHead * 0.26 + hasTorso * 0.34 + hasLegs * 0.22 + torsoDominance * 0.18;

    // 4. Pitch isolation & turf/grass/shadow/glare rejection
    const collarScore = pitchCollar >= 0.45 ? 1 : pitchCollar / 0.45;
    if (pitchCollar < 0.24) {
      return 0.14; // Embedded in crowd / sideline banner / glass border, not isolated inside pitch
    }
    if (pitchCollar < 0.36 && turfContrast < 0.32) {
      return 0.18;
    }

    // Reject weak chroma-key fringe speckles (grass texture / pitch glare leaking past tolerance)
    if (sample.meanFgAlpha < 0.55 && sample.highAlphaFrac < 0.18) {
      return 0.15;
    }

    // Reject grass stripes, worn turf, and cast grass shadows that match local turf chromaticity
    if (turfContrast < 0.17 && sample.nonTurfFrac < 0.24) {
      return 0.17;
    }
    if (sample.nonTurfFrac < 0.12 && sample.highAlphaFrac < 0.65) {
      return 0.17;
    }
    if (sample.nonTurfFrac < 0.08 && sample.popFrac < 0.32 && turfContrast < 0.36) {
      return 0.19;
    }

    // 5. Scale sanity prior (or learned scale prior)
    let scaleScore = 1.0;
    if (this.positiveSamples.length > 0) {
      const medH = this.getLearnedMedianHeight() ?? normH;
      const ratio = normH / Math.max(0.01, medH);
      scaleScore = ratio >= 0.45 && ratio <= 2.1 ? 1.0 : Math.max(0.25, 1 - Math.abs(Math.log2(ratio)) * 0.55);
    }

    const appearancePop = clamp(
      turfContrast * 0.45 + sample.nonTurfFrac * 0.35 + sample.popFrac * 0.2,
      0,
      1
    );

    let score =
      aspectScore * 0.22 +
      fillScore * 0.14 +
      anatomyScore * 0.23 +
      symmetry * 0.07 +
      vertEdge * 0.06 +
      collarScore * 0.12 +
      appearancePop * 0.16;

    score *= 0.8 + 0.2 * scaleScore;

    // Online Positive Training boost (RBF similarity to user-drawn human shapes)
    if (this.positiveSamples.length > 0) {
      let maxPosSim = 0;
      for (const pos of this.positiveSamples) {
        const distSq = featureDistSq(f, pos.features);
        const sim = Math.exp(-distSq / 0.42);
        if (sim > maxPosSim) maxPosSim = sim;
      }
      score = score * 0.68 + maxPosSim * 0.32;
    }

    // Online Negative Training suppression (shape + color similarity to user-erased false positives)
    if (this.negativeSamples.length > 0) {
      let maxNegCombined = 0;
      for (const neg of this.negativeSamples) {
        const distSq = featureDistSq(f, neg.features);
        const shapeSim = Math.exp(-distSq / 0.28);
        const colorDist = Math.hypot(
          sample.fgRgb[0] - neg.fgRgb[0],
          sample.fgRgb[1] - neg.fgRgb[1],
          sample.fgRgb[2] - neg.fgRgb[2]
        );
        const colorSim = Math.exp(-(colorDist * colorDist) / (52 * 52));
        const combined = shapeSim * (0.48 + 0.52 * colorSim);
        if (combined > maxNegCombined) maxNegCombined = combined;
      }
      if (maxNegCombined > 0.62) {
        score -= (maxNegCombined - 0.44) * 1.15;
      } else if (maxNegCombined > 0.48) {
        score -= (maxNegCombined - 0.48) * 0.45;
      }
    }

    return clamp(score, 0, 1);
  }

  private buildAnalysisGrid(
    video: HTMLVideoElement,
    chromaKey: ChromaKeySettings
  ): AnalysisGrid | null {
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      return null;
    }
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = Math.min(1, MAX_DETECT_WIDTH / vw);
    const w = Math.max(64, Math.round(vw * scale));
    const h = Math.max(48, Math.round(vh * scale));

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }

    this.ctx.drawImage(video, 0, 0, w, h);
    const imgData = this.ctx.getImageData(0, 0, w, h);
    return this.buildAnalysisGridFromRgba(imgData.data, w, h, chromaKey);
  }

  private buildAnalysisGridFromRgba(
    data: Uint8ClampedArray,
    w: number,
    h: number,
    chromaKey: ChromaKeySettings
  ): AnalysisGrid {
    const total = w * h;
    const pool = this.getScratch(w, h);
    const targets: ChromaTargets = buildChromaTargets(chromaKey);
    const fgAlpha = pool.fgAlpha;
    const rawFg = pool.rawFg;
    const rawTurf = pool.rawTurf;

    for (let i = 0, idx = 0; i < total; i++, idx += 4) {
      const alpha = computePixelFgAlphaFast(data[idx], data[idx + 1], data[idx + 2], targets);
      fgAlpha[i] = alpha;
      rawFg[i] = alpha >= 0.44 ? 1 : 0;
      rawTurf[i] = alpha < 0.48 ? 1 : 0;
    }

    // Isolate the playable green pitch field (excludes crowd stands, ad-boards, sky)
    const inPitchField = computePitchFieldMask(rawTurf, w, h, pool);

    // Suppress thin white chalk pitch lines inside the pitch while preserving white kits
    const fg = suppressPitchChalkLines(rawFg, inPitchField, data, w, h, pool);

    return { w, h, data, fg, fgAlpha, inPitchField };
  }
}

/**
 * Computes playable pitch field mask on a 2x downsampled grid via horizontal + vertical
 * morphological closing (fills players & pitch lines), keeps large green components, and
 * fills enclosed interior holes so players inside the pitch are always included.
 */
function computePitchFieldMask(
  rawTurf: Uint8Array,
  w: number,
  h: number,
  pool: DetectorScratchPool
): Uint8Array {
  const gw = Math.max(16, Math.ceil(w / 2));
  const gh = Math.max(12, Math.ceil(h / 2));
  const gTurf = pool.gTurf;

  for (let gy = 0; gy < gh; gy++) {
    const sy = Math.min(h - 1, gy * 2);
    const syNext = Math.min(h - 1, sy + 1);
    const row0 = sy * w;
    const row1 = syNext * w;
    const gRow = gy * gw;
    for (let gx = 0; gx < gw; gx++) {
      const sx = Math.min(w - 1, gx * 2);
      const sxNext = Math.min(w - 1, sx + 1);
      const count = rawTurf[row0 + sx] + rawTurf[row0 + sxNext] + rawTurf[row1 + sx];
      gTurf[gRow + gx] = count >= 2 ? 1 : 0;
    }
  }

  // Slight opening (erode 1, dilate 1) to disconnect narrow single-pixel green glints in stands
  const opened = morphOpen2x2(gTurf, gw, gh, pool);

  // Separable morphological closing to bridge players, shadows, and chalk lines across pitch
  const rx = Math.max(5, Math.round(gw * 0.032));
  const ry = Math.max(4, Math.round(gh * 0.045));
  const dilated = dilateRect(opened, gw, gh, rx, ry, pool.gMorphTmp, pool.gDilated);
  const closed = erodeRect(dilated, gw, gh, rx, ry, pool.gMorphTmp, pool.gClosed);

  // Keep only large connected pitch regions (>= 8% of frame)
  const totalGrid = gw * gh;
  const visited = pool.gVisited;
  const kept = pool.gKept;
  const queue = pool.gQueue;
  visited.fill(0);
  kept.fill(0);

  for (let i = 0; i < totalGrid; i++) {
    if (closed[i] === 0 || visited[i]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = i;
    visited[i] = 1;
    while (head < tail) {
      const curr = queue[head++];
      const cx = curr % gw;
      const cy = (curr - cx) / gw;
      if (cx > 0 && closed[curr - 1] && !visited[curr - 1]) {
        visited[curr - 1] = 1;
        queue[tail++] = curr - 1;
      }
      if (cx + 1 < gw && closed[curr + 1] && !visited[curr + 1]) {
        visited[curr + 1] = 1;
        queue[tail++] = curr + 1;
      }
      if (cy > 0 && closed[curr - gw] && !visited[curr - gw]) {
        visited[curr - gw] = 1;
        queue[tail++] = curr - gw;
      }
      if (cy + 1 < gh && closed[curr + gw] && !visited[curr + gw]) {
        visited[curr + gw] = 1;
        queue[tail++] = curr + gw;
      }
    }
    if (tail >= totalGrid * 0.08) {
      for (let k = 0; k < tail; k++) {
        kept[queue[k]] = 1;
      }
    }
  }

  // Flood-fill outside background (kept === 0) from frame borders so any interior holes
  // caused by large player clusters remain marked as pitch interior
  const outside = pool.gOutside;
  outside.fill(0);
  let head = 0;
  let tail = 0;
  for (let gx = 0; gx < gw; gx++) {
    if (kept[gx] === 0 && !outside[gx]) {
      outside[gx] = 1;
      queue[tail++] = gx;
    }
    const bottomIdx = (gh - 1) * gw + gx;
    if (kept[bottomIdx] === 0 && !outside[bottomIdx]) {
      outside[bottomIdx] = 1;
      queue[tail++] = bottomIdx;
    }
  }
  for (let gy = 0; gy < gh; gy++) {
    const leftIdx = gy * gw;
    if (kept[leftIdx] === 0 && !outside[leftIdx]) {
      outside[leftIdx] = 1;
      queue[tail++] = leftIdx;
    }
    const rightIdx = gy * gw + (gw - 1);
    if (kept[rightIdx] === 0 && !outside[rightIdx]) {
      outside[rightIdx] = 1;
      queue[tail++] = rightIdx;
    }
  }
  while (head < tail) {
    const curr = queue[head++];
    const cx = curr % gw;
    const cy = (curr - cx) / gw;
    if (cx > 0 && kept[curr - 1] === 0 && !outside[curr - 1]) {
      outside[curr - 1] = 1;
      queue[tail++] = curr - 1;
    }
    if (cx + 1 < gw && kept[curr + 1] === 0 && !outside[curr + 1]) {
      outside[curr + 1] = 1;
      queue[tail++] = curr + 1;
    }
    if (cy > 0 && kept[curr - gw] === 0 && !outside[curr - gw]) {
      outside[curr - gw] = 1;
      queue[tail++] = curr - gw;
    }
    if (cy + 1 < gh && kept[curr + gw] === 0 && !outside[curr + gw]) {
      outside[curr + gw] = 1;
      queue[tail++] = curr + gw;
    }
  }

  // Fallback if user only sampled a small pitch region: ensure kept wasn't empty
  let hasPitch = false;
  for (let i = 0; i < totalGrid; i++) {
    if (outside[i] === 0) {
      hasPitch = true;
      break;
    }
  }

  const fullPitch = pool.fullPitch;
  if (!hasPitch) {
    fullPitch.fill(1);
    return fullPitch;
  }

  for (let y = 0; y < h; y++) {
    const gy = Math.min(gh - 1, y >> 1);
    const rowOff = y * w;
    const gOff = gy * gw;
    for (let x = 0; x < w; x++) {
      const gx = Math.min(gw - 1, x >> 1);
      fullPitch[rowOff + x] = outside[gOff + gx] === 0 ? 1 : 0;
    }
  }
  return fullPitch;
}

function morphOpen2x2(
  src: Uint8Array,
  w: number,
  h: number,
  pool: DetectorScratchPool
): Uint8Array {
  const eroded = erodeRect(src, w, h, 1, 1, pool.gMorphTmp, pool.gDilated);
  return dilateRect(eroded, w, h, 1, 1, pool.gMorphTmp, pool.gOpened);
}

function dilateRect(
  src: Uint8Array,
  w: number,
  h: number,
  rx: number,
  ry: number,
  horiz: Uint8Array,
  out: Uint8Array
): Uint8Array {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let count = 0;
    for (let dx = 0; dx <= Math.min(w - 1, rx); dx++) {
      count += src[row + dx];
    }
    for (let x = 0; x < w; x++) {
      if (x > rx) count -= src[row + x - rx - 1];
      if (x + rx < w && x > 0) count += src[row + x + rx];
      horiz[row + x] = count > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let dy = 0; dy <= Math.min(h - 1, ry); dy++) {
      count += horiz[dy * w + x];
    }
    for (let y = 0; y < h; y++) {
      if (y > ry) count -= horiz[(y - ry - 1) * w + x];
      if (y + ry < h && y > 0) count += horiz[(y + ry) * w + x];
      out[y * w + x] = count > 0 ? 1 : 0;
    }
  }
  return out;
}

function erodeRect(
  src: Uint8Array,
  w: number,
  h: number,
  rx: number,
  ry: number,
  horiz: Uint8Array,
  out: Uint8Array
): Uint8Array {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const xEndInit = Math.min(w - 1, rx);
    let zeros = 0;
    for (let dx = 0; dx <= xEndInit; dx++) {
      if (src[row + dx] === 0) zeros++;
    }
    for (let x = 0; x < w; x++) {
      if (x > rx && src[row + x - rx - 1] === 0) zeros--;
      if (x + rx < w && x > 0 && src[row + x + rx] === 0) zeros++;
      horiz[row + x] = zeros === 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < w; x++) {
    const yEndInit = Math.min(h - 1, ry);
    let zeros = 0;
    for (let dy = 0; dy <= yEndInit; dy++) {
      if (horiz[dy * w + x] === 0) zeros++;
    }
    for (let y = 0; y < h; y++) {
      if (y > ry && horiz[(y - ry - 1) * w + x] === 0) zeros--;
      if (y + ry < h && y > 0 && horiz[(y + ry) * w + x] === 0) zeros++;
      out[y * w + x] = zeros === 0 ? 1 : 0;
    }
  }
  return out;
}

/**
 * Suppresses thin bright achromatic pitch lines (chalk markings) when there is no
 * nearby chromatic kit/skin foreground, preserving white socks/shorts/jerseys.
 */
function suppressPitchChalkLines(
  rawFg: Uint8Array,
  inPitchField: Uint8Array,
  data: Uint8ClampedArray,
  w: number,
  h: number,
  pool: DetectorScratchPool
): Uint8Array {
  const out = pool.chalkOut;
  const chromatic = pool.chromatic;
  const whiteAchromatic = pool.whiteAchromatic;
  out.set(rawFg);
  chromatic.fill(0);
  whiteAchromatic.fill(0);

  const total = w * h;
  for (let i = 0; i < total; i++) {
    if (rawFg[i] === 0 || inPitchField[i] === 0) continue;
    const idx = i * 4;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    const max = r > g ? (r > b ? r : b) : g > b ? g : b;
    const min = r < g ? (r < b ? r : b) : g < b ? g : b;
    const sat = max === 0 ? 0 : (max - min) / max;
    if (sat < 0.25 && max >= 132) {
      whiteAchromatic[i] = 1;
    } else if (sat >= 0.24) {
      chromatic[i] = 1;
    }
  }

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (whiteAchromatic[i] === 0) continue;

      // Measure thinness across vertical & horizontal spans
      let vRun = 1;
      for (let dy = 1; dy <= 4 && y - dy >= 0 && rawFg[(y - dy) * w + x]; dy++) vRun++;
      for (let dy = 1; dy <= 4 && y + dy < h && rawFg[(y + dy) * w + x]; dy++) vRun++;

      let hRun = 1;
      for (let dx = 1; dx <= 4 && x - dx >= 0 && rawFg[row + x - dx]; dx++) hRun++;
      for (let dx = 1; dx <= 4 && x + dx < w && rawFg[row + x + dx]; dx++) hRun++;

      if (vRun > 4 && hRun > 4) continue;

      // Check for nearby chromatic kit/skin within 5px
      let hasNearbyChromatic = false;
      const yMin = Math.max(0, y - 5);
      const yMax = Math.min(h - 1, y + 5);
      const xMin = Math.max(0, x - 5);
      const xMax = Math.min(w - 1, x + 5);
      for (let ny = yMin; ny <= yMax && !hasNearbyChromatic; ny++) {
        const nRow = ny * w;
        for (let nx = xMin; nx <= xMax; nx++) {
          if (chromatic[nRow + nx]) {
            hasNearbyChromatic = true;
            break;
          }
        }
      }

      if (!hasNearbyChromatic) {
        out[i] = 0;
      }
    }
  }

  return out;
}

/**
 * Bridges 1-2px vertical foreground gaps ONLY (to keep head/jersey/shorts/socks united)
 * without bridging close players horizontally.
 */
function bridgeVerticalGapsOnly(
  fg: Uint8Array,
  inPitchField: Uint8Array,
  w: number,
  h: number,
  out: Uint8Array
): Uint8Array {
  const total = fg.length;
  for (let i = 0; i < total; i++) {
    out[i] = inPitchField[i] && fg[i] ? 1 : 0;
  }
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (out[i] || !inPitchField[i]) continue;
      if (fg[(y - 1) * w + x] && fg[(y + 1) * w + x]) {
        out[i] = 1;
      } else if (y >= 2 && y < h - 2) {
        if (
          (fg[(y - 1) * w + x] && fg[(y + 2) * w + x]) ||
          (fg[(y - 2) * w + x] && fg[(y + 1) * w + x])
        ) {
          out[i] = 1;
        }
      }
    }
  }
  return out;
}

function extractConnectedComponents(
  fg: Uint8Array,
  inPitchField: Uint8Array,
  w: number,
  h: number,
  visited: Uint8Array,
  queue: Int32Array
): CandidateRect[] {
  const total = w * h;
  visited.fill(0);
  const comps: CandidateRect[] = [];

  for (let i = 0; i < total; i++) {
    if (fg[i] === 0 || inPitchField[i] === 0 || visited[i]) continue;

    let head = 0;
    let tail = 0;
    queue[tail++] = i;
    visited[i] = 1;

    let minX = w;
    let maxX = 0;
    let minY = h;
    let maxY = 0;

    while (head < tail) {
      const curr = queue[head++];
      const x = curr % w;
      const y = (curr - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      // 4-connectivity preserves separation of diagonally touching adjacent players
      if (x > 0) {
        const l = curr - 1;
        if (fg[l] && inPitchField[l] && !visited[l]) {
          visited[l] = 1;
          queue[tail++] = l;
        }
      }
      if (x + 1 < w) {
        const r = curr + 1;
        if (fg[r] && inPitchField[r] && !visited[r]) {
          visited[r] = 1;
          queue[tail++] = r;
        }
      }
      if (y > 0) {
        const u = curr - w;
        if (fg[u] && inPitchField[u] && !visited[u]) {
          visited[u] = 1;
          queue[tail++] = u;
        }
      }
      if (y + 1 < h) {
        const d = curr + w;
        if (fg[d] && inPitchField[d] && !visited[d]) {
          visited[d] = 1;
          queue[tail++] = d;
        }
      }
    }

    if (tail >= 16) {
      comps.push({ x0: minX, y0: minY, x1: maxX, y1: maxY });
    }
  }

  return comps;
}

/**
 * Recursively splits wide/multi-headed connected components where two or more players
 * are close or lightly touching into separate tight player boxes.
 */
function splitClosePlayersRecursive(
  rect: CandidateRect,
  fg: Uint8Array,
  data: Uint8ClampedArray,
  w: number,
  h: number,
  expW: number,
  expH: number,
  depth: number
): CandidateRect[] {
  const bw = rect.x1 - rect.x0 + 1;
  const bh = rect.y1 - rect.y0 + 1;
  if (depth >= 4 || bw < 9 || bh < 9) {
    return [rect];
  }

  // Check vertical split first if abnormally tall (> 1.68x expected height & tall aspect)
  if (bh > Math.max(expH * 1.65, h * 0.14) && bh / bw > 3.4) {
    const rowDens = new Float32Array(bh);
    for (let dy = 0; dy < bh; dy++) {
      let c = 0;
      const row = (rect.y0 + dy) * w;
      for (let x = rect.x0; x <= rect.x1; x++) {
        c += fg[row + x];
      }
      rowDens[dy] = c / bw;
    }
    const minSubH = Math.max(6, Math.round(bh * 0.25));
    let bestSplitY = -1;
    let bestRowGapScore = 0;
    for (let dy = minSubH; dy < bh - minSubH; dy++) {
      if (rowDens[dy] < 0.18) {
        const gapScore = 1 - rowDens[dy];
        if (gapScore > bestRowGapScore) {
          bestRowGapScore = gapScore;
          bestSplitY = dy;
        }
      }
    }
    if (bestSplitY !== -1) {
      const topRect = tightenSubRect(rect.x0, rect.y0, rect.x1, rect.y0 + bestSplitY - 1, fg, w);
      const botRect = tightenSubRect(rect.x0, rect.y0 + bestSplitY + 1, rect.x1, rect.y1, fg, w);
      const out: CandidateRect[] = [];
      if (topRect) {
        out.push(...splitClosePlayersRecursive(topRect, fg, data, w, h, expW, expH, depth + 1));
      }
      if (botRect) {
        out.push(...splitClosePlayersRecursive(botRect, fg, data, w, h, expW, expH, depth + 1));
      }
      if (out.length >= 2) return out;
    }
  }

  // Compute column mass, upper-body (head+torso) mass, head-top contour, and torso color per column
  const colMass = new Float32Array(bw);
  const upperMass = new Float32Array(bw);
  const topY = new Float32Array(bw);
  const colR = new Float32Array(bw);
  const colG = new Float32Array(bw);
  const colB = new Float32Array(bw);
  const colColorCount = new Float32Array(bw);

  const upperLimit = rect.y0 + Math.round(bh * 0.62);
  const torsoTop = rect.y0 + Math.round(bh * 0.18);
  const torsoBot = rect.y0 + Math.round(bh * 0.66);

  for (let dx = 0; dx < bw; dx++) {
    const x = rect.x0 + dx;
    let m = 0;
    let um = 0;
    let firstY = -1;
    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    let cCount = 0;

    for (let y = rect.y0; y <= rect.y1; y++) {
      if (fg[y * w + x] === 0) continue;
      m++;
      if (y <= upperLimit) um++;
      if (firstY === -1) firstY = y - rect.y0;
      if (y >= torsoTop && y <= torsoBot) {
        const idx = (y * w + x) * 4;
        rSum += data[idx];
        gSum += data[idx + 1];
        bSum += data[idx + 2];
        cCount++;
      }
    }

    colMass[dx] = m;
    upperMass[dx] = um;
    topY[dx] = firstY === -1 ? bh : firstY;
    if (cCount > 0) {
      colR[dx] = rSum / cCount;
      colG[dx] = gSum / cCount;
      colB[dx] = bSum / cCount;
      colColorCount[dx] = cCount;
    }
  }

  // Smooth upperMass slightly (3-tap) to detect distinct upper-body player peaks
  const smoothUpper = new Float32Array(bw);
  for (let dx = 0; dx < bw; dx++) {
    const a = dx > 0 ? upperMass[dx - 1] : upperMass[dx];
    const b = upperMass[dx];
    const c = dx + 1 < bw ? upperMass[dx + 1] : upperMass[dx];
    smoothUpper[dx] = (a + 2 * b + c) * 0.25;
  }

  const singleUpperPeakMin = Math.max(2.5, bh * 0.18);
  const peaks: number[] = [];
  for (let dx = 1; dx < bw - 1; dx++) {
    if (
      smoothUpper[dx] >= singleUpperPeakMin &&
      smoothUpper[dx] >= smoothUpper[dx - 1] &&
      smoothUpper[dx] > smoothUpper[dx + 1]
    ) {
      peaks.push(dx);
    }
  }

  const isWideForHeight = bw / bh > 0.68 || bw > Math.max(expW * 1.32, bh * 0.62);
  const hasMultiplePeaks = peaks.length >= 2 && peaks[peaks.length - 1] - peaks[0] >= Math.max(4, bw * 0.25);

  if (!isWideForHeight && !hasMultiplePeaks) {
    return [rect];
  }

  const minSubW = Math.max(4, Math.round(Math.min(expW * 0.42, bw * 0.22)));
  if (bw < minSubW * 2 + 1) {
    return [rect];
  }

  // Search for best separating column between left & right clusters
  let bestSplitDx = -1;
  let bestScore = 0;

  for (let dx = minSubW; dx <= bw - minSubW - 1; dx++) {
    let leftPeakMass = 0;
    let leftMinTop = bh;
    for (let i = 0; i < dx; i++) {
      if (upperMass[i] > leftPeakMass) leftPeakMass = upperMass[i];
      if (topY[i] < leftMinTop) leftMinTop = topY[i];
    }

    let rightPeakMass = 0;
    let rightMinTop = bh;
    for (let i = dx + 1; i < bw; i++) {
      if (upperMass[i] > rightPeakMass) rightPeakMass = upperMass[i];
      if (topY[i] < rightMinTop) rightMinTop = topY[i];
    }

    const minShoulderPeak = Math.min(leftPeakMass, rightPeakMass);
    if (minShoulderPeak < 2) continue;

    // 1. Silhouette valley in upper body & full column
    const upperValley = 1 - upperMass[dx] / Math.max(1, minShoulderPeak);
    const fullColRatio = colMass[dx] / Math.max(1, bh);
    const gapBonus = colMass[dx] <= 1 ? 0.55 : fullColRatio < 0.16 ? 0.28 : 0;

    // 2. Head-contour V-dip between two heads
    const headBase = Math.max(leftMinTop, rightMinTop);
    const headDip = Math.max(0, (topY[dx] - headBase) / Math.max(4, bh * 0.28));

    // 3. Torso kit color discontinuity across candidate split column
    const colorDiff = measureColorDiscontinuity(colR, colG, colB, colColorCount, dx, bw);

    const splitScore =
      upperValley * 0.48 +
      gapBonus +
      Math.min(1, headDip) * 0.26 +
      colorDiff * 0.34;

    if (splitScore > bestScore) {
      bestScore = splitScore;
      bestSplitDx = dx;
    }
  }

  // Require stronger evidence if width isn't clearly multi-player, lower bar if wide blob
  const splitThreshold = bw / bh > 0.85 ? 0.34 : 0.44;
  if (bestSplitDx === -1 || bestScore < splitThreshold) {
    return [rect];
  }

  const leftRect = tightenSubRect(rect.x0, rect.y0, rect.x0 + bestSplitDx - 1, rect.y1, fg, w);
  const rightRect = tightenSubRect(rect.x0 + bestSplitDx + 1, rect.y0, rect.x1, rect.y1, fg, w);

  if (!leftRect || !rightRect) {
    return [rect];
  }

  return [
    ...splitClosePlayersRecursive(leftRect, fg, data, w, h, expW, expH, depth + 1),
    ...splitClosePlayersRecursive(rightRect, fg, data, w, h, expW, expH, depth + 1),
  ];
}

function measureColorDiscontinuity(
  colR: Float32Array,
  colG: Float32Array,
  colB: Float32Array,
  colCount: Float32Array,
  dx: number,
  bw: number
): number {
  let lr = 0;
  let lg = 0;
  let lb = 0;
  let lc = 0;
  for (let i = Math.max(0, dx - 4); i < dx; i++) {
    if (colCount[i] > 0) {
      lr += colR[i];
      lg += colG[i];
      lb += colB[i];
      lc++;
    }
  }

  let rr = 0;
  let rg = 0;
  let rb = 0;
  let rc = 0;
  for (let i = dx + 1; i <= Math.min(bw - 1, dx + 4); i++) {
    if (colCount[i] > 0) {
      rr += colR[i];
      rg += colG[i];
      rb += colB[i];
      rc++;
    }
  }

  if (lc === 0 || rc === 0) return 0;
  const dr = lr / lc - rr / rc;
  const dg = lg / lc - rg / rc;
  const db = lb / lc - rb / rc;
  const dist = Math.hypot(dr, dg, db);
  return clamp((dist - 24) / 110, 0, 1);
}

function tightenSubRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  fg: Uint8Array,
  w: number
): CandidateRect | null {
  let minX = x1 + 1;
  let maxX = x0 - 1;
  let minY = y1 + 1;
  let maxY = y0 - 1;
  let count = 0;

  for (let y = y0; y <= y1; y++) {
    const row = y * w;
    for (let x = x0; x <= x1; x++) {
      if (fg[row + x]) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (count < 10 || minX > maxX || minY > maxY) return null;
  return { x0: minX, y0: minY, x1: maxX, y1: maxY };
}

/**
 * Tight-shrinks a candidate box strictly around high-confidence foreground pixels
 * so the resulting player bounding box is as small as possible.
 */
function shrinkWrapTight(
  rect: CandidateRect,
  fg: Uint8Array,
  fgAlpha: Float32Array,
  w: number
): CandidateRect | null {
  let minX = rect.x1 + 1;
  let maxX = rect.x0 - 1;
  let minY = rect.y1 + 1;
  let maxY = rect.y0 - 1;
  let count = 0;

  for (let y = rect.y0; y <= rect.y1; y++) {
    const row = y * w;
    for (let x = rect.x0; x <= rect.x1; x++) {
      const idx = row + x;
      if (fg[idx] && fgAlpha[idx] >= 0.48) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (count < 10 || minX > maxX || minY > maxY) return null;
  return { x0: minX, y0: minY, x1: maxX, y1: maxY };
}

function extractShapeSample(rect: CandidateRect, grid: AnalysisGrid): ShapeSample | null {
  const { w, h, fg, fgAlpha, data, inPitchField } = grid;
  const bw = rect.x1 - rect.x0 + 1;
  const bh = rect.y1 - rect.y0 + 1;
  if (bw <= 0 || bh <= 0) return null;

  // 1. Measure local pitch collar first (2-3px ring around rect) so we have local grass reference
  const collarPad = 3;
  const cx0 = Math.max(0, rect.x0 - collarPad);
  const cx1 = Math.min(w - 1, rect.x1 + collarPad);
  const cy0 = Math.max(0, rect.y0 - collarPad);
  const cy1 = Math.min(h - 1, rect.y1 + collarPad);

  let collarTotal = 0;
  let collarTurf = 0;
  let bgR = 0;
  let bgG = 0;
  let bgB = 0;
  let bgCount = 0;

  for (let y = cy0; y <= cy1; y++) {
    const row = y * w;
    for (let x = cx0; x <= cx1; x++) {
      if (x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1) continue;
      const idx = row + x;
      collarTotal++;
      if (inPitchField[idx] && fg[idx] === 0) {
        collarTurf++;
        const pIdx = idx * 4;
        bgR += data[pIdx];
        bgG += data[pIdx + 1];
        bgB += data[pIdx + 2];
        bgCount++;
      }
    }
  }

  const pitchCollar = collarTotal > 0 ? collarTurf / collarTotal : 0;
  const bgAvgR = bgCount > 0 ? bgR / bgCount : 42;
  const bgAvgG = bgCount > 0 ? bgG / bgCount : 120;
  const bgAvgB = bgCount > 0 ? bgB / bgCount : 54;
  const bgSum = bgAvgR + bgAvgG + bgAvgB;
  const hasBgChroma = bgCount > 0 && bgSum > 15;
  const bgCr = hasBgChroma ? bgAvgR / bgSum : 0;
  const bgCg = hasBgChroma ? bgAvgG / bgSum : 0;
  const bgCb = hasBgChroma ? bgAvgB / bgSum : 0;

  // 2. Measure silhouette anatomy + turf-vs-player appearance inside rect
  const area = bw * bh;
  let fgCount = 0;
  let headCount = 0;
  let headArea = 0;
  let torsoCount = 0;
  let torsoArea = 0;
  let legCount = 0;
  let legArea = 0;

  let symMatches = 0;
  let symTotal = 0;
  let vertEdges = 0;
  let horizEdges = 0;

  let fgR = 0;
  let fgG = 0;
  let fgB = 0;
  let alphaSum = 0;
  let highAlphaCount = 0;
  let nonTurfCount = 0;
  let popCount = 0;

  const headEnd = rect.y0 + Math.max(1, Math.round(bh * 0.22));
  const torsoEnd = rect.y0 + Math.max(2, Math.round(bh * 0.58));
  const headXStart = rect.x0 + Math.floor(bw * 0.22);
  const headXEnd = rect.x1 - Math.floor(bw * 0.22);

  for (let y = rect.y0; y <= rect.y1; y++) {
    const row = y * w;
    for (let x = rect.x0; x <= rect.x1; x++) {
      const idx = row + x;
      const val = fg[idx];
      if (val) {
        fgCount++;
        const pIdx = idx * 4;
        const r = data[pIdx];
        const g = data[pIdx + 1];
        const b = data[pIdx + 2];
        const a = fgAlpha[idx];
        fgR += r;
        fgG += g;
        fgB += b;
        alphaSum += a;
        if (a >= 0.72) highAlphaCount++;

        const rgbDist = bgCount > 0 ? Math.hypot(r - bgAvgR, g - bgAvgG, b - bgAvgB) : 100;
        if (rgbDist >= 32 && a >= 0.6) popCount++;

        const pSum = r + g + b;
        const chromaDiff =
          hasBgChroma && pSum > 15
            ? Math.abs(r / pSum - bgCr) + Math.abs(g / pSum - bgCg) + Math.abs(b / pSum - bgCb)
            : 1;
        const isGreenDominant = g > r * 1.02 && g > b * 1.02;
        const isTurfShadowOrStripe =
          bgCount > 0 && isGreenDominant && chromaDiff < 0.11 && (a < 0.78 || rgbDist < 48);
        const isWeakGlareTurf =
          bgCount > 0 && a < 0.62 && chromaDiff < 0.15 && rgbDist < 42;

        if (!isTurfShadowOrStripe && !isWeakGlareTurf) {
          nonTurfCount++;
        }
      }

      if (y < headEnd) {
        if (x >= headXStart && x <= headXEnd) {
          headArea++;
          headCount += val;
        }
      } else if (y < torsoEnd) {
        torsoArea++;
        torsoCount += val;
      } else {
        legArea++;
        legCount += val;
      }

      // Mirror symmetry across vertical centerline
      const mx = rect.x0 + (rect.x1 - x);
      if (x <= mx) {
        symTotal++;
        if (val === fg[row + mx]) {
          symMatches++;
        }
      }

      if (x > rect.x0 && val !== fg[row + x - 1]) vertEdges++;
      if (y > rect.y0 && val !== fg[(y - 1) * w + x]) horizEdges++;
    }
  }

  const fgAvgR = fgCount > 0 ? fgR / fgCount : 128;
  const fgAvgG = fgCount > 0 ? fgG / fgCount : 128;
  const fgAvgB = fgCount > 0 ? fgB / fgCount : 128;

  let turfContrast = 0.5;
  if (fgCount > 0 && bgCount > 0) {
    const dist = Math.hypot(fgAvgR - bgAvgR, fgAvgG - bgAvgG, fgAvgB - bgAvgB);
    turfContrast = clamp(dist / 135, 0, 1);
  }

  const aspect = bh / bw;
  const normW = bw / w;
  const normH = bh / h;
  const fillRatio = fgCount / area;
  const headOcc = headArea > 0 ? headCount / headArea : 0;
  const torsoOcc = torsoArea > 0 ? torsoCount / torsoArea : 0;
  const legOcc = legArea > 0 ? legCount / legArea : 0;
  const symmetry = symTotal > 0 ? symMatches / symTotal : 0.5;
  const vertEdgeScore =
    vertEdges + horizEdges > 0 ? vertEdges / (vertEdges + horizEdges) : 0.5;

  const meanFgAlpha = fgCount > 0 ? alphaSum / fgCount : 0;
  const highAlphaFrac = fgCount > 0 ? highAlphaCount / fgCount : 0;
  const nonTurfFrac = fgCount > 0 ? nonTurfCount / fgCount : 0;
  const popFrac = fgCount > 0 ? popCount / fgCount : 0;

  const features = new Float32Array([
    clamp(aspect / 2.2, 0, 2.5),
    clamp(normW * 10, 0, 2.0),
    clamp(normH * 6, 0, 2.5),
    clamp(fillRatio, 0, 1),
    clamp(headOcc, 0, 1),
    clamp(torsoOcc, 0, 1),
    clamp(legOcc, 0, 1),
    clamp(symmetry, 0, 1),
    clamp(vertEdgeScore, 0, 1),
    clamp(pitchCollar, 0, 1),
    clamp(turfContrast, 0, 1),
  ]);

  return {
    features,
    boxWNorm: normW,
    boxHNorm: normH,
    meanFgAlpha,
    highAlphaFrac,
    nonTurfFrac,
    popFrac,
    fgRgb: [fgAvgR, fgAvgG, fgAvgB],
    bgRgb: [bgAvgR, bgAvgG, bgAvgB],
  };
}

function featureDistSq(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return sum;
}

function normBoxToGridRect(
  box: { cx: number; cy: number; width: number; height: number },
  w: number,
  h: number
): CandidateRect {
  const bw = Math.max(3, Math.round(box.width * w));
  const bh = Math.max(5, Math.round(box.height * h));
  const cxPx = Math.round(box.cx * w);
  const cyPx = Math.round(box.cy * h);
  const x0 = clamp(cxPx - Math.floor(bw / 2), 0, w - 1);
  const y0 = clamp(cyPx - Math.floor(bh / 2), 0, h - 1);
  const x1 = clamp(x0 + bw - 1, x0, w - 1);
  const y1 = clamp(y0 + bh - 1, y0, h - 1);
  return { x0, y0, x1, y1 };
}

function computeIoU(a: CandidateRect, b: CandidateRect): number {
  const ix0 = Math.max(a.x0, b.x0);
  const iy0 = Math.max(a.y0, b.y0);
  const ix1 = Math.min(a.x1, b.x1);
  const iy1 = Math.min(a.y1, b.y1);
  if (ix1 < ix0 || iy1 < iy0) return 0;
  const inter = (ix1 - ix0 + 1) * (iy1 - iy0 + 1);
  const areaA = (a.x1 - a.x0 + 1) * (a.y1 - a.y0 + 1);
  const areaB = (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);
  return inter / Math.max(1, areaA + areaB - inter);
}

function floodFillLocalComponent(
  seedIdx: number,
  fg: Uint8Array,
  inPitchField: Uint8Array,
  w: number,
  wx0: number,
  wy0: number,
  wx1: number,
  wy1: number
): CandidateRect | null {
  const winW = wx1 - wx0 + 1;
  const winH = wy1 - wy0 + 1;
  const maxPixels = winW * winH;
  const visited = new Uint8Array(maxPixels);
  const queue = new Int32Array(maxPixels);

  const sx = seedIdx % w;
  const sy = (seedIdx - sx) / w;
  if (sx < wx0 || sx > wx1 || sy < wy0 || sy > wy1) return null;

  let head = 0;
  let tail = 0;
  queue[tail++] = seedIdx;
  visited[(sy - wy0) * winW + (sx - wx0)] = 1;

  let minX = sx;
  let maxX = sx;
  let minY = sy;
  let maxY = sy;

  while (head < tail) {
    const curr = queue[head++];
    const x = curr % w;
    const y = (curr - x) / w;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;

    if (x > wx0) {
      const lx = x - 1;
      const vIdx = (y - wy0) * winW + (lx - wx0);
      const l = curr - 1;
      if (fg[l] && inPitchField[l] && !visited[vIdx]) {
        visited[vIdx] = 1;
        queue[tail++] = l;
      }
    }
    if (x < wx1) {
      const rx = x + 1;
      const vIdx = (y - wy0) * winW + (rx - wx0);
      const r = curr + 1;
      if (fg[r] && inPitchField[r] && !visited[vIdx]) {
        visited[vIdx] = 1;
        queue[tail++] = r;
      }
    }
    if (y > wy0) {
      const uy = y - 1;
      const vIdx = (uy - wy0) * winW + (x - wx0);
      const u = curr - w;
      if (fg[u] && inPitchField[u] && !visited[vIdx]) {
        visited[vIdx] = 1;
        queue[tail++] = u;
      }
    }
    if (y < wy1) {
      const dy = y + 1;
      const vIdx = (dy - wy0) * winW + (x - wx0);
      const d = curr + w;
      if (fg[d] && inPitchField[d] && !visited[vIdx]) {
        visited[vIdx] = 1;
        queue[tail++] = d;
      }
    }
  }

  if (tail < 6) return null;
  return { x0: minX, y0: minY, x1: maxX, y1: maxY };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

