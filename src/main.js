/* ════════════════════════════════════════════════════════════════════
   一盘磁带，和一台能用的卡座。没有别的实体——只有机器、带子、灯光，
   和走带的声音。场景编排：渲染 / 灯光 / 交互 / 走带状态机 / LCD / VU。
   磁带建模与卷带物理来自 cassette.js；机械声来自 audio.js。
   ════════════════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { createEnvironments } from './env.js';
import { createRig, RIG } from './lights.js';
import { createCassette } from './cassette.js';
import { createSoftFloor } from './floor.js';
import { createComposer } from './post.js';
import { Orbit } from './controls.js';
import { clamp } from './anim.js';
import * as TX from './textures.js';
import { TapeAudio } from './audio.js';
import { buildDeck } from './deck.js';
import { MIXTAPE, otherSide, trackAt } from './mixtape.js';

const canvas = document.getElementById('gl');
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (s) => document.querySelector(s);

/* 贴纸印刷先于一切：createCassette 首次画标签就要用 */
const LABEL_ART_READY = Promise.all([
  new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = 'assets/label-a.png'; }),
  new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = 'assets/label-b.png'; }),
]).then(([a, b]) => TX.setLabelArt(a, b));

/* ============================== 渲染器与舞台 ============================ */
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setSize(innerWidth, innerHeight, false);
renderer.toneMapping = THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 1, 220);

/* 房间：烤在球体内壁的暗色渐变（效果，不是实体） */
const BG = {
  stops: [[0, '#12151a'], [0.44, '#1e232a'], [0.64, '#0d1014'], [1, '#040507']],
  spot: { u: 0.5, v: 0.42, r: 0.42, color: 'rgba(150,168,205,0.5)' },
};
const backdrop = new THREE.Mesh(
  new THREE.SphereGeometry(70, 32, 24),
  new THREE.MeshBasicMaterial({ side: THREE.BackSide, depthWrite: false, map: TX.backdropTexture(BG) })
);
backdrop.frustumCulled = false;
scene.add(backdrop);

const envs = createEnvironments(renderer);
scene.environment = envs.noir;

const rig = createRig(scene);
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true;

const floorBase = createSoftFloor({ base: 0x0b0c0e, mix: 0.62, y: -1.62, interval: 2 });
scene.add(floorBase.mesh ?? floorBase.group ?? floorBase);

/* composer：AO / 辉光 / 颗粒 / 暗角 */
let composer, grade, bloom;
function buildComposer() {
  const c = createComposer(renderer, scene, camera);
  composer = c.composer; grade = c.grade; bloom = c.bloom;
}

/* 相机：可拖拽旋转 / 滚轮缩放 / 双击回家 */
const orbit = new Orbit(canvas, camera, {
  theta: 0.62, phi: 1.08, radius: 30, target: new THREE.Vector3(0, 1.4, 0.5),
  minR: 12, maxR: 48, minPhi: 0.18, maxPhi: 1.5,
  auto: false, reduce,
  onInteract: (dragging) => document.body.classList.toggle('dragging', dragging),
});
orbit.home = { theta: 0.62, phi: 1.08, radius: 30 };

/* ============================== 两件实体 ================================ */
const audio = new TapeAudio();
const audioEl = new Audio('assets/A%20side.mp3');
audioEl.preload = 'auto';
audioEl.volume = 0.9;

let cas = null, deck = null;
const audioOk = () => audioEl.readyState >= 2 && isFinite(audioEl.duration) && audioEl.duration > 0;
const sideDur = (s) => (audioOk() && side === s ? audioEl.duration : MIXTAPE.sides[s].approx);

/* 磁带在台面上的悬浮位姿 */
const HOVER = { pos: new THREE.Vector3(8.6, 0.7, 6.4), rotY: 0.55 };

async function boot() {
  await LABEL_ART_READY;
  deck = buildDeck();
  scene.add(deck.root);

  cas = createCassette({ title: MIXTAPE.title, artist: MIXTAPE.no, album: `${MIXTAPE.year} · 限量 1 张`, minutes: '60' });
  cas.st.onEnd = endOfSide;
  cas.root.position.copy(HOVER.pos);
  cas.root.rotation.y = HOVER.rotY;
  cas.root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  scene.add(cas.root);

  audioEl.addEventListener('loadedmetadata', () => { if (audioOk()) cas.st.duration = audioEl.duration; });
  audioEl.addEventListener('ended', endOfSide);

  buildComposer();
  rig.apply(RIG.noir, 0, true, 1);
  onResize();
  addEventListener('resize', onResize);
  bindPointer();
  updateLCD(true);
  hint('点击磁带 · 翻面　　点击卡座 · 放入磁带');
  document.body.classList.add('ready');
  loop();
}

