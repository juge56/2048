// Coldsmoke — a freeride snowboarding game. Physics, tricks, camera and HUD.
import * as THREE from './vendor/three.module.min.js';
import { World, height, normal, centerX, cellFeatures, CELL } from './world.js';
import { Rider } from './rider.js';
import { Sound } from './audio.js';

const G = 9.81, DT = 1 / 120, TAU = Math.PI * 2;
const touch = matchMedia('(pointer: coarse)').matches;
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = (a) => a - TAU * Math.round(a / TAU);
const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));

// ---------------------------------------------------------------- scene ----
const renderer = new THREE.WebGLRenderer({ canvas: $('view'), antialias: !touch, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, touch ? 1.5 : 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.4;

const HAZE = new THREE.Color(0xc4dcf2);
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(HAZE, 160, 640);
const camera = new THREE.PerspectiveCamera(64, 1, 0.3, 6000);

const sunDir = new THREE.Vector3(-0.55, 0.42, 0.62).normalize();
scene.add(new THREE.HemisphereLight(0xa9cdfc, 0xf4f8ff, 1.5));
const sun = new THREE.DirectionalLight(0xffe9cf, 3.1);
sun.castShadow = true;
sun.shadow.mapSize.set(touch ? 1024 : 2048, touch ? 1024 : 2048);
Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 420 });
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.06;
scene.add(sun, sun.target);

const sky = new THREE.Mesh(
  new THREE.SphereGeometry(4500, 24, 12),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      zenith: { value: new THREE.Color(0x1f66cc) }, horizon: { value: HAZE },
      sunCol: { value: new THREE.Color(0xfff1d6) }, sunDir: { value: sunDir },
    },
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
function makeRange(radius, base, amp, seed, top, bottom) {
  const N = 220, pos = [], col = [], idx = [];
  const ridge = (a) => {
    let h = 0;
    for (let o = 0; o < 5; o++) h += Math.abs(Math.sin(a * (3 + o * 4.7) + seed * (o + 1) * 1.7)) / (o + 1.4);
    return h;
  };
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * TAU, x = Math.cos(a) * radius, z = Math.sin(a) * radius;
    pos.push(x, base + amp * ridge(a), z, x, -1600, z);
    col.push(top.r, top.g, top.b, bottom.r, bottom.g, bottom.b);
    if (i < N) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 2, i * 2 + 1, i * 2 + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide, depthWrite: false }));
  m.frustumCulled = false;
  m.renderOrder = -1;
  scene.add(m);
  return m;
}
const ranges = [
  makeRange(4000, -250, 420, 1.3, new THREE.Color(0xf4f8fd), new THREE.Color(0x9fc0e6)),
  makeRange(3000, -520, 380, 4.1, new THREE.Color(0xdfeaf7), new THREE.Color(0x86acd9)),
];

const world = new World(scene);
const rider = new Rider();
scene.add(rider.root);
const sound = new Sound();

