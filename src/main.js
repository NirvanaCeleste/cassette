/* ════════════════════════════════════════════════════════════════════
   磁带盒 → 取出磁带 → 放入卡座 → 走带。三件实体：盒子、磁带、卡座。
   轻量直出渲染：一次场景绘制、两盏方向光 + 半球光、静态台面。
   磁带建模与卷带物理来自 cassette.js；机械声来自 audio.js。
   ════════════════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { createCassette } from './cassette.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Orbit } from './controls.js';
import { clamp } from './anim.js';
import * as TX from './textures.js';
import { TapeAudio } from './audio.js';
import { buildDeck } from './deck.js';
import { MIXTAPE, otherSide, trackAt } from './mixtape.js';

const canvas = document.getElementById('gl');
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const IS_MOBILE = matchMedia('(pointer: coarse)').matches;
let resScale = 1, emaFrame = 16, perfAcc = 0;
const $ = (id) => document.getElementById(id);

/* 机械音效 */
const sfx = {};
for (const n of ['click', 'clack', 'open', 'stop']) { const a = new Audio(`assets/sfx/${n}.wav`); sfx[n] = a; }
const play = n => { try { const a = sfx[n].cloneNode(); a.volume = 0.75; a.play().catch(() => {}); } catch {} };
const tick = () => play('click'), clack = () => play('clack');

/* 贴纸与封面印刷先于一切：ART_READY 完成后解析出封面图 */
const ART_READY = Promise.all([
  new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = 'assets/label-a.png'; }),
  new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = 'assets/label-b.png'; }),
  new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = 'assets/cover.png'; }),
]).then(([a, b, c]) => { TX.setLabelArt(a, b); return c; });

/* ============================== 渲染器 ================================ */
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, IS_MOBILE ? 1.25 : 1.5));
renderer.setSize(innerWidth, innerHeight, false);
renderer.toneMapping = THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.18;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 1, 260);

/* 房间背景 */
const backdrop = new THREE.Mesh(
  new THREE.SphereGeometry(80, 32, 24),
  new THREE.MeshBasicMaterial({
    side: THREE.BackSide, depthWrite: false,
    map: TX.backdropTexture({
      stops: [[0, '#12151a'], [0.44, '#1e232a'], [0.64, '#0d1014'], [1, '#040507']],
      spot: { u: 0.5, v: 0.42, r: 0.42, color: 'rgba(150,168,205,0.5)' },
    }),
  })
);
backdrop.frustumCulled = false;
scene.add(backdrop);

/* 灯光：主光（投影）+ 轮廓光 + 半球环境 */
scene.add(new THREE.AmbientLight(0xcfd6e2, 0.9));
const keyLight = new THREE.DirectionalLight(0xfff1e0, 1.7);
keyLight.position.set(9, 16, 12);
scene.add(keyLight);

/* 台面：静态渐变圆盘 */
{
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(256, 256, 40, 256, 256, 256);
  rg.addColorStop(0, '#1c1e24'); rg.addColorStop(0.55, '#0e1013'); rg.addColorStop(1, '#050607');
  g.fillStyle = rg; g.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(70, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: tex })
  );
  floor.position.y = -1.62;
  scene.add(floor);
}

/* 相机 */
const orbit = new Orbit(canvas, camera, {
  theta: 0.72, phi: 1.06, radius: 52, target: new THREE.Vector3(0, 1.6, 3),
  minR: 18, maxR: 90, minPhi: 0.18, maxPhi: 1.5,
  auto: false, reduce,
  onInteract: (dragging) => document.body.classList.toggle('dragging', dragging),
});
orbit.home = { theta: 0.72, phi: 1.06, radius: 52 };

/* ============================== 实体 ================================== */
const audio = new TapeAudio();
const audioEl = new Audio(MIXTAPE.sides.A.src);
audioEl.preload = 'auto';
audioEl.volume = .9;

let cas = null, deck = null, tapeBox = null;
const audioOk = () => audioEl.readyState >= 2 && isFinite(audioEl.duration) && audioEl.duration > 0;
const sideDur = (s) => (audioOk() && side === s ? audioEl.duration : MIXTAPE.sides[s].approx);

