// The rider: an original snowboarder whose jacket, sleeves and pants are one
// continuous mesh that bends at the joints, driven by a small skeleton that is
// posed procedurally with two-bone IK. Colours and kit come from a "look".
// Local frame: +z is the nose of the board, +y is up, the rider's chest faces -x.
import * as THREE from '../vendor/three.module.min.js';

const UP = new THREE.Vector3(0, 1, 0);
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));

export const LOOK_OPTIONS = {
  jacket: ['#12a5a0', '#ff3d7f', '#ffc928', '#2f6fe0', '#f2f4f7', '#1c1f28', '#8be04e', '#ff7a1a', '#8a4fd8'],
  jacket2: ['#0b6f78', '#1c1f28', '#f2f4f7', '#ff3d7f', '#ffc928', '#2f6fe0', '#ff7a1a'],
  style: ['two-tone', 'solid', 'stripe'],
  pants: ['#262b38', '#f2f4f7', '#6b4a2e', '#3d5a80', '#7a1f3d', '#ffc928', '#4a5d3a'],
  headwear: ['helmet', 'beanie'],
  helmet: ['#f2f4f7', '#1c1f28', '#ff3d7f', '#ffc928', '#12a5a0', '#2f6fe0'],
  lens: ['#ff8a1f', '#22c7e8', '#b44dff', '#f2f4f7', '#3ddc84'],
  gloves: ['#15171d', '#f2f4f7', '#ff3d7f', '#ffc928'],
  skin: ['#f1c9a5', '#d9a27e', '#b97a50', '#8a5a3a', '#5c3a24'],
  build: ['regular', 'slim', 'broad'],
  board: ['#ff0d38', '#12a5a0', '#ffc928', '#1c1f28', '#f2f4f7', '#2f6fe0', '#8be04e'],
  board2: ['#ffc212', '#f2f4f7', '#1c1f28', '#ff3d7f', '#22c7e8'],
  boardArt: ['bars', 'split', 'solid'],
};
export const DEFAULT_LOOK = Object.fromEntries(Object.entries(LOOK_OPTIONS).map(([k, v]) => [k, v[0]]));
// Keep only known keys with allowed values, so a stored or shared look can't inject anything odd.
export function sanitizeLook(raw) {
  const out = { ...DEFAULT_LOOK };
  if (raw && typeof raw === 'object') for (const k in LOOK_OPTIONS) if (LOOK_OPTIONS[k].includes(raw[k])) out[k] = raw[k];
  return out;
}

