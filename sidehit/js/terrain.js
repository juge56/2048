// Turns a map into a rideable hill: height field, feature meshes, trees, ray casting.
import * as THREE from '../vendor/three.module.min.js';
import { centerX } from './maps.js';

export const KICKER = [{ H: 1.2, L: 7, w: 5 }, { H: 2.2, L: 11, w: 7 }, { H: 3.4, L: 15, w: 9 }, { H: 4.8, L: 19, w: 11 }];
export const ROLLER = [{ H: 0.8, L: 10, w: 8 }, { H: 1.5, L: 16, w: 10 }, { H: 2.4, L: 24, w: 14 }];
// Tabletop jumps: curved take-off (T), flat deck (D), sloped landing (R).
export const JUMP = [{ H: 2.0, T: 9, D: 6, R: 15, w: 9 }, { H: 3.0, T: 13, D: 9, R: 21, w: 11 }, { H: 4.2, T: 18, D: 13, R: 28, w: 13 }];
const SIDE = 130, CELL = 8, F = 5;   // F: numbers stored per forest tree
const UP = new THREE.Vector3(0, 1, 0);
const RAIL_COLOURS = [0xffc928, 0xff3d7f, 0xff7a1a, 0x22c7e8, 0x8be04e];

function hash(ix, iz, s) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263) ^ Math.imul((s | 0) + 977, 1274126177);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x, z, s) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = hash(ix, iz, s), b = hash(ix + 1, iz, s), c = hash(ix, iz + 1, s), d = hash(ix + 1, iz + 1, s);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
}
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
// integral of a smoothstep that starts at `a` and takes `w` metres to reach full slope
const ramp = (z, a, w) => { const t = (z - a) / w; return t <= 0 ? 0 : t >= 1 ? w / 2 + (z - a - w) : w * (t * t * t - (t * t * t * t) / 2); };

// Length and width of the snow a shaped feature covers.
export function bumpSize(o) {
  if (o.t === 'kicker') return { ...KICKER[o.s], len: KICKER[o.s].L };
  if (o.t === 'roller') return { ...ROLLER[o.s], len: ROLLER[o.s].L };
  const j = JUMP[o.s];
  return { ...j, len: j.T + j.D + j.R };
}

// Centre and pick radius of an object, used by the editor.
export function footprint(o) {
  const sin = Math.sin(o.r || 0), cos = Math.cos(o.r || 0);
  let half = 0, rad = 2.5;
  if (o.t === 'rail' || o.t === 'box') { half = o.len / 2; rad = Math.max(half, 2.5); }
  else if (o.t !== 'tree') { const b = bumpSize(o); half = b.len / 2; rad = Math.max(half, b.w / 2); }
  return { x: o.x + sin * half, z: o.z + cos * half, rad };
}

function treeGeometry(profile) {
  const g = new THREE.LatheGeometry(profile.map((p) => new THREE.Vector2(p[0], p[1])), 7).toNonIndexed();
  g.computeVertexNormals();
  const pos = g.attributes.position, nor = g.attributes.normal, col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i += 3) {
    const y = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    const t = y < 1 ? -1 : Math.min(Math.max(nor.getY(i) * 1.9, 0), 1) * 0.85;
    const rgb = t < 0 ? [0.24, 0.15, 0.1] : [0.05 + t * 0.85, 0.2 + t * 0.73, 0.13 + t * 0.85];
    for (let k = 0; k < 3; k++) col.set(rgb, (i + k) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

// Sun glints: tiny crystals that flash as the camera moves past them.
export const sparkle = { value: 1 };
function addSparkle(material) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSparkle = sparkle;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSnowPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvSnowPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vSnowPos; uniform float uSparkle;
        float snowHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }`)
      .replace('#include <opaque_fragment>', `
        vec3 toEye = cameraPosition - vSnowPos;
        float dist = length(toEye);
        vec3 cell = floor(vec3(vSnowPos.xz * 26.0, 0.0)) + floor(vec3(normalize(toEye).xz * 34.0, 1.0)).xzy;
        float glint = step(0.9935, snowHash(cell)) * smoothstep(34.0, 3.0, dist) * uSparkle;
        outgoingLight += vec3(1.0, 0.97, 0.9) * glint * 1.6;
        #include <opaque_fragment>`);
  };
  return material;
}

