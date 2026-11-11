// Sidehit — app shell: rendering, modes (menu / ride / edit), camera, HUD, input.
import * as THREE from '../vendor/three.module.min.js';
import { Terrain, sparkle, quality } from './terrain.js';
import { EffectComposer } from '../vendor/post/EffectComposer.js';
import { RenderPass } from '../vendor/post/RenderPass.js';
import { UnrealBloomPass } from '../vendor/post/UnrealBloomPass.js';
import { OutputPass } from '../vendor/post/OutputPass.js';
import { Player, airTricks } from './player.js';
import { Rider, LOOK_OPTIONS, sanitizeLook } from './rider.js';
import { Sound } from './audio.js';
import { Editor } from './editor.js';
import { MODES } from './player.js';
import { BUILTIN, loadCustom, saveCustom, sanitizeMap, blankMap, newId, getBest, setBest, isBuiltin, centerX } from './maps.js';

const DT = 1 / 120, TAU = Math.PI * 2;
const touch = matchMedia('(pointer: coarse)').matches;
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));

// ---------------------------------------------------------------- scene ----
const canvas = $('view');
// smoothing edges is only worth its cost on ordinary-density screens
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !touch && devicePixelRatio <= 1.25, powerPreference: 'high-performance' });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;   // refreshed every other frame, see the loop
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
const FOG_FAR = touch ? 460 : 600;   // phones draw a shorter distance
scene.fog = new THREE.Fog(0xffffff, 140, FOG_FAR);
const camera = new THREE.PerspectiveCamera(64, 1, 0.3, 6000);
const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
const sun = new THREE.DirectionalLight(0xffffff, 3);
const sunDir = new THREE.Vector3();
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.06;
sun.shadow.radius = 3;
scene.add(hemi, sun, sun.target);

// Sky: a golden-hour alpine panorama painted with Higgsfield (textures/sky.webp). The file holds the
// picture next to its mirror image, so it wraps seamlessly; it repeats twice around the horizon.
// Above the picture the sky fades to the zenith colour, below it into the valley haze.
const panorama = new THREE.TextureLoader().load('textures/sky.webp');
panorama.wrapS = THREE.RepeatWrapping;
panorama.colorSpace = THREE.SRGBColorSpace;
const skyU = {
  zenith: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, sunCol: { value: new THREE.Color() }, sunDir: { value: sunDir },
  pano: { value: panorama }, tint: { value: new THREE.Color(1, 1, 1) },
  // elevation (radians) of the picture's bottom and top edges: keeps its proportions, peaks just above eye level
  elBot: { value: THREE.MathUtils.degToRad(-22.8) }, elTop: { value: THREE.MathUtils.degToRad(27.8) },
};
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(4500, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false, uniforms: skyU,
    vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec3 zenith, horizon, sunCol, sunDir, tint; uniform sampler2D pano; uniform float elBot, elTop; varying vec3 vDir;
      void main(){
        vec3 d = normalize(vDir);
        float el = asin(clamp(d.y, -1.0, 1.0));
        float v = (el - elBot) / (elTop - elBot);
        // shifted a quarter turn so the mirror seams sit 45 degrees either side of downhill (+z), not straight ahead
        float u = atan(d.z, d.x) / 3.14159265 + 0.25;
        vec3 col = texture2D(pano, vec2(u, clamp(v, 0.004, 0.996))).rgb * tint;
        col = mix(col, zenith * tint, smoothstep(0.9, 1.25, v));
        col = mix(col, horizon, smoothstep(0.12, -0.05, v));
        float s = max(dot(d, sunDir), 0.0);
        col += sunCol * pow(s, 900.0) * 3.0;
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  }),
);
sky.frustumCulled = false;
sky.renderOrder = -2;
scene.add(sky);

// distant ranges that travel with the camera
function makeRange(radius, base, amp, seed) {
  const N = 220, pos = [], idx = [];
  const ridge = (a) => { let h = 0; for (let o = 0; o < 5; o++) h += Math.abs(Math.sin(a * (3 + o * 4.7) + seed * (o + 1) * 1.7)) / (o + 1.4); return h; };
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * TAU, x = Math.cos(a) * radius, z = Math.sin(a) * radius;
    pos.push(x, base + amp * ridge(a), z, x, -1600, z);
    if (i < N) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 2, i * 2 + 1, i * 2 + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide, depthWrite: false }));
  m.frustumCulled = false;
  m.renderOrder = -1;
  scene.add(m);
  return m;
}
const ranges = [makeRange(4000, -150, 420, 1.3), makeRange(3000, -420, 380, 4.1)];
for (const r of ranges) r.visible = false;   // kept for reference; the panorama does this job now
function tintRange(mesh, top, bottom) {
  const c = mesh.geometry.attributes.color;
  for (let i = 0; i < c.count; i++) { const k = i % 2 ? bottom : top; c.setXYZ(i, k.r, k.g, k.b); }
  c.needsUpdate = true;
}

const SKY = {
  bluebird: { tint: [0.97, 1.02, 1.1], fog: 0xb4bfcf, glint: 1, zenith: 0x1f66cc, haze: 0xc4dcf2, sun: 0xffe9cf, power: 3.1, hemiSky: 0xa9cdfc, hemiGround: 0xf4f8ff, hemi: 1.5, dir: [-0.55, 0.42, 0.62], exposure: 1.4 },
  golden: { tint: [1, 1, 1], fog: 0xb3a59c, glint: 0.8, zenith: 0x4a6cb5, haze: 0xf3c9a8, sun: 0xffa868, power: 3.6, hemiSky: 0x9fb2e8, hemiGround: 0xffe2d0, hemi: 1.2, dir: [-0.78, 0.2, 0.55], exposure: 1.3 },
  dusk: { tint: [0.42, 0.48, 0.72], fog: 0x4f5878, glint: 0.25, zenith: 0x0c1a48, haze: 0x5a6aa6, sun: 0xb4c8ff, power: 1.7, hemiSky: 0x5068b8, hemiGround: 0x93a4d8, hemi: 1.15, dir: [0.45, 0.5, 0.45], exposure: 1.2 },
};
function applySky(name) {
  const s = SKY[name] || SKY.bluebird, haze = new THREE.Color(s.haze), white = new THREE.Color(0xffffff);
  skyU.zenith.value.set(0x578cbc);
  skyU.tint.value.setRGB(...s.tint);
  haze.set(s.fog);
  skyU.horizon.value.copy(haze);
  skyU.sunCol.value.set(s.sun);
  sunDir.set(...s.dir).normalize();
  scene.fog.color.copy(haze);
  sun.color.set(s.sun);
  sun.intensity = s.power;
  hemi.color.set(s.hemiSky);
  hemi.groundColor.set(s.hemiGround);
  hemi.intensity = s.hemi;
  renderer.toneMappingExposure = s.exposure;
  sparkle.value = gfx.mode === 'low' ? 0 : s.glint;
  const z = new THREE.Color(s.zenith);
  document.body.style.background = '#' + haze.getHexString();
}

