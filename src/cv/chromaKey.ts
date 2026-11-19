import { DEFAULT_PITCH_GREEN, type ChromaKeySettings } from '../types/tracking';

const BG_MAX_WIDTH = 1280;
const CHROMA_MAX_WIDTH = 800;

export interface ChromaKeyResult {
  bgCanvas: HTMLCanvasElement;
  fgCanvas: HTMLCanvasElement;
  maskCanvas: HTMLCanvasElement;
  width: number;
  height: number;
}

export interface SampledColor {
  hex: string;
  r: number;
  g: number;
  b: number;
}

export class ChromaKeyEngine {
  private bgCanvas: HTMLCanvasElement;
  private bgCtx: CanvasRenderingContext2D;
  private sourceCanvas: HTMLCanvasElement;
  private sourceCtx: CanvasRenderingContext2D;
  private fgCanvas: HTMLCanvasElement;
  private fgCtx: CanvasRenderingContext2D;
  private maskCanvas: HTMLCanvasElement;
  private maskCtx: CanvasRenderingContext2D;

  private sourceImgData: ImageData | null = null;
  private fgImgData: ImageData | null = null;
  private maskImgData: ImageData | null = null;

  private lastSourceSig = '';
  private lastProcessSig = '';
  private lastBgWidth = 0;
  private lastBgHeight = 0;
  private lastWidth = 0;
  private lastHeight = 0;

  constructor() {
    this.bgCanvas = document.createElement('canvas');
    this.sourceCanvas = document.createElement('canvas');
    this.fgCanvas = document.createElement('canvas');
    this.maskCanvas = document.createElement('canvas');

    const bCtx = this.bgCanvas.getContext('2d');
    const sCtx = this.sourceCanvas.getContext('2d', { willReadFrequently: true });
    const fCtx = this.fgCanvas.getContext('2d');
    const mCtx = this.maskCanvas.getContext('2d');

    if (!bCtx || !sCtx || !fCtx || !mCtx) {
      throw new Error('Unable to initialize 2D canvas contexts for chroma keying.');
    }

    this.bgCtx = bCtx;
    this.sourceCtx = sCtx;
    this.fgCtx = fCtx;
    this.maskCtx = mCtx;
  }

  public reset(): void {
    this.lastSourceSig = '';
    this.lastProcessSig = '';
    this.sourceImgData = null;
  }

  private ensureSourceFrame(video: HTMLVideoElement, frameSeq: number, skipBgCanvas = false): boolean {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || video.readyState < 2) return false;

    const bgScale = Math.min(1, BG_MAX_WIDTH / vw);
    const bgWidth = Math.max(64, Math.round(vw * bgScale));
    const bgHeight = Math.max(64, Math.round(vh * bgScale));

    const keyScale = Math.min(1, CHROMA_MAX_WIDTH / vw);
    const width = Math.max(64, Math.round(vw * keyScale));
    const height = Math.max(64, Math.round(vh * keyScale));

    const timeOrSeq = frameSeq > 0 ? `seq:${frameSeq}` : `t:${video.currentTime.toFixed(4)}`;
    const sig = `${video.currentSrc}|${timeOrSeq}|${width}x${height}|${skipBgCanvas ? 's' : 'f'}`;

    if (sig === this.lastSourceSig && this.sourceImgData) {
      return true;
    }

    if (!skipBgCanvas && (this.lastBgWidth !== bgWidth || this.lastBgHeight !== bgHeight)) {
      this.bgCanvas.width = bgWidth;
      this.bgCanvas.height = bgHeight;
      this.lastBgWidth = bgWidth;
      this.lastBgHeight = bgHeight;
    }

    if (this.lastWidth !== width || this.lastHeight !== height) {
      this.sourceCanvas.width = width;
      this.sourceCanvas.height = height;
      this.fgCanvas.width = width;
      this.fgCanvas.height = height;
      this.maskCanvas.width = width;
      this.maskCanvas.height = height;
      this.fgImgData = this.fgCtx.createImageData(width, height);
      this.maskImgData = this.maskCtx.createImageData(width, height);
      this.lastWidth = width;
      this.lastHeight = height;
    }

