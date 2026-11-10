// Map format, built-in parks, validation and browser storage.
//
// A map is plain JSON:
//   { id, name, length, width, slope, bumps, seed, sky, spawn: {x, z}, objects: [...] }
// Objects: { t: 'kicker' | 'roller' | 'rail' | 'box' | 'tree', x, z, r, s, len, h }
//   r   heading in radians (0 points straight down the hill)
//   s   size step for kickers and rollers, scale for trees
//   len, h   length and height above the snow for rails and boxes

export const SKIES = ['bluebird', 'golden', 'dusk'];
export const TYPES = ['kicker', 'roller', 'rail', 'box', 'tree'];
export const MAX_OBJECTS = 160;

const num = (v, lo, hi, def) => (Number.isFinite(+v) ? Math.min(Math.max(+v, lo), hi) : def);

export function sanitizeObject(o, map) {
  if (!o || !TYPES.includes(o.t)) return null;
  const out = {
    t: o.t,
    x: num(o.x, -map.width / 2 - 20, map.width / 2 + 20, 0),
    z: num(o.z, 0, map.length + 40, 50),
  };
  if (o.t !== 'tree') out.r = num(o.r, -Math.PI, Math.PI, 0);
  if (o.t === 'kicker') out.s = Math.round(num(o.s, 0, 3, 1));
  if (o.t === 'roller') out.s = Math.round(num(o.s, 0, 2, 1));
  if (o.t === 'tree') out.s = num(o.s, 0.6, 2, 1);
  if (o.t === 'rail' || o.t === 'box') {
    out.len = num(o.len, 6, 40, 14);
    out.h = num(o.h, 0.3, 1.5, 0.5);
  }
  return out;
}

// Accepts anything (including pasted text from a stranger) and returns a safe map.
export function sanitizeMap(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Not a map');
  const map = {
    id: typeof raw.id === 'string' ? raw.id.slice(0, 40) : newId(),
    name: String(raw.name || 'Untitled park').slice(0, 40),
    length: num(raw.length, 250, 1000, 520),
    width: num(raw.width, 80, 240, 140),
    slope: num(raw.slope, 0.14, 0.5, 0.28),
    bumps: num(raw.bumps, 0, 1, 0.4),
    seed: Math.round(num(raw.seed, 0, 9999, 1)),
    sky: SKIES.includes(raw.sky) ? raw.sky : 'bluebird',
    objects: [],
  };
  map.spawn = { x: num(raw.spawn && raw.spawn.x, -map.width / 2, map.width / 2, 0), z: num(raw.spawn && raw.spawn.z, 2, map.length - 60, 6) };
  for (const o of Array.isArray(raw.objects) ? raw.objects.slice(0, MAX_OBJECTS) : []) {
    const s = sanitizeObject(o, map);
    if (s) map.objects.push(s);
  }
  return map;
}

export const newId = () => 'm' + Math.random().toString(36).slice(2, 10);

export function blankMap() {
  return sanitizeMap({ name: 'My park', objects: [{ t: 'kicker', x: 0, z: 90, r: 0, s: 1 }] });
}

const K = (x, z, s, r = 0) => ({ t: 'kicker', x, z, s, r });
const O = (x, z, s, r = 0) => ({ t: 'roller', x, z, s, r });
const R = (x, z, len, h = 0.45, r = 0) => ({ t: 'rail', x, z, len, h, r });
const B = (x, z, len, h = 0.5, r = 0) => ({ t: 'box', x, z, len, h, r });
const T = (x, z, s = 1) => ({ t: 'tree', x, z, s });

export const BUILTIN = [
  {
    id: 'warmup', name: 'Warm-Up Lap', length: 540, width: 140, slope: 0.28, bumps: 0.35, seed: 3, sky: 'bluebird',
    objects: [
      K(-22, 70, 0), K(-22, 150, 1), K(-22, 245, 2), K(-22, 355, 2), O(-22, 440, 1),
      R(18, 85, 14), B(24, 165, 16), R(16, 255, 22, 0.5), B(30, 335, 14, 0.6, 0.25), R(20, 420, 18),
      K(48, 120, 0, -0.15), K(46, 290, 1),
      T(-2, 110, 1.1), T(1, 118, 0.8), T(-1, 205, 1.2), T(3, 300, 1), T(0, 312, 0.8), T(-3, 400, 1.3),
    ],
  },
  {
    id: 'jibs', name: 'Jib Garden', length: 430, width: 130, slope: 0.25, bumps: 0.2, seed: 11, sky: 'golden',
    objects: [
      R(-30, 60, 12), B(-10, 62, 12), R(10, 60, 16, 0.6), B(30, 62, 14, 0.4),
      K(-30, 110, 0), R(-30, 128, 20, 0.9), K(12, 112, 0), B(12, 130, 18, 1.0),
      R(-40, 190, 18, 0.45, 0.35), R(-12, 190, 18, 0.45, -0.35), B(22, 185, 24, 0.5), R(42, 190, 14, 0.7),
      O(-25, 250, 0), O(20, 250, 0), B(-25, 275, 12, 0.4), R(20, 275, 26, 0.5),
      R(-36, 330, 16, 0.5, 0.2), B(-8, 335, 20, 0.6), R(18, 330, 22, 0.45, -0.2), K(44, 320, 1),
      T(-55, 150, 1), T(55, 230, 1.2), T(0, 300, 0.9),
    ],
  },
  {
    id: 'sendline', name: 'Send Line', length: 760, width: 160, slope: 0.36, bumps: 0.5, seed: 27, sky: 'dusk',
    objects: [
      K(0, 90, 2), O(0, 150, 2), K(0, 220, 3), O(0, 290, 2), K(0, 370, 3), K(0, 500, 3), O(0, 570, 2), K(0, 640, 2),
      K(-45, 130, 1), K(-45, 260, 2), K(-45, 420, 2), R(-45, 540, 30, 0.6),
      B(45, 120, 20), K(45, 240, 1), R(45, 262, 24, 1.1), K(45, 400, 2), B(45, 560, 26, 0.5, -0.15),
      T(-22, 180, 1.3), T(-24, 330, 1), T(22, 190, 1.1), T(24, 450, 1.4), T(-20, 600, 1),
    ],
  },
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