// snow spray
const SPRAY = 320;
const spray = { pos: new Float32Array(SPRAY * 3).fill(-1e5), vel: new Float32Array(SPRAY * 3), life: new Float32Array(SPRAY), next: 0 };
{
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d'), grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 32, 32);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(spray.pos, 3));
  spray.points = new THREE.Points(geo, new THREE.PointsMaterial({ map: new THREE.CanvasTexture(c), size: 0.55, transparent: true, opacity: 0.85, depthWrite: false }));
  spray.points.frustumCulled = false;
  scene.add(spray.points);
}
function puff(p, vx, vy, vz, spread) {
  const i = spray.next;
  spray.next = (i + 1) % SPRAY;
  const k = i * 3;
  spray.pos[k] = p.x; spray.pos[k + 1] = p.y + 0.1; spray.pos[k + 2] = p.z;
  spray.vel[k] = vx + (Math.random() - 0.5) * spread; spray.vel[k + 1] = vy + Math.random() * spread * 0.6; spray.vel[k + 2] = vz + (Math.random() - 0.5) * spread;
  spray.life[i] = 0.28 + Math.random() * 0.3;
}

// The trench the board cuts: bright walls sloping into a shadowed floor.
const TRAIL = 640, ACROSS = 4;
const trail = { pos: new Float32Array(TRAIL * ACROSS * 3), col: new Float32Array(TRAIL * ACROSS * 4), on: new Float32Array(TRAIL), last: new THREE.Vector3(1e9, 0, 0) };
{
  const geo = new THREE.BufferGeometry(), idx = [];
  for (let i = 0; i < TRAIL - 1; i++) for (let k = 0; k < ACROSS - 1; k++) {
    const a = i * ACROSS + k, b = a + 1, c = a + ACROSS, d = c + 1;
    idx.push(a, b, c, c, b, d);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(trail.pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(trail.col, 4));
  geo.setIndex(idx);
  trail.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  trail.mesh.frustumCulled = false;
  scene.add(trail.mesh);
}
// A slice is drawn only if its neighbours touched the snow too; walls are fainter than the floor.
function trailAlpha(i) {
  const joined = trail.on[i] && (i === 0 || trail.on[i - 1]) && (i === TRAIL - 1 || trail.on[i + 1]);
  const a = joined ? trail.on[i] * Math.min(i / 60, 1) : 0, k = i * ACROSS * 4, c = trail.col;
  c[k + 3] = a * 0.5; c[k + 7] = a; c[k + 11] = a; c[k + 15] = a * 0.5;
}
function clearTrail() {
  trail.on.fill(0);
  const c = trail.col;
  for (let i = 0; i < TRAIL; i++) for (let s = 0; s < ACROSS; s++) {
    const k = (i * ACROSS + s) * 4, outer = s === 0 || s === ACROSS - 1;
    c[k] = outer ? 1 : 0.43; c[k + 1] = outer ? 1 : 0.56; c[k + 2] = outer ? 1 : 0.82; c[k + 3] = 0;
  }
  trail.mesh.geometry.attributes.color.needsUpdate = true;
}
// depth 0..1: how hard the board is biting (0 = lifted off the snow)
function trailPush(p, side, up, depth, deep) {
  const stride = ACROSS * 3;
  trail.pos.copyWithin(0, stride);
  trail.on.copyWithin(0, 1);
  const k = (TRAIL - 1) * stride, half = (deep ? 0.36 : 0.16) * (1 + 0.5 * depth);
  for (let s = 0; s < ACROSS; s++) {
    // outer edges sit on the surface, the inner pair a touch lower to catch the eye as a groove
    const outer = s === 0 || s === ACROSS - 1, w = (s < 2 ? -1 : 1) * half * (outer ? 1 : 0.55), lift = outer ? 0.08 : 0.045;
    trail.pos[k + s * 3] = p.x + side.x * w + up.x * lift;
    trail.pos[k + s * 3 + 1] = p.y + side.y * w + up.y * lift;
    trail.pos[k + s * 3 + 2] = p.z + side.z * w + up.z * lift;
  }
  trail.on[TRAIL - 1] = depth > 0 ? 0.45 + 0.35 * depth + (deep ? 0.15 : 0) : 0;
  trail.col.copyWithin(0, ACROSS * 4);
  // only the newest two slices and the fading tail change opacity
  for (let i = 0; i <= 60; i++) trailAlpha(i);
  trailAlpha(TRAIL - 2);
  trailAlpha(TRAIL - 1);
  trail.mesh.geometry.attributes.position.needsUpdate = true;
  trail.mesh.geometry.attributes.color.needsUpdate = true;
}

// ---------------------------------------------------------------- state ----
if (touch) { quality.trees = 0.55; quality.treeSides = 5; }
const blob = new THREE.Mesh(new THREE.CircleGeometry(0.75, 20), new THREE.MeshBasicMaterial({ color: 0x0a1630, map: spray.points.material.map, transparent: true, opacity: 0.4, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
blob.renderOrder = 1;
scene.add(blob);
const sound = new Sound();
const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked */ } },
};
let look = sanitizeLook(store.get('sidehit.look', null));
const rider = new Rider(look);
rider.load('models/snowboarder/').catch(() => flash('Rider model failed to load', 'bad'));
scene.add(rider.root);
let flashTimer = 0;
function flash(text, kind) {
  $('flash').textContent = text;
  $('flash').className = 'show ' + kind;
  flashTimer = 1.4;
}
const player = new Player({
  flash, puff, sound,
  banked(total, count) {
    flash('+' + total.toLocaleString(), 'good');
    sound.chime(count);
    if (player.score > app.best) { app.best = player.score; setBest(app.map.id, app.best); }
  },
});

const app = {
  mode: 'menu', camera, canvas, map: null, terrain: null, best: 0, custom: loadCustom(), fromEditor: false,
  saved() { saveCustom(app.custom); },
  rebuildGround() { setMap(app.map); editor.terrainChanged(); app.saved(); },
};
const editor = new Editor(app);

// Graphics: Auto scales the resolution to hold the frame rate; Low also drops shadows.
const MAX_RATIO = Math.min(devicePixelRatio, touch ? 2 : 1.5);
const gfx = { mode: 'auto', ratio: 1, time: 0, frames: 0, slow: 0, good: 0, drops: 0, fps: 0 };
function setRatio(r) {
  gfx.ratio = clamp(r, touch ? 0.9 : 0.6, MAX_RATIO);
  renderer.setPixelRatio(gfx.ratio);
  renderer.setSize(innerWidth, innerHeight, false);
  if (typeof composer !== 'undefined') { composer.setPixelRatio(gfx.ratio); composer.setSize(innerWidth, innerHeight); }
}
function setShadows(on) {
  sun.castShadow = on;
  renderer.shadowMap.needsUpdate = true;
}
// Bloom on bright snow and the sun, on the High setting only (it costs a lot on phones).
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.32, 0.55, 0.88);
composer.addPass(bloom);
composer.addPass(new OutputPass());
let useBloom = false;
function setGraphics(mode) {
  gfx.mode = ['auto', 'low', 'high'].includes(mode) ? mode : 'auto';
  store.set('sidehit.gfx', gfx.mode);
  gfx.slow = 0;
  // Auto on a phone starts without shadows at a moderate resolution, then adapts
  setShadows(gfx.mode !== 'low');
  setRatio(gfx.mode === 'low' ? (touch ? 1 : 0.75) : gfx.mode === 'auto' ? Math.min(touch ? 1.5 : 1.25, MAX_RATIO) : MAX_RATIO);
  gfx.drops = gfx.good = 0;
  useBloom = gfx.mode === 'high';
  sparkle.value = gfx.mode === 'low' ? 0 : (SKY[app.map && app.map.sky] || SKY.bluebird).glint;
  $('b-gfx').textContent = 'Graphics: ' + gfx.mode[0].toUpperCase() + gfx.mode.slice(1);
}
function autoQuality(dt) {
  gfx.time += dt;
  gfx.frames++;
  if (gfx.time < 1) return;
  const fps = gfx.frames / gfx.time;
  gfx.fps = Math.round(fps);
  gfx.time = gfx.frames = 0;
  if (gfx.mode !== 'auto' || document.hidden) return;
  if (fps < 30) {
    // far too slow: drop shadows, sparkle and resolution in one go
    if (sun.castShadow) setShadows(false);
    sparkle.value = 0;
    if (gfx.ratio > 1) setRatio(1); else setRatio(gfx.ratio - 0.15);
    gfx.good = 0; gfx.drops = 9;
  } else if (fps < 50) {
    gfx.good = 0; gfx.drops++;
    if (sun.castShadow) setShadows(false); else setRatio(gfx.ratio - 0.15);
  } else if (fps > 57 && gfx.ratio < MAX_RATIO && gfx.drops < 3) {
    // every resize costs a hitch, so only climb back after a long smooth spell
    if (++gfx.good >= 6) { gfx.good = 0; setRatio(gfx.ratio + 0.1); }
  }
}
// if the browser drops the graphics context (low memory), recover instead of leaving a blank page
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); $('lost').hidden = false; });
canvas.addEventListener('webglcontextrestored', () => { $('lost').hidden = true; renderer.shadowMap.needsUpdate = true; });
$('lost').addEventListener('click', () => location.reload());
$('b-gfx').addEventListener('click', () => setGraphics({ auto: 'low', low: 'high', high: 'auto' }[gfx.mode]));

