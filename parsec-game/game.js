(() => {
'use strict';
/* Parsec clone — TI-99/4A style side-scrolling shooter.
   Ship on the left, terrain scrolls right-to-left, shoot saucers/darts/rocks,
   shoot red fuel pods to refuel, don't touch the ground. 3 ships per game. */

const W = 960;
const H = 540;
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);

// Deterministic hash noise for terrain segments (stable per segment index).
function hash(n) {
  let x = (n | 0) * 374761393 + 668265263;
  x = (x ^ (x >> 13)) * 1274126177;
  x = x ^ (x >> 16);
  return ((x >>> 0) % 10000) / 10000;
}

const G = {
  screen: 'title', // title | play | dying | over
  paused: false,
  muted: false,
  time: 0,
  worldX: 0,
  dist: 0,
  score: 0,
  lives: 3,
  level: 1,
  fuel: 100,
  scroll: 150,
  fireCd: 0,
  spawnT: 1.2,
  dartT: 4,
  rockT: 6,
  stormT: 0,
  stormLeft: 0,
  warn: null,      // { text, sub, t }
  shake: 0,
  dieT: 0,
  invuln: 0,
  flash: 0,
};

const ship = { x: 220, ox: 0, y: 300, vy: 0, tilt: 0, flame: 0 };
let bullets = [];   // player: {x,y,vx}
let ebullets = [];   // enemy: {x,y,vx,vy}
let enemies = [];   // {kind,wx,y,t,vx,hp,r,seed,shotT,dy}
let pods = [];      // fuel pods on ground: {wx,y,taken}
let parts = [];     // particles {x,y,vx,vy,life,maxLife,color,size}
let popups = [];    // score popups {x,y,text,t}
let stars = [];
for (let i = 0; i < 130; i++) {
  stars.push({ x: Math.random() * W, y: Math.random() * (H - 60), z: rand(0.15, 1), s: rand(0.5, 2) });
}
let nextPodWx = 700;

// ---------- audio (all synthesized) ----------
let AC = null;
let masterGain = null;
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
function tone(freq, dur, type, vol, slideTo) {
  if (G.muted) return;
  const ac = audio();
  if (!ac) return;
  try {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type || 'square';
    o.frequency.setValueAtTime(freq, ac.currentTime);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), ac.currentTime + dur);
    g.gain.setValueAtTime(vol || 0.2, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + dur);
    o.connect(g); g.connect(masterGain);
    o.start(); o.stop(ac.currentTime + dur + 0.02);
  } catch (e) { /* no audio */ }
}
function noiseBurst(dur, vol) {
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
    f.type = 'lowpass'; f.frequency.value = 900;
    src.connect(f); f.connect(g); g.connect(masterGain);
    src.start();
  } catch (e) { /* no audio */ }
}
const sfx = {
  shoot() { tone(880, 0.09, 'square', 0.12, 220); },
  eshoot() { tone(300, 0.12, 'sawtooth', 0.08, 120); },
  boom() { noiseBurst(0.45, 0.5); tone(120, 0.4, 'sawtooth', 0.2, 30); },
  hit() { noiseBurst(0.25, 0.35); },
  pickup() { tone(520, 0.09, 'square', 0.15); setTimeout(() => tone(780, 0.12, 'square', 0.15), 80); },
  warn() { tone(440, 0.16, 'square', 0.2); setTimeout(() => tone(440, 0.16, 'square', 0.2), 220); },
  level() { [523, 659, 784].forEach((f, i) => setTimeout(() => tone(f, 0.14, 'square', 0.16), i * 110)); },
};

