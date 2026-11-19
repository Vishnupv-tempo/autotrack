import type { CirclePosition, CvTrackerSettings } from '../types/tracking';

const ANALYSIS_MAX_WIDTH = 760;

// 2-band HSV color histogram: 8 Hue x 4 Sat x 3 Val = 96 bins per band
const H_BINS = 8;
const S_BINS = 4;
const V_BINS = 3;
const HIST_SIZE = H_BINS * S_BINS * V_BINS; // 96

export interface FrameData {
  width: number;
  height: number;
  coarseWidth: number;
  coarseHeight: number;
  coarseLuma: Float32Array;
  rgba: Uint8ClampedArray;
  luma: Float32Array;
  cb: Float32Array; // B - Y opponent chroma
  cr: Float32Array; // R - Y opponent chroma
  hsvBin: Uint8Array;
  turfR: number;
  turfG: number;
  turfB: number;
  hasTurf: boolean;
  time: number;
}

export interface PlayerTrackInput {
  id: string;
  prevPos: CirclePosition;
}

interface KalmanAxis {
  x: number;
  v: number;
  p00: number;
  p01: number;
  p11: number;
}

interface PatchStepStats {
  invW: number;
  meanRefL: number;
  invStdRefL: number;
  meanRefCb: number;
  invStdRefCb: number;
  meanRefCr: number;
  invStdRefCr: number;
  meanAdaptL: number;
  invStdAdaptL: number;
  meanAdaptCb: number;
  invStdAdaptCb: number;
  meanAdaptCr: number;
  invStdAdaptCr: number;
}

interface PlayerTemplate {
  halfW: number;
  halfH: number;
  patchW: number;
  patchH: number;
  normW: number;
  normH: number;
  /** Original reference patch (anchored when user drew the rectangle) */
  refLuma: Float32Array;
  refCb: Float32Array;
  refCr: Float32Array;
  refWeights: Float32Array;
  refHistUpper: Float32Array;
  refHistLower: Float32Array;
  /** Adaptive short-term patch blended ONLY during isolated, unambiguous locks */
  adaptLuma: Float32Array;
  adaptCb: Float32Array;
  adaptCr: Float32Array;
  adaptHistUpper: Float32Array;
  adaptHistLower: Float32Array;
  /** Precomputed template ZNCC moments for patchStep=1 and patchStep=2 */
  stats1: PatchStepStats;
  stats2: PatchStepStats;
  /** Precomputed sqrt histograms & sparse active bin lists for fast Bhattacharyya */
  sqrtRefHistUpper: Float32Array;
  sqrtRefHistLower: Float32Array;
  sqrtAdaptHistUpper: Float32Array;
  sqrtAdaptHistLower: Float32Array;
  activeUpperBins: Uint8Array;
  activeUpperCount: number;
  activeLowerBins: Uint8Array;
  activeLowerCount: number;
  /** Decoupled 2D constant-velocity Kalman filter in analysis pixels */
  kx: KalmanAxis;
  ky: KalmanAxis;
  lastRadiusPx: number;
  lostFrames: number;
  edgeLostFrames: number;
}

interface CandidatePeak {
  x: number;
  y: number;
  score: number;
  confidence: number;
}

interface PlayerCandidateSet {
  id: string;
  prevPos: CirclePosition;
  prevPx: number;
  prevPy: number;
  halfW: number;
  halfH: number;
  radiusPx: number;
  predX: number;
  predY: number;
  rawPredX: number;
  rawPredY: number;
  sigmaX: number;
  sigmaY: number;
  isCrowded: boolean;
  isAmbiguous: boolean;
  peaks: CandidatePeak[];
}

export class CvPlayerTracker {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private prevFrame: FrameData | null = null;
  private prevCamShift: { dx: number; dy: number } = { dx: 0, dy: 0 };
  private templates = new Map<string, PlayerTemplate>();

  // Ping-pong frame buffers + scratch arrays to avoid per-frame GC pauses
  private framePool: [FrameData | null, FrameData | null] = [null, null];
  private framePoolIdx = 0;
  private scratchCandHistUpper = new Float32Array(HIST_SIZE);
  private scratchCandHistLower = new Float32Array(HIST_SIZE);
  private scratchAdaptHistUpper = new Float32Array(HIST_SIZE);
  private scratchAdaptHistLower = new Float32Array(HIST_SIZE);
  private scratchAdaptLuma = new Float32Array(0);
  private scratchAdaptCb = new Float32Array(0);
  private scratchAdaptCr = new Float32Array(0);
  private scratchAdaptWeights = new Float32Array(0);
  private scratchEvaluated = new Map<number, number>();

