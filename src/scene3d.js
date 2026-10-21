/* ════════════════════════════════════════════════════════════════════
   3D 展示层：磁带盒 + 磁带 + 卡座的"实物"交互。
   职责只有三件事：开盒、取出、放入；放入完成即把舞台交给 2D 播放层，
   自己停止一切渲染（播放期间 3D 零开销）。
   对外接口 window.Hybrid3D：enter / exit / insert / eject / flip / setSide
   事件（window 派发）：hybrid:inserted / hybrid:ejected / hybrid:flipped
   ════════════════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { createCassette } from './cassette.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Orbit } from './controls.js';
import { clamp } from './anim.js';
import * as TX from './textures.js';
import { buildDeck } from './deck.js';
import { MIXTAPE } from './mixtape.js';

const canvas = document.getElementById('gl');
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
let resScale = 1;
const $ = (id) => document.getElementById(id);

/* 贴纸与封面先于一切 */
const ART_READY = Promise.all([
  new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = 'assets/label-a.png'; }),
  new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = 'assets/label-b.png'; }),
  new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = 'assets/cover.png'; }),
]).then(([a, b, c]) => { TX.setLabelArt(a, b); return c; });

/* 渲染器：直出，无后期 */
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, matchMedia('(pointer: coarse)').matches ? 1.0 : 1.25));
renderer.setSize(innerWidth, innerHeight, false);
renderer.toneMapping = THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 1, 260);

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

scene.add(new THREE.AmbientLight(0xcfd6e2, 0.9));
const keyLight = new THREE.DirectionalLight(0xfff1e0, 1.7);
keyLight.position.set(9, 16, 12);
scene.add(keyLight);

{
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(256, 256, 40, 256, 256, 256);
  rg.addColorStop(0, '#1c1e24'); rg.addColorStop(0.55, '#0e1013'); rg.addColorStop(1, '#050607');
  g.fillStyle = rg; g.fillRect(0, 0, 512, 512);
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(70, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c) })
  );
  floor.position.y = -1.62;
  scene.add(floor);
}

const orbit = new Orbit(canvas, camera, {
  theta: 0.72, phi: 1.06, radius: 52, target: new THREE.Vector3(0, 1.6, 3),
  minR: 18, maxR: 90, minPhi: 0.18, maxPhi: 1.5,
  auto: false, reduce,
  onInteract: (dragging) => { document.body.classList.toggle('dragging', dragging); wake(6); },
});
orbit.home = { theta: 0.72, phi: 1.06, radius: 52 };

/* ═══════════════ 实体 ═══════════════ */
let cas = null, deck = null, tapeBox = null;

