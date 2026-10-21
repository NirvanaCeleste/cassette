/* 分级诊断：每加一层东西就抓一次画面中心像素，找出黑屏从哪一级开始。 */
import * as THREE from 'three';
import { createEnvironments } from './env.js';
import { createRig, RIG } from './lights.js';
import { createCassette } from './cassette.js';
import { createSoftFloor } from './floor.js';
import { createComposer } from './post.js';
import { buildDeck } from './deck.js';

const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight, false);

const scene = new THREE.Scene();
const cam = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 1, 220);
cam.position.set(15, 10, 22);
cam.lookAt(0, 0, 0);

window.__stages = {};
function snap(label) {
  renderer.render(scene, cam);
  const src = renderer.domElement;
  const c = document.createElement('canvas');
  c.width = 320; c.height = 180;
  const g = c.getContext('2d');
  g.drawImage(src, 0, 0, 320, 180);
  const d = g.getImageData(140, 60, 40, 40).data;
  let r = 0, gr = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; gr += d[i + 1]; b += d[i + 2]; n++; }
  window.__stages[label] = {
    rgb: [Math.round(r / n), Math.round(gr / n), Math.round(b / n)],
    calls: renderer.info.render.calls,
    tris: renderer.info.render.triangles,
    kids: scene.children.length,
  };
}

/* A：红底 + 绿方块 + 白光 —— 验证画布与几何管线 */
renderer.setClearColor(0xff0000, 1);
scene.add(new THREE.AmbientLight(0xffffff, 0.5));
const dl = new THREE.DirectionalLight(0xffffff, 2.5);
dl.position.set(5, 10, 8);
scene.add(dl);
scene.add(new THREE.Mesh(new THREE.BoxGeometry(6, 6, 6), new THREE.MeshStandardMaterial({ color: 0x00cc44 })));
snap('A_box');

/* B：+ 卡座 */
const deck = buildDeck();
scene.add(deck.root);
snap('B_deck');

/* C：+ 环境光照 */
const envs = createEnvironments(renderer);
scene.environment = envs.noir;
snap('C_env');

/* D：+ 灯光组 */
const rig = createRig(scene);
rig.apply(RIG.noir, 0, true, 1);
snap('D_rig');

/* E：+ 磁带 */
const cas = createCassette({ title: '测试', artist: 'X', album: 'Y', minutes: '60' });
cas.root.position.set(8.6, 0.7, 6.4);
scene.add(cas.root);
snap('E_cassette');

/* F：+ 地板 */
const floorBase = createSoftFloor({ base: 0x0b0c0e, mix: 0.62, y: -1.62, interval: 2 });
scene.add(floorBase.mesh ?? floorBase.group ?? floorBase);
snap('F_floor');

/* G：composer 通道渲染 */
const cmp = createComposer(renderer, scene, cam);
composer_render();
function composer_render() {
  cmp.grade.uniforms.uFade.value = 1;
cmp.grade.uniforms.uCenter.value.set(0.5, 0.5);
  cmp.grade.uniforms.uTime.value = 0;
  cmp.composer.render();
  const src = renderer.domElement;
  const c = document.createElement('canvas');
  c.width = 320; c.height = 180;
  const g = c.getContext('2d');
  g.drawImage(src, 0, 0, 320, 180);
  const d = g.getImageData(140, 60, 40, 40).data;
  let r = 0, gr = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; gr += d[i + 1]; b += d[i + 2]; n++; }
  window.__stages.G_composer = {
    rgb: [Math.round(r / n), Math.round(gr / n), Math.round(b / n)],
  };
}
document.body.classList.add('ready');