// snow spray
const SPRAY = 320;
const spray = { pos: new Float32Array(SPRAY * 3), vel: new Float32Array(SPRAY * 3), life: new Float32Array(SPRAY), next: 0 };
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
  spray.pos.fill(-1e5);
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
const TRAIL = 260;
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
function trailPush(p, side, n, on) {
  trail.pos.copyWithin(0, 6);
  trail.on.copyWithin(0, 1);
  const k = (TRAIL - 1) * 6;
  for (let s = 0; s < 2; s++) {
    const w = s ? 0.15 : -0.15;
    trail.pos[k + s * 3] = p.x + side.x * w + n.x * 0.05;
    trail.pos[k + s * 3 + 1] = p.y + side.y * w + n.y * 0.05;
    trail.pos[k + s * 3 + 2] = p.z + side.z * w + n.z * 0.05;
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

// ---------------------------------------------------------------- input ----
const keys = new Set();
const inp = { steer: 0, pitch: 0, jump: false, grab: '', stick: { x: 0, y: 0 }, tJump: false, tGrab: false };
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  keys.add(e.code);
  if (e.code === 'KeyR') reset();
  if (e.code === 'KeyM') $('mute').click();
  if (e.code === 'Enter' && !S.started) start();
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
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
  const pad = $('pad'), nub = $('nub');
  let id = null, ox = 0, oy = 0;
  const move = (t) => {
    const dx = clamp((t.clientX - ox) / 50, -1, 1), dy = clamp((t.clientY - oy) / 50, -1, 1);
    inp.stick.x = dx;
    inp.stick.y = -dy;
    nub.style.transform = `translate(${dx * 34}px, ${dy * 34}px)`;
  };
  $('stickzone').addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0];
    id = t.identifier; ox = t.clientX; oy = t.clientY;
    pad.style.left = ox + 'px'; pad.style.top = oy + 'px'; pad.classList.add('on');
    move(t);
    e.preventDefault();
  }, { passive: false });
  const end = (e) => {
    for (const t of e.changedTouches) if (t.identifier === id) {
      id = null; inp.stick.x = inp.stick.y = 0; pad.classList.remove('on'); nub.style.transform = '';
    }
  };
  $('stickzone').addEventListener('touchmove', (e) => { for (const t of e.changedTouches) if (t.identifier === id) move(t); e.preventDefault(); }, { passive: false });
  $('stickzone').addEventListener('touchend', end);
  $('stickzone').addEventListener('touchcancel', end);
  const hold = (el, prop) => {
    el.addEventListener('touchstart', (e) => { inp[prop] = true; el.classList.add('on'); e.preventDefault(); }, { passive: false });
    for (const ev of ['touchend', 'touchcancel']) el.addEventListener(ev, () => { inp[prop] = false; el.classList.remove('on'); });
  };
  hold($('bjump'), 'tJump');
  hold($('bgrab'), 'tGrab');
}

// ---------------------------------------------------------------- state ----
const S = {
  started: false,
  pos: new THREE.Vector3(), vel: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0),
  yaw: 0, yawRate: 0, spinVel: 0, flip: 0, flipVel: 0, lean: 0,
  grounded: true, charge: 0, jumpHeld: false, carve: 0, braking: false, tuck: false,
  air: null, rail: null, railT: 0, railV: 0, railCd: 0, railItem: null,
  bail: 0, tumble: 0,
  score: 0, best: +(localStorage.getItem('coldsmoke.best') || 0),
  combo: { items: [], timer: 0 }, time: 0,
};
const n = new THREE.Vector3(), f0 = new THREE.Vector3(), f3 = new THREE.Vector3(0, 0, 1), s3 = new THREE.Vector3(1, 0, 0);
const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();

function reset() {
  const z = 4, x = centerX(z);
  S.pos.set(x, height(x, z), z);
  S.vel.set(0, 0, 0);
  Object.assign(S, { yaw: 0, yawRate: 0, spinVel: 0, flip: 0, flipVel: 0, grounded: true, charge: 0, air: null, rail: null, bail: 0, tumble: 0, score: 0, time: 0 });
  S.combo.items.length = 0;
  S.up.set(0, 1, 0);
  cam.dir.set(0, 0, 1);
  cam.snap = true;
  trail.on.fill(0);
  world.update(S.pos.x, S.pos.z, 1e9);
  hud.force = true;
}

