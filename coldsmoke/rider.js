// Low-poly snowboarder built from primitives and posed procedurally.
// Local frame: +z is the nose of the board, +y is up, the rider's chest faces -x.
import * as THREE from './vendor/three.module.min.js';

const UP = new THREE.Vector3(0, 1, 0);
const V = () => new THREE.Vector3();
const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));

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

    const mat = (c) => new THREE.MeshLambertMaterial({ color: c });
    const jacket = mat(0x12a5a0), pants = mat(0x2a2f3d), glove = mat(0x1b1d24), skin = mat(0xd9a27e);
    const helmet = mat(0xf2f4f7), lens = new THREE.MeshLambertMaterial({ color: 0xff8a1f, emissive: 0x7a3300 });
    const deck = mat(0xff3d7f), boot = mat(0x14161c);
    const add = (geo, m, parent = this.body) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };

    // board with kicked nose and tail
    add(new THREE.BoxGeometry(0.29, 0.025, 1.2), deck).position.y = 0.012;
    for (const s of [1, -1]) {
      const tip = add(new THREE.BoxGeometry(0.29, 0.025, 0.22), deck);
      tip.position.set(0, 0.05, s * 0.7);
      tip.rotation.x = -s * 0.38;
      add(new THREE.BoxGeometry(0.2, 0.13, 0.13), boot).position.set(-0.01, 0.09, s * 0.27);
    }
    const stripe = add(new THREE.BoxGeometry(0.292, 0.027, 0.1), mat(0xffe14a));
    stripe.position.y = 0.012;

    const limb = (r, m) => add(new THREE.CylinderGeometry(r, r, 1, 7), m);
    const joint = (r, m) => add(new THREE.SphereGeometry(r, 8, 6), m);
    this.legs = [1, -1].map((s) => ({ s, thigh: limb(0.075, pants), shin: limb(0.065, pants), knee: joint(0.075, pants) }));
    this.arms = [1, -1].map((s) => ({ s, upper: limb(0.055, jacket), lower: limb(0.05, jacket), elbow: joint(0.055, jacket), hand: joint(0.06, glove), pos: V() }));
    this.torso = add(new THREE.BoxGeometry(0.24, 1, 0.4), jacket);
    this.hips = add(new THREE.BoxGeometry(0.23, 0.18, 0.34), pants);

    this.head = new THREE.Group();
    this.body.add(this.head);
    add(new THREE.SphereGeometry(0.115, 10, 8), skin, this.head);
    add(new THREE.SphereGeometry(0.135, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.58), helmet, this.head).position.y = 0.01;
    add(new THREE.BoxGeometry(0.2, 0.065, 0.07), lens, this.head).position.set(0, 0.025, 0.09);

    this.crouch = 0;
    this.grab = 0;
    this.air = 0;
    this.flail = 0;
    this._a = V(); this._b = V(); this._c = V(); this._d = V(); this._e = V();
    this.pose({}, 1);
  }

  // Stretch a unit cylinder between two points.
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

    const hip = this._a.set(0.05 + 0.12 * c, 0.82 - 0.32 * c, 0);
    const neck = this._b.set(hip.x - 0.12 - 0.3 * c, hip.y + 0.5 - 0.16 * c, 0.02);
    this._limb(this.torso, hip, neck);
    this.hips.position.copy(hip);
    this.head.position.set(neck.x - 0.02, neck.y + 0.16, neck.z + 0.03);
    this.head.rotation.set(0.1 * c, -0.55, 0);

    const bendKnee = this._c.set(-1, 0.2, 0);
    for (const leg of this.legs) {
      const h = V().set(hip.x, hip.y, leg.s * 0.1), f = V().set(0, 0.15, leg.s * 0.27);
      bendKnee.z = leg.s * 0.35;
      const k = this._ik(h, f, 0.4, 0.4, bendKnee, leg.knee.position);
      this._limb(leg.thigh, h, k);
      this._limb(leg.shin, k, f);
    }

    const bendElbow = this._c.set(0.4, -0.3, 0);
    for (const arm of this.arms) {
      const s = arm.s;
      const sh = V().set(neck.x + 0.02, neck.y - 0.05, s * 0.2);
      // relaxed riding pose, spread wider for balance in the air
      const target = V().set(sh.x - 0.12, sh.y - 0.28 + 0.2 * this.air, s * (0.42 + 0.14 * this.air));
      if (this.flail > 0.01) {
        target.x += this.flail * 0.3 * Math.sin(time * 17 + s);
        target.y += this.flail * (0.35 + 0.3 * Math.sin(time * 13 + s * 2));
      }
      const g = this.grab * ((t.grab === 'mute') === (s === 1) ? 1 : 0);
      if (g > 0) target.lerp(V().set(-0.17, 0.07, s * 0.02), g);
      arm.pos.copy(target);
      bendElbow.z = s * 0.6;
      const e = this._ik(sh, target, 0.3, 0.3, bendElbow, arm.elbow.position);
      this._limb(arm.upper, sh, e);
      this._limb(arm.lower, e, target);
      arm.hand.position.copy(target);
    }
  }
}
