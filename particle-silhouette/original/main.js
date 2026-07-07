const ORANGE = '#FAA300';
console.log('DEBUG: loaded Documents/main.js — ORANGE=' + ORANGE + ' — ' + new Date().toISOString());
const PINK = '#FF64CB';
const BACKGROUND = '#FFFFFF';
const SAMPLE = 3; // smaller grid for a clearer pixelated silhouette (reduced for better tracking)
const SQUARE = SAMPLE; // drawn square size
const SEGMENT_INTERVAL = 60; // ms between segmentation calls (faster updates)
const PINK_FLASH_MIN = 900; // ms
const PINK_FLASH_MAX = 1400; // ms
const SMOOTHING = 0.28; // increased smoothing for more stable body center tracking
const MAX_PINK_SPAWN = 0.18; // highest per-frame chance after escalation
const MIN_PINK_SPAWN = 0.02; // initial pink spawn chance after 7s
const PINK_ESCALATION_DURATION = 18000; // 18 seconds from 7s to 25s
const DISSOLVE_START = 35000; // start dissolving 35 seconds after pink phase begins
const DISSOLVE_RAMP = 16000; // how fast the dissolve accelerates
const DISSOLVE_BASE_RATE = 0.0015;
const DISSOLVE_MAX_RATE = 0.08;
const DISSOLVE_EXIT_MARGIN = 140;
const DISSOLVE_FADE_RATE = 0.0004; // fade speed for detached squares after they leave the figure

const touchSound = new Audio('Electric SHOCK.mp3');
touchSound.preload = 'auto';
touchSound.volume = 0.75;
let audioContext = null;
function playTouchSound(){
  if(touchSound.readyState >= 2){
    touchSound.currentTime = 0;
    touchSound.play().catch(()=>{});
    return;
  }
  if(!audioContext){
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(340, audioContext.currentTime);
  gain.gain.setValueAtTime(0.16, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.12);
  osc.connect(gain).connect(audioContext.destination);
  osc.start();
  osc.stop(audioContext.currentTime + 0.12);
}

let video, canvas, ctx, net;
let width = 640, height = 480;
let silhouettePoints = [];
let silhouetteMap = new Map(); // keys: relX_relY -> {relX,relY,targetX,targetY,dispX,dispY,hitStart,hitDuration}
let bodyCenter = {x: width / 2, y: height / 2};
let particles = [];
let dissolveParticles = [];
let pinks = [];
let personDetected = false;
let pinkEnabled = false;
let pinkSpawner = null;
let personStartTimer = null;
let pinkPhaseStart = null;

async function setupCamera(){
  video = document.getElementById('video');
  const stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:'user'}});
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
  // Use a higher-accuracy backbone for improved segmentation when possible
  try{
    net = await bodyPix.load({architecture:'ResNet50', outputStride:8, multiplier:1.0});
  }catch(e){
    // fallback to MobileNet if ResNet fails (device constraints)
    net = await bodyPix.load({architecture:'MobileNetV1', outputStride:8, multiplier:1.0});
  }
}

function sampleSilhouette(segmentation){
  const data = segmentation.data;
  const newMap = new Map();
  silhouettePoints = [];
  const tempPoints = [];
  let minX = width, minY = height, maxX = 0, maxY = 0;

  for(let y=0;y<height;y+=SAMPLE){
    for(let x=0;x<width;x+=SAMPLE){
      const idx = y*width + x;
      if(data[idx] === 1){
        let neighbors = 0;
        for(let yy=-2; yy<=2; yy+=2){
          for(let xx=-2; xx<=2; xx+=2){
            const nx = x + xx;
            const ny = y + yy;
            if(nx >= 0 && nx < width && ny >= 0 && ny < height){
              if(data[ny*width + nx] === 1) neighbors++;
            }
          }
        }
          if(neighbors < 3) continue;
        const gx = Math.floor(x / SAMPLE);
        const gy = Math.floor(y / SAMPLE);
        const cx = width - (gx * SAMPLE + SAMPLE/2);
        const cy = gy * SAMPLE + SAMPLE/2;
        tempPoints.push({gx, gy, cx, cy});
        if(cx < minX) minX = cx;
        if(cx > maxX) maxX = cx;
        if(cy < minY) minY = cy;
        if(cy > maxY) maxY = cy;
      }
    }
  }

  if(!tempPoints.length){
    silhouetteMap = newMap;
    return;
  }

    const frameCenterX = (minX + maxX) / 2;
    const frameCenterY = (minY + maxY) / 2;
    // Smooth body center movement to reduce jitter
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

    silhouettePoints.push({
      x: targetX,
      y: targetY,
      relKey,
      relX,
      relY,
      relKeyX,
      relKeyY,
      gx: p.gx,
      gy: p.gy
    });

    newMap.set(relKey, {
      relX,
      relY,
      relKey,
      relKeyX,
      relKeyY,
      targetX,
      targetY,
      dispX: existing ? existing.dispX : targetX,
      dispY: existing ? existing.dispY : targetY,
      gx: p.gx,
      gy: p.gy,
      hitStart: existing ? existing.hitStart : 0,
      hitDuration: existing ? existing.hitDuration : 0
    });
  }

  silhouetteMap = newMap;
}