  constructor() {
    this.canvas = document.createElement('canvas');
    const context = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      throw new Error('Unable to initialize 2D context for computer vision tracker.');
    }
    this.ctx = context;
  }

  public reset(): void {
    this.prevFrame = null;
    this.prevCamShift = { dx: 0, dy: 0 };
    this.templates.clear();
  }

  public removePlayer(playerId: string): void {
    this.templates.delete(playerId);
  }

  public syncPlayers(activeIds: string[]): void {
    const activeSet = new Set(activeIds);
    for (const id of this.templates.keys()) {
      if (!activeSet.has(id)) {
        this.templates.delete(id);
      }
    }
  }

  public hasTemplate(playerId: string): boolean {
    return this.templates.has(playerId);
  }

  public setPrevFrame(frame: FrameData): void {
    this.prevFrame = frame;
  }

  public getPrevFrame(): FrameData | null {
    return this.prevFrame;
  }

  /**
   * Captures current HTMLVideoElement frame into an optimized analysis buffer
   * with precomputed Luma, opponent Chroma (Cb, Cr), and quantized HSV bins.
   */
  public captureFrame(video: HTMLVideoElement): FrameData | null {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || video.readyState < 2) return null;

    const scale = Math.min(1, ANALYSIS_MAX_WIDTH / vw);
    const width = Math.max(64, Math.round(vw * scale));
    const height = Math.max(64, Math.round(vh * scale));

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    this.ctx.drawImage(video, 0, 0, width, height);
    const imageData = this.ctx.getImageData(0, 0, width, height);
    const rgba = imageData.data;
    const pixelCount = width * height;
    const coarseWidth = Math.max(16, Math.floor(width / 4));
    const coarseHeight = Math.max(16, Math.floor(height / 4));
    const coarseCount = coarseWidth * coarseHeight;

    // Pick the pool slot that is NOT currently held by this.prevFrame
    let slotIdx = this.framePoolIdx;
    if (this.framePool[slotIdx] && this.framePool[slotIdx] === this.prevFrame) {
      slotIdx = 1 - slotIdx;
    }
    this.framePoolIdx = 1 - slotIdx;

    let slot = this.framePool[slotIdx];
    if (!slot || slot.width !== width || slot.height !== height) {
      slot = {
        width,
        height,
        coarseWidth,
        coarseHeight,
        coarseLuma: new Float32Array(coarseCount),
        rgba,
        luma: new Float32Array(pixelCount),
        cb: new Float32Array(pixelCount),
        cr: new Float32Array(pixelCount),
        hsvBin: new Uint8Array(pixelCount),
        turfR: 42,
        turfG: 115,
        turfB: 52,
        hasTurf: false,
        time: video.currentTime,
      };
      this.framePool[slotIdx] = slot;
    } else {
      slot.rgba = rgba;
      slot.time = video.currentTime;
    }

    const { luma, cb, cr, hsvBin, coarseLuma } = slot;
    const hsvLut = getHsvBinLut();

    let turfSumR = 0;
    let turfSumG = 0;
    let turfSumB = 0;
    let turfCount = 0;

    for (let i = 0, p = 0; i < pixelCount; i++, p += 4) {
      const r = rgba[p];
      const g = rgba[p + 1];
      const b = rgba[p + 2];

      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      luma[i] = y;
      cb[i] = b - y;
      cr[i] = r - y;
      hsvBin[i] = hsvLut[((r & 0xfc) << 10) | ((g & 0xfc) << 4) | (b >> 2)];

      // Sample every 4th pixel to estimate dominant green pitch turf color
      if ((i & 3) === 0 && g > r + 10 && g > b + 8 && g > 45 && g < 220) {
        turfSumR += r;
        turfSumG += g;
        turfSumB += b;
        turfCount++;
      }
    }

    const hasTurf = turfCount > pixelCount * 0.04;
    const tR = hasTurf ? turfSumR / turfCount : 42;
    const tG = hasTurf ? turfSumG / turfCount : 115;
    const tB = hasTurf ? turfSumB / turfCount : 52;

    if (hasTurf) {
      // Pre-encode turf mask into bit 7 (0x80) of hsvBin so evaluateCandidate never reads rgba
      for (let i = 0, p = 0; i < pixelCount; i++, p += 4) {
        const g = rgba[p + 1];
        if (g > 40) {
          const r = rgba[p];
          if (g > r + 10) {
            const b = rgba[p + 2];
            if (g > b + 8) {
              const dist = Math.abs(r - tR) + Math.abs(g - tG) + Math.abs(b - tB);
              if (dist < 95) {
                hsvBin[i] |= 0x80;
              }
            }
          }
        }
      }
    }

    // 4x downsampled luma pyramid for fast wide-range global camera pan detection
    for (let cy = 0; cy < coarseHeight; cy++) {
      const sy = cy * 4;
      const cRow = cy * coarseWidth;
      for (let cx = 0; cx < coarseWidth; cx++) {
        const sx = cx * 4;
        const p0 = sy * width + sx;
        const p1 = (sy + 1) * width + sx;
        const p2 = (sy + 2) * width + sx;
        const p3 = (sy + 3) * width + sx;
        coarseLuma[cRow + cx] =
          (luma[p0] + luma[p0 + 2] + luma[p1 + 1] + luma[p2] + luma[p2 + 2] + luma[p3 + 3]) *
          (1 / 6);
      }
    }

    slot.turfR = tR;
    slot.turfG = tG;
    slot.turfB = tB;
    slot.hasTurf = hasTurf;
    return slot;
  }

  /**
   * Initializes or re-anchors a player's CV template at the given frame & normalized rectangle.
   */
  public anchorPlayer(
    playerId: string,
    frame: FrameData,
    rectPos: CirclePosition,
    useTurfMask: boolean,
    preserveMotion = false
  ): void {
    const prevTpl = preserveMotion ? this.templates.get(playerId) : undefined;
    const px = rectPos.cx * frame.width;
    const py = rectPos.cy * frame.height;
    const fallbackW = rectPos.radius * 2 * frame.width;
    const boxWPx = Math.max(10, rectPos.width > 0 ? rectPos.width * frame.width : fallbackW);
    const boxHPx = Math.max(14, rectPos.height > 0 ? rectPos.height * frame.height : fallbackW * 1.8);
    const radiusPx = Math.max(8, rectPos.radius * frame.width);

    // Sample rectangular patch matched directly to user's bounding rectangle
    const halfW = Math.max(5, Math.min(34, Math.round(boxWPx * 0.5)));
    const halfH = Math.max(7, Math.min(52, Math.round(boxHPx * 0.5)));
    const patchW = halfW * 2 + 1;
    const patchH = halfH * 2 + 1;
    const len = patchW * patchH;

    const refLuma = new Float32Array(len);
    const refCb = new Float32Array(len);
    const refCr = new Float32Array(len);
    const refWeights = new Float32Array(len);
    const refHistUpper = new Float32Array(HIST_SIZE);
    const refHistLower = new Float32Array(HIST_SIZE);

    this.samplePatch(
      frame,
      px,
      py,
      halfW,
      halfH,
      useTurfMask,
      refLuma,
      refCb,
      refCr,
      refWeights,
      refHistUpper,
      refHistLower
    );

    const kx: KalmanAxis = prevTpl
      ? {
          x: px,
          v: prevTpl.kx.v,
          p00: Math.max(4, Math.min(20, prevTpl.kx.p00)),
          p01: prevTpl.kx.p01,
          p11: Math.max(2, Math.min(14, prevTpl.kx.p11)),
        }
      : createKalmanAxis(px);

    const ky: KalmanAxis = prevTpl
      ? {
          x: py,
          v: prevTpl.ky.v,
          p00: Math.max(4, Math.min(20, prevTpl.ky.p00)),
          p01: prevTpl.ky.p01,
          p11: Math.max(2, Math.min(14, prevTpl.ky.p11)),
        }
      : createKalmanAxis(py);

    const adaptLuma = new Float32Array(refLuma);
    const adaptCb = new Float32Array(refCb);
    const adaptCr = new Float32Array(refCr);
    const adaptHistUpper = new Float32Array(refHistUpper);
    const adaptHistLower = new Float32Array(refHistLower);

    const tpl: PlayerTemplate = {
      halfW,
      halfH,
      patchW,
      patchH,
      normW: rectPos.width > 0 ? rectPos.width : boxWPx / frame.width,
      normH: rectPos.height > 0 ? rectPos.height : boxHPx / frame.height,
      refLuma,
      refCb,
      refCr,
      refWeights,
      refHistUpper,
      refHistLower,
      adaptLuma,
      adaptCb,
      adaptCr,
      adaptHistUpper,
      adaptHistLower,
      stats1: createEmptyPatchStats(),
      stats2: createEmptyPatchStats(),
      sqrtRefHistUpper: new Float32Array(HIST_SIZE),
      sqrtRefHistLower: new Float32Array(HIST_SIZE),
      sqrtAdaptHistUpper: new Float32Array(HIST_SIZE),
      sqrtAdaptHistLower: new Float32Array(HIST_SIZE),
      activeUpperBins: new Uint8Array(HIST_SIZE),
      activeUpperCount: 0,
      activeLowerBins: new Uint8Array(HIST_SIZE),
      activeLowerCount: 0,
      kx,
      ky,
      lastRadiusPx: radiusPx,
      lostFrames: 0,
      edgeLostFrames: 0,
    };

    computeTemplateStepStats(tpl, 1, tpl.stats1);
    computeTemplateStepStats(tpl, 2, tpl.stats2);
    for (let b = 0; b < HIST_SIZE; b++) {
      tpl.sqrtRefHistUpper[b] = Math.sqrt(refHistUpper[b]);
      tpl.sqrtRefHistLower[b] = Math.sqrt(refHistLower[b]);
    }
    syncTemplateAdaptCache(tpl, false);

    this.templates.set(playerId, tpl);
  }

  /**
   * Estimates global broadcast camera pan (dx, dy) using a 2-level coarse-to-fine pyramid
   * with texture filtering so sudden fast whip-pans (up to ~100px/frame) are tracked accurately.
   */
  public estimateGlobalCameraShift(prev: FrameData, curr: FrameData): { dx: number; dy: number } {
    if (prev.width !== curr.width || prev.height !== curr.height) {
      return { dx: 0, dy: 0 };
    }

    // Level 1: Coarse 4x search for wide, sudden camera whip-pans
    const cw = curr.coarseWidth;
    const ch = curr.coarseHeight;
    const cBlockHalf = 5;
    const maxCoarseX = Math.max(8, Math.round(cw * 0.14)); // ~105 full-res px
    const maxCoarseY = Math.max(5, Math.round(ch * 0.09)); // ~38 full-res px

    const coarseAnchors = [
      [Math.round(cw * 0.22), Math.round(ch * 0.24)],
      [Math.round(cw * 0.5), Math.round(ch * 0.24)],
      [Math.round(cw * 0.78), Math.round(ch * 0.24)],
      [Math.round(cw * 0.22), Math.round(ch * 0.5)],
      [Math.round(cw * 0.5), Math.round(ch * 0.5)],
      [Math.round(cw * 0.78), Math.round(ch * 0.5)],
      [Math.round(cw * 0.22), Math.round(ch * 0.75)],
      [Math.round(cw * 0.5), Math.round(ch * 0.75)],
      [Math.round(cw * 0.78), Math.round(ch * 0.75)],
    ];

    const cDxs: number[] = [];
    const cDys: number[] = [];

    for (const [ax, ay] of coarseAnchors) {
      if (
        ax - cBlockHalf - maxCoarseX < 0 ||
        ax + cBlockHalf + maxCoarseX >= cw ||
        ay - cBlockHalf - maxCoarseY < 0 ||
        ay + cBlockHalf + maxCoarseY >= ch
      ) {
        continue;
      }

      // Skip featureless flat grass blocks
      if (blockContrast(prev.coarseLuma, cw, ax, ay, cBlockHalf) < 3.5) {
        continue;
      }

      let bestSad = Infinity;
      let bestDx = 0;
      let bestDy = 0;

      for (let dy = -maxCoarseY; dy <= maxCoarseY; dy += 2) {
        for (let dx = -maxCoarseX; dx <= maxCoarseX; dx += 2) {
          let sad = 0;
          for (let py = -cBlockHalf; py <= cBlockHalf; py += 2) {
            const rowPrev = (ay + py) * cw;
            const rowCurr = (ay + py + dy) * cw;
            for (let px = -cBlockHalf; px <= cBlockHalf; px += 2) {
              sad += Math.abs(
                prev.coarseLuma[rowPrev + ax + px] - curr.coarseLuma[rowCurr + ax + px + dx]
              );
            }
          }
          if (sad < bestSad) {
            bestSad = sad;
            bestDx = dx;
            bestDy = dy;
          }
        }
      }

      const bdx = bestDx;
      const bdy = bestDy;
      bestSad = Infinity;
      for (let dy = bdy - 1; dy <= bdy + 1; dy++) {
        for (let dx = bdx - 1; dx <= bdx + 1; dx++) {
          let sad = 0;
          for (let py = -cBlockHalf; py <= cBlockHalf; py += 2) {
            const rowPrev = (ay + py) * cw;
            const rowCurr = (ay + py + dy) * cw;
            for (let px = -cBlockHalf; px <= cBlockHalf; px += 2) {
              sad += Math.abs(
                prev.coarseLuma[rowPrev + ax + px] - curr.coarseLuma[rowCurr + ax + px + dx]
              );
            }
          }
          if (sad < bestSad) {
            bestSad = sad;
            bestDx = dx;
            bestDy = dy;
          }
        }
      }

      cDxs.push(bestDx);
      cDys.push(bestDy);
    }

    let initDx = 0;
    let initDy = 0;
    if (cDxs.length > 0) {
      cDxs.sort((a, b) => a - b);
      cDys.sort((a, b) => a - b);
      const midC = Math.floor(cDxs.length / 2);
      initDx = cDxs[midC] * 4;
      initDy = cDys[midC] * 4;
    }

    // Level 2: Fine full-res search around (initDx, initDy) with sub-pixel parabolic refinement
    const w = curr.width;
    const h = curr.height;
    const blockHalf = 12;
    const fineRadius = 6;

    const anchors = [
      [Math.round(w * 0.22), Math.round(h * 0.25)],
      [Math.round(w * 0.5), Math.round(h * 0.25)],
      [Math.round(w * 0.78), Math.round(h * 0.25)],
      [Math.round(w * 0.22), Math.round(h * 0.5)],
      [Math.round(w * 0.5), Math.round(h * 0.45)],
      [Math.round(w * 0.78), Math.round(h * 0.5)],
      [Math.round(w * 0.22), Math.round(h * 0.74)],
      [Math.round(w * 0.5), Math.round(h * 0.72)],
      [Math.round(w * 0.78), Math.round(h * 0.74)],
    ];

    const dxs: number[] = [];
    const dys: number[] = [];

    for (const [ax, ay] of anchors) {
      if (
        ax - blockHalf < 0 ||
        ax + blockHalf >= w ||
        ay - blockHalf < 0 ||
        ay + blockHalf >= h ||
        ax - blockHalf + initDx - fineRadius < 0 ||
        ax + blockHalf + initDx + fineRadius >= w ||
        ay - blockHalf + initDy - fineRadius < 0 ||
        ay + blockHalf + initDy + fineRadius >= h
      ) {
        continue;
      }

      // Skip low-texture uniform grass blocks so repetitive turf cannot pull median to 0
      if (blockContrast(prev.luma, w, ax, ay, blockHalf) < 4.5) {
        continue;
      }

      let bestSad = Infinity;
      let bestDx = initDx;
      let bestDy = initDy;

      for (let dy = initDy - fineRadius; dy <= initDy + fineRadius; dy += 2) {
        for (let dx = initDx - fineRadius; dx <= initDx + fineRadius; dx += 2) {
          let sad = 0;
          for (let py = -blockHalf; py <= blockHalf; py += 2) {
            const rowPrev = (ay + py) * w;
            const rowCurr = (ay + py + dy) * w;
            for (let px = -blockHalf; px <= blockHalf; px += 2) {
              sad += Math.abs(prev.luma[rowPrev + ax + px] - curr.luma[rowCurr + ax + px + dx]);
            }
          }
          if (sad < bestSad) {
            bestSad = sad;
            bestDx = dx;
            bestDy = dy;
          }
        }
      }

      const baseDx = bestDx;
      const baseDy = bestDy;
      const fineSads = new Float64Array(9);
      let idx3 = 0;
      bestSad = Infinity;

      for (let dy = baseDy - 1; dy <= baseDy + 1; dy++) {
        for (let dx = baseDx - 1; dx <= baseDx + 1; dx++) {
          let sad = 0;
          for (let py = -blockHalf; py <= blockHalf; py += 2) {
            const rowPrev = (ay + py) * w;
            const rowCurr = (ay + py + dy) * w;
            for (let px = -blockHalf; px <= blockHalf; px += 2) {
              sad += Math.abs(prev.luma[rowPrev + ax + px] - curr.luma[rowCurr + ax + px + dx]);
            }
          }
          fineSads[idx3++] = sad;
          if (sad < bestSad) {
            bestSad = sad;
            bestDx = dx;
            bestDy = dy;
          }
        }
      }

      let subDx = 0;
      let subDy = 0;
      if (bestDx === baseDx && bestDy === baseDy) {
        const sLeft = fineSads[3];
        const sCenter = fineSads[4];
        const sRight = fineSads[5];
        const sUp = fineSads[1];
        const sDown = fineSads[7];
        const denomX = 2 * (sLeft - 2 * sCenter + sRight);
        if (denomX > 1e-3) {
          subDx = clamp((sLeft - sRight) / denomX, -0.5, 0.5);
        }
        const denomY = 2 * (sUp - 2 * sCenter + sDown);
        if (denomY > 1e-3) {
          subDy = clamp((sUp - sDown) / denomY, -0.5, 0.5);
        }
      }

      dxs.push(bestDx + subDx);
      dys.push(bestDy + subDy);
    }

    if (dxs.length === 0) return { dx: initDx, dy: initDy };
    dxs.sort((a, b) => a - b);
    dys.sort((a, b) => a - b);
    const mid = Math.floor(dxs.length / 2);
    return { dx: dxs[mid], dy: dys[mid] };
  }

  /**
   * Jointly tracks all active players in `currFrame` using:
   * - Decoupled 2D Kalman prediction & Mahalanobis velocity gating
   * - Opponent-Chroma + Luma ZNCC + 2-band (Upper/Lower) HSV Bhattacharyya matching
   * - Multi-peak extraction + Joint 1-to-1 assignment to avoid ID swaps when close/crossing
   * - Proximity & ambiguity template freeze to prevent template contamination
   */
  public trackAllPlayers(
    currFrame: FrameData,
    inputs: PlayerTrackInput[],
    camShift: { dx: number; dy: number },
    settings: CvTrackerSettings
  ): Map<string, CirclePosition> {
    const results = new Map<string, CirclePosition>();
    if (inputs.length === 0) return results;

    const w = currFrame.width;
    const h = currFrame.height;
    const compDx = settings.cameraCompensation ? camShift.dx : 0;
    const compDy = settings.cameraCompensation ? camShift.dy : 0;
    const panMag = Math.hypot(compDx, compDy);
    const panAccel = Math.hypot(compDx - this.prevCamShift.dx, compDy - this.prevCamShift.dy);
    const isFastPan = panMag > 7 || panAccel > 5.5;
    this.prevCamShift = { dx: compDx, dy: compDy };

    // 1. Ensure templates exist and run Kalman prediction per player
    const predictions: Array<{
      id: string;
      prevPos: CirclePosition;
      tpl: PlayerTemplate;
      prevPx: number;
      prevPy: number;
      radiusPx: number;
      predX: number;
      predY: number;
      rawPredX: number;
      rawPredY: number;
      sigmaX: number;
      sigmaY: number;
    }> = [];

    for (const item of inputs) {
      let tpl = this.templates.get(item.id);
      if (!tpl) {
        const seedFrame = this.prevFrame ?? currFrame;
        this.anchorPlayer(item.id, seedFrame, item.prevPos, settings.turfMasking);
        tpl = this.templates.get(item.id)!;
      }

      const prevPx = item.prevPos.cx * w;
      const prevPy = item.prevPos.cy * h;
      const radiusPx = Math.max(8, item.prevPos.radius * w);

      // Sync Kalman state if external seek/drag moved it far from filter state
      if (
        Math.hypot(
          (tpl.kx.x - prevPx) / Math.max(8, tpl.halfW),
          (tpl.ky.x - prevPy) / Math.max(10, tpl.halfH)
        ) > 2.8
      ) {
        tpl.kx = createKalmanAxis(prevPx);
        tpl.ky = createKalmanAxis(prevPy);
      }

      const rawPredX = tpl.kx.x + tpl.kx.v + compDx;
      const rawPredY = tpl.ky.x + tpl.ky.v + compDy;

      const extraUncert = isFastPan ? panAccel * 1.35 + panMag * 0.45 : 0;
      const pxPred = predictKalmanAxis(tpl.kx, compDx, tpl.halfW + 1, w - tpl.halfW - 2, extraUncert);
      const pyPred = predictKalmanAxis(tpl.ky, compDy, tpl.halfH + 1, h - tpl.halfH - 2, extraUncert);

      predictions.push({
        id: item.id,
        prevPos: item.prevPos,
        tpl,
        prevPx,
        prevPy,
        radiusPx,
        predX: pxPred.pos,
        predY: pyPred.pos,
        rawPredX,
        rawPredY,
        sigmaX: pxPred.sigma,
        sigmaY: pyPred.sigma,
      });
    }

    // 2. Detect proximity between predicted player boxes (to freeze template adaptation & boost ref weight)
    const candidateSets: PlayerCandidateSet[] = [];

    for (let i = 0; i < predictions.length; i++) {
      const p = predictions[i];
      let isCrowded = false;

      if (settings.collisionAvoidance) {
        for (let j = 0; j < predictions.length; j++) {
          if (i === j) continue;
          const other = predictions[j];
          const normDist = boxNormalizedDist(
            p.predX,
            p.predY,
            p.tpl.halfW,
            p.tpl.halfH,
            other.predX,
            other.predY,
            other.tpl.halfW,
            other.tpl.halfH
          );
          if (normDist < 1.45) {
            isCrowded = true;
            break;
          }
        }
      }

      const { peaks, isAmbiguous } = this.searchPlayerPeaks(
        currFrame,
        p.tpl,
        p.predX,
        p.predY,
        p.sigmaX,
        p.sigmaY,
        isCrowded,
        isFastPan,
        panMag,
        settings
      );

      candidateSets.push({
        id: p.id,
        prevPos: p.prevPos,
        prevPx: p.prevPx,
        prevPy: p.prevPy,
        halfW: p.tpl.halfW,
        halfH: p.tpl.halfH,
        radiusPx: p.radiusPx,
        predX: p.predX,
        predY: p.predY,
        rawPredX: p.rawPredX,
        rawPredY: p.rawPredY,
        sigmaX: p.sigmaX,
        sigmaY: p.sigmaY,
        isCrowded,
        isAmbiguous,
        peaks,
      });
    }

    // 3. Jointly assign peaks across players to avoid two boxes collapsing onto one player
    const chosenPeaks = settings.collisionAvoidance && candidateSets.length > 1
      ? solveJointAssignment(candidateSets)
      : candidateSets.map((cs) => cs.peaks[0]);

    // 4. Check post-assignment overlap: if two players still converge onto the same location,
    //    keep the higher-confidence lock and force the weaker one into occlusion coasting
    const postOccluded = new Set<string>();
    if (settings.collisionAvoidance && candidateSets.length > 1) {
      for (let i = 0; i < candidateSets.length; i++) {
        for (let j = i + 1; j < candidateSets.length; j++) {
          const ci = chosenPeaks[i];
          const cj = chosenPeaks[j];
          const normSep = boxNormalizedDist(
            ci.x,
            ci.y,
            candidateSets[i].halfW,
            candidateSets[i].halfH,
            cj.x,
            cj.y,
            candidateSets[j].halfW,
            candidateSets[j].halfH
          );
          if (normSep < 0.65) {
            // Whichever has the significantly weaker appearance match is likely stolen/occluded
            if (ci.confidence + 0.08 < cj.confidence) {
              postOccluded.add(candidateSets[i].id);
            } else if (cj.confidence + 0.08 < ci.confidence) {
              postOccluded.add(candidateSets[j].id);
            }
          }
        }
      }
    }

    // 5. Update Kalman filters, detect out-of-camera exits, handle occlusion coasting, and adapt templates only when safe
    for (let i = 0; i < candidateSets.length; i++) {
      const cs = candidateSets[i];
      const tpl = this.templates.get(cs.id)!;
      const peak = chosenPeaks[i];
      const forcedOccluded = postOccluded.has(cs.id);

      const exitMarginX = Math.max(4, tpl.halfW * 0.45);
      const exitMarginY = Math.max(4, tpl.halfH * 0.45);
      const predExitedFrame =
        cs.rawPredX < exitMarginX ||
        cs.rawPredX > w - exitMarginX ||
        cs.rawPredY < exitMarginY ||
        cs.rawPredY > h - exitMarginY;

      const nearLeft = cs.prevPx <= tpl.halfW + 6;
      const nearRight = cs.prevPx >= w - tpl.halfW - 7;
      const nearTop = cs.prevPy <= tpl.halfH + 6;
      const nearBottom = cs.prevPy >= h - tpl.halfH - 7;
      const atBorder = nearLeft || nearRight || nearTop || nearBottom;

      const netVx = tpl.kx.v + compDx;
      const netVy = tpl.ky.v + compDy;
      const movingOutward =
        (nearLeft && netVx < -0.45) ||
        (nearRight && netVx > 0.45) ||
        (nearTop && netVy < -0.45) ||
        (nearBottom && netVy > 0.45);

      const isWeakOrLost = forcedOccluded || peak.confidence < settings.confidenceThreshold;

      if (
        predExitedFrame &&
        (isWeakOrLost || peak.confidence < settings.confidenceThreshold + 0.14 || movingOutward)
      ) {
        this.templates.delete(cs.id);
        results.set(cs.id, {
          cx: cs.prevPos.cx,
          cy: cs.prevPos.cy,
          width: tpl.normW,
          height: tpl.normH,
          radius: cs.radiusPx / w,
          confidence: peak.confidence,
          status: 'stopped',
          time: currFrame.time,
        });
        continue;
      }

      if (isWeakOrLost) {
        if (atBorder) {
          tpl.edgeLostFrames += 1;
          if (tpl.edgeLostFrames >= 2 || movingOutward) {
            this.templates.delete(cs.id);
            results.set(cs.id, {
              cx: cs.prevPos.cx,
              cy: cs.prevPos.cy,
              width: tpl.normW,
              height: tpl.normH,
              radius: cs.radiusPx / w,
              confidence: peak.confidence,
              status: 'stopped',
              time: currFrame.time,
            });
            continue;
          }
        } else {
          tpl.edgeLostFrames = 0;
        }

        // Occluded / low confidence inside frame: coast smoothly along Kalman-predicted velocity
        tpl.lostFrames += 1;
        // Dampen velocity mildly so long occlusions don't fly off-screen
        tpl.kx.v *= 0.84;
        tpl.ky.v *= 0.84;
        const coastX = clamp(cs.predX, tpl.halfW + 1, w - tpl.halfW - 2);
        const coastY = clamp(cs.predY, tpl.halfH + 1, h - tpl.halfH - 2);
        tpl.kx.x = coastX;
        tpl.ky.x = coastY;

        results.set(cs.id, {
          cx: coastX / w,
          cy: coastY / h,
          width: tpl.normW,
          height: tpl.normH,
          radius: cs.radiusPx / w,
          confidence: forcedOccluded ? Math.min(peak.confidence, settings.confidenceThreshold * 0.85) : peak.confidence,
          status: tpl.lostFrames > 16 ? 'lost' : 'occluded',
          time: currFrame.time,
        });
        continue;
      }

      // Valid measurement lock: update 2D Kalman filter with innovation-adaptive smoothing
      const smoothing = clamp(settings.smoothing ?? 0.65, 0, 1);
      const isolatePanShock = isFastPan || tpl.lostFrames > 0;
      updateKalmanAxis(tpl.kx, peak.x, peak.confidence, smoothing, isolatePanShock);
      updateKalmanAxis(tpl.ky, peak.y, peak.confidence, smoothing, isolatePanShock);
      tpl.lostFrames = 0;

      const outX = clamp(tpl.kx.x, tpl.halfW + 1, w - tpl.halfW - 2);
      const outY = clamp(tpl.ky.x, tpl.halfH + 1, h - tpl.halfH - 2);

      const pinnedAtBorder =
        outX <= tpl.halfW + 2.5 ||
        outX >= w - tpl.halfW - 3.5 ||
        outY <= tpl.halfH + 2.5 ||
        outY >= h - tpl.halfH - 3.5;

      if (pinnedAtBorder && (peak.confidence < 0.56 || movingOutward)) {
        tpl.edgeLostFrames += 1;
        if (tpl.edgeLostFrames >= 3) {
          this.templates.delete(cs.id);
          results.set(cs.id, {
            cx: outX / w,
            cy: outY / h,
            width: tpl.normW,
            height: tpl.normH,
            radius: cs.radiusPx / w,
            confidence: peak.confidence,
            status: 'stopped',
            time: currFrame.time,
          });
          continue;
        }
      } else {
        tpl.edgeLostFrames = 0;
      }

      // CRITICAL ANTI-SWAP RULE:
      // Only adapt short-term template when the player is isolated, unambiguous, and strongly locked.
      // Never contaminate the template while another player is close or multiple peaks compete!
      if (
        !cs.isCrowded &&
        !cs.isAmbiguous &&
        !isFastPan &&
        peak.confidence > 0.7 &&
        settings.adaptationRate > 0
      ) {
        this.adaptTemplate(
          currFrame,
          tpl,
          outX,
          outY,
          settings.adaptationRate,
          settings.turfMasking
        );
      }

      results.set(cs.id, {
        cx: outX / w,
        cy: outY / h,
        width: tpl.normW,
        height: tpl.normH,
        radius: cs.radiusPx / w,
        confidence: peak.confidence,
        status: 'tracking',
        time: currFrame.time,
      });
    }

    return results;
  }

  /**
   * Single-player convenience wrapper (delegates to joint tracker).
   */
  public trackPlayer(
    playerId: string,
    currFrame: FrameData,
    prevPos: CirclePosition,
    camShift: { dx: number; dy: number },
    settings: CvTrackerSettings
  ): CirclePosition {
    const res = this.trackAllPlayers(currFrame, [{ id: playerId, prevPos }], camShift, settings);
    return res.get(playerId) ?? prevPos;
  }

  /**
   * Estimates an optimal player CV sampling rectangle when user single-clicks on a player
   * (either on their feet or torso), returning both the CV box and the render offset
   * so the rendered ring or polygon vertex stays pinned at the exact clicked point.
   */
  public suggestPlayerBoxAtPoint(
    frame: FrameData | null,
    normX: number,
    normY: number,
    defaultNormW: number,
    defaultNormH: number,
    preferFootAnchor: boolean,
    time: number
  ): { pos: CirclePosition; renderOffsetX: number; renderOffsetY: number } {
    const safeW = Math.max(0.015, Math.min(0.45, defaultNormW));
    const safeH = Math.max(0.03, Math.min(0.7, defaultNormH));

    if (!frame || !frame.hasTurf) {
      const boxCy = preferFootAnchor
        ? clamp(normY - safeH * 0.44, 0.01, 0.99)
        : normY;
      return {
        pos: {
          cx: normX,
          cy: boxCy,
          width: safeW,
          height: safeH,
          radius: Math.max(safeW * 0.5, safeH * 0.28),
          confidence: 1,
          status: 'anchored',
          time,
        },
        renderOffsetX: 0,
        renderOffsetY: normY - boxCy,
      };
    }

    const w = frame.width;
    const h = frame.height;
    const px = normX * w;
    const py = normY * h;
    const boxWPx = Math.max(10, safeW * w);
    const boxHPx = Math.max(14, safeH * h);
    const halfW = boxWPx * 0.5;
    const halfH = boxHPx * 0.5;

    const sampleFgRatio = (cxPx: number, yMin: number, yMax: number) => {
      const x0 = Math.max(0, Math.round(cxPx - halfW * 0.75));
      const x1 = Math.min(w - 1, Math.round(cxPx + halfW * 0.75));
      const yy0 = Math.max(0, Math.round(yMin));
      const yy1 = Math.min(h - 1, Math.round(yMax));
      let fg = 0;
      let total = 0;
      let sumX = 0;
      for (let y = yy0; y <= yy1; y += 2) {
        const row = y * w;
        for (let x = x0; x <= x1; x += 2) {
          const p4 = (row + x) * 4;
          const isTurf = isTurfPixel(
            frame.rgba[p4],
            frame.rgba[p4 + 1],
            frame.rgba[p4 + 2],
            frame
          );
          total++;
          if (!isTurf) {
            fg++;
            sumX += x;
          }
        }
      }
      return {
        ratio: total > 0 ? fg / total : 0,
        meanX: fg > 0 ? sumX / fg : cxPx,
      };
    };

    const upper = sampleFgRatio(px, py - halfH * 1.65, py - halfH * 0.2);
    const lower = sampleFgRatio(px, py + halfH * 0.2, py + halfH * 1.15);

    // Clicked near player's feet: foreground is mostly above click point
    const clickedFeet =
      (preferFootAnchor && lower.ratio < 0.22) ||
      (upper.ratio > 0.2 && lower.ratio < 0.14);

    let boxCx = normX;
    let boxCy = normY;

    if (clickedFeet) {
      boxCy = clamp(normY - safeH * 0.44, 0.01, 0.99);
      if (upper.ratio > 0.16) {
        const shiftX = clamp((upper.meanX - px) / w, -safeW * 0.35, safeW * 0.35);
        boxCx = clamp(normX + shiftX, 0.01, 0.99);
      }
      return {
        pos: {
          cx: boxCx,
          cy: boxCy,
          width: safeW,
          height: safeH,
          radius: Math.max(safeW * 0.5, safeH * 0.28),
          confidence: 1,
          status: 'anchored',
          time,
        },
        renderOffsetX: normX - boxCx,
        renderOffsetY: normY - boxCy,
      };
    }

    // Clicked on player torso: keep CV box centered on torso; Chain ring still drops to feet
    return {
      pos: {
        cx: boxCx,
        cy: boxCy,
        width: safeW,
        height: safeH,
        radius: Math.max(safeW * 0.5, safeH * 0.28),
        confidence: 1,
        status: 'anchored',
        time,
      },
      renderOffsetX: 0,
      renderOffsetY: preferFootAnchor ? safeH * 0.44 : 0,
    };
  }

  private searchPlayerPeaks(
    currFrame: FrameData,
    tpl: PlayerTemplate,
    predX: number,
    predY: number,
    sigmaX: number,
    sigmaY: number,
    isCrowded: boolean,
    isFastPan: boolean,
    panMag: number,
    settings: CvTrackerSettings
  ): { peaks: CandidatePeak[]; isAmbiguous: boolean } {
    const w = currFrame.width;
    const h = currFrame.height;
    const boundMinX = tpl.halfW + 1;
    const boundMaxX = w - tpl.halfW - 2;
    const boundMinY = tpl.halfH + 1;
    const boundMaxY = h - tpl.halfH - 2;

    const panSearchBoost = isFastPan ? Math.min(48, Math.round(panMag * 0.65 + 12)) : 0;
    const fullSearchPx = Math.max(
      16,
      Math.round((settings.searchRadiusPx * w) / 720) +
        panSearchBoost +
        Math.min(28, tpl.lostFrames * 4)
    );

    const canUseFastWindow = tpl.lostFrames === 0 && fullSearchPx > 26;
    const fastSearchPx = canUseFastWindow
      ? Math.min(
          fullSearchPx,
          Math.max(isCrowded ? 26 : 22, Math.round(Math.max(sigmaX, sigmaY) * 2.5 + (isCrowded ? 14 : 11)))
        )
      : fullSearchPx;

    const fullMinX = Math.max(boundMinX, Math.round(predX - fullSearchPx));
    const fullMaxX = Math.min(boundMaxX, Math.round(predX + fullSearchPx));
    const fullMinY = Math.max(boundMinY, Math.round(predY - fullSearchPx));
    const fullMaxY = Math.min(boundMaxY, Math.round(predY + fullSearchPx));

    const fastMinX = Math.max(boundMinX, Math.round(predX - fastSearchPx));
    const fastMaxX = Math.min(boundMaxX, Math.round(predX + fastSearchPx));
    const fastMinY = Math.max(boundMinY, Math.round(predY - fastSearchPx));
    const fastMaxY = Math.min(boundMaxY, Math.round(predY + fastSearchPx));

    // When crowded or panning fast, trust original anchor & relax motion gating so true matches aren't suppressed
    const refBias = isCrowded ? 0.78 : 0.6;
    const motionWeight = isFastPan || tpl.lostFrames > 0 ? 0.04 : isCrowded ? 0.18 : 0.14;
    const sigmaScale = isFastPan || tpl.lostFrames > 0 ? 2.2 : 1.0;
    // During fast pan motion blur, HSV color histograms stay stable while pixel-level ZNCC smears
    const znccShare = isFastPan ? 0.36 : 0.54;

    const stride = 3;
    const effSigmaX = sigmaX * sigmaScale;
    const effSigmaY = sigmaY * sigmaScale;
    const evaluated = this.scratchEvaluated;
    evaluated.clear();

    const getScoreAt = (gx: number, gy: number): number => {
      const cx = clamp(gx, boundMinX, boundMaxX);
      const cy = clamp(gy, boundMinY, boundMaxY);
      const key = cy * w + cx;
      let val = evaluated.get(key);
      if (val === undefined) {
        val = this.evaluateCandidate(
          currFrame,
          tpl,
          cx,
          cy,
          predX,
          predY,
          effSigmaX,
          effSigmaY,
          fullSearchPx,
          1,
          settings.turfMasking,
          refBias,
          motionWeight,
          znccShare
        );
        evaluated.set(key, val);
      }
      return val;
    };

    const pickAndRefinePeaks = (
      coarseCandidates: Array<{ x: number; y: number; score: number }>
    ): CandidatePeak[] => {
      coarseCandidates.sort((a, b) => b.score - a.score);

      const topCoarseScore = coarseCandidates[0]?.score ?? 0;
      const maxSeeds = isCrowded ? 3 : 2;

      // Pick spatially distinct coarse seeds separated relative to the player's rectangular box
      const distinctSeeds: Array<{ x: number; y: number; score: number }> = [];
      for (const cand of coarseCandidates) {
        if (distinctSeeds.length >= 2 && !isCrowded && cand.score < topCoarseScore - 0.12) {
          break;
        }
        let tooClose = false;
        for (const s of distinctSeeds) {
          const boxSep = Math.hypot(
            (cand.x - s.x) / Math.max(6, tpl.halfW),
            (cand.y - s.y) / Math.max(8, tpl.halfH)
          );
          if (boxSep < 0.78) {
            tooClose = true;
            break;
          }
        }
        if (!tooClose) {
          distinctSeeds.push(cand);
          if (distinctSeeds.length >= maxSeeds) break;
        }
      }

      if (distinctSeeds.length === 0) {
        distinctSeeds.push({
          x: clamp(Math.round(predX), boundMinX, boundMaxX),
          y: clamp(Math.round(predY), boundMinY, boundMaxY),
          score: 0,
        });
      }

      const refinedPeaks: CandidatePeak[] = [];

      for (const seed of distinctSeeds) {
        let bestScore = -Infinity;
        let bestX = seed.x;
        let bestY = seed.y;

        // 5x5 local fine search (covers stride=3 coarse grid spacing completely)
        for (let dy = -2; dy <= 2; dy++) {
          const cy = clamp(seed.y + dy, boundMinY, boundMaxY);
          for (let dx = -2; dx <= 2; dx++) {
            const cx = clamp(seed.x + dx, boundMinX, boundMaxX);
            const s = getScoreAt(cx, cy);
            if (s > bestScore) {
              bestScore = s;
              bestX = cx;
              bestY = cy;
            }
          }
        }

        // One 3x3 border hill-climb step if peak landed on the +-2 edge of 5x5
        if (Math.abs(bestX - seed.x) === 2 || Math.abs(bestY - seed.y) === 2) {
          const curX = bestX;
          const curY = bestY;
          for (let dy = -1; dy <= 1; dy++) {
            const cy = clamp(curY + dy, boundMinY, boundMaxY);
            for (let dx = -1; dx <= 1; dx++) {
              const cx = clamp(curX + dx, boundMinX, boundMaxX);
              const s = getScoreAt(cx, cy);
              if (s > bestScore) {
                bestScore = s;
                bestX = cx;
                bestY = cy;
              }
            }
          }
        }

        // Parabolic sub-pixel interpolation
        const sLeft = getScoreAt(bestX - 1, bestY);
        const sRight = getScoreAt(bestX + 1, bestY);
        const sUp = getScoreAt(bestX, bestY - 1);
        const sDown = getScoreAt(bestX, bestY + 1);

        const denomX = 2 * (sLeft - 2 * bestScore + sRight);
        const subDx = denomX < -1e-5 ? clamp((sLeft - sRight) / denomX, -0.5, 0.5) : 0;

        const denomY = 2 * (sUp - 2 * bestScore + sDown);
        const subDy = denomY < -1e-5 ? clamp((sUp - sDown) / denomY, -0.5, 0.5) : 0;

        const fx = clamp(bestX + subDx, boundMinX, boundMaxX);
        const fy = clamp(bestY + subDy, boundMinY, boundMaxY);

        // Deduplicate if two seeds converged onto the same physical player box
        const existing = refinedPeaks.find(
          (p) =>
            Math.hypot(
              (p.x - fx) / Math.max(6, tpl.halfW),
              (p.y - fy) / Math.max(8, tpl.halfH)
            ) < 0.62
        );
        const conf = clamp((bestScore - 0.14) / 0.78, 0, 1);

        if (existing) {
          if (bestScore > existing.score) {
            existing.x = fx;
            existing.y = fy;
            existing.score = bestScore;
            existing.confidence = conf;
          }
        } else {
          refinedPeaks.push({ x: fx, y: fy, score: bestScore, confidence: conf });
        }
      }

      refinedPeaks.sort((a, b) => b.score - a.score);
      return refinedPeaks;
    };

    // Stage 1A: Fast Kalman-centered coarse grid search (circular radius pruning)
    const fastRadSq = (fastSearchPx + 2) * (fastSearchPx + 2);
    const coarseCandidates: Array<{ x: number; y: number; score: number }> = [];
    for (let cy = fastMinY; cy <= fastMaxY; cy += stride) {
      const dy = cy - predY;
      const dySq = dy * dy;
      if (dySq > fastRadSq) continue;
      for (let cx = fastMinX; cx <= fastMaxX; cx += stride) {
        const dx = cx - predX;
        if (dx * dx + dySq > fastRadSq) continue;
        const score = this.evaluateCandidate(
          currFrame,
          tpl,
          cx,
          cy,
          predX,
          predY,
          effSigmaX,
          effSigmaY,
          fullSearchPx,
          2,
          settings.turfMasking,
          refBias,
          motionWeight,
          znccShare
        );
        coarseCandidates.push({ x: cx, y: cy, score });
      }
    }

    let refinedPeaks = pickAndRefinePeaks(coarseCandidates);

    // Stage 1B: Zero-loss fallback — if fast window was smaller than full window and lock is
    // borderline, sits near the fast window boundary, or crowded player lacks runner-up peaks, expand
    if (
      canUseFastWindow &&
      (fastMinX > fullMinX || fastMaxX < fullMaxX || fastMinY > fullMinY || fastMaxY < fullMaxY)
    ) {
      const top = refinedPeaks[0];
      const strongConf = Math.max(0.62, settings.confidenceThreshold + 0.14);
      const nearInnerEdge =
        top &&
        ((fastMinX > fullMinX && top.x <= fastMinX + stride) ||
          (fastMaxX < fullMaxX && top.x >= fastMaxX - stride) ||
          (fastMinY > fullMinY && top.y <= fastMinY + stride) ||
          (fastMaxY < fullMaxY && top.y >= fastMaxY - stride));
      const needsCrowdedExpand = isCrowded && refinedPeaks.length < 2;

      if (!top || top.confidence < strongConf || nearInnerEdge || needsCrowdedExpand) {
        const fullRadSq = (fullSearchPx + 2) * (fullSearchPx + 2);
        for (let cy = fullMinY; cy <= fullMaxY; cy += stride) {
          const dy = cy - predY;
          const dySq = dy * dy;
          if (dySq > fullRadSq) continue;
          const yInInner = cy >= fastMinY && cy <= fastMaxY;
          for (let cx = fullMinX; cx <= fullMaxX; cx += stride) {
            if (yInInner && cx >= fastMinX && cx <= fastMaxX) continue;
            const dx = cx - predX;
            if (dx * dx + dySq > fullRadSq) continue;
            const score = this.evaluateCandidate(
              currFrame,
              tpl,
              cx,
              cy,
              predX,
              predY,
              effSigmaX,
              effSigmaY,
              fullSearchPx,
              2,
              settings.turfMasking,
              refBias,
              motionWeight,
              znccShare
            );
            coarseCandidates.push({ x: cx, y: cy, score });
          }
        }
        refinedPeaks = pickAndRefinePeaks(coarseCandidates);
      }
    }

    const isAmbiguous =
      refinedPeaks.length >= 2 &&
      refinedPeaks[1].confidence > settings.confidenceThreshold &&
      refinedPeaks[0].score - refinedPeaks[1].score < 0.065;

    return { peaks: refinedPeaks, isAmbiguous };
  }

  private evaluateCandidate(
    frame: FrameData,
    tpl: PlayerTemplate,
    cx: number,
    cy: number,
    predX: number,
    predY: number,
    sigmaX: number,
    sigmaY: number,
    searchRadius: number,
    patchStep: number,
    useTurfMask: boolean,
    refBias: number,
    motionWeight: number,
    znccShare: number
  ): number {
    const stats = patchStep === 2 ? tpl.stats2 : tpl.stats1;
    if (stats.invW === 0) return -1;

    const w = frame.width;
    const {
      halfW,
      halfH,
      patchW,
      patchH,
      refLuma,
      refCb,
      refCr,
      adaptLuma,
      adaptCb,
      adaptCr,
      refWeights,
    } = tpl;
    const { luma, cb, cr, hsvBin } = frame;

    let sumCL = 0;
    let sumCCL = 0;
    let sumCRL = 0;
    let sumCAL = 0;

    let sumCCb = 0;
    let sumCCCb = 0;
    let sumCRCb = 0;
    let sumCACb = 0;

    let sumCCr = 0;
    let sumCCCr = 0;
    let sumCRCr = 0;
    let sumCACr = 0;

    const candHistUpper = this.scratchCandHistUpper;
    const candHistLower = this.scratchCandHistLower;
    candHistUpper.fill(0);
    candHistLower.fill(0);
    let histUpperSum = 0;
    let histLowerSum = 0;

    const startX = Math.round(cx) - halfW;
    const startY = Math.round(cy) - halfH;
    const splitY = halfH; // Upper half = head/jersey, lower half = shorts/socks
    const maskTurf = useTurfMask && frame.hasTurf;

    for (let py = 0; py < patchH; py += patchStep) {
      const fy = startY + py;
      const rowOffset = fy * w;
      const patchRowOffset = py * patchW;
      const isUpper = py <= splitY;

      for (let px = 0; px < patchW; px += patchStep) {
        const pidx = patchRowOffset + px;
        const wgt = refWeights[pidx];
        if (wgt <= 0.01) continue;

        const idx = rowOffset + startX + px;
        const cL = luma[idx];
        const wcL = wgt * cL;
        sumCL += wcL;
        sumCCL += wcL * cL;
        sumCRL += wcL * refLuma[pidx];
        sumCAL += wcL * adaptLuma[pidx];

        const cCb = cb[idx];
        const wcCb = wgt * cCb;
        sumCCb += wcCb;
        sumCCCb += wcCb * cCb;
        sumCRCb += wcCb * refCb[pidx];
        sumCACb += wcCb * adaptCb[pidx];

        const cCr = cr[idx];
        const wcCr = wgt * cCr;
        sumCCr += wcCr;
        sumCCCr += wcCr * cCr;
        sumCRCr += wcCr * refCr[pidx];
        sumCACr += wcCr * adaptCr[pidx];

        // Accumulate foreground-weighted 2-band HSV color histograms using pre-encoded turf bit
        const rawBin = hsvBin[idx];
        const fgWeight = maskTurf && (rawBin & 0x80) !== 0 ? wgt * 0.14 : wgt;
        const bin = rawBin & 0x7f;
        if (isUpper) {
          candHistUpper[bin] += fgWeight;
          histUpperSum += fgWeight;
        } else {
          candHistLower[bin] += fgWeight;
          histLowerSum += fgWeight;
        }
      }
    }

    const invW = stats.invW;
    const adaptBias = 1 - refBias;

    const meanCL = sumCL * invW;
    const invStdCL = 1 / Math.sqrt(Math.max(1e-4, sumCCL * invW - meanCL * meanCL));
    const znccLumaRef = clamp(
      (sumCRL * invW - meanCL * stats.meanRefL) * invStdCL * stats.invStdRefL,
      -1,
      1
    );
    const znccLumaAdapt = clamp(
      (sumCAL * invW - meanCL * stats.meanAdaptL) * invStdCL * stats.invStdAdaptL,
      -1,
      1
    );
    const znccLuma = (refBias * znccLumaRef + adaptBias * znccLumaAdapt + 1) * 0.5;

    const meanCCb = sumCCb * invW;
    const invStdCCb = 1 / Math.sqrt(Math.max(1e-4, sumCCCb * invW - meanCCb * meanCCb));
    const znccCbRef = clamp(
      (sumCRCb * invW - meanCCb * stats.meanRefCb) * invStdCCb * stats.invStdRefCb,
      -1,
      1
    );
    const znccCbAdapt = clamp(
      (sumCACb * invW - meanCCb * stats.meanAdaptCb) * invStdCCb * stats.invStdAdaptCb,
      -1,
      1
    );

    const meanCCr = sumCCr * invW;
    const invStdCCr = 1 / Math.sqrt(Math.max(1e-4, sumCCCr * invW - meanCCr * meanCCr));
    const znccCrRef = clamp(
      (sumCRCr * invW - meanCCr * stats.meanRefCr) * invStdCCr * stats.invStdRefCr,
      -1,
      1
    );
    const znccCrAdapt = clamp(
      (sumCACr * invW - meanCCr * stats.meanAdaptCr) * invStdCCr * stats.invStdAdaptCr,
      -1,
      1
    );

    const znccChroma =
      (0.5 * (refBias * znccCbRef + adaptBias * znccCbAdapt) +
        0.5 * (refBias * znccCrRef + adaptBias * znccCrAdapt) +
        1) *
      0.5;

    const znccScore = 0.62 * znccLuma + 0.38 * znccChroma;

    // 2-Band Bhattacharyya color histogram similarity over sparse active bins only
    let bhattUpperRef = 0;
    let bhattUpperAdapt = 0;
    if (histUpperSum > 1e-4) {
      const invSqrtU = 1 / Math.sqrt(histUpperSum);
      const activeU = tpl.activeUpperBins;
      const countU = tpl.activeUpperCount;
      const sqrtRefU = tpl.sqrtRefHistUpper;
      const sqrtAdaptU = tpl.sqrtAdaptHistUpper;
      for (let k = 0; k < countU; k++) {
        const b = activeU[k];
        const cVal = candHistUpper[b];
        if (cVal > 0) {
          const sc = Math.sqrt(cVal);
          bhattUpperRef += sc * sqrtRefU[b];
          bhattUpperAdapt += sc * sqrtAdaptU[b];
        }
      }
      bhattUpperRef *= invSqrtU;
      bhattUpperAdapt *= invSqrtU;
    }

    let bhattLowerRef = 0;
    let bhattLowerAdapt = 0;
    if (histLowerSum > 1e-4) {
      const invSqrtL = 1 / Math.sqrt(histLowerSum);
      const activeL = tpl.activeLowerBins;
      const countL = tpl.activeLowerCount;
      const sqrtRefL = tpl.sqrtRefHistLower;
      const sqrtAdaptL = tpl.sqrtAdaptHistLower;
      for (let k = 0; k < countL; k++) {
        const b = activeL[k];
        const cVal = candHistLower[b];
        if (cVal > 0) {
          const sc = Math.sqrt(cVal);
          bhattLowerRef += sc * sqrtRefL[b];
          bhattLowerAdapt += sc * sqrtAdaptL[b];
        }
      }
      bhattLowerRef *= invSqrtL;
      bhattLowerAdapt *= invSqrtL;
    }

    const upperScore = refBias * bhattUpperRef + adaptBias * bhattUpperAdapt;
    const lowerScore = refBias * bhattLowerRef + adaptBias * bhattLowerAdapt;
    const histScore = 0.56 * upperScore + 0.44 * lowerScore;

    // Kalman Mahalanobis + spatial continuity prior around predicted location
    const dx = cx - predX;
    const dy = cy - predY;
    const effSigmaX = Math.max(8, Math.min(searchRadius * 0.75, sigmaX));
    const effSigmaY = Math.max(8, Math.min(searchRadius * 0.75, sigmaY));
    const mahalSq = (dx * dx) / (effSigmaX * effSigmaX) + (dy * dy) / (effSigmaY * effSigmaY);
    const motionPrior = Math.exp(-mahalSq * 0.32);

    const appWeight = 1 - motionWeight;
    return (
      appWeight * (znccShare * znccScore + (1 - znccShare) * histScore) +
      motionWeight * motionPrior
    );
  }

  private samplePatch(
    frame: FrameData,
    cx: number,
    cy: number,
    halfW: number,
    halfH: number,
    useTurfMask: boolean,
    outLuma: Float32Array,
    outCb: Float32Array,
    outCr: Float32Array,
    outWeights: Float32Array,
    outHistUpper: Float32Array,
    outHistLower: Float32Array
  ): void {
    const w = frame.width;
    const h = frame.height;
    const patchW = halfW * 2 + 1;
    const patchH = halfH * 2 + 1;

    let histUpperSum = 0;
    let histLowerSum = 0;
    const startX = Math.round(cx) - halfW;
    const startY = Math.round(cy) - halfH;
    const splitY = halfH;

    for (let py = 0; py < patchH; py++) {
      const fy = clamp(startY + py, 0, h - 1);
      const dyNorm = (py - halfH) / Math.max(1, halfH);
      const isUpper = py <= splitY;

      for (let px = 0; px < patchW; px++) {
        const fx = clamp(startX + px, 0, w - 1);
        const dxNorm = (px - halfW) / Math.max(1, halfW);
        const ax = Math.abs(dxNorm);
        const ay = Math.abs(dyNorm);

        // Separable rectangular window preserves head/shoulders/socks corners while mildly tapering outermost border
        const wx = ax <= 0.65 ? 1.0 : 1.0 - ((ax - 0.65) / 0.35) * 0.55;
        const wy = ay <= 0.65 ? 1.0 : 1.0 - ((ay - 0.65) / 0.35) * 0.55;
        const rectWeight = wx * wy;

        const idx = fy * w + fx;
        const rawBin = frame.hsvBin[idx];
        const turfFactor =
          useTurfMask && frame.hasTurf && (rawBin & 0x80) !== 0 ? 0.16 : 1.0;

        const pidx = py * patchW + px;
        outLuma[pidx] = frame.luma[idx];
        outCb[pidx] = frame.cb[idx];
        outCr[pidx] = frame.cr[idx];
        const hw = rectWeight * turfFactor;
        outWeights[pidx] = hw;

        const bin = rawBin & 0x7f;
        if (isUpper) {
          outHistUpper[bin] += hw;
          histUpperSum += hw;
        } else {
          outHistLower[bin] += hw;
          histLowerSum += hw;
        }
      }
    }

    if (histUpperSum > 1e-4) {
      const invU = 1 / histUpperSum;
      for (let i = 0; i < HIST_SIZE; i++) {
        outHistUpper[i] *= invU;
      }
    }
    if (histLowerSum > 1e-4) {
      const invL = 1 / histLowerSum;
      for (let i = 0; i < HIST_SIZE; i++) {
        outHistLower[i] *= invL;
      }
    }
  }

  private adaptTemplate(
    frame: FrameData,
    tpl: PlayerTemplate,
    cx: number,
    cy: number,
    alpha: number,
    useTurfMask: boolean
  ): void {
    const len = tpl.patchW * tpl.patchH;
    if (this.scratchAdaptLuma.length < len) {
      this.scratchAdaptLuma = new Float32Array(len);
      this.scratchAdaptCb = new Float32Array(len);
      this.scratchAdaptCr = new Float32Array(len);
      this.scratchAdaptWeights = new Float32Array(len);
    }
    const curLuma = this.scratchAdaptLuma;
    const curCb = this.scratchAdaptCb;
    const curCr = this.scratchAdaptCr;
    const tmpW = this.scratchAdaptWeights;
    const curHistUpper = this.scratchAdaptHistUpper;
    const curHistLower = this.scratchAdaptHistLower;
    curHistUpper.fill(0);
    curHistLower.fill(0);

    this.samplePatch(
      frame,
      cx,
      cy,
      tpl.halfW,
      tpl.halfH,
      useTurfMask,
      curLuma,
      curCb,
      curCr,
      tmpW,
      curHistUpper,
      curHistLower
    );

    const keep = 1 - alpha;
    for (let i = 0; i < len; i++) {
      tpl.adaptLuma[i] = tpl.adaptLuma[i] * keep + curLuma[i] * alpha;
      tpl.adaptCb[i] = tpl.adaptCb[i] * keep + curCb[i] * alpha;
      tpl.adaptCr[i] = tpl.adaptCr[i] * keep + curCr[i] * alpha;
    }
    for (let b = 0; b < HIST_SIZE; b++) {
      tpl.adaptHistUpper[b] = tpl.adaptHistUpper[b] * keep + curHistUpper[b] * alpha;
      tpl.adaptHistLower[b] = tpl.adaptHistLower[b] * keep + curHistLower[b] * alpha;
    }
    computeTemplateStepStats(tpl, 1, tpl.stats1, true);
    computeTemplateStepStats(tpl, 2, tpl.stats2, true);
    syncTemplateAdaptCache(tpl, true);
  }
}