// ---------- input ----------
const keys = Object.create(null);
let touchSteer = null; // {x,y} in canvas pixels
let touchFire = false;
function canvasPos(ev) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (ev.clientX - r.left) * (W / Math.max(1, r.width)),
    y: (ev.clientY - r.top) * (H / Math.max(1, r.height)),
  };
}
window.addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  keys[e.code] = true;
  audio();
  if (G.nameEntry) {
    e.preventDefault();
    if (!e.repeat) handleEntryKey(e.code);
    return;
  }
  if (e.code === 'Enter') { startGame(); }
  if (e.code === 'KeyF') { toggleFull(); }
  if (e.code === 'KeyP') { togglePause(); }
  if (e.code === 'KeyM') { G.muted = !G.muted; }
  if (e.code === 'Space' || e.code === 'KeyZ') { audio(); }
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });
canvas.addEventListener('pointerdown', (e) => {
  audio();
  canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
  const p = canvasPos(e);
  if (G.screen !== 'play') { startGame(); return; }
  touchSteer = p;
});
canvas.addEventListener('pointermove', (e) => {
  if (touchSteer) touchSteer = canvasPos(e);
});
const endTouch = () => { touchSteer = null; };
canvas.addEventListener('pointerup', endTouch);
canvas.addEventListener('pointercancel', endTouch);
document.getElementById('btnFire').addEventListener('pointerdown', (e) => { e.preventDefault(); audio(); touchFire = true; });
document.getElementById('btnFire').addEventListener('pointerup', () => { touchFire = false; });
document.getElementById('btnFire').addEventListener('pointerleave', () => { touchFire = false; });
document.getElementById('btnStart').addEventListener('click', () => { audio(); startGame(); });
document.getElementById('btnPause').addEventListener('click', () => { togglePause(); });
document.getElementById('btnFull').addEventListener('click', () => { toggleFull(); });
// Fit the 960x540 playfield into the window (or fullscreen) keeping 16:9.
function fitScreen() {
  try {
    const stage = document.getElementById('stage');
    const availW = (stage && stage.clientWidth) || window.innerWidth || W;
    const availH = (stage && stage.clientHeight) || window.innerHeight || H;
    if (!canvas.style) return;
    const s = Math.max(0.2, Math.min(availW / W, availH / H));
    canvas.style.width = Math.floor(W * s) + 'px';
    canvas.style.height = Math.floor(H * s) + 'px';
  } catch (e) { /* sizing optional */ }
}
function toggleFull() {
  try {
    if (document.fullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen();
    } else {
      const el = document.documentElement;
      if (el && el.requestFullscreen) el.requestFullscreen();
    }
  } catch (e) { /* fullscreen optional */ }
}
window.addEventListener('resize', fitScreen);
document.addEventListener('fullscreenchange', fitScreen);
function togglePause() {
  if (G.screen === 'play') G.paused = !G.paused;
}
// USB controller pad (Gamepad API). First connected pad wins:
// left stick or D-pad steers, A / RT / X fires, Start launches or pauses.
let prevPadStart = false;
let prevPadAny = false;
function readPad() {
  const none = { move: null, fire: false, start: false, any: false, face: false, id: null };
  try {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return none;
    const pads = navigator.getGamepads();
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const dz = (v) => (Math.abs(v || 0) < 0.22 ? 0 : v);
      const ax = dz(p.axes[0]);
      const ay = dz(p.axes[1]);
      const b = (i) => !!(p.buttons[i] && p.buttons[i].pressed);
      const mx = ax || ((b(15) ? 1 : 0) - (b(14) ? 1 : 0));
      const my = ay || ((b(13) ? 1 : 0) - (b(12) ? 1 : 0));
      // any: every pressed button (D-pad included) — launching the game.
      // face: pressed buttons except the D-pad — advancing initials entry.
      let any = false, face = false;
      for (let i = 0; i < p.buttons.length; i++) {
        if (p.buttons[i] && p.buttons[i].pressed) {
          any = true;
          if (i < 12 || i > 15) face = true;
        }
      }
      return {
        move: (mx || my) ? { x: clamp(mx, -1, 1), y: clamp(my, -1, 1) } : null,
        fire: b(0) || b(7) || b(2),
        start: b(9),
        any, face,
        id: p.id || null,
      };
    }
  } catch (e) { /* gamepad optional */ }
  return none;
}

// ---------- terrain ----------
const SEG = 260; // world px per terrain segment
function segHeight(i) {
  if (i < 2) return H - 80;
  const r = hash(i * 7 + 3);
  const r2 = hash(i * 13 + 71);
  let h = (H - 80) - r * 130 + Math.sin(i * 0.9) * 26;
  if (r2 > 0.82) h -= 70;         // crater dip seed
  return clamp(h, H - 250, H - 26);
}
function groundYAt(wx) {
  const i = Math.floor(wx / SEG);
  const t = (wx - i * SEG) / SEG;
  const s = t * t * (3 - 2 * t);
  let y = lerp(segHeight(i), segHeight(i + 1), s);
  const crater = hash(i * 29 + 5) > 0.78;
  if (crater) y += Math.sin(t * Math.PI) * 34; // bowl dip (+y = lower)
  return y;
}
// Level palettes (TI-style bright bands).
function palette(level) {
  const P = [
    { sky: ['#02030a', '#0a1030'], far: '#141c44', ground: '#3fae5a', edge: '#c8ff7a' },
    { sky: ['#0a0212', '#2b0f3a'], far: '#3a1c55', ground: '#b5533c', edge: '#ffd23f' },
    { sky: ['#021018', '#0b2c3a'], far: '#134052', ground: '#3cc8b5', edge: '#eaffff' },
    { sky: ['#100a02', '#3a240b'], far: '#543416', ground: '#d8a03c', edge: '#fff3c8' },
  ];
  return P[(level - 1) % P.length];
}