/* 磁带悬浮位姿（已取出、未入卡座） */
const HOVER = { pos: new THREE.Vector3(14.5, 2.8, 9.5), rot: { x: -0.5, y: 0.55 } };

/* ── 磁带盒（平放，盖向后开，盖内侧印封面） ── */
const BOX = { pos: new THREE.Vector3(-20.5, -1.62, 5.5) };
const BOX_TAPE_POSE = {
  pos: new THREE.Vector3(BOX.pos.x, BOX.pos.y + 1.16, BOX.pos.z + 0.25),
  rot: {},
};

const jcardCanvas = document.createElement('canvas');
jcardCanvas.width = 512; jcardCanvas.height = 317;

function drawJcard(coverImg) {
  const g = jcardCanvas.getContext('2d');
  g.fillStyle = '#040404'; g.fillRect(0, 0, 512, 317);
  if (coverImg) {
    const iw = coverImg.width, ih = coverImg.height;
    const sc = Math.max(512 / iw, 317 / ih) * 0.96;
    const w = iw * sc, h = ih * sc;
    g.filter = 'brightness(1.5)';
    g.drawImage(coverImg, (512 - w) / 2, (317 - h) / 2 + 30, w, h);
    g.filter = 'none';
  }
  g.fillStyle = 'rgba(240,240,240,.92)';
  g.font = '600 34px "Microsoft YaHei", serif';
  g.save(); g.translate(46, 300); g.rotate(-Math.PI / 2);
  g.fillText('苍穹耳语无限无垠', 0, 0);
  g.restore();
  g.fillStyle = 'rgba(230,230,230,.8)';
  g.font = '300 17px "Segoe UI", sans-serif';
  g.fillText('MIXTAPE NO.001 · 2026', 96, 300);
}

function buildBox(coverImg) {
  drawJcard(coverImg);
  const root = new THREE.Group();
  root.position.copy(BOX.pos);
  const W = 12.4, D = 7.6, WALL = 0.85;
  const shell = new THREE.MeshStandardMaterial({ color: 0x262932, roughness: 0.45, metalness: 0.45 });

  // 底板
  const base = new THREE.Mesh(new RoundedBoxGeometry(W, 0.5, D, 3, 0.2), shell);
  base.position.y = 0.25;
  root.add(base);
  // 四面矮围边
  const mk = (w, d, x, z) => {
    const m = new THREE.Mesh(new RoundedBoxGeometry(w, WALL, d, 2, 0.12), shell);
    m.position.set(x, 0.5 + WALL / 2, z);
    return m;
  };
  root.add(mk(W, 0.4, 0, -D / 2 + 0.2), mk(W, 0.4, 0, D / 2 - 0.2),
           mk(0.4, D - 0.8, -W / 2 + 0.2, 0), mk(0.4, D - 0.8, W / 2 - 0.2, 0));

  // 盒内衬：J-card 印刷平贴在底板上（磁带压在上面，露出一截）
  const jtex = new THREE.CanvasTexture(jcardCanvas);
  jtex.colorSpace = THREE.SRGBColorSpace;
  jtex.anisotropy = 8;
  const jcard = new THREE.Mesh(new THREE.PlaneGeometry(10.9, 6.7).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: jtex, roughness: 0.85 }));
  jcard.position.y = 0.52;
  root.add(jcard);

  // 盖：铰链在后缘，向后上翻开；内侧印封面
  const lid = new THREE.Group();
  const lidSlab = new THREE.Mesh(new RoundedBoxGeometry(W, 0.42, D, 3, 0.18),
    new THREE.MeshLambertMaterial({ color: 0x33373f }));
  lidSlab.position.set(0, 0.21, D / 2 - 0.21);
  // 封面印刷在盖子外表面（朝上，合盖时正对镜头）
  const jtexLid = new THREE.CanvasTexture(jcardCanvas);
  jtexLid.colorSpace = THREE.SRGBColorSpace;
  jtexLid.anisotropy = 8;
  const art = new THREE.Mesh(new THREE.PlaneGeometry(W - 1.4, D - 1.4).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ map: jtexLid }));
  art.rotation.y = Math.PI;                      // 翻转使图案朝向镜头正向
  art.position.set(0, 0.435, D / 2 - 0.21);
  lid.add(lidSlab, art);
  lid.position.set(0, 0.5, -D / 2);              // 铰链：后缘
  root.add(lid);

  let p = 0, target = 0;
  return {
    root, lidGroup: lid,
    setLid(open) { target = open ? 1 : 0; },
    get lidOpen() { return target === 1; },
    tick(dt) {
      p = clamp(p + Math.sign(target - p) * dt / 0.9, 0, 1);
      const k = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      lid.rotation.x = -k * 1.9;                 // 向后上方翻开
    },
  };
}