function emitParticle(){
  if(silhouettePoints.length===0) return;
  const p = silhouettePoints[Math.floor(Math.random()*silhouettePoints.length)];
  const angle = Math.random()*Math.PI*2;
  const escaped = Math.random() < 0.35;
  const speed = escaped ? 1.2 + Math.random()*2.8 : 0.35 + Math.random()*3.4;
  const size = (Math.random() < 0.15)
    ? 2 + Math.random()*2
    : (Math.random() < 0.45)
      ? 6 + Math.random()*4
      : 12 + Math.random()*10;
  const life = escaped ? 2200 + Math.random()*2800 : 1000 + Math.random()*2200;
  const key = p.relKey;
  particles.push({
    x: p.x + (Math.random()-0.5)*SQUARE * 0.4,
    y: p.y + (Math.random()-0.5)*SQUARE * 0.4,
    vx: Math.cos(angle)*speed,
    vy: Math.sin(angle)*speed,
    size,
    life,
    born: performance.now(),
    sourceKey: key,
    sourceX: p.x,
    sourceY: p.y,
    escaped,
    jitter: Math.random()*0.02
  });
}

function updateParticles(dt){
  const now = performance.now();
  for(let i=particles.length-1;i>=0;i--){
    const a = particles[i];
    if(!a.escaped){
      if(a.sourceKey && silhouetteMap.has(a.sourceKey)){
        const src = silhouetteMap.get(a.sourceKey);
        a.sourceX = src.dispX;
        a.sourceY = src.dispY;
      } else if(silhouettePoints.length){
        const p = silhouettePoints[Math.floor(Math.random()*silhouettePoints.length)];
        a.sourceKey = p.relKey;
        a.sourceX = p.x;
        a.sourceY = p.y;
      }
      const dx = a.sourceX - a.x;
      const dy = a.sourceY - a.y;
      const dist = Math.hypot(dx,dy) || 1;
      a.vx += (dx / dist) * 0.02;
      a.vy += (dy / dist) * 0.02;
      a.vx += (Math.random()-0.5) * a.jitter;
      a.vy += (Math.random()-0.5) * a.jitter;
    }
    a.vx *= 0.96;
    a.vy *= 0.96;
    a.x += a.vx * dt/16;
    a.y += a.vy * dt/16;
    const age = now - a.born;
    if(age > a.life) particles.splice(i,1);
  }
}

function detachSilhouetteCell(cell, now){
  silhouetteMap.delete(cell.relKey);
  silhouettePoints = silhouettePoints.filter(p => p.relKey !== cell.relKey);

  const edge = Math.floor(Math.random()*4);
  let destX, destY;
  if(edge===0){ destX = Math.random()*width; destY = -80; }
  else if(edge===1){ destX = width + 80; destY = Math.random()*height; }
  else if(edge===2){ destX = Math.random()*width; destY = height + 80; }
  else { destX = -80; destY = Math.random()*height; }

  const dx = destX - cell.dispX;
  const dy = destY - cell.dispY;
  const distance = Math.hypot(dx, dy) || 1;
  const speed = 2.4 + Math.random() * 1.6;
  const vx = (dx / distance) * speed + (Math.random()-0.5) * 0.35;
  const vy = (dy / distance) * speed + (Math.random()-0.5) * 0.35;
  // compute a conservative offscreen removal distance from the start point
  const startX = cell.dispX;
  const startY = cell.dispY;
  const removalX = destX > width/2 ? width + DISSOLVE_EXIT_MARGIN : -DISSOLVE_EXIT_MARGIN;
  const removalY = destY > height/2 ? height + DISSOLVE_EXIT_MARGIN : -DISSOLVE_EXIT_MARGIN;
  const offscreenDist = Math.hypot(removalX - startX, removalY - startY) || distance;

  dissolveParticles.push({
    x: startX,
    y: startY,
    vx,
    vy,
    size: SQUARE + Math.random() * SQUARE,
    alpha: 1,
    fading: false,
    destX,
    destY,
    startX,
    startY,
    offscreenDist,
    born: now
  });
}