/* ============================== 走带状态机 ==============================
   tapeIn: 磁带在不在仓里 · side: A/B · wind: null|'rew'|'ff' 机械走带
   翻面物理：A、B 面共用同一条磁带的上下两半磁迹；翻面后位置镜像——
   B 面落点 = B 时长 × (1 − A 面已播比例)。A 面播完翻面，B 从头开始。 */
let side = 'A';
let tapeIn = false, flipped = false;
let playing = false;
let wind = null;
let animP = null;                       // 插入/弹出动画进行中
let lastTrackIdx = -1;

const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function setWind(w) {
  if (!tapeIn || animP) return;
  if (w === wind) w = null;
  wind = w;
  deck.litKey('rew', w === 'rew');
  deck.litKey('ff', w === 'ff');
  playing = false;
  deck.litKey('play', false);
  audioEl.pause();
  cas.st.driven = false;
  cas.st.playing = true;                // 卷轴要转
  if (w === 'rew') { cas.st.dir = 1; audio.start(); audio.setLevel(0.4); }
  else if (w === 'ff') { cas.st.dir = 2; audio.start(); audio.setLevel(0.4); }
  else {
    cas.st.dir = -1;
    cas.st.playing = false;
    audio.stop();
  }
  updateLCD(true);
}

function togglePlay(force) {
  if (!tapeIn || animP) { if (!tapeIn) hint('先把磁带放入卡座 —— 点击卡座'); return; }
  const on = force ?? !playing;
  if (on && wind) setWind(null);
  playing = on;
  deck.litKey('play', on);
  if (on) {
    if (audioOk()) {
      if (audioEl.ended || audioEl.currentTime > audioEl.duration - 0.08) audioEl.currentTime = 0;
      audioEl.play().catch(() => {});
      ensureAnalyser();
    }
    audio.start();
    audio.setLevel(0.4);
  } else {
    audioEl.pause();
    audio.stop();
    cas.st.playing = false;
    cas.st.driven = false;
  }
  updateLCD(true);
}

function stopAll() {
  if (wind) setWind(null);
  playing = false;
  deck.litKey('play', false);
  audioEl.pause();
  audio.stop();
  cas.st.playing = false;
  cas.st.driven = false;
  updateLCD(true);
}

/** 带尾：自动倒回带头，停在起点（真实卡座的自动回零） */
function endOfSide() {
  playing = false;
  deck.litKey('play', false);
  audioEl.pause();
  cas.st.driven = false;
  cas.st.playing = true;
  cas.st.dir = 1;                        // 快速倒回
  wind = 'rew';                          // 走完这趟，停在带头（loop 里收尾）
  deck.litKey('rew', true);
  audio.start();
  audio.setLevel(0.4);
  updateLCD(true);
}

/** 翻面：只在磁带不在仓内时允许（真实使用也是如此） */
async function sideFlip() {
  if (tapeIn || animP) { if (tapeIn) hint('先按 ⏏ 弹出磁带再翻面'); return; }
  const frac = audioOk() && side === loadedSide
    ? clamp(audioEl.currentTime / audioEl.duration, 0, 1)
    : (cas.st.duration > 0 ? clamp(cas.st.time / cas.st.duration, 0, 1) : 0);
  side = otherSide(side);
  flipped = side === 'B';
  cas.setFlip(flipped);
  audio.clunk(0.9);
  lastTrackIdx = -1;
  // 换面：音频源跟着换，位置按镜像比例映射
  const sd = MIXTAPE.sides[side];
  audioEl.src = sd.src;
  loadedSide = side;
  audioEl.load();
  await new Promise((res) => {
    let done = false;
    const ok = () => { if (!done) { done = true; res(); } };
    audioEl.addEventListener('loadedmetadata', ok, { once: true });
    setTimeout(ok, 2500);
  });
  if (audioOk()) {
    cas.st.duration = audioEl.duration;
    const at = audioEl.duration * (1 - frac);
    audioEl.currentTime = at;
    cas.setProgress(at / audioEl.duration);
  }
  hint(`翻到 ${sd.cn}　点击卡座 · 放入磁带`);
  updateLCD(true);
}
let loadedSide = 'A';                    // 音频元素当前装的面