/* 材质降级：Standard/Physical → Lambert（无 PBR、无环境采样、无阴影） */
function cheapify(root) {
  root.traverse((o) => {
    if (!o.isMesh || !o.material || o.material.isMeshBasicMaterial || o.material.isMeshLambertMaterial) return;
    const m = o.material;
    o.material = new THREE.MeshLambertMaterial({
      color: m.color ? m.color.clone() : new THREE.Color(0xffffff),
      map: m.map || null,
      transparent: !!m.transparent,
      opacity: m.opacity ?? 1,
      side: m.side,
    });
  });
}

/* ═══════════════ 启动 ═══════════════ */
async function boot() {
  const coverImg = await ART_READY;

  deck = buildDeck();
  cheapify(deck.root);
  scene.add(deck.root);

  tapeBox = buildBox(coverImg);
  cheapify(tapeBox.root);
  scene.add(tapeBox.root);

  cas = createCassette({ title: MIXTAPE.title, artist: MIXTAPE.no, album: `${MIXTAPE.year} · 限量 1 张`, minutes: '60' });
  cas.st.onEnd = endOfSide;
  placeAt(cas.root, BOX_TAPE_POSE);
  cheapify(cas.root);
  scene.add(cas.root);

  audioEl.addEventListener('loadedmetadata', () => { if (audioOk()) cas.st.duration = audioEl.duration; });
  audioEl.addEventListener('ended', endOfSide);

  onResize();
  addEventListener('resize', onResize);
  bindPointer();
  updateLCD(true);
  // 预编译全部着色器程序并预热首帧，veil 盖住这段编译时间
  renderer.compile(scene, camera);
  renderer.render(scene, camera);
  hint('点击磁带盒 · 打开盒盖');
  document.body.classList.add('ready');
  loop();
}

/* ═══════════════ 走带状态机 ═══════════════
   tapeLoc: 'box'（在盒里）| 'hand'（已取出）| 'deck'（已入卡座）
   翻面物理：A、B 面共用同一条磁带的上下两半磁迹，翻面后位置镜像——
   B 面落点 = B 时长 × (1 − A 面已播比例)。A 面播完翻面，B 从头开始。 */
let side = 'A';
let tapeLoc = 'box', flipped = false;
let playing = false;
let wind = null;
let animP = null, busy = false;
let boxOpen = false;
let lastTrackIdx = -1;

const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function setWind(w) {
  if (tapeLoc !== 'deck' || busy) return;
  if (w === wind) w = null;
  wind = w;
  deck.litKey('rew', w === 'rew');
  deck.litKey('ff', w === 'ff');
  playing = false;
  deck.litKey('play', false);
  audioEl.pause();
  cas.st.driven = false;
  cas.st.playing = true;
  if (w === 'rew') { cas.st.dir = 1; audio.start(); audio.setLevel(0.2); }
  else if (w === 'ff') { cas.st.dir = 2; audio.start(); audio.setLevel(0.2); }
  else {
    cas.st.dir = -1;
    cas.st.playing = false;
    audio.stop();
  }
  updateLCD(true);
}

