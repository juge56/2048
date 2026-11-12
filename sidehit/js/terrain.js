// Turns a map into a rideable hill: height field, feature meshes, trees, ray casting.
import * as THREE from '../vendor/three.module.min.js';
import { centerX } from './maps.js';

export const KICKER = [{ H: 1.2, L: 7, w: 5 }, { H: 2.2, L: 11, w: 7 }, { H: 3.4, L: 15, w: 9 }, { H: 4.8, L: 19, w: 11 }];
export const ROLLER = [{ H: 0.8, L: 10, w: 8 }, { H: 1.5, L: 16, w: 10 }, { H: 2.4, L: 24, w: 14 }];
// Tabletop jumps: curved take-off (T), flat deck (D), sloped landing (R).
export const JUMP = [{ H: 2.0, T: 9, D: 6, R: 15, w: 9 }, { H: 3.0, T: 13, D: 9, R: 21, w: 11 }, { H: 4.2, T: 18, D: 13, R: 28, w: 13 }];
const SIDE = 130, CELL = 8, F = 5;   // F: numbers stored per forest tree
const UP = new THREE.Vector3(0, 1, 0);
const RAIL_SIZE = 1.35;   // rails and boxes stand taller and read better than their nominal height
const RAIL_COLOURS = [0xffc928, 0xff3d7f, 0xff7a1a, 0x22c7e8, 0x8be04e];

function hash(ix, iz, s) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263) ^ Math.imul((s | 0) + 977, 1274126177);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x, z, s) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = hash(ix, iz, s), b = hash(ix + 1, iz, s), c = hash(ix, iz + 1, s), d = hash(ix + 1, iz + 1, s);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
}
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
// integral of a smoothstep that starts at `a` and takes `w` metres to reach full slope
const ramp = (z, a, w) => { const t = (z - a) / w; return t <= 0 ? 0 : t >= 1 ? w / 2 + (z - a - w) : w * (t * t * t - (t * t * t * t) / 2); };

// Rock drops: the snow builds up level behind a rock face, then falls away.
export const DROP = [{ H: 1.6, L: 8, w: 7 }, { H: 2.8, L: 11, w: 9 }, { H: 4.2, L: 14, w: 12 }];
// Length and width of the snow a shaped feature covers.
export function bumpSize(o) {
  if (o.t === 'kicker') return { ...KICKER[o.s], len: KICKER[o.s].L };
  if (o.t === 'roller') return { ...ROLLER[o.s], len: ROLLER[o.s].L };
  if (o.t === 'drop') return { ...DROP[o.s], len: DROP[o.s].L };
  const j = JUMP[o.s];
  return { ...j, len: j.T + j.D + j.R };
}

// Centre and pick radius of an object, used by the editor.
export function footprint(o) {
  const sin = Math.sin(o.r || 0), cos = Math.cos(o.r || 0);
  let half = 0, rad = 2.5;
  if (o.t === 'rail' || o.t === 'box') { half = o.len / 2; rad = Math.max(half, 2.5); }
  else if (o.t !== 'tree') { const b = bumpSize(o); half = b.len / 2; rad = Math.max(half, b.w / 2); }
  return { x: o.x + sin * half, z: o.z + cos * half, rad };
}

// Flat-shaded triangle soup with a colour per face.
function facets(build) {
  const pos = [], col = [];
  build((a, b, c, rgb, shade = 1) => {
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (let k = 0; k < 3; k++) col.push(rgb[0] * shade, rgb[1] * shade, rgb[2] * shade);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

// A pine as stacked, slightly uneven tiers: dark green skirts with snow lying on top of each.
function pineGeometry(tiers, height, radius, seed, sides) {
  const N = sides || quality.treeSides, GREEN = [0.07, 0.23, 0.16], UNDER = [0.04, 0.13, 0.1], SNOW = [0.93, 0.96, 1], BARK = [0.26, 0.17, 0.11];
  const ring = (y, r, id, wobble) => {
    const out = [];
    for (let i = 0; i < N; i++) {
      const a = ((i + 0.5 * (id % 2)) / N) * Math.PI * 2, k = r * (1 + wobble * (hash(i, id, seed) - 0.5));
      out.push([Math.cos(a) * k, y + wobble * 0.5 * r * (hash(id, i, seed + 1) - 0.5), Math.sin(a) * k]);
    }
    return out;
  };
  return facets((tri) => {
    const band = (lo, hi, rgb, id) => {
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N, shade = 0.9 + 0.2 * hash(i, id, seed + 2);
        tri(lo[i], hi[i], lo[j], rgb, shade);
        tri(lo[j], hi[i], hi[j], rgb, shade);
      }
    };
    band(ring(-0.6, 0.26, 90, 0), ring(height * 0.22, 0.18, 91, 0), BARK, 90);
    for (let t = 0; t < tiers; t++) {
      const f = t / tiers, y0 = height * (0.15 + 0.78 * f), span = (height * 0.78 / tiers) * 1.55, r = radius * (1 - 0.74 * f);
      const skirt = ring(y0, r, t * 3, 0.3), mid = ring(y0 + span * 0.42, r * 0.56, t * 3 + 1, 0.18), top = ring(y0 + span, t === tiers - 1 ? 0.02 : r * 0.16, t * 3 + 2, 0);
      band(skirt, mid, GREEN, t * 3);
      band(mid, top, SNOW, t * 3 + 1);
      const hub = [0, y0 + 0.12 * r, 0];
      for (let i = 0; i < N; i++) tri(skirt[(i + 1) % N], hub, skirt[i], UNDER);   // underside of the tier
    }
  });
}

// A boulder: a knocked-about icosahedron, bare rock on the sides and snow on top.
function rockGeometry(seed) {
  const base = new THREE.IcosahedronGeometry(1, 0).toNonIndexed(), p = base.attributes.position;
  const at = (i) => {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), k = 0.75 + 0.5 * hash(Math.round(x * 50), Math.round(y * 50) + Math.round(z * 50) * 7, seed);
    return [x * k, Math.max(y * k * 0.72, -0.35), z * k];
  };
  return facets((tri) => {
    for (let i = 0; i < p.count; i += 3) {
      const a = at(i), b = at(i + 1), c = at(i + 2);
      const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), up = ny / (Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]) + 1e-6);
      tri(a, b, c, up > 0.42 ? [0.93, 0.96, 1] : [0.4, 0.41, 0.46], 0.85 + 0.3 * hash(i, 3, seed));
    }
  });
}