// ---- rider select: a showroom with the rider on a turntable ----
const studio = new THREE.Group();
studio.position.set(0, -4000, 0);
studio.visible = false;
scene.add(studio);
{
  const backdrop = new THREE.Mesh(new THREE.SphereGeometry(70, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      varying vec3 vDir;
      void main(){
        vec3 d = normalize(vDir);
        // night-blue hall with a warm glow behind the rider and light beams fanning up from the floor
        vec3 col = mix(vec3(0.02, 0.03, 0.09), vec3(0.05, 0.1, 0.3), smoothstep(-0.2, 0.9, d.y));
        float behind = pow(max(dot(d, normalize(vec3(0.0, 0.1, -1.0))), 0.0), 26.0);
        col += vec3(1.0, 0.25, 0.5) * behind * 0.32;
        float beams = pow(abs(sin(atan(d.x, -d.z) * 9.0)), 14.0) * smoothstep(0.0, 0.5, d.y) * smoothstep(0.95, 0.3, d.y);
        col += vec3(0.2, 0.7, 1.0) * beams * 0.22 * step(d.z, 0.2);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }));
  const floor = new THREE.Mesh(new THREE.CircleGeometry(40, 48), new THREE.MeshStandardMaterial({ color: 0x070b1c, roughness: 0.35, metalness: 0.4 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  const podium = new THREE.Mesh(new THREE.CylinderGeometry(1.45, 1.6, 0.3, 48), new THREE.MeshStandardMaterial({ color: 0xeef3fa, roughness: 0.8 }));
  podium.position.y = 0.15;
  podium.receiveShadow = true;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.62, 0.035, 8, 64), new THREE.MeshBasicMaterial({ color: 0xffe14a }));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.06;
  const outer = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.02, 8, 64), new THREE.MeshBasicMaterial({ color: 0xff3d7f }));
  outer.rotation.x = Math.PI / 2;
  outer.position.y = 0.02;
  const pink = new THREE.PointLight(0xff4f8f, 60, 14), cyan = new THREE.PointLight(0x35c8ff, 60, 14);
  pink.position.set(-3, 2.4, -2.2);
  cyan.position.set(3, 2, -2.6);
  studio.add(backdrop, floor, podium, ring, outer, pink, cyan);
}
const turn = { angle: 0.6, drag: null, idle: 0 };
function showStudio(on) {
  studio.visible = on;
  app.terrain.group.visible = !on;
  sky.visible = trail.mesh.visible = spray.points.visible = !on;
  for (const r of ranges) r.visible = !on;
  scene.fog.far = on ? 4000 : FOG_FAR;
  scene.fog.near = on ? 2000 : 140;
  if (on) {
    // even showroom light, whatever the park's time of day
    sunDir.set(-0.45, 0.75, 0.55).normalize();
    sun.color.set(0xffffff); sun.intensity = 2.6;
    hemi.color.set(0x9fb6ff); hemi.groundColor.set(0x30364f); hemi.intensity = 0.9;
    renderer.toneMappingExposure = 1.15;
    turn.angle = 0.6;
    rider.leanG.rotation.set(0, 0, 0);
    rider.pivot.rotation.x = 0;
    rider.body.rotation.x = 0;
    rider.body.position.y = -0.8;
  } else applySky(app.map.sky);
}
canvas.addEventListener('pointerdown', (e) => { if (app.mode === 'custom') { turn.drag = e.clientX; canvas.setPointerCapture(e.pointerId); } });
canvas.addEventListener('pointermove', (e) => { if (app.mode === 'custom' && turn.drag !== null) { turn.angle += (e.clientX - turn.drag) * 0.012; turn.drag = e.clientX; turn.idle = 0; } });
for (const ev of ['pointerup', 'pointercancel']) canvas.addEventListener(ev, () => { turn.drag = null; });
function studioFrame(dt) {
  turn.idle += dt;
  if (turn.drag === null && turn.idle > 1.2) turn.angle += dt * 0.45;
  const o = studio.position, portrait = innerHeight > innerWidth;
  rider.root.position.set(o.x, o.y + 0.31, o.z);
  rider.root.rotation.set(0, turn.angle, 0);
  rider.pose({ crouch: 0.18, time: performance.now() / 1000 }, dt);
  // the option bar covers the bottom of the screen, so aim low enough to keep the whole rider above it
  camera.position.set(o.x, o.y + 1.35, o.z + (portrait ? 6.3 : 4.9));
  camera.lookAt(o.x, o.y + (portrait ? 0.15 : 0.5), o.z);
  setFov(portrait ? 44 : 38);
  cam.snap = true;
}