/* ============================== 放入 / 弹出 ============================= */
const EASE = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function insertTape() {
  if (tapeIn || animP) return;
  stopAll();
  animP = { kind: 'insert', p: 0 };
  deck.door.set(true);
  audio.clunk(0.6);
}
function ejectTape() {
  if (!tapeIn || animP) return;
  stopAll();
  animP = { kind: 'eject', p: 0 };
  deck.door.set(true);
  audio.clunk(0.6);
}

function stepAnim(dt) {
  if (!animP) return;
  animP.p += dt / 1.15;
  const k = EASE(clamp(animP.p, 0, 1));
  const bay = deck.bayPose;
  if (animP.kind === 'insert') {
    cas.root.position.lerpVectors(HOVER.pos, bay.pos, k);
    cas.root.rotation.y = HOVER.rotY * (1 - k);
    cas.root.rotation.x = bay.rotX * k;
    cas.root.rotation.z = 0;
    if (animP.p >= 0.42 && !animP.doorClosed) {
      animP.doorClosed = true;
      deck.door.set(false);
    }
    if (animP.p >= 1) {
      tapeIn = true;
      animP = null;
      audio.clunk(0.9);
      cas.root.position.copy(bay.pos);
      cas.root.rotation.set(bay.rotX, 0, 0);
      lastTrackIdx = -1;
      if (loadedSide !== side) swapAudioTo(side);
      hint('SPACE 播放　R 倒带　T 快进　S 停止　⏏ 弹出');
      updateLCD(true);
    }
  } else {
    cas.root.position.lerpVectors(bay.pos, HOVER.pos, k);
    cas.root.rotation.x = bay.rotX * (1 - k);
    cas.root.rotation.y = HOVER.rotY * k;
    if (animP.p >= 0.42 && !animP.doorClosed) {
      animP.doorClosed = true;
      deck.door.set(false);
    }
    if (animP.p >= 1) {
      tapeIn = false;
      animP = null;
      audio.clunk(0.8);
      cas.root.position.copy(HOVER.pos);
      cas.root.rotation.set(0, HOVER.rotY, 0);
      lastTrackIdx = -1;
      hint('点击磁带 · 翻面　　点击卡座 · 放入磁带');
      updateLCD(true);
    }
  }
}

/** 仓外翻面时切换音频面（镜像位置在 sideFlip 里处理） */
function swapAudioTo(s) {
  loadedSide = s;
  audioEl.src = MIXTAPE.sides[s].src;
  audioEl.load();
  audioEl.addEventListener('loadedmetadata', () => {
    if (audioOk()) cas.st.duration = audioEl.duration;
  }, { once: true });
}

/* ============================== LCD / VU / 浮字 ========================== */
const popEl = $('#trkpop');
let popTimer = 0;
function announceTrack(sd, tr) {
  $('#tp-side').textContent = sd.cn;
  $('#tp-no').textContent = tr[0];
  $('#tp-name').textContent = tr[1];
  popEl.classList.add('show');
  clearTimeout(popTimer);
  popTimer = setTimeout(() => popEl.classList.remove('show'), 6500);
}
const hintEl = $('#hint');
let hintTimer = 0;
function hint(text) {
  hintEl.textContent = text;
  clearTimeout(hintTimer);
  hintEl.classList.add('show');
  hintTimer = setTimeout(() => hintEl.classList.remove('show'), 9000);
}

function updateLCD(force = false) {
  if (!deck) return;
  const sd = MIXTAPE.sides[side];
  if (!tapeIn) {
    deck.lcd.set(`NO TAPE · SIDE ${side} UP`, '--:-- / --:--', '');
    deck.lcdGlow.intensity = 0.7;
    return;
  }
  const t = audioOk() ? audioEl.currentTime : cas.st.time;
  const idx = trackAt(side, t);
  const tr = sd.tracks[idx];
  const glyph = wind === 'rew' ? '◀◀' : wind === 'ff' ? '▶▶' : playing ? '▶' : '■';
  deck.lcd.set(`${sd.cn}·${tr[0]} ${tr[1]}`.slice(0, 26), `${fmt(t)} / ${sd.total}`, glyph);
  deck.lcdGlow.intensity = playing || wind ? 3.2 : 1.1;
}

