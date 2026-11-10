// Procedural mountain: height field, park features, trees, and chunk streaming.
import * as THREE from './vendor/three.module.min.js';

export const SLOPE = 0.36;   // average fall line gradient
export const CHUNK = 80;     // metres per terrain chunk
const SEG = 20;              // quads per chunk side
export const CELL = 100;     // one park feature slot per CELL metres of descent
const SEED = 1337;

export function hash(ix, iz, s = 0) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263) ^ Math.imul((s | 0) + SEED, 1274126177);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Value noise in [-1, 1] with quintic fade (continuous curvature, so the
// rider only leaves the ground where the terrain really falls away).
function noise(x, z, s) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = hash(ix, iz, s), b = hash(ix + 1, iz, s), c = hash(ix, iz + 1, s), d = hash(ix + 1, iz + 1, s);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
}

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// The open run meanders down the valley; this is its centre line.
export function centerX(z) {
  return 60 * Math.sin(z * 0.0021) + 35 * Math.sin(z * 0.0057 + 1.3);
}
function centerDx(z) {
  return 60 * 0.0021 * Math.cos(z * 0.0021) + 35 * 0.0057 * Math.cos(z * 0.0057 + 1.3);
}

export function baseHeight(x, z) {
  const a = Math.abs(x - centerX(z)) - 85;
  let h = z > 0 ? -SLOPE * z : -0.25 * z;
  h += 10 * noise(x / 350, z / 350, 1) + 1.6 * noise(x / 60, z / 60, 2) + 0.12 * noise(x / 16, z / 16, 3);
  if (a > 0) {
    // valley walls
    h += a < 100 ? 0.003 * a * a : 30 + 0.6 * (a - 100);
    const w = Math.min(a / 150, 1);
    h += w * w * (22 * noise(x / 130, z / 130, 4) + 5 * noise(x / 37, z / 37, 5));
  }
  return h;
}

const EMPTY = [];
const featureCache = new Map();

function makeRail(i, fx, fz, k) {
  const len = 14 + hash(i, 20 + k, 7) * 10;
  const dx = centerDx(fz);
  const x1 = fx + dx * len, z1 = fz + len;
  const p0 = new THREE.Vector3(fx, baseHeight(fx, fz) + 0.5, fz);
  const p1 = new THREE.Vector3(x1, baseHeight(x1, z1) + 0.5, z1);
  const d = p1.clone().sub(p0);
  const length = d.length();
  return { type: 'rail', p0, p1, len: length, dir: d.divideScalar(length) };
}

export function cellFeatures(i) {
  if (i < 1) return EMPTY;
  let f = featureCache.get(i);
  if (f) return f;
  f = [];
  let r = hash(i, 11, 7);
  if (i === 1) r = 0.2;
  if (i === 2) r = 0.7;
  const fz = i * CELL + 15 + hash(i, 12, 7) * 35;
  const off = (hash(i, 13, 7) - 0.5) * 44;
  const fx = centerX(fz) + off;
  const s = hash(i, 14, 7);
  if (r < 0.42) f.push({ type: 'kicker', x: fx, z: fz, H: 1.6 + s * 1.8, L: 9 + s * 6, w: 7 + s * 3 });
  else if (r < 0.62) f.push({ type: 'kicker', x: fx, z: fz, H: 4.2 + s * 1.2, L: 17 + s * 3, w: 11 });
  else if (r < 0.88) f.push(makeRail(i, fx, fz, 0));
  if (r < 0.62 && hash(i, 15, 7) < 0.4) {
    const side = off > 0 ? -1 : 1;
    f.push(makeRail(i, centerX(fz) + side * (15 + hash(i, 16, 7) * 9), fz + 4, 1));
  }
  featureCache.set(i, f);
  return f;
}

// Physics height: base terrain plus kickers. Kickers end in a sharp lip.
// `over` extends each kicker a little past its lip, so slope normals taken
// right at the lip don't straddle the drop.
export function height(x, z, over = 0) {
  let h = baseHeight(x, z);
  const fs = cellFeatures(Math.floor(z / CELL));
  for (let k = 0; k < fs.length; k++) {
    const f = fs[k];
    if (f.type !== 'kicker') continue;
    const u = (z - f.z) / f.L;
    if (u <= 0 || u > 1 + over / f.L) continue;
    const dx = Math.abs(x - f.x), hw = f.w / 2;
    if (dx >= hw) continue;
    const e = dx < hw - 1.5 ? 1 : 1 - smooth((dx - (hw - 1.5)) / 1.5);
    h += f.H * u * u * e;
  }
  return h;
}

export function normal(x, z, out) {
  const e = 0.35;
  out.set(height(x - e, z, 1) - height(x + e, z, 1), 2 * e, height(x, z - e, 1) - height(x, z + e, 1));
  return out.normalize();
}

// ---------------------------------------------------------------------------

