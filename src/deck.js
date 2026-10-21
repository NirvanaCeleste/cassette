/* 一台能用的卡座（ Deck ）：壳体、带仓、翻盖式仓门、五枚机械走带键、
   LCD 读数屏、VU 电平表、音量旋钮。全程序化几何，1 unit = 1 cm。
   键帽上的图标、LCD 的字都是烤成贴图的 canvas，灯效走 emissive。 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { clamp } from './anim.js';

export const DECK = {
  W: 26, D: 17, H: 6.0,
  floorY: -1.62,
  get topY() { return this.floorY + this.H; },
  bay: { cx: 0, cz: -2.3, w: 11.6, d: 7.9, depth: 1.7 },
  doorHingeZ: -6.35,
};

const ccanvas = (w, h) => {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
};

/* ---- 键帽图标贴图 ---- */
function keyIcon(glyph) {
  const c = ccanvas(128, 128), g = c.getContext('2d');
  g.clearRect(0, 0, 128, 128);
  g.fillStyle = '#e8e6df';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  if (glyph === 'rew') {
    g.beginPath(); g.moveTo(78, 30); g.lineTo(40, 64); g.lineTo(78, 98); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(112, 30); g.lineTo(74, 64); g.lineTo(112, 98); g.closePath(); g.fill();
  } else if (glyph === 'play') {
    g.beginPath(); g.moveTo(44, 26); g.lineTo(102, 64); g.lineTo(44, 102); g.closePath(); g.fill();
  } else if (glyph === 'ff') {
    g.beginPath(); g.moveTo(50, 30); g.lineTo(88, 64); g.lineTo(50, 98); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(16, 30); g.lineTo(54, 64); g.lineTo(16, 98); g.closePath(); g.fill();
  } else if (glyph === 'stop') {
    g.fillRect(38, 38, 52, 52);
  } else if (glyph === 'eject') {
    g.beginPath(); g.moveTo(64, 26); g.lineTo(96, 62); g.lineTo(32, 62); g.closePath(); g.fill();
    g.fillRect(32, 78, 64, 12);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/* ---- LCD 面板：canvas 烤字 + 自发光 ---- */
function makeLCD() {
  const W = 768, H = 224;
  const c = ccanvas(W, H), g = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mat = new THREE.MeshBasicMaterial({ map: tex });
  const state = { line1: 'NO TAPE', line2: '--:-- / --:--', glyph: '' };
  function draw() {
    g.fillStyle = '#060b07';
    g.fillRect(0, 0, W, H);
    // 扫描线质感
    g.fillStyle = 'rgba(120, 255, 180, 0.028)';
    for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 2);
    g.fillStyle = '#9dffb8';
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.font = '600 44px Consolas, "Courier New", monospace';
    g.fillText(state.line1, 26, 62);
    g.font = '300 76px Consolas, "Courier New", monospace';
    g.fillText(state.line2, 26, 152);
    if (state.glyph) {
      g.textAlign = 'right';
      g.font = '300 64px Consolas, "Courier New", monospace';
      g.fillText(state.glyph, W - 26, 152);
    }
    tex.needsUpdate = true;
  }
  draw();
  return {
    mesh: new THREE.Mesh(new THREE.PlaneGeometry(6.4, 1.87), mat),
    set(line1, line2, glyph = '') { state.line1 = line1; state.line2 = line2; state.glyph = glyph; draw(); },
  };
}

/* ---- VU 电平表：2 × 12 段 ---- */
function makeVU() {
  const segs = [];
  const group = new THREE.Group();
  const geo = new THREE.PlaneGeometry(0.30, 0.52);
  const COL = (i) => (i >= 10 ? 0xff5a3c : i >= 8 ? 0xffc23c : 0x51e07c);
  for (let ch = 0; ch < 2; ch++) {
    for (let i = 0; i < 12; i++) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: COL(i), transparent: true, opacity: 0.06,
      }));
      m.position.set(-1.9 + i * 0.345, ch === 0 ? 0.34 : -0.34, 0.001);
      group.add(m);
      segs.push({ m, i });
    }
  }
  let lv = [0, 0];
  return {
    group,
    set(l, r) { lv = [l, r]; },
    tick(dt) {
      for (const { m, i } of segs) {
        const v = lv[m.position.y > 0 ? 0 : 1];
        const on = clamp(v * 12 - i, 0, 1);
        m.material.opacity = 0.06 + on * 0.9;
      }
    },
  };
}