// ---------- high scores (arcade leaderboard, saved on this machine) ----------
const HS_KEY = 'parsec_highscores_v1';
const HS_MAX = 10;
const ENTRY_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function defaultScores() {
  return [
    { name: 'TEX', score: 5000, sector: 4 },
    { name: 'PAR', score: 3000, sector: 3 },
    { name: 'SEC', score: 2000, sector: 2 },
    { name: 'TI9', score: 1200, sector: 2 },
    { name: 'ACE', score: 800, sector: 1 },
  ];
}
function loadScores() {
  try {
    const raw = localStorage.getItem(HS_KEY);
    if (!raw) return defaultScores();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return defaultScores();
    return arr.filter((e) => e && typeof e.score === 'number').slice(0, HS_MAX);
  } catch (e) { return defaultScores(); }
}
let highscores = loadScores();
function saveScores() {
  try { localStorage.setItem(HS_KEY, JSON.stringify(highscores)); } catch (e) { /* storage optional */ }
}
function qualifies(score) {
  return score > 0 && (highscores.length < HS_MAX || score > highscores[highscores.length - 1].score);
}
function entryString(en) {
  return en.letters.map((i) => ENTRY_CHARS[i]).join('');
}
function commitEntry() {
  const en = G.nameEntry;
  if (!en) return;
  highscores.push({ name: entryString(en), score: G.score, sector: G.level });
  highscores.sort((a, b) => b.score - a.score);
  highscores = highscores.slice(0, HS_MAX);
  saveScores();
  G.nameEntry = null;
}
// Keyboard entry: up/down changes the letter, right/space/fire advances, enter confirms.
function handleEntryKey(code) {
  const en = G.nameEntry;
  if (!en) return;
  if (code === 'ArrowUp' || code === 'KeyW') en.letters[en.pos] = (en.letters[en.pos] + 1) % 26;
  else if (code === 'ArrowDown' || code === 'KeyS') en.letters[en.pos] = (en.letters[en.pos] + 25) % 26;
  else if (code === 'ArrowLeft' || code === 'Backspace') en.pos = Math.max(0, en.pos - 1);
  else if (code === 'ArrowRight' || code === 'Space' || code === 'KeyZ') {
    if (en.pos < 2) en.pos++;
    else commitEntry();
  } else if (code === 'Enter') commitEntry();
}
// Gamepad entry: stick/D-pad up-down changes the letter, right/A advances, start confirms.
let prevEntry = { x: 0, y: 0, fire: false, start: false };
function entryPad(pad) {
  const en = G.nameEntry;
  if (!en) return;
  const mx = pad.move ? pad.move.x : 0;
  const my = pad.move ? pad.move.y : 0;
  const ex = Math.abs(mx) > 0.5 ? Math.sign(mx) : 0;
  const ey = Math.abs(my) > 0.5 ? Math.sign(my) : 0;
  if (ey < 0 && prevEntry.y >= 0) en.letters[en.pos] = (en.letters[en.pos] + 1) % 26;
  if (ey > 0 && prevEntry.y <= 0) en.letters[en.pos] = (en.letters[en.pos] + 25) % 26;
  if (ex > 0 && prevEntry.x <= 0) {
    if (en.pos < 2) en.pos++;
    else commitEntry();
  }
  if (ex < 0 && prevEntry.x >= 0) en.pos = Math.max(0, en.pos - 1);
  if (pad.face && !prevEntry.face) {
    if (G.nameEntry && en.pos < 2) en.pos++;
    else commitEntry();
  }
  if (pad.start && !prevEntry.start) commitEntry();
  prevEntry = { x: ex, y: ey, fire: pad.fire, start: pad.start, face: pad.face };
}
// Title-screen pad readout: null when no pad is awake (browsers only list
// a pad after one of its buttons has been pressed at least once).
function padLabel() {
  try {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (const p of pads) {
      if (p && p.connected) return p.id || 'pad';
    }
  } catch (e) { /* gamepad optional */ }
  return null;
}

// ---------- game flow ----------
function startGame() {
  G.screen = 'play';
  G.paused = false;
  G.time = 0; G.worldX = 0; G.dist = 0;
  G.score = 0; G.lives = 3; G.level = 1;
  G.fuel = 100; G.scroll = 150;
  G.fireCd = 0; G.spawnT = 1.4; G.dartT = 5; G.rockT = 7;
  G.stormT = 24; G.stormLeft = 0;
  G.shake = 0; G.dieT = 0; G.invuln = 2; G.flash = 0;
  G.nameEntry = null;
  prevEntry = { x: 0, y: 0, fire: false, start: false, face: false };
  prevPadAny = false;
  bullets = []; ebullets = []; enemies = []; pods = [];
  parts = []; popups = [];
  ship.ox = 0; ship.y = 280; ship.vy = 0;
  nextPodWx = 800;
  setWarn('PARSEC', 'destroy the enemy — watch your fuel', 2.6);
  sfx.level();
}
function setWarn(text, sub, t) {
  G.warn = { text, sub: sub || '', t: t || 2.4 };
  sfx.warn();
}
function loseShip(cause) {
  if (G.invuln > 0 || G.screen !== 'play') return;
  G.screen = 'dying';
  G.dieT = 1.4;
  G.shake = 14;
  explode(ship.x, ship.y, '#ffd23f', 60);
  explode(ship.x, ship.y, '#ff4d4d', 40);
  sfx.boom();
  G._deathCause = cause || 'crash';
}
function respawnOrOver() {
  G.lives -= 1;
  if (G.lives <= 0) {
    G.screen = 'over';
    if (qualifies(G.score)) {
      G.nameEntry = { pos: 0, letters: [0, 0, 0] };
      prevEntry = { x: 0, y: 0, fire: false, start: false, face: false };
    }
  } else {
    G.screen = 'play';
    G.fuel = Math.max(G.fuel, 60);
    if (G.fuel <= 0) G.fuel = 60;
    ship.y = 240; ship.vy = 0; ship.ox = 0;
    bullets = []; ebullets = []; enemies = [];
    G.invuln = 2.5;
    setWarn('SHIP ' + (4 - G.lives) + ' READY', G._deathCause === 'fuel' ? 'out of fuel — shoot red pods' : '', 2.0);
  }
}
function explode(x, y, color, n) {
  for (let i = 0; i < (n || 24); i++) {
    const a = Math.random() * TAU;
    const sp = rand(40, 320);
    parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60, life: 0, maxLife: rand(0.4, 1.1), color, size: rand(1.5, 4) });
  }
}
function addPopup(x, y, text, color) {
  popups.push({ x, y, text, t: 0, color: color || '#fff' });
}

