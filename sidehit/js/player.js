// Rider physics and the trick / combo system. No rendering in here.
import * as THREE from '../vendor/three.module.min.js';

const G = 9.81, TAU = Math.PI * 2, HALF = Math.PI / 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = (a) => a - TAU * Math.round(a / TAU);
const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));
// smallest rotation that lines a board up with a heading, nose or tail first
const toAligned = (heading, yaw) => { let d = wrap(heading - yaw); if (Math.abs(d) > HALF) d = wrap(d + Math.PI); return d; };

// How forgiving the riding is.
export const MODES = {
  arcade: { assist: 6, yawSketchy: 0.6, yawBail: 1.2, flipSketchy: 0.55, flipBail: 0.95, spinBase: 6.4, spinMax: 8.2, pop0: 2.4, pop1: 4.4, strict: false },
  sim: { assist: 1.5, yawSketchy: 0.4, yawBail: 0.9, flipSketchy: 0.4, flipBail: 0.75, spinBase: 4.6, spinMax: 8.2, pop0: 2.2, pop1: 3.6, strict: true },
};

const n = new THREE.Vector3(), f0 = new THREE.Vector3(), tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();

export function airTricks(a) {
  const list = [];
  const halves = Math.round(Math.abs(a.spin) / Math.PI), deg = halves * 180;
  if (halves >= 1) {
    const fs = a.spin > 0;
    let name = (fs ? 'FS ' : 'BS ') + deg, pts = 50 * halves * (halves + 1);
    if (a.fromRail) name = deg + ' Out';
    else if (a.sw) { name = (fs ? 'Cab ' : 'Sw BS ') + deg; pts *= 1.2; }
    list.push({ name, pts: Math.round(pts) });
  }
  const flips = Math.round(Math.abs(a.flip) / TAU);
  if (flips >= 1) list.push({ name: ['', '', 'Double ', 'Triple '][Math.min(flips, 3)] + (a.flip > 0 ? 'Frontflip' : 'Backflip'), pts: 400 * flips * (flips + 1) });
  if (a.grab > 0.25) list.push({ name: a.grabName === 'mute' ? 'Mute' : 'Indy', pts: Math.round(150 + 350 * a.grab) });
  if (a.nollie && a.time > 0.45 && !a.fromRail) list.push({ name: 'Nollie', pts: 80 });
  if (a.time > 1.1) list.push({ name: 'Big Air', pts: Math.round(a.time * 120) });
  return list;
}

