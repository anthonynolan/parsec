(() => {
'use strict';
/* Sprint — Super Sprint style top-down arcade racer.
   Whole track on one screen, 4 cars (you + 3 AI), 3 laps.
   Gas/brake/steer physics, walls slow you down, oil spins you,
   turbo arrows boost you, wrenches score. */

const W = 960;
const H = 540;
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

// Adaptive view: the canvas always fills its container exactly. The 960x540
// world is never stretched or cropped; on wider/taller containers the camera
// simply sees more grass around it.
let view = { scale: 1, ox: 0, oy: 0, vw: W, vh: H };
function resize() {
  try {
    const stage = document.getElementById('stage');
    const r = stage.getBoundingClientRect();
    if (!r || r.width < 2 || r.height < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    // Fit height on wide containers (extend the sides), fit width on narrow
    // ones (extend top/bottom) — the world is always fully visible.
    const base = (r.width / r.height) >= W / H ? r.height / H : r.width / W;
    const scale = base * dpr;
    const vw = canvas.width / scale;
    const vh = canvas.height / scale;
    view = { scale, ox: (vw - W) / 2, oy: (vh - H) / 2, vw, vh };
  } catch (e) { /* keep previous view */ }
}

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
function angDiff(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

// ---------- track ----------
// TRACK_OY shifts the whole circuit down to leave room for the scoreboard,
// like the original cabinet. All geometry stays relative, so physics is unchanged.
const TRACK_OY = 28;
const PTS = [
  [300, 120], [470, 95], [640, 105], [770, 160],
  [830, 250], [790, 340], [700, 375], [650, 440],
  [500, 455], [350, 445], [225, 395], [165, 305],
  [185, 210], [245, 145],
].map(([x, y]) => [x, y + TRACK_OY]);
const NSEG = PTS.length;
const ROAD_HALF = 46;
const LAPS = 3;

const SEGS = [];
for (let i = 0; i < NSEG; i++) {
  const a = PTS[i];
  const b = PTS[(i + 1) % NSEG];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  SEGS.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1], dx, dy, len, ux: dx / len, uy: dy / len });
}

function nearestOnTrack(x, y) {
  let bestD = Infinity;
  let bestI = 0;
  let bestT = 0;
  let bestPx = 0;
  let bestPy = 0;
  for (let i = 0; i < NSEG; i++) {
    const s = SEGS[i];
    const px = x - s.ax;
    const py = y - s.ay;
    let t = (px * s.dx + py * s.dy) / (s.len * s.len);
    t = clamp(t, 0, 1);
    const cx = s.ax + s.dx * t;
    const cy = s.ay + s.dy * t;
    const d = Math.hypot(x - cx, y - cy);
    if (d < bestD) { bestD = d; bestI = i; bestT = t; bestPx = cx; bestPy = cy; }
  }
  return { d: bestD, i: bestI, t: bestT, px: bestPx, py: bestPy };
}

function trackPoint(segI, t, lateral) {
  const s = SEGS[((segI % NSEG) + NSEG) % NSEG];
  const cx = s.ax + s.dx * t;
  const cy = s.ay + s.dy * t;
  return { x: cx + -s.uy * lateral, y: cy + s.ux * lateral, ux: s.ux, uy: s.uy };
}

// Outward normal of a segment: whichever side is farther from the loop centroid.
const CENT = PTS.reduce((a, p) => ({ x: a.x + p[0] / NSEG, y: a.y + p[1] / NSEG }), { x: 0, y: 0 });
function outNormal(i) {
  const s = SEGS[((i % NSEG) + NSEG) % NSEG];
  const mx = (s.ax + s.bx) / 2;
  const my = (s.ay + s.by) / 2;
  const nx = -s.uy;
  const ny = s.ux;
  const d1 = (mx + nx * 60 - CENT.x) ** 2 + (my + ny * 60 - CENT.y) ** 2;
  const d2 = (mx - nx * 60 - CENT.x) ** 2 + (my - ny * 60 - CENT.y) ** 2;
  const sgn = d1 > d2 ? 1 : -1;
  return { x: nx * sgn, y: ny * sgn };
}

// Yellow/black corner barriers (like the original): a striped chord across the
// outside of every sharp joint.
const BARRIERS = [];
for (let j = 0; j < NSEG; j++) {
  const prev = SEGS[((j - 1) % NSEG + NSEG) % NSEG];
  const cur = SEGS[j];
  const turn = Math.abs(angDiff(Math.atan2(prev.uy, prev.ux), Math.atan2(cur.uy, cur.ux)));
  if (turn > 0.42) {
    const o1 = outNormal(j - 1);
    const o2 = outNormal(j);
    const a = trackPoint(j - 1, 0.72, 0);
    const b = trackPoint(j, 0.28, 0);
    BARRIERS.push({
      x1: a.x + o1.x * (ROAD_HALF + 14), y1: a.y + o1.y * (ROAD_HALF + 14),
      x2: b.x + o2.x * (ROAD_HALF + 14), y2: b.y + o2.y * (ROAD_HALF + 14),
    });
  }
}

// Red direction chevrons painted on the asphalt, every other segment.
const CHEVRONS = [];
for (let i = 1; i < NSEG; i += 2) {
  const p = trackPoint(i, 0.5, 0);
  CHEVRONS.push({ x: p.x, y: p.y, angle: Math.atan2(p.uy, p.ux) });
}

// Decorations, kept only where they are safely off the road (checked at draw).
const TREES = [
  [90, 170], [90, 420], [895, 170], [895, 420], [60, 295], [910, 295],
  [490, 320], [420, 360], [560, 360], [370, 290], [610, 290], [490, 420],
  [250, 90], [710, 90],
];
const TENTS = [[300, 330], [680, 330]];
const HELI_SPOTS = [[490, 300], [450, 330], [530, 330], [490, 360]];

// Fixed hazards / bonuses on the road.
const OILS = [3, 6, 9, 11].map((seg, k) => {
  const p = trackPoint(seg, 0.5, k % 2 === 0 ? 12 : -12);
  return { x: p.x, y: p.y, r: 13 };
});
const TURBOS = [2, 7, 10].map((seg) => {
  const p = trackPoint(seg, 0.5, 0);
  return { x: p.x, y: p.y, ux: p.ux, uy: p.uy, r: 20 };
});
const WRENCH_SPOTS = [4, 8, 12].map((seg) => {
  const p = trackPoint(seg, 0.55, 0);
  return { x: p.x, y: p.y, taken: 0 };
});

// ---------- audio ----------
let AC = null;
let masterGain = null;
let engineOsc = null;
let engineGain = null;
function audio() {
  if (AC) return AC;
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    AC = new Ctor();
    masterGain = AC.createGain();
    masterGain.gain.value = 0.35;
    masterGain.connect(AC.destination);
  } catch (e) { AC = null; }
  return AC;
}
function tone(freq, dur, type, vol, slideTo, delay) {
  if (G.muted) return;
  const ac = audio();
  if (!ac) return;
  try {
    const t0 = ac.currentTime + (delay || 0);
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type || 'square';
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
    g.gain.setValueAtTime(vol || 0.2, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g); g.connect(masterGain);
    o.start(t0); o.stop(t0 + dur + 0.02);
  } catch (e) { /* no audio */ }
}
function noiseBurst(dur, vol, freq) {
  if (G.muted) return;
  const ac = audio();
  if (!ac) return;
  try {
    const len = Math.floor(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ac.createBufferSource();
    src.buffer = buf;
    const g = ac.createGain();
    g.gain.value = vol || 0.4;
    const f = ac.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = freq || 900;
    src.connect(f); f.connect(g); g.connect(masterGain);
    src.start();
  } catch (e) { /* no audio */ }
}
const sfx = {
  count() { tone(440, 0.15, 'square', 0.25); },
  go() { tone(880, 0.4, 'square', 0.25); },
  crash() { noiseBurst(0.25, 0.4, 700); tone(110, 0.25, 'sawtooth', 0.18, 40); },
  spin() { tone(500, 0.35, 'sawtooth', 0.16, 120); },
  turbo() { tone(200, 0.35, 'sawtooth', 0.16, 900); },
  wrench() { tone(660, 0.08, 'square', 0.16); tone(990, 0.12, 'square', 0.16, null, 0.07); },
  lap() { [523, 659, 784].forEach((f, i) => tone(f, 0.12, 'square', 0.16, null, i * 0.09)); },
  win() { [523, 659, 784, 1046, 784, 1046].forEach((f, i) => tone(f, 0.16, 'square', 0.18, null, i * 0.12)); },
  lose() { [392, 330, 262, 196].forEach((f, i) => tone(f, 0.2, 'square', 0.16, null, i * 0.14)); },
};
function engineStart() {
  const ac = audio();
  if (!ac || engineOsc) return;
  try {
    engineOsc = ac.createOscillator();
    engineGain = ac.createGain();
    engineOsc.type = 'sawtooth';
    engineOsc.frequency.value = 60;
    engineGain.gain.value = 0.0;
    engineOsc.connect(engineGain); engineGain.connect(masterGain);
    engineOsc.start();
  } catch (e) { engineOsc = null; }
}
function engineUpdate(speed) {
  if (!engineOsc || !engineGain) return;
  try {
    const ac = AC;
    if (G.muted || G.screen !== 'race' || G.paused) {
      engineGain.gain.setTargetAtTime(0.0, ac.currentTime, 0.05);
      return;
    }
    engineOsc.frequency.setTargetAtTime(55 + Math.abs(speed) * 0.45, ac.currentTime, 0.05);
    engineGain.gain.setTargetAtTime(0.035, ac.currentTime, 0.05);
  } catch (e) { /* no audio */ }
}

// ---------- state ----------
const G = {
  screen: 'title', // title | countdown | race | done
  paused: false,
  muted: false,
  time: 0,
  countT: 0,
  countStep: -1,
  raceT: 0,
  endT: 0,
  firstFinishT: -1,
  message: null, // {text, sub, t}
  shake: 0,
  winner: null,
};

const DEFS = [
  { name: 'YOU', color: '#ffd23f', dark: '#8a6d00', isPlayer: true, top: 305 },
  { name: 'RED', color: '#ff5252', dark: '#7a1010', isPlayer: false, top: 296 },
  { name: 'BLU', color: '#40c4ff', dark: '#0d4a63', isPlayer: false, top: 286 },
  { name: 'GRN', color: '#69f0ae', dark: '#0d5c34', isPlayer: false, top: 276 },
];

let cars = [];
let parts = [];
let popups = [];

function startPose(k) {
  const s = SEGS[0];
  const row = Math.floor(k / 2);
  const side = k % 2 === 0 ? -1 : 1;
  return {
    x: s.ax - s.ux * (24 + row * 34) + -s.uy * side * 20,
    y: s.ay - s.uy * (24 + row * 34) + s.ux * side * 20,
    angle: Math.atan2(s.uy, s.ux),
  };
}

function resetRace() {
  cars = DEFS.map((d, k) => {
    const p = startPose(k);
    return {
      def: d, x: p.x, y: p.y, angle: p.angle,
      vx: 0, vy: 0, speed: 0,
      segI: 0, prevI: 0, progress: -k * 0.6, lap: 0,
      spinT: 0, spinDir: 1, boostT: 0, oilCd: 0, crashCd: 0,
      lapStart: 0, lastLap: 0, bestLap: 0, finished: false, finishT: 0,
      place: k + 1, wrongT: 0, aiNoise: Math.random() * 100,
      score: 0, wrenches: 0,
    };
  });
  parts = [];
  popups = [];
  WRENCH_SPOTS.forEach((w) => { w.taken = 0; });
  G.time = 0;
  G.raceT = 0;
  G.endT = 0;
  G.firstFinishT = -1;
  G.winner = null;
  G.message = null;
  G.shake = 0;
}

function showMessage(text, sub, dur) {
  G.message = { text, sub: sub || '', t: dur || 2 };
}

// ---------- input ----------
const keys = {};
const touch = { left: false, right: false, gas: false, brake: false };
let padPrev = {};

function playerInput() {
  let steer = 0;
  let gas = false;
  let brake = false;
  if (keys.ArrowLeft || keys.KeyA) steer -= 1;
  if (keys.ArrowRight || keys.KeyD) steer += 1;
  if (keys.ArrowUp || keys.KeyW) gas = true;
  if (keys.ArrowDown || keys.KeyS) brake = true;
  if (touch.left) steer -= 1;
  if (touch.right) steer += 1;
  if (touch.gas) gas = true;
  if (touch.brake) brake = true;
  // gamepad
  try {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const ax = p.axes[0] || 0;
      if (Math.abs(ax) > 0.18) steer += clamp(ax, -1, 1);
      if (p.buttons[7] && p.buttons[7].pressed) gas = true;
      if (p.buttons[0] && p.buttons[0].pressed) gas = true;
      if (p.buttons[6] && p.buttons[6].pressed) brake = true;
      if (p.buttons[1] && p.buttons[1].pressed) brake = true;
      if (p.buttons[9] && p.buttons[9].pressed && !padPrev.start) startRace();
      padPrev.start = !!(p.buttons[9] && p.buttons[9].pressed);
    }
  } catch (e) { /* no gamepad */ }
  return { steer: clamp(steer, -1, 1), gas, brake };
}