// ---------- spawning ----------
function spawnSaucer() {
  enemies.push({ kind: 'saucer', wx: G.worldX + W + 60, y: rand(70, H - 200), t: rand(0, 9), vx: 40, hp: 1, r: 16, shotT: rand(0.8, 1.8) });
}
function spawnDart() {
  enemies.push({ kind: 'dart', wx: G.worldX + W + 60, y: rand(60, 200), t: 0, vx: -60, hp: 1, r: 13, vy: 0 });
}
function spawnRock() {
  const big = Math.random() < 0.35;
  enemies.push({ kind: 'rock', wx: G.worldX + W + 60, y: rand(50, H - 160), t: rand(0, 9), vx: rand(-30, 30), hp: 1, r: big ? 22 : 13, spin: rand(-2, 2), rot: rand(0, 6), vy: rand(-20, 20) });
}
function maybeSpawnPods() {
  while (nextPodWx < G.worldX + W + 200) {
    const gy = groundYAt(nextPodWx);
    // Only place pods on reasonably flat, non-crater ground.
    const slope = Math.abs(groundYAt(nextPodWx + 30) - groundYAt(nextPodWx - 30));
    if (slope < 26 && gy < H - 30) pods.push({ wx: nextPodWx, y: gy - 12, taken: false });
    nextPodWx += rand(700, 1300);
  }
  pods = pods.filter((p) => p.wx > G.worldX - 100 && !p.taken);
}