/**
 * Jointly assigns one peak per player so two trackers don't collapse onto the same player
 * when teammates or opponents pass close by.
 */
function solveJointAssignment(candidateSets: PlayerCandidateSet[]): CandidatePeak[] {
  const n = candidateSets.length;
  const maxChoices = n <= 6 ? 3 : 2;
  const chosen: CandidatePeak[] = candidateSets.map((cs) => cs.peaks[0]);

  if (n <= 7) {
    let bestTotal = -Infinity;
    const currentIdx = new Array<number>(n).fill(0);
    const bestIdx = new Array<number>(n).fill(0);

    const dfs = (idx: number, accScore: number) => {
      if (idx === n) {
        if (accScore > bestTotal) {
          bestTotal = accScore;
          for (let k = 0; k < n; k++) bestIdx[k] = currentIdx[k];
        }
        return;
      }

      const cs = candidateSets[idx];
      const limit = Math.min(maxChoices, cs.peaks.length);

      for (let c = 0; c < limit; c++) {
        const peak = cs.peaks[c];
        let penalty = 0;

        for (let prev = 0; prev < idx; prev++) {
          const prevCs = candidateSets[prev];
          const prevPeak = prevCs.peaks[currentIdx[prev]];
          const normDist = boxNormalizedDist(
            peak.x,
            peak.y,
            cs.halfW,
            cs.halfH,
            prevPeak.x,
            prevPeak.y,
            prevCs.halfW,
            prevCs.halfH
          );
          if (normDist < 0.85) {
            const overlapRatio = 1 - normDist / 0.85;
            penalty += 0.32 * overlapRatio;
          }
        }

        currentIdx[idx] = c;
        dfs(idx + 1, accScore + peak.score - penalty);
      }
    };

    dfs(0, 0);
    for (let i = 0; i < n; i++) {
      chosen[i] = candidateSets[i].peaks[bestIdx[i]];
    }
    return chosen;
  }

  // Greedy conflict-resolving fallback for larger player counts
  const order = candidateSets
    .map((cs, i) => ({ i, topScore: cs.peaks[0]?.score ?? 0 }))
    .sort((a, b) => b.topScore - a.topScore);

  const assigned: Array<{ peak: CandidatePeak; halfW: number; halfH: number }> = [];
  for (const { i } of order) {
    const cs = candidateSets[i];
    let bestPeak = cs.peaks[0];
    let bestObj = -Infinity;

    for (const peak of cs.peaks) {
      let penalty = 0;
      for (const other of assigned) {
        const normDist = boxNormalizedDist(
          peak.x,
          peak.y,
          cs.halfW,
          cs.halfH,
          other.peak.x,
          other.peak.y,
          other.halfW,
          other.halfH
        );
        if (normDist < 0.85) {
          penalty += 0.32 * (1 - normDist / 0.85);
        }
      }
      const obj = peak.score - penalty;
      if (obj > bestObj) {
        bestObj = obj;
        bestPeak = peak;
      }
    }

    chosen[i] = bestPeak;
    assigned.push({ peak: bestPeak, halfW: cs.halfW, halfH: cs.halfH });
  }

  return chosen;
}

