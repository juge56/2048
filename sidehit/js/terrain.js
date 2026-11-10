// Turns a map into a rideable hill: height field, feature meshes, trees, ray casting.
import * as THREE from '../vendor/three.module.min.js';

export const KICKER = [{ H: 1.2, L: 7, w: 5 }, { H: 2.2, L: 11, w: 7 }, { H: 3.4, L: 15, w: 9 }, { H: 4.8, L: 19, w: 11 }];
export const ROLLER = [{ H: 0.8, L: 10, w: 8 }, { H: 1.5, L: 16, w: 10 }, { H: 2.4, L: 24, w: 14 }];
const STEP = 3, SIDE = 130, CELL = 8;
const UP = new THREE.Vector3(0, 1, 0);

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

// Centre and pick radius of an object, used by the editor.
export function footprint(o) {
  const sin = Math.sin(o.r || 0), cos = Math.cos(o.r || 0);
  let half = 0, rad = 2.5;
  if (o.t === 'kicker') { half = KICKER[o.s].L / 2; rad = Math.max(half, KICKER[o.s].w / 2); }
  else if (o.t === 'roller') { half = ROLLER[o.s].L / 2; rad = Math.max(half, ROLLER[o.s].w / 2); }
  else if (o.t === 'rail' || o.t === 'box') { half = o.len / 2; rad = Math.max(half, 2.5); }
  return { x: o.x + sin * half, z: o.z + cos * half, rad };
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

  const pts = [[0.26, -0.6], [0.26, 1.0], [2.1, 1.0], [0.8, 3.0], [1.6, 3.0], [0.55, 5.0], [1.05, 5.0], [0.0, 7.0]].map((p) => new THREE.Vector2(p[0], p[1]));
  const tree = new THREE.LatheGeometry(pts, 7).toNonIndexed();
  tree.computeVertexNormals();
  const pos = tree.attributes.position, nor = tree.attributes.normal, col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i += 3) {
    const y = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    const t = y < 1 ? -1 : Math.min(Math.max(nor.getY(i) * 1.9, 0), 1) * 0.85;
    const rgb = t < 0 ? [0.24, 0.15, 0.1] : [0.05 + t * 0.85, 0.2 + t * 0.73, 0.13 + t * 0.85];
    for (let k = 0; k < 3; k++) col.set(rgb, (i + k) * 3);
  }
  tree.setAttribute('color', new THREE.BufferAttribute(col, 3));

  shared = {
    snow: new THREE.MeshLambertMaterial({ vertexColors: true, map: tex, side: THREE.DoubleSide }),
    treeMat: new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }),
    tree,
    rail: new THREE.MeshLambertMaterial({ color: 0xffc928 }),
    box: new THREE.MeshLambertMaterial({ color: 0x19b5ad }),
    boxTop: new THREE.MeshLambertMaterial({ color: 0xeef3f8 }),
    post: new THREE.MeshLambertMaterial({ color: 0x39424e }),
    gate: new THREE.MeshLambertMaterial({ color: 0xff3d7f }),
    railGeo: new THREE.CylinderGeometry(0.07, 0.07, 1, 8),
    unitBox: new THREE.BoxGeometry(1, 1, 1),
  };
  return shared;
}

export class Terrain {
  constructor(map) {
    this.map = map;
    this.a = sharedAssets();
    this.group = new THREE.Group();
    this.objects = new THREE.Group();
    this.group.add(this.objects);
    this.meshOf = new Map();
    this.bumps = [];
    this.rails = [];
    this.forest = [];
    this.buildGround();
    this.compile();
    this.buildObjects();
  }

  // ---- height field ----------------------------------------------------

  base(x, z) {
    const m = this.map, s = m.seed;
    let h = -m.slope * (ramp(z, -4, 12) - ramp(z, m.length - 40, 40));
    if (z < -4) h += (-z - 4) * 0.35;
    h += m.bumps * smooth((z - 10) / 40) * (2.6 * noise(x / 85, z / 85, s) + 0.5 * noise(x / 27, z / 27, s + 1));
    const a = Math.abs(x) - m.width / 2;
    if (a > 0) {
      h += a < 40 ? 0.008 * a * a : 12.8 + 0.64 * (a - 40);
      const w = Math.min(a / 80, 1);
      h += w * w * (14 * noise(x / 110, z / 110, s + 3) + 3 * noise(x / 31, z / 31, s + 4));
    }
    return h;
  }