function bindHold(id, prop) {
  const el = document.getElementById(id);
  if (!el) return;
  const on = (e) => { e.preventDefault(); touch[prop] = true; audio(); };
  const off = (e) => { e.preventDefault(); touch[prop] = false; };
  el.addEventListener('pointerdown', on);
  el.addEventListener('pointerup', off);
  el.addEventListener('pointercancel', off);
  el.addEventListener('pointerleave', off);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}
bindHold('btnLeft', 'left');
bindHold('btnRight', 'right');
bindHold('btnGas', 'gas');
bindHold('btnBrake', 'brake');

window.addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  if (!e.repeat) {
    if (e.code === 'Enter' || e.code === 'Space') { audio(); engineStart(); startRace(); }
    if (e.code === 'KeyP') G.paused = !G.paused;
    if (e.code === 'KeyM') { G.muted = !G.muted; }
  }
  keys[e.code] = true;
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });

document.getElementById('btnStart').addEventListener('click', () => { audio(); engineStart(); startRace(); });
document.getElementById('btnFull').addEventListener('click', () => {
  try {
    const stage = document.getElementById('stage');
    if (document.fullscreenElement) document.exitFullscreen();
    else if (stage.requestFullscreen) stage.requestFullscreen();
  } catch (e) { /* no fullscreen */ }
});
canvas.addEventListener('pointerdown', () => { audio(); engineStart(); if (G.screen !== 'race') startRace(); });