export function buildDeck() {
  const D = DECK;
  const root = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.5, metalness: 0.45 });
  const fasciaMat = new THREE.MeshStandardMaterial({ color: 0x1a1d22, roughness: 0.42, metalness: 0.5 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x0a0b0d, roughness: 0.8, metalness: 0.2 });

  /* ---- 壳体：主箱 + 顶面留出带仓的围边 ---- */
  const body = new THREE.Mesh(new RoundedBoxGeometry(D.W, D.H, D.D, 4, 0.35), bodyMat);
  body.position.y = D.floorY + D.H / 2;
  root.add(body);

  const { cx, cz, w, d, depth } = D.bay;
  const topY = D.topY;
  // 围边四条（前 / 后 / 左 / 右），围出带仓
  const frontStrip = new THREE.Mesh(new THREE.BoxGeometry(D.W - 0.7, 0.5, (D.D - d) / 2 - 0.4), fasciaMat);
  frontStrip.position.set(0, topY - 0.25, cz + d / 2 + ((D.D - d) / 2 - 0.4) / 2 + 0.15);
  const backStrip = frontStrip.clone();
  backStrip.position.z = cz - d / 2 - ((D.D - d) / 2 - 0.4) / 2 - 0.15;
  const sideL = new THREE.Mesh(new THREE.BoxGeometry((D.W - w) / 2 - 0.35, 0.5, d + 0.7), fasciaMat);
  sideL.position.set(-w / 2 - ((D.W - w) / 2 - 0.35) / 2 - 0.175, topY - 0.25, cz);
  const sideR = sideL.clone();
  sideR.position.x = w / 2 + ((D.W - w) / 2 - 0.35) / 2 + 0.175;
  root.add(frontStrip, backStrip, sideL, sideR);

  // 带仓内腔（深色井）
  const well = new THREE.Mesh(new THREE.BoxGeometry(w, depth, d), darkMat);
  well.position.set(cx, topY - 0.25 - depth / 2, cz);
  root.add(well);

  // 仓内主轴 / 磁头 / 压轮的剪影
  const inner = new THREE.Group();
  const spinGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.5, 18);
  const spinMat = new THREE.MeshStandardMaterial({ color: 0xd8d8d4, roughness: 0.35, metalness: 0.7 });
  for (const dx of [-2.15, 2.15]) {
    const s = new THREE.Mesh(spinGeo, spinMat);
    s.position.set(dx, 0.25, -0.30);
    inner.add(s);
  }
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 1.1),
    new THREE.MeshStandardMaterial({ color: 0x2c2e33, roughness: 0.3, metalness: 0.8 }));
  head.position.set(1.48, 0.25, 2.1);
  inner.add(head);
  const pinRoller = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.5, 14), spinMat);
  pinRoller.position.set(3.6, 0.25, 2.42);
  inner.add(pinRoller);
  inner.position.set(cx, topY - 0.25 - depth + 0.05, cz);
  root.add(inner);

  /* ---- 仓门：烟灰玻璃，铰链在后缘 ---- */
  const doorGroup = new THREE.Group();
  const glass = new THREE.Mesh(
    new THREE.BoxGeometry(w + 0.5, 0.14, d + 0.5),
    new THREE.MeshPhysicalMaterial({
      color: 0x9fb4bd, roughness: 0.12, metalness: 0,
      transparent: true, opacity: 0.22, transmission: 0,
    })
  );
  glass.position.z = (d + 0.5) / 2 - 0.25;         // 相对铰链向前伸
  doorGroup.add(glass);
  const doorFrame = new THREE.Mesh(
    new THREE.BoxGeometry(w + 0.5, 0.1, 0.35),
    new THREE.MeshStandardMaterial({ color: 0x22262c, roughness: 0.4, metalness: 0.6 })
  );
  doorFrame.position.set(0, 0, d + 0.5 - 0.25);
  doorGroup.add(doorFrame);
  doorGroup.position.set(cx, topY + 0.1, D.doorHingeZ);
  root.add(doorGroup);
  // open: 0 关 · 1 全开（绕后缘上掀）
  let doorP = 0, doorTarget = 0;
  const door = {
    get open() { return doorTarget; },
    set(v) { doorTarget = v ? 1 : 0; },
    tick(dt) {
      doorP = clamp(doorP + Math.sign(doorTarget - doorP) * dt / 0.55, 0, 1);
      const k = doorP < 0.5 ? 2 * doorP * doorP : 1 - Math.pow(-2 * doorP + 2, 2) / 2;
      doorGroup.rotation.x = -k * 1.75;
      return doorP;
    },
  };

  /* ---- 前面板：五枚机械键 / LCD / VU / 旋钮 ---- */
  const fasciaZ = D.D / 2 + 0.01;
  const keyDefs = [
    { id: 'rew', x: -6.6, glyph: 'rew' },
    { id: 'play', x: -3.3, glyph: 'play' },
    { id: 'ff', x: 0, glyph: 'ff' },
    { id: 'stop', x: 3.3, glyph: 'stop' },
    { id: 'eject', x: 6.6, glyph: 'eject' },
  ];
  const keyMat = new THREE.MeshStandardMaterial({ color: 0x23262c, roughness: 0.38, metalness: 0.55 });
  const keys = {};
  const keyMeshes = [];
  for (const k of keyDefs) {
    const g = new THREE.Group();
    const cap = new THREE.Mesh(new RoundedBoxGeometry(2.1, 1.45, 0.8, 3, 0.12), keyMat.clone());
    const icon = new THREE.Mesh(
      new THREE.PlaneGeometry(1.1, 1.1),
      new THREE.MeshBasicMaterial({ map: keyIcon(k.glyph), transparent: true, opacity: 0.85 })
    );
    icon.position.z = 0.41;
    g.add(cap, icon);
    g.position.set(k.x, D.floorY + 2.0, fasciaZ);
    root.add(g);
    keys[k.id] = { grp: g, baseY: g.position.y, press: 0, lit: 0, cap };
    keyMeshes.push({ id: k.id, mesh: cap, grp: g });
  }

  // LCD
  const lcd = makeLCD();
  lcd.mesh.position.set(-5.6, D.floorY + 4.05, fasciaZ);
  root.add(lcd.mesh);
  // LCD 亮度：无带时暗一点
  const lcdGlow = new THREE.PointLight(0x66ff9e, 0, 6);
  lcdGlow.position.set(-5.6, D.floorY + 4.2, fasciaZ + 0.6);
  root.add(lcdGlow);

  // VU
  const vu = makeVU();
  vu.group.position.set(3.9, D.floorY + 4.0, fasciaZ);
  root.add(vu.group);
  const vuBase = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 1.8),
    new THREE.MeshBasicMaterial({ color: 0x05080a }));
  vuBase.position.set(3.9, D.floorY + 4.0, fasciaZ - 0.01);
  root.add(vuBase);

  // 音量旋钮
  const knob = new THREE.Group();
  const kn = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.7, 28),
    new THREE.MeshStandardMaterial({ color: 0x2a2e34, roughness: 0.35, metalness: 0.6 }));
  kn.rotation.x = Math.PI / 2;
  const notch = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.6, 0.1),
    new THREE.MeshBasicMaterial({ color: 0xe8e6df }));
  notch.position.set(0, 0.45, 0.37);
  knob.add(kn, notch);
  knob.position.set(8.7, D.floorY + 4.0, fasciaZ);
  root.add(knob);

  // 铭牌
  {
    const c = ccanvas(512, 48), g = c.getContext('2d');
    g.fillStyle = 'rgba(0,0,0,0)'; g.clearRect(0, 0, 512, 48);
    g.fillStyle = 'rgba(210, 214, 220, .6)';
    g.font = '300 22px "Segoe UI", sans-serif';
    g.letterSpacing = '6px';
    g.fillText('OHM TAPE  ·  STEREO CASSETTE DECK  ·  OHM-100', 10, 32);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(7.4, 0.7),
      new THREE.MeshBasicMaterial({ map: t, transparent: true, opacity: 0.8 }));
    plate.position.set(-3.4, D.floorY + 0.75, fasciaZ);
    root.add(plate);
  }

  // 电源灯
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 10),
    new THREE.MeshBasicMaterial({ color: 0xff4a3c }));
  led.position.set(11.3, D.floorY + 4.3, fasciaZ);
  root.add(led);

  /* ---- 每帧：键的按压 / 灯效，门的开关 ---- */
  function tick(dt) {
    door.tick(dt);
    for (const id in keys) {
      const k = keys[id];
      const target = k.press;
      k.cap.position.z = 0;
      k.grp.position.y = k.baseY - k.press * 0.22;
      k.press = Math.max(0, k.press - dt * 5);
      const em = k.cap.material.emissiveIntensity ?? 0;
    }
    vu.tick(dt);
  }
  function pressKey(id) {
    const k = keys[id];
    if (k) k.press = 1;
  }
  function litKey(id, on) {
    const k = keys[id];
    if (!k) return;
    k.cap.material.emissive.set(0x8dffb0);
    k.cap.material.emissiveIntensity = on ? 0.55 : 0;
  }

  return {
    root, keys, keyMeshes, lcd, vu, door, knob, lcdGlow,
    tick, pressKey, litKey,
    /** 磁带在仓内的位姿 */
    bayPose: {
      pos: new THREE.Vector3(cx, topY - 0.25 - depth + 0.66, cz),
      rotX: -Math.PI / 2,
    },
  };
}
