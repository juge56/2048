// Rider physics and the trick / combo system. No rendering in here.
import * as THREE from '../vendor/three.module.min.js';

const G = 9.81, TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = (a) => a - TAU * Math.round(a / TAU);
const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));

const n = new THREE.Vector3(), f0 = new THREE.Vector3(), tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();

export function airTricks(a) {
  const list = [];
  const halves = Math.round(Math.abs(a.spin) / Math.PI);
  if (halves >= 1) list.push({ name: (a.spin > 0 ? 'FS ' : 'BS ') + halves * 180, pts: 50 * halves * (halves + 1) });
  const flips = Math.round(Math.abs(a.flip) / TAU);
  if (flips >= 1) list.push({ name: ['', '', 'Double ', 'Triple '][Math.min(flips, 3)] + (a.flip > 0 ? 'Frontflip' : 'Backflip'), pts: 400 * flips * (flips + 1) });
  if (a.grab > 0.25) list.push({ name: a.grabName === 'mute' ? 'Mute' : 'Indy', pts: Math.round(150 + 350 * a.grab) });
  if (a.time > 1.1) list.push({ name: 'Big Air', pts: Math.round(a.time * 120) });
  return list;
}

export class Player {
  // hooks: { flash(text, kind), puff(pos, vx, vy, vz, spread), sound, banked(total) }
  constructor(hooks) {
    this.hooks = hooks;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.f3 = new THREE.Vector3(0, 0, 1);
    this.s3 = new THREE.Vector3(1, 0, 0);
    this.combo = [];
    this.score = 0;
    this.spawn = { x: 0, z: 6, yaw: 0 };
    this.terrain = null;
    this.clear();
  }

  clear() {
    Object.assign(this, {
      yaw: 0, yawRate: 0, spinVel: 0, flip: 0, flipVel: 0, grounded: true, charge: 0, jumpHeld: false,
      carve: 0, braking: false, tuck: false, air: null, rail: null, railT: 0, railV: 0, railCd: 0, railItem: null,
      bail: 0, tumble: 0, comboTimer: 0, time: 0,
    });
    this.combo.length = 0;
  }

  setTerrain(terrain) {
    this.terrain = terrain;
    this.spawn = { x: terrain.map.spawn.x, z: terrain.map.spawn.z, yaw: 0 };
    this.score = 0;
    this.respawn();
  }

  respawn() {
    this.clear();
    const s = this.spawn;
    this.pos.set(s.x, this.terrain.height(s.x, s.z), s.z);
    this.yaw = s.yaw;
    this.vel.set(Math.sin(s.yaw) * 2.5, 0, Math.cos(s.yaw) * 2.5);
  }

  setSpawnHere() {
    this.spawn = { x: this.pos.x, z: this.pos.z, yaw: this.yaw };
  }

  get state() { return this.bail > 0 ? 'bail' : this.rail ? 'rail' : this.grounded ? 'ground' : 'air'; }
  comboPoints() { return this.combo.reduce((s, i) => s + i.pts, 0); }

  bank() {
    if (!this.combo.length) return;
    const total = Math.round(this.comboPoints() * this.combo.length);
    this.score += total;
    this.hooks.banked(total, this.combo.length);
    this.combo.length = 0;
  }

  beginAir() {
    this.grounded = false;
    this.rail = null;
    this.air = { time: 0, spin: 0, flip: 0, grab: 0, grabName: '' };
    this.spinVel = this.yawRate;
    this.flipVel = 0;
  }

  // Fold the air that just ended into the combo. `quality` scales the points.
  resolveAir(quality) {
    const a = this.air;
    this.air = null;
    if (!a) return;
    for (const t of airTricks(a)) this.combo.push({ name: t.name, pts: Math.round(t.pts * quality) });
    this.comboTimer = 1.5;
  }

  crash(msg = 'Bail') {
    if (this.bail > 0) return;
    this.bail = 1.7;
    this.air = this.rail = null;
    this.combo.length = 0;
    this.charge = 0;
    this.hooks.flash(msg, 'bad');
    this.hooks.sound.crash();
    for (let i = 0; i < 30; i++) this.hooks.puff(this.pos, this.vel.x * 0.4, 2, this.vel.z * 0.4, 6);
  }