    try {
      if (skipBgCanvas) {
        this.sourceCtx.drawImage(video, 0, 0, width, height);
      } else {
        // Capture crisp Layer 1 video snapshot once, then derive Layer 3 matte from that exact snapshot
        this.bgCtx.drawImage(video, 0, 0, bgWidth, bgHeight);
        this.sourceCtx.drawImage(this.bgCanvas, 0, 0, width, height);
      }
      this.sourceImgData = this.sourceCtx.getImageData(0, 0, width, height);
      this.lastSourceSig = sig;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Samples an averaged 5x5 pitch color around the normalized video coordinates [0..1].
   */
  public samplePitchColorAt(
    video: HTMLVideoElement,
    normX: number,
    normY: number,
    frameSeq = 0
  ): SampledColor | null {
    if (!this.ensureSourceFrame(video, frameSeq, true) || !this.sourceImgData) return null;

    const w = this.lastWidth;
    const h = this.lastHeight;
    const data = this.sourceImgData.data;

    const cx = Math.max(0, Math.min(w - 1, Math.round(normX * (w - 1))));
    const cy = Math.max(0, Math.min(h - 1, Math.round(normY * (h - 1))));

    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let count = 0;

    for (let dy = -2; dy <= 2; dy++) {
      const py = cy + dy;
      if (py < 0 || py >= h) continue;
      const rowOffset = py * w;
      for (let dx = -2; dx <= 2; dx++) {
        const px = cx + dx;
        if (px < 0 || px >= w) continue;
        const idx = (rowOffset + px) * 4;
        sumR += data[idx];
        sumG += data[idx + 1];
        sumB += data[idx + 2];
        count++;
      }
    }

    if (count === 0) return null;
    const r = Math.round(sumR / count);
    const g = Math.round(sumG / count);
    const b = Math.round(sumB / count);
    return {
      hex: rgbToHex(r, g, b),
      r,
      g,
      b,
    };
  }

  /**
   * Computes the atomic video background frame (bgCanvas), chroma-keyed foreground player layer (fgCanvas),
   * and/or the inspection mask layer highlighting the keyed pitch portion across all sampled pitch colors.
   */
  public processFrame(
    video: HTMLVideoElement,
    settings: ChromaKeySettings,
    frameSeq = 0
  ): ChromaKeyResult | null {
    const needFg = true;
    const needMask = settings.showMask;

    if (!this.ensureSourceFrame(video, frameSeq) || !this.sourceImgData || !this.fgImgData || !this.maskImgData) {
      return null;
    }

    const palette = settings.keyColors.length > 0 ? settings.keyColors : [DEFAULT_PITCH_GREEN];
    const paletteKey = palette.join(',');
    const processSig = `${this.lastSourceSig}|${paletteKey}|${settings.tolerance}|${settings.softness}|${needFg ? 1 : 0}|${needMask ? 1 : 0}`;
    if (processSig === this.lastProcessSig) {
      return {
        bgCanvas: this.bgCanvas,
        fgCanvas: this.fgCanvas,
        maskCanvas: this.maskCanvas,
        width: this.lastWidth,
        height: this.lastHeight,
      };
    }

    const src = this.sourceImgData.data;
    const fg = this.fgImgData.data;
    const mask = this.maskImgData.data;
    const pixelCount = this.lastWidth * this.lastHeight;

    const targetCount = palette.length;
    const targetH = new Float32Array(targetCount);
    const targetS = new Float32Array(targetCount);
    const targetV = new Float32Array(targetCount);
    const targetChromatic = new Uint8Array(targetCount);

    for (let t = 0; t < targetCount; t++) {
      const { r: tr, g: tg, b: tb } = hexToRgb(palette[t]);
      const hsv = rgbToHsv(tr, tg, tb);
      targetH[t] = hsv.h;
      targetS[t] = hsv.s;
      targetV[t] = hsv.v;
      targetChromatic[t] = hsv.s > 0.22 ? 1 : 0;
    }

    const thresh = 0.12 + (settings.tolerance / 100) * 0.78;
    const soft = 0.02 + (settings.softness / 100) * 0.30;
    const low = thresh - soft;
    const high = thresh + soft;
    const invRange = 1 / Math.max(1e-4, high - low);

    for (let i = 0, p = 0; i < pixelCount; i++, p += 4) {
      const r = src[p];
      const g = src[p + 1];
      const b = src[p + 2];

      const max = r > g ? (r > b ? r : b) : g > b ? g : b;
      const min = r < g ? (r < b ? r : b) : g < b ? g : b;
      const delta = max - min;
      const isAchromatic = delta < 12 || (max > 0 && delta / max < 0.14);

      const v = max / 255;
      const s = max === 0 ? 0 : delta / max;
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
        h *= 60;
      }

      let minDist = Infinity;
      for (let t = 0; t < targetCount; t++) {
        // Achromatic whites (chalk lines, white shorts) & deep blacks (cleats) stay foreground for chromatic turf targets
        if (targetChromatic[t] === 1 && isAchromatic) {
          continue;
        }
        let dh = Math.abs(h - targetH[t]);
        if (dh > 180) dh = 360 - dh;
        const satDiff = Math.abs(s - targetS[t]);
        const valDiff = Math.abs(v - targetV[t]);

        // Hue weighted strongest so mowed grass stripes & pitch shadows key together cleanly
        const hNorm = dh / 42;
        const sNorm = satDiff / 0.56;
        const vNorm = valDiff / 0.78;
        const dist = Math.sqrt(hNorm * hNorm * 1.45 + sNorm * sNorm * 0.65 + vNorm * vNorm * 0.32);
        if (dist < minDist) {
          minDist = dist;
        }
      }

      let fgAlpha = 1;
      if (minDist <= low) {
        fgAlpha = 0;
      } else if (minDist < high) {
        const interp = (minDist - low) * invRange;
        fgAlpha = interp * interp * (3 - 2 * interp);
      }

      if (needFg) {
        fg[p] = r;
        fg[p + 1] = g;
        fg[p + 2] = b;
        fg[p + 3] = Math.round(fgAlpha * 255);
      }

      if (needMask) {
        const pitchAlpha = 1 - fgAlpha;
        if (pitchAlpha > 0.01) {
          mask[p] = 217;
          mask[p + 1] = 70;
          mask[p + 2] = 239;
          mask[p + 3] = Math.round(pitchAlpha * 142);
        } else {
          mask[p + 3] = 0;
        }
      }
    }

    if (needFg) {
      this.fgCtx.putImageData(this.fgImgData, 0, 0);
    }
    if (needMask) {
      this.maskCtx.putImageData(this.maskImgData, 0, 0);
    }

    this.lastProcessSig = processSig;

    return {
      bgCanvas: this.bgCanvas,
      fgCanvas: this.fgCanvas,
      maskCanvas: this.maskCanvas,
      width: this.lastWidth,
      height: this.lastHeight,
    };
  }
}