/* VU：分析器挂在音乐元素上（懒建，需在用户手势后） */
let actx = null, analyser = null, freqData = null, vuLevel = [0, 0];
function ensureAnalyser() {
  if (actx || !window.AudioContext) return;
  try {
    actx = new AudioContext();
    const srcN = actx.createMediaElementSource(audioEl);
    analyser = actx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
    srcN.connect(analyser);
    analyser.connect(actx.destination);
    freqData = new Uint8Array(analyser.frequencyBinCount);
  } catch { /* 连不了分析器就跳过，VU 走静默 */ }
}
function tickVU() {
  if (analyser && playing) {
    analyser.getByteFrequencyData(freqData);
    const n = freqData.length;
    let l = 0, r = 0;
    for (let i = 0; i < n / 2; i++) l += freqData[i];
    for (let i = n / 2; i < n; i++) r += freqData[i];
    vuLevel[0] = Math.max(vuLevel[0] - 0.06, clamp((l / (n / 2)) / 210, 0, 1) * (0.55 + Math.random() * 0.45));
    vuLevel[1] = Math.max(vuLevel[1] - 0.06, clamp((r / (n / 2)) / 210, 0, 1) * (0.55 + Math.random() * 0.45));
  } else {
    vuLevel[0] = Math.max(0, vuLevel[0] - 0.03);
    vuLevel[1] = Math.max(0, vuLevel[1] - 0.03);
  }
  deck.vu.set(vuLevel[0], vuLevel[1]);
}

/* ============================== 指针交互 ================================ */
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let downAt = null;

function raycastAt(cx, cy) {
  ndc.set((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const targets = [];
  if (cas && !tapeIn && !animP) targets.push(cas.assembly);
  if (deck) {
    for (const k of deck.keyMeshes) targets.push(k.mesh);
    if (!tapeIn && !animP) targets.push(deck.root);
  }
  const hits = ray.intersectObjects(targets, true);
  if (!hits.length) return null;
  const o = hits[0].object;
  for (const k of deck.keyMeshes) {
    let p = o;
    while (p) { if (p === k.mesh) return { kind: 'key', id: k.id }; p = p.parent; }
  }
  {
    let p = o;
    while (p) { if (p === cas.assembly) return { kind: 'tape' }; p = p.parent; }
  }
  return { kind: 'deck' };
}

function bindPointer() {
  canvas.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    const dtp = performance.now() - downAt.t;
    downAt = null;
    if (moved > 6 || dtp > 500) return;                 // 拖拽视角，不算点击
    pick(e.clientX, e.clientY);
  });
  canvas.addEventListener('pointermove', (e) => {
    canvas.style.cursor = raycastAt(e.clientX, e.clientY) ? 'pointer' : '';
  });
}

function pick(cx, cy) {
  const hit = raycastAt(cx, cy);
  if (!hit) return;
  audio.tick();
  if (hit.kind === 'key') {
    deck.pressKey(hit.id);
    if (hit.id === 'play') togglePlay();
    else if (hit.id === 'stop') stopAll();
    else if (hit.id === 'rew') setWind(wind === 'rew' ? null : 'rew');
    else if (hit.id === 'ff') setWind(wind === 'ff' ? null : 'ff');
    else if (hit.id === 'eject') { tapeIn ? ejectTape() : insertTape(); }
  } else if (hit.kind === 'tape') {
    sideFlip();
  } else if (hit.kind === 'deck') {
    if (!tapeIn) insertTape();
    else hint('⏏ 弹出磁带 · SPACE 播放/暂停');
  }
}

addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); togglePlay(); }
  else if (k === 'r') { deck.pressKey('rew'); setWind(wind === 'rew' ? null : 'rew'); }
  else if (k === 't') { deck.pressKey('ff'); setWind(wind === 'ff' ? null : 'ff'); }
  else if (k === 's') { deck.pressKey('stop'); stopAll(); }
  else if (k === 'e') { deck.pressKey('eject'); tapeIn ? ejectTape() : insertTape(); }
  else if (k === 'f') sideFlip();
});

/* ============================== 主循环 ================================== */
let last = performance.now(), t = 0;
let lastTitle = '';
let uiAcc = 0;
const subjectPos = new THREE.Vector3();

