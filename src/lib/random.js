// Small deterministic PRNG helpers so demo data is stable across requests.

export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seeded(...parts) {
  return mulberry32(hashString(parts.join('|')));
}

export function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

export function intBetween(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}