function boxNormalizedDist(
  ax: number,
  ay: number,
  ahw: number,
  ahh: number,
  bx: number,
  by: number,
  bhw: number,
  bhh: number
): number {
  const dx = (ax - bx) / Math.max(6, ahw + bhw);
  const dy = (ay - by) / Math.max(8, ahh + bhh);
  return Math.hypot(dx, dy);
}

function createKalmanAxis(pos: number): KalmanAxis {
  return {
    x: pos,
    v: 0,
    p00: 16,
    p01: 0,
    p11: 12,
  };
}

function predictKalmanAxis(
  k: KalmanAxis,
  camShift: number,
  minPos: number,
  maxPos: number,
  extraUncertainty = 0
): { pos: number; sigma: number } {
  // Apply camera pan directly to position state
  k.x = clamp(k.x + camShift + k.v, minPos, maxPos);

  // P = F * P * F^T + Q  (F = [[1, 1], [0, 1]])
  const qPos = 0.45 + extraUncertainty;
  const qVel = 0.28 + (extraUncertainty > 0 ? 0.35 : 0);
  const p00 = k.p00 + 2 * k.p01 + k.p11 + qPos;
  const p01 = k.p01 + k.p11;
  const p11 = k.p11 + qVel;

  k.p00 = p00;
  k.p01 = p01;
  k.p11 = p11;

  return {
    pos: k.x,
    sigma: Math.sqrt(Math.max(4, p00)),
  };
}