// radius profiles along each tube, as [position 0..1, width, depth]
const TORSO = [[0, 0.205, 0.15], [0.2, 0.2, 0.146], [0.55, 0.215, 0.156], [0.84, 0.2, 0.14], [0.94, 0.13, 0.11], [1, 0.085, 0.085]];
const ARM = [[0, 0.086, 0.086], [0.15, 0.076, 0.076], [0.5, 0.064, 0.064], [0.9, 0.055, 0.055], [1, 0.06, 0.06]];
const LEG = [[0, 0.116, 0.116], [0.25, 0.106, 0.106], [0.5, 0.096, 0.096], [0.85, 0.09, 0.09], [1, 0.1, 0.1]];
const RINGS = 10, SIDES = 10, TUBES = 5, PER = RINGS * SIDES;
function profile(table, u, out) {
  let i = 1;
  while (i < table.length - 1 && table[i][0] < u) i++;
  const a = table[i - 1], b = table[i], t = (u - a[0]) / (b[0] - a[0]);
  out[0] = a[1] + (b[1] - a[1]) * t;
  out[1] = a[2] + (b[2] - a[2]) * t;
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

    const mat = (roughness = 0.85, extra) => new THREE.MeshStandardMaterial({ roughness, ...extra });
    this.m = {
      cloth: mat(0.85, { vertexColors: true }), sheet: mat(0.45, { vertexColors: true, side: THREE.DoubleSide }),
      trim: mat(), glove: mat(0.6), skin: mat(), helmet: mat(0.35), dark: mat(0.85, { color: 0x1a1d26 }), boot: mat(0.7, { color: 0x2d313c }),
      lens: mat(0.15, { metalness: 0.6 }), accent: mat(0.6),
    };
    const m = this.m;
    const add = (geo, material, parent = this.body) => {
      const mesh = new THREE.Mesh(geo, material);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };

    // clothing: torso, two arms, two legs as tubes in one geometry
    const count = TUBES * PER + 1, idx = [];
    this.pos = new Float32Array(count * 3);
    this.nor = new Float32Array(count * 3);
    this.col = new Float32Array(count * 3);
    for (let t = 0; t < TUBES; t++) for (let r = 0; r < RINGS - 1; r++) for (let s = 0; s < SIDES; s++) {
      const a = t * PER + r * SIDES + s, b = t * PER + r * SIDES + ((s + 1) % SIDES), c = a + SIDES, d = b + SIDES;
      idx.push(a, b, c, c, b, d);
    }
    for (let s = 0; s < SIDES; s++) idx.push(count - 1, (s + 1) % SIDES, s);   // close the jacket hem
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    geo.setIndex(idx);
    this.cloth = add(geo, m.cloth);
    this.cloth.frustumCulled = false;

    this.deck = add(new THREE.BufferGeometry(), m.sheet);
    this.base = add(boardGeometry(0.02, () => ({ r: 0.03, g: 0.05, b: 0.12 })), m.sheet);

    // boots and bindings, set in a slight duck stance
    for (const s of [1, -1]) {
      const foot = new THREE.Group();
      foot.position.set(0, 0, s * 0.27);
      foot.rotation.y = s * 0.2;
      this.body.add(foot);
      add(new THREE.BoxGeometry(0.31, 0.025, 0.16), m.dark, foot).position.set(-0.01, 0.045, 0);
      const sole = add(new THREE.CapsuleGeometry(0.062, 0.15, 4, 10), m.boot, foot);
      sole.rotation.z = Math.PI / 2;
      sole.position.set(-0.035, 0.115, 0);
      add(new THREE.CylinderGeometry(0.07, 0.066, 0.16, 12), m.boot, foot).position.set(0.035, 0.2, 0);
      const back = add(new THREE.BoxGeometry(0.022, 0.2, 0.13), m.dark, foot);
      back.position.set(0.118, 0.17, 0);
      back.rotation.z = -0.16;
      add(new THREE.BoxGeometry(0.035, 0.012, 0.15), m.accent, foot).position.set(-0.1, 0.168, 0);
      const strap = add(new THREE.BoxGeometry(0.04, 0.012, 0.16), m.accent, foot);
      strap.position.set(-0.03, 0.2, 0);
      strap.rotation.z = 0.7;
    }

    this.hands = [1, -1].map(() => add(new THREE.SphereGeometry(0.06, 10, 8), m.glove));
    this.hood = add(new THREE.SphereGeometry(0.12, 12, 8), m.trim);
    this.hood.scale.set(0.75, 0.6, 1.25);

    // head: face, mask, goggles, and a helmet or a beanie
    this.head = new THREE.Group();
    this.body.add(this.head);
    const face = Math.PI / 2;
    add(new THREE.CylinderGeometry(0.062, 0.07, 0.12, 10), m.dark, this.head).position.y = -0.11;
    add(new THREE.SphereGeometry(0.108, 14, 10), m.skin, this.head);
    add(new THREE.SphereGeometry(0.134, 14, 4, face - 0.85, 1.7, 1.22, 0.46), m.lens, this.head);
    add(new THREE.SphereGeometry(0.113, 14, 5, face - 1.0, 2.0, 1.68, 0.75), m.dark, this.head);
    const strap = add(new THREE.TorusGeometry(0.128, 0.013, 6, 24), m.dark, this.head);
    strap.rotation.x = Math.PI / 2;
    strap.position.y = 0.012;
    this.helmet = add(new THREE.SphereGeometry(0.129, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.6), m.helmet, this.head);
    this.helmet.position.y = 0.006;
    this.beanie = new THREE.Group();
    this.head.add(this.beanie);
    add(new THREE.SphereGeometry(0.122, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), m.helmet, this.beanie).scale.y = 1.25;
    add(new THREE.CylinderGeometry(0.126, 0.126, 0.045, 14), m.trim, this.beanie).position.y = 0.015;
    add(new THREE.SphereGeometry(0.035, 8, 6), m.trim, this.beanie).position.y = 0.165;

    this.crouch = 0;
    this.grab = 0;
    this.air = 0;
    this.flail = 0;
    this.j = { hem: V(), mid: V(), neck: V(), hip: V(), sh: [V(), V()], elbow: [V(), V()], hand: [V(), V()], leg: [V(), V()], knee: [V(), V()], ankle: [V(), V()] };
    this._c = V(); this._d = V(); this._e = V(); this._p = V(); this._q = V(); this._t = V(); this._a1 = V(); this._a2 = V(); this._side = V();
    this._rad = [0, 0];
    this.setLook(look);
    this.pose({}, 1);
  }

  setLook(raw) {
    const look = (this.look = sanitizeLook(raw)), m = this.m, C = (hex) => new THREE.Color(hex);
    this.girth = look.build === 'slim' ? 0.9 : look.build === 'broad' ? 1.13 : 1;
    m.trim.color.set(look.jacket2);
    m.glove.color.set(look.gloves);
    m.skin.color.set(look.skin);
    m.helmet.color.set(look.helmet);
    m.lens.color.set(look.lens);
    m.lens.emissive.set(look.lens).multiplyScalar(0.3);
    m.accent.color.set(look.board2);
    this.helmet.visible = look.headwear === 'helmet';
    this.beanie.visible = look.headwear === 'beanie';
    // clothing colours, painted per ring
    const jacket = C(look.jacket), second = C(look.jacket2), pants = C(look.pants), col = this.col;
    for (let t = 0; t < TUBES; t++) for (let r = 0; r < RINGS; r++) {
      const u = r / (RINGS - 1);
      let c = t >= 3 ? pants : jacket;
      if (t === 0 && look.style === 'two-tone' && u < 0.4) c = second;
      if (t === 0 && look.style === 'stripe' && u > 0.5 && u < 0.68) c = second;
      if (t > 0 && t < 3 && look.style !== 'solid' && (u > 0.93 || (look.style === 'stripe' && u > 0.3 && u < 0.45))) c = second;
      for (let s = 0; s < SIDES; s++) col.set([c.r, c.g, c.b], (t * PER + r * SIDES + s) * 3);
    }
    const hemColour = look.style === 'two-tone' ? second : jacket;
    col.set([hemColour.r, hemColour.g, hemColour.b], TUBES * PER * 3);
    this.cloth.geometry.attributes.color.needsUpdate = true;
    // board top sheet
    const main = C(look.board), art = C(look.board2);
    this.deck.geometry.dispose();
    this.deck.geometry = boardGeometry(0, (z, u) => {
      if (look.boardArt === 'split') return z > 0 ? art : main;
      if (look.boardArt === 'bars') { const d = z + (u - 0.5) * 0.22; return (d > 0.36 && d < 0.43) || (d > 0.47 && d < 0.5) ? art : main; }
      return main;
    });
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

  // Point on the path a -> b -> c, with the corner at b rounded off.
  _chain(a, b, c, u, out) {
    const w = 0.17;
    if (Math.abs(u - 0.5) >= w) return u < 0.5 ? out.lerpVectors(a, b, u * 2) : out.lerpVectors(b, c, (u - 0.5) * 2);
    const t = (u - (0.5 - w)) / (2 * w), p0 = this._p.lerpVectors(a, b, 1 - 2 * w), p2 = this._q.lerpVectors(b, c, 2 * w);
    return out.copy(p0).multiplyScalar((1 - t) * (1 - t)).addScaledVector(b, 2 * (1 - t) * t).addScaledVector(p2, t * t);
  }

  // Write one tube of the clothing mesh along a -> b -> c.
  _tube(index, a, b, c, side, table) {
    const pos = this.pos, nor = this.nor, centre = this._c, tan = this._t, a1 = this._a1, a2 = this._a2, rad = this._rad, g = this.girth;
    for (let r = 0; r < RINGS; r++) {
      const u = r / (RINGS - 1);
      this._chain(a, b, c, Math.min(u + 0.02, 1), tan).sub(this._chain(a, b, c, Math.max(u - 0.02, 0), centre)).normalize();
      this._chain(a, b, c, u, centre);
      a1.copy(side).addScaledVector(tan, -side.dot(tan)).normalize();
      a2.crossVectors(tan, a1);
      profile(table, u, rad);
      const w = rad[0] * g, d = rad[1] * g;
      for (let s = 0; s < SIDES; s++) {
        const ang = (s / SIDES) * Math.PI * 2, cs = Math.cos(ang), sn = Math.sin(ang), k = (index * PER + r * SIDES + s) * 3;
        pos[k] = centre.x + a1.x * cs * w + a2.x * sn * d;
        pos[k + 1] = centre.y + a1.y * cs * w + a2.y * sn * d;
        pos[k + 2] = centre.z + a1.z * cs * w + a2.z * sn * d;
        // normal of an ellipse
        const nx = a1.x * cs * d + a2.x * sn * w, ny = a1.y * cs * d + a2.y * sn * w, nz = a1.z * cs * d + a2.z * sn * w, l = Math.hypot(nx, ny, nz) || 1;
        nor[k] = nx / l; nor[k + 1] = ny / l; nor[k + 2] = nz / l;
      }
    }
  }

  // t: { crouch 0..1, grab '' | 'indy' | 'mute', airborne, bail, time }
  pose(t, dt) {
    const grabbing = !!t.grab, j = this.j;
    this.crouch = damp(this.crouch, grabbing ? 1.25 : t.bail ? 0.5 : (t.crouch || 0), 14, dt);
    this.grab = damp(this.grab, grabbing ? 1 : 0, 14, dt);
    this.air = damp(this.air, t.airborne ? 1 : 0, 8, dt);
    this.flail = damp(this.flail, t.bail ? 1 : 0, 10, dt);
    const c = this.crouch, time = t.time || 0;

    // shoulders open toward the direction of travel, more so when standing tall
    const open = 0.5 - 0.2 * Math.min(c, 1), so = Math.sin(open), co = Math.cos(open);
    const hip = j.hip.set(0.05 + 0.13 * c, 0.86 - 0.34 * c, 0);
    const neck = j.neck.set(hip.x - 0.1 - 0.3 * c, hip.y + 0.5 - 0.16 * c, 0.03);
    const spine = this._side.copy(neck).sub(hip).normalize();
    j.hem.copy(hip).addScaledVector(spine, -0.1);
    j.mid.lerpVectors(hip, neck, 0.5);
    j.mid.x += 0.035 + 0.03 * c;               // a rounded back
    this.hood.position.copy(neck).addScaledVector(spine, 0.01);
    this.hood.position.x += 0.1;
    this.head.position.set(neck.x - 0.03, neck.y + 0.17, neck.z + 0.03);
    this.head.rotation.set(0.12 * c, -0.75, 0);

    const bendKnee = this._c.set(-1, 0.25, 0);
    for (let i = 0; i < 2; i++) {
      const s = i ? -1 : 1;
      j.leg[i].set(hip.x, hip.y - 0.02, s * 0.1);
      j.ankle[i].set(0.035, 0.26, s * 0.27);
      bendKnee.set(-1, 0.25, s * 0.45);
      this._ik(j.leg[i], j.ankle[i], 0.4, 0.4, bendKnee, j.knee[i]);
    }
    const bendElbow = this._c;
    for (let i = 0; i < 2; i++) {
      const s = i ? -1 : 1, sh = j.sh[i], hand = j.hand[i];
      sh.set(neck.x + 0.01 + s * 0.19 * so, neck.y - 0.05, neck.z + s * 0.19 * co);
      // relaxed riding pose: hands low and out; wider for balance in the air
      hand.set(sh.x - 0.14 + s * 0.04, sh.y - 0.3 + 0.22 * this.air, sh.z + s * (0.2 + 0.16 * this.air));
      if (this.flail > 0.01) {
        hand.x += this.flail * 0.3 * Math.sin(time * 17 + s);
        hand.y += this.flail * (0.35 + 0.3 * Math.sin(time * 13 + s * 2));
      }
      const g = this.grab * ((t.grab === 'mute') === (s === 1) ? 1 : 0);
      if (g > 0) hand.lerp(this._p.set(-0.16, 0.06, s * 0.02), g);
      bendElbow.set(0.5, -0.35, s * 0.7);
      this._ik(sh, hand, 0.3, 0.29, bendElbow, j.elbow[i]);
      this.hands[i].position.copy(hand);
    }

    // skin the clothing to the skeleton
    this._tube(0, j.hem, j.mid, j.neck, this._side.set(so * 0.6, 0, 1).normalize(), TORSO);
    for (let i = 0; i < 2; i++) {
      this._tube(1 + i, j.sh[i], j.elbow[i], j.hand[i], UP, ARM);
      this._tube(3 + i, j.leg[i], j.knee[i], j.ankle[i], this._side.set(1, 0, 0), LEG);
    }
    this.pos.set([j.hem.x, j.hem.y, j.hem.z], TUBES * PER * 3);
    this.nor.set([0, -1, 0], TUBES * PER * 3);
    this.cloth.geometry.attributes.position.needsUpdate = true;
    this.cloth.geometry.attributes.normal.needsUpdate = true;
  }
}