const HOVER = { pos: new THREE.Vector3(14.5, 2.8, 9.5), rot: { x: -0.5, y: 0.55 } };
const BOX = { pos: new THREE.Vector3(-20.5, -1.62, 5.5), yaw: 0.38, W: 11.8, H: 7.1, D: 2.6 };
const BOX_TAPE_POSE = {
  pos: new THREE.Vector3(
    BOX.pos.x + Math.sin(BOX.yaw) * 0.62,
    BOX.pos.y + BOX.H / 2 - 0.05,
    BOX.pos.z + Math.cos(BOX.yaw) * 0.62),
  rot: { y: BOX.yaw },
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
  root.rotation.y = BOX.yaw;
  const W = BOX.W, H = BOX.H, D = BOX.D;
  const shell = new THREE.MeshLambertMaterial({ color: 0x2e323b });

  const back = new THREE.Mesh(new RoundedBoxGeometry(W, H, 0.5, 3, 0.22), shell);
  back.position.z = -D / 2 + 0.25;
  const top = new THREE.Mesh(new RoundedBoxGeometry(W, 0.5, D, 3, 0.2), shell);
  top.position.y = H / 2 - 0.25;
  const bot = top.clone(); bot.position.y = -H / 2 + 0.25;
  const left = new THREE.Mesh(new RoundedBoxGeometry(0.5, H, D, 3, 0.2), shell);
  left.position.x = -W / 2 + 0.25;
  const right = left.clone(); right.position.x = W / 2 - 0.25;
  root.add(back, top, bot, left, right);

  const jtex = new THREE.CanvasTexture(jcardCanvas);
  jtex.colorSpace = THREE.SRGBColorSpace;
  jtex.anisotropy = 8;
  const jcard = new THREE.Mesh(new THREE.PlaneGeometry(W - 1.6, H - 1.15),
    new THREE.MeshLambertMaterial({ map: jtex }));
  jcard.position.z = -D / 2 + 0.62;
  root.add(jcard);

  const lid = new THREE.Group();
  const lidSlab = new THREE.Mesh(new RoundedBoxGeometry(W, 0.42, D, 3, 0.18),
    new THREE.MeshLambertMaterial({ color: 0x33373f }));
  lidSlab.position.set(0, 0.21, D / 2 - 0.21);
  const jtexLid = new THREE.CanvasTexture(jcardCanvas);
  jtexLid.colorSpace = THREE.SRGBColorSpace;
  const art = new THREE.Mesh(new THREE.PlaneGeometry(W - 1.4, D - 1.4).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ map: jtexLid }));
  art.rotation.y = Math.PI;
  art.position.set(0, 0.435, D / 2 - 0.21);
  lid.add(lidSlab, art);
  lid.position.set(-W / 2, 0, D / 2 - 0.13);
  root.add(lid);

  let p = 0, target = 0;
  return {
    root, setLid(open) { target = open ? 1 : 0; },
    get lidOpen() { return target === 1; },
    tick(dt) {
      p = clamp(p + Math.sign(target - p) * dt / 0.8, 0, 1);
      const k = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      lid.rotation.y = -k * 2.0;
    },
  };
}

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
let sfxClick, sfxClack, sfxOpen;
async function boot() {
  const coverImg = await ART_READY;
  sfxClick = new Audio('assets/sfx/click.wav');
  sfxClack = new Audio('assets/sfx/clack.wav');
  sfxOpen = new Audio('assets/sfx/open.wav');

  deck = buildDeck();
  cheapify(deck.root);
  scene.add(deck.root);

  tapeBox = buildBox(coverImg);
  cheapify(tapeBox.root);
  scene.add(tapeBox.root);

  cas = createCassette({ title: MIXTAPE.title, artist: MIXTAPE.no, album: `${MIXTAPE.year} · 限量 1 张`, minutes: '60' });
  placeAt(cas.root, BOX_TAPE_POSE);
  cheapify(cas.root);
  scene.add(cas.root);

  buildPickTargets();
  onResize();
  addEventListener('resize', onResize);
  bindPointer();
  renderer.render(scene, camera);
  document.body.classList.add('ready');
  hint('点击磁带盒 · 打开盒盖');
  loop(performance.now());
}

function placeAt(root, pose) {
  root.position.copy(pose.pos);
  root.rotation.set(pose.rot.x || 0, pose.rot.y || 0, pose.rot.z || 0);
}

/* ═══════════════ 盒 / 取出 / 放入 ═══════════════ */
let tapeLoc = 'box';            // 'box' | 'hand' | 'deck'
let busy = false, boxOpen = false;
let flipped = false;

function toggleBox() {
  if (tapeLoc !== 'box' || busy) return;
  boxOpen = !boxOpen;
  tapeBox.setLid(boxOpen);
  (boxOpen ? sfxOpen : sfxClack).play().catch(() => {});
  wake(60);
  hint(boxOpen ? '点击磁带 · 取出磁带' : '点击磁带盒 · 打开盒盖');
}

function takeOut() {
  if (tapeLoc !== 'box' || busy) return;
  sfxOpen.play().catch(() => {});
  busy = true;
  flyTo(HOVER, () => {
    tapeLoc = 'hand';
    tapeBox.setLid(false); boxOpen = false;
    sfxClack.play().catch(() => {});
    hint('点击卡座 · 放入磁带　　点击磁带 · 翻面 A/B');
  });
}

function insert() {
  if (tapeLoc !== 'hand' || busy) return;
  sfxClack.play().catch(() => {});
  busy = true;
  const bay = deck.bayPose;
  flyTo({ pos: bay.pos, rot: { x: bay.rotX, y: flipped ? Math.PI : 0 } }, () => {
    tapeLoc = 'deck';
    sfxClack.play().catch(() => {});
    dispatch('hybrid:inserted');
  }, 'in');
}