function loop() {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  t += dt;

  // 走带耦合：播放由音频钟驱动；倒带/快进是内部机械模拟
  if (wind === 'rew' || (cas.st.dir === 1 && cas.st.playing && !playing)) {
    cas.st.driven = false;
    if (cas.st.dir === -1) {                      // 倒完了，停在带头
      wind = null;
      deck.litKey('rew', false);
      cas.st.playing = false;
      audio.stop();
      audioEl.currentTime = 0;
      cas.setProgress(0);
      lastTrackIdx = -1;
      updateLCD(true);
    }
  } else if (audioOk() && !audioEl.paused && !audioEl.ended && playing) {
    cas.st.driven = true;
    cas.setProgress(audioEl.currentTime / audioEl.duration);
  } else if (!playing && !wind) {
    cas.st.driven = false;
    cas.st.playing = false;
  }

  // 磁带悬浮呼吸（只在仓外）
  if (!tapeIn && !animP) {
    const bob = reduce ? 0 : Math.sin(t * 0.7) * 0.09;
    cas.root.position.y = HOVER.pos.y + bob;
    cas.root.rotation.y = HOVER.rotY + (reduce ? 0 : Math.sin(t * 0.24) * 0.06);
    cas.root.rotation.z = reduce ? 0 : Math.sin(t * 0.4) * 0.012;
  }
  stepAnim(dt);
  const st = cas.update(dt);
  deck.tick(dt);
  tickVU();

  // LCD 每 0.25s 刷时间；曲目变化时右下角报歌
  uiAcc += dt;
  if (uiAcc > 0.25) {
    uiAcc = 0;
    updateLCD();
    if (audioOk() && playing) {
      const idx = trackAt(side, audioEl.currentTime);
      if (idx !== lastTrackIdx) {
        lastTrackIdx = idx;
        const sd = MIXTAPE.sides[side];
        announceTrack(sd, sd.tracks[idx]);
      }
    }
    const title = playing ? `♪ ${MIXTAPE.sides[side].cn} · ${MIXTAPE.title}` : `${MIXTAPE.title} — MIXTAPE NO.001`;
    if (title !== lastTitle) { lastTitle = title; document.title = title; }
  }

  // 磁带位置的投影给暗角用
  cas.root.getWorldPosition(subjectPos).project(camera);
  grade.uniforms.uCenter.value.set(subjectPos.x * 0.5 + 0.5, subjectPos.y * 0.5 + 0.5);
  grade.uniforms.uTime.value = t;

  orbit.update(dt);
  const camMoved = Math.abs(camera.position.lengthSq() - (loop._cl ?? 0)) > 1e-6;
  loop._cl = camera.position.lengthSq();
  floorBase.update(renderer, scene, camera, camMoved);
  composer.render();
  requestAnimationFrame(loop);
}

/* ============================== 尺寸 ==================================== */
function onResize() {
  const w = innerWidth, h = innerHeight;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  camera.aspect = w / h;
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  camera.updateProjectionMatrix();
  const ss = w * dpr * h * dpr > 9.0e6 ? 1 : 1.25;
  const bw = Math.round(w * dpr * ss), bh = Math.round(h * dpr * ss);
  if (composer) composer.setSize(bw, bh);
  if (bloom) bloom.setSize(bw, bh);
  floorBase.setSize && floorBase.setSize(w, h);
}

window.__snap2 = () => {
  renderer.info.autoReset = true;
  renderer.render(scene, camera);
  window.__info = { calls: renderer.info.render.calls, tris: renderer.info.render.triangles };
  const src = renderer.domElement;
  const c = document.createElement('canvas');
  c.width = 720; c.height = Math.round(src.height / src.width * 720) || 405;
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
};
window.__snap = () => {
  composer.render();
  const src = renderer.domElement;
  const c = document.createElement('canvas');
  c.width = 720; c.height = Math.round(src.height / src.width * 720) || 405;
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
};
window.__dbg = () => ({
  calls: renderer.info.render.calls,
  tris: renderer.info.render.triangles,
  cam: camera.position.toArray().map((v) => +v.toFixed(1)),
  size: [renderer.domElement.width, renderer.domElement.height],
  env: !!scene.environment,
  veil: getComputedStyle(document.getElementById('veil')).opacity,
});
boot().catch((err) => {
  console.error(err);
  hint('初始化失败：' + (err?.message || err));
});