function updateDissolveParticles(dt){
  for(let i=dissolveParticles.length-1;i>=0;i--){
    const p = dissolveParticles[i];
    const dx = p.destX - p.x;
    const dy = p.destY - p.y;
    const dist = Math.hypot(dx, dy) || 1;
    p.vx += (dx / dist) * 0.005;
    p.vy += (dy / dist) * 0.005;
    p.vx *= 0.993;
    p.vy *= 0.993;
    p.vy -= 0.002 * dt/16;
    p.x += p.vx * dt/16;
    p.y += p.vy * dt/16;

    const relKeyX = Math.round((p.x - bodyCenter.x) / SAMPLE);
    const relKeyY = Math.round((p.y - bodyCenter.y) / SAMPLE);
    const relKey = `${relKeyX}_${relKeyY}`;
    // start fading immediately when the square is no longer inside the current silhouette
    if(!p.fading && !silhouetteMap.has(relKey)){
      p.fading = true;
    }

    if(p.fading){
      const traveled = Math.hypot(p.x - p.startX, p.y - p.startY);
      // fade proportionally to progress toward the offscreen removal distance
      p.alpha = Math.max(0, 1 - (traveled / (p.offscreenDist || 1)));
    }

    if(p.x < -DISSOLVE_EXIT_MARGIN || p.x > width + DISSOLVE_EXIT_MARGIN || p.y < -DISSOLVE_EXIT_MARGIN || p.y > height + DISSOLVE_EXIT_MARGIN){
      dissolveParticles.splice(i,1);
    }
  }
}

function updateDissolve(now, dt){
  if(!pinkPhaseStart || !silhouettePoints.length) return;
  const elapsed = now - pinkPhaseStart;
  if(elapsed <= DISSOLVE_START) return;

  const dissolveElapsed = elapsed - DISSOLVE_START;
  const progress = Math.min(1, dissolveElapsed / DISSOLVE_RAMP);
  const detachChance = DISSOLVE_BASE_RATE + progress * DISSOLVE_MAX_RATE;

  for(const cell of Array.from(silhouetteMap.values())){
    if(Math.random() < detachChance * dt/16){
      detachSilhouetteCell(cell, now);
    }
  }

  updateDissolveParticles(dt);
}

function drawDissolveParticles(){
  ctx.save();
  for(const p of dissolveParticles){
    ctx.globalAlpha = p.alpha;
    ctx.fillStyle = ORANGE;
    ctx.fillRect(p.x - p.size/2, p.y - p.size/2, p.size, p.size);
  }
  ctx.restore();
}

function drawParticles(){
  ctx.save();
  for(const p of particles){
    ctx.fillStyle = ORANGE;
    ctx.fillRect(p.x - p.size/2, p.y - p.size/2, p.size, p.size);
  }
  ctx.restore();
}

function spawnPink(){
  const edge = Math.floor(Math.random()*4);
  let x,y;
  if(edge===0){ x = Math.random()*width; y = -20; }
  else if(edge===1){ x = width+20; y = Math.random()*height; }
  else if(edge===2){ x = Math.random()*width; y = height+20; }
  else { x = -20; y = Math.random()*height; }
  let target = {x: width/2, y: height/2};
  if(silhouettePoints.length){
    target = silhouettePoints[Math.floor(Math.random()*silhouettePoints.length)];
  }
  const dx = target.x - x;
  const dy = target.y - y;
  const mag = Math.hypot(dx,dy)||1;
  const speed = 0.7 + Math.random()*0.75;
  pinks.push({
    x,y,
    vx:dx/mag*speed,
    vy:dy/mag*speed,
    targetX: target.x,
    targetY: target.y,
    r:10+Math.random()*16,
    born:performance.now(),
    attached: false,
    attachedTime: 0,
    attachDuration: 0,
    attachKey: null
  });
}

