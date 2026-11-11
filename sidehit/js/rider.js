// The rider. The body is "Low Poly Snowboarder" by gamedevme (CC-BY-4.0, see
// models/snowboarder/license.txt), rigged with a 24-bone humanoid skeleton and
// skin weights through Higgsfield (Meshy rigging). The game drives those bones
// every frame from its riding poses with two-bone IK; the GPU does the skinning.
// The board and bindings are generated.
// Local frame: +z is the nose of the board, +y is up, the rider's chest faces -x.
import * as THREE from '../vendor/three.module.min.js';
import { GLTFLoader } from '../vendor/GLTFLoader.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));
const UP = V(0, 1, 0);

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

// Bones the game drives, by the rig's names. Paired entries are [front foot side (+z), back side].
const NAMES = {
  hips: 'Hips', spine: ['Spine02', 'Spine01', 'Spine'], neck: 'neck', head: 'Head',
  shoulder: ['LeftShoulder', 'RightShoulder'], arm: ['LeftArm', 'RightArm'], fore: ['LeftForeArm', 'RightForeArm'], hand: ['LeftHand', 'RightHand'],
  thigh: ['LeftUpLeg', 'RightUpLeg'], shin: ['LeftLeg', 'RightLeg'], foot: ['LeftFoot', 'RightFoot'],
}