function updateKalmanAxis(
  k: KalmanAxis,
  meas: number,
  confidence: number,
  smoothing: number,
  isolatePanShock = false
): void {
  const innov = meas - k.x;
  const absInnov = Math.abs(innov);

  // Speed/innovation-adaptive measurement noise (One-Euro style):
  // Since k.x already incorporates camera shift + predicted player velocity,
  // sub-1.6px innovation is primarily pixel/limb-swing noise, while >= 2.5px is true acceleration/cutting.
  let rMeas: number;
  if (smoothing <= 0.01) {
    rMeas = 0.25;
  } else {
    const baseQuietR = 3.2 + smoothing * 12.5;
    const baseFastR = 0.95 + (1 - confidence) * 3.2;
    const motionBlend = clamp((absInnov - 1.55) / 2.8, 0, 1);
    const confPenalty = confidence > 0.72 ? 1.0 : 1.85;
    rMeas = (baseQuietR * (1 - motionBlend) + baseFastR * motionBlend) * confPenalty;
  }

  const s = k.p00 + rMeas;
  const k0 = k.p00 / s;
  // Dampen velocity injection on sub-pixel noise and camera-pan shocks
  const velNoiseDamp = smoothing > 0.01 && absInnov < 1.3 ? 0.45 : 1.0;
  const k1 = (isolatePanShock ? (k.p01 / s) * 0.2 : k.p01 / s) * velNoiseDamp;

  k.x += k0 * innov;
  k.v = clamp(k.v + k1 * innov, -26, 26);

  const p00 = (1 - k0) * k.p00;
  const p01 = (1 - k0) * k.p01;
  const p11 = Math.max(0.5, k.p11 - k1 * k.p01);

  k.p00 = p00;
  k.p01 = p01;
  k.p11 = p11;
}