const LOOK_LABELS = { jacket: 'Suit', jacket2: 'Trim', board: 'Deck', board2: 'Art colour', boardArt: 'Design' };
const LOOK_TABS = { Suit: ['jacket', 'jacket2'], Board: ['board', 'board2', 'boardArt'] };
const STYLES = [
  ['Factory', { boardArt: 'ridgeline' }],
  ['Glacier', { jacket: '#12a5a0', jacket2: '#ffe14a', board: '#12a5a0', board2: '#f2f4f7', boardArt: 'slash' }],
  ['Sunset', { jacket: '#ff3d7f', jacket2: '#ffe14a', board: '#ffc928', board2: '#ff3d7f', boardArt: 'split' }],
  ['Night Shift', { jacket: '#2a2f3d', jacket2: '#22c7e8', board: '#1c1f28', board2: '#22c7e8', boardArt: 'wolf' }],
  ['Citrus', { jacket: '#ffc928', jacket2: '#8be04e', board: '#8be04e', board2: '#f2f4f7', boardArt: 'split' }],
  ['Whiteout', { jacket: '#d8dde6', jacket2: '#1c1f28', board: '#f2f4f7', board2: '#1c1f28', boardArt: 'bars' }],
  ['Grape Soda', { jacket: '#8a4fd8', jacket2: '#ff3d7f', board: '#2f6fe0', board2: '#ff3d7f', boardArt: 'solid' }],
].map(([name, l]) => [name, sanitizeLook(l)]);
const styleIndex = () => STYLES.findIndex(([, l]) => Object.keys(l).every((k) => l[k] === look[k]));
let lookTab = 'Suit';
function renderCustomizer() {
  const at = styleIndex();
  $('c-name').textContent = at < 0 ? 'Custom' : STYLES[at][0];
  const tabs = $('c-tabs'), box = $('looks');
  tabs.textContent = box.textContent = '';
  for (const name in LOOK_TABS) {
    const b = document.createElement('button');
    b.textContent = name;
    b.classList.toggle('on', name === lookTab);
    b.addEventListener('click', () => { lookTab = name; renderCustomizer(); });
    tabs.append(b);
  }
  for (const key of LOOK_TABS[lookTab]) {
    const row = document.createElement('div'), label = document.createElement('span'), opts = document.createElement('div');
    row.className = 'lookrow';
    label.textContent = LOOK_LABELS[key];
    for (const value of LOOK_OPTIONS[key]) {
      const b = document.createElement('button');
      if (value[0] === '#') { b.className = 'swatch'; b.style.background = value; b.setAttribute('aria-label', LOOK_LABELS[key] + ' ' + value); }
      else b.textContent = value;
      if (look[key] === value) b.classList.add('on');
      b.addEventListener('click', () => { look = sanitizeLook({ ...look, [key]: value }); applyLook(); });
      opts.append(b);
    }
    row.append(label, opts);
    box.append(row);
  }
}
function applyLook() {
  rider.setLook(look);
  store.set('sidehit.look', look);
  renderCustomizer();
}
function stepStyle(d) {
  const at = styleIndex(), next = STYLES[((at < 0 ? (d > 0 ? -1 : 0) : at) + d + STYLES.length) % STYLES.length][1];
  look = sanitizeLook(next);
  applyLook();
}
$('c-prev').addEventListener('click', () => stepStyle(-1));
$('c-next').addEventListener('click', () => stepStyle(1));
$('b-rider').addEventListener('click', () => { renderCustomizer(); setMode('custom'); });
$('b-lookdone').addEventListener('click', () => setMode('menu'));
$('b-random').addEventListener('click', () => {
  look = sanitizeLook(Object.fromEntries(Object.entries(LOOK_OPTIONS).map(([k, v]) => [k, v[Math.floor(Math.random() * v.length)]])));
  applyLook();
});

