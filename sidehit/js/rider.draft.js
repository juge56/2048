// The rider: an original snowboarder with realistic proportions, built from
// smooth tapered shapes and posed procedurally with two-bone IK.
// Local frame: +z is the nose of the board, +y is up, the rider's chest faces -x.
import * as THREE from '../vendor/three.module.min.js';

const UP = new THREE.Vector3(0, 1, 0);
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));

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
      col.push(...colour(z, i / NX));
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
  constructor() {
    this.root = new THREE.Group();
    this.leanG = new THREE.Group();
    this.pivot = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.leanG);
    this.leanG.add(this.pivot);
    this.pivot.position.y = 0.8;
    this.pivot.add(this.body);
    this.body.position.y = -0.8;

    const mat = (color, roughness = 0.85) => new THREE.MeshStandardMaterial({ color, roughness });
    const shell = mat(0x12a5a0), shellDark = mat(0x0b6f78), pants = mat(0x262b38), glove = mat(0x15171d, 0.6);
    const skin = mat(0xd9a27e), helmet = mat(0xf2f4f7, 0.35), dark = mat(0x1a1d26), boot = mat(0x2d313c, 0.7);
    const lens = new THREE.MeshStandardMaterial({ color: 0xff8a1f, roughness: 0.15, metalness: 0.6, emissive: 0x5a2600 });
    const accent = mat(0xffe14a, 0.6);
    const add = (geo, m, parent = this.body) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };

    // board
    const sheet = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, side: THREE.DoubleSide });
    add(boardGeometry(0, (z, u) => {
      // pink deck with two angled yellow bars toward the nose
      const d = z + (u - 0.5) * 0.22;
      return (d > 0.36 && d < 0.43) || (d > 0.47 && d < 0.5) ? [1, 0.76, 0.07] : [1, 0.05, 0.22];
    }), sheet);
    add(boardGeometry(0.02, () => [0.03, 0.05, 0.12]), sheet);

    // boots and bindings, set in a slight duck stance
    for (const s of [1, -1]) {
      const foot = new THREE.Group();
      foot.position.set(0, 0, s * 0.27);
      foot.rotation.y = s * 0.2;
      this.body.add(foot);
      add(new THREE.BoxGeometry(0.31, 0.025, 0.16), dark, foot).position.set(-0.01, 0.045, 0);
      const sole = add(new THREE.CapsuleGeometry(0.062, 0.15, 4, 10), boot, foot);
      sole.rotation.z = Math.PI / 2;
      sole.position.set(-0.035, 0.115, 0);
      add(new THREE.CylinderGeometry(0.07, 0.066, 0.16, 12), boot, foot).position.set(0.035, 0.2, 0);
      const back = add(new THREE.BoxGeometry(0.022, 0.2, 0.13), dark, foot);
      back.position.set(0.118, 0.17, 0);
      back.rotation.z = -0.16;
      const toe = add(new THREE.BoxGeometry(0.035, 0.012, 0.15), accent, foot);
      toe.position.set(-0.1, 0.168, 0);
      const ankle = add(new THREE.BoxGeometry(0.04, 0.012, 0.16), accent, foot);
      ankle.position.set(-0.03, 0.2, 0);
      ankle.rotation.z = 0.7;
    }

    // tapered limb: radius ra at its start, rb at its end
    const limb = (ra, rb, m) => add(new THREE.CylinderGeometry(rb, ra, 1, 12), m);
    const ball = (r, m) => add(new THREE.SphereGeometry(r, 12, 9), m);
    this.legs = [1, -1].map((s) => ({ s, thigh: limb(0.1, 0.086, pants), shin: limb(0.086, 0.078, pants), knee: ball(0.088, pants) }));
    this.arms = [1, -1].map((s) => ({
      s, upper: limb(0.068, 0.056, shell), lower: limb(0.056, 0.047, shell), shoulder: ball(0.082, shell), elbow: ball(0.057, shell),
      cuff: ball(0.05, shellDark), hand: ball(0.058, glove),
    }));
    // jacket: oval in cross-section, hanging a little below the hips
    this.torso = limb(0.185, 0.2, shell);
    this.torso.scale.set(0.66, 1, 1);
    this.yoke = add(new THREE.SphereGeometry(0.2, 14, 8), shell);
    this.hem = add(new THREE.CylinderGeometry(0.19, 0.195, 0.1, 14), shellDark);
    this.hips = add(new THREE.SphereGeometry(0.17, 12, 8), pants);
    this.hips.scale.set(0.74, 0.72, 1);
    this.hood = add(new THREE.SphereGeometry(0.12, 12, 8), shellDark);
    this.hood.scale.set(0.75, 0.6, 1.25);

    // head: helmet, goggles and a face mask
    this.head = new THREE.Group();
    this.body.add(this.head);
    add(new THREE.CylinderGeometry(0.062, 0.07, 0.12, 10), dark, this.head).position.y = -0.11;
    add(new THREE.SphereGeometry(0.108, 14, 10), skin, this.head);
    add(new THREE.SphereGeometry(0.129, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.6), helmet, this.head).position.y = 0.006;
    const face = Math.PI / 2;
    add(new THREE.SphereGeometry(0.134, 14, 4, face - 0.85, 1.7, 1.22, 0.46), lens, this.head);
    add(new THREE.SphereGeometry(0.113, 14, 5, face - 1.0, 2.0, 1.68, 0.75), dark, this.head);
    const strap = add(new THREE.TorusGeometry(0.128, 0.013, 6, 24), dark, this.head);
    strap.rotation.x = Math.PI / 2;
    strap.position.y = 0.012;
    add(new THREE.BoxGeometry(0.05, 0.012, 0.03), dark, this.head).position.set(0, 0.125, 0.03);

    this.crouch = 0;
    this.grab = 0;
    this.air = 0;
    this.flail = 0;
    this._a = V(); this._b = V(); this._c = V(); this._d = V(); this._e = V(); this._f = V(); this._g = V(); this._h = V();
    this.pose({}, 1);
  }

  // Stretch a unit cylinder from a to b.
  _limb(mesh, a, b) {
    const d = this._e.copy(b).sub(a), len = d.length() || 1e-4;
    mesh.position.copy(a).addScaledVector(d, 0.5);
    mesh.quaternion.setFromUnitVectors(UP, d.divideScalar(len));
    mesh.scale.y = len;
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

  // t: { crouch 0..1, grab '' | 'indy' | 'mute', airborne, bail, time }
  pose(t, dt) {
    const grabbing = !!t.grab;
    this.crouch = damp(this.crouch, grabbing ? 1.25 : t.bail ? 0.5 : (t.crouch || 0), 14, dt);
    this.grab = damp(this.grab, grabbing ? 1 : 0, 14, dt);
    this.air = damp(this.air, t.airborne ? 1 : 0, 8, dt);
    this.flail = damp(this.flail, t.bail ? 1 : 0, 10, dt);
    const c = this.crouch, time = t.time || 0;

    // shoulders open toward the direction of travel, more so when standing tall
    const open = 0.5 - 0.2 * Math.min(c, 1), so = Math.sin(open), co = Math.cos(open);
    const hip = this._a.set(0.05 + 0.13 * c, 0.86 - 0.34 * c, 0);
    const neck = this._b.set(hip.x - 0.1 - 0.3 * c, hip.y + 0.5 - 0.16 * c, 0.03);
    const spine = this._f.copy(neck).sub(hip).normalize();
    this._limb(this.torso, this._g.copy(hip).addScaledVector(spine, -0.07), neck);
    this.torso.rotateY(open * 0.6);
    this.yoke.position.copy(neck);
    this.yoke.quaternion.copy(this.torso.quaternion);
    this.yoke.scale.set(0.66, 0.42, 1);
    this.hem.position.copy(hip).addScaledVector(spine, -0.06);
    this.hem.quaternion.copy(this.torso.quaternion);
    this.hem.scale.set(0.68, 1, 1);
    this.hips.position.copy(hip).y -= 0.03;
    this.hood.position.copy(neck).addScaledVector(spine, 0.02);
    this.hood.position.x += 0.1;
    this.head.position.set(neck.x - 0.03, neck.y + 0.17, neck.z + 0.03);
    this.head.rotation.set(0.12 * c, -0.75, 0);

    const bendKnee = this._c.set(-1, 0.25, 0), h = this._g, f = this._h;
    for (const leg of this.legs) {
      h.set(hip.x, hip.y - 0.02, leg.s * 0.1);
      f.set(0.035, 0.24, leg.s * 0.27);
      bendKnee.z = leg.s * 0.45;
      const k = this._ik(h, f, 0.4, 0.4, bendKnee, leg.knee.position);
      this._limb(leg.thigh, h, k);
      this._limb(leg.shin, k, f);
    }

    const bendElbow = this._c.set(0.5, -0.35, 0), sh = this._g, target = this._h;
    for (const arm of this.arms) {
      const s = arm.s;
      sh.set(neck.x + 0.01 + s * 0.2 * so, neck.y - 0.045, neck.z + s * 0.2 * co);
      // relaxed riding pose: leading hand forward, trailing hand out; wider for balance in the air
      target.set(sh.x - 0.14 + s * 0.04, sh.y - 0.3 + 0.22 * this.air, sh.z + s * (0.2 + 0.16 * this.air));
      if (this.flail > 0.01) {
        target.x += this.flail * 0.3 * Math.sin(time * 17 + s);
        target.y += this.flail * (0.35 + 0.3 * Math.sin(time * 13 + s * 2));
      }
      const g = this.grab * ((t.grab === 'mute') === (s === 1) ? 1 : 0);
      if (g > 0) target.lerp(V(-0.16, 0.06, s * 0.02), g);
      bendElbow.z = s * 0.7;
      const e = this._ik(sh, target, 0.3, 0.29, bendElbow, arm.elbow.position);
      this._limb(arm.upper, sh, e);
      this._limb(arm.lower, e, target);
      arm.shoulder.position.copy(sh);
      arm.hand.position.copy(target);
      arm.cuff.position.copy(target).lerp(e, 0.16);
    }
  }
}