let shared = null;
function sharedAssets() {
  if (shared) return shared;
  // groomed-snow stripes running down the fall line
  const c = document.createElement('canvas');
  c.width = 64; c.height = 4;
  const g = c.getContext('2d');
  for (let x = 0; x < 64; x++) {
    const v = Math.round(243 + 12 * (0.5 + 0.5 * Math.cos((x / 64) * Math.PI * 2)));
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(x, 0, 1, 4);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const lam = (color, extra) => new THREE.MeshLambertMaterial({ color, ...extra });
  shared = {
    snow: addSparkle(new THREE.MeshLambertMaterial({ vertexColors: true, map: tex, side: THREE.DoubleSide })),
    powder: addSparkle(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })),
    treeMat: new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }),
    trees: [
      treeGeometry([[0.26, -0.6], [0.26, 1.0], [2.1, 1.0], [0.8, 3.0], [1.6, 3.0], [0.55, 5.0], [1.05, 5.0], [0.0, 7.0]]),
      treeGeometry([[0.2, -0.6], [0.2, 1.4], [1.35, 1.4], [0.6, 3.4], [1.1, 3.4], [0.45, 5.6], [0.85, 5.6], [0.3, 7.6], [0.6, 7.6], [0.0, 9.6]]),
    ],
    rails: RAIL_COLOURS.map((col) => new THREE.MeshStandardMaterial({ color: col, roughness: 0.35, metalness: 0.5 })),
    steel: new THREE.MeshStandardMaterial({ color: 0x3a4250, roughness: 0.5, metalness: 0.7 }),
    boxSides: RAIL_COLOURS.map((col) => lam(col)),
    boxTop: lam(0xf3f6fa),
    gate: lam(0xff3d7f),
    finish: lam(0x1b2a44),
    net: lam(0xff7a1a, { side: THREE.DoubleSide, transparent: true, opacity: 0.8 }),
    tube: new THREE.CylinderGeometry(1, 1, 1, 12),
    ball: new THREE.SphereGeometry(1, 12, 8),
    cube: new THREE.BoxGeometry(1, 1, 1),
  };
  return shared;
}

export class Terrain {
  constructor(map) {
    this.map = map;
    this.a = sharedAssets();
    this.step = map.length > 1200 ? 4 : 3;
    this.group = new THREE.Group();
    this.objects = new THREE.Group();
    this.group.add(this.objects);
    this.meshOf = new Map();
    this.bumps = [];
    this.rails = [];
    this.forest = [];
    this.own = [];
    this.buildGround();
    this.compile();
    this.buildObjects();
  }

  center(z) { return centerX(this.map, z); }

  // ---- height field ----------------------------------------------------

  base(x, z) {
    const m = this.map, s = m.seed;
    let h = -m.slope * (ramp(z, -2, 26) - ramp(z, m.length - 40, 40));
    if (z < -4) h += (-z - 4) * 0.35;
    const fade = smooth((z - 10) / 40);
    h += m.bumps * fade * (2.6 * noise(x / 85, z / 85, s) + 0.5 * noise(x / 27, z / 27, s + 1));
    if (m.powder) {
      // wind-blown pillows and hollows
      const p = noise(x / 15, z / 15, s + 6);
      h += fade * (0.9 * p * Math.abs(p) + 0.1 * noise(x / 7, z / 7, s + 7));
    }
    if (m.cliffs) {
      // benches that end in a drop, strongest where the mask says so
      const q = z / 75 + 1.3 * noise(x / 95, z / 170, s + 9), f = q - Math.floor(q);
      const mask = smooth((noise(x / 150, z / 150, s + 11) + 0.25) / 0.35);
      h += m.cliffs * 6.5 * mask * fade * (f - smooth((f - 0.9) / 0.07)) * (1 - smooth((z - m.length + 120) / 80));
    }
    const a = Math.abs(x - centerX(m, z)) - m.width / 2;
    if (a > 0) {
      h += a < 40 ? 0.008 * a * a : 12.8 + 0.64 * (a - 40);
      const w = Math.min(a / 80, 1);
      h += w * w * (14 * noise(x / 110, z / 110, s + 3) + 3 * noise(x / 31, z / 31, s + 4));
    }
    return h;
  }