function togglePlay(force) {
  if (tapeLoc !== 'deck' || busy) {
    if (tapeLoc !== 'deck') hint('磁带还在盒子里 —— 点击盒子打开，取出磁带放入卡座');
    return;
  }
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
    audio.setLevel(0.13);
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

/** 带尾：自动倒回带头并停 */
function endOfSide() {
  playing = false;
  deck.litKey('play', false);
  audioEl.pause();
  cas.st.driven = false;
  cas.st.playing = true;
  cas.st.dir = 1;
  wind = 'rew';
  deck.litKey('rew', true);
  audio.start();
  audio.setLevel(0.2);
  updateLCD(true);
}

/** 翻面：只在磁带拿在手里时允许 */
function sideFlip() {
  if (busy) return;
  if (tapeLoc === 'deck') { hint('先按 ⏏ 弹出磁带再翻面'); return; }
  if (tapeLoc === 'box') { hint('先把磁带从盒里取出来'); return; }
  const frac = audioOk() && side === loadedSide
    ? clamp(audioEl.currentTime / audioEl.duration, 0, 1)
    : (cas.st.duration > 0 ? clamp(cas.st.time / cas.st.duration, 0, 1) : 0);
  side = otherSide(side);
  flipped = side === 'B';
  cas.setFlip(flipped);
  audio.clunk(0.9);
  lastTrackIdx = -1;
  const sd = MIXTAPE.sides[side];
  audioEl.src = sd.src;
  loadedSide = side;
  audioEl.load();
  audioEl.addEventListener('loadedmetadata', () => {
    if (audioOk()) {
      cas.st.duration = audioEl.duration;
      const at = audioEl.duration * (1 - frac);      // 镜像位置
      audioEl.currentTime = at;
      cas.setProgress(at / audioEl.duration);
    }
  }, { once: true });
  hint(`翻到 ${sd.cn}　点击卡座 · 放入磁带`);
  updateLCD(true);
}
let loadedSide = 'A';

/* ═══════════════ 磁带飞行（通用） ═══════════════ */
const EASE = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function flyTape(toPos, toRot, after, doorSeq) {
  busy = true;
  animP = {
    p: 0, dur: 1.2,
    q0: cas.root.quaternion.clone(),
    q1: new THREE.Quaternion().setFromEuler(new THREE.Euler(toRot.x || 0, toRot.y || 0, toRot.z || 0)),
    p0: cas.root.position.clone(),
    p1: toPos.clone(),
    after, doorSeq,
  };
  cas.st.driven = false;
  cas.st.playing = false;
}
function stepAnim(dt) {
  if (!animP) return;
  animP.p = Math.min(1, animP.p + dt / animP.dur);
  const k = EASE(animP.p);
  cas.root.position.lerpVectors(animP.p0, animP.p1, k);
  cas.root.quaternion.slerpQuaternions(animP.q0, animP.q1, k);
  if (animP.doorSeq === 'in') {
    if (animP.p > .3 && !animP.d1) { animP.d1 = true; deck.door.set(true); }
    if (animP.p > .78 && !animP.d2) { animP.d2 = true; deck.door.set(false); }
  } else if (animP.doorSeq === 'out') {
    if (animP.p > .22 && !animP.d1) { animP.d1 = true; deck.door.set(true); }
    if (animP.p > .8 && !animP.d2) { animP.d2 = true; deck.door.set(false); }
  }
  if (animP.p >= 1) {
    const cb = animP.after;
    busy = false; animP = null;
    if (cb) cb();
  }
}

function placeAt(root, pose) {
  root.position.copy(pose.pos);
  root.rotation.set(pose.rot.x || 0, pose.rot.y || 0, pose.rot.z || 0);
}

/* 取出：盒 → 手 */
function takeOut() {
  if (tapeLoc !== 'box' || busy) return;
  play('open');
  flyTape(HOVER.pos, HOVER.rot, () => {
    tapeLoc = 'hand';
    tapeBox.setLid(false);
    boxOpen = false;
    clack();
    hint('点击卡座 · 放入磁带　　点击磁带 · 翻面 A/B');
    updateLCD(true);
  }, null);
}

/* 放入：手 → 卡座 */
function insertTape() {
  if (tapeLoc !== 'hand' || busy) return;
  stopAll();
  play('clack');
  const bay = deck.bayPose;
  flyTape(bay.pos, flipped ? { x: Math.PI / 2, y: Math.PI } : { x: bay.rotX }, () => {
    tapeLoc = 'deck';
    clack();
    setKeys(true);
    lastTrackIdx = -1;
    hint('SPACE 播放 · R 倒带 · T 快进 · S 停止 · ⏏ 弹出');
    updateLCD(true);
  }, 'in');
}

/* 弹出：卡座 → 手 */
function ejectTape() {
  if (tapeLoc !== 'deck' || busy) return;
  stopAll();
  play('open');
  flyTape(HOVER.pos, HOVER.rot, () => {
    tapeLoc = 'hand';
    clack();
    setKeys(false);
    lastTrackIdx = -1;
    hint('点击磁带 · 翻面 A/B　　点击卡座 · 放入');
    updateLCD(true);
  }, 'out');
}

function setKeys(on) {
  for (const id of ['bPlay', 'bStop', 'bRew', 'bFf', 'bEject']) $(id) && ($(id).disabled = !on);
}

/* ═══════════════ LCD / VU / 浮字 ═══════════════ */
let popTimer = 0;
function announceTrack(sd, tr) {
  const side = $('tp-side'), no = $('tp-no'), name = $('tp-name'), pop = $('trkpop');
  if (!side || !no || !name || !pop) return;
  side.textContent = sd.cn;
  no.textContent = tr[0];
  name.textContent = tr[1];
  pop.classList.add('show');
  clearTimeout(popTimer);
  popTimer = setTimeout(() => pop.classList.remove('show'), 6500);
}
let hintTimer = 0;
function hint(text) {
  const el = $('hint');
  if (!el) return;
  el.textContent = text;
  el.style.opacity = '.9';
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => el.style.opacity = '.35', 9000);
}

