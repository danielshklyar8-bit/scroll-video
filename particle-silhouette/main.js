const ORANGE = '#FAA300';
const PINK = '#FF64CB';
const BACKGROUND = '#FFFFFF';
const PERSON_TINT = '#CFCFCF'; // stand-in body colour used only in ?demo mode (no webcam)

const SAMPLE = 4;      // grid step used to sample the body outline
const SQUARE = SAMPLE; // drawn square size for silhouette cells (demo person / dissolve)

// --- Segmentation / tracking ---
const SEGMENT_INTERVAL = 90;  // ms between BodyPix calls
const SMOOTHING = 0.28;       // body-center + cell smoothing

// --- Catch game tuning ---
const GAME_DIFFICULTY_RAMP = 55000; // ms to reach max difficulty
const EMIT_INTERVAL_START = 750;    // ms between block bursts at the start
const EMIT_INTERVAL_END = 260;      // ms between block bursts at max difficulty
const BLOCK_SPEED_MIN = 1.5;        // outward speed at easy difficulty
const BLOCK_SPEED_MAX = 3.2;        // outward speed at max difficulty
const CATCH_RADIUS = 46;            // how close a hand must be to grab a block
const ABSORB_RADIUS = 24;           // distance to body center where a caught block is absorbed
const CAUGHT_PULL = 0.45;           // acceleration of a caught block back toward the body
const CAUGHT_FRICTION = 0.88;       // damping while reeling a caught block in

// --- Pink "jellyfish" escalation (triggered when a block escapes the frame) ---
const PINK_FLASH_MIN = 900;         // ms
const PINK_FLASH_MAX = 1400;        // ms
const MIN_PINK_SPAWN = 0.03;        // per-frame spawn chance right after the first escape
const MAX_PINK_SPAWN = 0.20;        // per-frame spawn chance after full escalation
const PINK_ESCALATION_DURATION = 16000;

// --- Dissolve end-phase (person disintegrates), kept from the original piece ---
const DISSOLVE_START = 35000;
const DISSOLVE_RAMP = 16000;
const DISSOLVE_BASE_RATE = 0.0015;
const DISSOLVE_MAX_RATE = 0.08;
const DISSOLVE_EXIT_MARGIN = 140;

// --- Demo mode (no camera): synthetic body + auto-controlled hands ---
const params = new URLSearchParams(location.search);
const DEMO = params.has('demo') && params.get('demo') !== '0';
const DEMO_MOUSE = params.get('demo') === 'mouse';
const DEMO_HAND_SPEED = 5.2; // capped so some fast blocks still escape