// ---------- update ----------
function fireBullet() {
  if (G.fireCd > 0 || G.screen !== 'play' || G.paused) return;
  G.fireCd = 0.16;
  bullets.push({ x: ship.x + 26, y: ship.y - 2, vx: 560 });
  bullets.push({ x: ship.x + 26, y: ship.y + 6, vx: 560 });
  G.fuel = Math.max(0, G.fuel - 0.35);
  sfx.shoot();
  ship.flame = 1;
}
function step(dt) {
  G.time += dt;
  // USB gamepad Start works on every screen (launch or pause).
  const pad = readPad();
  if (G.nameEntry) entryPad(pad);
  else if (pad.any && !prevPadAny && G.screen !== 'play' && G.screen !== 'dying') startGame();
  else if (pad.start && !prevPadStart && G.screen === 'play') togglePause();
  prevPadStart = pad.start;
  prevPadAny = pad.any;
  // Star twinkle drift always (menus too).
  for (const s of stars) {
    s.x -= dt * 12 * s.z * (G.screen === 'play' && !G.paused ? G.scroll / 150 : 1);
    if (s.x < 0) { s.x += W; s.y = Math.random() * (H - 60); }
  }
  if (G.warn && G.warn.t > 0 && (G.screen === 'play' || G.screen === 'dying')) G.warn.t -= dt;
  // Particles / popups always animate.
  for (const p of parts) { p.life += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 300 * dt; }
  parts = parts.filter((p) => p.life < p.maxLife);
  for (const p of popups) { p.t += dt; p.y -= 34 * dt; }
  popups = popups.filter((p) => p.t < 1);
  if (G.shake > 0) G.shake = Math.max(0, G.shake - dt * 30);
  if (G.flash > 0) G.flash -= dt;
  if (G.screen === 'dying') {
    G.dieT -= dt;
    G.worldX += G.scroll * 0.3 * dt;
    if (G.dieT <= 0) respawnOrOver();
    return;
  }
  if (G.screen !== 'play' || G.paused) return;
  if (G.invuln > 0) G.invuln -= dt;
  if (G.fireCd > 0) G.fireCd -= dt;

  // Difficulty ramp.
  const newLevel = 1 + Math.floor(G.dist / 2500);
  if (newLevel !== G.level) {
    G.level = newLevel;
    G.scroll = Math.min(340, 150 + (G.level - 1) * 28);
    setWarn('SECTOR ' + G.level, G.level === 2 ? 'warning: asteroid belt' : G.level === 3 ? 'warning: swoopers' : 'enemy speed up', 2.4);
    sfx.level();
  }
  const dx = G.scroll * dt;
  G.worldX += dx;
  G.dist += dx;
  G.fuel = Math.max(0, G.fuel - dt * 2.1);
  if (G.fuel <= 0) { ship.y += 260 * dt; } // flameout: sinking

  // Ship steering (keyboard, touch, or USB gamepad).
  const up = keys.ArrowUp || keys.KeyW;
  const dn = keys.ArrowDown || keys.KeyS;
  const lf = keys.ArrowLeft || keys.KeyA;
  const rt = keys.ArrowRight || keys.KeyD;
  const SPD = 330;
  if (touchSteer) {
    ship.ox = clamp(ship.ox + clamp(touchSteer.x - (ship.x), -1, 1) * SPD * dt, -90, 130);
    ship.y += clamp(touchSteer.y - ship.y, -1, 1) * SPD * dt;
  } else if (pad.move) {
    ship.ox = clamp(ship.ox + pad.move.x * 260 * dt, -90, 130);
    ship.y += pad.move.y * SPD * dt;
  } else {
    if (up) ship.y -= SPD * dt;
    if (dn) ship.y += SPD * dt;
    if (lf) ship.ox -= 200 * dt;
    if (rt) ship.ox += 200 * dt;
    ship.ox = clamp(ship.ox, -90, 130);
  }
  ship.x = 220 + ship.ox;
  ship.y = clamp(ship.y, 46, H - 20);
  const vertDir = touchSteer ? clamp(touchSteer.y - ship.y, -1, 1) : pad.move ? pad.move.y : (dn ? 1 : 0) - (up ? 1 : 0);
  ship.vy = lerp(ship.vy, vertDir, 0.2);
  ship.tilt = clamp(vertDir * 0.25, -0.3, 0.3);
  if (ship.flame > 0) ship.flame -= dt * 4;
  const wantFire = keys.Space || keys.KeyZ || touchFire || pad.fire;
  if (wantFire) fireBullet();

  // Spawning.
  maybeSpawnPods();
  G.spawnT -= dt;
  if (G.spawnT <= 0) { spawnSaucer(); G.spawnT = rand(1.1, 2.4) / (1 + G.level * 0.15); }
  G.dartT -= dt;
  if (G.dartT <= 0 && G.level >= 2) { spawnDart(); spawnDart(); G.dartT = rand(3, 6); }
  G.stormT -= dt;
  if (G.stormT <= 0 && G.stormLeft <= 0) {
    G.stormLeft = 8 + G.level * 2;
    G.stormT = rand(20, 30);
    setWarn('WARNING: ASTEROID BELT', '', 2.2);
  }
  if (G.stormLeft > 0) {
    G.rockT -= dt;
    if (G.rockT <= 0) { spawnRock(); G.rockT = 0.35; G.stormLeft -= 1; }
  } else {
    G.rockT -= dt;
    if (G.rockT <= 0) { spawnRock(); G.rockT = rand(2.5, 5); }
  }

  // Player bullets.
  for (const b of bullets) b.x += b.vx * dt;
  bullets = bullets.filter((b) => b.x < W + 40);

  // Enemies.
  for (const e of enemies) {
    e.t += dt;
    if (e.kind === 'saucer') {
      e.wx += (e.vx - G.scroll) * dt * 0.9;
      e.y += Math.sin(e.t * 3) * 40 * dt;
      e.shotT -= dt;
      const sx = e.wx - G.worldX;
      if (e.shotT <= 0 && sx > 0 && sx < W && Math.abs(e.y - ship.y) < 220) {
        ebullets.push({ x: sx - 10, y: e.y, vx: -260 - G.level * 20, vy: clamp((ship.y - e.y) * 1.6, -140, 140) });
        e.shotT = rand(1.2, 2.4);
        sfx.eshoot();
      }
    } else if (e.kind === 'dart') {
      e.wx -= (G.scroll * 0.55 + 60) * dt;
      const sx = e.wx - G.worldX;
      e.vy = clamp((ship.y - e.y) * 2.2, -260, 260);
      e.y += e.vy * dt;
      if (sx < -40) e.dead = true;
    } else if (e.kind === 'rock') {
      e.wx += (e.vx - G.scroll) * dt;
      e.y += (e.vy || 0) * dt + Math.sin(e.t * 1.7) * 20 * dt;
      e.rot += e.spin * dt;
      if (e.y < 30) e.y = 30;
      const gy = groundYAt(e.wx);
      if (e.y > gy - e.r) { explode(e.wx - G.worldX, gy - 10, '#aa8866', 10); e.dead = true; }
    }
  }
  enemies = enemies.filter((e) => {
    const sx = e.wx - G.worldX;
    return !e.dead && sx > -80 && sx < W + 120 && e.y > -60 && e.y < H + 40;
  });

  // Enemy bullets.
  for (const b of ebullets) { b.x += b.vx * dt; b.y += b.vy * dt; }
  ebullets = ebullets.filter((b) => b.x > -30 && b.x < W + 30 && b.y > -20 && b.y < H + 20);

  // Bullet vs enemy / pod / rock.
  for (const b of bullets) {
    for (const e of enemies) {
      if (e.hp <= 0) continue;
      const sx = e.wx - G.worldX;
      const rr = e.r + 4;
      if (Math.abs(b.x - sx) < rr && Math.abs(b.y - e.y) < rr) {
        e.hp -= 1; b.dead = true;
        if (e.hp <= 0) {
          const pts = e.kind === 'saucer' ? 100 : e.kind === 'dart' ? 150 : 50;
          G.score += pts;
          addPopup(sx, e.y - 18, '+' + pts, '#ffd23f');
          explode(sx, e.y, e.kind === 'rock' ? '#c9a06a' : '#ff6b6b', 22);
          sfx.hit();
        }
        break;
      }
    }
    if (!b.dead) {
      for (const p of pods) {
        const sx = p.wx - G.worldX;
        if (Math.abs(b.x - sx) < 14 && Math.abs(b.y - p.y) < 16) {
          p.taken = true; b.dead = true;
          G.fuel = Math.min(100, G.fuel + 26);
          G.score += 80;
          addPopup(sx, p.y - 24, '+FUEL', '#7dff8a');
          explode(sx, p.y, '#7dff8a', 16);
          sfx.pickup();
          break;
        }
      }
    }
  }
  bullets = bullets.filter((b) => !b.dead);
  enemies = enemies.filter((e) => e.hp > 0);
  pods = pods.filter((p) => !p.taken && p.wx > G.worldX - 100);

  const gy = groundYAt(G.worldX + ship.x);
  // Ground collision.
  if (ship.y + 10 >= gy) { loseShip('crash'); return; }
  // Enemy ram / enemy bullet hits.
  if (G.invuln <= 0) {
    for (const e of enemies) {
      const sx = e.wx - G.worldX;
      if (Math.abs(sx - ship.x) < e.r + 12 && Math.abs(e.y - ship.y) < e.r + 10) { loseShip('ram'); return; }
    }
    for (const b of ebullets) {
      if (Math.abs(b.x - ship.x) < 14 && Math.abs(b.y - ship.y) < 10) { loseShip('shot'); return; }
    }
  } else {
    // Invulnerable: still clear overlapping bullets.
    ebullets = ebullets.filter((b) => !(Math.abs(b.x - ship.x) < 16 && Math.abs(b.y - ship.y) < 12));
  }
  if (G.fuel <= 0 && ship.y + 10 >= gy - 2) { loseShip('fuel'); }
}