function startRace() {
  if (G.screen === 'countdown') return;
  resetRace();
  G.screen = 'countdown';
  G.paused = false;
  G.countT = 0;
  G.countStep = -1;
}

// ---------- AI ----------
function aiInput(car, dt) {
  // Look ahead along the track and steer toward it.
  const lookSegs = 2;
  const target = trackPoint(car.segI + lookSegs, 0.5, 0);
  // Add a little wobble so AI lines differ.
  const wob = Math.sin(G.raceT * 1.3 + car.aiNoise) * 10;
  const tx = target.x + -target.uy * wob * 0.3;
  const ty = target.y + target.ux * wob * 0.3;
  const want = Math.atan2(ty - car.y, tx - car.x);
  const diff = angDiff(car.angle, want);
  const steer = clamp(diff * 2.2, -1, 1);
  // Brake for hairpins.
  const sharp = Math.abs(diff) > 0.7 && Math.abs(car.speed) > 180;
  // Rubber band: trailing AI goes a touch faster, leader a touch slower.
  const player = cars[0];
  let rubber = 0;
  if (player && car !== player) rubber = clamp((player.progress - car.progress) * 4, -18, 26);
  car.rubber = rubber;
  return { steer, gas: !sharp, brake: sharp };
}

// ---------- physics ----------
function burst(x, y, n, color, spd) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU;
    const s = (spd || 120) * (0.3 + Math.random() * 0.7);
    parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.5 + Math.random() * 0.4, t: 0, color, size: 2 + Math.random() * 3 });
  }
}

