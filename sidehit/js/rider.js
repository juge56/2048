// The rider. The body is "Low Poly Snowboarder" by gamedevme (CC-BY-4.0, see
// models/snowboarder/license.txt). That model ships as a fixed T-pose with no
// skeleton, so it is rigged here: every vertex is bound to one or two bones of
// a small skeleton, and the skeleton is posed each frame with two-bone IK.
// The board and bindings are generated.
// Local frame: +z is the nose of the board, +y is up, the rider's chest faces -x.
import * as THREE from '../vendor/three.module.min.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export const LOOK_OPTIONS = {
  jacket: ['#4d7fb3', '#12a5a0', '#ff3d7f', '#ffc928', '#8be04e', '#8a4fd8', '#d8dde6', '#2a2f3d', '#c0392b'],
  jacket2: ['#f07a2a', '#ffe14a', '#ff3d7f', '#22c7e8', '#f2f4f7', '#1c1f28', '#8be04e'],
  board: ['#ff0d38', '#12a5a0', '#ffc928', '#1c1f28', '#f2f4f7', '#2f6fe0', '#8be04e'],
  board2: ['#ffc212', '#f2f4f7', '#1c1f28', '#ff3d7f', '#22c7e8'],
  boardArt: ['bars', 'split', 'solid'],
};
export const DEFAULT_LOOK = Object.fromEntries(Object.entries(LOOK_OPTIONS).map(([k, v]) => [k, v[0]]));
// Keep only known keys with allowed values, so a stored look can't inject anything odd.
export function sanitizeLook(raw) {
  const out = { ...DEFAULT_LOOK };
  if (raw && typeof raw === 'object') for (const k in LOOK_OPTIONS) if (LOOK_OPTIONS[k].includes(raw[k])) out[k] = raw[k];
  return out;
}

// ---- skeleton -------------------------------------------------------------
// Bones, and where their joints sit in the model's T-pose (local frame, metres).
const PELVIS = 0, CHEST = 1, HEAD = 2, UPPER = 3, FORE = 5, THIGH = 7, SHIN = 9, FOOT = 11, BONES = 13;   // paired bones: +0 front side (+z), +1 back side
const REST = {
  hip: V(0, 0.92, 0), neck: V(0, 1.46, 0),
  shoulder: (s) => V(0, 1.38, s * 0.19), elbow: (s) => V(0, 1.34, s * 0.47), wrist: (s) => V(0, 1.31, s * 0.75),
  leg: (s) => V(0, 0.9, s * 0.1), knee: (s) => V(0, 0.5, s * 0.15), ankle: (s) => V(0, 0.12, s * 0.18),
};
const LEN = { spine: 0.54, upper: 0.28, fore: 0.28, thigh: 0.4, shin: 0.38 };

// Which bones a T-pose vertex follows: [bone, other bone, weight of the first].
function bind(x, y, z) {
  const az = Math.abs(z), side = z >= 0 ? 0 : 1;
  if (y > 1.13 && az > 0.165) {
    if (az < 0.265) return [UPPER + side, CHEST, smooth((az - 0.165) / 0.1)];
    return [FORE + side, UPPER + side, smooth((az - 0.41) / 0.12)];
  }
  if (y > 1.4) return [HEAD, CHEST, smooth((y - 1.42) / 0.08)];
  if (y > 0.98) return [CHEST, PELVIS, smooth((y - 1.0) / 0.2)];
  if (y > 0.82) return [THIGH + side, PELVIS, smooth((0.98 - y) / 0.16)];
  if (y > 0.43) return [SHIN + side, THIGH + side, smooth((0.57 - y) / 0.14)];
  return [FOOT + side, SHIN + side, smooth((0.2 - y) / 0.08)];
}