function boardGeometry(drop, colour) {
  const NZ = 28, NX = 4, HALF = 0.8, R = 0.17, pos = [], col = [], idx = [];
  for (let j = 0; j <= NZ; j++) {
    const z = -HALF + (2 * HALF * j) / NZ, az = Math.abs(z);
    const tip = az - (HALF - R);
    const half = tip > 0 ? Math.sqrt(Math.max(R * R - tip * tip, 0)) : 0.152 + 0.018 * (az / (HALF - R)) ** 2;
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
      add(new THREE.BoxGeometry(0.3, 0.025, 0.17), this.m.dark, foot).position.set(-0.02, 0.045, 0);
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
    this.crouchVel = 0;
    this.grab = 0;
    this.air = 0;
    this.flail = 0;
    this.tuck = 0;
    this.edge = 0;
    this.shift = 0;
    this.twist = 0;
    this.spin = 0;
    this.lookTurn = 0;
    this.v = Array.from({ length: 12 }, () => V());
    this.q = Array.from({ length: 4 }, () => new THREE.Quaternion());
    this.style = sanitizeLook(look);
    this.setLook(this.style);
  }

  // Load the rigged model and record its rest pose in the body's frame.
  async load(dir) {
    const [pack, image] = await Promise.all([
      fetch(dir + 'rigged.json').then((r) => r.json()),
      new Promise((ok, fail) => { const im = new Image(); im.onload = () => ok(im); im.onerror = fail; im.src = dir + 'baseColor.webp'; }),
    ]);
    const glb = Uint8Array.from(atob(pack.glbBase64), (ch) => ch.charCodeAt(0)).buffer;
    const gltf = await new Promise((ok, fail) => new GLTFLoader().parse(glb, '', ok, fail));

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

    // the model faces +z with its left side at +x; turn it to face -x, which puts its left foot forward (+z)
    this.model = new THREE.Group();
    this.model.rotation.y = -Math.PI / 2;
    this.model.add(gltf.scene);
    this.body.add(this.model);
    gltf.scene.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      o.material = new THREE.MeshStandardMaterial({ map: this.texture, roughness: 0.7, side: THREE.DoubleSide });
      o.castShadow = true;
      o.frustumCulled = false;
      this.skin = o;
    });
    const find = (name) => gltf.scene.getObjectByName(name);
    const B = (this.bones = {});
    for (const [key, name] of Object.entries(NAMES)) B[key] = Array.isArray(name) ? name.map(find) : find(name);
    this.armature = find('Hips').parent;

    // rest pose, in the body's frame: position, orientation and local rotation of every bone
    this.body.updateWorldMatrix(true, true);
    const toBody = new THREE.Matrix4().copy(this.body.matrixWorld).invert(), m = new THREE.Matrix4(), s = V();
    this.rest = new Map();
    gltf.scene.traverse((o) => {
      if (!o.isBone && o !== this.armature) return;
      m.multiplyMatrices(toBody, o.matrixWorld);
      const pos = V(), quat = new THREE.Quaternion();
      m.decompose(pos, quat, s);
      this.rest.set(o, { pos, quat, local: o.quaternion.clone() });
    });
    const P = (b) => this.rest.get(b).pos;
    this.len = {
      thigh: P(B.thigh[0]).distanceTo(P(B.shin[0])), shin: P(B.shin[0]).distanceTo(P(B.foot[0])),
      upper: P(B.arm[0]).distanceTo(P(B.fore[0])), fore: P(B.fore[0]).distanceTo(P(B.hand[0])),
      spine: P(B.hips).distanceTo(P(B.neck)),
    };
    this.restHip = P(B.hips).clone();
    this.ankleY = (P(B.foot[0]).y + P(B.foot[1]).y) / 2;
    // the armature's own frame in the body, for turning body-space targets into bone-local values
    this.armQuat = this.rest.get(this.armature).quat.clone();
    this.armToBody = new THREE.Matrix4().multiplyMatrices(toBody, this.armature.matrixWorld);
    this.bodyToArm = this.armToBody.clone().invert();
    this.setLook(this.style);
    this.pose({}, 1 / 60);
  }

  setLook(raw) {
    const look = (this.style = sanitizeLook(raw)), C = (hex) => new THREE.Color(hex);
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
    const d = this.v[10].copy(b).sub(a), dist = Math.min(d.length(), l1 + l2 - 1e-3);
    d.normalize();
    const x = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist || 1);
    const h = Math.sqrt(Math.max(l1 * l1 - x * x, 0));
    const perp = this.v[11].copy(bend).addScaledVector(d, -bend.dot(d)).normalize();
    return out.copy(a).addScaledVector(d, x).addScaledVector(perp, h);
  }

  // ---- forward kinematics in body space --------------------------------
  // Each posed bone gets a body-space orientation; its local rotation is that relative to its parent's.
  _set(bone, bodyQuat) {
    const parent = bone.parent, pq = parent === this.armature ? this.armQuat : this.cur.get(parent).quat;
    bone.quaternion.copy(pq).invert().multiply(bodyQuat);
    const r = this.rest.get(bone), c = this.cur.get(bone) || this.cur.set(bone, { quat: new THREE.Quaternion(), pos: V() }).get(bone);
    c.quat.copy(bodyQuat);
    if (parent !== this.armature) {
      // position follows the parent: rest offset carried by the parent's change of orientation
      const pr = this.rest.get(parent), pc = this.cur.get(parent);
      c.pos.copy(r.pos).sub(pr.pos).applyQuaternion(this.q[3].copy(pr.quat).invert()).applyQuaternion(pc.quat).add(pc.pos);
    }
    return c;
  }
  // Keep the bone's rest rotation relative to its (posed) parent.
  _follow(bone) {
    const parent = bone.parent, pr = this.rest.get(parent), pc = this.cur.get(parent), r = this.rest.get(bone);
    return this._set(bone, this.q[2].copy(pc.quat).multiply(this.q[3].copy(pr.quat).invert()).multiply(r.quat));
  }
  // Turn the bone so that, from where it now sits, it points at the target (its child joint lands there).
  _aim(bone, child, target) {
    const r = this.rest.get(bone), parentPose = this._follow(bone), from = parentPose.pos;
    const restDir = this.v[8].copy(this.rest.get(child).pos).sub(r.pos).normalize();
    const curDir = this.v[9].copy(restDir).applyQuaternion(this.q[1].copy(r.quat).invert()).applyQuaternion(parentPose.quat).normalize();
    const want = this.v[10].copy(target).sub(from).normalize();
    return this._set(bone, this.q[0].setFromUnitVectors(curDir, want).multiply(parentPose.quat));
  }

  // t: { crouch 0..1, grab '' | 'indy' | 'mute', airborne, bail, tuck, edge -1..1 (heel..toe), shift -1..1 (tail..nose),
  //      twist -1..1, spin 0..1, look -1..1, time }
  pose(t, dt) {
    if (!this.skin) return;
    const B = this.bones, L = this.len, v = this.v, grabbing = !!t.grab;
    // legs are a spring: they compress on a landing and rebound, instead of sliding to the new height
    const want = grabbing ? 1.25 : t.bail ? 0.5 : (t.crouch || 0), h = Math.min(dt, 1 / 30);
    this.crouchVel += ((want - this.crouch) * 150 - this.crouchVel * 15) * h;
    this.crouch = Math.max(this.crouch + this.crouchVel * h, -0.05);
    this.grab = damp(this.grab, grabbing ? 1 : 0, 14, dt);
    this.air = damp(this.air, t.airborne ? 1 : 0, 8, dt);
    this.flail = damp(this.flail, t.bail ? 1 : 0, 10, dt);
    this.tuck = damp(this.tuck, t.tuck ? 1 : 0, 9, dt);
    this.edge = damp(this.edge, t.edge || 0, 8, dt);
    this.shift = damp(this.shift, t.shift || 0, 9, dt);
    this.twist = damp(this.twist, t.twist || 0, 10, dt);
    this.spin = damp(this.spin, t.spin || 0, 8, dt);
    this.lookTurn = damp(this.lookTurn, t.look || 0, 6, dt);
    const c = this.crouch, k = this.tuck, e = this.edge, air = this.air, w = this.shift, time = t.time || 0;
    this.cur = this.cur || new Map();

    // ---- targets in body space
    // hips sink and sit back as the knees bend; toe edge drives them forward, a press slides them along the board
    const lift = 0.045;   // board and binding height under the boots
    const hip = v[0].set(this.restHip.x + 0.03 + 0.05 * c - 0.07 * e + 0.05 * k, this.restHip.y + lift - 0.05 - 0.3 * c - 0.1 * k, 0.18 * w);
    const fold = 0.12 + 0.3 * Math.min(c, 1.3) + 0.6 * k - 0.07 * e;              // how far the torso leans over the board
    const open = 0.4 + 0.3 * k + 0.6 * this.twist;                                   // shoulders turned toward the nose
    const spineDir = v[1].set(-Math.sin(fold), Math.cos(fold), 0.06 * w);

    // ---- spine and head
    const hips = B.hips, hr = this.rest.get(hips);
    // hips: aim the spine, keep the pelvis square to the board otherwise
    const restSpine = v[2].copy(this.rest.get(B.neck).pos).sub(hr.pos).normalize();
    const hq = this.q[0].setFromUnitVectors(restSpine, spineDir).multiply(hr.quat);
    hips.position.copy(hip).applyMatrix4(this.bodyToArm);
    const hc = this._set(hips, hq);
    hc.pos.copy(hip);
    // chest twist spread over the three spine bones
    for (const bone of B.spine) {
      const pc = this._follow(bone);
      this._set(bone, this.q[1].setFromAxisAngle(spineDir, open / 3).multiply(pc.quat));
    }
    this._follow(B.neck);
    // the head stays level and looks down the hill over the lead shoulder
    const hd = this.rest.get(B.head);
    this._set(B.head, this.q[1].setFromAxisAngle(UP, 0.4 + 0.35 * k + 0.3 * this.twist + 0.75 + 0.35 * this.lookTurn).multiply(this.q[2].setFromAxisAngle(V(0, 0, 1), fold * 0.3)).multiply(hd.quat));

    // ---- legs: hip sockets ride with the pelvis, ankles stay strapped to the board, knees track over the toes
    for (let i = 0; i < 2; i++) {
      const s = i ? -1 : 1, thigh = B.thigh[i];
      const socket = this._follow(thigh).pos;
      const ankle = v[3].set(0.0, this.ankleY + lift, s * 0.26);
      const knee = this._ik(socket, ankle, L.thigh, L.shin, v[4].set(-1, 0.1, s * 0.5), v[5]);
      this._aim(thigh, B.shin[i], knee);
      this._aim(B.shin[i], B.foot[i], ankle);
      // feet stay flat on the board, toes pointing across it, with a slight duck stance
      const fr = this.rest.get(B.foot[i]);
      this._follow(B.foot[i]);
      this._set(B.foot[i], this.q[1].setFromAxisAngle(UP, -s * 0.2).multiply(fr.quat));
    }

    // ---- arms: relaxed at the sides; lifted and spread in the air; pulled in when spinning
    for (let i = 0; i < 2; i++) {
      const s = i ? -1 : 1;
      this._follow(B.shoulder[i]);
      const sh = this._follow(B.arm[i]).pos, hand = v[6];
      hand.set(sh.x - 0.05 - 0.05 * air, sh.y - 0.36 + 0.3 * air, sh.z + s * (0.16 + 0.22 * air));
      hand.y += 0.08 * Math.abs(e); hand.z += s * 0.07 * Math.abs(e);
      if (this.spin > 0.01) hand.lerp(v[7].set(sh.x - 0.2, sh.y - 0.15, sh.z - s * 0.1), 0.75 * this.spin);
      // tuck: lead hand low in front, rear hand tucked behind the back
      if (k > 0.01) hand.lerp(s > 0 ? v[7].set(hip.x - 0.32, hip.y + 0.05, hip.z + 0.14) : v[7].set(hip.x + 0.17, hip.y + 0.12, hip.z - 0.08), k);
      if (this.flail > 0.01) { hand.x += this.flail * 0.3 * Math.sin(time * 17 + s); hand.y += this.flail * (0.4 + 0.3 * Math.sin(time * 13 + s * 2)); }
      const g = this.grab * ((t.grab === 'mute') === (s === 1) ? 1 : 0);
      if (g > 0) hand.lerp(v[7].set(-0.17, 0.09, s * 0.03), g);                                   // reach the toe edge
      else if (this.grab > 0.01) { hand.y += 0.24 * this.grab; hand.z += s * 0.14 * this.grab; }  // free arm up and out
      const elbow = this._ik(sh, hand, L.upper, L.fore, v[4].set(0.9, -0.2, s * 0.5), v[5]);
      this._aim(B.arm[i], B.fore[i], elbow);
      this._aim(B.fore[i], B.hand[i], hand);
      this._follow(B.hand[i]);
    }
  }
}