export interface ChromaTargets {
  count: number;
  h: Float32Array;
  s: Float32Array;
  v: Float32Array;
  chromatic: Uint8Array;
  low: number;
  high: number;
  lowSq: number;
  highSq: number;
  invRange: number;
  /** Lazily populated 6-bit RGB LUT (255 = uncomputed, 0..200 = alpha * 200) */
  alphaLut: Uint8Array;
}

let cachedTargetsKey = '';
let cachedTargets: ChromaTargets | null = null;

export function buildChromaTargets(settings: ChromaKeySettings): ChromaTargets {
  const palette = settings.keyColors.length > 0 ? settings.keyColors : [DEFAULT_PITCH_GREEN];
  const key = `${palette.join(',')}|${settings.tolerance}|${settings.softness}`;
  if (cachedTargets && cachedTargetsKey === key) {
    return cachedTargets;
  }

  const count = palette.length;
  const h = new Float32Array(count);
  const s = new Float32Array(count);
  const v = new Float32Array(count);
  const chromatic = new Uint8Array(count);

  for (let t = 0; t < count; t++) {
    const { r: tr, g: tg, b: tb } = hexToRgb(palette[t]);
    const hsv = rgbToHsv(tr, tg, tb);
    h[t] = hsv.h;
    s[t] = hsv.s;
    v[t] = hsv.v;
    chromatic[t] = hsv.s > 0.22 ? 1 : 0;
  }

  const thresh = 0.12 + (settings.tolerance / 100) * 0.78;
  const soft = 0.02 + (settings.softness / 100) * 0.30;
  const low = thresh - soft;
  const high = thresh + soft;
  const invRange = 1 / Math.max(1e-4, high - low);

  const alphaLut = new Uint8Array(64 * 64 * 64);
  alphaLut.fill(255);

  const built: ChromaTargets = {
    count,
    h,
    s,
    v,
    chromatic,
    low,
    high,
    lowSq: low > 0 ? low * low : 0,
    highSq: high * high,
    invRange,
    alphaLut,
  };
  cachedTargetsKey = key;
  cachedTargets = built;
  return built;
}