// Deck and base as two thin shaped sheets: rounded tips, sidecut, kicked nose and tail.
function boardGeometry(drop, colour) {
  const NZ = 28, NX = 4, HALF = 0.77, R = 0.145, pos = [], col = [], idx = [];
  for (let j = 0; j <= NZ; j++) {
    const z = -HALF + (2 * HALF * j) / NZ, az = Math.abs(z);
    const tip = az - (HALF - R);
    const half = tip > 0 ? Math.sqrt(Math.max(R * R - tip * tip, 0)) : 0.126 + 0.019 * (az / (HALF - R)) ** 2;
    const lift = az > 0.5 ? ((az - 0.5) / 0.27) ** 2 * 0.08 : 0;
    for (let i = 0; i <= NX; i++) {
      pos.push(-half + (2 * half * i) / NX, 0.03 + lift - drop, z);
      const c = colour(z, i / NX);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    const a = j * (NX + 1) + i, b = a + 1, c = a + NX + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export class Rider {
  constructor(look) {
    this.root = new THREE.Group();
    this.leanG = new THREE.Group();
    this.pivot = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.leanG);
    this.leanG.add(this.pivot);
    this.pivot.position.y = 0.8;
    this.pivot.add(this.body);
    this.body.position.y = -0.8;

    const mat = (roughness, extra) => new THREE.MeshStandardMaterial({ roughness, ...extra });
    this.m = { sheet: mat(0.45, { vertexColors: true, side: THREE.DoubleSide }), dark: mat(0.85, { color: 0x1a1d26 }), accent: mat(0.6) };
    const add = (geo, material, parent = this.body) => {
      const mesh = new THREE.Mesh(geo, material);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };
    this.deck = add(new THREE.BufferGeometry(), this.m.sheet);
    this.base = add(boardGeometry(0.02, () => ({ r: 0.03, g: 0.05, b: 0.12 })), this.m.sheet);
    // bindings in a slight duck stance; the boots are part of the model
    for (const s of [1, -1]) {
      const foot = new THREE.Group();
      foot.position.set(0, 0, s * 0.27);
      foot.rotation.y = s * 0.2;
      this.body.add(foot);
      add(new THREE.BoxGeometry(0.33, 0.025, 0.17), this.m.dark, foot).position.set(-0.02, 0.045, 0);
      const back = add(new THREE.BoxGeometry(0.022, 0.21, 0.14), this.m.dark, foot);
      back.position.set(0.115, 0.16, 0);
      back.rotation.z = -0.14;
      for (const [x, y, tilt] of [[-0.12, 0.13, 0], [-0.03, 0.19, 0.7]]) {
        const strap = add(new THREE.BoxGeometry(0.04, 0.014, 0.19), this.m.accent, foot);
        strap.position.set(x, y, 0);
        strap.rotation.z = tilt;
      }
    }

    this.crouch = 0;
    this.grab = 0;
    this.air = 0;
    this.flail = 0;
    this.j = { hip: V(), neck: V(), sh: [V(), V()], elbow: [V(), V()], hand: [V(), V()], leg: [V(), V()], knee: [V(), V()], ankle: [V(), V()] };
    // per bone: rest origin, current origin, current rotation
    this.rest = [];
    this.at = [];
    this.rot = [];
    for (let i = 0; i < BONES; i++) { this.rest.push(V()); this.at.push(V()); this.rot.push(new THREE.Quaternion()); }
    this.rest[PELVIS].copy(REST.hip); this.rest[CHEST].copy(REST.hip); this.rest[HEAD].copy(REST.neck);
    [1, -1].forEach((s, i) => {
      this.rest[UPPER + i].copy(REST.shoulder(s)); this.rest[FORE + i].copy(REST.elbow(s));
      this.rest[THIGH + i].copy(REST.leg(s)); this.rest[SHIN + i].copy(REST.knee(s)); this.rest[FOOT + i].copy(REST.ankle(s));
    });
    this._c = V(); this._d = V(); this._e = V(); this._p = V(); this._q = V(); this._u = V(); this._w = V();
    this._qa = new THREE.Quaternion(); this._qb = new THREE.Quaternion();
    this.look = sanitizeLook(look);
    this.setLook(this.look);
  }

  // Fetch the model and bind it to the skeleton. Resolves when the rider can be drawn.
  async load(dir) {
    const [gltf, bin, image] = await Promise.all([
      fetch(dir + 'scene.gltf').then((r) => r.json()),
      fetch(dir + 'scene.bin').then((r) => r.arrayBuffer()),
      new Promise((ok, fail) => { const im = new Image(); im.onload = () => ok(im); im.onerror = fail; im.src = dir + 'baseColor.webp'; }),
    ]);
    const read = (i) => {
      const a = gltf.accessors[i], view = gltf.bufferViews[a.bufferView], n = { VEC3: 3, VEC2: 2, SCALAR: 1 }[a.type];
      const start = (view.byteOffset || 0) + (a.byteOffset || 0), stride = view.byteStride || n * 4;
      const out = a.componentType === 5126 ? new Float32Array(a.count * n) : new Uint32Array(a.count * n), data = new DataView(bin);
      for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) {
        out[k * n + c] = a.componentType === 5126 ? data.getFloat32(start + k * stride + c * 4, true) : data.getUint32(start + k * stride + c * 4, true);
      }
      return out;
    };
    // merge the model's meshes, turning it to stand across the board: model (x, y, z-up) -> local (y, z, x)
    const P = [], N = [], UV = [], I = [];
    for (const mesh of gltf.meshes) for (const prim of mesh.primitives) {
      const p = read(prim.attributes.POSITION), nm = read(prim.attributes.NORMAL), uv = read(prim.attributes.TEXCOORD_0), ix = read(prim.indices), base = P.length / 3;
      for (let k = 0; k < p.length; k += 3) { P.push(p[k + 1], p[k + 2], p[k]); N.push(nm[k + 1], nm[k + 2], nm[k]); }
      for (const v of uv) UV.push(v);
      for (const v of ix) I.push(base + v);
    }
    const count = P.length / 3;
    this.p0 = new Float32Array(P);
    this.n0 = new Float32Array(N);
    this.bones = new Uint8Array(count * 2);
    this.weight = new Float32Array(count);
    for (let k = 0; k < count; k++) {
      const [a, b, w] = bind(P[k * 3], P[k * 3 + 1], P[k * 3 + 2]);
      this.bones[k * 2] = a; this.bones[k * 2 + 1] = b; this.weight[k] = w;
    }
    this.pos = new Float32Array(count * 3);
    this.nor = new Float32Array(count * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
    geo.setIndex(I);

    // the suit colours are changed by repainting the model's texture
    const size = 1024, canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    this.paint = canvas.getContext('2d', { willReadFrequently: true });
    this.paint.drawImage(image, 0, 0, size, size);
    this.original = this.paint.getImageData(0, 0, size, size);
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.flipY = false;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.skin = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: this.texture, roughness: 0.7, side: THREE.DoubleSide }));
    this.skin.castShadow = true;
    this.skin.frustumCulled = false;
    this.body.add(this.skin);
    this.setLook(this.look);
    this.pose({}, 1);
  }

  setLook(raw) {
    const look = (this.look = sanitizeLook(raw)), C = (hex) => new THREE.Color(hex);
    this.m.accent.color.set(look.jacket2);
    const main = C(look.board), art = C(look.board2);
    this.deck.geometry.dispose();
    this.deck.geometry = boardGeometry(0, (z, u) => {
      if (look.boardArt === 'split') return z > 0 ? art : main;
      if (look.boardArt === 'bars') { const d = z + (u - 0.5) * 0.22; return (d > 0.36 && d < 0.43) || (d > 0.47 && d < 0.5) ? art : main; }
      return main;
    });
    if (!this.original) return;
    // the model's suit is blue with orange trim: swap those two families of colour, keeping the shading
    const src = this.original.data, out = this.paint.createImageData(this.original.width, this.original.height), dst = out.data;
    const suit = C(look.jacket).convertLinearToSRGB(), trim = C(look.jacket2).convertLinearToSRGB();
    for (let k = 0; k < src.length; k += 4) {
      const r = src[k], g = src[k + 1], b = src[k + 2], hi = Math.max(r, g, b), lo = Math.min(r, g, b), sat = hi ? (hi - lo) / hi : 0;
      let to = null, shade = 1;
      if (b > r * 1.12 && b >= g && sat > 0.16) { to = suit; shade = hi / 165; }
      else if (r > g * 1.2 && g > b * 1.15 && sat > 0.4) { to = trim; shade = hi / 235; }
      if (to) { dst[k] = Math.min(to.r * 255 * shade, 255); dst[k + 1] = Math.min(to.g * 255 * shade, 255); dst[k + 2] = Math.min(to.b * 255 * shade, 255); }
      else { dst[k] = r; dst[k + 1] = g; dst[k + 2] = b; }
      dst[k + 3] = 255;
    }
    this.paint.putImageData(out, 0, 0);
    this.texture.needsUpdate = true;
  }

  // Two-bone IK: place the middle joint so both bones keep their length.
  _ik(a, b, l1, l2, bend, out) {
    const d = this._e.copy(b).sub(a), dist = Math.min(d.length(), l1 + l2 - 1e-3);
    d.normalize();
    const x = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist || 1);
    const h = Math.sqrt(Math.max(l1 * l1 - x * x, 0));
    const perp = this._d.copy(bend).addScaledVector(d, -bend.dot(d)).normalize();
    return out.copy(a).addScaledVector(d, x).addScaledVector(perp, h);
  }

  // Aim a bone: it starts at `from` and points at `to`; in the T-pose it pointed along `restDir`.
  _aim(bone, from, to, restDir) {
    this.at[bone].copy(from);
    this.rot[bone].setFromUnitVectors(restDir, this._u.copy(to).sub(from).normalize());
  }

  // t: { crouch 0..1, grab '' | 'indy' | 'mute', airborne, bail, time }
  pose(t, dt) {
    if (!this.skin) return;
    const grabbing = !!t.grab, j = this.j, at = this.at, rot = this.rot;
    this.crouch = damp(this.crouch, grabbing ? 1.25 : t.bail ? 0.5 : (t.crouch || 0), 14, dt);
    this.grab = damp(this.grab, grabbing ? 1 : 0, 14, dt);
    this.air = damp(this.air, t.airborne ? 1 : 0, 8, dt);
    this.flail = damp(this.flail, t.bail ? 1 : 0, 10, dt);
    const c = this.crouch, time = t.time || 0;

    // spine: hips sink and move back as the rider crouches, the chest folds forward over the board
    const hip = j.hip.set(0.04 + 0.14 * c, 0.84 - 0.36 * c, 0);
    const fold = 0.2 + 0.55 * Math.min(c, 1.3);
    const neck = j.neck.set(hip.x - Math.sin(fold) * LEN.spine, hip.y + Math.cos(fold) * LEN.spine, 0);
    const up = this._w.set(0, 1, 0);
    this._aim(PELVIS, hip, neck, up);
    // shoulders open toward the direction of travel, more so when standing tall
    const open = 0.55 - 0.25 * Math.min(c, 1);
    this._qa.setFromAxisAngle(up, open);
    at[CHEST].copy(hip);
    rot[CHEST].copy(rot[PELVIS]).multiply(this._qa);
    // the head stays level and looks down the hill
    at[HEAD].copy(neck);
    rot[HEAD].setFromAxisAngle(up, open + 0.7).premultiply(this._qb.setFromAxisAngle(this._p.set(0, 0, 1), fold * 0.35));

    const bend = this._c, down = this._q.set(0, -1, 0);
    for (let i = 0; i < 2; i++) {
      const s = i ? -1 : 1, side = this._p.set(0, 0, s);
      // legs: hip sockets ride with the pelvis, ankles stay strapped to the board
      j.leg[i].copy(REST.leg(s)).sub(REST.hip).applyQuaternion(rot[PELVIS]).add(hip);
      j.ankle[i].set(0.01, 0.165, s * 0.27);
      this._ik(j.leg[i], j.ankle[i], LEN.thigh, LEN.shin, bend.set(-1, 0.25, s * 0.5), j.knee[i]);
      this._aim(THIGH + i, j.leg[i], j.knee[i], down);
      this._aim(SHIN + i, j.knee[i], j.ankle[i], down);
      at[FOOT + i].copy(j.ankle[i]);
      rot[FOOT + i].setFromAxisAngle(up, s * 0.2);

      // arms: shoulders ride with the chest
      const sh = j.sh[i].copy(REST.shoulder(s)).sub(REST.hip).applyQuaternion(rot[CHEST]).add(hip), hand = j.hand[i];
      hand.set(sh.x - 0.1 + s * 0.05, sh.y - 0.36 + 0.26 * this.air, sh.z + s * (0.16 + 0.2 * this.air));
      if (this.flail > 0.01) {
        hand.x += this.flail * 0.3 * Math.sin(time * 17 + s);
        hand.y += this.flail * (0.4 + 0.3 * Math.sin(time * 13 + s * 2));
      }
      const g = this.grab * ((t.grab === 'mute') === (s === 1) ? 1 : 0);
      if (g > 0) hand.lerp(this._e.set(-0.17, 0.07, s * 0.03), g);
      this._ik(sh, hand, LEN.upper, LEN.fore, bend.set(0.5, -0.35, s * 0.7), j.elbow[i]);
      this._aim(UPPER + i, sh, j.elbow[i], side);
      this._aim(FORE + i, j.elbow[i], hand, side);
    }

    // skin: each vertex follows its two bones
    const p0 = this.p0, n0 = this.n0, pos = this.pos, nor = this.nor, bones = this.bones, weight = this.weight, rest = this.rest, a = this._u, b = this._e, na = this._c, nb = this._d;
    for (let k = 0, n = weight.length; k < n; k++) {
      const i = k * 3, b0 = bones[k * 2], b1 = bones[k * 2 + 1], w = weight[k];
      a.set(p0[i], p0[i + 1], p0[i + 2]).sub(rest[b0]).applyQuaternion(rot[b0]).add(at[b0]);
      na.set(n0[i], n0[i + 1], n0[i + 2]).applyQuaternion(rot[b0]);
      if (w < 0.999) {
        b.set(p0[i], p0[i + 1], p0[i + 2]).sub(rest[b1]).applyQuaternion(rot[b1]).add(at[b1]);
        nb.set(n0[i], n0[i + 1], n0[i + 2]).applyQuaternion(rot[b1]);
        a.lerp(b, 1 - w);
        na.lerp(nb, 1 - w).normalize();
      }
      pos[i] = a.x; pos[i + 1] = a.y; pos[i + 2] = a.z;
      nor[i] = na.x; nor[i + 1] = na.y; nor[i + 2] = na.z;
    }
    this.skin.geometry.attributes.position.needsUpdate = true;
    this.skin.geometry.attributes.normal.needsUpdate = true;
  }
}