function updateLCD(force) {
  if (!deck) return;
  const sd = MIXTAPE.sides[side];
  if (tapeLoc !== 'deck') {
    deck.lcd.set(`NO TAPE · SIDE ${side} UP`, '--:-- / --:--', '');
    deck.lcdGlow.intensity = 0.7;
    return;
  }
  const t = audioOk() ? audioEl.currentTime : cas.st.time;
  const tr = sd.tracks[trackAt(side, t)];
  const glyph = wind === 'rew' ? '◀◀' : wind === 'ff' ? '▶▶' : playing ? '▶' : '■';
  deck.lcd.set(`${sd.cn}·${tr[0]} ${tr[1]}`.slice(0, 26), `${fmt(t)} / ${sd.total}`, glyph);
  deck.lcdGlow.intensity = playing || wind ? 3.2 : 1.1;
}

/* VU 分析器（懒建，需用户手势） */
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
  } catch { /* 无分析器时 VU 走静默 */ }
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

/* ═══════════════ 指针交互 ═══════════════ */
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let downAt = null;

function raycastAt(cx, cy) {
  ndc.set((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const targets = [];
  if (cas && tapeLoc !== 'deck' && !animP) targets.push(cas.assembly);
  if (tapeBox && tapeLoc === 'box') targets.push(tapeBox.root);
  if (deck) {
    for (const k of deck.keyMeshes) targets.push(k.mesh);
    if (tapeLoc === 'hand' && !animP) targets.push(deck.root);
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
  {
    let p = o;
    while (p) { if (p === tapeBox.root) return { kind: 'box' }; p = p.parent; }
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
    if (moved > 6 || dtp > 500) return;
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
    else if (hit.id === 'eject') ejectTape();
  } else if (hit.kind === 'tape') {
    if (tapeLoc === 'box') { if (tapeBox.lidOpen) takeOut(); else hint('先点击盒盖 · 打开磁带盒'); }
    else if (tapeLoc === 'hand') sideFlip();
  } else if (hit.kind === 'box') {
    boxOpen = !boxOpen;
    tapeBox.setLid(boxOpen);
    play(boxOpen ? 'open' : 'clack');
    if (boxOpen && tapeLoc === 'box') hint('点击磁带 · 取出磁带');
  } else if (hit.kind === 'deck') {
    if (tapeLoc === 'hand') insertTape();
    else if (tapeLoc === 'box') hint('先从盒里取出磁带');
  }
}

addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); togglePlay(); }
  else if (k === 'r' && tapeLoc === 'deck') setWind(wind === 'rew' ? null : 'rew');
  else if (k === 't' && tapeLoc === 'deck') setWind(wind === 'ff' ? null : 'ff');
  else if (k === 's') stopAll();
  else if (k === 'e' && tapeLoc === 'deck') ejectTape();
  else if (k === 'f') sideFlip();
  else if (k === 'b' && tapeLoc === 'box' && tapeBox) { boxOpen = !boxOpen; tapeBox.setLid(boxOpen); }
});