// Arcade or Sim riding, remembered between visits
function setRideMode(name) {
  player.setMode(name);
  try { localStorage.setItem('sidehit.mode', player.mode); } catch { /* storage blocked */ }
  $('b-mode').textContent = 'Riding: ' + (player.mode === 'sim' ? 'Sim' : 'Arcade');
  $('modehelp').textContent = player.mode === 'sim'
    ? 'Sim: slower spins unless you wind up, landings must be lined up, and catching an edge out of a butter is a fall.'
    : 'Arcade: the board straightens itself before landing and butters always ride out.';
}
{ let saved = 'arcade'; try { saved = localStorage.getItem('sidehit.mode') || 'arcade'; } catch { /* storage blocked */ } setRideMode(MODES[saved] ? saved : 'arcade'); }
$('b-mode').addEventListener('click', () => setRideMode(player.mode === 'sim' ? 'arcade' : 'sim'));
scene.add(editor.marker);

function setMap(map) {
  if (app.terrain) app.terrain.dispose();
  app.map = map;
  app.terrain = new Terrain(map);
  scene.add(app.terrain.group);
  app.best = getBest(map.id);
  applySky(map.sky);
  spray.points.material.size = map.powder ? 0.42 : 0.32;
  player.setTerrain(app.terrain);
  resetView();
}
function resetView() {
  cam.snap = true;
  cam.dir.set(Math.sin(player.yaw), 0, Math.cos(player.yaw));
  clearTrail();
  hud.force = true;
}

function setMode(mode) {
  app.mode = mode;
  document.body.dataset.mode = mode;
  rider.root.visible = mode !== 'edit';
  if (studio.visible !== (mode === 'custom')) showStudio(mode === 'custom');
  const s = mode === 'edit' ? 190 : 70;
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 700 });
  sun.shadow.camera.updateProjectionMatrix();
  if (mode === 'edit') editor.enter(); else editor.exit();
  if (mode === 'menu') renderMenu();
  if (mode === 'play') { $('b-edit').hidden = !app.fromEditor; sound.start(); } else sound.silence();
  keys.clear();
}

function ride(map, fromEditor = false) {
  app.fromEditor = fromEditor;
  if (map !== app.map || fromEditor) setMap(map);
  else { player.score = 0; player.spawn = { x: map.spawn.x, z: map.spawn.z, yaw: 0 }; player.respawn(); resetView(); }
  setMode('play');
}
function edit(map) {
  if (isBuiltin(map)) {
    // built-in parks are read-only: remix a copy instead
    map = sanitizeMap({ ...JSON.parse(JSON.stringify(map)), id: newId(), name: map.name + ' remix' });
    app.custom.push(map);
    app.saved();
  }
  setMap(map);
  setMode('edit');
}

// ----------------------------------------------------------------- menu ----
function renderMenu() {
  const list = $('maps');
  list.textContent = '';
  const row = (map, custom) => {
    const el = document.createElement('div');
    el.className = 'map' + (map === app.map ? ' current' : '');
    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('b');
    name.textContent = map.name;
    const meta = document.createElement('span');
    const best = getBest(map.id);
    const kind = map.powder ? 'Powder' : map.curve > 0.3 && map.length > 1000 ? 'Course' : 'Park';
    meta.textContent = `${kind}${custom ? ' · custom' : ''} · ${map.powder ? 'no features' : map.objects.length + ' features'} · ${Math.round(map.length)} m` + (best ? ` · best ${best.toLocaleString()}` : '');
    info.append(name, meta);
    info.addEventListener('click', () => { if (map !== app.map) { setMap(map); renderMenu(); } });
    const btn = (label, fn, cls = '') => {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = cls;
      b.addEventListener('click', fn);
      return b;
    };
    el.append(info, btn('Ride', () => ride(map), 'primary'), btn(custom ? 'Edit' : 'Remix', () => edit(map)));
    if (custom) {
      el.append(btn('Share', () => openShare(map)), btn('✕', (e) => {
        // two taps to delete: the first arms the button for a few seconds
        const b = e.currentTarget;
        if (!b.dataset.armed) {
          b.dataset.armed = '1';
          b.textContent = 'Delete?';
          setTimeout(() => { delete b.dataset.armed; b.textContent = '✕'; }, 3000);
          return;
        }
        app.custom.splice(app.custom.indexOf(map), 1);
        app.saved();
        if (map === app.map) setMap(BUILTIN[0]);
        renderMenu();
      }, 'danger'));
    }
    list.append(el);
  };
  for (const m of BUILTIN) row(m, false);
  for (const m of app.custom) row(m, true);
}
$('b-new').addEventListener('click', () => {
  const map = blankMap();
  map.name = 'My park ' + (app.custom.length + 1);
  app.custom.push(map);
  app.saved();
  edit(map);
});

// share / import dialog
function openShare(map) {
  $('dlg-title').textContent = map ? 'Share "' + map.name + '"' : 'Import a park';
  $('dlg-help').textContent = map ? 'Copy this code and send it to a friend. They paste it under Import.' : 'Paste a park code here.';
  $('dlg-text').value = map ? JSON.stringify(map) : '';
  $('dlg-text').readOnly = !!map;
  $('dlg-ok').textContent = map ? 'Copy' : 'Import';
  $('dlg-err').textContent = '';
  $('dlg').dataset.kind = map ? 'share' : 'import';
  $('dlg').classList.add('open');
  if (map) $('dlg-text').select();
}
$('b-import').addEventListener('click', () => openShare(null));
$('b-share').addEventListener('click', () => openShare(app.map));
$('dlg-close').addEventListener('click', () => $('dlg').classList.remove('open'));
$('dlg-ok').addEventListener('click', async () => {
  const text = $('dlg-text');
  if ($('dlg').dataset.kind === 'share') {
    text.select();
    try { await navigator.clipboard.writeText(text.value); $('dlg-err').textContent = 'Copied.'; }
    catch { $('dlg-err').textContent = 'Select the text and copy it manually.'; }
    return;
  }
  try {
    const map = sanitizeMap(JSON.parse(text.value));
    map.id = newId();
    app.custom.push(map);
    app.saved();
    $('dlg').classList.remove('open');
    setMap(map);
    renderMenu();
  } catch {
    $('dlg-err').textContent = "That doesn't look like a park code.";
  }
});