// Detail settings the app may lower on slower devices, before the first terrain is built.
export const quality = { trees: 1, treeSides: 7 };

// Sun glints: tiny crystals that flash as the camera moves past them.
export const sparkle = { value: 1 };
// Tiling textures painted with Higgsfield (see textures/), shared by every map.
const textureLoader = new THREE.TextureLoader();
function tiled(name) {
  const t = textureLoader.load('textures/' + name + '.webp');
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
const rockTex = { value: null };
function addSparkle(material) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSparkle = sparkle;
    shader.uniforms.uRock = rockTex;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSnowPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvSnowPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vSnowPos; uniform float uSparkle; uniform sampler2D uRock;
        float snowHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        // bare rock where the ground is too steep to hold snow (painted grey in the vertex colours)
        float rockiness = smoothstep(0.78, 0.5, vColor.g);
        if (rockiness > 0.0) {
          vec3 rock = texture2D(uRock, vec2(vSnowPos.x + vSnowPos.z, vSnowPos.y) * 0.12).rgb * 1.15;
          diffuseColor.rgb = mix(diffuseColor.rgb, rock, rockiness);
        }`)
      .replace('#include <opaque_fragment>', `
        vec3 toEye = cameraPosition - vSnowPos;
        float dist = length(toEye);
        vec3 cell = floor(vec3(vSnowPos.xz * 26.0, 0.0)) + floor(vec3(normalize(toEye).xz * 34.0, 1.0)).xzy;
        float glint = step(0.9935, snowHash(cell)) * smoothstep(34.0, 8.0, dist) * smoothstep(2.0, 5.0, dist) * uSparkle;
        outgoingLight += vec3(1.0, 0.97, 0.9) * glint * 1.6;
        #include <opaque_fragment>`);
  };
  return material;
}

