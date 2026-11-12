// The rider: a snowboarder with realistic proportions built from rounded shapes (helmet and goggles,
// hooded shell jacket that hangs over the hips, baggy pants, gloves) and posed every frame with two-bone IK. No model file is needed.
// Local frame: +z is the nose of the board, +y is up, the rider's chest faces -x.
import * as THREE from '../vendor/three.module.min.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));
const UP = V(0, 1, 0);

export const LOOK_OPTIONS = {
  jacket: ['#7fae98', '#a8324a', '#e8a13a', '#4d7fb3', '#12a5a0', '#ff3d7f', '#8a4fd8', '#d8dde6', '#2a2f3d'],
  jacket2: ['#5a6068', '#3d7d63', '#f07a2a', '#ffe14a', '#22c7e8', '#f2f4f7', '#1c1f28', '#ff3d7f'],
  pants: ['#4a4c54', '#2a2d36', '#6b6f78', '#8a6a4a', '#3d5a80', '#d8dde6', '#4a5d3a', '#7a1f3d'],
  helmet: ['#f2f4f7', '#1c1f28', '#4d7fb3', '#ff3d7f', '#ffc928', '#12a5a0'],
  lens: ['amber', 'blue', 'violet', 'silver', 'green'],
  board: ['#ff0d38', '#12a5a0', '#ffc928', '#1c1f28', '#f2f4f7', '#2f6fe0', '#8be04e'],
  board2: ['#ffc212', '#f2f4f7', '#1c1f28', '#ff3d7f', '#22c7e8'],
  boardArt: ['ridgeline', 'wolf', 'slash', 'bars', 'split', 'solid'],
};
export const DEFAULT_LOOK = Object.fromEntries(Object.entries(LOOK_OPTIONS).map(([k, v]) => [k, v[0]]));
// Keep only known keys with allowed values, so a stored look can't inject anything odd.
export function sanitizeLook(raw) {
  const out = { ...DEFAULT_LOOK };
  if (raw && typeof raw === 'object') for (const k in LOOK_OPTIONS) if (LOOK_OPTIONS[k].includes(raw[k])) out[k] = raw[k];
  return out;
}
const LENS = { amber: [0xffa21f, 0xb03a10], blue: [0x3cc8ff, 0x1b3cff], violet: [0xd36bff, 0x2b1a8a], silver: [0xe8eef7, 0x55606f], green: [0x6dff9a, 0x0f6b5a] };

// Grab poses, modelled on reference photos: hips over the board and low so the knees come to the chest,
// a long back leaning over the knees, the grabbing arm straight to the edge, the free arm high.
//   hand 1 = front, -1 = rear; at = where the hand takes the board; lean = forward lean of the back;
//   free = free hand relative to its shoulder; tilt = [pitch, roll, yaw] of rider and board when held
const GRAB_POSE = {
  indy: { hand: -1, at: [-0.15, 0.11, -0.05], lean: 0.75, free: [0.02, 0.42, 0.34], tilt: [0.05, -0.35, 0.25] },
  mute: { hand: 1, at: [-0.15, 0.11, 0.07], lean: 0.78, free: [0.06, 0.42, -0.34], tilt: [0, -0.35, -0.25] },
  method: { hand: 1, at: [0.17, 0.13, 0.08], lean: 0.32, free: [0.1, 0.55, -0.12], tilt: [0.25, 0.8, -0.3] },
  stalefish: { hand: -1, at: [0.18, 0.12, -0.17], lean: 0.5, free: [0, 0.48, 0.3], tilt: [-0.1, 0.45, 0.3] },
  melon: { hand: 1, at: [0.17, 0.12, 0.06], lean: 0.55, free: [0.04, 0.45, -0.3], tilt: [0.1, 0.4, -0.2] },
  japan: { hand: 1, at: [-0.15, 0.12, 0.15], lean: 0.85, free: [0.06, 0.4, -0.32], tilt: [-0.35, -0.5, -0.15] },
  nose: { hand: 1, at: [-0.04, 0.14, 0.5], lean: 0.9, free: [0.05, 0.42, -0.34], tilt: [-0.35, -0.1, 0] },
  tail: { hand: -1, at: [0.04, 0.14, -0.5], lean: 0.85, free: [0.04, 0.42, 0.34], tilt: [0.35, 0.1, 0] },
  roastbeef: { hand: -1, at: [0.16, 0.1, 0.0], lean: 0.6, free: [0.03, 0.45, 0.3], tilt: [0.05, 0.4, 0.2] },
};