  step(dt, inp) {
    this.time += dt;
    this.railCd -= dt;
    const released = this.jumpHeld && !inp.jump;
    this.jumpHeld = inp.jump;
    if (this.bail > 0) return this.stepBail(dt);
    if (this.rail) this.stepRail(dt, inp, released);
    else if (this.grounded) this.stepGround(dt, inp, released);
    else this.stepAir(dt, inp);

    if (this.collideTree() > 6) this.crash('Tree!');
    if (this.combo.length && this.grounded && !this.rail) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.bank();
    }
  }

  // Push the rider clear of any trunk and deflect them around it, so nobody
  // gets wedged. Returns how hard they hit it head-on, in m/s.
  collideTree() {
    const tree = this.terrain.hitTree(this.pos.x, this.pos.y, this.pos.z);
    if (!tree) return 0;
    tmp.set(this.pos.x - tree.x, 0, this.pos.z - tree.z);
    const d = tmp.length();
    if (d < 1e-3) tmp.set(1, 0, 0); else tmp.divideScalar(d);
    this.pos.addScaledVector(tmp, tree.r + 0.05 - d);
    const into = -(this.vel.x * tmp.x + this.vel.z * tmp.z);
    if (into > 0) { this.vel.x += tmp.x * into * 1.15; this.vel.z += tmp.z * into * 1.15; }
    return Math.max(into, 0);
  }

  stepGround(dt, inp, released) {
    const T = this.terrain, v = this.vel, f3 = this.f3, s3 = this.s3;
    T.normal(this.pos.x, this.pos.z, n);
    const sp = v.length();
    this.yawRate = damp(this.yawRate, (-inp.steer * 2.3 * Math.min(0.4 + sp / 8, 1)) / (1 + sp / 40), 10, dt);
    this.yaw += this.yawRate * dt;
    this.flip = damp(this.flip, 0, 14, dt);
    f0.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    f3.copy(f0).addScaledVector(n, -f0.dot(n)).normalize();
    s3.crossVectors(n, f3);

    // gravity along the slope
    v.x += G * n.y * n.x * dt;
    v.y += (G * n.y * n.y - G) * dt;
    v.z += G * n.y * n.z * dt;
    let vf = v.dot(f3), vs = v.dot(s3);
    this.braking = inp.pitch < -0.3;
    this.tuck = inp.pitch > 0.3;
    this.carve = clamp(Math.abs(vs) * 0.25 + Math.abs(this.yawRate * vf) * 0.03 + (this.braking ? Math.abs(vf) * 0.08 : 0), 0, 1);
    // the edge holds: sideways slip bleeds off fast, forward glide barely at all
    vs *= Math.exp(-(this.braking ? 3 : 9) * dt);
    const dec = ((this.tuck ? 0.0024 : 0.0042) * vf * vf + 0.035 * G * n.y + Math.abs(this.yawRate * vf) * 0.06 + (this.braking ? 7 : 0)) * dt;
    vf = Math.abs(vf) <= dec ? 0 : vf - Math.sign(vf) * dec;
    // skate / hop along on the flat
    if (this.tuck && Math.abs(vf) < 5) vf += (vf < -0.5 ? -1 : 1) * 4 * dt;
    v.copy(f3).multiplyScalar(vf).addScaledVector(s3, vs);

    // ollie: hold to load the board, release to pop
    if (inp.jump) this.charge = Math.min(this.charge + dt / 0.5, 1);
    if (released) {
      v.addScaledVector(n, 4.2 + 2.6 * this.charge);
      this.charge = 0;
      this.hooks.sound.pop();
      this.beginAir();
      return;
    }
    if (!inp.jump) this.charge = 0;

    // follow the surface, or leave it where it drops away faster than gravity
    const speed = v.length();
    const nx = this.pos.x + v.x * dt, nz = this.pos.z + v.z * dt;
    const h = T.height(nx, nz), fall = 0.5 * G * dt * dt;
    if (h >= this.pos.y + v.y * dt - 2 * fall) {
      const dy = h - this.pos.y;
      if (dy > 0.9) {
        // ran into the back of a kicker
        if (speed > 6) this.crash();
        v.set(0, 0, 0);
        return;
      }
      tmp.set(nx - this.pos.x, dy, nz - this.pos.z);
      const l = tmp.length();
      if (l > 1e-7) v.copy(tmp).multiplyScalar(speed / l);
      this.pos.set(nx, h, nz);
    } else {
      this.pos.set(nx, this.pos.y + v.y * dt, nz);
      v.y -= G * dt;
      this.beginAir();
    }
  }

  stepAir(dt, inp) {
    const a = this.air, v = this.vel;
    a.time += dt;
    v.y -= G * dt;
    v.multiplyScalar(1 - 0.0008 * v.length() * dt);
    this.pos.addScaledVector(v, dt);
    this.charge = 0;

    // spin and flip; with the stick released the board settles toward a clean landing
    if (Math.abs(inp.steer) > 0.15) this.spinVel = damp(this.spinVel, -inp.steer * 7.6, 5, dt);
    else {
      this.spinVel = damp(this.spinVel, 0, 5, dt);
      let d = wrap(Math.atan2(v.x, v.z) - this.yaw);
      if (Math.abs(d) > Math.PI / 2) d = wrap(d + Math.PI);
      this.spinVel += clamp(d * 6, -5, 5) * Math.min(1, 6 * dt);
    }
    if (Math.abs(inp.pitch) > 0.3) this.flipVel = damp(this.flipVel, inp.pitch * 6.6, 5, dt);
    else {
      this.flipVel = damp(this.flipVel, 0, 5, dt);
      this.flipVel += clamp(-wrap(this.flip) * 6, -5, 5) * Math.min(1, 6 * dt);
    }
    this.yaw += this.spinVel * dt;
    this.flip += this.flipVel * dt;
    a.spin += this.spinVel * dt;
    a.flip += this.flipVel * dt;
    if (inp.grab && a.time > 0.12) { a.grab += dt; a.grabName = inp.grab; }

    if (this.railCd <= 0 && a.time > 0.06 && v.y < 3) {
      for (const r of this.terrain.rails) {
        const t = tmp.copy(this.pos).sub(r.p0).dot(r.dir) / r.len;
        if (t < 0.01 || t > 0.97) continue;
        tmp2.copy(r.p0).addScaledVector(r.dir, t * r.len);
        const dy = this.pos.y - tmp2.y;
        if (Math.hypot(this.pos.x - tmp2.x, this.pos.z - tmp2.z) > (r.wide ? 1.2 : 0.9) || dy > 0.8 || dy < -0.5) continue;
        this.resolveAir(1);
        this.rail = r;
        this.railT = t;
        this.railV = v.dot(r.dir);
        if (Math.abs(this.railV) < 4) this.railV = this.railV < 0 ? -4 : 4;
        this.railItem = { name: '50-50', pts: 150 };
        this.combo.push(this.railItem);
        this.flip = wrap(this.flip);
        this.hooks.sound.clank();
        return;
      }
    }
    const h = this.terrain.height(this.pos.x, this.pos.z);
    if (this.pos.y <= h) this.land(h);
  }

  land(h) {
    const a = this.air, v = this.vel;
    this.pos.y = h;
    this.terrain.normal(this.pos.x, this.pos.z, n);
    const vn = v.dot(n);
    if (vn < 0) v.addScaledVector(n, -vn);
    this.grounded = true;
    const impact = Math.max(-vn, 0);
    if (a.time < 0.25 && Math.abs(a.flip) < 0.5) {
      // just a bump in the snow
      this.flip = wrap(this.flip);
      this.air = null;
      return;
    }
    const flipOff = Math.abs(wrap(this.flip));
    let yawOff = Math.abs(wrap(Math.atan2(v.x, v.z) - this.yaw));
    if (yawOff > Math.PI / 2) yawOff = Math.PI - yawOff;
    if (v.lengthSq() < 9) yawOff = 0;
    this.flip = wrap(this.flip);
    this.yawRate = 0;
    this.hooks.sound.thump(impact);
    for (let i = 0; i < 14; i++) this.hooks.puff(this.pos, v.x * 0.3, 1.5, v.z * 0.3, 4 + impact * 0.4);
    if (flipOff > 0.95 || yawOff > 1.2 || impact > 16) return this.crash();
    const sketchy = yawOff > 0.6 || flipOff > 0.55 || impact > 12.5;
    if (sketchy) {
      v.multiplyScalar(0.75);
      if (airTricks(a).length) this.hooks.flash('Sketchy', 'meh');
    }
    this.resolveAir(sketchy ? 0.5 : 1);
  }

  stepRail(dt, inp, released) {
    const r = this.rail;
    this.railV += (-G * r.dir.y - 0.4 * Math.sign(this.railV)) * dt;
    this.railT += (this.railV * dt) / r.len;
    this.pos.copy(r.p0).addScaledVector(r.dir, this.railT * r.len);
    this.vel.copy(r.dir).multiplyScalar(this.railV);
    this.yawRate = -inp.steer * 4.5;
    this.yaw += this.yawRate * dt;
    this.flip = damp(this.flip, 0, 14, dt);
    let off = Math.abs(wrap(this.yaw - Math.atan2(r.dir.x, r.dir.z)));
    if (off > Math.PI / 2) off = Math.PI - off;
    this.railItem.name = off > 0.7 ? 'Boardslide' : '50-50';
    this.railItem.pts += 320 * dt;
    this.carve = 0;
    if (Math.random() < 0.4) this.hooks.puff(this.pos, 0, 0.5, 0, 1.5);
    if (inp.jump) this.charge = Math.min(this.charge + dt / 0.5, 1);
    if (this.railT < 0 || this.railT > 1 || released) {
      if (released) { this.vel.y += 4 + 2 * this.charge; this.hooks.sound.pop(); }
      this.railItem.pts = Math.round(this.railItem.pts);
      this.railCd = 0.35;
      this.charge = 0;
      this.beginAir();
      this.spinVel = 0;
    }
  }

  stepBail(dt) {
    const T = this.terrain, v = this.vel;
    this.bail -= dt;
    this.tumble += dt * (4 + v.length() * 0.5);
    if (this.pos.y > T.height(this.pos.x, this.pos.z) + 0.05) v.y -= G * dt;
    else {
      T.normal(this.pos.x, this.pos.z, n);
      const vn = v.dot(n);
      if (vn < 0) v.addScaledVector(n, -vn);
      v.multiplyScalar(Math.exp(-2.2 * dt));
      if (Math.random() < 0.3) this.hooks.puff(this.pos, 0, 1, 0, 2);
    }
    this.pos.addScaledVector(v, dt);
    const h = T.height(this.pos.x, this.pos.z);
    if (this.pos.y < h) this.pos.y = h;
    this.collideTree();
    if (this.bail <= 0) {
      // back on your feet, pointing down the fall line
      this.pos.y = h;
      v.set(0, 0, 0);
      this.grounded = true;
      this.yaw = this.yawRate = this.flip = this.tumble = this.bail = 0;
    }
  }
}