function makeTreeGeometry() {
  const pts = [
    [0.26, -0.6], [0.26, 1.0], [2.1, 1.0], [0.8, 3.0], [1.6, 3.0], [0.55, 5.0], [1.05, 5.0], [0.0, 7.0],
  ].map((p) => new THREE.Vector2(p[0], p[1]));
  const g = new THREE.LatheGeometry(pts, 7).toNonIndexed();
  g.computeVertexNormals();
  const pos = g.attributes.position, nor = g.attributes.normal;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i += 3) {
    // colour per face
    const y = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    const ny = nor.getY(i);
    let r, gg, b;
    if (y < 1.0) { r = 0.24; gg = 0.15; b = 0.1; }
    else {
      const t = Math.min(Math.max(ny * 1.9, 0), 1) * 0.85;
      r = 0.05 + t * 0.85; gg = 0.2 + t * 0.73; b = 0.13 + t * 0.85;
    }
    for (let k = 0; k < 3; k++) { col[(i + k) * 3] = r; col[(i + k) * 3 + 1] = gg; col[(i + k) * 3 + 2] = b; }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

export class World {
  constructor(scene) {
    this.scene = scene;
    this.chunks = new Map();
    this.cells = new Map();
    this.snowMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.treeMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    this.treeGeo = makeTreeGeometry();
    this.railMat = new THREE.MeshLambertMaterial({ color: 0xffc928 });
    this.postMat = new THREE.MeshLambertMaterial({ color: 0x39424e });
    this.railGeo = new THREE.CylinderGeometry(0.07, 0.07, 1, 8);
    this.postGeo = new THREE.BoxGeometry(0.1, 1, 0.1);
    const idx = [];
    const N = SEG + 1;
    for (let j = 0; j < SEG; j++) for (let i = 0; i < SEG; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    this.index = new THREE.BufferAttribute(new Uint16Array(idx), 1);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
  }

  // Stream chunks and park features around the rider. `budget` limits how many
  // chunks are built per call so streaming never hitches a frame.
  update(px, pz, budget = 2) {
    const x0 = Math.floor((px - 320) / CHUNK), x1 = Math.floor((px + 320) / CHUNK);
    const z0 = Math.floor((pz - 160) / CHUNK), z1 = Math.floor((pz + 660) / CHUNK);
    for (const [key, c] of this.chunks) {
      if (c.cx < x0 || c.cx > x1 || c.cz < z0 || c.cz > z1) {
        this.scene.remove(c.mesh);
        c.mesh.geometry.dispose();
        if (c.trees) { this.scene.remove(c.trees); c.trees.dispose(); }
        this.chunks.delete(key);
      }
    }
    outer:
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
      const key = cx + ',' + cz;
      if (this.chunks.has(key)) continue;
      this.chunks.set(key, this.buildChunk(cx, cz));
      if (--budget <= 0) break outer;
    }
    const c0 = Math.floor((pz - 160) / CELL), c1 = Math.floor((pz + 660) / CELL);
    for (const [i, g] of this.cells) {
      if (i < c0 || i > c1) {
        this.scene.remove(g);
        g.traverse((o) => { if (o.userData.own) o.geometry.dispose(); });
        this.cells.delete(i);
      }
    }
    for (let i = Math.max(c0, 1); i <= c1; i++) if (!this.cells.has(i)) this.cells.set(i, this.buildCell(i));
  }

  buildChunk(cx, cz) {
    const N = SEG + 1, M = N + 2, step = CHUNK / SEG;
    const ox = cx * CHUNK, oz = cz * CHUNK;
    const hs = new Float32Array(M * M);
    for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) hs[j * M + i] = baseHeight(ox + (i - 1) * step, oz + (j - 1) * step);
    const pos = new Float32Array(N * N * 3), nor = new Float32Array(N * N * 3), col = new Float32Array(N * N * 3);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = (j * N + i) * 3, m = (j + 1) * M + i + 1;
      const x = ox + i * step, z = oz + j * step;
      pos[k] = x; pos[k + 1] = hs[m]; pos[k + 2] = z;
      let nx = hs[m - 1] - hs[m + 1], ny = 2 * step, nz = hs[m - M] - hs[m + M];
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      nor[k] = nx; nor[k + 1] = ny; nor[k + 2] = nz;
      // snow, with rock showing through on the steepest wall faces
      const wall = Math.abs(x - centerX(z)) - 85;
      let rock = wall > 60 ? smooth((0.83 - ny) / 0.07) * smooth((noise(x / 23, z / 23, 6) + 0.5) / 0.5) : 0;
      rock *= 0.85;
      const shade = 0.93 + 0.07 * noise(x / 45, z / 45, 8);
      col[k] = (0.9 + (0.33 - 0.9) * rock) * shade;
      col[k + 1] = (0.93 + (0.32 - 0.93) * rock) * shade;
      col[k + 2] = (0.99 + (0.36 - 0.99) * rock) * shade;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(this.index);
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.snowMat);
    mesh.receiveShadow = true;
    this.scene.add(mesh);

    // trees on an 8 m jittered grid: none on the open run, glades beside it, forest on the walls
    const list = [];
    const T = 8, per = CHUNK / T;
    for (let j = 0; j < per; j++) for (let i = 0; i < per; i++) {
      const gx = cx * per + i, gz = cz * per + j;
      const x = (gx + 0.15 + 0.7 * hash(gx, gz, 21)) * T, z = (gz + 0.15 + 0.7 * hash(gx, gz, 22)) * T;
      const d = Math.abs(x - centerX(z));
      let p;
      if (d < 32 || d > 330) p = 0;
      else if (d < 85) p = 0.16 * smooth((d - 32) / 25) * (noise(x / 90, z / 90, 23) > -0.1 ? 1 : 0.15);
      else p = 0.55 * (1 - smooth((d - 230) / 100));
      if (z < 30 && d < 70) p = 0;
      if (hash(gx, gz, 24) >= p) continue;
      list.push(x, baseHeight(x, z), z, 0.75 + hash(gx, gz, 25) * 0.9);
    }
    let trees = null;
    if (list.length) {
      trees = new THREE.InstancedMesh(this.treeGeo, this.treeMat, list.length / 4);
      for (let t = 0; t < list.length; t += 4) {
        const s = list[t + 3];
        this._q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, hash(t, cx, cz) * 6.28);
        this._m.compose(this._v.set(list[t], list[t + 1], list[t + 2]), this._q, this._s.set(s, s * (0.9 + 0.3 * hash(t, cz, cx)), s));
        trees.setMatrixAt(t / 4, this._m);
      }
      trees.castShadow = true;
      trees.receiveShadow = true;
      trees.computeBoundingSphere();
      this.scene.add(trees);
    }
    return { cx, cz, mesh, trees, list };
  }

  buildCell(i) {
    const group = new THREE.Group();
    for (const f of cellFeatures(i)) group.add(f.type === 'kicker' ? this.buildKicker(f) : this.buildRail(f));
    this.scene.add(group);
    return group;
  }

  buildKicker(f) {
    const nx = Math.ceil((f.w + 1) * 2), nz = Math.ceil(f.L * 2);
    const x0 = f.x - f.w / 2 - 0.5, dx = (f.w + 1) / nx, dz = f.L / nz;
    const pos = [], col = [], idx = [];
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
      const x = x0 + i * dx, z = f.z + j * dz;
      pos.push(x, height(x, z) + 0.05, z);
      if (j >= nz - 1) col.push(1.0, 0.36, 0.2); else col.push(0.9, 0.93, 0.99);
    }
    const W = nx + 1;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    // back face under the lip
    const base = pos.length / 3, zl = f.z + f.L;
    for (let i = 0; i <= nx; i++) {
      const x = x0 + i * dx;
      pos.push(x, height(x, zl) + 0.05, zl, x, baseHeight(x, zl + 0.4) - 0.3, zl + 0.4);
      col.push(0.62, 0.7, 0.84, 0.62, 0.7, 0.84);
    }
    for (let i = 0; i < nx; i++) {
      const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, c, b, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, this.snowMat);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    mesh.userData.own = true;
    return mesh;
  }

  buildRail(f) {
    const group = new THREE.Group();
    const bar = new THREE.Mesh(this.railGeo, this.railMat);
    bar.position.copy(f.p0).add(f.p1).multiplyScalar(0.5);
    bar.quaternion.setFromUnitVectors(THREE.Object3D.DEFAULT_UP, f.dir);
    bar.scale.y = f.len;
    bar.castShadow = true;
    group.add(bar);
    for (let k = 0; k < 4; k++) {
      const t = 0.04 + (k / 3) * 0.92;
      const p = this._v.copy(f.p0).lerp(f.p1, t);
      const ground = baseHeight(p.x, p.z) - 0.4;
      const post = new THREE.Mesh(this.postGeo, this.postMat);
      post.scale.y = Math.max(p.y - ground, 0.1);
      post.position.set(p.x, (p.y + ground) / 2 - 0.05, p.z);
      post.castShadow = true;
      group.add(post);
    }
    return group;
  }

  // Returns the tree trunk the point is touching, if any, as {x, z}.
  hitTree(x, y, z) {
    for (let k = 0; k < 4; k++) {
      const cx = Math.floor((x + (k & 1 ? 1.2 : -1.2)) / CHUNK), cz = Math.floor((z + (k & 2 ? 1.2 : -1.2)) / CHUNK);
      const c = this.chunks.get(cx + ',' + cz);
      if (!c) continue;
      const l = c.list;
      for (let t = 0; t < l.length; t += 4) {
        const dx = x - l[t], dz = z - l[t + 2], r = 0.3 + 0.3 * l[t + 3];
        if (dx * dx + dz * dz < r * r && y < l[t + 1] + 5.5 * l[t + 3]) return { x: l[t], z: l[t + 2] };
      }
    }
    return null;
  }
}