  // `over` extends kickers slightly past the lip so normals sampled at the lip stay sane.
  height(x, z, over = 0) {
    let h = this.base(x, z);
    const bs = this.bumps;
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i], dx = x - b.x, dz = z - b.z;
      if (dx * dx + dz * dz > b.rad2) continue;
      const v = Math.abs(dx * b.cos - dz * b.sin);
      if (v >= b.hw) continue;
      const t = (dx * b.sin + dz * b.cos) / b.L;
      if (t <= 0) continue;
      const e = v < b.hw - 1.5 ? 1 : 1 - smooth((v - (b.hw - 1.5)) / 1.5);
      if (b.kicker) { if (t <= 1 + over / b.L) h += b.H * t * t * e; }
      else if (t < 1) h += b.H * (0.5 - 0.5 * Math.cos(t * Math.PI * 2)) * e;
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
    for (let t = 2; t < 2500; t += 2) {
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
    for (let i = 0; i < this.forest.length; i += 4) addTree(this.forest[i], this.forest[i + 1], this.forest[i + 2], this.forest[i + 3]);
    for (const o of this.map.objects) {
      if (o.t === 'kicker' || o.t === 'roller') {
        const d = (o.t === 'kicker' ? KICKER : ROLLER)[o.s];
        this.bumps.push({ o, kicker: o.t === 'kicker', x: o.x, z: o.z, sin: Math.sin(o.r), cos: Math.cos(o.r), H: d.H, L: d.L, hw: d.w / 2, rad2: (d.L + 2) ** 2 + (d.w / 2) ** 2 });
      } else if (o.t === 'tree') addTree(o.x, this.base(o.x, o.z), o.z, o.s);
    }
    for (const o of this.map.objects) {
      if (o.t !== 'rail' && o.t !== 'box') continue;
      const x1 = o.x + Math.sin(o.r) * o.len, z1 = o.z + Math.cos(o.r) * o.len;
      const p0 = new THREE.Vector3(o.x, this.height(o.x, o.z) + o.h, o.z);
      const p1 = new THREE.Vector3(x1, this.height(x1, z1) + o.h, z1);
      const dir = p1.clone().sub(p0), len = dir.length();
      this.rails.push({ o, p0, p1, len, dir: dir.divideScalar(len), wide: o.t === 'box' });
    }
  }

  hitTree(x, y, z) {
    for (let k = 0; k < 4; k++) {
      const cell = this.grid.get(Math.floor((x + (k & 1 ? 1.2 : -1.2)) / CELL) + ',' + Math.floor((z + (k & 2 ? 1.2 : -1.2)) / CELL));
      if (!cell) continue;
      for (let t = 0; t < cell.length; t += 4) {
        const dx = x - cell[t], dz = z - cell[t + 2], r = 0.3 + 0.3 * cell[t + 3];
        if (dx * dx + dz * dz < r * r && y < cell[t + 1] + 5.5 * cell[t + 3]) return { x: cell[t], z: cell[t + 2] };
      }
    }
    return null;
  }

  // ---- meshes ----------------------------------------------------------