export function computePixelFgAlphaFast(
  r: number,
  g: number,
  b: number,
  targets: ChromaTargets
): number {
  const idx = ((r & 0xfc) << 10) | ((g & 0xfc) << 4) | (b >> 2);
  const cached = targets.alphaLut[idx];
  if (cached !== 255) {
    return cached * 0.005;
  }
  const alpha = computePixelFgAlpha((r & 0xfc) | 2, (g & 0xfc) | 2, (b & 0xfc) | 2, targets);
  targets.alphaLut[idx] = Math.round(alpha * 200);
  return alpha;
}

export function computePixelFgAlpha(
  r: number,
  g: number,
  b: number,
  targets: ChromaTargets
): number {
  const max = r > g ? (r > b ? r : b) : g > b ? g : b;
  const min = r < g ? (r < b ? r : b) : g < b ? g : b;
  const delta = max - min;
  const isAchromatic = delta < 12 || (max > 0 && delta / max < 0.14);

  const v = max * (1 / 255);
  const s = max === 0 ? 0 : delta / max;
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
    h *= 60;
  }

  let minDistSq = Infinity;
  const count = targets.count;
  for (let t = 0; t < count; t++) {
    if (targets.chromatic[t] === 1 && isAchromatic) {
      continue;
    }
    let dh = Math.abs(h - targets.h[t]);
    if (dh > 180) dh = 360 - dh;
    const satDiff = s - targets.s[t];
    const valDiff = v - targets.v[t];

    const hNorm = dh * (1 / 42);
    const sNorm = satDiff * (1 / 0.56);
    const vNorm = valDiff * (1 / 0.78);
    const distSq = hNorm * hNorm * 1.45 + sNorm * sNorm * 0.65 + vNorm * vNorm * 0.32;
    if (distSq < minDistSq) {
      minDistSq = distSq;
    }
  }

  if (minDistSq <= targets.lowSq || (targets.low < 0 && minDistSq === 0)) return 0;
  if (minDistSq >= targets.highSq) return 1;
  const minDist = Math.sqrt(minDistSq);
  if (minDist <= targets.low) return 0;
  if (minDist >= targets.high) return 1;
  const interp = (minDist - targets.low) * targets.invRange;
  return interp * interp * (3 - 2 * interp);
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return {
    r: Number.isNaN(r) ? 42 : r,
    g: Number.isNaN(g) ? 120 : g,
    b: Number.isNaN(b) ? 54 : b,
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  return (
    '#' +
    [r, g, b]
      .map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  );
}

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const v = max / 255;
  const s = max === 0 ? 0 : delta / max;
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
    h *= 60;
  }
  return { h, s, v };
}