const LEN = { thigh: 0.43, shin: 0.41, upper: 0.29, fore: 0.27, spine: 0.5 };

// Deck and base as thin shaped sheets: rounded tips, sidecut, kicked nose and tail.
function boardGeometry(drop, colour) {
  const NZ = 28, NX = 4, HALF = 0.8, R = 0.17, pos = [], col = [], idx = [], uv = [];
  for (let j = 0; j <= NZ; j++) {
    const z = -HALF + (2 * HALF * j) / NZ, az = Math.abs(z);
    const tip = az - (HALF - R);
    const half = tip > 0 ? Math.sqrt(Math.max(R * R - tip * tip, 0)) : 0.152 + 0.018 * (az / (HALF - R)) ** 2;
    const lift = az > 0.5 ? ((az - 0.5) / 0.27) ** 2 * 0.08 : 0;
    for (let i = 0; i <= NX; i++) {
      pos.push(-half + (2 * half * i) / NX, 0.03 + lift - drop, z);
      const c = colour(z, i / NX);
      col.push(c.r, c.g, c.b);
      uv.push((z + HALF) / (2 * HALF), i / NX);
    }
  }
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    const a = j * (NX + 1) + i, b = a + 1, c = a + NX + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
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
    const m = (this.m = {
      jacket: mat(0.85), trim: mat(0.85), pants: mat(0.9), helmet: mat(0.3), mitt: mat(0.8, { color: 0x1d1f26 }), boot: mat(0.7, { color: 0x3a3d47 }),
      skin: mat(0.8, { color: 0xe0ab85 }), dark: mat(0.85, { color: 0x1a1d26 }), accent: mat(0.6),
      sheet: mat(0.45, { vertexColors: true, side: THREE.DoubleSide }), deck: mat(0.4, { vertexColors: true, side: THREE.DoubleSide }),
    });
    const add = (geo, material, parent = this.body) => {
      const mesh = new THREE.Mesh(geo, material);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };
    const ball = new THREE.SphereGeometry(1, 20, 14);
    const tube = (rEnd, rStart) => new THREE.CylinderGeometry(rEnd, rStart, 1, 16);   // stretched from its start joint to its end joint

    // board: painted graphics or two-colour designs on top, dark base underneath
    this.art = {};
    for (const [key, file] of [['ridgeline', 'board1'], ['slash', 'board2'], ['wolf', 'board3']]) {
      const t = new THREE.TextureLoader().load('textures/' + file + '.webp');
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      this.art[key] = t;
    }
    this.deck = add(new THREE.BufferGeometry(), m.deck);
    add(boardGeometry(0.02, () => ({ r: 0.03, g: 0.05, b: 0.12 })), m.sheet);

    // boots and bindings, in a slight duck stance
    for (const s of [1, -1]) {
      const foot = new THREE.Group();
      foot.position.set(0, 0, s * 0.26);
      foot.rotation.y = s * 0.2;
      this.body.add(foot);
      add(new THREE.BoxGeometry(0.3, 0.025, 0.18), m.dark, foot).position.set(-0.02, 0.045, 0);
      const shoe = add(ball, m.boot, foot);
      shoe.scale.set(0.18, 0.085, 0.105);
      shoe.position.set(-0.035, 0.13, 0);
      add(new THREE.CylinderGeometry(0.105, 0.1, 0.16, 14), m.boot, foot).position.set(0.03, 0.2, 0);
      const back = add(new THREE.BoxGeometry(0.025, 0.2, 0.15), m.dark, foot);
      back.position.set(0.125, 0.17, 0);
      back.rotation.z = -0.14;
      for (const [x, y, tilt] of [[-0.12, 0.15, 0.1], [-0.03, 0.21, 0.7]]) {
        const strap = add(new THREE.BoxGeometry(0.045, 0.016, 0.215), m.accent, foot);
        strap.position.set(x, y, 0);
        strap.rotation.z = tilt;
      }
    }

    // body parts, placed every frame by pose()
    this.p = {
      hips: add(ball, m.pants), belly: add(ball, m.jacket), chest: add(ball, m.jacket), hem: add(new THREE.CylinderGeometry(1, 1.06, 1, 20), m.jacket), hood: add(ball, m.jacket),
      thigh: [0, 1].map(() => add(tube(0.103, 0.116), m.pants)), shin: [0, 1].map(() => add(tube(0.124, 0.103), m.pants)), knee: [0, 1].map(() => add(ball, m.pants)),
      upper: [0, 1].map(() => add(tube(0.072, 0.086), m.jacket)), fore: [0, 1].map(() => add(tube(0.076, 0.072), m.jacket)),
      shoulder: [0, 1].map(() => add(ball, m.jacket)), elbow: [0, 1].map(() => add(ball, m.jacket)), cuff: [0, 1].map(() => add(ball, m.trim)), mitt: [0, 1].map(() => add(ball, m.mitt)),
    };
    for (const k of this.p.knee) k.scale.setScalar(0.107);
    for (const k of this.p.shoulder) k.scale.setScalar(0.093);
    for (const k of this.p.elbow) k.scale.setScalar(0.075);
    for (const k of this.p.cuff) k.scale.setScalar(0.08);
    for (const k of this.p.mitt) k.scale.set(0.062, 0.078, 0.056);

    // head: big round helmet, wrap-around goggles, a bit of face, a neck gaiter
    const head = (this.head = new THREE.Group());
    this.body.add(head);
    head.scale.setScalar(0.8);
    add(ball, m.skin, head).scale.setScalar(0.158);
    const gaiter = add(new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, Math.PI * 0.6, Math.PI * 0.4), m.dark, head);
    gaiter.scale.setScalar(0.164);
    add(new THREE.CylinderGeometry(0.1, 0.12, 0.12, 14), m.dark, head).position.y = -0.17;
    const shell = add(new THREE.SphereGeometry(1, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.6), m.helmet, head);
    shell.scale.set(0.196, 0.19, 0.19);
    shell.position.set(0.012, 0.012, 0);
    const lensTex = (() => {
      const c = document.createElement('canvas'); c.width = 4; c.height = 64;
      const g = c.getContext('2d'), grd = g.createLinearGradient(0, 0, 0, 64);
      grd.addColorStop(0, '#fff'); grd.addColorStop(0.45, '#c8c8c8'); grd.addColorStop(1, '#5a5a5a');
      g.fillStyle = grd; g.fillRect(0, 0, 4, 64);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    })();
    m.lens = mat(0.1, { map: lensTex, emissiveMap: lensTex, emissiveIntensity: 0.55, metalness: 0.35, side: THREE.DoubleSide });
    const band = (r, h, start, len, material, y) => {
      const b = add(new THREE.CylinderGeometry(1, 1, 1, 28, 1, true, start, len), material, head);
      b.scale.set(r, h, r * 0.97);
      b.position.y = y;
      material.side = THREE.DoubleSide;
    };
    const arc = 2.25, face = -Math.PI / 2;   // cylinder angle 0 points to +z; the face is toward -x
    band(0.186, 0.088, face - arc / 2, arc, m.lens, 0.012);
    band(0.191, 0.018, face - arc / 2 - 0.07, arc + 0.14, m.dark, 0.06);
    band(0.191, 0.018, face - arc / 2 - 0.07, arc + 0.14, m.dark, -0.036);
    band(0.2, 0.05, face + arc / 2, Math.PI * 2 - arc, m.dark, 0.012);

    Object.assign(this, { crouch: 0, crouchVel: 0, grab: 0, air: 0, flail: 0, tuck: 0, edge: 0, shift: 0, twist: 0, spin: 0, lookTurn: 0, tweakAmt: 0, headYaw: 1.1, grabKey: 'indy' });
    this.v = Array.from({ length: 16 }, () => V());
    this.mx = new THREE.Matrix4();
    this.hp = [null, null];
    this.setLook(look);
    this.pose({}, 1 / 60);
  }

  // Kept for callers that wait for the rider to be ready; nothing needs loading any more.
  async load() {}

  setLook(raw) {
    const look = (this.style = sanitizeLook(raw)), m = this.m, C = (hex) => new THREE.Color(hex);
    m.jacket.color.set(look.jacket);
    m.trim.color.set(look.jacket2);
    m.pants.color.set(look.pants);
    m.helmet.color.set(look.helmet);
    m.accent.color.set(look.jacket2);
    m.lens.color.setHex(LENS[look.lens][0]);
    m.lens.emissive.setHex(LENS[look.lens][1]);
    const main = C(look.board), second = C(look.board2), art = this.art[look.boardArt] || null;
    m.deck.map = art;
    m.deck.needsUpdate = true;
    this.deck.geometry.dispose();
    this.deck.geometry = art ? boardGeometry(0, () => ({ r: 1, g: 1, b: 1 })) : boardGeometry(0, (z, u) => {
      if (look.boardArt === 'split') return z > 0 ? second : main;
      if (look.boardArt === 'bars') { const d = z + (u - 0.5) * 0.22; return (d > 0.36 && d < 0.43) || (d > 0.47 && d < 0.5) ? second : main; }
      return main;
    });
  }

  // Two-bone IK: place the middle joint so both bones keep their length.
  _ik(a, b, l1, l2, bend, out) {
    const d = this.v[14].copy(b).sub(a), dist = Math.min(d.length(), l1 + l2 - 1e-3);
    d.normalize();
    const x = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist || 1);
    const h = Math.sqrt(Math.max(l1 * l1 - x * x, 0));
    const perp = this.v[15].copy(bend).addScaledVector(d, -bend.dot(d)).normalize();
    return out.copy(a).addScaledVector(d, x).addScaledVector(perp, h);
  }
  // Stretch a unit tube from joint a to joint b.
  _limb(mesh, a, b) {
    const d = this.v[14].copy(b).sub(a), len = d.length() || 1e-4;
    mesh.position.copy(a).addScaledVector(d, 0.5);
    mesh.quaternion.setFromUnitVectors(UP, d.divideScalar(len));
    mesh.scale.y = len;
  }
  // Place a rounded torso part: centred at c, long axis along `along`, widest across `across`.
  _blob(mesh, c, along, across, depth, length, width) {
    const x = this.v[15].crossVectors(along, across).normalize();
    mesh.quaternion.setFromRotationMatrix(this.mx.makeBasis(x, along, across));
    mesh.position.copy(c);
    mesh.scale.set(depth, length, width);
  }

  // t: { crouch 0..1, grab '' | name, grabHold, airborne, bail, tuck, pitch, edge -1..1 (heel..toe),
  //      shift -1..1 (tail..nose), twist -1..1, spin 0..1, look -1..1, time }
  pose(t, dt) {
    const v = this.v, P = this.p, grabbing = !!t.grab;
    // legs are a spring: they compress on a landing and rebound
    const want = grabbing ? 0.4 : t.bail ? 0.5 : (t.crouch || 0), h = Math.min(dt, 1 / 30);
    this.crouchVel += ((want - this.crouch) * 150 - this.crouchVel * 15) * h;
    this.crouch = Math.max(this.crouch + this.crouchVel * h, -0.05);
    if (grabbing) this.grabKey = t.grab;
    this.tweakAmt = damp(this.tweakAmt, grabbing ? Math.min(0.45 + (t.grabHold || 0) * 1.2, 1) : 0, 7, dt);
    this.grab = damp(this.grab, grabbing ? 1 : 0, 11, dt);
    this.air = damp(this.air, t.airborne ? 1 : 0, 8, dt);
    this.flail = damp(this.flail, t.bail ? 1 : 0, 10, dt);
    this.tuck = damp(this.tuck, t.tuck ? 1 : 0, 9, dt);
    this.edge = damp(this.edge, t.edge || 0, 8, dt);
    this.shift = damp(this.shift, t.shift || 0, 9, dt);
    this.twist = damp(this.twist, t.twist || 0, 10, dt);
    this.spin = damp(this.spin, t.spin || 0, 8, dt);
    this.lookTurn = damp(this.lookTurn, t.look || 0, 6, dt);
    const c = Math.min(this.crouch, 1.2), k = this.tuck, e = this.edge, air = this.air, w = this.shift, time = t.time || 0;
    const gp = GRAB_POSE[this.grabKey] || GRAB_POSE.indy, gr = this.grab, tw = gp.tilt, a = this.tweakAmt;
    this.body.rotation.set((t.pitch || 0) + tw[0] * a, tw[2] * a, tw[1] * a);

    // ---- stance: hips over the board, sinking as the knees bend; a long back that leans from the hips
    const hip = v[0].set(0.01 - 0.12 * e + 0.02 * k, 0.99 - 0.3 * c - 0.14 * k - 0.42 * gr, 0.16 * w);
    const riding = 0.08 + 0.2 * c + 0.5 * k + 0.24 * Math.max(-e, 0) - 0.05 * Math.max(e, 0);
    const lean = riding + (gp.lean - riding) * gr;
    const open = 0.4 + 0.3 * k + 0.6 * this.twist - 0.25 * gr;   // shoulders turned toward the nose
    const low = v[1].set(-Math.sin(lean * 0.6), Math.cos(lean * 0.6), 0), high = v[2].set(-Math.sin(lean * 1.25), Math.cos(lean * 1.25), 0);
    const mid = v[3].copy(hip).addScaledVector(low, LEN.spine * 0.5), neck = v[4].copy(mid).addScaledVector(high, LEN.spine * 0.5);
    const across0 = v[5].set(Math.sin(open * 0.4), 0, Math.cos(open * 0.4)), across = v[6].set(Math.sin(open), 0, Math.cos(open));
    across0.addScaledVector(low, -across0.dot(low)).normalize();
    across.addScaledVector(high, -across.dot(high)).normalize();
    this._blob(P.hips, hip, low, across0, 0.15, 0.15, 0.185);
    this._blob(P.hem, v[7].copy(hip).addScaledVector(low, 0.03), low, across0, 0.172, 0.2, 0.212);
    this._blob(P.belly, v[7].copy(hip).addScaledVector(low, 0.17), low, across0, 0.168, 0.22, 0.208);
    this._blob(P.chest, v[7].copy(mid).addScaledVector(high, 0.11), high, across, 0.172, 0.21, 0.232);
    const backDir = v[8].crossVectors(high, across);   // out of the rider's back
    this._blob(P.hood, v[7].copy(neck).addScaledVector(backDir, 0.11).addScaledVector(high, -0.02), high, across, 0.085, 0.1, 0.145);

    // head: stays fairly level and looks down the hill over the lead shoulder
    this.headYaw = damp(this.headYaw, open + 0.55 + 0.28 * this.lookTurn, 6, dt);
    this.head.position.copy(neck).addScaledVector(high, 0.08).addScaledVector(UP, 0.085);
    this.head.rotation.set(0, this.headYaw, lean * 0.3, 'YXZ');

    // ---- legs: knees track out over the toes
    for (let i = 0; i < 2; i++) {
      const s = i ? -1 : 1;
      const socket = v[9].copy(hip).addScaledVector(across0, s * 0.095).addScaledVector(low, -0.03);
      const ankle = v[10].set(0.02, 0.27, s * 0.26);
      const knee = this._ik(socket, ankle, LEN.thigh, LEN.shin, v[11].set(-1, 0.1, s * 0.5), v[12]);
      this._limb(P.thigh[i], socket, knee);
      this._limb(P.shin[i], knee, ankle);
      P.knee[i].position.copy(knee);
    }

    // ---- arms: relaxed at the sides; lifted and spread in the air; pulled in when spinning
    for (let i = 0; i < 2; i++) {
      const s = i ? -1 : 1;
      const sh = v[9].copy(neck).addScaledVector(across, s * 0.2).addScaledVector(high, -0.07), hand = v[10];
      hand.set(sh.x - 0.07 - 0.05 * air, sh.y - 0.44 + 0.36 * air, sh.z + s * (0.13 + 0.24 * air));
      hand.y += 0.1 * Math.abs(e); hand.z += s * 0.08 * Math.abs(e);
      if (this.spin > 0.01) hand.lerp(v[11].set(sh.x - 0.2, sh.y - 0.15, sh.z - s * 0.1), 0.75 * this.spin);
      if (k > 0.01) hand.lerp(s > 0 ? v[11].set(hip.x - 0.3, hip.y + 0.06, hip.z + 0.14) : v[11].set(hip.x + 0.2, hip.y + 0.1, hip.z - 0.08), k);
      if (this.flail > 0.01) { hand.x += this.flail * 0.3 * Math.sin(time * 17 + s); hand.y += this.flail * (0.4 + 0.3 * Math.sin(time * 13 + s * 2)); }
      if (gr > 0.01) {
        if (gp.hand === s) hand.lerp(v[11].set(gp.at[0], gp.at[1], gp.at[2]), gr);
        else hand.lerp(v[11].set(sh.x + gp.free[0], sh.y + gp.free[1], sh.z + gp.free[2]), gr);
      }
      // hands glide to their targets instead of jumping there
      const hp = this.hp[i] || (this.hp[i] = hand.clone());
      hp.lerp(hand, 1 - Math.exp(-(gr > 0.5 && gp.hand === s ? 24 : 14) * dt));
      hand.copy(hp);
      const elbow = this._ik(sh, hand, LEN.upper, LEN.fore, v[11].set(0.6, -0.75, s * 0.55), v[12]);
      this._limb(P.upper[i], sh, elbow);
      this._limb(P.fore[i], elbow, hand);
      P.shoulder[i].position.copy(sh);
      P.elbow[i].position.copy(elbow);
      P.cuff[i].position.copy(hand).lerp(elbow, 0.1);
      P.mitt[i].position.copy(hand).addScaledVector(v[13].copy(hand).sub(elbow).normalize(), 0.05);
    }
  }
}