$('b-menu').addEventListener('click', () => setMode('menu'));
$('b-emenu').addEventListener('click', () => setMode('menu'));
$('b-edit').addEventListener('click', () => { setMode('edit'); });
$('b-test').addEventListener('click', () => ride(app.map, true));
$('b-respawn').addEventListener('click', () => { player.respawn(); resetView(); });
$('b-setspawn').addEventListener('click', () => { if (player.grounded && player.bail <= 0) { player.setSpawnHere(); flash('Spawn set', 'meh'); } });
$('b-mute').addEventListener('click', () => { $('b-mute').textContent = sound.toggleMute() ? 'Sound off' : 'Sound on'; });

// ---------------------------------------------------------------- input ----
const keys = new Set();
const inp = { steer: 0, pitch: 0, jump: false, brake: false, tuck: false, grab: '', stick: { x: 0, y: 0 }, tJump: false, tGrab: false, tBrake: false, tTuck: false };
addEventListener('keydown', (e) => {
  if (e.repeat || e.target.matches('input, textarea, select')) return;
  keys.add(e.code);
  if (app.mode === 'play') {
    if (e.code === 'KeyR') $('b-respawn').click();
    if (e.code === 'KeyT') $('b-setspawn').click();
    if (e.code === 'KeyM') $('b-mute').click();
    if (e.code === 'Escape') (app.fromEditor ? $('b-edit') : $('b-menu')).click();
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  } else if (app.mode === 'edit' && editor.sel) {
    if (e.code === 'Delete' || e.code === 'Backspace') $('del').click();
    if (e.code === 'KeyQ') $('rotl').click();
    if (e.code === 'KeyE') $('rotr').click();
  }
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
// no sound while the tab or app is in the background
document.addEventListener('visibilitychange', () => {
  if (document.hidden) sound.suspend(); else if (app.mode === 'play') sound.start();
});
function readInput() {
  const k = (...c) => c.some((x) => keys.has(x));
  inp.steer = clamp((k('KeyD', 'ArrowRight') ? 1 : 0) - (k('KeyA', 'ArrowLeft') ? 1 : 0) + inp.stick.x, -1, 1);
  inp.pitch = clamp((k('KeyW', 'ArrowUp') ? 1 : 0) - (k('KeyS', 'ArrowDown') ? 1 : 0) + inp.stick.y, -1, 1);
  inp.jump = k('Space') || inp.tJump;
  inp.brake = k('KeyX', 'ShiftLeft', 'ShiftRight') || inp.tBrake;
  inp.tuck = k('KeyC', 'ControlLeft', 'ControlRight') || inp.tTuck;
  inp.grab = k('KeyQ') ? 'mute' : k('KeyE') || inp.tGrab ? 'indy' : '';
}
{
  // virtual stick on the left half, buttons on the right
  const zone = $('stickzone'), pad = $('pad'), nub = $('nub');
  let id = null, ox = 0, oy = 0;
  const move = (t) => {
    const dx = clamp((t.clientX - ox) / 50, -1, 1), dy = clamp((t.clientY - oy) / 50, -1, 1);
    inp.stick.x = dx;
    inp.stick.y = -dy;
    nub.style.transform = `translate(${dx * 34}px, ${dy * 34}px)`;
  };
  zone.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0];
    id = t.identifier; ox = t.clientX; oy = t.clientY;
    pad.style.left = ox + 'px'; pad.style.top = oy + 'px'; pad.classList.add('on');
    move(t);
    e.preventDefault();
  }, { passive: false });
  const end = (e) => {
    for (const t of e.changedTouches) if (t.identifier === id) { id = null; inp.stick.x = inp.stick.y = 0; pad.classList.remove('on'); nub.style.transform = ''; }
  };
  zone.addEventListener('touchmove', (e) => { for (const t of e.changedTouches) if (t.identifier === id) move(t); e.preventDefault(); }, { passive: false });
  zone.addEventListener('touchend', end);
  zone.addEventListener('touchcancel', end);
  const hold = (el, prop) => {
    el.addEventListener('touchstart', (e) => { inp[prop] = true; el.classList.add('on'); e.preventDefault(); }, { passive: false });
    for (const ev of ['touchend', 'touchcancel']) el.addEventListener(ev, () => { inp[prop] = false; el.classList.remove('on'); });
  };
  hold($('bjump'), 'tJump');
  hold($('bgrab'), 'tGrab');
  hold($('bbrake'), 'tBrake');
  hold($('btuck'), 'tTuck');
}