// ---------- render ----------
function drawShip(x, y, tilt, invuln) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tilt || 0);
  if (invuln > 0 && Math.floor(G.time * 10) % 2 === 0) ctx.globalAlpha = 0.35;
  // Engine glow.
  const fl = 10 + Math.random() * 8 + (ship.flame > 0 ? 10 : 0);
  const grad = ctx.createLinearGradient(-26, 0, -14, 0);
  grad.addColorStop(0, 'rgba(255,120,40,0)');
  grad.addColorStop(1, '#ffcf5a');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(-14, -4); ctx.lineTo(-14 - fl, 0); ctx.lineTo(-14, 4); ctx.closePath(); ctx.fill();
  // Hull (Parsec arrow-dart).
  ctx.fillStyle = '#e8f1ff';
  ctx.strokeStyle = '#2b3a6b';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(26, 0); ctx.lineTo(2, -9); ctx.lineTo(-14, -9); ctx.lineTo(-8, -2);
  ctx.lineTo(-14, 2); ctx.lineTo(-14, 9); ctx.lineTo(2, 9);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#ff4d4d';
  ctx.fillRect(-10, -2, 14, 4);
  ctx.fillStyle = '#59d6ff';
  ctx.beginPath(); ctx.arc(8, 0, 3.4, 0, TAU); ctx.fill();
  ctx.restore();
}
function drawSaucer(sx, y, t) {
  ctx.save();
  ctx.translate(sx, y);
  ctx.fillStyle = 'rgba(255,80,80,0.25)';
  ctx.beginPath(); ctx.ellipse(0, 4, 20, 12, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = '#9aa7d0';
  ctx.beginPath(); ctx.ellipse(0, 3, 18, 7, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = '#dfe7ff';
  ctx.beginPath(); ctx.arc(0, -3, 7, Math.PI, 0); ctx.fill();
  ctx.fillStyle = (Math.floor(t * 6) % 2 === 0) ? '#ffd23f' : '#ff4d4d';
  ctx.beginPath(); ctx.arc(-10, 3, 2.2, 0, TAU); ctx.arc(0, 3, 2.2, 0, TAU); ctx.arc(10, 3, 2.2, 0, TAU); ctx.fill();
  ctx.restore();
}
function drawDart(sx, y) {
  ctx.save();
  ctx.translate(sx, y);
  ctx.fillStyle = '#c084ff';
  ctx.strokeStyle = '#4b2b8f';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-16, 0); ctx.lineTo(10, -10); ctx.lineTo(4, 0); ctx.lineTo(10, 10);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.fillRect(-2, -2, 5, 4);
  ctx.restore();
}
function drawRock(e, sx) {
  ctx.save();
  ctx.translate(sx, e.y);
  ctx.rotate(e.rot || 0);
  ctx.fillStyle = '#8a6f4d';
  ctx.strokeStyle = '#3d2f1e';
  ctx.lineWidth = 2;
  ctx.beginPath();
  const n = 8;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * TAU;
    const rr = e.r * (0.75 + hash((e.seed || 1) * 31 + i * 7) * 0.5);
    const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath(); ctx.arc(-e.r * 0.25, -e.r * 0.2, e.r * 0.3, 0, TAU); ctx.fill();
  ctx.restore();
}
function render() {
  const pal = palette(G.level);
  ctx.save();
  if (G.shake > 0) ctx.translate(rand(-G.shake, G.shake) * 0.4, rand(-G.shake, G.shake) * 0.4);
  // Sky.
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, pal.sky[0]);
  sky.addColorStop(1, pal.sky[1]);
  ctx.fillStyle = sky;
  ctx.fillRect(-20, -20, W + 40, H + 40);
  // Stars.
  for (const s of stars) {
    ctx.globalAlpha = 0.3 + s.z * 0.7;
    ctx.fillStyle = '#dfe8ff';
    ctx.fillRect(s.x, s.y, s.s, s.s);
  }
  ctx.globalAlpha = 1;
  // Far mountains (parallax).
  ctx.fillStyle = pal.far;
  ctx.beginPath();
  ctx.moveTo(-20, H);
  for (let x = -20; x <= W + 20; x += 24) {
    const wx = G.worldX * 0.3 + x;
    const y = H - 150 + Math.sin(wx * 0.008) * 40 + Math.sin(wx * 0.021 + 2) * 18;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(W + 20, H); ctx.closePath(); ctx.fill();
  // Terrain.
  ctx.beginPath();
  ctx.moveTo(-20, H + 20);
  for (let x = -20; x <= W + 20; x += 12) ctx.lineTo(x, groundYAt(G.worldX + x));
  ctx.lineTo(W + 20, H + 20); ctx.closePath();
  ctx.fillStyle = pal.ground;
  ctx.fill();
  ctx.beginPath();
  for (let x = -20; x <= W + 20; x += 12) {
    const y = groundYAt(G.worldX + x);
    if (x === -20) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = pal.edge;
  ctx.lineWidth = 3;
  ctx.stroke();
  // Fuel pods (red tanks on legs).
  for (const p of pods) {
    const sx = p.wx - G.worldX;
    if (sx < -20 || sx > W + 20) continue;
    const blink = 0.6 + 0.4 * Math.sin(G.time * 6 + p.wx);
    ctx.save();
    ctx.translate(sx, p.y);
    ctx.strokeStyle = '#5b6478'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-6, 12); ctx.lineTo(-6, 2); ctx.moveTo(6, 12); ctx.lineTo(6, 2); ctx.stroke();
    ctx.fillStyle = '#ff2e2e';
    ctx.fillRect(-8, -10, 16, 14);
    ctx.fillStyle = '#ffd23f';
    ctx.globalAlpha = blink;
    ctx.fillRect(-8, -10, 16, 3);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 9px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('F', 0, 1);
    ctx.restore();
  }
  // Enemies.
  for (const e of enemies) {
    const sx = e.wx - G.worldX;
    if (e.kind === 'saucer') drawSaucer(sx, e.y, e.t);
    else if (e.kind === 'dart') drawDart(sx, e.y);
    else if (e.kind === 'rock') drawRock(e, sx);
  }
  // Bullets.
  ctx.fillStyle = '#ffe97a';
  for (const b of bullets) {
    ctx.fillRect(b.x - 8, b.y - 1.5, 16, 3);
    ctx.fillStyle = '#fff';
    ctx.fillRect(b.x + 4, b.y - 1.5, 6, 3);
    ctx.fillStyle = '#ffe97a';
  }
  ctx.fillStyle = '#ff6b6b';
  for (const b of ebullets) {
    ctx.beginPath(); ctx.arc(b.x, b.y, 3.4, 0, TAU); ctx.fill();
  }
  // Ship + shadow.
  if (G.screen === 'play' || (G.screen === 'dying' && G.dieT > 0.9)) {
    const gy = groundYAt(G.worldX + ship.x);
    const hAbove = clamp(gy - ship.y, 0, 200);
    ctx.fillStyle = 'rgba(0,0,0,' + (0.35 * (1 - hAbove / 200)).toFixed(3) + ')';
    ctx.beginPath(); ctx.ellipse(ship.x, gy + 6, 20 * (1 - hAbove / 260), 5, 0, 0, TAU); ctx.fill();
    drawShip(ship.x, ship.y, ship.tilt, G.invuln);
  }
  // Particles / popups.
  for (const p of parts) {
    ctx.globalAlpha = 1 - p.life / p.maxLife;
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = 'center';
  for (const p of popups) {
    ctx.globalAlpha = 1 - p.t;
    ctx.fillStyle = p.color;
    ctx.font = 'bold 15px "Courier New", monospace';
    ctx.fillText(p.text, p.x, p.y);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
  drawHUD(pal);
  if (G.warn && G.warn.t > 0 && (G.screen === 'play' || G.screen === 'dying')) {
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(W / 2 - 260, 84, 520, 64);
    ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 2;
    ctx.strokeRect(W / 2 - 260, 84, 520, 64);
    ctx.fillStyle = '#ffd23f';
    ctx.font = 'bold 30px "Courier New", monospace';
    ctx.fillText(G.warn.text, W / 2, 112);
    if (G.warn.sub) {
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 14px "Courier New", monospace';
      ctx.fillText(G.warn.sub.toUpperCase(), W / 2, 134);
    }
  }
  if (G.screen === 'title') drawTitle();
  else if (G.screen === 'over') drawOver();
  else if (G.paused && G.screen === 'play') {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#ffd23f';
    ctx.textAlign = 'center';
    ctx.font = 'bold 40px "Courier New", monospace';
    ctx.fillText('PAUSED', W / 2, H / 2);
  }
  if (G.flash > 0) {
    ctx.fillStyle = 'rgba(255,255,255,' + Math.min(0.5, G.flash).toFixed(3) + ')';
    ctx.fillRect(0, 0, W, H);
  }
}
function drawHUD(pal) {
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, W, 40);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffd23f';
  ctx.font = 'bold 17px "Courier New", monospace';
  ctx.fillText('SCORE ' + String(G.score).padStart(6, '0'), 12, 26);
  // Fuel bar.
  ctx.fillStyle = '#7f8db3';
  ctx.font = 'bold 14px "Courier New", monospace';
  ctx.fillText('FUEL', 300, 25);
  ctx.fillStyle = '#222a4a';
  ctx.fillRect(360, 12, 220, 16);
  const fw = 220 * clamp(G.fuel / 100, 0, 1);
  ctx.fillStyle = G.fuel > 35 ? '#7dff8a' : (Math.floor(G.time * 6) % 2 ? '#ff2e2e' : '#7a1010');
  ctx.fillRect(360, 12, fw, 16);
  ctx.strokeStyle = '#5b6478'; ctx.lineWidth = 1;
  ctx.strokeRect(360.5, 12.5, 220, 16);
  // Ships + sector.
  ctx.fillStyle = '#dfe8ff';
  ctx.fillText('SHIPS ' + Math.max(0, G.lives - (G.screen === 'play' ? 0 : 0)), 610, 25);
  ctx.fillStyle = pal.edge;
  ctx.textAlign = 'right';
  ctx.fillText('SECTOR ' + G.level, W - 14, 26);
}
function drawScoreTable(y, rows) {
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffd23f';
  ctx.font = 'bold 18px "Courier New", monospace';
  ctx.fillText('— HIGH SCORES —', W / 2, y);
  ctx.font = 'bold 15px "Courier New", monospace';
  const rh = 18;
  rows.forEach((r, i) => {
    const ry = y + 22 + i * rh;
    ctx.fillStyle = i === 0 ? '#ffd23f' : '#dfe8ff';
    ctx.textAlign = 'right';
    ctx.fillText((i + 1) + '.', W / 2 - 130, ry);
    ctx.textAlign = 'left';
    ctx.fillText(r.name, W / 2 - 105, ry);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#7f8db3';
    ctx.fillText('SEC ' + r.sector, W / 2 + 10, ry);
    ctx.textAlign = 'right';
    ctx.fillStyle = i === 0 ? '#ffd23f' : '#dfe8ff';
    ctx.fillText(String(r.score), W / 2 + 150, ry);
  });
  ctx.textAlign = 'center';
}
function drawEntryBlock(y) {
  const en = G.nameEntry;
  ctx.textAlign = 'center';
  if (Math.floor(G.time * 2) % 2 === 0) {
    ctx.fillStyle = '#ff4d4d';
    ctx.font = 'bold 22px "Courier New", monospace';
    ctx.fillText('★ NEW HIGH SCORE ★', W / 2, y);
  }
  ctx.font = 'bold 34px "Courier New", monospace';
  let sx = W / 2 - 40;
  en.letters.forEach((li, i) => {
    ctx.fillStyle = i === en.pos ? '#ffd23f' : '#dfe8ff';
    ctx.fillText(ENTRY_CHARS[li], sx, y + 42);
    if (i === en.pos && Math.floor(G.time * 3) % 2 === 0) {
      ctx.fillRect(sx - 13, y + 50, 26, 3);
    }
    sx += 40;
  });
  ctx.fillStyle = '#7f8db3';
  ctx.font = '13px "Courier New", monospace';
  ctx.fillText('UP/DOWN: LETTER   RIGHT/FIRE: NEXT   ENTER: DONE', W / 2, y + 74);
}
function drawTitle() {
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffd23f';
  ctx.font = 'bold 64px "Courier New", monospace';
  ctx.fillText('PARSEC', W / 2, 120);
  ctx.fillStyle = '#dfe8ff';
  ctx.font = 'bold 15px "Courier New", monospace';
  ctx.fillText('A TI-99/4A STYLE HOMAGE', W / 2, 148);
  drawScoreTable(180, highscores.slice(0, 5));
  ctx.fillStyle = '#7dff8a';
  ctx.font = 'bold 16px "Courier New", monospace';
  ctx.fillText('ARROWS MOVE — SPACE FIRES — SHOOT RED PODS FOR FUEL', W / 2, 420);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 20px "Courier New", monospace';
  if (Math.floor(G.time * 2) % 2 === 0) ctx.fillText('PRESS ENTER, TAP OR ANY PAD BUTTON TO LAUNCH', W / 2, 452);
  ctx.fillStyle = '#7f8db3';
  ctx.font = '14px "Courier New", monospace';
  const pl = padLabel();
  ctx.fillText(pl ? 'PAD: ' + String(pl).slice(0, 34) : 'NO PAD SEEN — PRESS ANY PAD BUTTON TO WAKE IT', W / 2, 480);
}
function drawOver() {
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ff4d4d';
  ctx.font = 'bold 44px "Courier New", monospace';
  ctx.fillText('GAME OVER', W / 2, 84);
  ctx.fillStyle = '#ffd23f';
  ctx.font = 'bold 22px "Courier New", monospace';
  ctx.fillText('SCORE ' + G.score + '   SECTOR ' + G.level, W / 2, 116);
  if (G.nameEntry) {
    drawEntryBlock(140);
    drawScoreTable(268, highscores.slice(0, 6));
  } else {
    if (G.score > 0 && Math.floor(G.time * 2) % 2 === 0) {
      ctx.fillStyle = '#7dff8a';
      ctx.font = 'bold 16px "Courier New", monospace';
      ctx.fillText('SCORE LOGGED', W / 2, 142);
    }
    drawScoreTable(168, highscores.slice(0, 10));
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 19px "Courier New", monospace';
    if (Math.floor(G.time * 2) % 2 === 0) ctx.fillText('PRESS ENTER, TAP OR ANY PAD BUTTON TO FLY AGAIN', W / 2, 500);
  }
}

// ---------- main loop ----------
let lastT = 0;
let booted = false;
function frame(now) {
  try {
    if (!lastT) lastT = now;
    let dt = (now - lastT) / 1000;
    lastT = now;
    if (!(dt >= 0) || dt > 0.05) dt = dt > 0.05 ? 0.05 : 0.016;
    step(dt);
    render();
  } catch (err) {
    try { console.error(err); } catch (e) { /* noop */ }
  } finally {
    requestAnimationFrame(frame);
  }
}
function boot() {
  if (booted) return;
  booted = true;
  try {
    if (document.fonts && document.fonts.load) {
      document.fonts.load('bold 20px "Courier New"').catch(() => {});
      document.fonts.load('16px monospace').catch(() => {});
    }
  } catch (e) { /* fonts optional */ }
  fitScreen();
  requestAnimationFrame(frame);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
// Hook for automated smoke checks (harmless in the browser).
try {
  window.__parsec = { G, ship, step, render, startGame, groundYAt, spawnSaucer, handleEntryKey, commitEntry, padLabel, getScores: () => highscores };
} catch (e) { /* noop */ }
})();