  buildGround() {
    const m = this.map, a = this.a;
    const x0 = -m.width / 2 - SIDE, z0 = -90;
    const nx = Math.ceil((m.width + 2 * SIDE) / STEP), nz = Math.ceil((m.length + 240) / STEP);
    const W = nx + 1, M = W + 2;
    const hs = new Float32Array(M * (nz + 3));
    for (let j = 0; j < nz + 3; j++) for (let i = 0; i < M; i++) hs[j * M + i] = this.base(x0 + (i - 1) * STEP, z0 + (j - 1) * STEP);
    const count = W * (nz + 1);
    const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), col = new Float32Array(count * 3), uv = new Float32Array(count * 2);
    const idx = new Uint32Array(nx * nz * 6);
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
      const v = j * W + i, k = v * 3, q = (j + 1) * M + i + 1;
      const x = x0 + i * STEP, z = z0 + j * STEP;
      pos[k] = x; pos[k + 1] = hs[q]; pos[k + 2] = z;
      let ax = hs[q - 1] - hs[q + 1], ay = 2 * STEP, az = hs[q - M] - hs[q + M];
      const l = Math.hypot(ax, ay, az);
      nor[k] = ax / l; nor[k + 1] = ay / l; nor[k + 2] = az / l;
      const shade = 0.94 + 0.06 * noise(x / 40, z / 40, m.seed + 8);
      // slightly bluer, unpisted snow outside the park boundary
      const off = smooth((Math.abs(x) - m.width / 2) / 12);
      col[k] = (0.93 - 0.05 * off) * shade; col[k + 1] = (0.95 - 0.03 * off) * shade; col[k + 2] = shade;
      uv[v * 2] = x / 0.45; uv[v * 2 + 1] = z / 6;
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
    this.ground = new THREE.Mesh(g, a.snow);
    this.ground.receiveShadow = true;
    this.group.add(this.ground);