// --------------------------------------------------------------- camera ----
const cam = { dir: new THREE.Vector3(0, 0, 1), pos: new THREE.Vector3(), look: new THREE.Vector3(), snap: true, orbit: 0 };
const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), n = new THREE.Vector3();
function chaseCamera(dt) {
  const p = player, T = app.terrain, hs = Math.hypot(p.vel.x, p.vel.z);
  if (hs > 2) tmp.set(p.vel.x / hs, 0, p.vel.z / hs); else tmp.set(Math.sin(p.yaw), 0, Math.cos(p.yaw));
  cam.dir.lerp(tmp, 1 - Math.exp(-2.6 * dt));
  if (cam.dir.lengthSq() < 1e-4) cam.dir.copy(tmp);
  cam.dir.normalize();
  tmp.copy(p.pos).addScaledVector(cam.dir, -(6.6 + hs * 0.07));
  tmp.y = Math.max(p.pos.y + 2.3, T.height(tmp.x, tmp.z) + 1.9);
  tmp2.copy(p.pos).addScaledVector(cam.dir, 5);
  tmp2.y += 0.7;
  if (cam.snap) { cam.pos.copy(tmp); cam.look.copy(tmp2); cam.snap = false; }
  cam.pos.lerp(tmp, 1 - Math.exp(-5.5 * dt));
  cam.look.lerp(tmp2, 1 - Math.exp(-7.5 * dt));
  cam.pos.y = Math.max(cam.pos.y, T.height(cam.pos.x, cam.pos.z) + 1.0);
  camera.position.copy(cam.pos);
  camera.lookAt(cam.look);
  setFov(damp(camera.fov, 62 + Math.min(hs, 34) * 0.62, 4, dt));
}
function menuCamera(dt) {
  // slow fly-around of the selected park
  cam.orbit += dt * 0.07;
  const m = app.map, z = m.length * 0.35, r = 150;
  const cx = centerX(m, z);
  tmp.set(cx + Math.sin(cam.orbit) * r, 0, z - Math.cos(cam.orbit) * r * 0.9);
  tmp.y = Math.max(app.terrain.base(cx, z) + 75, app.terrain.base(tmp.x, tmp.z) + 25);
  camera.position.copy(tmp);
  camera.lookAt(cx, app.terrain.base(cx, z), z);
  setFov(55);
  cam.snap = true;
}
function setFov(f) {
  if (Math.abs(f - camera.fov) < 0.02) return;
  camera.fov = f;
  camera.updateProjectionMatrix();
}

const vis = { railOff: 0, press: 0, sink: 0 };
// How bent the legs should be. In the air: extend for the pop, pull the board up, then reach for the landing.
function riderCrouch(p, onSnow, sp) {
  if (p.rail) return 0.4 + 0.5 * p.charge;
  if (onSnow) return Math.max(p.press ? 0.45 : p.tuck ? 0.65 : 0.22 + 0.1 * Math.min(sp / 20, 1) + Math.abs(p.lean) * 0.5, 0.2 + 0.85 * p.charge, p.absorb * 0.95);
  if (!p.air) return 0.5;
  if (p.air.time < 0.16) return 0.05;
  const gap = p.pos.y - app.terrain.height(p.pos.x, p.pos.z), flipping = Math.abs(p.flipVel) > 2;
  if (p.vel.y < 0 && gap < 1.6 && !flipping) return 0.28;
  return flipping ? 0.95 : 0.62;
}
const basis = new THREE.Matrix4(), bx = new THREE.Vector3(), bz = new THREE.Vector3(), f0 = new THREE.Vector3();
function updateRider(dt) {
  const p = player, onSnow = p.state === 'ground';
  if (onSnow) app.terrain.normal(p.pos.x, p.pos.z, n); else n.set(0, 1, 0);
  up.lerp(n, 1 - Math.exp(-(onSnow ? 14 : 3) * dt)).normalize();
  f0.set(Math.sin(p.yaw), 0, Math.cos(p.yaw));
  bz.copy(f0).addScaledVector(up, -f0.dot(up)).normalize();
  bx.crossVectors(up, bz);
  basis.makeBasis(bx, up, bz);
  rider.root.quaternion.setFromRotationMatrix(basis);
  // in powder the board rides low at walking pace and planes up with speed
  vis.sink = damp(vis.sink, p.powder && onSnow ? 0.3 * (1 - clamp(p.vel.length() / 14, 0, 1)) : 0, 5, dt);
  rider.root.position.copy(p.pos).addScaledVector(up, (p.rail ? 0.09 : 0.03) - vis.sink);
  vis.railOff = damp(vis.railOff, p.rail ? p.railOff : 0, 12, dt);
  rider.root.position.addScaledVector(bz, -vis.railOff);
  // a press lifts one end of the board off the snow
  vis.press = damp(vis.press, onSnow ? p.pressLocal : p.rail && Math.abs(inp.pitch) > 0.5 ? Math.sign(inp.pitch) : 0, 10, dt);
  rider.body.rotation.x = vis.press * 0.3;
  rider.body.position.y = -0.8 + Math.abs(Math.sin(vis.press * 0.3)) * 0.6;
  blob.visible = !sun.castShadow && app.mode !== 'custom';
  if (blob.visible) {
    const gy = app.terrain.height(p.pos.x, p.pos.z), gap = Math.max(p.pos.y - gy, 0);
    app.terrain.normal(p.pos.x, p.pos.z, tmp);
    blob.position.set(p.pos.x, gy + 0.06, p.pos.z);
    blob.quaternion.setFromUnitVectors(tmp2.set(0, 0, 1), tmp);
    blob.scale.setScalar(1 + gap * 0.12);
    blob.material.opacity = 0.42 * clamp(1 - gap / 7, 0, 1);
  }
  const sp = p.vel.length();
  p.lean = damp(p.lean || 0, onSnow && !p.press ? clamp(-p.yawRate * sp * 0.035, -0.6, 0.6) : 0, 6, dt);
  rider.leanG.rotation.z = p.lean;
  rider.leanG.rotation.y = damp(rider.leanG.rotation.y, onSnow && p.braking && sp > 1 ? 1.1 : 0, 9, dt);
  rider.pivot.rotation.x = p.flip + p.tumble;
  rider.pose({
    crouch: riderCrouch(p, onSnow, sp),
    tuck: onSnow && p.tuck, edge: onSnow ? clamp(p.lean / 0.45, -1, 1) : 0, shift: vis.press * 0.85,
    // wind the shoulders against the turn while loading a jump, then lead the spin with them in the air
    twist: onSnow ? inp.steer * p.charge * 0.9 : p.air ? clamp(p.spinVel / 7, -1, 1) * 0.8 : 0,
    spin: p.air ? clamp(Math.max(Math.abs(p.spinVel) / 7, Math.abs(p.flipVel) / 6) - 0.15, 0, 1) : 0,
    look: onSnow ? clamp(p.yawRate / 1.6, -1, 1) : 0,
    grab: p.air && p.air.time > 0.12 ? inp.grab : '',
    airborne: !!p.rail || (p.state === 'air' && p.air.time > 0.15), bail: p.bail > 0, time: p.time,
  }, dt);

  const deep = p.powder ? 0.25 + Math.min(sp / 30, 0.4) : 0;
  if (onSnow && (p.carve > 0.15 || deep) && sp > 4) {
    // thrown off the edge the rider is standing on, low and back along the track
    const count = Math.min(Math.round((p.carve * 5 + deep * 3) * dt * 60), 6), side = Math.sign(p.yawRate) || 1, kick = 1.2 + p.carve * 2.2;
    tmp.copy(p.pos).addScaledVector(up, -vis.sink).addScaledVector(bx, side * 0.14);
    for (let i = 0; i < count; i++) puff(tmp, p.vel.x * 0.55 + p.s3.x * side * kick, 0.4 + p.carve * 1.3 + deep, p.vel.z * 0.55 + p.s3.z * side * kick, 0.8 + p.carve * 1.2);
  }
  if (trail.last.distanceToSquared(p.pos) > 0.16) {
    trail.last.copy(p.pos);
    trailPush(tmp.copy(p.pos).addScaledVector(up, -vis.sink), bx, up, onSnow ? 0.25 + 0.75 * p.carve : 0, p.powder);
  }
}