function blockContrast(
  luma: Float32Array,
  w: number,
  ax: number,
  ay: number,
  half: number
): number {
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let py = -half; py <= half; py += 2) {
    const row = (ay + py) * w;
    for (let px = -half; px <= half; px += 2) {
      const v = luma[row + ax + px];
      sum += v;
      sumSq += v * v;
      count++;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return Math.sqrt(Math.max(0, sumSq / count - mean * mean));
}

function createEmptyPatchStats(): PatchStepStats {
  return {
    invW: 0,
    meanRefL: 0,
    invStdRefL: 0,
    meanRefCb: 0,
    invStdRefCb: 0,
    meanRefCr: 0,
    invStdRefCr: 0,
    meanAdaptL: 0,
    invStdAdaptL: 0,
    meanAdaptCb: 0,
    invStdAdaptCb: 0,
    meanAdaptCr: 0,
    invStdAdaptCr: 0,
  };
}

function computeTemplateStepStats(
  tpl: PlayerTemplate,
  patchStep: number,
  out: PatchStepStats,
  adaptOnly = false
): void {
  const { patchW, patchH, refWeights, refLuma, refCb, refCr, adaptLuma, adaptCb, adaptCr } = tpl;
  let sumW = 0;
  let sumRL = 0;
  let sumRRL = 0;
  let sumRCb = 0;
  let sumRRCb = 0;
  let sumRCr = 0;
  let sumRRCr = 0;
  let sumAL = 0;
  let sumAAL = 0;
  let sumACb = 0;
  let sumAACb = 0;
  let sumACr = 0;
  let sumAACr = 0;

  for (let py = 0; py < patchH; py += patchStep) {
    const rowOff = py * patchW;
    for (let px = 0; px < patchW; px += patchStep) {
      const pidx = rowOff + px;
      const wgt = refWeights[pidx];
      if (wgt <= 0.01) continue;
      sumW += wgt;
      if (!adaptOnly) {
        const rL = refLuma[pidx];
        const rCb = refCb[pidx];
        const rCr = refCr[pidx];
        sumRL += wgt * rL;
        sumRRL += wgt * rL * rL;
        sumRCb += wgt * rCb;
        sumRRCb += wgt * rCb * rCb;
        sumRCr += wgt * rCr;
        sumRRCr += wgt * rCr * rCr;
      }
      const aL = adaptLuma[pidx];
      const aCb = adaptCb[pidx];
      const aCr = adaptCr[pidx];
      sumAL += wgt * aL;
      sumAAL += wgt * aL * aL;
      sumACb += wgt * aCb;
      sumAACb += wgt * aCb * aCb;
      sumACr += wgt * aCr;
      sumAACr += wgt * aCr * aCr;
    }
  }

  if (sumW < 1e-4) {
    out.invW = 0;
    return;
  }
  const invW = 1 / sumW;
  out.invW = invW;

  if (!adaptOnly) {
    out.meanRefL = sumRL * invW;
    out.invStdRefL = 1 / Math.sqrt(Math.max(1e-4, sumRRL * invW - out.meanRefL * out.meanRefL));
    out.meanRefCb = sumRCb * invW;
    out.invStdRefCb = 1 / Math.sqrt(Math.max(1e-4, sumRRCb * invW - out.meanRefCb * out.meanRefCb));
    out.meanRefCr = sumRCr * invW;
    out.invStdRefCr = 1 / Math.sqrt(Math.max(1e-4, sumRRCr * invW - out.meanRefCr * out.meanRefCr));
  }

  out.meanAdaptL = sumAL * invW;
  out.invStdAdaptL = 1 / Math.sqrt(Math.max(1e-4, sumAAL * invW - out.meanAdaptL * out.meanAdaptL));
  out.meanAdaptCb = sumACb * invW;
  out.invStdAdaptCb = 1 / Math.sqrt(Math.max(1e-4, sumAACb * invW - out.meanAdaptCb * out.meanAdaptCb));
  out.meanAdaptCr = sumACr * invW;
  out.invStdAdaptCr = 1 / Math.sqrt(Math.max(1e-4, sumAACr * invW - out.meanAdaptCr * out.meanAdaptCr));
}

function syncTemplateAdaptCache(tpl: PlayerTemplate, recomputeSqrt = true): void {
  let uCount = 0;
  let lCount = 0;
  for (let b = 0; b < HIST_SIZE; b++) {
    const aU = tpl.adaptHistUpper[b];
    if (recomputeSqrt) {
      tpl.sqrtAdaptHistUpper[b] = aU > 0 ? Math.sqrt(aU) : 0;
    } else {
      tpl.sqrtAdaptHistUpper[b] = tpl.sqrtRefHistUpper[b];
    }
    if (tpl.refHistUpper[b] > 0 || aU > 0) {
      tpl.activeUpperBins[uCount++] = b;
    }

    const aL = tpl.adaptHistLower[b];
    if (recomputeSqrt) {
      tpl.sqrtAdaptHistLower[b] = aL > 0 ? Math.sqrt(aL) : 0;
    } else {
      tpl.sqrtAdaptHistLower[b] = tpl.sqrtRefHistLower[b];
    }
    if (tpl.refHistLower[b] > 0 || aL > 0) {
      tpl.activeLowerBins[lCount++] = b;
    }
  }
  tpl.activeUpperCount = uCount;
  tpl.activeLowerCount = lCount;
}

let cachedHsvBinLut: Uint8Array | null = null;

function getHsvBinLut(): Uint8Array {
  if (cachedHsvBinLut) return cachedHsvBinLut;
  const lut = new Uint8Array(64 * 64 * 64);
  for (let r6 = 0; r6 < 64; r6++) {
    const r = (r6 << 2) | 2;
    for (let g6 = 0; g6 < 64; g6++) {
      const g = (g6 << 2) | 2;
      const base = (r6 << 12) | (g6 << 6);
      for (let b6 = 0; b6 < 64; b6++) {
        lut[base | b6] = quantizeHsvBin(r, g, (b6 << 2) | 2);
      }
    }
  }
  cachedHsvBinLut = lut;
  return lut;
}

function isTurfPixel(r: number, g: number, b: number, frame: FrameData): boolean {
  if (g > r + 10 && g > b + 8 && g > 40) {
    const dist =
      Math.abs(r - frame.turfR) +
      Math.abs(g - frame.turfG) +
      Math.abs(b - frame.turfB);
    return dist < 95;
  }
  return false;
}

function quantizeHsvBin(r: number, g: number, b: number): number {
  const max = r > g ? (r > b ? r : b) : g > b ? g : b;
  const min = r < g ? (r < b ? r : b) : g < b ? g : b;
  const delta = max - min;

  // Value in [0..255]
  const vBin = max < 85 ? 0 : max < 170 ? 1 : 2;

  // Saturation in [0..1]
  const sat = max === 0 ? 0 : delta / max;
  const sBin = sat < 0.2 ? 0 : sat < 0.45 ? 1 : sat < 0.72 ? 2 : 3;

  // Hue in [0..6)
  let h = 0;
  if (delta > 0) {
    if (max === r) {
      h = ((g - b) / delta) % 6;
      if (h < 0) h += 6;
    } else if (max === g) {
      h = (b - r) / delta + 2;
    } else {
      h = (r - g) / delta + 4;
    }
  }
  const hBin = Math.min(H_BINS - 1, Math.floor((h / 6) * H_BINS));

  return (hBin * S_BINS + sBin) * V_BINS + vBin;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
