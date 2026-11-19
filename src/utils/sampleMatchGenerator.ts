interface SimPlayer {
  id: number;
  team: 'home' | 'away' | 'gk';
  number: string;
  baseX: number;
  baseY: number;
  ampX: number;
  ampY: number;
  freqX: number;
  freqY: number;
  phase: number;
  hairColor: string;
  skinColor: string;
}

const SIM_PLAYERS: SimPlayer[] = [
  // Home team (Crimson Red shirts, White shorts) attacking Left -> Right
  { id: 1, team: 'home', number: '9', baseX: 1120, baseY: 430, ampX: 280, ampY: 110, freqX: 0.42, freqY: 0.65, phase: 0.2, hairColor: '#2B1D14', skinColor: '#D9A077' },
  { id: 2, team: 'home', number: '10', baseX: 980, baseY: 570, ampX: 250, ampY: 130, freqX: 0.36, freqY: 0.52, phase: 1.4, hairColor: '#18181B', skinColor: '#8D5524' },
  { id: 3, team: 'home', number: '7', baseX: 1050, baseY: 250, ampX: 260, ampY: 95, freqX: 0.48, freqY: 0.72, phase: 2.3, hairColor: '#B45309', skinColor: '#F1C27D' },
  { id: 4, team: 'home', number: '8', baseX: 780, baseY: 460, ampX: 220, ampY: 140, freqX: 0.31, freqY: 0.44, phase: 0.9, hairColor: '#1E1B18', skinColor: '#E0AC69' },
  { id: 5, team: 'home', number: '6', baseX: 640, baseY: 360, ampX: 180, ampY: 105, freqX: 0.28, freqY: 0.49, phase: 3.1, hairColor: '#3F2E21', skinColor: '#C68642' },

  // Away team (Sky Blue shirts, Navy shorts) defending
  { id: 6, team: 'away', number: '4', baseX: 1220, baseY: 420, ampX: 170, ampY: 110, freqX: 0.39, freqY: 0.58, phase: 0.6, hairColor: '#1F2937', skinColor: '#E0AC69' },
  { id: 7, team: 'away', number: '5', baseX: 1250, baseY: 540, ampX: 190, ampY: 95, freqX: 0.34, freqY: 0.61, phase: 2.0, hairColor: '#451A03', skinColor: '#8D5524' },
  { id: 8, team: 'away', number: '2', baseX: 1160, baseY: 270, ampX: 210, ampY: 85, freqX: 0.45, freqY: 0.68, phase: 2.8, hairColor: '#111827', skinColor: '#F1C27D' },
  { id: 9, team: 'away', number: '14', baseX: 930, baseY: 470, ampX: 200, ampY: 135, freqX: 0.33, freqY: 0.47, phase: 1.1, hairColor: '#78350F', skinColor: '#D9A077' },
  { id: 10, team: 'away', number: '16', baseX: 840, baseY: 310, ampX: 185, ampY: 105, freqX: 0.37, freqY: 0.54, phase: 3.7, hairColor: '#18181B', skinColor: '#C68642' },

  // Away Goalkeeper (Neon Lime / Yellow kit)
  { id: 11, team: 'gk', number: '1', baseX: 1620, baseY: 450, ampX: 35, ampY: 80, freqX: 0.5, freqY: 0.75, phase: 0.4, hairColor: '#27272A', skinColor: '#E0AC69' },
];

/**
 * Generates an animated 12-second 1280x720 tactical football match clip
 * using offscreen HTML5 Canvas + MediaRecorder and returns a WebM Blob.
 */
export async function generateSampleFootballMatchBlob(
  onProgress?: (percent: number) => void
): Promise<Blob> {
  const width = 1280;
  const height = 720;
  const fps = 30;
  const durationSec = 10;
  const totalFrames = fps * durationSec;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not acquire 2D canvas context for sample match generation.');
  }

  // Pick best supported MediaRecorder mime type
  const mimeCandidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  const mimeType =
    mimeCandidates.find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) ||
    'video/webm';

  const stream = canvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 4_500_000,
  });

  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      chunks.push(e.data);
    }
  };

  const stopPromise = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType });
      if (blob.size === 0) {
        reject(new Error('Generated video stream was empty.'));
      } else {
        resolve(blob);
      }
    };
    recorder.onerror = () => reject(new Error('MediaRecorder failed while recording sample match.'));
  });

  recorder.start(250);

  const frameDurationMs = 1000 / fps;
  for (let frame = 0; frame < totalFrames; frame++) {
    const t = frame / fps;
    drawMatchFrame(ctx, width, height, t);
    onProgress?.(Math.round(((frame + 1) / totalFrames) * 95));
    await new Promise((r) => setTimeout(r, frameDurationMs));
  }

  recorder.stop();
  const rawBlob = await stopPromise;
  onProgress?.(100);
  return rawBlob;
}

function drawMatchFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  t: number
): void {
  // Subtle broadcast camera pan right and back
  const camX = 140 + Math.sin(t * 0.45) * 165 + t * 14;
  const camY = 95 + Math.cos(t * 0.35) * 28;

  ctx.save();
  ctx.fillStyle = '#143318';
  ctx.fillRect(0, 0, width, height);

  // Translate world pitch coordinates into camera viewport
  ctx.translate(-camX, -camY);

  // World pitch dimensions: 1850 x 920
  const pitchW = 1850;
  const pitchH = 920;

  // Mowed grass vertical stripes
  const stripeCount = 18;
  const stripeW = pitchW / stripeCount;
  for (let i = 0; i < stripeCount; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#246B2F' : '#2B7A37';
    ctx.fillRect(i * stripeW, 0, stripeW + 1, pitchH);
  }

  // Subtle turf grain vignette
  const grad = ctx.createRadialGradient(925, 460, 120, 925, 460, 1050);
  grad.addColorStop(0, 'rgba(255,255,255,0.04)');
  grad.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, pitchW, pitchH);

  // Crisp pitch chalk markings
  ctx.strokeStyle = 'rgba(248, 250, 252, 0.84)';
  ctx.lineWidth = 4;

  // Outer touchlines
  ctx.strokeRect(70, 55, pitchW - 140, pitchH - 110);

  // Halfway line & center circle
  ctx.beginPath();
  ctx.moveTo(pitchW / 2, 55);
  ctx.lineTo(pitchW / 2, pitchH - 55);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(pitchW / 2, pitchH / 2, 118, 0, Math.PI * 2);
  ctx.stroke();

  // Center spot
  ctx.fillStyle = 'rgba(248, 250, 252, 0.9)';
  ctx.beginPath();
  ctx.arc(pitchW / 2, pitchH / 2, 5, 0, Math.PI * 2);
  ctx.fill();

  // Right Penalty Box & 6-yard Box
  ctx.strokeRect(pitchW - 70 - 280, pitchH / 2 - 220, 280, 440);
  ctx.strokeRect(pitchW - 70 - 105, pitchH / 2 - 110, 105, 220);
  ctx.beginPath();
  ctx.arc(pitchW - 70 - 195, pitchH / 2, 112, Math.PI * 0.72, Math.PI * 1.28);
  ctx.stroke();

  // Left Penalty Box
  ctx.strokeRect(70, pitchH / 2 - 220, 280, 440);
  ctx.strokeRect(70, pitchH / 2 - 110, 105, 220);

  // Goal net frame (right)
  ctx.strokeStyle = 'rgba(226, 232, 240, 0.75)';
  ctx.lineWidth = 3;
  ctx.strokeRect(pitchW - 70, pitchH / 2 - 68, 36, 136);

  // Compute player positions
  const positions = SIM_PLAYERS.map((p) => {
    const x =
      p.baseX +
      Math.sin(t * p.freqX * Math.PI * 2 + p.phase) * p.ampX +
      Math.cos(t * 0.7 + p.id) * 26;
    const y =
      p.baseY +
      Math.cos(t * p.freqY * Math.PI * 2 + p.phase * 1.3) * p.ampY;
    const vx = Math.cos(t * p.freqX * Math.PI * 2 + p.phase) * p.ampX * p.freqX;
    return { ...p, x, y, vx };
  });

  // Sort by Y for authentic 2.5D painter's order
  positions.sort((a, b) => a.y - b.y);

  // Draw ball moving smoothly between home attackers
  const p9 = positions.find((p) => p.number === '9' && p.team === 'home')!;
  const p10 = positions.find((p) => p.number === '10' && p.team === 'home')!;
  const p7 = positions.find((p) => p.number === '7' && p.team === 'home')!;
  const cycle = (t * 0.45) % 3;
  let ballX = p9.x + 18;
  let ballY = p9.y + 18;
  if (cycle < 1) {
    const u = smoothstep(cycle);
    ballX = lerp(p10.x + 12, p9.x + 14, u);
    ballY = lerp(p10.y + 18, p9.y + 18, u);
  } else if (cycle < 2) {
    const u = smoothstep(cycle - 1);
    ballX = lerp(p9.x + 14, p7.x + 12, u);
    ballY = lerp(p9.y + 18, p7.y + 18, u);
  } else {
    const u = smoothstep(cycle - 2);
    ballX = lerp(p7.x + 12, p10.x + 12, u);
    ballY = lerp(p7.y + 18, p10.y + 18, u);
  }

  // Ball shadow + ball
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(ballX + 2, ballY + 5, 8, 4, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#F8FAFC';
  ctx.beginPath();
  ctx.arc(ballX, ballY, 6.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#0F172A';
  ctx.lineWidth = 1.4;
  ctx.stroke();

  // Draw each player with realistic broadcast silhouette + kit colors + running stride
  for (const p of positions) {
    drawPlayerSprite(ctx, p, t);
  }

  ctx.restore();

  // Broadcast scorebug overlay top-left (subtle, realistic match footage cue)
  ctx.save();
  ctx.fillStyle = 'rgba(11, 15, 20, 0.78)';
  ctx.fillRect(28, 24, 210, 34);
  ctx.fillStyle = '#DC2626';
  ctx.fillRect(28, 24, 6, 34);
  ctx.fillStyle = '#0284C7';
  ctx.fillRect(232, 24, 6, 34);

  ctx.font = '600 13px "JetBrains Mono", monospace';
  ctx.fillStyle = '#F8FAFC';
  ctx.fillText('HOM  1 - 1  AWY', 46, 46);
  ctx.fillStyle = '#94A3B8';
  const secStr = Math.floor(t).toString().padStart(2, '0');
  ctx.fillText(`64:${secStr}`, 182, 46);
  ctx.restore();
}

function drawPlayerSprite(
  ctx: CanvasRenderingContext2D,
  p: SimPlayer & { x: number; y: number; vx: number },
  t: number
): void {
  const stride = Math.sin(t * 11 + p.id * 1.7) * 6;
  const jerseyColor =
    p.team === 'home' ? '#DC2626' : p.team === 'away' ? '#0284C7' : '#84CC16';
  const shortsColor =
    p.team === 'home' ? '#F8FAFC' : p.team === 'away' ? '#0F172A' : '#18181B';
  const sockColor =
    p.team === 'home' ? '#B91C1C' : p.team === 'away' ? '#0369A1' : '#65A30D';

  ctx.save();
  ctx.translate(p.x, p.y);

  // Ground shadow
  ctx.fillStyle = 'rgba(0, 0, 0, 0.34)';
  ctx.beginPath();
  ctx.ellipse(0, 22, 14, 6, 0, 0, Math.PI * 2);
  ctx.fill();

  // Legs with running stride
  ctx.strokeStyle = p.skinColor;
  ctx.lineWidth = 4.2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-4, 6);
  ctx.lineTo(-4 - stride * 0.7, 19);
  ctx.moveTo(4, 6);
  ctx.lineTo(4 + stride * 0.7, 19);
  ctx.stroke();

  // Socks + cleats
  ctx.strokeStyle = sockColor;
  ctx.lineWidth = 4.5;
  ctx.beginPath();
  ctx.moveTo(-4 - stride * 0.4, 13);
  ctx.lineTo(-4 - stride * 0.7, 20);
  ctx.moveTo(4 + stride * 0.4, 13);
  ctx.lineTo(4 + stride * 0.7, 20);
  ctx.stroke();

  ctx.fillStyle = '#111827';
  ctx.fillRect(-6 - stride * 0.7, 19, 6, 3);
  ctx.fillRect(1 + stride * 0.7, 19, 6, 3);

  // Shorts
  ctx.fillStyle = shortsColor;
  ctx.beginPath();
  ctx.roundRect(-8.5, 1, 17, 9, 2);
  ctx.fill();

  // Torso / Jersey
  ctx.fillStyle = jerseyColor;
  ctx.beginPath();
  ctx.roundRect(-10, -15, 20, 18, 4);
  ctx.fill();

  // Arms swinging
  ctx.strokeStyle = jerseyColor;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(-9, -12);
  ctx.lineTo(-13, -3 + stride * 0.4);
  ctx.moveTo(9, -12);
  ctx.lineTo(13, -3 - stride * 0.4);
  ctx.stroke();

  // Jersey number
  ctx.fillStyle = p.team === 'gk' ? '#09090B' : '#FFFFFF';
  ctx.font = 'bold 9px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(p.number, 0, -6);

  // Head & hair
  ctx.fillStyle = p.skinColor;
  ctx.beginPath();
  ctx.arc(0, -21, 6, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = p.hairColor;
  ctx.beginPath();
  ctx.arc(0, -23, 6, Math.PI, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(x: number): number {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
}
