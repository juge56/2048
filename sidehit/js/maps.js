// Map format, built-in parks, validation and browser storage.
//
// A map is plain JSON:
//   { id, name, length, width, slope, bumps, curve, powder, trees, cliffs, seed, sky, spawn: {x, z}, objects: [...] }
//   curve    0..1  how much the run snakes from side to side
//   powder   true for ungroomed deep snow
//   trees    0..1  trees scattered inside the run
//   cliffs   0..1  drops and steps in the terrain
// Objects: { t: 'kicker' | 'jump' | 'roller' | 'rail' | 'box' | 'tree', x, z, r, s, k, len, h }
//   r   heading in radians (0 points straight down the hill)
//   s   size step for kickers, jumps and rollers; scale for trees
//   k   shape of a rail (straight, rainbow, z, kink) or box (straight, wide, flatdown)
//   len, h   length and height above the snow for rails and boxes
//   lip      false to leave out the snow take-off in front of a rail or box

export const SKIES = ['bluebird', 'golden', 'dusk'];
export const TYPES = ['kicker', 'jump', 'roller', 'rail', 'box', 'tree'];
export const SHAPES = { rail: ['straight', 'rainbow', 'z', 'kink'], box: ['straight', 'wide', 'flatdown'] };
export const SIZES = { kicker: 4, jump: 3, roller: 3 };
export const MAX_OBJECTS = 200;

const num = (v, lo, hi, def) => (Number.isFinite(+v) ? Math.min(Math.max(+v, lo), hi) : def);
const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// Centre line of the run, and the heading of that line.
export function centerX(m, z) {
  if (!m.curve) return 0;
  return m.curve * (60 * Math.sin(z * 0.0052 + m.seed) + 32 * Math.sin(z * 0.0121 + m.seed * 1.7)) * ease(z / 80);
}
export const pathDir = (m, z) => Math.atan2(centerX(m, z + 1) - centerX(m, z - 1), 2);

export function sanitizeObject(o, map) {
  if (!o || !TYPES.includes(o.t)) return null;
  const z = num(o.z, 0, map.length + 40, 50), c = centerX(map, z), reach = map.width / 2 + 20;
  const out = { t: o.t, x: num(o.x, c - reach, c + reach, c), z };
  if (o.t !== 'tree') out.r = num(o.r, -Math.PI, Math.PI, 0);
  if (SIZES[o.t]) out.s = Math.round(num(o.s, 0, SIZES[o.t] - 1, 1));
  if (o.t === 'tree') out.s = num(o.s, 0.6, 2, 1);
  if (SHAPES[o.t]) {
    out.len = num(o.len, 6, 40, 14);
    out.h = num(o.h, 0.3, 1.5, 0.5);
    out.k = SHAPES[o.t].includes(o.k) ? o.k : 'straight';
    if (o.lip === false) out.lip = false;   // lips are on unless switched off
  }
  return out;
}

// Accepts anything (including pasted text from a stranger) and returns a safe map.
export function sanitizeMap(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Not a map');
  const map = {
    id: typeof raw.id === 'string' ? raw.id.slice(0, 40) : newId(),
    name: String(raw.name || 'Untitled park').slice(0, 40),
    length: num(raw.length, 250, 2400, 520),
    width: num(raw.width, 80, 300, 140),
    slope: num(raw.slope, 0.16, 0.5, 0.28),
    bumps: num(raw.bumps, 0, 1, 0.4),
    curve: num(raw.curve, 0, 1, 0),
    trees: num(raw.trees, 0, 1, 0),
    cliffs: num(raw.cliffs, 0, 1, 0),
    powder: !!raw.powder,
    seed: Math.round(num(raw.seed, 0, 9999, 1)),
    sky: SKIES.includes(raw.sky) ? raw.sky : 'bluebird',
    objects: [],
  };
  const sz = num(raw.spawn && raw.spawn.z, 2, map.length - 60, 6), sc = centerX(map, sz);
  map.spawn = { x: num(raw.spawn && raw.spawn.x, sc - map.width / 2, sc + map.width / 2, sc), z: sz };
  for (const o of Array.isArray(raw.objects) ? raw.objects.slice(0, MAX_OBJECTS) : []) {
    const s = sanitizeObject(o, map);
    if (s) map.objects.push(s);
  }
  return map;
}

export const newId = () => 'm' + Math.random().toString(36).slice(2, 10);

export function blankMap() {
  return sanitizeMap({ name: 'My park', objects: [{ t: 'jump', x: 0, z: 90, r: 0, s: 0 }] });
}

const K = (x, z, s, r = 0) => ({ t: 'kicker', x, z, s, r });
const J = (x, z, s, r = 0) => ({ t: 'jump', x, z, s, r });
const O = (x, z, s, r = 0) => ({ t: 'roller', x, z, s, r });
const R = (x, z, len, h = 0.45, k = 'straight', r = 0) => ({ t: 'rail', x, z, len, h, k, r });
const B = (x, z, len, h = 0.5, k = 'straight', r = 0) => ({ t: 'box', x, z, len, h, k, r });
const T = (x, z, s = 1) => ({ t: 'tree', x, z, s });

// For winding courses: place features by distance down the run and offset from
// its centre line, turned to follow the line.
function along(map, list) {
  map.objects = list.map((o) => ({ ...o, x: centerX(map, o.z) + o.x, r: (o.r || 0) + pathDir(map, o.z) }));
  return map;
}