/* ═══════════════ 主循环 ═══════════════ */
let last = performance.now(), t = 0;
let lastTitle = '';
let uiAcc = 0;

function loop() {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 1 / 20);
  frame(dt);
  requestAnimationFrame(loop);
}
function frame(dt) {
  last = performance.now();
  t += dt;

  // 走带耦合：播放由音频钟驱动；倒带/快进为机械模拟
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
  } else if (audioOk() && !audioEl.paused && !audioEl.ended && playing && tapeLoc === 'deck') {
    cas.st.driven = true;
    cas.setProgress(audioEl.currentTime / audioEl.duration);
  } else if (!playing && !wind) {
    cas.st.driven = false;
    cas.st.playing = false;
  }

  // 悬浮呼吸（只在手里）
  if (tapeLoc === 'hand' && !animP) {
    const bob = reduce ? 0 : Math.sin(t * 0.7) * 0.09;
    cas.root.position.set(HOVER.pos.x, HOVER.pos.y + bob, HOVER.pos.z);
    cas.root.rotation.y = HOVER.rot.y + (reduce ? 0 : Math.sin(t * 0.24) * 0.06);
    cas.root.rotation.z = reduce ? 0 : Math.sin(t * 0.4) * 0.012;
  }
  stepAnim(dt);
  const st = cas.update(dt);
  deck.tick(dt);
  tapeBox.tick(dt);
  tickVU();

  uiAcc += dt;
  if (uiAcc > 0.25) {
    uiAcc = 0;
    updateLCD();
    if (audioOk() && playing && tapeLoc === 'deck') {
      const idx = trackAt(side, audioEl.currentTime);
      if (idx !== lastTrackIdx) {
        lastTrackIdx = idx;
        announceTrack(MIXTAPE.sides[side], MIXTAPE.sides[side].tracks[idx]);
      }
    }
    const title = playing ? `♪ ${MIXTAPE.sides[side].cn} · ${MIXTAPE.title}` : `${MIXTAPE.title} — MIXTAPE NO.001`;
    if (title !== lastTitle) { lastTitle = title; document.title = title; }
  }

  orbit.update(dt);
  // 自适应分辨率
  emaFrame = emaFrame * 0.94 + Math.min(dt, 0.05) * 1000 * 0.06;
  perfAcc += dt;
  if (perfAcc > 1.5) {
    perfAcc = 0;
    if (emaFrame > 26 && resScale > 0.55) { resScale = Math.max(0.55, resScale - 0.12); onResize(); }
    else if (emaFrame < 15 && resScale < 1) { resScale = Math.min(1, resScale + 0.08); onResize(); }
  }
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

function onResize() {
  const w = innerWidth, h = innerHeight;
  const dpr = Math.min(devicePixelRatio || 1, IS_MOBILE ? 1.0 : 1.5) * resScale;
  camera.aspect = w / h;
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  camera.updateProjectionMatrix();
}

boot().catch((err) => {
  console.error(err);
  hint('初始化失败：' + (err?.message || err));
});