  // `over` extends take-offs slightly past the lip so normals sampled at the lip stay sane.
  height(x, z, over = 0) {
    let h = this.base(x, z);
    const bs = this.bumps;
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i], dx = x - b.x, dz = z - b.z;
      if (dx * dx + dz * dz > b.rad2) continue;
      const v = Math.abs(dx * b.cos - dz * b.sin);
      if (v >= b.hw) continue;
      const u = dx * b.sin + dz * b.cos;
      if (u <= 0 || u >= b.len + over) continue;
      const e = v < b.hw - b.edge ? 1 : 1 - smooth((v - (b.hw - b.edge)) / b.edge);
      if (b.type === 'roller') { if (u < b.len) h += b.H * (0.5 - 0.5 * Math.cos((u / b.len) * Math.PI * 2)) * e; }
      else if (u <= b.T + over) h += b.H * (u / b.T) ** 2 * e;
      else if (b.type === 'jump') {
        const d = u - b.T - b.D;
        h += 0.72 * b.H * (d < 0 ? 1 : 1 - smooth(d / b.R)) * e;
      }
    }
    return h;
  }

  normal(x, z, out) {
    const e = 0.35;
    out.set(this.height(x - e, z, 1) - this.height(x + e, z, 1), 2 * e, this.height(x, z - e, 1) - this.height(x, z + e, 1));
    return out.normalize();
  }

  // Where a ray meets the snow; returns false if it never does.
  raycast(origin, dir, out) {
    let t0 = 0, t1 = 0;
    const p = out;
    for (let t = 2; t < 3500; t += 2) {
      p.copy(origin).addScaledVector(dir, t);
      if (p.y < this.height(p.x, p.z)) { t0 = t - 2; t1 = t; break; }
    }
    if (!t1) return false;
    for (let i = 0; i < 12; i++) {
      const tm = (t0 + t1) / 2;
      p.copy(origin).addScaledVector(dir, tm);
      if (p.y < this.height(p.x, p.z)) t1 = tm; else t0 = tm;
    }
    return true;
  }

  // ---- derived data ----------------------------------------------------

  compile() {
    this.bumps.length = 0;
    this.rails.length = 0;
    this.grid = new Map();
    const addTree = (x, y, z, s) => {
      const k = Math.floor(x / CELL) + ',' + Math.floor(z / CELL);
      let cell = this.grid.get(k);
      if (!cell) this.grid.set(k, (cell = []));
      cell.push(x, y, z, s);
    };
    const f = this.forest;
    for (let i = 0; i < f.length; i += F) addTree(f[i], f[i + 1], f[i + 2], f[i + 3]);
    for (const o of this.map.objects) {
      if (o.t === 'tree') addTree(o.x, this.base(o.x, o.z), o.z, o.s);
      else if (o.t !== 'rail' && o.t !== 'box') {
        const d = bumpSize(o);
        this.bumps.push({
          o, type: o.t, x: o.x, z: o.z, sin: Math.sin(o.r), cos: Math.cos(o.r), H: d.H, len: d.len, hw: d.w / 2,
          T: o.t === 'jump' ? d.T : d.len, D: d.D || 0, R: d.R || 0, edge: o.t === 'jump' ? 2.5 : 1.5, rad2: (d.len + 3) ** 2 + (d.w / 2) ** 2,
        });
      }
    }
    for (const o of this.map.objects) if (o.t === 'rail' || o.t === 'box') this.rails.push(this.railPath(o));
  }

  // A rail or box as a chain of straight segments the rider slides along.
  railPath(o) {
    const sin = Math.sin(o.r), cos = Math.cos(o.r), L = o.len;
    const at = (u, v, y) => {
      const x = o.x + u * sin + v * cos, z = o.z + u * cos - v * sin;
      return new THREE.Vector3(x, y === undefined ? this.height(x, z) + o.h : y, z);
    };
    let pts;
    if (o.k === 'rainbow') {
      // an arc that climbs and comes back down
      const a = at(0, 0), b = at(L, 0), rise = Math.min(1.5, L * 0.09), n = 10;
      pts = [];
      for (let i = 0; i <= n; i++) { const t = i / n; pts.push(at(t * L, 0, a.y + (b.y - a.y) * t + rise * Math.sin(t * Math.PI))); }
    } else if (o.k === 'z') {
      // straight, a diagonal step sideways, straight again
      pts = [at(0, 0), at(L * 0.36, 0), at(L * 0.64, 2), at(L, 2)];
    } else if (o.k === 'kink') {
      // down, flat, down
      const mid = at(L / 3, 0);
      pts = [at(0, 0), mid, at((2 * L) / 3, 0, mid.y), at(L, 0)];
    } else if (o.k === 'flatdown') {
      const a = at(0, 0);
      pts = [a, at(L / 2, 0, a.y), at(L, 0)];
    } else pts = [at(0, 0), at(L, 0)];
    const segs = [];
    let total = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const dir = pts[i + 1].clone().sub(pts[i]), len = dir.length();
      segs.push({ p0: pts[i], p1: pts[i + 1], dir: dir.divideScalar(len), len, s0: total });
      total += len;
    }
    const wide = o.t === 'box', width = wide ? (o.k === 'wide' ? 2 : 0.62) : 0;
    return { o, pts, segs, total, wide, width, reach: wide ? (o.k === 'wide' ? 1.6 : 1.15) : 0.9 };
  }

  hitTree(x, y, z) {
    for (let k = 0; k < 4; k++) {
      const cell = this.grid.get(Math.floor((x + (k & 1 ? 1.2 : -1.2)) / CELL) + ',' + Math.floor((z + (k & 2 ? 1.2 : -1.2)) / CELL));
      if (!cell) continue;
      for (let t = 0; t < cell.length; t += 4) {
        const dx = x - cell[t], dz = z - cell[t + 2], r = 0.3 + 0.3 * cell[t + 3];
        if (dx * dx + dz * dz < r * r && y < cell[t + 1] + 5.5 * cell[t + 3]) return { x: cell[t], z: cell[t + 2], r };
      }
    }
    return null;
  }

  // ---- meshes ----------------------------------------------------------

  buildGround() {
    const m = this.map, a = this.a, STEP = this.step, bend = m.curve ? 95 * m.curve : 0;
    const x0 = -m.width / 2 - SIDE - bend, z0 = -90;
    const nx = Math.ceil((m.width + 2 * (SIDE + bend)) / STEP), nz = Math.ceil((m.length + 240) / STEP);
    const W = nx + 1, M = W + 2;
    const hs = new Float32Array(M * (nz + 3));
    for (let j = 0; j < nz + 3; j++) for (let i = 0; i < M; i++) hs[j * M + i] = this.base(x0 + (i - 1) * STEP, z0 + (j - 1) * STEP);
    const count = W * (nz + 1);
    const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), col = new Float32Array(count * 3), uv = new Float32Array(count * 2);
    const idx = new Uint32Array(nx * nz * 6);
    for (let j = 0; j <= nz; j++) {
      const z = z0 + j * STEP, c = centerX(m, z);
      for (let i = 0; i <= nx; i++) {
        const v = j * W + i, k = v * 3, q = (j + 1) * M + i + 1, x = x0 + i * STEP;
        pos[k] = x; pos[k + 1] = hs[q]; pos[k + 2] = z;
        const ax = hs[q - 1] - hs[q + 1], ay = 2 * STEP, az = hs[q - M] - hs[q + M], l = Math.hypot(ax, ay, az);
        nor[k] = ax / l; nor[k + 1] = ay / l; nor[k + 2] = az / l;
        // untracked snow gets stronger light and dark patches so the shape of the slope reads
        const shade = m.powder ? 0.9 + 0.07 * noise(x / 40, z / 40, m.seed + 8) + 0.05 * noise(x / 15, z / 15, m.seed + 6) : 0.94 + 0.06 * noise(x / 40, z / 40, m.seed + 8);
        // slightly bluer, unpisted snow outside the run
        const off = m.powder ? 0.6 : smooth((Math.abs(x - c) - m.width / 2) / 12);
        // bare rock on the steepest faces
        const rock = ay / l < 0.72 ? smooth((0.72 - ay / l) / 0.1) * 0.75 : 0;
        col[k] = ((0.93 - 0.05 * off) * (1 - rock) + 0.36 * rock) * shade;
        col[k + 1] = ((0.95 - 0.03 * off) * (1 - rock) + 0.36 * rock) * shade;
        col[k + 2] = (1 - rock + 0.4 * rock) * shade;
        uv[v * 2] = (x - c) / 0.45; uv[v * 2 + 1] = z / 6;
      }
    }
    let n = 0;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const p = j * W + i, q = p + 1, r = p + W, s = r + 1;
      idx[n++] = p; idx[n++] = r; idx[n++] = q; idx[n++] = q; idx[n++] = r; idx[n++] = s;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.ground = new THREE.Mesh(g, m.powder ? a.powder : a.snow);
    this.ground.receiveShadow = true;
    this.group.add(this.ground);
    this.own.push(g);

    // forest around the run, plus trees scattered inside it where the map asks for them;
    // each tree is x, y, z, scale, kind
    const f = this.forest, T = 9;
    f.length = 0;
    for (let gz = Math.floor(z0 / T); gz * T < m.length + 150; gz++) for (let gx = Math.floor(x0 / T); gx * T < -x0; gx++) {
      const x = (gx + 0.15 + 0.7 * hash(gx, gz, m.seed + 21)) * T, z = (gz + 0.15 + 0.7 * hash(gx, gz, m.seed + 22)) * T;
      const d = Math.abs(x - centerX(m, z)), side = d - m.width / 2;
      let p = side > 5 ? 0.5 * smooth((side - 5) / 15) : z < -16 || z > m.length + 70 ? 0.4 : 0;
      if (!p && m.trees && side < -3 && z > 30 && z < m.length - 20 && !(z < 110 && d < 16)) {
        p = m.trees * 0.34 * smooth((noise(x / 60, z / 60, m.seed + 31) + 0.05) / 0.3);
      }
      if (hash(gx, gz, m.seed + 24) < p) f.push(x, this.base(x, z), z, 0.75 + hash(gx, gz, m.seed + 25) * 0.9, hash(gx, gz, m.seed + 26) < 0.35 ? 1 : 0);
    }
    const mat = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3();
    this.forestMeshes = a.trees.map((geo, kind) => {
      let total = 0;
      for (let t = 0; t < f.length; t += F) if (f[t + 4] === kind) total++;
      const inst = new THREE.InstancedMesh(geo, a.treeMat, total);
      for (let t = 0, i = 0; t < f.length; t += F) {
        if (f[t + 4] !== kind) continue;
        q.setFromAxisAngle(UP, hash(t, 1, 2) * 6.28);
        mat.compose(v.set(f[t], f[t + 1], f[t + 2]), q, s.set(f[t + 3], f[t + 3] * (0.9 + 0.3 * hash(t, 3, 4)), f[t + 3]));
        inst.setMatrixAt(i++, mat);
      }
      inst.castShadow = inst.receiveShadow = true;
      inst.frustumCulled = false;
      this.group.add(inst);
      return inst;
    });
    if (!m.powder) this.buildFence();
  }

  // Orange safety netting down both sides of a groomed run.
  buildFence() {
    const m = this.map, a = this.a, pos = [], idx = [], posts = [];
    for (const side of [-1, 1]) {
      const start = pos.length / 3;
      let rows = 0;
      for (let z = 0; z <= m.length; z += 4, rows++) {
        const x = centerX(m, z) + side * (m.width / 2 + 3), y = this.base(x, z);
        pos.push(x, y + 0.35, z, x, y + 1.2, z);
        if (rows % 2 === 0) posts.push(x, y + 0.55, z);
      }
      for (let i = 0; i < rows - 1; i++) { const p = start + i * 2; idx.push(p, p + 1, p + 2, p + 2, p + 1, p + 3); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    this.group.add(new THREE.Mesh(g, a.net));
    this.own.push(g);
    const inst = new THREE.InstancedMesh(a.cube, a.steel, posts.length / 3);
    const mat = new THREE.Matrix4();
    for (let i = 0; i < posts.length; i += 3) inst.setMatrixAt(i / 3, mat.makeScale(0.07, 1.5, 0.07).setPosition(posts[i], posts[i + 1], posts[i + 2]));
    inst.frustumCulled = false;
    this.group.add(inst);
    this.fencePosts = inst;
  }

  buildObjects() {
    for (const m of this.meshOf.values()) this.disposeMesh(m);
    this.meshOf.clear();
    this.objects.clear();
    for (const o of this.map.objects) this.addMesh(o);
    const m = this.map;
    this.objects.add(this.gate(m.spawn.x, m.spawn.z, this.a.gate), this.gate(centerX(m, m.length), m.length, this.a.finish));
  }

  gate(x, z, material) {
    const group = new THREE.Group(), half = 5.5;
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(this.a.cube, material);
      post.scale.set(0.25, 6.4, 0.25);
      post.position.set(x + s * half, this.base(x + s * half, z) + 2.9, z);
      post.castShadow = true;
      group.add(post);
    }
    const bar = new THREE.Mesh(this.a.cube, material);
    bar.scale.set(half * 2 + 0.25, 0.7, 0.25);
    bar.position.set(x, this.base(x, z) + 5.9, z);
    bar.castShadow = true;
    group.add(bar);
    return group;
  }

  // Rebuild one object after it moved (cheap enough to do while dragging).
  refreshObject(o) {
    this.compile();
    const old = this.meshOf.get(o);
    if (old) { this.objects.remove(old); this.disposeMesh(old); }
    this.addMesh(o);
  }

  addMesh(o) {
    let m;
    if (o.t === 'tree') {
      m = new THREE.Mesh(this.a.trees[hash(o.x * 10, o.z * 10, 6) < 0.35 ? 1 : 0], this.a.treeMat);
      m.position.set(o.x, this.base(o.x, o.z), o.z);
      m.scale.setScalar(o.s);
      m.rotation.y = hash(o.x * 10, o.z * 10, 5) * 6.28;
      m.castShadow = m.receiveShadow = true;
    } else if (o.t === 'rail' || o.t === 'box') m = this.railMesh(this.rails.find((r) => r.o === o));
    else m = this.bumpMesh(this.bumps.find((b) => b.o === o));
    this.meshOf.set(o, m);
    this.objects.add(m);
  }

  // Shaped snow: a fine patch laid over the coarse ground mesh.
  bumpMesh(b) {
    const w = b.hw * 2, nx = Math.ceil((w + 1) * 2), W = nx + 1, lipped = b.type !== 'roller';
    const us = [];
    for (let u = 0; u < b.T - 0.01; u += 0.5) us.push(u);
    if (lipped) us.push(b.T, b.T + 0.03);          // the lip, then the face behind it
    for (let u = b.T + 0.5; u < b.len; u += 0.5) us.push(u);
    if (b.type !== 'kicker') us.push(b.len);
    const pos = [], col = [], uv = [], idx = [];
    us.forEach((u, j) => {
      const lip = lipped && u <= b.T && u > b.T - 0.8, face = lipped && us[j - 1] === b.T;
      for (let i = 0; i <= nx; i++) {
        const v = -b.hw - 0.5 + (i / nx) * (w + 1);
        const x = b.x + u * b.sin + v * b.cos, z = b.z + u * b.cos - v * b.sin;
        // coloured markers at the edges of the take-off, as parks paint them
        const marker = lip && Math.abs(Math.abs(v) - (b.hw - b.edge)) < 0.45;
        pos.push(x, this.height(x, z) + 0.05, z);
        if (marker) col.push(0.1, 0.45, 1); else if (lip) col.push(1, 0.36, 0.2); else if (face) col.push(0.62, 0.7, 0.84); else col.push(0.93, 0.95, 1);
        uv.push((x - this.center(z)) / 0.45, z / 6);
      }
    });
    for (let j = 0; j < us.length - 1; j++) for (let i = 0; i < nx; i++) {
      const p = j * W + i, q = p + 1, r = p + W, s = r + 1;
      idx.push(p, r, q, q, r, s);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, this.a.snow);
    m.receiveShadow = m.castShadow = true;
    m.userData.own = true;
    return m;
  }

  // Park steel: a round tube on splayed legs, or a box with a slick top sheet and metal edges.
  railMesh(r) {
    const a = this.a, group = new THREE.Group(), o = r.o;
    const tint = Math.floor(hash(o.x * 7, o.z * 7, 12) * RAIL_COLOURS.length);
    const add = (geo, mat, shadow = true) => { const m = new THREE.Mesh(geo, mat); m.castShadow = shadow; group.add(m); return m; };
    const tube = (p, q, rad, mat) => {
      const m = add(a.tube, mat), d = q.clone().sub(p), len = d.length();
      m.position.copy(p).addScaledVector(d, 0.5);
      m.quaternion.setFromUnitVectors(UP, d.divideScalar(len));
      m.scale.set(rad, len, rad);
      return m;
    };
    const ball = (p, rad, mat) => { const m = add(a.ball, mat); m.scale.setScalar(rad); m.position.copy(p); };
    const p = new THREE.Vector3(), foot = new THREE.Vector3(), top = new THREE.Vector3(), across = new THREE.Vector3(), basis = new THREE.Matrix4();
    let since = 4;
    if (!r.wide) ball(r.pts[0], 0.058, a.rails[tint]);
    for (const sg of r.segs) {
      across.crossVectors(UP, sg.dir).normalize();
      if (r.wide) {
        const q = new THREE.Quaternion().setFromRotationMatrix(basis.makeBasis(across, new THREE.Vector3().crossVectors(sg.dir, across), sg.dir));
        p.copy(sg.p0).add(sg.p1).multiplyScalar(0.5);
        const body = add(a.cube, a.boxSides[tint]);
        body.scale.set(r.width, 0.34, sg.len + 0.02);
        body.quaternion.copy(q);
        body.position.copy(p).y -= 0.19;
        const sheet = add(a.cube, a.boxTop, false);
        sheet.scale.set(r.width - 0.1, 0.03, sg.len);
        sheet.quaternion.copy(q);
        sheet.position.copy(p).y -= 0.012;
        // steel coping down both edges
        for (const s of [-1, 1]) {
          const off = across.clone().multiplyScalar(s * (r.width / 2 - 0.02));
          tube(sg.p0.clone().add(off), sg.p1.clone().add(off), 0.028, a.steel);
        }
      } else {
        tube(sg.p0, sg.p1, 0.058, a.rails[tint]);
        ball(sg.p1, 0.058, a.rails[tint]);
      }
      // legs with feet on the snow
      // one pair of legs roughly every four metres, however finely the rail is segmented
      since += sg.len;
      const legs = sg.len >= 3 ? Math.max(1, Math.round(sg.len / 4)) : since >= 4 ? 1 : 0, spread = r.wide ? r.width / 2 - 0.08 : 0.28;
      if (legs) since = 0;
      for (let k = 0; k < legs; k++) {
        p.copy(sg.p0).lerp(sg.p1, (k + 0.5) / legs);
        for (const s of [-1, 1]) {
          foot.copy(p).addScaledVector(across, s * spread);
          foot.y = this.base(foot.x, foot.z) - 0.05;
          if (r.wide) top.copy(foot).setY(p.y - 0.3); else top.copy(p).setY(p.y - 0.04);
          if (top.y - foot.y > 0.05) tube(foot, top, r.wide ? 0.05 : 0.03, a.steel);
          const pad = add(a.cube, a.steel, false);
          pad.scale.set(0.22, 0.03, 0.22);
          pad.position.copy(foot).y += 0.07;
        }
      }
    }
    return group;
  }

  disposeMesh(m) { m.traverse((o) => { if (o.userData.own) o.geometry.dispose(); }); }

  dispose() {
    for (const m of this.meshOf.values()) this.disposeMesh(m);
    for (const g of this.own) g.dispose();
    for (const f of this.forestMeshes) f.dispose();
    if (this.fencePosts) this.fencePosts.dispose();
    this.group.removeFromParent();
  }
}