export const BUILTIN = [
  {
    id: 'warmup', name: 'Warm-Up Lap', length: 560, width: 140, slope: 0.28, bumps: 0.35, seed: 3, sky: 'bluebird',
    objects: [
      K(-24, 70, 0), J(-24, 130, 0), J(-24, 235, 1), J(-24, 355, 1), O(-24, 470, 1),
      R(18, 85, 16, 0.45, 'z'), B(24, 165, 16), R(16, 250, 21, 0.5, 'kink'), B(30, 335, 14, 0.6, 'wide', 0.2), R(20, 420, 18, 0.5, 'rainbow'),
      K(48, 120, 0, -0.15), K(46, 290, 1), B(46, 400, 18, 0.5, 'flatdown'),
      T(-2, 110, 1.1), T(1, 118, 0.8), T(-1, 205, 1.2), T(3, 300, 1), T(0, 312, 0.8), T(-3, 400, 1.3),
    ],
  },
  {
    id: 'jibs', name: 'Jib Garden', length: 430, width: 130, slope: 0.25, bumps: 0.2, seed: 11, sky: 'golden',
    objects: [
      R(-30, 60, 14, 0.45, 'rainbow'), B(-10, 62, 12), R(10, 60, 18, 0.6, 'z'), B(30, 62, 14, 0.4, 'wide'),
      K(-30, 110, 0), R(-30, 128, 21, 0.9, 'kink'), K(12, 112, 0), B(12, 130, 18, 1.0),
      R(-40, 190, 18, 0.45, 'straight', 0.35), R(-12, 190, 18, 0.45, 'rainbow', -0.35), B(22, 185, 24, 0.5, 'flatdown'), R(42, 190, 14, 0.7),
      O(-25, 250, 0), O(20, 250, 0), B(-25, 275, 12, 0.4, 'wide'), R(20, 275, 27, 0.5, 'kink'),
      R(-36, 330, 16, 0.5, 'rainbow', 0.2), B(-8, 335, 20, 0.6), R(18, 330, 22, 0.45, 'straight', -0.2), K(44, 320, 1),
      T(-55, 150, 1), T(55, 230, 1.2), T(0, 300, 0.9),
    ],
  },
  {
    id: 'sendline', name: 'Send Line', length: 800, width: 160, slope: 0.36, bumps: 0.5, seed: 27, sky: 'dusk',
    objects: [
      J(0, 80, 1), J(0, 200, 2), J(0, 350, 2), J(0, 510, 2), K(0, 660, 2),
      K(-45, 130, 1), J(-45, 250, 1), J(-45, 420, 1), R(-45, 560, 30, 0.6, 'z'),
      B(45, 120, 20), K(45, 240, 1), R(45, 262, 24, 1.1), J(45, 400, 1), B(45, 560, 26, 0.5, 'flatdown', -0.15),
      T(-22, 180, 1.3), T(-24, 330, 1), T(22, 190, 1.1), T(24, 450, 1.4), T(-20, 600, 1),
    ],
  },
  along({ id: 'gulch', name: 'Thunder Gulch', length: 1900, width: 86, slope: 0.34, bumps: 0.6, curve: 1, seed: 5, sky: 'golden' }, [
    O(0, 90, 0), O(0, 120, 0), O(0, 150, 0), J(0, 230, 1), K(-18, 330, 1), R(18, 330, 22, 0.5, 'kink'),
    J(0, 440, 2), O(-10, 560, 1), O(10, 600, 1), K(0, 680, 2), B(-16, 760, 26, 0.6, 'flatdown'), R(16, 770, 20, 0.6, 'rainbow'),
    J(0, 880, 2), K(-14, 1010, 1), K(14, 1040, 1), J(0, 1130, 1), O(0, 1230, 2), R(0, 1290, 34, 0.7, 'z'),
    J(0, 1400, 2), K(-16, 1540, 2), B(16, 1540, 24, 0.5, 'wide'), J(0, 1650, 2), O(0, 1790, 1),
  ]),
  along({ id: 'switchback', name: 'Midnight Switchback', length: 1500, width: 100, slope: 0.38, bumps: 0.45, curve: 0.8, seed: 14, sky: 'dusk' }, [
    K(0, 80, 1), J(0, 170, 1), R(-20, 290, 24, 0.5, 'rainbow'), B(20, 290, 24, 0.5, 'flatdown'), J(0, 400, 2),
    O(0, 540, 1), O(0, 580, 1), O(0, 620, 1), K(-20, 700, 2), K(20, 720, 2), J(0, 830, 2),
    R(0, 980, 36, 0.8, 'kink'), J(-18, 1090, 1), J(18, 1090, 1), K(0, 1230, 3), O(0, 1350, 2),
  ]),
  { id: 'bowl', name: 'Backcountry Bowl', length: 2200, width: 280, slope: 0.42, bumps: 1, curve: 0.5, powder: true, trees: 0.6, cliffs: 0.7, seed: 41, sky: 'bluebird', objects: [] },
  { id: 'glades', name: 'Deep Glades', length: 1600, width: 220, slope: 0.36, bumps: 0.8, curve: 0.9, powder: true, trees: 1, cliffs: 0.35, seed: 63, sky: 'golden', objects: [] },
].map(sanitizeMap);

const KEY = 'sidehit.maps', BEST = 'sidehit.best';
const read = (k, def) => { try { return JSON.parse(localStorage.getItem(k)) || def; } catch { return def; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } };

export function loadCustom() {
  const out = [];
  for (const m of read(KEY, [])) { try { out.push(sanitizeMap(m)); } catch { /* skip broken entry */ } }
  return out;
}
export const saveCustom = (maps) => write(KEY, maps);
export const getBest = (id) => read(BEST, {})[id] || 0;
export function setBest(id, score) {
  const all = read(BEST, {});
  all[id] = score;
  write(BEST, all);
}
export const isBuiltin = (map) => BUILTIN.some((b) => b.id === map.id);
