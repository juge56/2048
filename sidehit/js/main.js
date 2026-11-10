// Sidehit — app shell: rendering, modes (menu / ride / edit), camera, HUD, input.
import * as THREE from '../vendor/three.module.min.js';
import { Terrain } from './terrain.js';
import { Player, airTricks } from './player.js';
import { Rider } from './rider.js';
import { Sound } from './audio.js';
import { Editor } from './editor.js';
import { BUILTIN, loadCustom, saveCustom, sanitizeMap, blankMap, newId, getBest, setBest, isBuiltin } from './maps.js';

const DT = 1 / 120, TAU = Math.PI * 2;
const touch = matchMedia('(pointer: coarse)').matches;
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));

// ---------------------------------------------------------------- scene ----
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !touch, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, touch ? 1.5 : 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xffffff, 140, 720);
const camera = new THREE.PerspectiveCamera(64, 1, 0.3, 6000);
const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
const sun = new THREE.DirectionalLight(0xffffff, 3);
const sunDir = new THREE.Vector3();
sun.castShadow = true;
sun.shadow.mapSize.set(touch ? 1024 : 2048, touch ? 1024 : 2048);
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.06;
scene.add(hemi, sun, sun.target);

const skyU = { zenith: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, sunCol: { value: new THREE.Color() }, sunDir: { value: sunDir } };
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(4500, 24, 12),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false, uniforms: skyU,
    vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec3 zenith, horizon, sunCol, sunDir; varying vec3 vDir;
      void main(){
        vec3 d = normalize(vDir);
        vec3 col = mix(horizon, zenith, pow(smoothstep(-0.02, 0.5, d.y), 0.55));
        float s = max(dot(d, sunDir), 0.0);
        col += sunCol * (pow(s, 900.0) * 6.0 + pow(s, 14.0) * 0.3);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
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
function tintRange(mesh, top, bottom) {
  const c = mesh.geometry.attributes.color;
  for (let i = 0; i < c.count; i++) { const k = i % 2 ? bottom : top; c.setXYZ(i, k.r, k.g, k.b); }
  c.needsUpdate = true;
}

const SKY = {
  bluebird: { zenith: 0x1f66cc, haze: 0xc4dcf2, sun: 0xffe9cf, power: 3.1, hemiSky: 0xa9cdfc, hemiGround: 0xf4f8ff, hemi: 1.5, dir: [-0.55, 0.42, 0.62], exposure: 1.4 },
  golden: { zenith: 0x4a6cb5, haze: 0xf3c9a8, sun: 0xffa868, power: 3.6, hemiSky: 0x9fb2e8, hemiGround: 0xffe2d0, hemi: 1.2, dir: [-0.78, 0.2, 0.55], exposure: 1.3 },
  dusk: { zenith: 0x0c1a48, haze: 0x5a6aa6, sun: 0xb4c8ff, power: 1.7, hemiSky: 0x5068b8, hemiGround: 0x93a4d8, hemi: 1.15, dir: [0.45, 0.5, 0.45], exposure: 1.2 },
};
function applySky(name) {
  const s = SKY[name] || SKY.bluebird, haze = new THREE.Color(s.haze), white = new THREE.Color(0xffffff);
  skyU.zenith.value.set(s.zenith);
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
  const z = new THREE.Color(s.zenith);
  tintRange(ranges[0], haze.clone().lerp(white, 0.6), haze.clone().lerp(z, 0.25));
  tintRange(ranges[1], haze.clone().lerp(white, 0.3), haze.clone().lerp(z, 0.4));
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
  spray.pos.set([p.x, p.y + 0.1, p.z], i * 3);
  spray.vel.set([vx + (Math.random() - 0.5) * spread, vy + Math.random() * spread * 0.6, vz + (Math.random() - 0.5) * spread], i * 3);
  spray.life[i] = 0.5 + Math.random() * 0.5;
}

// track left in the snow
const TRAIL = 300;
const trail = { pos: new Float32Array(TRAIL * 6), col: new Float32Array(TRAIL * 8), on: new Uint8Array(TRAIL), last: new THREE.Vector3(1e9, 0, 0) };
{
  const geo = new THREE.BufferGeometry(), idx = [];
  for (let i = 0; i < TRAIL - 1; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 2, i * 2 + 1, i * 2 + 3);
  geo.setAttribute('position', new THREE.BufferAttribute(trail.pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(trail.col, 4));
  geo.setIndex(idx);
  trail.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  trail.mesh.frustumCulled = false;
  scene.add(trail.mesh);
}
function trailPush(p, side, up, on) {
  trail.pos.copyWithin(0, 6);
  trail.on.copyWithin(0, 1);
  const k = (TRAIL - 1) * 6;
  for (let s = 0; s < 2; s++) {
    const w = s ? 0.15 : -0.15;
    trail.pos[k + s * 3] = p.x + side.x * w + up.x * 0.07;
    trail.pos[k + s * 3 + 1] = p.y + side.y * w + up.y * 0.07;
    trail.pos[k + s * 3 + 2] = p.z + side.z * w + up.z * 0.07;
  }
  trail.on[TRAIL - 1] = on ? 1 : 0;
  for (let i = 0; i < TRAIL; i++) {
    // a segment is drawn only if both of its ends touched the snow
    const a = trail.on[i] && (i === 0 || trail.on[i - 1]) && (i === TRAIL - 1 || trail.on[i + 1]) ? 0.4 * Math.min(i / 40, 1) : 0;
    for (let s = 0; s < 2; s++) trail.col.set([0.55, 0.66, 0.86, a], i * 8 + s * 4);
  }
  trail.mesh.geometry.attributes.position.needsUpdate = true;
  trail.mesh.geometry.attributes.color.needsUpdate = true;
}

// ---------------------------------------------------------------- state ----
const sound = new Sound();
const rider = new Rider();
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
scene.add(editor.marker);

function setMap(map) {
  if (app.terrain) app.terrain.dispose();
  app.map = map;
  app.terrain = new Terrain(map);
  scene.add(app.terrain.group);
  app.best = getBest(map.id);
  applySky(map.sky);
  player.setTerrain(app.terrain);
  resetView();
}
function resetView() {
  cam.snap = true;
  cam.dir.set(Math.sin(player.yaw), 0, Math.cos(player.yaw));
  trail.on.fill(0);
  hud.force = true;
}

function setMode(mode) {
  app.mode = mode;
  document.body.dataset.mode = mode;
  rider.root.visible = mode !== 'edit';
  const s = mode === 'edit' ? 190 : 70;
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 700 });
  sun.shadow.camera.updateProjectionMatrix();
  if (mode === 'edit') editor.enter(); else editor.exit();
  if (mode === 'menu') renderMenu();
  if (mode === 'play') { $('b-edit').hidden = !app.fromEditor; sound.start(); }
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
    meta.textContent = `${custom ? 'Custom' : 'Built-in'} · ${map.objects.length} features · ${Math.round(map.length)} m` + (best ? ` · best ${best.toLocaleString()}` : '');
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
      el.append(btn('Share', () => openShare(map)), btn('✕', () => {
        if (!confirm(`Delete "${map.name}"? This can't be undone.`)) return;
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
const inp = { steer: 0, pitch: 0, jump: false, grab: '', stick: { x: 0, y: 0 }, tJump: false, tGrab: false };
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
function readInput() {
  const k = (...c) => c.some((x) => keys.has(x));
  inp.steer = clamp((k('KeyD', 'ArrowRight') ? 1 : 0) - (k('KeyA', 'ArrowLeft') ? 1 : 0) + inp.stick.x, -1, 1);
  inp.pitch = clamp((k('KeyW', 'ArrowUp') ? 1 : 0) - (k('KeyS', 'ArrowDown') ? 1 : 0) + inp.stick.y, -1, 1);
  inp.jump = k('Space') || inp.tJump;
  inp.grab = k('KeyQ') ? 'mute' : k('KeyE', 'ShiftLeft', 'ShiftRight') || inp.tGrab ? 'indy' : '';
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
}

// --------------------------------------------------------------- camera ----
const cam = { dir: new THREE.Vector3(0, 0, 1), pos: new THREE.Vector3(), look: new THREE.Vector3(), snap: true, orbit: 0 };
const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), n = new THREE.Vector3();
function chaseCamera(dt) {
  const p = player, T = app.terrain, hs = Math.hypot(p.vel.x, p.vel.z);
  if (hs > 2) tmp.set(p.vel.x / hs, 0, p.vel.z / hs); else tmp.set(Math.sin(p.yaw), 0, Math.cos(p.yaw));
  cam.dir.lerp(tmp, 1 - Math.exp(-3.2 * dt));
  if (cam.dir.lengthSq() < 1e-4) cam.dir.copy(tmp);
  cam.dir.normalize();
  tmp.copy(p.pos).addScaledVector(cam.dir, -(6.6 + hs * 0.07));
  tmp.y = Math.max(p.pos.y + 2.3, T.height(tmp.x, tmp.z) + 1.9);
  tmp2.copy(p.pos).addScaledVector(cam.dir, 5);
  tmp2.y += 0.7;
  if (cam.snap) { cam.pos.copy(tmp); cam.look.copy(tmp2); cam.snap = false; }
  cam.pos.lerp(tmp, 1 - Math.exp(-7 * dt));
  cam.look.lerp(tmp2, 1 - Math.exp(-10 * dt));
  cam.pos.y = Math.max(cam.pos.y, T.height(cam.pos.x, cam.pos.z) + 1.0);
  camera.position.copy(cam.pos);
  camera.lookAt(cam.look);
  setFov(damp(camera.fov, 62 + Math.min(hs, 34) * 0.62, 4, dt));
}
function menuCamera(dt) {
  // slow fly-around of the selected park
  cam.orbit += dt * 0.07;
  const m = app.map, z = m.length * 0.35, r = 150;
  tmp.set(Math.sin(cam.orbit) * r, 0, z - Math.cos(cam.orbit) * r * 0.9);
  tmp.y = Math.max(app.terrain.base(0, z) + 75, app.terrain.base(tmp.x, tmp.z) + 25);
  camera.position.copy(tmp);
  camera.lookAt(0, app.terrain.base(0, z), z);
  setFov(55);
  cam.snap = true;
}
function setFov(f) {
  if (Math.abs(f - camera.fov) < 0.02) return;
  camera.fov = f;
  camera.updateProjectionMatrix();
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
  rider.root.position.copy(p.pos).addScaledVector(up, p.rail ? 0.09 : 0.03);
  const sp = p.vel.length();
  p.lean = damp(p.lean || 0, onSnow ? clamp(-p.yawRate * sp * 0.035, -0.6, 0.6) : 0, 8, dt);
  rider.leanG.rotation.z = p.lean;
  rider.leanG.rotation.y = damp(rider.leanG.rotation.y, onSnow && p.braking && sp > 1 ? 1.1 : 0, 9, dt);
  rider.pivot.rotation.x = p.flip + p.tumble;
  rider.pose({
    crouch: p.rail ? 0.35 + 0.4 * p.charge : onSnow ? Math.max(p.tuck ? 0.75 : 0.22 + Math.abs(p.lean) * 0.5, 0.25 + 0.75 * p.charge) : 0.55,
    grab: p.air && p.air.time > 0.12 ? inp.grab : '',
    airborne: !!p.rail || (p.state === 'air' && p.air.time > 0.15), bail: p.bail > 0, time: p.time,
  }, dt);

  if (onSnow && p.carve > 0.12 && sp > 3) {
    const count = Math.min(Math.round(p.carve * 5 * dt * 60), 6), side = Math.sign(p.yawRate) || 1;
    for (let i = 0; i < count; i++) puff(p.pos, p.vel.x * 0.35 + p.s3.x * side * 2.5, 0.8 + p.carve * 1.6, p.vel.z * 0.35 + p.s3.z * side * 2.5, 1.6 + p.carve * 2);
  }
  if (trail.last.distanceToSquared(p.pos) > 0.16) {
    trail.last.copy(p.pos);
    trailPush(p.pos, bx, up, onSnow);
  }
  sound.update(sp, p.carve, onSnow, !!p.rail);
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
const hud = { force: true, score: -1, best: -1, speed: -1, combo: '' };
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
  hud.force = false;
  if (flashTimer > 0 && (flashTimer -= dt) <= 0) $('flash').className = '';
}

// ----------------------------------------------------------------- loop ----
function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
if (touch) document.body.classList.add('touch');

let last = performance.now(), acc = 0;
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
    if ((p.z > m.length + 25 && player.state === 'ground') || p.z > m.length + 110 || Math.abs(p.x) > m.width / 2 + 110 || p.z < -70) {
      player.bank();
      player.respawn();
      resetView();
    }
    updateRider(dt);
    chaseCamera(dt);
    updateHud(dt);
  } else if (app.mode === 'edit') {
    editor.update();
    focus = editor.target;
  } else {
    updateRider(dt);
    menuCamera(dt);
    focus = tmp2.set(0, app.terrain.base(0, app.map.length * 0.35), app.map.length * 0.35);
  }
  updateSpray(dt);
  sky.position.copy(camera.position);
  for (const r of ranges) r.position.copy(camera.position);
  sun.target.position.copy(focus);
  sun.position.copy(focus).addScaledVector(sunDir, 300);
  renderer.render(scene, camera);
}

setMap(BUILTIN[0]);
setMode('menu');
requestAnimationFrame(frame);
window.sidehit = { app, player, inp, editor, ride, edit, setMode };