// --- Sizzle / shock sound (reused for the pink jellyfish attaching to the body) ---
const touchSound = new Audio('Electric SHOCK.mp3');
touchSound.preload = 'auto';
touchSound.volume = 0.75;
let audioContext = null;
function ensureAudio(){
  if(!audioContext){
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if(audioContext.state === 'suspended') audioContext.resume().catch(()=>{});
  return audioContext;
}
function playTouchSound(){
  if(touchSound.readyState >= 2){
    touchSound.currentTime = 0;
    touchSound.play().catch(()=>{});
    return;
  }
  const ac = ensureAudio();
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(220, ac.currentTime);
  osc.frequency.exponentialRampToValueAtTime(90, ac.currentTime + 0.18);
  gain.gain.setValueAtTime(0.18, ac.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.2);
  osc.connect(gain).connect(ac.destination);
  osc.start();
  osc.stop(ac.currentTime + 0.2);
}
function playCatchSound(){
  const ac = ensureAudio();
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(660, ac.currentTime);
  osc.frequency.exponentialRampToValueAtTime(990, ac.currentTime + 0.08);
  gain.gain.setValueAtTime(0.08, ac.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.1);
  osc.connect(gain).connect(ac.destination);
  osc.start();
  osc.stop(ac.currentTime + 0.1);
}

let video, canvas, ctx, net;
let width = 640, height = 480;

let silhouettePoints = [];
let silhouetteMap = new Map();
let bodyCenter = { x: width / 2, y: height / 2 };

let particles = [];        // flying / caught yellow blocks (the game pieces)
let dissolveParticles = [];
let pinks = [];
let hands = [];            // current hand positions (wrists), in canvas/mirrored coords

let personDetected = false;
let gameStart = 0;
let lastEmit = 0;
let score = 0;
let escapes = 0;
let lastCatchAt = -9999;

let pinkEnabled = false;
let pinkPhaseStart = null;

// offscreen buffers for masking the webcam person onto the white background
let personCanvas, personCtx, maskCanvas, maskCtx, maskImageData;

// demo helpers
let demoBaseCells = [];
let demoHands = [];
const demoRemoved = new Set();
let mouse = { x: width / 2, y: height / 2, active: false };

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

async function setupCamera(){
  video = document.getElementById('video');
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
  video.srcObject = stream;
  await video.play();
  width = video.videoWidth || width;
  height = video.videoHeight || height;
  video.width = width; video.height = height;
  video.style.display = 'none';
}

function setupCanvas(){
  canvas = document.getElementById('canvas');
  canvas.width = width; canvas.height = height;
  canvas.style.width = '100%'; canvas.style.height = '100%';
  ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
}

async function loadModel(){
  try{
    net = await bodyPix.load({ architecture: 'MobileNetV1', outputStride: 16, multiplier: 0.75, quantBytes: 2 });
  }catch(e){
    net = await bodyPix.load();
  }
}

/* ------------------------------------------------------------------ */
/* Silhouette sampling (live camera)                                   */
/* ------------------------------------------------------------------ */

function sampleSilhouette(segmentation){
  const data = segmentation.data;
  const newMap = new Map();
  silhouettePoints = [];
  const tempPoints = [];
  let minX = width, minY = height, maxX = 0, maxY = 0;

  for(let y = 0; y < height; y += SAMPLE){
    for(let x = 0; x < width; x += SAMPLE){
      const idx = y * width + x;
      if(data[idx] === 1){
        let neighbors = 0;
        for(let yy = -2; yy <= 2; yy += 2){
          for(let xx = -2; xx <= 2; xx += 2){
            const nx = x + xx, ny = y + yy;
            if(nx >= 0 && nx < width && ny >= 0 && ny < height && data[ny * width + nx] === 1) neighbors++;
          }
        }
        if(neighbors < 3) continue;
        const gx = Math.floor(x / SAMPLE);
        const gy = Math.floor(y / SAMPLE);
        const cx = width - (gx * SAMPLE + SAMPLE / 2); // mirror X (selfie view)
        const cy = gy * SAMPLE + SAMPLE / 2;
        tempPoints.push({ gx, gy, cx, cy });
        if(cx < minX) minX = cx;
        if(cx > maxX) maxX = cx;
        if(cy < minY) minY = cy;
        if(cy > maxY) maxY = cy;
      }
    }
  }

  if(!tempPoints.length){ silhouetteMap = newMap; silhouettePoints = []; return; }

  const frameCenterX = (minX + maxX) / 2;
  const frameCenterY = (minY + maxY) / 2;
  bodyCenter.x += (frameCenterX - bodyCenter.x) * SMOOTHING;
  bodyCenter.y += (frameCenterY - bodyCenter.y) * SMOOTHING;

  for(const p of tempPoints){
    const relX = p.cx - bodyCenter.x;
    const relY = p.cy - bodyCenter.y;
    const relKeyX = Math.round(relX / SAMPLE);
    const relKeyY = Math.round(relY / SAMPLE);
    const relKey = relKeyX + "_" + relKeyY;
    const targetX = bodyCenter.x + relX;
    const targetY = bodyCenter.y + relY;
    const existing = silhouetteMap.get(relKey);

    silhouettePoints.push({ x: targetX, y: targetY, relKey, relX, relY, relKeyX, relKeyY });
    newMap.set(relKey, {
      relX, relY, relKey, relKeyX, relKeyY, targetX, targetY,
      dispX: existing ? existing.dispX : targetX,
      dispY: existing ? existing.dispY : targetY,
      hitStart: existing ? existing.hitStart : 0,
      hitDuration: existing ? existing.hitDuration : 0
    });
  }
  silhouetteMap = newMap;
}

function getHandsFromPoses(poses){
  const out = [];
  if(!poses) return out;
  for(const pose of poses){
    if(!pose.keypoints) continue;
    for(const kp of pose.keypoints){
      if((kp.part === 'leftWrist' || kp.part === 'rightWrist') && kp.score > 0.25){
        out.push({ x: width - kp.position.x, y: kp.position.y }); // mirror X to match the flipped view
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Person rendering (live camera) – show the real person, masked       */
/* ------------------------------------------------------------------ */

function ensurePersonBuffers(){
  if(!personCanvas){ personCanvas = document.createElement('canvas'); personCtx = personCanvas.getContext('2d'); }
  if(personCanvas.width !== width || personCanvas.height !== height){ personCanvas.width = width; personCanvas.height = height; }
  if(!maskCanvas){ maskCanvas = document.createElement('canvas'); maskCtx = maskCanvas.getContext('2d'); }
  if(maskCanvas.width !== width || maskCanvas.height !== height){
    maskCanvas.width = width; maskCanvas.height = height;
    maskImageData = maskCtx.createImageData(width, height);
  }
}

function updateMask(segmentation){
  ensurePersonBuffers();
  const d = segmentation.data;
  const px = maskImageData.data;
  for(let i = 0; i < d.length; i++){
    const o = i * 4;
    if(d[i] === 1){ px[o] = 255; px[o + 1] = 255; px[o + 2] = 255; px[o + 3] = 255; }
    else { px[o + 3] = 0; }
  }
  maskCtx.putImageData(maskImageData, 0, 0);
}

function drawPerson(){
  if(!video || video.readyState < 2 || !maskCanvas) return;
  ensurePersonBuffers();
  personCtx.clearRect(0, 0, width, height);
  personCtx.save();
  personCtx.scale(-1, 1);
  personCtx.translate(-width, 0);
  personCtx.drawImage(video, 0, 0, width, height);          // mirrored webcam
  personCtx.globalCompositeOperation = 'destination-in';
  personCtx.drawImage(maskCanvas, 0, 0);                     // keep only the person
  personCtx.restore();
  personCtx.globalCompositeOperation = 'source-over';
  ctx.drawImage(personCanvas, 0, 0);
}

/* ------------------------------------------------------------------ */
/* The yellow blocks (game pieces)                                     */
/* ------------------------------------------------------------------ */

function emitBlock(difficulty){
  if(!silhouettePoints.length) return;
  const p = silhouettePoints[Math.floor(Math.random() * silhouettePoints.length)];
  let dx = p.x - bodyCenter.x, dy = p.y - bodyCenter.y;
  let m = Math.hypot(dx, dy);
  let dirx, diry;
  if(m < 1){ const a = Math.random() * Math.PI * 2; dirx = Math.cos(a); diry = Math.sin(a); }
  else { dirx = dx / m; diry = dy / m; }
  // rotate direction slightly for a natural spread
  const spread = (Math.random() - 0.5) * 0.8;
  const ca = Math.cos(spread), sa = Math.sin(spread);
  const rx = dirx * ca - diry * sa;
  const ry = dirx * sa + diry * ca;
  const speed = BLOCK_SPEED_MIN + difficulty * (BLOCK_SPEED_MAX - BLOCK_SPEED_MIN) + Math.random() * 0.9;
  const size = 10 + Math.random() * 12;
  particles.push({
    x: p.x, y: p.y,
    vx: rx * speed, vy: ry * speed,
    size, state: 'flying', born: performance.now()
  });
}

function updateBlocks(dt, now){
  const margin = 4;
  for(let i = particles.length - 1; i >= 0; i--){
    const b = particles[i];

    if(b.state === 'flying'){
      for(const h of hands){
        if(Math.hypot(h.x - b.x, h.y - b.y) < CATCH_RADIUS + b.size / 2){
          b.state = 'caught';
          lastCatchAt = now;
          playCatchSound();
          break;
        }
      }
      if(b.state === 'flying'){
        b.x += b.vx * dt / 16;
        b.y += b.vy * dt / 16;
        if(b.x < -margin || b.x > width + margin || b.y < -margin || b.y > height + margin){
          particles.splice(i, 1);
          onBlockEscaped(now);
          continue;
        }
      }
    }

    if(b.state === 'caught'){
      const dx = bodyCenter.x - b.x, dy = bodyCenter.y - b.y;
      const d = Math.hypot(dx, dy) || 1;
      b.vx += (dx / d) * CAUGHT_PULL;
      b.vy += (dy / d) * CAUGHT_PULL;
      b.vx *= CAUGHT_FRICTION;
      b.vy *= CAUGHT_FRICTION;
      b.x += b.vx * dt / 16;
      b.y += b.vy * dt / 16;
      if(d < ABSORB_RADIUS){
        particles.splice(i, 1);
        score++;
        updateScoreLabel();
      }
    }
  }
}

function onBlockEscaped(now){
  escapes++;
  if(!pinkEnabled){
    pinkEnabled = true;
    pinkPhaseStart = now;
  }
  // every escape sends an extra burst of jellyfish
  if(pinkEnabled){
    const burst = 1 + Math.min(3, Math.floor(escapes / 3));
    for(let k = 0; k < burst; k++) spawnPink();
  }
}

function drawBlocks(){
  // tether: show caught blocks being reeled back toward the body
  ctx.save();
  ctx.strokeStyle = 'rgba(250,163,0,0.35)';
  ctx.lineWidth = 2;
  for(const b of particles){
    if(b.state === 'caught'){
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(bodyCenter.x, bodyCenter.y);
      ctx.stroke();
    }
  }
  ctx.restore();

  ctx.save();
  for(const b of particles){
    if(b.state === 'caught'){
      // caught blocks get a subtle outline so the "grab" reads clearly
      ctx.fillStyle = ORANGE;
      ctx.fillRect(b.x - b.size / 2, b.y - b.size / 2, b.size, b.size);
      ctx.strokeStyle = 'rgba(255,120,0,0.9)';
      ctx.lineWidth = 2;
      ctx.strokeRect(b.x - b.size / 2 - 1, b.y - b.size / 2 - 1, b.size + 2, b.size + 2);
    } else {
      ctx.fillStyle = ORANGE;
      ctx.fillRect(b.x - b.size / 2, b.y - b.size / 2, b.size, b.size);
    }
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* Dissolve end-phase                                                  */
/* ------------------------------------------------------------------ */

function detachSilhouetteCell(cell, now){
  silhouetteMap.delete(cell.relKey);
  silhouettePoints = silhouettePoints.filter(p => p.relKey !== cell.relKey);
  if(DEMO) demoRemoved.add(cell.relKey);

  const edge = Math.floor(Math.random() * 4);
  let destX, destY;
  if(edge === 0){ destX = Math.random() * width; destY = -80; }
  else if(edge === 1){ destX = width + 80; destY = Math.random() * height; }
  else if(edge === 2){ destX = Math.random() * width; destY = height + 80; }
  else { destX = -80; destY = Math.random() * height; }

  const dx = destX - cell.dispX, dy = destY - cell.dispY;
  const distance = Math.hypot(dx, dy) || 1;
  const speed = 2.4 + Math.random() * 1.6;
  const startX = cell.dispX, startY = cell.dispY;
  const removalX = destX > width / 2 ? width + DISSOLVE_EXIT_MARGIN : -DISSOLVE_EXIT_MARGIN;
  const removalY = destY > height / 2 ? height + DISSOLVE_EXIT_MARGIN : -DISSOLVE_EXIT_MARGIN;
  const offscreenDist = Math.hypot(removalX - startX, removalY - startY) || distance;

  dissolveParticles.push({
    x: startX, y: startY,
    vx: (dx / distance) * speed + (Math.random() - 0.5) * 0.35,
    vy: (dy / distance) * speed + (Math.random() - 0.5) * 0.35,
    size: SQUARE + Math.random() * SQUARE,
    alpha: 1, fading: false,
    startX, startY, offscreenDist, born: now
  });
}

function updateDissolveParticles(dt){
  for(let i = dissolveParticles.length - 1; i >= 0; i--){
    const p = dissolveParticles[i];
    p.vx *= 0.993; p.vy *= 0.993;
    p.vy -= 0.002 * dt / 16;
    p.x += p.vx * dt / 16;
    p.y += p.vy * dt / 16;

    const relKeyX = Math.round((p.x - bodyCenter.x) / SAMPLE);
    const relKeyY = Math.round((p.y - bodyCenter.y) / SAMPLE);
    if(!p.fading && !silhouetteMap.has(`${relKeyX}_${relKeyY}`)) p.fading = true;
    if(p.fading){
      const traveled = Math.hypot(p.x - p.startX, p.y - p.startY);
      p.alpha = Math.max(0, 1 - (traveled / (p.offscreenDist || 1)));
    }
    if(p.x < -DISSOLVE_EXIT_MARGIN || p.x > width + DISSOLVE_EXIT_MARGIN || p.y < -DISSOLVE_EXIT_MARGIN || p.y > height + DISSOLVE_EXIT_MARGIN){
      dissolveParticles.splice(i, 1);
    }
  }
}

function updateDissolve(now, dt){
  if(!pinkPhaseStart || !silhouettePoints.length){ updateDissolveParticles(dt); return; }
  const elapsed = now - pinkPhaseStart;
  if(elapsed > DISSOLVE_START){
    const progress = Math.min(1, (elapsed - DISSOLVE_START) / DISSOLVE_RAMP);
    const detachChance = DISSOLVE_BASE_RATE + progress * DISSOLVE_MAX_RATE;
    for(const cell of Array.from(silhouetteMap.values())){
      if(Math.random() < detachChance * dt / 16) detachSilhouetteCell(cell, now);
    }
  }
  updateDissolveParticles(dt);
}

function drawDissolveParticles(){
  ctx.save();
  ctx.fillStyle = ORANGE;
  for(const p of dissolveParticles){
    ctx.globalAlpha = p.alpha;
    ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* Pink jellyfish                                                      */
/* ------------------------------------------------------------------ */

function spawnPink(){
  const edge = Math.floor(Math.random() * 4);
  let x, y;
  if(edge === 0){ x = Math.random() * width; y = -20; }
  else if(edge === 1){ x = width + 20; y = Math.random() * height; }
  else if(edge === 2){ x = Math.random() * width; y = height + 20; }
  else { x = -20; y = Math.random() * height; }
  let target = { x: width / 2, y: height / 2 };
  if(silhouettePoints.length) target = silhouettePoints[Math.floor(Math.random() * silhouettePoints.length)];
  const dx = target.x - x, dy = target.y - y;
  const mag = Math.hypot(dx, dy) || 1;
  const speed = 0.7 + Math.random() * 0.75;
  pinks.push({
    x, y, vx: dx / mag * speed, vy: dy / mag * speed,
    targetX: target.x, targetY: target.y,
    r: 10 + Math.random() * 16, born: performance.now(),
    attached: false, attachKey: null,
    attachOffsetX: undefined, attachOffsetY: undefined,
    attachStart: 0, attachedTime: 0, attachDuration: 0
  });
}

function updatePinks(dt){
  const now = performance.now();
  for(let i = pinks.length - 1; i >= 0; i--){
    const c = pinks[i];
    if(c.attached){
      if(c.attachKey && silhouetteMap.has(c.attachKey)){
        const cell = silhouetteMap.get(c.attachKey);
        c.x = cell.dispX; c.y = cell.dispY;
      } else if(c.attachOffsetX !== undefined){
        c.x = bodyCenter.x + c.attachOffsetX;
        c.y = bodyCenter.y + c.attachOffsetY;
      }
      c.attachedTime = now - c.attachStart;
      if(c.attachedTime > c.attachDuration) pinks.splice(i, 1);
      continue;
    }
    if(silhouettePoints.length){
      if(!c.targetX || Math.random() < 0.005){
        const target = silhouettePoints[Math.floor(Math.random() * silhouettePoints.length)];
        c.targetX = target.x; c.targetY = target.y;
      }
      const dx = c.targetX - c.x, dy = c.targetY - c.y;
      const mag = Math.hypot(dx, dy) || 1;
      c.vx += (dx / mag) * 0.045;
      c.vy += (dy / mag) * 0.045;
      c.vx += (Math.random() - 0.5) * 0.06;
      c.vy += (Math.random() - 0.5) * 0.06;
      if(Math.hypot(c.vx, c.vy) > 3){ c.vx *= 0.92; c.vy *= 0.92; }
    }
    c.x += c.vx * dt / 16;
    c.y += c.vy * dt / 16;
    if(c.x < -60 || c.x > width + 60 || c.y < -60 || c.y > height + 60) pinks.splice(i, 1);
    else checkPinkCollision(c);
  }
}

function checkPinkCollision(circle){
  if(circle.attached) return;
  const now = performance.now();
  const candidates = [];
  for(const p of silhouettePoints){
    const d = Math.hypot(p.x - circle.x, p.y - circle.y);
    if(d < circle.r + SAMPLE * 0.9) candidates.push(p);
  }
  if(!candidates.length) return;
  const p = candidates[Math.floor(Math.random() * candidates.length)];
  const cell = silhouetteMap.get(p.relKey);
  if(!cell) return;

  circle.attached = true;
  circle.attachKey = p.relKey;
  circle.attachOffsetX = cell.relX;
  circle.attachOffsetY = cell.relY;
  circle.attachStart = now;
  circle.attachDuration = PINK_FLASH_MIN + Math.random() * (PINK_FLASH_MAX - PINK_FLASH_MIN);
  circle.vx = 0; circle.vy = 0;
  playTouchSound();

  const spread = 3;
  for(let sy = -spread; sy <= spread; sy++){
    for(let sx = -spread; sx <= spread; sx++){
      const neighbor = silhouetteMap.get((cell.relKeyX + sx) + "_" + (cell.relKeyY + sy));
      if(neighbor){
        const dist = Math.hypot(sx, sy);
        if(dist <= spread + 0.2){
          const intensity = 1 - (dist / (spread + 0.2));
          neighbor.hitStart = now;
          neighbor.hitDuration = PINK_FLASH_MIN + intensity * (PINK_FLASH_MAX - PINK_FLASH_MIN);
        }
      }
    }
  }
}

function drawPinks(){
  ctx.save();
  ctx.fillStyle = PINK;
  for(const c of pinks){
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* Silhouette animation + hand indicator + HUD                         */
/* ------------------------------------------------------------------ */

function animateSilhouette(){
  for(const obj of silhouetteMap.values()){
    obj.dispX += (obj.targetX - obj.dispX) * SMOOTHING;
    obj.dispY += (obj.targetY - obj.dispY) * SMOOTHING;
  }
}

// In demo mode the person is drawn as a pixelated grey stand-in (no webcam).
// The pink hit-flash from the jellyfish is shown on top in both modes.
function drawPersonHits(){
  const now = performance.now();
  ctx.save();
  for(const obj of silhouetteMap.values()){
    if(obj.hitStart && obj.hitDuration){
      const t = (now - obj.hitStart) / obj.hitDuration;
      if(t < 1){
        ctx.globalAlpha = 1 - Math.min(1, t);
        ctx.fillStyle = PINK;
        ctx.fillRect(obj.dispX - SQUARE / 2, obj.dispY - SQUARE / 2, SQUARE, SQUARE);
      }
    }
  }
  ctx.restore();
}

function drawDemoPerson(){
  ctx.save();
  ctx.fillStyle = PERSON_TINT;
  for(const obj of silhouetteMap.values()){
    ctx.fillRect(obj.dispX - SQUARE / 2, obj.dispY - SQUARE / 2, SQUARE, SQUARE);
  }
  ctx.restore();
}

function drawHands(){
  const flash = Math.max(0, 1 - (performance.now() - lastCatchAt) / 200);
  ctx.save();
  for(const h of hands){
    ctx.lineWidth = 2 + flash * 3;
    ctx.strokeStyle = `rgba(250,163,0,${0.5 + flash * 0.4})`;
    ctx.beginPath();
    ctx.arc(h.x, h.y, CATCH_RADIUS, 0, Math.PI * 2);
    ctx.stroke();
    if(flash > 0){
      ctx.globalAlpha = flash * 0.25;
      ctx.fillStyle = ORANGE;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
}

function updateScoreLabel(){
  const el = document.getElementById('score');
  if(el) el.textContent = String(score);
}

/* ------------------------------------------------------------------ */
/* Presence / game lifecycle                                           */
/* ------------------------------------------------------------------ */

function startGame(now){
  particles = [];
  dissolveParticles = [];
  pinks = [];
  pinkEnabled = false;
  pinkPhaseStart = null;
  score = 0;
  escapes = 0;
  demoRemoved.clear();
  gameStart = now;
  lastEmit = now;
  updateScoreLabel();
}

function resetScene(){
  silhouettePoints = [];
  silhouetteMap.clear();
  particles = [];
  dissolveParticles = [];
  pinks = [];
  pinkEnabled = false;
  pinkPhaseStart = null;
}

function updatePersonPresence(segmentation){
  const data = segmentation.data;
  let areaCount = 0, minX = width, maxX = 0, minY = height, maxY = 0;
  for(let y = 0; y < height; y += 4){
    for(let x = 0; x < width; x += 4){
      if(data[y * width + x] === 1){
        areaCount++;
        if(x < minX) minX = x; if(x > maxX) maxX = x;
        if(y < minY) minY = y; if(y > maxY) maxY = y;
      }
    }
  }
  const areaRatio = areaCount / ((width * height) / 16);
  const boxWidth = maxX - minX, boxHeight = maxY - minY;
  const isLargeEnough = areaRatio > 0.02 && boxWidth > width * 0.2 && boxHeight > height * 0.28;

  if(isLargeEnough){
    if(!personDetected){ personDetected = true; startGame(performance.now()); }
    updateMask(segmentation);
    sampleSilhouette(segmentation);
  } else if(personDetected){
    personDetected = false;
    resetScene();
  }
}

/* ------------------------------------------------------------------ */
/* Demo mode: synthetic humanoid + auto hands                          */
/* ------------------------------------------------------------------ */

function buildDemoBaseCells(){
  demoBaseCells = [];
  const shapes = [
    { cx: 0,   cy: -120, rx: 30, ry: 36 }, // head
    { cx: 0,   cy: -12,  rx: 46, ry: 78 }, // torso
    { cx: -58, cy: -18,  rx: 15, ry: 58 }, // left arm
    { cx: 58,  cy: -18,  rx: 15, ry: 58 }, // right arm
    { cx: -22, cy: 118,  rx: 17, ry: 70 }, // left leg
    { cx: 22,  cy: 118,  rx: 17, ry: 70 }  // right leg
  ];
  const inside = (x, y) => shapes.some(s => {
    const dx = (x - s.cx) / s.rx, dy = (y - s.cy) / s.ry;
    return dx * dx + dy * dy <= 1;
  });
  for(let y = -170; y <= 200; y += SAMPLE){
    for(let x = -90; x <= 90; x += SAMPLE){
      if(inside(x, y)){
        const relKeyX = Math.round(x / SAMPLE);
        const relKeyY = Math.round(y / SAMPLE);
        demoBaseCells.push({ relX: x, relY: y, relKeyX, relKeyY, relKey: relKeyX + "_" + relKeyY });
      }
    }
  }
}

function updateDemoSilhouette(now){
  bodyCenter.x = width / 2 + Math.sin(now * 0.0007) * 20;
  bodyCenter.y = height / 2 + Math.sin(now * 0.001) * 10;
  const newMap = new Map();
  silhouettePoints = [];
  for(const c of demoBaseCells){
    if(demoRemoved.has(c.relKey)) continue;
    const targetX = bodyCenter.x + c.relX;
    const targetY = bodyCenter.y + c.relY;
    const existing = silhouetteMap.get(c.relKey);
    silhouettePoints.push({ x: targetX, y: targetY, relKey: c.relKey, relX: c.relX, relY: c.relY, relKeyX: c.relKeyX, relKeyY: c.relKeyY });
    newMap.set(c.relKey, {
      relX: c.relX, relY: c.relY, relKey: c.relKey, relKeyX: c.relKeyX, relKeyY: c.relKeyY,
      targetX, targetY,
      dispX: existing ? existing.dispX : targetX,
      dispY: existing ? existing.dispY : targetY,
      hitStart: existing ? existing.hitStart : 0,
      hitDuration: existing ? existing.hitDuration : 0
    });
  }
  silhouetteMap = newMap;
}

function updateDemoHands(dt){
  if(DEMO_MOUSE){
    hands = mouse.active ? [{ x: mouse.x, y: mouse.y }] : [];
    return;
  }
  for(const h of demoHands){
    let best = null, bd = Infinity;
    for(const b of particles){
      if(b.state !== 'flying') continue;
      const d = Math.hypot(b.x - h.x, b.y - h.y);
      if(d < bd){ bd = d; best = b; }
    }
    if(best){
      const dx = best.x - h.x, dy = best.y - h.y, m = Math.hypot(dx, dy) || 1;
      h.x += (dx / m) * DEMO_HAND_SPEED * dt / 16;
      h.y += (dy / m) * DEMO_HAND_SPEED * dt / 16;
    } else {
      h.x += (h.homeX - h.x) * 0.05;
      h.y += (h.homeY - h.y) * 0.05;
    }
  }
  hands = demoHands.map(h => ({ x: h.x, y: h.y }));
}

/* ------------------------------------------------------------------ */
/* Main loop                                                           */
/* ------------------------------------------------------------------ */

let last = performance.now();
function frame(){
  const now = performance.now();
  const dt = Math.min(48, now - last); last = now;

  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if(DEMO) updateDemoSilhouette(now);

  if(personDetected){
    animateSilhouette();

    if(DEMO) drawDemoPerson();
    else drawPerson();
    drawPersonHits();

    const difficulty = Math.min(1, (now - gameStart) / GAME_DIFFICULTY_RAMP);
    const emitInterval = EMIT_INTERVAL_START + (EMIT_INTERVAL_END - EMIT_INTERVAL_START) * difficulty;
    if(now - lastEmit > emitInterval){
      lastEmit = now;
      const count = 1 + Math.floor(difficulty * 1.6 + Math.random() * 0.6);
      for(let k = 0; k < count; k++) emitBlock(difficulty);
    }

    if(DEMO) updateDemoHands(dt);
    updateBlocks(dt, now);
    drawBlocks();

    updateDissolve(now, dt);
    drawDissolveParticles();

    if(pinkEnabled && pinkPhaseStart){
      const phase = Math.min(1, (now - pinkPhaseStart) / PINK_ESCALATION_DURATION);
      const spawnChance = MIN_PINK_SPAWN + (MAX_PINK_SPAWN - MIN_PINK_SPAWN) * phase;
      if(Math.random() < spawnChance) spawnPink();
    }
    updatePinks(dt);
    drawPinks();

    drawHands();
  }

  requestAnimationFrame(frame);
}

async function segmentationLoop(){
  while(true){
    if(net && video && video.readyState >= 2){
      try{
        const segmentation = await net.segmentPerson(video, {
          internalResolution: 'medium',
          segmentationThreshold: 0.7,
          maxDetections: 1
        });
        hands = getHandsFromPoses(segmentation.allPoses);
        updatePersonPresence(segmentation);
      }catch(e){ console.error('segmentation error', e); }
    }
    await new Promise(r => setTimeout(r, SEGMENT_INTERVAL));
  }
}

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */

(async function init(){
  if(DEMO){
    width = 640; height = 480;
    setupCanvas();
    buildDemoBaseCells();
    demoHands = [
      { x: width / 2 - 130, y: height / 2, homeX: width / 2 - 130, homeY: height / 2 },
      { x: width / 2 + 130, y: height / 2, homeX: width / 2 + 130, homeY: height / 2 }
    ];
    personDetected = true;
    startGame(performance.now());
    if(DEMO_MOUSE){
      window.addEventListener('mousemove', e => {
        const r = canvas.getBoundingClientRect();
        mouse.x = (e.clientX - r.left) * (width / r.width);
        mouse.y = (e.clientY - r.top) * (height / r.height);
        mouse.active = true;
      });
    }
    // unlock audio on first interaction (browser autoplay policy)
    window.addEventListener('pointerdown', ensureAudio, { once: true });
    window.addEventListener('keydown', ensureAudio, { once: true });
    frame();
    return;
  }

  try{
    await setupCamera();
    setupCanvas();
    await loadModel();
    window.addEventListener('pointerdown', ensureAudio, { once: true });
    frame();
    segmentationLoop();
  }catch(e){
    console.error(e);
    const hint = document.getElementById('hint');
    if(hint) hint.textContent = 'לא ניתן לגשת למצלמה. אפשר לבדוק את המשחק במצב הדגמה: index.html?demo=1';
  }
})();

window.addEventListener('resize', () => {
  if(canvas){ canvas.width = width; canvas.height = height; }
});