// --------------------------------------------------------------- tricks ----
const SPIN_PTS = (halves) => 50 * halves * (halves + 1);
function airTricks(a) {
  const list = [];
  const halves = Math.round(Math.abs(a.spin) / Math.PI);
  if (halves >= 1) list.push({ name: (a.spin > 0 ? 'FS ' : 'BS ') + halves * 180, pts: SPIN_PTS(halves) });
  const flips = Math.round(Math.abs(a.flip) / TAU);
  if (flips >= 1) list.push({ name: (flips > 1 ? ['', '', 'Double ', 'Triple '][Math.min(flips, 3)] : '') + (a.flip > 0 ? 'Frontflip' : 'Backflip'), pts: 400 * flips * (flips + 1) });
  if (a.grab > 0.25) list.push({ name: a.grabName === 'mute' ? 'Mute' : 'Indy', pts: Math.round(150 + 350 * a.grab) });
  if (a.time > 1.1) list.push({ name: 'Big Air', pts: Math.round(a.time * 120) });
  return list;
}
const comboPoints = () => S.combo.items.reduce((s, i) => s + i.pts, 0);
function bank() {
  const c = S.combo;
  if (!c.items.length) return;
  const total = Math.round(comboPoints() * c.items.length);
  S.score += total;
  if (S.score > S.best) { S.best = S.score; localStorage.setItem('coldsmoke.best', S.best); }
  flash('+' + total.toLocaleString(), 'good');
  sound.chime(c.items.length);
  c.items.length = 0;
}
function beginAir() {
  S.grounded = false;
  S.rail = null;
  S.air = { time: 0, spin: 0, flip: 0, grab: 0, grabName: '' };
  S.spinVel = S.yawRate;
  S.flipVel = 0;
}
// Fold the air that just ended into the combo. `quality` scales the points.
function resolveAir(quality) {
  const a = S.air;
  S.air = null;
  if (!a) return;
  for (const t of airTricks(a)) S.combo.items.push({ name: t.name, pts: Math.round(t.pts * quality) });
  S.combo.timer = 1.5;
}
function bail(msg = 'Bail') {
  if (S.bail > 0) return;
  S.bail = 1.7;
  S.air = null;
  S.rail = null;
  S.combo.items.length = 0;
  S.charge = 0;
  flash(msg, 'bad');
  sound.crash();
  for (let i = 0; i < 30; i++) puff(S.pos, S.vel.x * 0.4, 2, S.vel.z * 0.4, 6);
}

// -------------------------------------------------------------- physics ----
function step(dt) {
  S.time += dt;
  S.railCd -= dt;
  const jumpReleased = S.jumpHeld && !inp.jump;
  S.jumpHeld = inp.jump;

  if (S.bail > 0) return stepBail(dt);
  if (S.rail) stepRail(dt, jumpReleased);
  else if (S.grounded) stepGround(dt, jumpReleased);
  else stepAir(dt);

  const tree = world.hitTree(S.pos.x, S.pos.y, S.pos.z);
  if (tree) {
    const fast = S.vel.length() > 5;
    tmp.set(S.pos.x - tree.x, 0, S.pos.z - tree.z).normalize();
    S.pos.addScaledVector(tmp, 0.25);
    S.vel.set(tmp.x * 2, S.vel.y * 0.2, tmp.z * 2);
    if (fast) bail('Tree!');
  }

  if (S.combo.items.length && S.grounded && !S.rail) {
    S.combo.timer -= dt;
    if (S.combo.timer <= 0) bank();
  }
}

