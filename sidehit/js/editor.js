// Park editor: overhead camera, tap to place, drag to move, panel to tweak.
import * as THREE from '../vendor/three.module.min.js';
import { footprint, bumpSize } from './terrain.js';
import { sanitizeObject, MAX_OBJECTS, SHAPES, SIZES, centerX, pathDir } from './maps.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const LABEL = { kicker: 'Kicker', jump: 'Jump', roller: 'Roller', rail: 'Rail', box: 'Box', tree: 'Tree' };
const SIZE = { kicker: ['S', 'M', 'L', 'XL'], jump: ['S', 'M', 'L'], roller: ['S', 'M', 'L'] };
const SHAPE = { straight: 'straight', rainbow: 'rainbow', z: 'Z', kink: 'kinked', wide: 'wide', flatdown: 'flat-down' };
const DEFAULTS = {
  kicker: { s: 1, r: 0 }, jump: { s: 0, r: 0 }, roller: { s: 1, r: 0 }, rail: { len: 14, h: 0.45, r: 0 }, box: { len: 14, h: 0.5, r: 0 }, tree: { s: 1 },
};

export class Editor {
  // app: { camera, canvas, terrain (getter), map (getter), saved(), rebuildGround() }
  constructor(app) {
    this.app = app;
    this.active = false;
    this.tool = 'select';
    this.sel = null;
    this.target = new THREE.Vector3(0, 0, 120);
    this.dist = 150;
    this.ray = new THREE.Raycaster();
    this.hit = new THREE.Vector3();
    this.pointers = new Map();
    this.drag = null;

    // selection marker: ring on the snow plus an arrow for the heading
    this.marker = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0xffe14a, depthTest: false, transparent: true, opacity: 0.95, side: THREE.DoubleSide });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.93, 1, 48), mat);
    this.ring.rotation.x = -Math.PI / 2;
    this.arrow = new THREE.Mesh(new THREE.ConeGeometry(0.8, 2.2, 3), mat);
    this.arrow.rotation.x = Math.PI / 2;
    this.marker.add(this.ring, this.arrow);
    this.marker.renderOrder = 10;
    this.marker.visible = false;

    const c = app.canvas;
    c.addEventListener('pointerdown', (e) => this.down(e));
    c.addEventListener('pointermove', (e) => this.move(e));
    c.addEventListener('pointerup', (e) => this.up(e));
    c.addEventListener('pointercancel', (e) => this.up(e, true));
    c.addEventListener('wheel', (e) => { if (this.active) { this.dist = clamp(this.dist * (e.deltaY > 0 ? 1.12 : 0.89), 25, 900); e.preventDefault(); } }, { passive: false });

    for (const b of document.querySelectorAll('#tools button')) b.addEventListener('click', () => this.setTool(b.dataset.tool));
    const act = (id, fn) => $(id).addEventListener('click', () => { if (this.sel) { fn(this.sel); this.commit(); } });
    act('rotl', (o) => { o.r = this.wrap(o.r + Math.PI / 12); });
    act('rotr', (o) => { o.r = this.wrap(o.r - Math.PI / 12); });
    act('smaller', (o) => this.resize(o, -1));
    act('bigger', (o) => this.resize(o, 1));
    act('lower', (o) => { o.h = clamp(Math.round((o.h - 0.1) * 10) / 10, 0.3, 1.5); });
    act('higher', (o) => { o.h = clamp(Math.round((o.h + 0.1) * 10) / 10, 0.3, 1.5); });
    act('lip', (o) => { if (o.lip === false) delete o.lip; else o.lip = false; });
    act('shape', (o) => { const all = SHAPES[o.t]; if (all) o.k = all[(all.indexOf(o.k) + 1) % all.length]; });
    $('dup').addEventListener('click', () => {
      if (!this.sel || this.map.objects.length >= MAX_OBJECTS) return;
      const o = sanitizeObject({ ...this.sel, x: this.sel.x + 6 }, this.map);
      this.map.objects.push(o);
      this.sel = o;
      this.commit();
    });
    $('del').addEventListener('click', () => {
      if (!this.sel) return;
      this.map.objects.splice(this.map.objects.indexOf(this.sel), 1);
      this.sel = null;
      this.commit();
    });

    // map settings
    const bind = (id, key, parse) => $(id).addEventListener('change', () => {
      this.map[key] = parse($(id).value);
      if (key === 'name') this.app.saved(); else this.app.rebuildGround();
    });
    bind('m-name', 'name', (v) => v.trim().slice(0, 40) || 'Untitled park');
    bind('m-slope', 'slope', Number);
    bind('m-length', 'length', Number);
    bind('m-width', 'width', Number);
    bind('m-bumps', 'bumps', Number);
    bind('m-curve', 'curve', Number);
    bind('m-trees', 'trees', Number);
    bind('m-cliffs', 'cliffs', Number);
    $('m-powder').addEventListener('change', () => { this.map.powder = $('m-powder').checked; this.app.rebuildGround(); });
    bind('m-sky', 'sky', String);
    $('b-settings').addEventListener('click', () => $('settings').classList.toggle('open'));
  }

  get map() { return this.app.map; }
  get terrain() { return this.app.terrain; }
  wrap(a) { return a - Math.PI * 2 * Math.round(a / (Math.PI * 2)); }

  enter() {
    this.active = true;
    this.sel = null;
    this.setTool('select');
    const m = this.map;
    this.target.set(centerX(m, 120), 0, Math.min(m.length * 0.3, 160));
    this.dist = 170;
    $('m-name').value = m.name;
    $('m-slope').value = m.slope;
    $('m-length').value = m.length;
    $('m-width').value = m.width;
    $('m-bumps').value = m.bumps;
    $('m-curve').value = m.curve;
    $('m-trees').value = m.trees;
    $('m-cliffs').value = m.cliffs;
    $('m-powder').checked = m.powder;
    $('m-sky').value = m.sky;
    $('settings').classList.remove('open');
    this.refreshPanel();
  }

  exit() {
    this.active = false;
    this.marker.visible = false;
  }

  // Called after the terrain object was replaced (settings change).
  terrainChanged() {
    const m = this.map;
    for (const o of m.objects) { o.z = clamp(o.z, 0, m.length + 40); const c = centerX(m, o.z); o.x = clamp(o.x, c - m.width / 2 - 20, c + m.width / 2 + 20); }
    m.spawn.x = clamp(m.spawn.x, centerX(m, m.spawn.z) - m.width / 2, centerX(m, m.spawn.z) + m.width / 2);
    this.refreshPanel();
  }

  setTool(tool) {
    this.tool = tool;
    for (const b of document.querySelectorAll('#tools button')) b.classList.toggle('on', b.dataset.tool === tool);
    $('tip').textContent = tool === 'select' ? 'Tap a feature to select it, drag it to move. Drag the snow to pan, pinch or scroll to zoom.'
      : tool === 'spawn' ? 'Tap where riders should drop in.' : `Tap the snow to place a ${LABEL[tool].toLowerCase()}.`;
  }

  resize(o, d) {
    if (SIZES[o.t]) o.s = clamp(o.s + d, 0, SIZES[o.t] - 1);
    else if (o.t === 'tree') o.s = clamp(Math.round((o.s + d * 0.2) * 10) / 10, 0.6, 2);
    else o.len = clamp(o.len + d * 2, 6, 40);
  }

  // Apply an edit: rebuild derived data, redraw, save.
  commit() {
    this.terrain.compile();
    this.terrain.buildObjects();
    this.refreshPanel();
    this.app.saved();
  }

  refreshPanel() {
    const o = this.sel, panel = $('selpanel');
    panel.classList.toggle('open', !!o);
    $('count').textContent = `${this.map.objects.length} / ${MAX_OBJECTS}`;
    if (!o) return;
    let info = LABEL[o.t];
    if (SIZE[o.t]) info += ' ' + SIZE[o.t][o.s];
    else if (o.t === 'tree') info += ' ×' + o.s.toFixed(1);
    else info = `${SHAPE[o.k][0].toUpperCase() + SHAPE[o.k].slice(1)} ${LABEL[o.t].toLowerCase()} · ${o.len} m · ${o.h.toFixed(1)} m high`;
    $('selinfo').textContent = info;
    const rail = o.t === 'rail' || o.t === 'box';
    for (const id of ['rotl', 'rotr']) $(id).hidden = o.t === 'tree';
    for (const id of ['lower', 'higher', 'shape', 'lip']) $(id).hidden = !rail;
    $('lip').textContent = o.lip === false ? 'Lip off' : 'Lip on';
  }

  ground(e) {
    const r = this.app.canvas.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.app.camera);
    return this.terrain.raycast(this.ray.ray.origin, this.ray.ray.direction, this.hit) ? this.hit : null;
  }

  pick(p) {
    let best = null, bestD = Infinity;
    for (const o of this.map.objects) {
      const f = footprint(o), d = Math.hypot(p.x - f.x, p.z - f.z);
      if (d < Math.max(f.rad, 3) && d < bestD) { best = o; bestD = d; }
    }
    return best;
  }

  down(e) {
    if (!this.active) return;
    this.app.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), dist: this.dist };
      this.drag = null;
      return;
    }
    const g = this.ground(e);
    this.drag = { x: e.clientX, y: e.clientY, moved: false, obj: null, g: g ? g.clone() : null };
    if (g && this.sel && this.pick(g) === this.sel) {
      this.drag.obj = this.sel;
      this.drag.off = { x: this.sel.x - g.x, z: this.sel.z - g.z };
    }
  }

  move(e) {
    if (!this.active || !this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2 && this.pinch) {
      const [a, b] = [...this.pointers.values()];
      this.dist = clamp((this.pinch.dist * this.pinch.d) / Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1), 25, 900);
      return;
    }
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 8) return;
    d.moved = true;
    const g = this.ground(e);
    if (!g) return;
    const m = this.map;
    if (d.obj) {
      d.obj.z = clamp(g.z + d.off.z, 0, m.length + 40);
      const c = centerX(m, d.obj.z);
      d.obj.x = clamp(g.x + d.off.x, c - m.width / 2 - 20, c + m.width / 2 + 20);
      this.terrain.refreshObject(d.obj);
    } else if (d.g) {
      // pan: keep the grabbed point of snow under the finger
      this.target.x = clamp(this.target.x + d.g.x - g.x, -m.width - 100, m.width + 100);
      this.target.z = clamp(this.target.z + d.g.z - g.z, -40, m.length + 80);
    }
  }

  up(e, cancelled) {
    if (!this.active) return;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    const d = this.drag;
    this.drag = null;
    if (!d || cancelled) return;
    if (d.moved) { if (d.obj) this.commit(); return; }
    if (!d.g) return;
    const m = this.map;
    if (this.tool === 'select') {
      this.sel = this.pick(d.g);
      this.refreshPanel();
    } else if (this.tool === 'spawn') {
      const sz = clamp(d.g.z, 2, m.length - 60), sc = centerX(m, sz);
      m.spawn = { x: clamp(d.g.x, sc - m.width / 2, sc + m.width / 2), z: sz };
      this.commit();
    } else if (m.objects.length < MAX_OBJECTS) {
      // new features point down the run; shaped snow is centred on the tap, rails start at it
      const o = sanitizeObject({ t: this.tool, x: d.g.x, z: d.g.z, ...DEFAULTS[this.tool], r: pathDir(m, d.g.z) }, m);
      if (SIZES[o.t]) o.z = Math.max(o.z - bumpSize(o).len / 2, 0);
      m.objects.push(o);
      this.sel = o;
      this.commit();
    }
  }

  update() {
    const cam = this.app.camera, t = this.target;
    t.y = this.terrain.base(t.x, t.z);
    cam.position.set(t.x, t.y + this.dist * 0.8, t.z - this.dist * 0.6);
    cam.lookAt(t);
    const o = this.sel;
    this.marker.visible = !!o;
    if (o) {
      const f = footprint(o), rad = Math.max(f.rad, 2.5) + 1;
      this.marker.position.set(f.x, this.terrain.height(f.x, f.z) + 0.6, f.z);
      this.ring.scale.setScalar(rad);
      this.arrow.visible = o.t !== 'tree';
      this.arrow.position.set(Math.sin(o.r || 0) * (rad + 1.6), 0, Math.cos(o.r || 0) * (rad + 1.6));
      this.arrow.rotation.set(Math.PI / 2, o.r || 0, 0, 'YXZ');
    }
  }
}