// Fine surface detail for trees and boulders, which have no UVs: a texture is sampled at the
// fragment's world position, and only its brightness is used, so snow on the branches stays white.
function addDetail(material, tex, strength) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDetail = { value: tex };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorld;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 wp = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          wp = instanceMatrix * wp;
        #endif
        vWorld = (modelMatrix * wp).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorld; uniform sampler2D uDetail;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float lum = dot(texture2D(uDetail, vec2(vWorld.x + vWorld.z, vWorld.y) * 0.45).rgb, vec3(0.333));
        float amount = ${strength.toFixed(2)} * (1.0 - smoothstep(0.75, 0.92, vColor.g));
        diffuseColor.rgb *= mix(1.0, clamp(0.35 + 1.9 * lum, 0.55, 1.45), amount);`);
  };
  return material;
}

let shared = null;
function sharedAssets() {
  if (shared) return shared;
  const lam = (color, extra) => new THREE.MeshLambertMaterial({ color, ...extra });
  rockTex.value = tiled('rock');
  shared = {
    snow: addSparkle(new THREE.MeshLambertMaterial({ vertexColors: true, map: tiled('corduroy'), side: THREE.DoubleSide })),
    powder: addSparkle(new THREE.MeshLambertMaterial({ vertexColors: true, map: tiled('snow'), side: THREE.DoubleSide })),
    flags: [0x3ddc84, 0x2f8fff, 0xff4b4b, 0x1c1f28].map((c) => lam(c, { side: THREE.DoubleSide })),
    treeMat: addDetail(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), tiled('needles'), 0.9),
    rockMat: addDetail(new THREE.MeshLambertMaterial({ vertexColors: true }), rockTex.value, 1),
    // 0: broad pine, 1: tall slim pine, 2: boulder
    trees: [pineGeometry(3, 7, 2.2, 1), pineGeometry(4, 9.6, 1.5, 2), rockGeometry(3)],
    farTrees: [pineGeometry(1, 7, 2.2, 1, 4), pineGeometry(2, 9.6, 1.5, 2, 4), rockGeometry(3)],
    rails: RAIL_COLOURS.map((col) => new THREE.MeshStandardMaterial({ color: col, roughness: 0.35, metalness: 0.5 })),
    steel: new THREE.MeshStandardMaterial({ color: 0x3a4250, roughness: 0.5, metalness: 0.7 }),
    boxSides: RAIL_COLOURS.map((col) => lam(col)),
    boxTop: lam(0xf3f6fa),
    gate: lam(0xff3d7f),
    finish: lam(0x1b2a44),
    net: lam(0x9a6a45, { side: THREE.DoubleSide }),   // wooden fence
    tube: new THREE.CylinderGeometry(1, 1, 1, 12),
    ball: new THREE.SphereGeometry(1, 12, 8),
    cube: new THREE.BoxGeometry(1, 1, 1),
  };
  return shared;
}

export class Terrain {
  constructor(map) {
    this.map = map;
    this.a = sharedAssets();
    this.step = map.length > 1200 ? 5 : 4;
    this.group = new THREE.Group();
    this.objects = new THREE.Group();
    this.group.add(this.objects);
    this.meshOf = new Map();
    this.bumps = [];
    this.rails = [];
    this.forest = [];
    this.own = [];
    this.buildGround();
    this.compile();
    this.buildObjects();
  }

  center(z) { return centerX(this.map, z); }

  // ---- height field ----------------------------------------------------

  base(x, z) {
    const m = this.map, s = m.seed;
    let h = -m.slope * (ramp(z, -2, 18) - ramp(z, m.length - 40, 40));
    if (z < -4) h += (-z - 4) * 0.35;
    const fade = smooth((z - 10) / 40);
    h += m.bumps * fade * (2.6 * noise(x / 85, z / 85, s) + 0.5 * noise(x / 27, z / 27, s + 1));
    if (m.powder) {
      // wind-blown pillows and hollows
      const p = noise(x / 15, z / 15, s + 6);
      h += fade * (0.9 * p * Math.abs(p) + 0.1 * noise(x / 7, z / 7, s + 7));
    }
    if (m.cliffs) {
      // benches that end in a drop, strongest where the mask says so
      const q = z / 75 + 1.3 * noise(x / 95, z / 170, s + 9), f = q - Math.floor(q);
      const mask = smooth((noise(x / 150, z / 150, s + 11) + 0.25) / 0.35);
      h += m.cliffs * 6.5 * mask * fade * (f - smooth((f - 0.9) / 0.07)) * (1 - smooth((z - m.length + 120) / 80));
    }
    const a = Math.abs(x - centerX(m, z)) - m.width / 2;
    if (a > 0) {
      h += a < 40 ? 0.008 * a * a : 12.8 + 0.64 * (a - 40);
      const w = Math.min(a / 80, 1);
      h += w * w * (14 * noise(x / 110, z / 110, s + 3) + 3 * noise(x / 31, z / 31, s + 4));
    }
    return h;
  }

  // `over` extends take-offs slightly past the lip so normals sampled at the lip stay sane.
  height(x, z, over = 0) {
    let h = this.base(x, z);
    const bs = this.bumps;
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i], dx = x - b.x, dz = z - b.z;
      if (dx * dx + dz * dz > b.rad2) continue;
      const v = Math.abs(dx * b.cos - dz * b.sin);
      if (v >= b.hw) continue;
      const u = dx * b.sin + dz * b.cos;
      if (u <= 0 || u >= b.len + over) continue;
      const e = v < b.hw - b.edge ? 1 : 1 - smooth((v - (b.hw - b.edge)) / b.edge);
      if (b.type === 'roller') { if (u < b.len) h += b.H * (0.5 - 0.5 * Math.cos((u / b.len) * Math.PI * 2)) * e; }
      else if (b.type === 'drop') { if (u <= b.T + over) h += b.H * smooth(u / b.T) * e; }
      else if (u <= b.T + over) h += b.H * (u / b.T) ** 2 * e;
      else if (b.type === 'jump') {
        const d = u - b.T - b.D;
        h += 0.72 * b.H * (d < 0 ? 1 : 1 - smooth(d / b.R)) * e;
      }
    }
    return h;
  }

  normal(x, z, out) {
    const e = 0.35;
    out.set(this.height(x - e, z, 1) - this.height(x + e, z, 1), 2 * e, this.height(x, z - e, 1) - this.height(x, z + e, 1));
    return out.normalize();
  }

  // Where a ray meets the snow; returns false if it never does.
  raycast(origin, dir, out) {
    let t0 = 0, t1 = 0;
    const p = out;
    for (let t = 2; t < 3500; t += 2) {
      p.copy(origin).addScaledVector(dir, t);
      if (p.y < this.height(p.x, p.z)) { t0 = t - 2; t1 = t; break; }
    }
    if (!t1) return false;
    for (let i = 0; i < 12; i++) {
      const tm = (t0 + t1) / 2;
      p.copy(origin).addScaledVector(dir, tm);
      if (p.y < this.height(p.x, p.z)) t1 = tm; else t0 = tm;
    }
    return true;
  }

  // ---- derived data ----------------------------------------------------

  compile() {
    this.bumps.length = 0;
    this.rails.length = 0;
    this.grid = new Map();
    // obstacles: x, base height, z, radius, height (you can clear one by jumping over its top)
    const addSolid = (x, y, z, r, h) => {
      const k = Math.floor(x / CELL) + ',' + Math.floor(z / CELL);
      let cell = this.grid.get(k);
      if (!cell) this.grid.set(k, (cell = []));
      cell.push(x, y, z, r, h);
    };
    const addTree = (x, y, z, s) => addSolid(x, y, z, 0.3 + 0.3 * s, 5.5 * s);
    const f = this.forest;
    for (let i = 0; i < f.length; i += F) {
      if (f[i + 4] === 2) addSolid(f[i], f[i + 1], f[i + 2], 0.8 * f[i + 3], 0.6 * f[i + 3]);   // boulder
      else addTree(f[i], f[i + 1], f[i + 2], f[i + 3]);
    }
    for (const o of this.map.objects) {
      if (o.t === 'tree') addTree(o.x, this.base(o.x, o.z), o.z, o.s);
      else if (o.t !== 'rail' && o.t !== 'box') {
        const d = bumpSize(o);
        this.bumps.push({
          o, type: o.t, x: o.x, z: o.z, sin: Math.sin(o.r), cos: Math.cos(o.r), H: d.H, len: d.len, hw: d.w / 2,
          T: o.t === 'jump' ? d.T : d.len, D: d.D || 0, R: d.R || 0, edge: o.t === 'jump' ? 2.5 : 1.5, rad2: (d.len + 3) ** 2 + (d.w / 2) ** 2,
        });
      }
    }
    for (const o of this.map.objects) if (o.t === 'rail' || o.t === 'box') this.rails.push(this.railPath(o));
    // each rail gets a small take-off that ends just short of it, at rail height, so you can ride straight on
    for (const r of this.rails) {
      const o = r.o;
      if (o.lip === false) continue;
      const H = Math.max(r.h - 0.1, 0.25), L = Math.max(3.4, H * 5.5), w = (r.width || 0.5) + 2.8, back = L + 0.5;
      const sin = Math.sin(o.r), cos = Math.cos(o.r);
      r.lip = { o: null, type: 'kicker', x: o.x - sin * back, z: o.z - cos * back, sin, cos, H, len: L, hw: w / 2, T: L, D: 0, R: 0, edge: 1, rad2: (L + 3) ** 2 + (w / 2) ** 2 };
      this.bumps.push(r.lip);
    }
  }

  // A rail or box as a chain of straight segments the rider slides along.
  railPath(o) {
    const sin = Math.sin(o.r), cos = Math.cos(o.r), L = o.len, h = o.h * RAIL_SIZE;
    const at = (u, v, y) => {
      const x = o.x + u * sin + v * cos, z = o.z + u * cos - v * sin;
      return new THREE.Vector3(x, y === undefined ? this.height(x, z) + h : y, z);
    };
    let pts;
    if (o.k === 'rainbow') {
      // an arc that climbs and comes back down
      const a = at(0, 0), b = at(L, 0), rise = Math.min(1.5, L * 0.09), n = 10;
      pts = [];
      for (let i = 0; i <= n; i++) { const t = i / n; pts.push(at(t * L, 0, a.y + (b.y - a.y) * t + rise * Math.sin(t * Math.PI))); }
    } else if (o.k === 'z') {
      // straight, a diagonal step sideways, straight again
      pts = [at(0, 0), at(L * 0.36, 0), at(L * 0.64, 2), at(L, 2)];
    } else if (o.k === 'kink') {
      // down, flat, down
      const mid = at(L / 3, 0);
      pts = [at(0, 0), mid, at((2 * L) / 3, 0, mid.y), at(L, 0)];
    } else if (o.k === 'flatdown') {
      const a = at(0, 0);
      pts = [a, at(L / 2, 0, a.y), at(L, 0)];
    } else pts = [at(0, 0), at(L, 0)];
    const segs = [];
    let total = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const dir = pts[i + 1].clone().sub(pts[i]), len = dir.length();
      segs.push({ p0: pts[i], p1: pts[i + 1], dir: dir.divideScalar(len), len, s0: total });
      total += len;
    }
    const wide = o.t === 'box', width = wide ? (o.k === 'wide' ? 2.4 : 0.85) : 0;
    return { o, pts, segs, total, wide, width, h, reach: wide ? (o.k === 'wide' ? 1.9 : 1.3) : 1 };
  }

  hitTree(x, y, z) {
    for (let k = 0; k < 4; k++) {
      const cell = this.grid.get(Math.floor((x + (k & 1 ? 1.2 : -1.2)) / CELL) + ',' + Math.floor((z + (k & 2 ? 1.2 : -1.2)) / CELL));
      if (!cell) continue;
      for (let t = 0; t < cell.length; t += 5) {
        const dx = x - cell[t], dz = z - cell[t + 2], r = cell[t + 3];
        if (dx * dx + dz * dz < r * r && y < cell[t + 1] + cell[t + 4]) return { x: cell[t], z: cell[t + 2], r, rock: cell[t + 4] < 3 };
      }
    }
    return null;
  }

  // ---- meshes ----------------------------------------------------------

  buildGround() {
    const m = this.map, a = this.a, STEP = this.step, bend = m.curve ? 95 * m.curve : 0;
    const x0 = -m.width / 2 - SIDE - bend, z0 = -90;
    const nx = Math.ceil((m.width + 2 * (SIDE + bend)) / STEP), nz = Math.ceil((m.length + 240) / STEP);
    const W = nx + 1, M = W + 2;
    const hs = new Float32Array(M * (nz + 3));
    for (let j = 0; j < nz + 3; j++) for (let i = 0; i < M; i++) hs[j * M + i] = this.base(x0 + (i - 1) * STEP, z0 + (j - 1) * STEP);
    const count = W * (nz + 1);
    const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), col = new Float32Array(count * 3), uv = new Float32Array(count * 2);
    for (let j = 0; j <= nz; j++) {
      const z = z0 + j * STEP, c = centerX(m, z);
      for (let i = 0; i <= nx; i++) {
        const v = j * W + i, k = v * 3, q = (j + 1) * M + i + 1, x = x0 + i * STEP;
        pos[k] = x; pos[k + 1] = hs[q]; pos[k + 2] = z;
        const ax = hs[q - 1] - hs[q + 1], ay = 2 * STEP, az = hs[q - M] - hs[q + M], l = Math.hypot(ax, ay, az);
        nor[k] = ax / l; nor[k + 1] = ay / l; nor[k + 2] = az / l;
        // untracked snow gets stronger light and dark patches so the shape of the slope reads
        const shade = m.powder ? 0.9 + 0.07 * noise(x / 40, z / 40, m.seed + 8) + 0.05 * noise(x / 15, z / 15, m.seed + 6) : 0.94 + 0.06 * noise(x / 40, z / 40, m.seed + 8);
        // slightly bluer, unpisted snow outside the run
        const off = m.powder ? 0.6 : smooth((Math.abs(x - c) - m.width / 2) / 12);
        // bare rock on the steepest faces
        const rock = ay / l < 0.72 ? smooth((0.72 - ay / l) / 0.1) * 0.75 : 0;
        col[k] = ((0.93 - 0.05 * off) * (1 - rock) + 0.36 * rock) * shade;
        col[k + 1] = ((0.95 - 0.03 * off) * (1 - rock) + 0.36 * rock) * shade;
        col[k + 2] = (1 - rock + 0.4 * rock) * shade;
        uv[v * 2] = (x - c) / 5; uv[v * 2 + 1] = z / 5;   // one texture tile every 5 m, grooming lines down the fall line
      }
    }
    // split into bands down the hill so off-screen and far-off snow is skipped
    const attrs = { position: new THREE.BufferAttribute(pos, 3), normal: new THREE.BufferAttribute(nor, 3), color: new THREE.BufferAttribute(col, 3), uv: new THREE.BufferAttribute(uv, 2) };
    this.chunks = [];
    const BAND = 24;
    for (let j0 = 0; j0 < nz; j0 += BAND) {
      const j1 = Math.min(j0 + BAND, nz), idx = new Uint32Array(nx * (j1 - j0) * 6);
      let n = 0, lo = Infinity, hi = -Infinity;
      for (let j = j0; j < j1; j++) for (let i = 0; i < nx; i++) {
        const p = j * W + i, q = p + 1, r = p + W, s = r + 1;
        idx[n++] = p; idx[n++] = r; idx[n++] = q; idx[n++] = q; idx[n++] = r; idx[n++] = s;
      }
      for (let j = j0; j <= j1; j++) for (let i = 0; i <= nx; i += 3) { const y = pos[(j * W + i) * 3 + 1]; if (y < lo) lo = y; if (y > hi) hi = y; }
      const g = new THREE.BufferGeometry();
      for (const k in attrs) g.setAttribute(k, attrs[k]);
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(x0 + (nx * STEP) / 2, (lo + hi) / 2, z0 + ((j0 + j1) / 2) * STEP), Math.hypot((nx * STEP) / 2, ((j1 - j0) * STEP) / 2, (hi - lo) / 2) + 4);
      const mesh = new THREE.Mesh(g, m.powder ? a.powder : a.snow);
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.chunks.push(mesh);
      this.own.push(g);
    }
    this.vertexCount = count;

    // forest around the run, plus trees scattered inside it where the map asks for them;
    // each tree is x, y, z, scale, kind
    const f = this.forest, T = 9;
    f.length = 0;
    for (let gz = Math.floor(z0 / T); gz * T < m.length + 150; gz++) for (let gx = Math.floor(x0 / T); gx * T < -x0; gx++) {
      const x = (gx + 0.15 + 0.7 * hash(gx, gz, m.seed + 21)) * T, z = (gz + 0.15 + 0.7 * hash(gx, gz, m.seed + 22)) * T;
      const d = Math.abs(x - centerX(m, z)), side = d - m.width / 2;
      let p = (side > 5 ? 0.5 * smooth((side - 5) / 15) * (1 - 0.85 * smooth((side - 60) / 40)) : z < -16 || z > m.length + 70 ? 0.4 : 0) * quality.trees;
      if (!p && m.trees && side < -3 && z > 30 && z < m.length - 20 && !(z < 110 && d < 16)) {
        p = m.trees * 0.34 * smooth((noise(x / 60, z / 60, m.seed + 31) + 0.05) / 0.3);
      }
      if (hash(gx, gz, m.seed + 24) < p) f.push(x, this.base(x, z), z, 0.75 + hash(gx, gz, m.seed + 25) * 0.9, hash(gx, gz, m.seed + 26) < 0.35 ? 1 : 0);
      else if (z > 20 && ((side > 4 && side < 60) || (m.powder && side < -6 && !(z < 110 && d < 16))) && hash(gx, gz, m.seed + 27) < (side > 0 ? 0.05 : 0.012 + 0.03 * m.cliffs) * quality.trees) {
        const rx = (gx + 0.5) * T, rz = (gz + 0.5) * T;
        f.push(rx, this.base(rx, rz) + 0.1, rz, 0.7 + hash(gx, gz, m.seed + 28) * 1.5, 2);
      }
    }
    const mat = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3();
    const buckets = new Map();
    for (let t = 0; t < f.length; t += F) {
      const key = Math.floor(f[t + 2] / 110) * 3 + f[t + 4];
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(t);
    }
    this.forestMeshes = [];
    this.lod = [];
    for (const [key, list] of buckets) {
      const kind = ((key % 3) + 3) % 3, pair = { z: (Math.floor(key / 3) + 0.5) * 110 };
      for (const far of [false, true]) {
        const inst = new THREE.InstancedMesh((far ? a.farTrees : a.trees)[kind], kind === 2 ? a.rockMat : a.treeMat, list.length);
        list.forEach((t, i) => {
          q.setFromAxisAngle(UP, hash(t, 1, 2) * 6.28);
          mat.compose(v.set(f[t], f[t + 1], f[t + 2]), q, s.set(f[t + 3], f[t + 3] * (0.9 + 0.3 * hash(t, 3, 4)), f[t + 3]));
          inst.setMatrixAt(i, mat);
        });
        inst.castShadow = !far;
        inst.receiveShadow = !far;
        inst.computeBoundingSphere();
        this.group.add(inst);
        this.forestMeshes.push(inst);
        pair[far ? 'far' : 'near'] = inst;
      }
      this.lod.push(pair);
    }
    if (!m.powder) this.buildFence();
  }

  // Hide whatever is beyond the fog. Frustum culling handles the rest.
  cull(eye, far) {
    for (const c of this.chunks) {
      const b = c.geometry.boundingSphere;
      c.visible = b.center.distanceTo(eye) - b.radius < far;
    }
    // trees: full detail only in the bands of hillside close to the camera
    for (const t of this.lod) {
      const dz = Math.abs(t.z - eye.z) - 55, seen = dz < far;
      t.near.visible = seen && dz < 90;
      t.far.visible = seen && dz >= 90;
    }
  }

  // Orange safety netting down both sides of a groomed run.
  buildFence() {
    const m = this.map, a = this.a, pos = [], idx = [], posts = [];
    for (const side of [-1, 1]) {
      const start = pos.length / 3;
      let rows = 0;
      for (let z = 0; z <= m.length; z += 4, rows++) {
        const x = centerX(m, z) + side * (m.width / 2 + 3), y = this.base(x, z);
        // two wooden rails
        pos.push(x, y + 0.42, z, x, y + 0.6, z, x, y + 0.88, z, x, y + 1.06, z);
        posts.push(x, y + 0.45, z);
      }
      for (let i = 0; i < rows - 1; i++) for (const k of [0, 2]) { const p = start + i * 4 + k; idx.push(p, p + 1, p + 4, p + 4, p + 1, p + 5); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    this.group.add(new THREE.Mesh(g, a.net));
    this.own.push(g);
    const inst = new THREE.InstancedMesh(a.cube, a.net, posts.length / 3);
    const mat = new THREE.Matrix4();
    for (let i = 0; i < posts.length; i += 3) inst.setMatrixAt(i / 3, mat.makeScale(0.16, 1.5, 0.16).setPosition(posts[i], posts[i + 1], posts[i + 2]));
    inst.frustumCulled = false;
    this.group.add(inst);
    this.fencePosts = inst;
  }

  buildObjects() {
    for (const m of this.meshOf.values()) this.disposeMesh(m);
    this.meshOf.clear();
    this.objects.clear();
    for (const o of this.map.objects) this.addMesh(o);
    const m = this.map;
    this.objects.add(this.gate(m.spawn.x, m.spawn.z, this.a.gate), this.gate(centerX(m, m.length), m.length, this.a.finish));
  }

  gate(x, z, material) {
    const group = new THREE.Group(), half = 5.5;
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(this.a.cube, material);
      post.scale.set(0.25, 6.4, 0.25);
      post.position.set(x + s * half, this.base(x + s * half, z) + 2.9, z);
      post.castShadow = true;
      group.add(post);
    }
    const bar = new THREE.Mesh(this.a.cube, material);
    bar.scale.set(half * 2 + 0.25, 0.7, 0.25);
    bar.position.set(x, this.base(x, z) + 5.9, z);
    bar.castShadow = true;
    group.add(bar);
    return group;
  }

  // Rebuild one object after it moved (cheap enough to do while dragging).
  refreshObject(o) {
    this.compile();
    const old = this.meshOf.get(o);
    if (old) { this.objects.remove(old); this.disposeMesh(old); }
    this.addMesh(o);
  }

  addMesh(o) {
    let m;
    if (o.t === 'tree') {
      m = new THREE.Mesh(this.a.trees[hash(o.x * 10, o.z * 10, 6) < 0.35 ? 1 : 0], this.a.treeMat);
      m.position.set(o.x, this.base(o.x, o.z), o.z);
      m.scale.setScalar(o.s);
      m.rotation.y = hash(o.x * 10, o.z * 10, 5) * 6.28;
      m.castShadow = m.receiveShadow = true;
    } else if (o.t === 'rail' || o.t === 'box') {
      const r = this.rails.find((x) => x.o === o);
      m = this.railMesh(r);
      if (r.lip) m.add(this.bumpMesh(r.lip));
    }
    else {
      const b = this.bumps.find((x) => x.o === o);
      m = b.type === 'roller' ? this.bumpMesh(b) : b.type === 'drop' ? this.rockFace(b).add(this.bumpMesh(b)) : this.markers(b).add(this.bumpMesh(b));
    }
    this.meshOf.set(o, m);
    this.objects.add(m);
  }

  // Shaped snow: a fine patch laid over the coarse ground mesh.
  bumpMesh(b) {
    const w = b.hw * 2, nx = Math.ceil(w + 1), W = nx + 1, lipped = b.type !== 'roller';
    const us = [];
    for (let u = 0; u < b.T - 0.4; u += 1) us.push(u);
    if (lipped) us.push(b.T, b.T + 0.03);          // the lip, then the face behind it
    for (let u = b.T + 1; u < b.len - 0.4; u += 1) us.push(u);
    if (b.type !== 'kicker' && b.type !== 'drop') us.push(b.len);
    const pos = [], col = [], uv = [], idx = [];
    us.forEach((u, j) => {
      const lip = lipped && u === b.T, face = lipped && us[j - 1] === b.T;
      for (let i = 0; i <= nx; i++) {
        const v = -b.hw - 0.5 + (i / nx) * (w + 1);
        const x = b.x + u * b.sin + v * b.cos, z = b.z + u * b.cos - v * b.sin;
        // coloured markers at the edges of the take-off, as parks paint them
        const marker = lip && Math.abs(Math.abs(v) - (b.hw - b.edge)) < 0.45;
        pos.push(x, this.height(x, z) + 0.05, z);
        if (marker) col.push(0.1, 0.45, 1); else if (lip) col.push(1, 0.36, 0.2); else if (face) col.push(...(b.type === 'drop' ? [0.4, 0.41, 0.46] : [0.62, 0.7, 0.84])); else col.push(0.93, 0.95, 1);
        uv.push((x - this.center(z)) / 5, z / 5);
      }
    });
    for (let j = 0; j < us.length - 1; j++) for (let i = 0; i < nx; i++) {
      const p = j * W + i, q = p + 1, r = p + W, s = r + 1;
      idx.push(p, r, q, q, r, s);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, this.a.snow);
    m.receiveShadow = m.castShadow = true;
    m.userData.own = true;
    return m;
  }

  // Park steel: a round tube on splayed legs, or a box with a slick top sheet and metal edges.
  railMesh(r) {
    const a = this.a, group = new THREE.Group(), o = r.o;
    const tint = Math.floor(hash(o.x * 7, o.z * 7, 12) * RAIL_COLOURS.length);
    // parts are collected and baked into one mesh per material: far fewer draw calls
    const parts = [];
    const add = (geo, mat) => { const part = new THREE.Object3D(); parts.push({ geo, mat, part }); return part; };
    const tube = (p, q, rad, mat) => {
      const m = add(a.tube, mat), d = q.clone().sub(p), len = d.length();
      m.position.copy(p).addScaledVector(d, 0.5);
      m.quaternion.setFromUnitVectors(UP, d.divideScalar(len));
      m.scale.set(rad, len, rad);
      return m;
    };
    const ball = (p, rad, mat) => { const m = add(a.ball, mat); m.scale.setScalar(rad); m.position.copy(p); };
    const p = new THREE.Vector3(), foot = new THREE.Vector3(), top = new THREE.Vector3(), across = new THREE.Vector3(), basis = new THREE.Matrix4();
    let since = 4;
    if (!r.wide) ball(r.pts[0], 0.085, a.rails[tint]);
    for (const sg of r.segs) {
      across.crossVectors(UP, sg.dir).normalize();
      if (r.wide) {
        const q = new THREE.Quaternion().setFromRotationMatrix(basis.makeBasis(across, new THREE.Vector3().crossVectors(sg.dir, across), sg.dir));
        p.copy(sg.p0).add(sg.p1).multiplyScalar(0.5);
        const body = add(a.cube, a.boxSides[tint]);
        body.scale.set(r.width, 0.42, sg.len + 0.02);
        body.quaternion.copy(q);
        body.position.copy(p).y -= 0.23;
        const sheet = add(a.cube, a.boxTop);
        sheet.scale.set(r.width - 0.1, 0.03, sg.len);
        sheet.quaternion.copy(q);
        sheet.position.copy(p).y -= 0.012;
        // steel coping down both edges
        for (const s of [-1, 1]) {
          const off = across.clone().multiplyScalar(s * (r.width / 2 - 0.02));
          tube(sg.p0.clone().add(off), sg.p1.clone().add(off), 0.028, a.steel);
        }
      } else {
        tube(sg.p0, sg.p1, 0.085, a.rails[tint]);
        ball(sg.p1, 0.085, a.rails[tint]);
      }
      // legs with feet on the snow
      // one pair of legs roughly every four metres, however finely the rail is segmented
      since += sg.len;
      const legs = sg.len >= 3 ? Math.max(1, Math.round(sg.len / 4)) : since >= 4 ? 1 : 0, spread = r.wide ? r.width / 2 - 0.08 : 0.28;
      if (legs) since = 0;
      for (let k = 0; k < legs; k++) {
        p.copy(sg.p0).lerp(sg.p1, (k + 0.5) / legs);
        for (const s of [-1, 1]) {
          foot.copy(p).addScaledVector(across, s * spread);
          foot.y = this.base(foot.x, foot.z) - 0.05;
          if (r.wide) top.copy(foot).setY(p.y - 0.3); else top.copy(p).setY(p.y - 0.04);
          if (top.y - foot.y > 0.05) tube(foot, top, r.wide ? 0.05 : 0.03, a.steel);
          const pad = add(a.cube, a.steel);
          pad.scale.set(0.22, 0.03, 0.22);
          pad.position.copy(foot).y += 0.07;
        }
      }
    }
    return this.bake(parts, group);
  }

  // Bake loose parts into one mesh per material: far fewer draw calls.
  bake(parts, group) {
    const baked = new Map(), v = new THREE.Vector3(), nm = new THREE.Matrix3();
    for (const { geo, mat, part } of parts) {
      part.updateMatrix();
      nm.getNormalMatrix(part.matrix);
      let b = baked.get(mat);
      if (!b) baked.set(mat, (b = { pos: [], nor: [], idx: [] }));
      const start = b.pos.length / 3, P = geo.attributes.position, N = geo.attributes.normal;
      for (let i = 0; i < P.count; i++) {
        v.fromBufferAttribute(P, i).applyMatrix4(part.matrix);
        b.pos.push(v.x, v.y, v.z);
        v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
        b.nor.push(v.x, v.y, v.z);
      }
      for (let i = 0; i < geo.index.count; i++) b.idx.push(start + geo.index.getX(i));
    }
    for (const [mat, b] of baked) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
      g.setIndex(b.idx);
      const mesh = new THREE.Mesh(g, mat);
      mesh.castShadow = true;
      mesh.userData.own = true;
      group.add(mesh);
    }
    return group;
  }

  // Boulders packed under the lip of a rock drop.
  rockFace(b) {
    const group = new THREE.Group(), n = Math.max(2, Math.round(b.hw * 2 / 3));
    for (let i = 0; i < n; i++) {
      const v = -b.hw + (i + 0.5) * (b.hw * 2 / n), u = b.T - 0.9;
      const x = b.x + u * b.sin + v * b.cos, z = b.z + u * b.cos - v * b.sin, y = this.base(x, z);
      const rock = new THREE.Mesh(this.a.trees[2], this.a.rockMat);
      rock.position.set(x, y + b.H * 0.25, z);
      rock.scale.set(b.hw * 2 / n * 0.72, b.H * 0.78, 1.5 + 0.5 * hash(i, b.x, 7));
      rock.rotation.y = Math.atan2(b.sin, b.cos) + (hash(i, b.z, 8) - 0.5) * 0.5;
      rock.castShadow = rock.receiveShadow = true;
      group.add(rock);
    }
    return group;
  }

  // Flags at the corners of a take-off, coloured by size like trail ratings.
  markers(b) {
    const a = this.a, parts = [], group = new THREE.Group();
    const size = b.o.t === 'kicker' ? b.o.s : b.o.s + 1, flag = a.flags[Math.min(size, 3)];
    for (const s of [-1, 1]) {
      const v = s * (b.hw - b.edge + 0.7), u = b.T - 0.4;
      const x = b.x + u * b.sin + v * b.cos, z = b.z + u * b.cos - v * b.sin, y = this.height(x, z);
      const pole = new THREE.Object3D();
      pole.position.set(x, y + 0.85, z);
      pole.scale.set(0.06, 1.9, 0.06);
      parts.push({ geo: a.cube, mat: a.steel, part: pole });
      const cloth = new THREE.Object3D();
      cloth.position.set(x + b.sin * 0.3, y + 1.55, z + b.cos * 0.3);
      cloth.rotation.y = Math.atan2(b.sin, b.cos);
      cloth.scale.set(0.025, 0.36, 0.6);
      parts.push({ geo: a.cube, mat: flag, part: cloth });
    }
    return this.bake(parts, group);
  }

  disposeMesh(m) { m.traverse((o) => { if (o.userData.own) o.geometry.dispose(); }); }

  dispose() {
    for (const m of this.meshOf.values()) this.disposeMesh(m);
    for (const g of this.own) g.dispose();
    for (const f of this.forestMeshes) f.dispose();
    if (this.fencePosts) this.fencePosts.dispose();
    this.group.removeFromParent();
  }
}