function stepGround(dt, jumpReleased) {
  normal(S.pos.x, S.pos.z, n);
  const sp = S.vel.length();
  S.yawRate = damp(S.yawRate, (-inp.steer * 2.3 * Math.min(0.4 + sp / 8, 1)) / (1 + sp / 40), 10, dt);
  S.yaw += S.yawRate * dt;
  S.flip = damp(S.flip, 0, 14, dt);
  f0.set(Math.sin(S.yaw), 0, Math.cos(S.yaw));
  f3.copy(f0).addScaledVector(n, -f0.dot(n)).normalize();
  s3.crossVectors(n, f3);

  // gravity along the slope
  S.vel.x += G * n.y * n.x * dt;
  S.vel.y += (G * n.y * n.y - G) * dt;
  S.vel.z += G * n.y * n.z * dt;
  let vf = S.vel.dot(f3), vs = S.vel.dot(s3);
  S.braking = inp.pitch < -0.3;
  S.tuck = inp.pitch > 0.3;
  S.carve = clamp(Math.abs(vs) * 0.25 + Math.abs(S.yawRate * vf) * 0.03 + (S.braking ? Math.abs(vf) * 0.08 : 0), 0, 1);
  // the edge holds: sideways slip bleeds off fast, forward glide barely at all
  vs *= Math.exp(-(S.braking ? 3 : 9) * dt);
  const dec = ((S.tuck ? 0.0024 : 0.0042) * vf * vf + 0.035 * G * n.y + Math.abs(S.yawRate * vf) * 0.06 + (S.braking ? 7 : 0)) * dt;
  vf = Math.abs(vf) <= dec ? 0 : vf - Math.sign(vf) * dec;
  if (S.tuck && Math.abs(vf) < 4) vf += (vf < -0.5 ? -1 : 1) * 3.5 * dt;
  S.vel.copy(f3).multiplyScalar(vf).addScaledVector(s3, vs);

  // ollie: hold to load the board, release to pop
  if (inp.jump) S.charge = Math.min(S.charge + dt / 0.5, 1);
  if (jumpReleased) {
    S.vel.addScaledVector(n, 4.2 + 2.6 * S.charge);
    S.charge = 0;
    sound.pop();
    beginAir();
    return;
  }
  if (!inp.jump) S.charge = 0;

  // follow the surface, or leave it where it drops away faster than gravity
  const speed = S.vel.length();
  const nx = S.pos.x + S.vel.x * dt, nz = S.pos.z + S.vel.z * dt;
  const h = height(nx, nz), fall = 0.5 * G * dt * dt;
  const ballistic = S.pos.y + S.vel.y * dt - fall;
  if (h >= ballistic - fall) {
    const dy = h - S.pos.y;
    if (dy > 0.9) {
      // ran into the back of a kicker
      if (speed > 6) bail();
      S.vel.set(0, 0, 0);
      return;
    }
    tmp.set(nx - S.pos.x, dy, nz - S.pos.z);
    const l = tmp.length();
    if (l > 1e-7) S.vel.copy(tmp).multiplyScalar(speed / l);
    S.pos.set(nx, h, nz);
  } else {
    S.pos.set(nx, S.pos.y + S.vel.y * dt, nz);
    S.vel.y -= G * dt;
    beginAir();
  }
}

function stepAir(dt) {
  const a = S.air;
  a.time += dt;
  S.vel.y -= G * dt;
  S.vel.multiplyScalar(1 - 0.0008 * S.vel.length() * dt);
  S.pos.addScaledVector(S.vel, dt);
  S.charge = 0;

  // spin and flip; with the stick released the board settles toward a clean landing
  if (Math.abs(inp.steer) > 0.15) S.spinVel = damp(S.spinVel, -inp.steer * 7.6, 5, dt);
  else {
    S.spinVel = damp(S.spinVel, 0, 5, dt);
    const heading = Math.atan2(S.vel.x, S.vel.z);
    let d = wrap(heading - S.yaw);
    if (Math.abs(d) > Math.PI / 2) d = wrap(d + Math.PI);
    S.spinVel += clamp(d * 6, -5, 5) * Math.min(1, 6 * dt);
  }
  if (Math.abs(inp.pitch) > 0.3) S.flipVel = damp(S.flipVel, inp.pitch * 6.6, 5, dt);
  else {
    S.flipVel = damp(S.flipVel, 0, 5, dt);
    S.flipVel += clamp(-wrap(S.flip) * 6, -5, 5) * Math.min(1, 6 * dt);
  }
  S.yaw += S.spinVel * dt;
  S.flip += S.flipVel * dt;
  a.spin += S.spinVel * dt;
  a.flip += S.flipVel * dt;
  if (inp.grab && a.time > 0.12) { a.grab += dt; a.grabName = inp.grab; }

  // rails
  if (S.railCd <= 0 && a.time > 0.06 && S.vel.y < 3) {
    const cell = Math.floor(S.pos.z / CELL);
    for (let c = cell - 1; c <= cell; c++) for (const r of cellFeatures(c)) {
      if (r.type !== 'rail') continue;
      const t = tmp.copy(S.pos).sub(r.p0).dot(r.dir) / r.len;
      if (t < 0.01 || t > 0.97) continue;
      tmp2.copy(r.p0).addScaledVector(r.dir, t * r.len);
      const dy = S.pos.y - tmp2.y;
      if (Math.hypot(S.pos.x - tmp2.x, S.pos.z - tmp2.z) > 0.9 || dy > 0.7 || dy < -0.5) continue;
      resolveAir(1);
      S.rail = r;
      S.railT = t;
      S.railV = S.vel.dot(r.dir);
      if (Math.abs(S.railV) < 4) S.railV = S.railV < 0 ? -4 : 4;
      S.railItem = { name: '50-50', pts: 150 };
      S.combo.items.push(S.railItem);
      S.flip = wrap(S.flip);
      sound.clank();
      return;
    }
  }

  const h = height(S.pos.x, S.pos.z);
  if (S.pos.y <= h) land(h);
}