function updatePinks(dt){
  for(let i=pinks.length-1;i>=0;i--){
    const c = pinks[i];
    const now = performance.now();
    if(c.attached){
      if(c.attachKey && silhouetteMap.has(c.attachKey)){
        const cell = silhouetteMap.get(c.attachKey);
        c.x = cell.dispX;
        c.y = cell.dispY;
      } else if(c.attachOffsetX !== undefined && c.attachOffsetY !== undefined){
        c.x = bodyCenter.x + c.attachOffsetX;
        c.y = bodyCenter.y + c.attachOffsetY;
      }
      c.attachedTime = now - c.attachStart;
      if(c.attachedTime > c.attachDuration){
        pinks.splice(i,1);
      }
      continue;
    }
    if(silhouettePoints.length){
      if(!c.targetX || Math.random() < 0.005){
        const target = silhouettePoints[Math.floor(Math.random()*silhouettePoints.length)];
        c.targetX = target.x;
        c.targetY = target.y;
      }
      const dx = c.targetX - c.x;
      const dy = c.targetY - c.y;
      const mag = Math.hypot(dx, dy) || 1;
      c.vx += (dx / mag) * 0.045;
      c.vy += (dy / mag) * 0.045;
      c.vx += (Math.random()-0.5) * 0.06;
      c.vy += (Math.random()-0.5) * 0.06;
      const speed = Math.hypot(c.vx, c.vy);
      if(speed > 3) {
        c.vx *= 0.92;
        c.vy *= 0.92;
      }
    }
    c.x += c.vx * dt/16;
    c.y += c.vy * dt/16;
    if(c.x < -60 || c.x > width+60 || c.y < -60 || c.y > height+60) {
      pinks.splice(i,1);
    } else {
      checkPinkCollision(c);
    }
  }
}

function resetScene(){
  silhouettePoints = [];
  silhouetteMap.clear();
  particles = [];
  dissolveParticles = [];
  pinks = [];
  pinkEnabled = false;
  if(pinkSpawner){
    clearInterval(pinkSpawner);
    pinkSpawner = null;
  }
  if(personStartTimer){
    clearTimeout(personStartTimer);
    personStartTimer = null;
  }
}

function startPersonSequence(){
  particles = [];
  dissolveParticles = [];
  pinks = [];
  pinkEnabled = false;
  pinkPhaseStart = null;
  if(pinkSpawner){
    clearInterval(pinkSpawner);
    pinkSpawner = null;
  }
  if(personStartTimer){
    clearTimeout(personStartTimer);
    personStartTimer = null;
  }
  personStartTimer = setTimeout(()=>{
    personStartTimer = null;
    if(personDetected){
      pinkEnabled = true;
      pinkPhaseStart = performance.now();
    }
  },7000);
}

function updatePersonPresence(segmentation){
  const data = segmentation.data;
  let areaCount = 0;
  let minX = width, maxX = 0, minY = height, maxY = 0;
  for(let y=0;y<height;y+=4){
    for(let x=0;x<width;x+=4){
      const idx = y*width + x;
      if(data[idx] === 1){
        areaCount++;
        if(x < minX) minX = x;
        if(x > maxX) maxX = x;
        if(y < minY) minY = y;
        if(y > maxY) maxY = y;
      }
    }
  }
  const areaRatio = areaCount / ((width * height) / 16);
  const boxWidth = maxX - minX;
  const boxHeight = maxY - minY;
  const bodyArea = boxWidth * boxHeight;
  const minArea = (width * height) * 0.025;
  const isLargeEnough = areaRatio > 0.02 && boxWidth > width * 0.25 && boxHeight > height * 0.32 && bodyArea > minArea;

  if(isLargeEnough){
    if(!personDetected){
      personDetected = true;
      startPersonSequence();
    }
    sampleSilhouette(segmentation);
  } else {
    if(personDetected){
      personDetected = false;
      resetScene();
    }
  }
}