export class Player {
  // hooks: { flash(text, kind), puff(pos, vx, vy, vz, spread), sound, banked(total, count) }
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
    this.setMode('arcade');
    this.clear();
  }

  setMode(name) {
    this.mode = MODES[name] ? name : 'arcade';
    this.M = MODES[this.mode];
  }

  clear() {
    Object.assign(this, {
      yaw: 0, yawRate: 0, spinVel: 0, flip: 0, flipVel: 0, grounded: true, charge: 0, jumpHeld: false,
      carve: 0, braking: false, tuck: false, tuckT: 0, wind: 0, sw: false,
      press: 0, pressLocal: 0, pressT: 0, butter: 0, pressItem: null, slipT: 0,
      air: null, rail: null, railSeg: null, railS: 0, railV: 0, railCd: 0, railItem: null, railOff: 0, steerS: 0, absorb: 0,
      bail: 0, tumble: 0, comboTimer: 0, time: 0,
    });
    this.combo.length = 0;
  }

  setTerrain(terrain) {
    this.terrain = terrain;
    this.powder = !!terrain.map.powder;
    this.spawn = { x: terrain.map.spawn.x, z: terrain.map.spawn.z, yaw: 0 };
    this.score = 0;
    this.respawn();
  }

  respawn() {
    this.clear();
    const s = this.spawn;
    this.pos.set(s.x, this.terrain.height(s.x, s.z), s.z);
    this.yaw = s.yaw;
    this.vel.set(Math.sin(s.yaw) * 1.2, 0, Math.cos(s.yaw) * 1.2);
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

  beginAir(fromRail = false) {
    this.endPress(false);
    this.grounded = false;
    this.rail = null;
    this.air = { time: 0, spin: 0, flip: 0, grab: 0, grabName: '', wind: this.wind, sw: this.sw && !fromRail, nollie: false, fromRail };
    this.spinVel = fromRail ? 0 : this.yawRate;
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
    this.press = this.pressLocal = 0;
    this.pressItem = null;
    this.combo.length = 0;
    this.charge = 0;
    this.hooks.flash(msg, 'bad');
    this.hooks.sound.crash();
    for (let i = 0; i < 30; i++) this.hooks.puff(this.pos, this.vel.x * 0.4, 2, this.vel.z * 0.4, 6);
  }

  // inp: { steer, pitch, jump, brake, grab }
  step(dt, inp) {
    this.time += dt;
    this.railCd -= dt;
    const released = this.jumpHeld && !inp.jump;
    this.jumpHeld = inp.jump;
    if (this.bail > 0) return this.stepBail(dt);
    if (this.rail) this.stepRail(dt, inp, released);
    else if (this.grounded) this.stepGround(dt, inp, released);
    else this.stepAir(dt, inp);

    if (this.bail <= 0 && this.collideTree() > 6) this.crash('Tree!');
    if (this.combo.length && this.grounded && !this.rail && !this.press) {
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

  // ---- presses and butters ---------------------------------------------

  startPress(sign, lead) {
    this.press = sign;
    this.pressLocal = sign * lead;   // +1: the board's nose is the end on the snow
    this.pressT = 0;
    this.butter = 0;
    this.pressItem = null;
  }

  // `settle`: the board is going back onto its edges, so it has to line up again.
  endPress(settle) {
    if (!this.press) return;
    if (this.pressItem) { this.pressItem.pts = Math.round(this.pressItem.pts); this.comboTimer = 1.5; }
    this.press = this.pressLocal = 0;
    this.pressItem = null;
    if (!settle) return;
    const off = Math.abs(toAligned(Math.atan2(this.vel.x, this.vel.z), this.yaw));
    if (this.M.strict && off > 1.0 && this.vel.length() > 6) return this.crash('Caught an edge');
    this.slipT = 0.3;
  }

  stepGround(dt, inp, released) {
    const T = this.terrain, v = this.vel, f3 = this.f3, s3 = this.s3;
    T.normal(this.pos.x, this.pos.z, n);
    const sp = v.length();
    this.braking = !!inp.brake;

    // lean on the nose or tail to press; needs some speed, and the brake cancels it
    const lead = v.x * Math.sin(this.yaw) + v.z * Math.cos(this.yaw) < 0 ? -1 : 1;
    const want = !this.braking && Math.abs(inp.pitch) > 0.5 && sp > (this.press ? 2 : 3) ? Math.sign(inp.pitch) : 0;
    if (want !== this.press) { this.endPress(true); if (this.bail > 0) return; if (want) this.startPress(want, lead); }
    const loose = this.press !== 0 || this.slipT > 0;

    if (this.press) {
      // flat on one end of the board: it pivots freely
      this.yawRate = damp(this.yawRate, -inp.steer * 4.4, 8, dt);
      this.pressT += dt;
      this.butter += this.yawRate * dt;
      if (!this.pressItem && this.pressT > 0.3) {
        this.pressItem = { name: '', pts: 60, halves: 0 };
        this.combo.push(this.pressItem);
      }
      if (this.pressItem) {
        const it = this.pressItem, halves = Math.floor((Math.abs(this.butter) + 0.45) / Math.PI);
        if (halves > it.halves) { it.pts += 150 * (halves - it.halves) * halves; it.halves = halves; }
        it.pts += 170 * dt;
        it.name = (this.press > 0 ? 'Nose' : 'Tail') + (halves ? ' Butter ' + halves * 180 : ' Press');
      }
    } else if (this.slipT > 0) {
      // coming out of a butter: the board swings back in line with the direction of travel
      this.slipT -= dt;
      this.yawRate = clamp(toAligned(Math.atan2(v.x, v.z), this.yaw) * 10, -9, 9);
    } else {
      this.steerS = damp(this.steerS, inp.steer, 9, dt);
      this.yawRate = damp(this.yawRate, (-this.steerS * 2.3 * Math.min(0.4 + sp / 8, 1)) / (1 + sp / 40), this.powder ? 5 : 8, dt);
    }
    this.yaw += this.yawRate * dt;
    this.wind = damp(this.wind, this.yawRate, 3, dt);
    this.flip = damp(this.flip, 0, 14, dt);
    this.absorb = damp(this.absorb, 0, 5, dt);
    f0.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    f3.copy(f0).addScaledVector(n, -f0.dot(n)).normalize();
    s3.crossVectors(n, f3);

    // gravity along the slope
    v.x += G * n.y * n.x * dt;
    v.y += (G * n.y * n.y - G) * dt;
    v.z += G * n.y * n.z * dt;
    let vf = v.dot(f3), vs = v.dot(s3);
    this.sw = vf < -1;
    // tuck by itself when running straight
    const straight = !loose && !this.braking && !inp.jump && Math.abs(inp.steer) < 0.15 && sp > 4;
    this.tuckT = straight ? this.tuckT + dt : 0;
    this.tuck = this.tuckT > 0.5;
    this.carve = clamp(Math.abs(vs) * (loose ? 0.05 : 0.25) + Math.abs(this.yawRate * vf) * 0.03 + (this.braking ? Math.abs(vf) * 0.08 : 0), 0, 1);
    // on its edge the board holds: sideways slip bleeds off fast, forward glide barely at all
    vs *= Math.exp(-(loose ? 0.4 : this.braking ? 3 : this.powder ? 5 : 9) * dt);
    const dec = ((this.powder ? 0.0085 : this.tuck ? 0.0024 : 0.0042) * vf * vf + 0.035 * G * n.y + (loose ? 0 : Math.abs(this.yawRate * vf) * 0.06) + (this.braking ? 7 : 0)
      // deep snow drags when you're slow and lets go as you plane on top of it
      + (this.powder ? 0.8 * Math.exp(-Math.abs(vf) / 5) : 0)) * dt;
    vf = Math.abs(vf) <= dec ? 0 : vf - Math.sign(vf) * dec;
    // never stuck: the rider shuffles forward at walking pace unless braking, and skates harder on request
    if (!this.braking && !this.press) {
      if (inp.pitch > 0.3 && Math.abs(vf) < 4) vf += (vf < -0.5 ? -1 : 1) * 4 * dt;
      else if (Math.abs(vf) < 2.5) vf += (vf < -0.5 ? -1 : 1) * 2.2 * dt;
    }
    v.copy(f3).multiplyScalar(vf).addScaledVector(s3, vs);

    // ollie: the longer the hold, the bigger the pop
    if (inp.jump) this.charge = Math.min(this.charge + dt / 0.9, 1);
    if (released) {
      const pop = (this.M.pop0 + this.M.pop1 * this.charge) * (inp.pitch < -0.4 ? 1.12 : 1);
      v.addScaledVector(n, pop);
      this.charge = 0;
      this.hooks.sound.pop();
      this.beginAir();
      this.air.nollie = inp.pitch > 0.4;
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
    const a = this.air, v = this.vel, M = this.M;
    a.time += dt;
    v.y -= G * dt;
    v.multiplyScalar(1 - 0.0008 * v.length() * dt);
    this.pos.addScaledVector(v, dt);
    this.charge = 0;

    if (Math.abs(inp.steer) > 0.15) {
      // winding up the other way before take-off makes the spin faster
      const want = -inp.steer;
      const top = M.spinBase + (a.wind * want < 0 ? (M.spinMax - M.spinBase) * Math.min(Math.abs(a.wind) / 1.2, 1) : 0);
      this.spinVel = damp(this.spinVel, want * top, 5, dt);
    } else {
      // stick released: the board settles toward a clean landing (strongly in arcade, barely in sim)
      this.spinVel = damp(this.spinVel, 0, 5, dt);
      this.spinVel += clamp(toAligned(Math.atan2(v.x, v.z), this.yaw) * M.assist, -5, 5) * Math.min(1, 6 * dt);
    }
    if (Math.abs(inp.pitch) > 0.3) this.flipVel = damp(this.flipVel, inp.pitch * 6.6, 5, dt);
    else {
      this.flipVel = damp(this.flipVel, 0, 5, dt);
      this.flipVel += clamp(-wrap(this.flip) * M.assist, -5, 5) * Math.min(1, 6 * dt);
    }
    this.yaw += this.spinVel * dt;
    this.flip += this.flipVel * dt;
    a.spin += this.spinVel * dt;
    a.flip += this.flipVel * dt;
    if (inp.grab && a.time > 0.12) { a.grab += dt; a.grabName = inp.grab; }

    if (this.railCd <= 0 && a.time > 0.06 && v.y < 3) {
      for (const r of this.terrain.rails) for (const sg of r.segs) {
        const t = tmp.copy(this.pos).sub(sg.p0).dot(sg.dir), along = sg.s0 + t;
        if (t < 0 || t > sg.len || along < 0.2 || along > r.total - 0.5) continue;
        tmp2.copy(sg.p0).addScaledVector(sg.dir, t);
        const dy = this.pos.y - tmp2.y;
        if (Math.hypot(this.pos.x - tmp2.x, this.pos.z - tmp2.z) > r.reach || dy > 0.8 || dy < -0.5) continue;
        return this.lockOn(r, sg, along, tmp2);
      }
    }
    const h = this.terrain.height(this.pos.x, this.pos.z);
    if (this.pos.y <= h) this.land(h);
  }

  // ---- rails -------------------------------------------------------------

  lockOn(r, sg, along, point) {
    const a = this.air, v = this.vel;
    // which part of the board came down over the rail: + toward the nose, - toward the tail
    this.railOff = r.width > 1 ? 0 : clamp((point.x - this.pos.x) * Math.sin(this.yaw) + (point.z - this.pos.z) * Math.cos(this.yaw), -0.5, 0.5);
    const quarters = Math.round(Math.abs(a.spin) / HALF);
    if (quarters >= 2) {
      this.combo.push({ name: quarters * 90 + ' On', pts: 80 * quarters });
      a.spin = 0;
    }
    this.resolveAir(1);
    this.rail = r;
    this.railSeg = sg;
    this.railS = along;
    this.railV = v.dot(sg.dir);
    if (Math.abs(this.railV) < 4) this.railV = this.railV < 0 ? -4 : 4;
    this.railItem = { name: '50-50', pts: 150 };
    this.combo.push(this.railItem);
    this.flip = wrap(this.flip);
    this.yawRate = 0;
    this.hooks.sound.clank();
  }

  stepRail(dt, inp, released) {
    const r = this.rail, M = this.M, segs = r.segs;
    this.railV += (-G * this.railSeg.dir.y - 0.4 * Math.sign(this.railV)) * dt;
    this.railS += this.railV * dt;
    let i = segs.indexOf(this.railSeg);
    while (i < segs.length - 1 && this.railS > segs[i].s0 + segs[i].len) i++;
    while (i > 0 && this.railS < segs[i].s0) i--;
    const sg = (this.railSeg = segs[i]);
    this.pos.copy(sg.p0).addScaledVector(sg.dir, this.railS - sg.s0);
    this.vel.copy(sg.dir).multiplyScalar(this.railV);
    this.flip = damp(this.flip, 0, 14, dt);
    this.carve = 0;

    // the trick is set by how the board sits on the rail
    const way = this.railV < 0 ? -1 : 1, tx = sg.dir.x * way, tz = sg.dir.z * way;
    const rel = wrap(this.yaw - Math.atan2(tx, tz));
    let across = Math.abs(rel);
    if (across > HALF) across = Math.PI - across;
    const sideways = across > 0.7;
    const facing = -Math.cos(this.yaw) * tx + Math.sin(this.yaw) * tz > 0;   // chest toward the way you're going
    let name = '50-50', mult = 1;
    if (!sideways) {
      if (inp.pitch > 0.5) { name = 'Nose Press'; mult = 1.3; }
      else if (inp.pitch < -0.5) { name = '5-0'; mult = 1.3; }
    } else if (Math.abs(this.railOff) < 0.22) { name = (facing ? 'BS' : 'FS') + ' Boardslide'; mult = 1.4; }
    else if (this.railOff > 0) { name = facing ? 'Noseslide' : 'Noseblunt'; mult = facing ? 1.7 : 2; }
    else { name = facing ? 'Bluntslide' : 'Tailslide'; mult = facing ? 2 : 1.7; }
    this.railItem.name = name;
    this.railItem.pts += 320 * mult * dt;
    // steer to swing the board round on the rail; let go and it locks square, straight or sideways
    if (Math.abs(inp.steer) > 0.2) this.yawRate = damp(this.yawRate, -inp.steer * 4.5, 10, dt);
    else {
      const snap = sideways ? HALF : 0, target = Math.atan2(tx, tz) + (rel < 0 ? -snap : snap);
      this.yawRate = clamp(toAligned(target, this.yaw) * 8, -6, 6);
    }
    this.yaw += this.yawRate * dt;

    if (Math.random() < 0.4) this.hooks.puff(this.pos, 0, 0.5, 0, 1.5);
    if (inp.jump) this.charge = Math.min(this.charge + dt / 0.9, 1);
    if (this.railS < 0 || this.railS > r.total || released) {
      if (released) { this.vel.y += M.pop0 + M.pop1 * this.charge * 0.8; this.hooks.sound.pop(); }
      this.railItem.pts = Math.round(this.railItem.pts);
      this.railCd = 0.35;
      this.charge = 0;
      this.beginAir(true);
    }
  }

  land(h) {
    const a = this.air, v = this.vel, M = this.M;
    this.pos.y = h;
    this.terrain.normal(this.pos.x, this.pos.z, n);
    const vn = v.dot(n);
    if (vn < 0) v.addScaledVector(n, -vn);
    this.grounded = true;
    const impact = Math.max(-vn, 0);
    if (a.time < 0.25 && Math.abs(a.flip) < 0.5 && !a.fromRail) {
      // just a bump in the snow
      this.flip = wrap(this.flip);
      this.air = null;
      return;
    }
    const flipOff = Math.abs(wrap(this.flip));
    let yawOff = Math.abs(toAligned(Math.atan2(v.x, v.z), this.yaw));
    if (v.lengthSq() < 9) yawOff = 0;
    this.flip = wrap(this.flip);
    this.yawRate = 0;
    this.wind = 0;
    this.steerS = 0;
    this.absorb = Math.min(impact / 9, 1);
    this.hooks.sound.thump(impact);
    for (let i = 0; i < 14; i++) this.hooks.puff(this.pos, v.x * 0.3, 1.5, v.z * 0.3, 4 + impact * 0.4);
    const soft = this.powder ? 7 : 0;
    if (flipOff > M.flipBail || yawOff > M.yawBail || impact > 16 + soft) return this.crash();
    const sketchy = yawOff > M.yawSketchy || flipOff > M.flipSketchy || impact > 12.5 + soft;
    if (sketchy) {
      v.multiplyScalar(0.75);
      if (airTricks(a).length) this.hooks.flash('Sketchy', 'meh');
    }
    this.resolveAir(sketchy ? 0.5 : 1);
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