function land(h) {
  const a = S.air;
  S.pos.y = h;
  normal(S.pos.x, S.pos.z, n);
  const vn = S.vel.dot(n);
  if (vn < 0) S.vel.addScaledVector(n, -vn);
  S.grounded = true;
  const impact = Math.max(-vn, 0);
  if (a.time < 0.25 && Math.abs(a.flip) < 0.5) {
    // just a bump in the snow
    S.flip = wrap(S.flip);
    S.air = null;
    return;
  }
  const flipOff = Math.abs(wrap(S.flip));
  let yawOff = Math.abs(wrap(Math.atan2(S.vel.x, S.vel.z) - S.yaw));
  if (yawOff > Math.PI / 2) yawOff = Math.PI - yawOff;
  if (S.vel.lengthSq() < 9) yawOff = 0;
  S.flip = wrap(S.flip);
  S.yawRate = 0;
  sound.thump(impact);
  for (let i = 0; i < 14; i++) puff(S.pos, S.vel.x * 0.3, 1.5, S.vel.z * 0.3, 4 + impact * 0.4);
  if (flipOff > 0.95 || yawOff > 1.2 || impact > 15) return bail();
  const sketchy = yawOff > 0.6 || flipOff > 0.55 || impact > 11;
  if (sketchy) {
    S.vel.multiplyScalar(0.75);
    if (airTricks(a).length) flash('Sketchy', 'meh');
  }
  resolveAir(sketchy ? 0.5 : 1);
}

function stepRail(dt, jumpReleased) {
  const r = S.rail;
  S.railV += (-G * r.dir.y - 0.4 * Math.sign(S.railV)) * dt;
  S.railT += (S.railV * dt) / r.len;
  S.pos.copy(r.p0).addScaledVector(r.dir, S.railT * r.len);
  S.vel.copy(r.dir).multiplyScalar(S.railV);
  S.yawRate = -inp.steer * 4.5;
  S.yaw += S.yawRate * dt;
  S.flip = damp(S.flip, 0, 14, dt);
  let off = Math.abs(wrap(S.yaw - Math.atan2(r.dir.x, r.dir.z)));
  if (off > Math.PI / 2) off = Math.PI - off;
  S.railItem.name = off > 0.7 ? 'Boardslide' : '50-50';
  S.railItem.pts += 320 * dt;
  S.carve = 0;
  if (Math.random() < 0.4) puff(S.pos, 0, 0.5, 0, 1.5);
  if (inp.jump) S.charge = Math.min(S.charge + dt / 0.5, 1);
  const off_end = S.railT < 0 || S.railT > 1;
  if (off_end || jumpReleased) {
    if (jumpReleased) { S.vel.y += 4 + 2 * S.charge; sound.pop(); }
    S.railItem.pts = Math.round(S.railItem.pts);
    S.railCd = 0.35;
    S.charge = 0;
    beginAir();
    S.spinVel = 0;
  }
}