/* 2D 层调用：从卡座弹出到手 */
function ejectTo3D() {
  if (tapeLoc !== 'deck' || busy) return;
  tapeLoc = 'ejecting';
  mode = '3d';
  Hybrid.enter();
  const bay = deck.bayPose;
  placeAt(cas.root, { pos: bay.pos, rot: { x: bay.rotX, y: flipped ? Math.PI : 0 } });
  wake(999);
  busy = true;
  flyTo(HOVER, () => {
    tapeLoc = 'hand';
    sfxClack.play().catch(() => {});
    dispatch('hybrid:ejected');
    hint('点击磁带 · 翻面 A/B　　点击卡座 · 放入');
  }, 'out');
}

/* 翻面（视觉）：壳体翻转并广播 */
function flip() {
  flipped = !flipped;
  wake(8);
  cas.setFlip(flipped);
  sfxClack.play().catch(() => {});
  dispatch('hybrid:flipped', { sideB: flipped });
}

/* ═══════════════ 飞行动画 ═══════════════ */
const EASE = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
let animP = null;

function flyTo(to, after, doorSeq) {
  const q1 = new THREE.Quaternion().setFromEuler(new THREE.Euler(to.rot.x || 0, to.rot.y || 0, to.rot.z || 0));
  animP = {
    p: 0, dur: 1.2,
    q0: cas.root.quaternion.clone(), q1,
    p0: cas.root.position.clone(), p1: to.pos.clone ? to.pos.clone() : new THREE.Vector3(to.pos.x, to.pos.y, to.pos.z),
    after, doorSeq,
  };
  wake(999);
}
function stepAnim(dt) {
  if (!animP) return;
  animP.p = Math.min(1, animP.p + dt / animP.dur);
  const k = EASE(animP.p);
  cas.root.position.lerpVectors(animP.p0, animP.p1, k);
  cas.root.quaternion.slerpQuaternions(animP.q0, animP.q1, k);
  wake(2);
  if (animP.doorSeq === 'in') {
    if (animP.p > .3 && !animP.d1) { animP.d1 = true; deck.door.set(true); }
    if (animP.p > .78 && !animP.d2) { animP.d2 = true; deck.door.set(false); }
  } else if (animP.doorSeq === 'out') {
    if (animP.p > .22 && !animP.d1) { animP.d1 = true; deck.door.set(true); }
    if (animP.p > .8 && !animP.d2) { animP.d2 = true; deck.door.set(false); }
  }
  if (animP.p >= 1) {
    const cb = animP.after;
    animP = null;
    if (cb) cb();
  }
}

/* ═══════════════ 拾取（代理体） ═══════════════ */
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const pickTargets = [];
let downAt = null, lastMovePick = 0;