function updateCar(car, inp, dt) {
  const near = nearestOnTrack(car.x, car.y);
  car.segI = near.i;
  const onRoad = near.d <= ROAD_HALF;
  const offRoad = !onRoad;

  // Progress / laps (unwrap segment index).
  let di = (near.i - car.prevI + NSEG) % NSEG;
  if (di > NSEG / 2) di -= NSEG;
  if (Math.abs(di) < NSEG / 2) {
    car.progress += di;
    if (di < 0) car.wrongT += dt;
    else car.wrongT = Math.max(0, car.wrongT - dt * 2);
  }
  car.prevI = near.i;
  const lap = Math.floor(car.progress / NSEG);
  if (lap > car.lap) {
    car.lap = lap;
    const lapTime = G.raceT - car.lapStart;
    car.lapStart = G.raceT;
    car.lastLap = lapTime;
    if (!car.bestLap || lapTime < car.bestLap) car.bestLap = lapTime;
    if (car.def.isPlayer) {
      if (car.lap >= LAPS) {
        // handled by finish check below
      } else {
        sfx.lap();
        showMessage('LAP ' + (car.lap + 1), lapTime.toFixed(1) + 's', 1.6);
      }
      try {
        const prev = parseFloat(localStorage.getItem('sprint_best_lap') || '0');
        if (!prev || lapTime < prev) localStorage.setItem('sprint_best_lap', String(lapTime.toFixed(2)));
      } catch (e) {}
    } else {
      car.score += 250; // drones score for every lap, like the arcade
    }
    if (car.lap >= LAPS && !car.finished) {
      car.finished = true;
      car.finishT = G.raceT;
      burst(car.x, car.y, 26, '#ffffff', 200);
      if (G.firstFinishT < 0) {
        G.firstFinishT = G.raceT;
        G.winner = car;
        if (car.def.isPlayer) { sfx.win(); } else { showMessage(car.def.name + ' WINS', 'catch up next time!', 2.5); sfx.lose(); }
      } else if (car.def.isPlayer) {
        sfx.lap();
      }
    }
  }

  // Timers.
  if (car.spinT > 0) car.spinT -= dt;
  if (car.boostT > 0) car.boostT -= dt;
  if (car.oilCd > 0) car.oilCd -= dt;
  if (car.crashCd > 0) car.crashCd -= dt;

  // Oil slicks.
  if (car.oilCd <= 0 && car.spinT <= 0) {
    for (const o of OILS) {
      const dx = car.x - o.x;
      const dy = car.y - o.y;
      if (dx * dx + dy * dy < o.r * o.r) {
        car.spinT = 0.9;
        car.spinDir = Math.random() < 0.5 ? -1 : 1;
        car.oilCd = 2;
        burst(car.x, car.y, 10, '#111111', 140);
        if (car.def.isPlayer) { sfx.spin(); G.shake = 6; showMessage('OIL!', '', 0.8); }
        break;
      }
    }
  }

  // Turbo pads.
  for (const t of TURBOS) {
    const dx = car.x - t.x;
    const dy = car.y - t.y;
    if (dx * dx + dy * dy < t.r * t.r && car.boostT <= 0) {
      car.boostT = 0.7;
      car.speed = Math.max(car.speed, 400);
      burst(car.x, car.y, 12, '#40c4ff', 180);
      if (car.def.isPlayer) sfx.turbo();
      break;
    }
  }

  // Wrenches (score + tiny boost).
  if (car.def.isPlayer) {
    for (const w of WRENCH_SPOTS) {
      if (w.taken > 0) continue;
      const dx = car.x - w.x;
      const dy = car.y - w.y;
      if (dx * dx + dy * dy < 22 * 22) {
        w.taken = 8;
        car.wrenches += 1;
        car.score += 100;
        car.boostT = Math.max(car.boostT, 0.35);
        popups.push({ x: w.x, y: w.y - 14, text: '+100', t: 1 });
        sfx.wrench();
        break;
      }
    }
  }

  // Steering + throttle.
  let top = car.def.top + (car.rubber || 0);
  if (car.boostT > 0) top = 430;
  if (offRoad) top = Math.min(top, 150);
  const gripK = car.spinT > 0 ? 2.2 : 8;

  if (car.spinT > 0) {
    car.angle += 7 * car.spinDir * dt;
  } else {
    const spdF = clamp(Math.abs(car.speed) / 120, 0, 1);
    const highCut = 1 - clamp(Math.abs(car.speed) / 1100, 0, 0.35);
    car.angle += inp.steer * 3.4 * spdF * highCut * dt * (car.speed >= 0 ? 1 : -1);
  }

  if (inp.gas) car.speed += (car.boostT > 0 ? 620 : 300) * dt;
  if (inp.brake) {
    if (car.speed > 12) car.speed -= 450 * dt;
    else car.speed = Math.max(car.speed - 200 * dt, -85); // reverse
  }
  // Drag.
  car.speed -= car.speed * (offRoad ? 2.2 : 0.55) * dt;
  if (!inp.gas && !inp.brake) car.speed -= car.speed * 0.6 * dt;
  car.speed = clamp(car.speed, -90, top);
  if (Math.abs(car.speed) < 4 && !inp.gas && !inp.brake) car.speed = 0;

  // Velocity follows heading (drift when spinning / fast steering).
  const hx = Math.cos(car.angle);
  const hy = Math.sin(car.angle);
  const k = 1 - Math.exp(-gripK * dt);
  car.vx = lerp(car.vx, hx * car.speed, k);
  car.vy = lerp(car.vy, hy * car.speed, k);
  car.x += car.vx * dt;
  car.y += car.vy * dt;

  // Walls: clamp back inside road + margin, kill outward speed.
  const after = nearestOnTrack(car.x, car.y);
  const LIM = ROAD_HALF + 5;
  if (after.d > LIM) {
    const px = after.px;
    const py = after.py;
    let nx = car.x - px;
    let ny = car.y - py;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl; ny /= nl;
    car.x = px + nx * LIM;
    car.y = py + ny * LIM;
    const out = car.vx * nx + car.vy * ny;
    if (out > 0) { car.vx -= nx * out * 1.6; car.vy -= ny * out * 1.6; }
    if (Math.abs(car.speed) > 120 && car.crashCd <= 0) {
      car.crashCd = 0.5;
      car.speed *= 0.55;
      burst(car.x, car.y, 8, '#ffdd55', 150);
      if (car.def.isPlayer) { sfx.crash(); G.shake = 7; }
    } else {
      car.speed *= (1 - 2.5 * dt);
    }
  }

  // Car-car bumps: push apart.
  for (const o of cars) {
    if (o === car) continue;
    const dx = car.x - o.x;
    const dy = car.y - o.y;
    const d = Math.hypot(dx, dy);
    if (d > 0.01 && d < 26) {
      const push = (26 - d) * 0.5;
      const ux = dx / d;
      const uy = dy / d;
      car.x += ux * push * 0.5;
      car.y += uy * push * 0.5;
      const rel = (car.vx - o.vx) * ux + (car.vy - o.vy) * uy;
      if (rel > 60 && car.crashCd <= 0 && car.def.isPlayer) { sfx.crash(); car.crashCd = 0.4; G.shake = 4; }
    }
  }

  // Dust when sliding / off road.
  if ((offRoad && Math.abs(car.speed) > 90 && Math.random() < 0.25) ||
      (Math.abs(inp.steer) > 0.7 && Math.abs(car.speed) > 240 && Math.random() < 0.2)) {
    parts.push({
      x: car.x - Math.cos(car.angle) * 14, y: car.y - Math.sin(car.angle) * 14,
      vx: -car.vx * 0.15 + (Math.random() - 0.5) * 40,
      vy: -car.vy * 0.15 + (Math.random() - 0.5) * 40,
      life: 0.5, t: 0, color: offRoad ? '#7fae6a' : '#9aa3b2', size: 3,
    });
  }
}