function stepBail(dt) {
  S.bail -= dt;
  S.tumble += dt * (4 + S.vel.length() * 0.5);
  const h = height(S.pos.x, S.pos.z);
  if (S.pos.y > h + 0.05) {
    S.vel.y -= G * dt;
  } else {
    normal(S.pos.x, S.pos.z, n);
    const vn = S.vel.dot(n);
    if (vn < 0) S.vel.addScaledVector(n, -vn);
    S.vel.multiplyScalar(Math.exp(-2.2 * dt));
    if (Math.random() < 0.3) puff(S.pos, 0, 1, 0, 2);
  }
  S.pos.addScaledVector(S.vel, dt);
  const h2 = height(S.pos.x, S.pos.z);
  if (S.pos.y < h2) S.pos.y = h2;
  if (world.hitTree(S.pos.x, S.pos.y, S.pos.z)) S.vel.multiplyScalar(-0.3);
  if (S.bail <= 0) {
    // back on your feet, pointing down the fall line
    S.pos.y = h2;
    S.vel.set(0, 0, 0);
    S.grounded = true;
    S.yaw = 0;
    S.yawRate = S.flip = S.tumble = S.bail = 0;
  }
}

// --------------------------------------------------------------- camera ----
const cam = { dir: new THREE.Vector3(0, 0, 1), pos: new THREE.Vector3(), look: new THREE.Vector3(), snap: true };
function updateCamera(dt) {
  const hs = Math.hypot(S.vel.x, S.vel.z);
  if (hs > 2) tmp.set(S.vel.x / hs, 0, S.vel.z / hs);
  else tmp.set(Math.sin(S.yaw), 0, Math.cos(S.yaw));
  // never look back up the hill
  if (tmp.z < 0.15) { tmp.z = 0.15; tmp.normalize(); }
  cam.dir.lerp(tmp, 1 - Math.exp(-3.2 * dt)).normalize();
  const back = 6.6 + hs * 0.07;
  tmp.copy(S.pos).addScaledVector(cam.dir, -back);
  tmp.y = Math.max(S.pos.y + 2.3, height(tmp.x, tmp.z) + 1.9);
  tmp2.copy(S.pos).addScaledVector(cam.dir, 5);
  tmp2.y += 0.7;
  if (cam.snap) { cam.pos.copy(tmp); cam.look.copy(tmp2); cam.snap = false; }
  cam.pos.lerp(tmp, 1 - Math.exp(-7 * dt));
  cam.look.lerp(tmp2, 1 - Math.exp(-10 * dt));
  cam.pos.y = Math.max(cam.pos.y, height(cam.pos.x, cam.pos.z) + 1.0);
  camera.position.copy(cam.pos);
  camera.lookAt(cam.look);
  const fov = 62 + Math.min(hs, 34) * 0.62;
  if (Math.abs(fov - camera.fov) > 0.05) { camera.fov = damp(camera.fov, fov, 4, dt); camera.updateProjectionMatrix(); }
  sky.position.copy(camera.position);
  for (const r of ranges) r.position.copy(camera.position);
  sun.target.position.copy(S.pos);
  sun.position.copy(S.pos).addScaledVector(sunDir, 200);
}