function buildPickTargets() {
  const mk = (parent, w, h, d, kind) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
      new THREE.MeshBasicMaterial({ visible: false }));
    m.userData.pick = kind;
    parent.add(m);
    pickTargets.push(m);
  };
  mk(cas.root, 10.4, 6.6, 1.5, 'tape');
  mk(tapeBox.root, BOX.W, BOX.H, BOX.D, 'box');
  mk(deck.root, 26, 6, 17, 'deck');
}
function raycastAt(cx, cy) {
  ndc.set((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects(pickTargets, false);
  return hits.length ? hits[0].object.userData.pick : null;
}
function bindPointer() {
  canvas.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    const dtp = performance.now() - downAt.t;
    downAt = null;
    if (moved > 6 || dtp > 500) return;
    const hit = raycastAt(e.clientX, e.clientY);
    if (!hit) return;
    if (hit === 'tape') {
      if (tapeLoc === 'box') { if (tapeBox.lidOpen) takeOut(); else hint('先点击盒盖 · 打开磁带盒'); }
      else if (tapeLoc === 'hand') flip();
    } else if (hit === 'box') {
      toggleBox();
    } else if (hit === 'deck') {
      if (tapeLoc === 'hand') insert();
      else if (tapeLoc === 'box') hint('先从盒里取出磁带');
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const now = performance.now();
    if (now - lastMovePick < 100) return;
    lastMovePick = now;
    canvas.style.cursor = raycastAt(e.clientX, e.clientY) ? 'pointer' : '';
  });
}

/* ═══════════════ 渲染循环（按需） ═══════════════ */
let last = performance.now(), t = 0, frameGate = 0, lastRender = 0;
const FRAME_MIN = 1000 / 30;
function wake(n = 2) { frameGate = Math.max(frameGate, n); }

function frame(dt) {
  t += dt;
  stepAnim(dt);
  cas.update(dt);
  deck.tick(dt);
  tapeBox.tick(dt);
  if (tapeLoc === 'hand' && !animP) {
    wake(1);
    const bob = reduce ? 0 : Math.sin(t * 0.7) * 0.09;
    cas.root.position.set(HOVER.pos.x, HOVER.pos.y + bob, HOVER.pos.z);
    cas.root.rotation.y = (HOVER.rot.y) + (reduce ? 0 : Math.sin(t * 0.24) * 0.06);
    cas.root.rotation.z = reduce ? 0 : Math.sin(t * 0.4) * 0.012;
  }
  orbit.update(dt);
  emaFrame = emaFrame * 0.94 + Math.min(dt, 0.05) * 1000 * 0.06;
  perfAcc += dt;
  if (perfAcc > 1.5) {
    perfAcc = 0;
    if (emaFrame > 26 && resScale > 0.55) { resScale = Math.max(0.55, resScale - 0.12); onResize(); }
    else if (emaFrame < 15 && resScale < 1) { resScale = Math.min(1, resScale + 0.08); onResize(); }
  }
}
let emaFrame = 16, perfAcc = 0;
function loop(now) {
  const dt = Math.min((now - last) / 1000, 1 / 20);
  frame(dt);
  frameGate = Math.max(0, frameGate - 1);
  const active = animP || tapeLoc === 'hand' || orbit.dragging || frameGate > 0;
  if (active && now - lastRender >= FRAME_MIN) {
    renderer.render(scene, camera);
    lastRender = now;
  }
  if (mode === '3d') requestAnimationFrame(loop);
  else rafAlive = false;
}
function onResize() {
  const w = innerWidth, h = innerHeight;
  const dpr = Math.min(devicePixelRatio || 1, matchMedia('(pointer: coarse)').matches ? 1.0 : 1.25) * resScale;
  camera.aspect = w / h;
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  camera.updateProjectionMatrix();
}
addEventListener('resize', onResize);

/* ═══════════════ 对 2D 层的接口 ═══════════════ */
let mode = '3d';                     // '3d' 展示层 | '2d' 播放层（3D 停止渲染）
function dispatch(name, detail) { window.dispatchEvent(new CustomEvent(name, { detail })); }

let rafAlive = true;
window.Hybrid3D = {
  /** 磁带已插入（2D 接管）：3D 停止渲染 */
  exit() {
    mode = '2d';
    document.body.classList.add('playing2d');
  },
  /** 回到 3D 层 */
  enter() {
    mode = '3d';
    document.body.classList.remove('playing2d');
    if (!rafAlive) { rafAlive = true; requestAnimationFrame((t) => loop(t)); }
    wake(999);
    last = performance.now();
  },
  /** 翻面（磁带在手时） */
  flip,
  /** 2D 层请求弹出：门开、磁带飞回悬浮，完成后派发 hybrid:ejected */
  ejectTo3D,
  /** 2D 层的翻面同步（仅壳体视觉） */
  setSideFlipped(isB) {
    flipped = isB;
    if (tapeLoc !== 'deck') cas.setFlip(flipped);
  },
  get tapeOut() { return tapeLoc === 'hand'; },
};

/* hint 元素由 2D 层持有，这里转发文本 */
const hintEl = document.getElementById('hint');
function hint(text) { if (hintEl) { hintEl.textContent = text; hintEl.style.opacity = '.9'; clearTimeout(hint.t); hint.t = setTimeout(() => hintEl.style.opacity = '.35', 9000); } }

boot().catch((err) => {
  console.error(err);
  hint('初始化失败：' + (err?.message || err));
});