function update(dt) {
  G.time += dt;
  if (G.message) {
    G.message.t -= dt;
    if (G.message.t <= 0) G.message = null;
  }
  if (G.shake > 0) G.shake = Math.max(0, G.shake - dt * 30);
  for (const p of parts) { p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; }
  parts = parts.filter((p) => p.t < p.life);
  for (const p of popups) { p.t -= dt; p.y -= 24 * dt; }
  popups = popups.filter((p) => p.t > 0);
  for (const w of WRENCH_SPOTS) if (w.taken > 0) w.taken -= dt;

  if (G.screen === 'countdown') {
    G.countT += dt;
    const step = Math.floor(G.countT / 0.8);
    if (step !== G.countStep) {
      G.countStep = step;
      if (step < 3) sfx.count();
      else { sfx.go(); G.screen = 'race'; G.raceT = 0; cars.forEach((c) => { c.lapStart = 0; }); }
    }
    return;
  }
  if (G.screen !== 'race' || G.paused) return;

  G.raceT += dt;
  const pin = playerInput();
  updateCar(cars[0], G.firstFinishT >= 0 && cars[0].finished ? { steer: 0, gas: false, brake: true } : pin, dt);
  for (let i = 1; i < cars.length; i++) {
    const c = cars[i];
    if (c.finished) {
      updateCar(c, { steer: 0, gas: false, brake: true }, dt);
    } else {
      updateCar(c, aiInput(c, dt), dt);
    }
  }

  // Standings.
  const order = [...cars].sort((a, b) => {
    if (a.finished && b.finished) return a.finishT - b.finishT;
    if (a.finished) return -1;
    if (b.finished) return 1;
    return b.progress - a.progress;
  });
  order.forEach((c, i) => { c.place = i + 1; });
  engineUpdate(cars[0].speed);

  // End: player finishes, or 12s after first finisher.
  const player = cars[0];
  if (player.finished || (G.firstFinishT >= 0 && G.raceT - G.firstFinishT > 12)) {
    G.screen = 'done';
    G.endT = G.raceT;
    const wins = player.place === 1;
    if (wins) {
      sfx.win();
      try {
        const w = parseInt(localStorage.getItem('sprint_wins') || '0', 10) || 0;
        localStorage.setItem('sprint_wins', String(w + 1));
        const bt = parseFloat(localStorage.getItem('sprint_best_race') || '0');
        if (!bt || player.finishT < bt) localStorage.setItem('sprint_best_race', String(player.finishT.toFixed(2)));
      } catch (e) {}
    } else if (!player.finished) {
      sfx.lose();
    }
  }
}

// ---------- render ----------
function pathTrack() {
  ctx.beginPath();
  ctx.moveTo(PTS[0][0], PTS[0][1]);
  for (let i = 1; i < PTS.length; i++) ctx.lineTo(PTS[i][0], PTS[i][1]);
  ctx.closePath();
}