const basis = new THREE.Matrix4(), bx = new THREE.Vector3(), bz = new THREE.Vector3();
function updateRider(dt) {
  const onSnow = S.grounded && !S.rail && S.bail <= 0;
  if (onSnow) normal(S.pos.x, S.pos.z, n); else n.set(0, 1, 0);
  S.up.lerp(n, 1 - Math.exp(-(onSnow ? 14 : 3) * dt)).normalize();
  f0.set(Math.sin(S.yaw), 0, Math.cos(S.yaw));
  bz.copy(f0).addScaledVector(S.up, -f0.dot(S.up)).normalize();
  bx.crossVectors(S.up, bz);
  basis.makeBasis(bx, S.up, bz);
  rider.root.quaternion.setFromRotationMatrix(basis);
  rider.root.position.copy(S.pos).addScaledVector(S.up, S.rail ? 0.09 : 0.03);
  const sp = S.vel.length();
  S.lean = damp(S.lean, onSnow ? clamp(-S.yawRate * sp * 0.035, -0.6, 0.6) : 0, 8, dt);
  rider.leanG.rotation.z = S.lean;
  rider.leanG.rotation.y = damp(rider.leanG.rotation.y, onSnow && S.braking && sp > 1 ? 1.1 : 0, 9, dt);
  rider.pivot.rotation.x = S.flip + S.tumble;
  rider.pose({
    crouch: S.rail ? 0.35 + 0.4 * S.charge : onSnow ? Math.max(S.tuck ? 0.75 : 0.22 + Math.abs(S.lean) * 0.5, 0.25 + 0.75 * S.charge) : 0.55,
    grab: S.air && S.air.time > 0.12 ? inp.grab : '',
    airborne: !!S.rail || (!S.grounded && S.air && S.air.time > 0.15), bail: S.bail > 0, time: S.time,
  }, dt);
}

function updateEffects(dt) {
  const onSnow = S.grounded && !S.rail && S.bail <= 0;
  const sp = S.vel.length();
  if (onSnow && S.carve > 0.12 && sp > 3) {
    const count = Math.min(Math.round(S.carve * 5 * dt * 60), 6);
    const side = Math.sign(S.yawRate) || 1;
    for (let i = 0; i < count; i++) {
      puff(S.pos, S.vel.x * 0.35 + s3.x * side * 2.5, 0.8 + S.carve * 1.6, S.vel.z * 0.35 + s3.z * side * 2.5, 1.6 + S.carve * 2);
    }
  }
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
  if (trail.last.distanceToSquared(S.pos) > 0.16) {
    trail.last.copy(S.pos);
    trailPush(S.pos, bx, S.up, onSnow);
  }
  sound.update(sp, S.carve, onSnow, !!S.rail);
}

// ------------------------------------------------------------------ hud ----
const hud = { force: true, score: -1, best: -1, speed: -1, combo: '', dist: -1 };
let flashTimer = 0;
function flash(text, kind) {
  const el = $('flash');
  el.textContent = text;
  el.className = 'show ' + kind;
  flashTimer = 1.4;
}
function updateHud(dt) {
  const set = (key, value, el, fmt) => {
    if (hud[key] === value && !hud.force) return;
    hud[key] = value;
    $(el).textContent = fmt ? fmt(value) : value;
  };
  set('score', S.score, 'score', (v) => v.toLocaleString());
  set('best', S.best, 'best', (v) => v.toLocaleString());
  set('speed', Math.round(S.vel.length() * 3.6), 'speed');
  set('dist', Math.round(S.pos.z * 0.36), 'drop', (v) => Math.max(v, 0).toLocaleString());
  const items = S.combo.items.concat(S.air && S.air.time > 0.25 ? airTricks(S.air) : []);
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

function start() {
  if (S.started) return;
  S.started = true;
  document.body.classList.add('playing');
  sound.start();
  S.vel.set(0, 0, 2.5);
}
$('go').addEventListener('click', start);
$('restart').addEventListener('click', () => { reset(); S.vel.set(0, 0, 2.5); });
$('mute').addEventListener('click', () => { $('mute').textContent = sound.toggleMute() ? 'Sound off' : 'Sound on'; });
if (touch) document.body.classList.add('touch');

let last = performance.now(), acc = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  readInput();
  if (S.started) {
    acc += dt;
    while (acc >= DT) { step(DT); acc -= DT; }
  }
  world.update(S.pos.x, S.pos.z);
  updateRider(dt);
  updateCamera(dt);
  updateEffects(dt);
  updateHud(dt);
  renderer.render(scene, camera);
}

reset();
requestAnimationFrame(frame);
window.coldsmoke = { S, inp, world, step, reset, start };