function checkPinkCollision(circle){
  if(circle.attached) return;
  const now = performance.now();
  const candidates = [];

  for(const p of silhouettePoints){
    const d = Math.hypot(p.x - circle.x, p.y - circle.y);
    if(d < circle.r + SAMPLE * 0.9){
      candidates.push({point: p, dist: d});
    }
  }

  if(candidates.length){
    const choice = candidates[Math.floor(Math.random() * candidates.length)];
    const p = choice.point;
    const cell = silhouetteMap.get(p.relKey);
    if(!cell) return;

    circle.attached = true;
    circle.attachKey = p.relKey;
    circle.attachOffsetX = cell.relX;
    circle.attachOffsetY = cell.relY;
    circle.attachStart = now;
    circle.attachDuration = 1200 + Math.random()*1000;
    circle.vx = 0;
    circle.vy = 0;
    playTouchSound();

    const spread = 3;
    for(let sy=-spread; sy<=spread; sy++){
      for(let sx=-spread; sx<=spread; sx++){
        const nkey = (cell.relKeyX + sx) + "_" + (cell.relKeyY + sy);
        const neighbor = silhouetteMap.get(nkey);
        if(neighbor){
          const dist = Math.hypot(sx, sy);
          if(dist <= spread + 0.2){
            const intensity = 1 - (dist / (spread + 0.2));
            neighbor.hitStart = now;
            neighbor.hitDuration = 1200 + intensity * 1000;
          }
        }
      }
    }
  }
}

function animateSilhouette(){
  for(const obj of silhouetteMap.values()){
    obj.dispX += (obj.targetX - obj.dispX) * SMOOTHING;
    obj.dispY += (obj.targetY - obj.dispY) * SMOOTHING;
  }
}

function drawSilhouette(now, dissolveProgress = 0){
  const baseAlpha = 1;
  for(const obj of silhouetteMap.values()){
    ctx.save();
    ctx.globalAlpha = baseAlpha;
    ctx.fillStyle = ORANGE;
    ctx.fillRect(obj.dispX - SQUARE/2, obj.dispY - SQUARE/2, SQUARE, SQUARE);
    ctx.restore();
    if(obj.hitStart && obj.hitDuration){
      const t = (now - obj.hitStart) / obj.hitDuration;
      if(t < 1){
        const alpha = (1 - Math.min(1, t)) * baseAlpha;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = PINK;
        ctx.fillRect(obj.dispX - SQUARE/2, obj.dispY - SQUARE/2, SQUARE, SQUARE);
        ctx.restore();
      }
    }
  }
}

let last = performance.now();
async function frame(){
  const now = performance.now();
  const dt = now - last; last = now;
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if(personDetected){
    animateSilhouette();
    const dissolveElapsed = pinkPhaseStart ? Math.max(0, now - pinkPhaseStart - DISSOLVE_START) : 0;
    const dissolveProgress = Math.min(1, dissolveElapsed / DISSOLVE_RAMP);
    drawSilhouette(now, dissolveProgress);
    const emissions = 1 + Math.floor(Math.random()*3);
    for(let i=0;i<emissions;i++) emitParticle();
    updateParticles(dt);
    drawParticles();
    if(pinkEnabled && pinkPhaseStart){
      const elapsed = now - pinkPhaseStart;
      const phase = Math.min(1, elapsed / PINK_ESCALATION_DURATION);
      const spawnChance = MIN_PINK_SPAWN + (MAX_PINK_SPAWN - MIN_PINK_SPAWN) * phase;
      const burst = elapsed > PINK_ESCALATION_DURATION * 0.7 ? 1 : 0;
      if(Math.random() < spawnChance) spawnPink();
      if(burst && Math.random() < spawnChance * 0.4) spawnPink();
    }
    updatePinks(dt);
    for(const c of pinks){
      ctx.beginPath(); ctx.fillStyle = PINK; ctx.arc(c.x, c.y, c.r, 0, Math.PI*2); ctx.fill();
    }
  }

  requestAnimationFrame(frame);
}

async function segmentationLoop(){
  while(true){
    if(net && video && video.readyState >= 2){
      // Use full internal resolution for best accuracy; slightly lower threshold to reduce dropouts
      const segmentation = await net.segmentPerson(video, {internalResolution:'full', segmentationThreshold:0.7});
      updatePersonPresence(segmentation);
    }
    await new Promise(resolve => setTimeout(resolve, SEGMENT_INTERVAL));
  }
}

(async function init(){
  try{
    await setupCamera();
    setupCanvas();
    await loadModel();
    frame();
    segmentationLoop();
  }catch(e){
    console.error(e);
  }
})();

window.addEventListener('resize', ()=>{
  canvas.width = width; canvas.height = height;
});
