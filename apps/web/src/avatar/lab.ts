// Dev-only preview (vite: /avatar-lab.html, ?n=300 for a crowd test). Not part of the production build.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { randomAvatar } from "@nyxeron/core";
import { buildRig, type Rig } from "./rig";
import { applyMove as applyMoveAt, danceAt } from "./moves";

const n = Number(new URLSearchParams(location.search).get("n") ?? 24);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color("#07050c");
const camera = new THREE.PerspectiveCamera(
  40,
  innerWidth / innerHeight,
  0.1,
  200,
);
camera.position.set(0, 2.2, 6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.6, 0);

scene.add(new THREE.HemisphereLight("#b9a6ff", "#2a1350", 1.4));
const key = new THREE.DirectionalLight("#ffffff", 1.6);
key.position.set(2, 5, 4);
scene.add(key);
const pink = new THREE.PointLight("#ff2bd6", 6, 12);
const cyan = new THREE.PointLight("#22d3ee", 6, 12);
scene.add(pink, cyan);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.MeshLambertMaterial({ color: "#140a24" }),
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

const cols = Math.ceil(Math.sqrt(n));
const rigs: { rig: Rig; seed: number }[] = [];
for (let i = 0; i < n; i++) {
  const seed = 1000 + i;
  const rig = buildRig(randomAvatar(seed, i % 2 === 1));
  rig.mesh.position.set(
    ((i % cols) - (cols - 1) / 2) * 0.75,
    0,
    (Math.floor(i / cols) - (cols - 1) / 2) * 0.75,
  );
  rig.mesh.rotation.y = Math.sin(i * 7.1) * 0.6;
  rig.mesh.scale.setScalar(1.15);
  scene.add(rig.mesh);
  rigs.push({ rig, seed });
}

const hud = document.getElementById("hud")!;
const BPM = 124;
let frames = 0;
let last = performance.now();
let fps = 0;
renderer.setAnimationLoop((now) => {
  const t = now / 1000;
  const b = (t * BPM) / 60;
  for (const { rig, seed } of rigs) {
    const d = danceAt(seed, b);
    applyMoveAt(rig, d.move, d.beat, d.energy);
  }
  pink.position.set(Math.sin(t) * 4, 2.5, Math.cos(t) * 4);
  cyan.position.set(-Math.sin(t * 0.7) * 4, 2.5, -Math.cos(t * 0.7) * 4);
  controls.update();
  renderer.render(scene, camera);
  frames++;
  if (now - last > 500) {
    fps = Math.round((frames * 1000) / (now - last));
    frames = 0;
    last = now;
    hud.innerHTML = `${n} avatars · ${fps} fps · ${renderer.info.render.calls} draw calls · ${renderer.info.render.triangles.toLocaleString()} tris<br><a href="?n=24">24</a><a href="?n=100">100</a><a href="?n=300">300</a><a href="?n=500">500</a>`;
  }
});
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
