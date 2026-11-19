import { DEFAULT_PITCH_GREEN, type ChromaKeySettings } from '../types/tracking';

const MAX_KEY_COLORS = 12;

const VERT_SHADER = `#version 300 es
precision highp float;

in vec2 a_pos;
out vec2 v_uv;

void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
  // Map clip-space [-1..1] to top-down texture UV [0..1] (y=0 top, y=1 bottom)
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
}
`;

const FRAG_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_videoTex;
uniform sampler2D u_toolsTex;

uniform vec4 u_targets[${MAX_KEY_COLORS}]; // x=H (0..360), y=S (0..1), z=V (0..1), w=chromatic (0 or 1)
uniform int u_targetCount;
uniform float u_low;
uniform float u_high;
uniform float u_invRange;
uniform int u_showMask;
uniform int u_hasTools;

in vec2 v_uv;
out vec4 outColor;

void main() {
  vec4 vid = texture(u_videoTex, v_uv);
  vec3 rgb = vid.rgb;

  // Fast path: when no tools are active and mask inspection is off, output native video directly
  if (u_hasTools == 0 && u_showMask == 0) {
    outColor = vec4(rgb, 1.0);
    return;
  }

  float maxC = max(rgb.r, max(rgb.g, rgb.b));
  float minC = min(rgb.r, min(rgb.g, rgb.b));
  float delta = maxC - minC;

  // Match CPU ChromaKeyEngine: delta < 12/255 || (maxC > 0 && delta / maxC < 0.14)
  bool isAchromatic = (delta < 0.04705882) || (maxC > 0.0 && (delta / maxC) < 0.14);

  float v = maxC;
  float s = maxC <= 0.0 ? 0.0 : (delta / maxC);
  float h = 0.0;
  if (delta > 0.00001) {
    if (maxC == rgb.r) {
      h = mod((rgb.g - rgb.b) / delta, 6.0);
    } else if (maxC == rgb.g) {
      h = (rgb.b - rgb.r) / delta + 2.0;
    } else {
      h = (rgb.r - rgb.g) / delta + 4.0;
    }
    h *= 60.0;
  }

  float minDist = 1e6;
  for (int i = 0; i < ${MAX_KEY_COLORS}; i++) {
    if (i >= u_targetCount) break;
    vec4 t = u_targets[i];
    if (t.w > 0.5 && isAchromatic) {
      continue;
    }
    float dh = abs(h - t.x);
    if (dh > 180.0) dh = 360.0 - dh;
    float satDiff = abs(s - t.y);
    float valDiff = abs(v - t.z);

    float hNorm = dh / 42.0;
    float sNorm = satDiff / 0.56;
    float vNorm = valDiff / 0.78;
    float dist = sqrt(hNorm * hNorm * 1.45 + sNorm * sNorm * 0.65 + vNorm * vNorm * 0.32);
    minDist = min(minDist, dist);
  }

  float fgAlpha = 1.0;
  if (minDist <= u_low) {
    fgAlpha = 0.0;
  } else if (minDist < u_high) {
    float interp = clamp((minDist - u_low) * u_invRange, 0.0, 1.0);
    fgAlpha = interp * interp * (3.0 - 2.0 * interp);
  }

  // Layer 1: Native video background
  vec3 col = rgb;

  // Layer 1.5: Optional chroma-key inspection mask
  if (u_showMask == 1) {
    float pitchAlpha = 1.0 - fgAlpha;
    if (pitchAlpha > 0.01) {
      float maskA = pitchAlpha * 0.5568627; // 142 / 255
      vec3 maskCol = vec3(0.85098, 0.27451, 0.93725); // rgb(217, 70, 239)
      col = mix(col, maskCol, maskA);
    }
  }

  // Layer 2 (Tools, premultiplied alpha) + Layer 3 (Foreground players over tools)
  if (u_hasTools == 1) {
    vec4 tool = texture(u_toolsTex, v_uv);
    col = tool.rgb + col * (1.0 - tool.a);
    col = mix(col, rgb, fgAlpha);
  }

  outColor = vec4(col, 1.0);
}
`;

export interface RenderRectPx {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class WebGlChromaCompositor {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private videoTex: WebGLTexture;
  private toolsTex: WebGLTexture;

  private uVideoTexLoc: WebGLUniformLocation | null;
  private uToolsTexLoc: WebGLUniformLocation | null;
  private uTargetsLoc: WebGLUniformLocation | null;
  private uTargetCountLoc: WebGLUniformLocation | null;
  private uLowLoc: WebGLUniformLocation | null;
  private uHighLoc: WebGLUniformLocation | null;
  private uInvRangeLoc: WebGLUniformLocation | null;
  private uShowMaskLoc: WebGLUniformLocation | null;
  private uHasToolsLoc: WebGLUniformLocation | null;

  private targetsBuffer = new Float32Array(MAX_KEY_COLORS * 4);
  private lastVideoUploadSig = '';
  private lastChromaSig = '';
  private contextLost = false;
  private onContextLost?: () => void;

  private handleLost = (e: Event) => {
    e.preventDefault();
    this.contextLost = true;
    this.onContextLost?.();
  };

  constructor(
    canvas: HTMLCanvasElement,
    onContextLost?: () => void,
    options?: { preserveDrawingBuffer?: boolean }
  ) {
    this.canvas = canvas;
    this.onContextLost = onContextLost;

    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: options?.preserveDrawingBuffer ?? false,
      powerPreference: 'high-performance',
    });

    if (!gl) {
      throw new Error('WebGL2 context unavailable.');
    }

    this.gl = gl;
    canvas.addEventListener('webglcontextlost', this.handleLost);

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SHADER);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SHADER);
    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      throw new Error('Failed to create WebGL2 program.');
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) || 'Unknown link error';
      gl.deleteProgram(program);
      throw new Error(`WebGL2 program link error: ${log}`);
    }

    this.program = program;
    gl.useProgram(program);

    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    if (!vao || !vbo) {
      throw new Error('Failed to allocate WebGL2 geometry buffers.');
    }
    this.vao = vao;
    this.vbo = vbo;

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const quadVerts = new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
      -1,  1,
       1, -1,
       1,  1,
    ]);
    gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

    const posLoc = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    this.videoTex = createConfiguredTexture(gl);
    this.toolsTex = createConfiguredTexture(gl);

    this.uVideoTexLoc = gl.getUniformLocation(program, 'u_videoTex');
    this.uToolsTexLoc = gl.getUniformLocation(program, 'u_toolsTex');
    this.uTargetsLoc = gl.getUniformLocation(program, 'u_targets');
    this.uTargetCountLoc = gl.getUniformLocation(program, 'u_targetCount');
    this.uLowLoc = gl.getUniformLocation(program, 'u_low');
    this.uHighLoc = gl.getUniformLocation(program, 'u_high');
    this.uInvRangeLoc = gl.getUniformLocation(program, 'u_invRange');
    this.uShowMaskLoc = gl.getUniformLocation(program, 'u_showMask');
    this.uHasToolsLoc = gl.getUniformLocation(program, 'u_hasTools');

    gl.uniform1i(this.uVideoTexLoc, 0);
    gl.uniform1i(this.uToolsTexLoc, 1);
  }

  public isContextLost(): boolean {
    return this.contextLost || this.gl.isContextLost();
  }

  public resetFrameCache(): void {
    this.lastVideoUploadSig = '';
  }

  public uploadVideoFrame(video: HTMLVideoElement, frameEpoch: number): boolean {
    if (this.isContextLost()) return false;
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      return false;
    }
    const videoSig = `${video.currentSrc}|${frameEpoch}|${video.videoWidth}x${video.videoHeight}`;
    if (videoSig === this.lastVideoUploadSig) {
      return true;
    }
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      this.lastVideoUploadSig = videoSig;
      return true;
    } catch {
      return false;
    }
  }

  public render(params: {
    video: HTMLVideoElement;
    frameEpoch: number;
    toolsCanvas: HTMLCanvasElement | null;
    hasTools: boolean;
    toolsUpdated: boolean;
    chromaKey: ChromaKeySettings;
    stageWidthPx: number;
    stageHeightPx: number;
    rect: RenderRectPx;
    dpr: number;
  }): boolean {
    if (this.isContextLost()) return false;

    const {
      video,
      frameEpoch,
      toolsCanvas,
      hasTools,
      toolsUpdated,
      chromaKey,
      stageWidthPx,
      stageHeightPx,
      rect,
      dpr,
    } = params;

    const videoSig = `${video.currentSrc}|${frameEpoch}|${video.videoWidth}x${video.videoHeight}`;
    const needsUpload = videoSig !== this.lastVideoUploadSig;
    if (needsUpload && (video.readyState < 2 || !video.videoWidth || !video.videoHeight)) {
      return false;
    }

    const gl = this.gl;
    if (this.canvas.width !== stageWidthPx || this.canvas.height !== stageHeightPx) {
      this.canvas.width = stageWidthPx;
      this.canvas.height = stageHeightPx;
    }

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    // 1. Upload decoded video frame ONLY when frameEpoch or video source/time actually changed
    if (needsUpload) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        this.lastVideoUploadSig = videoSig;
      } catch {
        return false;
      }
    }

    // 2. Upload Layer 2 tools texture only when tools are visible & updated
    if (hasTools && toolsCanvas && toolsCanvas.width > 0 && toolsCanvas.height > 0 && toolsUpdated) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.toolsTex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, toolsCanvas);
    }

    // 3. Update chroma key uniforms only when settings change
    const palette = chromaKey.keyColors.length > 0 ? chromaKey.keyColors : [DEFAULT_PITCH_GREEN];
    const clampedCount = Math.min(MAX_KEY_COLORS, palette.length);
    const chromaSig = `${palette.slice(0, clampedCount).join(',')}|${chromaKey.tolerance}|${chromaKey.softness}`;
    if (chromaSig !== this.lastChromaSig) {
      for (let i = 0; i < clampedCount; i++) {
        const { r, g, b } = hexToRgb(palette[i]);
        const hsv = rgbToHsv(r, g, b);
        const offset = i * 4;
        this.targetsBuffer[offset] = hsv.h;
        this.targetsBuffer[offset + 1] = hsv.s;
        this.targetsBuffer[offset + 2] = hsv.v;
        this.targetsBuffer[offset + 3] = hsv.s > 0.22 ? 1 : 0;
      }
      const thresh = 0.12 + (chromaKey.tolerance / 100) * 0.78;
      const soft = 0.02 + (chromaKey.softness / 100) * 0.3;
      const low = thresh - soft;
      const high = thresh + soft;
      const invRange = 1 / Math.max(1e-4, high - low);

      gl.uniform4fv(this.uTargetsLoc, this.targetsBuffer);
      gl.uniform1i(this.uTargetCountLoc, clampedCount);
      gl.uniform1f(this.uLowLoc, low);
      gl.uniform1f(this.uHighLoc, high);
      gl.uniform1f(this.uInvRangeLoc, invRange);
      this.lastChromaSig = chromaSig;
    }

    gl.uniform1i(this.uShowMaskLoc, chromaKey.showMask ? 1 : 0);
    gl.uniform1i(this.uHasToolsLoc, hasTools ? 1 : 0);

    // 4. Clear stage letterbox background & draw video rect viewport
    gl.viewport(0, 0, stageWidthPx, stageHeightPx);
    gl.clearColor(7 / 255, 10 / 255, 14 / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const vx = Math.round(rect.x * dpr);
    const vw = Math.max(1, Math.round(rect.w * dpr));
    const vh = Math.max(1, Math.round(rect.h * dpr));
    const topPx = Math.round(rect.y * dpr);
    const vy = stageHeightPx - topPx - vh;

    gl.viewport(vx, vy, vw, vh);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return true;
  }

  public dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.handleLost);
    const gl = this.gl;
    gl.deleteTexture(this.videoTex);
    gl.deleteTexture(this.toolsTex);
    gl.deleteBuffer(this.vbo);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error('Failed to create WebGL2 shader.');
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || 'Unknown compile error';
    gl.deleteShader(shader);
    throw new Error(`WebGL2 shader compile error: ${log}`);
  }
  return shader;
}

function createConfiguredTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) {
    throw new Error('Failed to create WebGL2 texture.');
  }
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
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