    // forest wrapped around the park
    const f = this.forest, T = 9;
    f.length = 0;
    for (let gz = Math.floor(z0 / T); gz * T < m.length + 150; gz++) for (let gx = Math.floor(x0 / T); gx * T < -x0; gx++) {
      const x = (gx + 0.15 + 0.7 * hash(gx, gz, m.seed + 21)) * T, z = (gz + 0.15 + 0.7 * hash(gx, gz, m.seed + 22)) * T;
      const side = Math.abs(x) - m.width / 2;
      const p = side > 5 ? 0.5 * smooth((side - 5) / 15) : z < -16 || z > m.length + 70 ? 0.4 : 0;
      if (hash(gx, gz, m.seed + 24) < p) f.push(x, this.base(x, z), z, 0.75 + hash(gx, gz, m.seed + 25) * 0.9);
    }
    const inst = new THREE.InstancedMesh(a.tree, a.treeMat, f.length / 4);
    const mat = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3();
    for (let t = 0; t < f.length; t += 4) {
      q.setFromAxisAngle(UP, hash(t, 1, 2) * 6.28);
      mat.compose(v.set(f[t], f[t + 1], f[t + 2]), q, s.set(f[t + 3], f[t + 3] * (0.9 + 0.3 * hash(t, 3, 4)), f[t + 3]));
      inst.setMatrixAt(t / 4, mat);
    }
    inst.castShadow = inst.receiveShadow = true;
    inst.frustumCulled = false;
    this.group.add(inst);
    this.forestMesh = inst;
  }

  buildObjects() {
    for (const m of this.meshOf.values()) this.disposeMesh(m);
    this.meshOf.clear();
    this.objects.clear();
    for (const o of this.map.objects) this.addMesh(o);
    // start gate
    const sp = this.map.spawn, a = this.a, gate = new THREE.Group();
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(a.unitBox, a.gate);
      post.scale.set(0.25, 6.4, 0.25);
      post.position.set(sp.x + s * 5, this.base(sp.x + s * 5, sp.z) + 2.9, sp.z);
      post.castShadow = true;
      gate.add(post);
    }
    const bar = new THREE.Mesh(a.unitBox, a.gate);
    bar.scale.set(10.25, 0.5, 0.25);
    bar.position.set(sp.x, this.base(sp.x, sp.z) + 5.9, sp.z);
    bar.castShadow = true;
    gate.add(bar);
    this.objects.add(gate);
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
      m = new THREE.Mesh(this.a.tree, this.a.treeMat);
      m.position.set(o.x, this.base(o.x, o.z), o.z);
      m.scale.setScalar(o.s);
      m.rotation.y = hash(o.x * 10, o.z * 10, 5) * 6.28;
      m.castShadow = m.receiveShadow = true;
    } else if (o.t === 'rail' || o.t === 'box') m = this.railMesh(this.rails.find((r) => r.o === o));
    else m = this.bumpMesh(this.bumps.find((b) => b.o === o));
    this.meshOf.set(o, m);
    this.objects.add(m);
  }

  bumpMesh(b) {
    const w = b.hw * 2, nx = Math.ceil((w + 1) * 2), nz = Math.ceil(b.L * 2), W = nx + 1;
    const pos = [], col = [], uv = [], idx = [];
    const put = (u, v, lift, r, g, bl, baseOnly) => {
      const x = b.x + u * b.sin + v * b.cos, z = b.z + u * b.cos - v * b.sin;
      pos.push(x, (baseOnly ? this.base(x, z) : this.height(x, z)) + lift, z);
      col.push(r, g, bl);
      uv.push(x / 0.45, z / 6);
    };
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
      const lip = b.kicker && j >= nz - 1;
      put((j / nz) * b.L, -b.hw - 0.5 + (i / nx) * (w + 1), 0.05, lip ? 1 : 0.93, lip ? 0.36 : 0.95, lip ? 0.2 : 1);
    }
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const p = j * W + i, q = p + 1, r = p + W, s = r + 1;
      idx.push(p, r, q, q, r, s);
    }
    if (b.kicker) {
      // back face under the lip
      const start = pos.length / 3;
      for (let i = 0; i <= nx; i++) {
        const v = -b.hw - 0.5 + (i / nx) * (w + 1);
        put(b.L, v, 0.05, 0.62, 0.7, 0.84);
        put(b.L + 0.4, v, -0.3, 0.62, 0.7, 0.84, true);
      }
      for (let i = 0; i < nx; i++) { const p = start + i * 2; idx.push(p, p + 1, p + 2, p + 2, p + 1, p + 3); }
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

  railMesh(r) {
    const a = this.a, group = new THREE.Group(), mid = r.p0.clone().add(r.p1).multiplyScalar(0.5);
    const side = new THREE.Vector3(Math.cos(r.o.r), 0, -Math.sin(r.o.r));
    if (r.wide) {
      const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(side, new THREE.Vector3().crossVectors(r.dir, side), r.dir));
      const body = new THREE.Mesh(a.unitBox, a.box);
      body.scale.set(0.62, 0.3, r.len);
      body.quaternion.copy(q);
      body.position.copy(mid).y -= 0.17;
      const top = new THREE.Mesh(a.unitBox, a.boxTop);
      top.scale.set(0.56, 0.03, r.len - 0.1);
      top.quaternion.copy(q);
      top.position.copy(mid).y -= 0.01;
      body.castShadow = true;
      group.add(body, top);
    } else {
      const bar = new THREE.Mesh(a.railGeo, a.rail);
      bar.position.copy(mid);
      bar.quaternion.setFromUnitVectors(UP, r.dir);
      bar.scale.y = r.len;
      bar.castShadow = true;
      group.add(bar);
    }
    const posts = Math.max(2, Math.round(r.len / 6) + 1), p = new THREE.Vector3();
    for (let k = 0; k < posts; k++) {
      p.copy(r.p0).lerp(r.p1, 0.04 + (k / (posts - 1)) * 0.92);
      const ground = this.base(p.x, p.z) - 0.4, post = new THREE.Mesh(a.unitBox, a.post);
      post.scale.set(r.wide ? 0.4 : 0.1, Math.max(p.y - ground - 0.1, 0.1), 0.1);
      post.position.set(p.x, (p.y - 0.1 + ground) / 2, p.z);
      post.rotation.y = r.o.r;
      post.castShadow = true;
      group.add(post);
    }
    return group;
  }

  disposeMesh(m) { m.traverse((o) => { if (o.userData.own) o.geometry.dispose(); }); }

  dispose() {
    for (const m of this.meshOf.values()) this.disposeMesh(m);
    this.ground.geometry.dispose();
    this.forestMesh.dispose();
    this.group.removeFromParent();
  }
}