function updateSpray(dt) {
  for (let i = 0; i < SPRAY; i++) {
    if (spray.life[i] <= 0) continue;
    spray.life[i] -= dt;
    const k = i * 3;
    if (spray.life[i] <= 0) { spray.pos[k + 1] = -1e5; continue; }
    spray.vel[k + 1] -= 6 * dt;
    spray.pos[k] += spray.vel[k] * dt;
    spray.pos[k + 1] += spray.vel[k + 1] * dt;
    spray.pos[k + 2] += spray.vel[k + 2] * dt;
  }
  spray.points.geometry.attributes.position.needsUpdate = true;
}

// ------------------------------------------------------------------ hud ----
const hud = { force: true, score: -1, best: -1, speed: -1, combo: '', charge: 0, clock: -1, fps: -1 };
const clockText = (t) => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
function updateHud(dt) {
  const set = (key, value, el, fmt) => {
    if (hud[key] === value && !hud.force) return;
    hud[key] = value;
    $(el).textContent = fmt ? fmt(value) : value;
  };
  set('score', player.score, 'score', (v) => v.toLocaleString());
  set('best', app.best, 'best', (v) => v.toLocaleString());
  set('speed', Math.round(player.vel.length() * 3.6), 'speed');
  const items = player.combo.concat(player.air && player.air.time > 0.25 ? airTricks(player.air) : []);
  let text = '';
  if (items.length) {
    const pts = Math.round(items.reduce((s, i) => s + i.pts, 0));
    text = items.map((i) => i.name).join(' + ') + '\n' + pts.toLocaleString() + (items.length > 1 ? ' × ' + items.length : '');
  }
  if (text !== hud.combo || hud.force) {
    hud.combo = text;
    const [names, pts] = text.split('\n');
    $('tricks').textContent = names || '';
    $('points').textContent = pts || '';
  }
  const charge = Math.round(player.charge * 50) / 50;
  if (charge !== hud.charge) { hud.charge = charge; $('charge').hidden = charge <= 0; $('chargefill').style.transform = `scaleX(${charge})`; }
  set('clock', Math.floor(player.time), 'clock', clockText);
  set('fps', gfx.fps || 0, 'fps', (v) => (v ? v + ' fps' : ''));
  hud.force = false;
  if (flashTimer > 0 && (flashTimer -= dt) <= 0) $('flash').className = '';
}

// ----------------------------------------------------------------- loop ----
function resize() {
  renderer.setPixelRatio(gfx.ratio);
  renderer.setSize(innerWidth, innerHeight, false);
  composer.setPixelRatio(gfx.ratio);
  composer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
if (touch) document.body.classList.add('touch');

let last = performance.now(), acc = 0, frameNo = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  let focus = player.pos;
  if (app.mode === 'play') {
    readInput();
    acc += dt;
    while (acc >= DT) { player.step(DT, inp); acc -= DT; }
    const m = app.map, p = player.pos;
    // bottom of the hill (or lost in the woods): take the lift back up
    const done = p.z > m.length + 8 && player.state === 'ground';
    if (done || p.z > m.length + 110 || Math.abs(p.x - centerX(m, p.z)) > m.width / 2 + 110 || p.z < -70) {
      player.bank();
      if (done) { const t = clockText(player.time), sc = player.score; setTimeout(() => flash(`Run ${t} · ${sc.toLocaleString()}`, 'good'), 50); }
      player.respawn();
      resetView();
    }
    updateRider(dt);
    sound.update(player.vel.length(), player.carve, player.state === 'ground', !!player.rail);
    chaseCamera(dt);
    updateHud(dt);
  } else if (app.mode === 'edit') {
    editor.update();
    focus = editor.target;
  } else if (app.mode === 'custom') {
    studioFrame(dt);
    focus = studio.position;
  } else {
    updateRider(dt);
    menuCamera(dt);
    const fz = app.map.length * 0.35, fx = centerX(app.map, fz);
    focus = tmp2.set(fx, app.terrain.base(fx, fz), fz);
  }
  updateSpray(dt);
  sky.position.copy(camera.position);
  for (const r of ranges) r.position.copy(camera.position);
  sun.target.position.copy(focus);
  sun.position.copy(focus).addScaledVector(sunDir, 300);
  if (app.debugCamera) app.debugCamera(camera);
  app.terrain.cull(camera.position, FOG_FAR + 40);
  if (sun.castShadow && (frameNo++ & 1) === 0) renderer.shadowMap.needsUpdate = true;
  autoQuality(dt);
  // the menu has a painted background over the view, so there is nothing to draw behind it
  if (app.mode === 'menu') return;
  if (useBloom) composer.render(); else renderer.render(scene, camera);
}

setGraphics(store.get('sidehit.gfx', 'auto'));
setMap(BUILTIN[0]);
setMode('menu');
requestAnimationFrame(frame);
window.sidehit = { app, player, inp, editor, ride, edit, setMode, rider, renderer, gfx };