function drawHeli(x, y) {
  ctx.save();
  ctx.translate(x, y);
  // Shadow.
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath(); ctx.ellipse(3, 5, 19, 9, 0, 0, TAU); ctx.fill();
  // Tail boom + fin.
  ctx.fillStyle = '#c33';
  ctx.fillRect(-27, -2, 14, 4);
  ctx.fillRect(-31, -7, 4, 10);
  // Skids.
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-8, 8); ctx.lineTo(-8, 12); ctx.moveTo(8, 8); ctx.lineTo(8, 12); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-12, 12); ctx.lineTo(12, 12); ctx.stroke();
  // Body + cockpit.
  ctx.fillStyle = '#e8e8e8';
  ctx.beginPath(); ctx.ellipse(0, 0, 14, 9, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = '#223344';
  ctx.beginPath(); ctx.ellipse(7, -1, 6, 5, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = '#c33';
  ctx.fillRect(-4, -2, 8, 4);
  // Spinning rotor.
  const a = G.time * 18;
  ctx.strokeStyle = '#222';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(Math.cos(a) * 24, Math.sin(a) * 24);
  ctx.lineTo(-Math.cos(a) * 24, -Math.sin(a) * 24);
  ctx.stroke();
  ctx.restore();
}

function drawTrack() {
  // Bright arcade grass.
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#37bd4f');
  g.addColorStop(1, '#24a038');
  ctx.fillStyle = g;
  ctx.fillRect(-view.ox, -view.oy, view.vw, view.vh);
  ctx.fillStyle = 'rgba(0,0,0,0.06)';
  for (let y = -view.oy; y < -view.oy + view.vh; y += 52) ctx.fillRect(-view.ox, y, view.vw, 24);

  // Grandstand crowd strip along the top, like the arcade cabinet.
  // It stays glued to the scoreboard (world y 0..30); any extra space above
  // on tall containers is just grass.
  ctx.fillStyle = '#8f96a3';
  ctx.fillRect(-view.ox, 0, view.vw, 30);
  const crowd = ['#d66', '#fff', '#6cf', '#ff6', '#6d6'];
  const dots = Math.ceil(view.vw / 8);
  for (let ry = 0; ry < 3; ry++) {
    for (let rx = 0; rx < dots; rx++) {
      ctx.fillStyle = crowd[(rx * 7 + ry * 13 + rx * ry) % crowd.length];
      ctx.fillRect(-view.ox + 4 + rx * 8, 5 + ry * 8, 4, 4);
    }
  }
  ctx.fillStyle = '#3a3f4a';
  ctx.fillRect(-view.ox, 30, view.vw, 3);

  // Trees, only where safely off the road.
  for (const [tx, ty] of TREES) {
    if (nearestOnTrack(tx, ty).d < ROAD_HALF + 16) continue;
    ctx.fillStyle = '#1c7a2e';
    ctx.beginPath(); ctx.arc(tx, ty, 9, 0, TAU); ctx.fill();
    ctx.fillStyle = '#54d96a';
    ctx.beginPath(); ctx.arc(tx - 2, ty - 2, 6, 0, TAU); ctx.fill();
    ctx.fillStyle = '#1c7a2e';
    ctx.beginPath(); ctx.arc(tx + 2, ty - 3, 2, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(tx - 3, ty + 2, 2, 0, TAU); ctx.fill();
  }

  // Dark asphalt with light walls.
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  pathTrack();
  ctx.strokeStyle = '#e8e8e8';
  ctx.lineWidth = (ROAD_HALF + 6) * 2;
  ctx.stroke();
  pathTrack();
  ctx.strokeStyle = '#222228';
  ctx.lineWidth = ROAD_HALF * 2;
  ctx.stroke();
  pathTrack();
  ctx.strokeStyle = '#2e2e37';
  ctx.lineWidth = ROAD_HALF * 2 - 10;
  ctx.stroke();

  // Yellow/black striped corner barriers.
  ctx.lineCap = 'butt';
  for (const b of BARRIERS) {
    ctx.strokeStyle = '#ffd23f';
    ctx.lineWidth = 12;
    ctx.beginPath(); ctx.moveTo(b.x1, b.y1); ctx.lineTo(b.x2, b.y2); ctx.stroke();
    ctx.save();
    ctx.strokeStyle = '#111';
    ctx.setLineDash([12, 12]);
    ctx.beginPath(); ctx.moveTo(b.x1, b.y1); ctx.lineTo(b.x2, b.y2); ctx.stroke();
    ctx.restore();
  }
  ctx.lineCap = 'round';

  // Red direction chevrons painted on the asphalt.
  for (const c of CHEVRONS) {
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.angle);
    ctx.fillStyle = '#e03232';
    for (let k = -1; k <= 1; k++) {
      ctx.beginPath();
      ctx.moveTo(k * 13 - 5, -9); ctx.lineTo(k * 13 + 5, 0); ctx.lineTo(k * 13 - 5, 9);
      ctx.lineTo(k * 13 - 1, 9); ctx.lineTo(k * 13 + 9, 0); ctx.lineTo(k * 13 - 1, -9);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  // Start/finish: yellow/black stripes across the road, like the original.
  const s = SEGS[0];
  const mx = (s.ax + s.bx) / 2;
  const my = (s.ay + s.by) / 2;
  ctx.save();
  ctx.translate(mx, my);
  ctx.rotate(Math.atan2(s.uy, s.ux));
  for (let c = 0; c < 8; c++) {
    ctx.fillStyle = c % 2 === 0 ? '#111' : '#ffd23f';
    ctx.fillRect(-8, -ROAD_HALF + c * ((ROAD_HALF * 2) / 8), 16, (ROAD_HALF * 2) / 8);
  }
  ctx.restore();

  // Turbo pads: blue chevrons.
  for (const t of TURBOS) {
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.rotate(Math.atan2(t.uy, t.ux));
    ctx.fillStyle = 'rgba(64,196,255,0.25)';
    ctx.beginPath(); ctx.arc(0, 0, t.r, 0, TAU); ctx.fill();
    ctx.fillStyle = '#40c4ff';
    for (let k = -1; k <= 1; k++) {
      ctx.beginPath();
      ctx.moveTo(k * 12 - 4, -12); ctx.lineTo(k * 12 + 6, 0); ctx.lineTo(k * 12 - 4, 12);
      ctx.lineTo(k * 12 - 1, 12); ctx.lineTo(k * 12 + 9, 0); ctx.lineTo(k * 12 - 1, -12);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }
  // Oil slicks.
  for (const o of OILS) {
    ctx.fillStyle = '#0b0b10';
    ctx.beginPath();
    ctx.ellipse(o.x, o.y, o.r, o.r * 0.7, 0.5, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = '#4a4a55';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = 'rgba(120,120,160,0.5)';
    ctx.beginPath(); ctx.ellipse(o.x - 3, o.y - 3, 4, 2.5, 0.5, 0, TAU); ctx.fill();
  }
  // Wrenches.
  for (const wspot of WRENCH_SPOTS) {
    if (wspot.taken > 0) continue;
    const bob = Math.sin(G.time * 4 + wspot.x) * 2;
    ctx.save();
    ctx.translate(wspot.x, wspot.y + bob);
    ctx.fillStyle = '#ffd23f';
    ctx.strokeStyle = '#7a5b00';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, 10, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(-4, 4); ctx.lineTo(4, -4); ctx.stroke();
    ctx.beginPath(); ctx.arc(-4, 4, 3, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.arc(4, -4, 3, 0, TAU); ctx.stroke();
    ctx.restore();
  }
  // Pit tents in the infield.
  for (const [tx, ty] of TENTS) {
    if (nearestOnTrack(tx, ty).d < ROAD_HALF + 20) continue;
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath(); ctx.ellipse(tx, ty + 9, 15, 4, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#eee';
    ctx.beginPath(); ctx.moveTo(tx - 13, ty + 8); ctx.lineTo(tx + 13, ty + 8); ctx.lineTo(tx, ty - 10); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#d23b3b';
    ctx.beginPath(); ctx.moveTo(tx - 6, ty + 8); ctx.lineTo(tx + 6, ty + 8); ctx.lineTo(tx, ty - 2); ctx.closePath(); ctx.fill();
  }
  // Helicopter parked in the infield, rotor spinning.
  for (const [hx, hy] of HELI_SPOTS) {
    if (nearestOnTrack(hx, hy).d > ROAD_HALF + 34) { drawHeli(hx, hy); break; }
  }
}

function drawCar(car) {
  ctx.save();
  ctx.translate(car.x, car.y);
  // Shadow.
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath(); ctx.ellipse(2, 2, 14, 8, car.angle, 0, TAU); ctx.fill();
  ctx.rotate(car.angle);
  const main = car.def.color;
  const dark = car.def.dark;
  // Wheels.
  ctx.fillStyle = '#101014';
  ctx.fillRect(-9, -10, 7, 4);
  ctx.fillRect(3, -10, 7, 4);
  ctx.fillRect(-9, 6, 7, 4);
  ctx.fillRect(3, 6, 7, 4);
  // Body.
  ctx.fillStyle = dark;
  ctx.fillRect(-13, -7, 26, 14);
  ctx.fillStyle = main;
  ctx.fillRect(-12, -6, 25, 12);
  // Nose.
  ctx.fillStyle = main;
  ctx.beginPath();
  ctx.moveTo(13, -5); ctx.lineTo(19, 0); ctx.lineTo(13, 5); ctx.closePath(); ctx.fill();
  // Cockpit + driver.
  ctx.fillStyle = '#101828';
  ctx.fillRect(-3, -3, 7, 6);
  ctx.fillStyle = car.def.isPlayer ? '#fff' : '#dfe8ff';
  ctx.beginPath(); ctx.arc(0, 0, 2.5, 0, TAU); ctx.fill();
  // Rear wing.
  ctx.fillStyle = dark;
  ctx.fillRect(-16, -10, 5, 20);
  ctx.fillStyle = main;
  ctx.fillRect(-15, -9, 3, 18);
  // Stripe.
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.fillRect(-12, -1, 25, 2);
  // Player marker.
  if (car.def.isPlayer) {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(0, -13); ctx.lineTo(-5, -20); ctx.lineTo(5, -20); ctx.closePath(); ctx.fill();
  }
  if (car.boostT > 0) {
    ctx.fillStyle = 'rgba(64,196,255,0.8)';
    ctx.beginPath();
    ctx.moveTo(-13, -4); ctx.lineTo(-22 - Math.random() * 7, 0); ctx.lineTo(-13, 4);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  // Name tag for AI.
  if (!car.def.isPlayer) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.font = 'bold 10px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(car.def.name, car.x, car.y - 19);
  }
}

function fmt(t) {
  if (!t || t <= 0) return '--.-';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return (m > 0 ? m + ':' : '') + s.toFixed(1).padStart(4, '0');
}

function drawHUD() {
  const player = cars[0];
  // Arcade scoreboard: one column per car across the top.
  ctx.textAlign = 'center';
  const cols = [120, 360, 600, 840];
  ctx.font = 'bold 17px "Courier New", monospace';
  cars.forEach((c, i) => {
    const x = cols[i];
    ctx.fillStyle = '#000';
    ctx.fillText(c.def.name + ' ' + c.score, x + 2, 22);
    ctx.fillStyle = c.def.color;
    ctx.fillText(c.def.name + ' ' + c.score, x, 20);
  });
  ctx.font = '13px "Courier New", monospace';
  cars.forEach((c, i) => {
    const x = cols[i];
    let sub = 'LAP ' + Math.min(c.lap + 1, LAPS);
    if (c.def.isPlayer) sub += '  P' + c.place + '  W' + c.wrenches;
    else if (c.finished) sub += '  FIN';
    ctx.fillStyle = '#000';
    ctx.fillText(sub, x + 1, 45);
    ctx.fillStyle = '#fff';
    ctx.fillText(sub, x, 44);
  });
  // Bottom info bar.
  ctx.fillStyle = 'rgba(8,10,24,0.8)';
  ctx.fillRect(-view.ox, H - 24, view.vw, 24);
  ctx.textAlign = 'left';
  ctx.font = 'bold 14px "Courier New", monospace';
  ctx.fillStyle = '#54d96a';
  ctx.fillText('TRACK 1', 12, H - 8);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff';
  ctx.fillText('TIME ' + fmt(G.raceT) + '   BEST ' + fmt(player && player.bestLap), W / 2, H - 8);
  if (player && player.lastLap) {
    ctx.fillStyle = '#cfe3ff';
    ctx.fillText('LAST ' + fmt(player.lastLap), W / 2 + 230, H - 8);
  }

  // Wrong way.
  if (player && player.wrongT > 0.6 && G.screen === 'race') {
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ff5252';
    ctx.font = 'bold 30px "Courier New", monospace';
    ctx.fillText('WRONG WAY!', W / 2, 120);
  }
  if (G.message) {
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    const mw = 320;
    ctx.fillRect(W / 2 - mw / 2, 150, mw, G.message.sub ? 64 : 48);
    ctx.fillStyle = '#ffd23f';
    ctx.font = 'bold 28px "Courier New", monospace';
    ctx.fillText(G.message.text, W / 2, 178);
    if (G.message.sub) {
      ctx.fillStyle = '#fff';
      ctx.font = '15px "Courier New", monospace';
      ctx.fillText(G.message.sub, W / 2, 202);
    }
  }
  // Particles + popups.
  for (const p of parts) {
    ctx.globalAlpha = 1 - p.t / p.life;
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffd23f';
  ctx.font = 'bold 15px "Courier New", monospace';
  for (const p of popups) {
    ctx.globalAlpha = clamp(p.t, 0, 1);
    ctx.fillText(p.text, p.x, p.y);
  }
  ctx.globalAlpha = 1;
}

function drawScreen() {
  ctx.setTransform(view.scale, 0, 0, view.scale, view.ox * view.scale, view.oy * view.scale);
  ctx.save();
  if (G.shake > 0) ctx.translate((Math.random() - 0.5) * G.shake, (Math.random() - 0.5) * G.shake);
  drawTrack();
  // Draw AI first, player last (on top).
  for (let i = cars.length - 1; i >= 0; i--) drawCar(cars[i]);
  ctx.restore();
  drawHUD();

  if (G.screen === 'title') {
    ctx.fillStyle = 'rgba(2,4,12,0.72)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd23f';
    ctx.font = 'bold 64px "Courier New", monospace';
    ctx.fillText('SPRINT', W / 2, 190);
    ctx.fillStyle = '#cfe3ff';
    ctx.font = '16px "Courier New", monospace';
    ctx.fillText('TOP-DOWN ARCADE RACER · 3 LAPS · 4 CARS', W / 2, 224);
    ctx.fillStyle = '#9be3a8';
    ctx.font = '15px "Courier New", monospace';
    try {
      const bl = localStorage.getItem('sprint_best_lap');
      const br = localStorage.getItem('sprint_best_race');
      const w = localStorage.getItem('sprint_wins');
      if (bl || br || w) ctx.fillText('BEST LAP ' + (bl || '--') + '   BEST RACE ' + (br || '--') + '   WINS ' + (w || 0), W / 2, 252);
    } catch (e) {}
    ctx.fillStyle = '#7f8db3';
    ctx.font = '14px "Courier New", monospace';
    ctx.fillText('Hold UP / GAS to accelerate · steer with LEFT / RIGHT', W / 2, 292);
    ctx.fillText('Turbo arrows = boost · black puddles = oil · wrench = +100', W / 2, 314);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 22px "Courier New", monospace';
    const blink = Math.floor(G.time * 2) % 2 === 0;
    if (blink) ctx.fillText('PRESS ENTER OR TAP TO START', W / 2, 366);
    ctx.fillStyle = '#7f8db3';
    ctx.font = '13px "Courier New", monospace';
    ctx.fillText('You are YELLOW (white arrow). Finish 3 laps before RED, BLU, GRN.', W / 2, 396);
  }

  if (G.screen === 'countdown') {
    ctx.fillStyle = 'rgba(2,4,12,0.45)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    const names = ['3', '2', '1'];
    const label = G.countStep < 3 ? (names[G.countStep] || '3') : 'GO!';
    ctx.fillStyle = G.countStep < 3 ? '#ffd23f' : '#9be3a8';
    ctx.font = 'bold 96px "Courier New", monospace';
    ctx.fillText(label, W / 2, H / 2 + 30);
  }

  if (G.paused && G.screen === 'race') {
    ctx.fillStyle = 'rgba(2,4,12,0.65)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 40px "Courier New", monospace';
    ctx.fillText('PAUSED', W / 2, H / 2);
    ctx.font = '15px "Courier New", monospace';
    ctx.fillText('Press P to resume', W / 2, H / 2 + 30);
  }

  if (G.screen === 'done') {
    const player = cars[0];
    ctx.fillStyle = 'rgba(2,4,12,0.72)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    const win = player.place === 1;
    ctx.fillStyle = win ? '#9be3a8' : '#ffd23f';
    ctx.font = 'bold 52px "Courier New", monospace';
    ctx.fillText(win ? 'YOU WIN!' : 'P' + player.place + ' — FINISH', W / 2, 150);
    ctx.font = '16px "Courier New", monospace';
    ctx.fillStyle = '#cfe3ff';
    const order = [...cars].sort((a, b) => a.place - b.place);
    order.forEach((c, i) => {
      const line = (i + 1) + '. ' + c.def.name + (c.def.isPlayer ? ' (you)' : '') +
        '  ' + (c.finished ? fmt(c.finishT) : 'DNF') +
        (c.bestLap ? '   best ' + fmt(c.bestLap) : '');
      ctx.fillStyle = c.def.color;
      ctx.fillText(line, W / 2, 200 + i * 28);
    });
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 18px "Courier New", monospace';
    if (Math.floor(G.time * 2) % 2 === 0) ctx.fillText('PRESS ENTER TO RACE AGAIN', W / 2, 360);
    ctx.fillStyle = '#7f8db3';
    ctx.font = '14px "Courier New", monospace';
    ctx.fillText('Wrenches: ' + player.wrenches + ' (+' + player.score + ')', W / 2, 392);
  }

  if (G.muted) {
    ctx.textAlign = 'right';
    ctx.fillStyle = '#7f8db3';
    ctx.font = '12px "Courier New", monospace';
    ctx.fillText('MUTED (M)', W - 12, H - 30);
  }
}

// ---------- main loop ----------
let last = performance.now();
function frame(now) {
  try {
    let dt = (now - last) / 1000;
    last = now;
    if (!(dt > 0)) dt = 0;
    dt = clamp(dt, 0, 0.033);
    update(dt);
    drawScreen();
  } catch (e) {
    try {
      ctx.fillStyle = '#200';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#fff';
      ctx.font = '14px monospace';
      ctx.textAlign = 'left';
      ctx.fillText('Error: ' + (e && e.message), 12, 24);
    } catch (e2) { /* ignore */ }
  } finally {
    requestAnimationFrame(frame);
  }
}

window.addEventListener('resize', resize);
if (document.addEventListener) document.addEventListener('fullscreenchange', resize);
resize();
resetRace();
requestAnimationFrame(frame);
})();
