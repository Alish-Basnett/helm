// qr.js — a small QR Code encoder (ISO 18004): byte mode, error correction level M, versions 1-10 (up to 213 bytes).
// Pure functions, no DOM, no dependencies. Used by Settings to pair a phone. Returns null when the text does not fit.

/* ---------- GF(256) + Reed-Solomon ---------- */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsGenerator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= mul(g[j], EXP[i]); }
    g = next;
  }
  return g;
}
export function rsEncode(data, n) {
  const g = rsGenerator(n);
  const res = data.concat(new Array(n).fill(0));
  for (let i = 0; i < data.length; i++) {
    const c = res[i];
    if (c) for (let j = 1; j < g.length; j++) res[i + j] ^= mul(g[j], c);
  }
  return res.slice(data.length);
}

/* ---------- level M tables: version -> { ec codewords per block, blocks: [count, data codewords][] } ---------- */
const M = {
  1: { ec: 10, blocks: [[1, 16]] },
  2: { ec: 16, blocks: [[1, 28]] },
  3: { ec: 26, blocks: [[1, 44]] },
  4: { ec: 18, blocks: [[2, 32]] },
  5: { ec: 24, blocks: [[2, 43]] },
  6: { ec: 16, blocks: [[4, 27]] },
  7: { ec: 18, blocks: [[4, 31]] },
  8: { ec: 22, blocks: [[2, 38], [2, 39]] },
  9: { ec: 22, blocks: [[3, 36], [2, 37]] },
  10: { ec: 26, blocks: [[4, 43], [1, 44]] },
};
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
const dataCodewords = (v) => M[v].blocks.reduce((a, [n, k]) => a + n * k, 0);

/** Largest payload (bytes) that fits. */
export const QR_MAX_BYTES = 213;

/* ---------- bit helpers ---------- */
const bitLen = (n) => 32 - Math.clz32(n);
function bch(value, poly, bits) { // append `bits` check bits (BCH remainder)
  let rem = value << bits;
  const pl = bitLen(poly);
  while (bitLen(rem) >= pl) rem ^= poly << (bitLen(rem) - pl);
  return (value << bits) | rem;
}

/** Data codewords (mode + length + bytes + terminator + padding) for `bytes` at version `v`. */
function buildData(bytes, v) {
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, v >= 10 ? 16 : 8);
  for (const b of bytes) put(b, 8);
  const cap = dataCodewords(v) * 8;
  put(0, Math.min(4, cap - bits.length));
  while (bits.length % 8) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; out.push(b); }
  for (let pad = 0xec; out.length < dataCodewords(v); pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/** Split into blocks, add EC, interleave: the final codeword sequence. */
function interleave(data, v) {
  const { ec, blocks } = M[v];
  const dBlocks = [];
  let pos = 0;
  for (const [count, k] of blocks) for (let i = 0; i < count; i++) { dBlocks.push(data.slice(pos, pos + k)); pos += k; }
  const eBlocks = dBlocks.map((b) => rsEncode(b, ec));
  const out = [];
  const maxD = Math.max(...dBlocks.map((b) => b.length));
  for (let i = 0; i < maxD; i++) for (const b of dBlocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ec; i++) for (const b of eBlocks) out.push(b[i]);
  return out;
}

/* ---------- matrix ---------- */
const MASKS = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => ((((i + j) % 2) + ((i * j) % 3)) % 2) === 0,
];

function penalty(m) {
  const n = m.length;
  let p = 0;
  const line = (get) => { // runs + finder-like patterns along one line
    let run = 1;
    for (let k = 1; k < n; k++) {
      if (get(k) === get(k - 1)) run++;
      else { if (run >= 5) p += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) p += 3 + (run - 5);
    for (let k = 0; k + 11 <= n; k++) {
      let a = true, b = true;
      const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
      for (let t = 0; t < 11 && (a || b); t++) { const v = get(k + t) ? 1 : 0; if (v !== A[t]) a = false; if (v !== B[t]) b = false; }
      if (a) p += 40;
      if (b) p += 40;
    }
  };
  for (let r = 0; r < n; r++) line((c) => m[r][c]);
  for (let c = 0; c < n; c++) line((r) => m[r][c]);
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) {
    const v = m[r][c];
    if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) p += 3;
  }
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  p += 10 * Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5);
  return p;
}

function build(codewords, v) {
  const size = 17 + 4 * v;
  const mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { mod[y][x] = !!dark; fn[y][x] = true; }; // x = column, y = row

  // timing
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  // finders + separators
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  // alignment
  const al = ALIGN[v];
  for (let a = 0; a < al.length; a++) for (let b = 0; b < al.length; b++) {
    if ((a === 0 && b === 0) || (a === 0 && b === al.length - 1) || (a === al.length - 1 && b === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[a] + dx, al[b] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  // reserve format + version areas (drawn properly later)
  const formatBits = (mask) => bch((0 << 3) | mask, 0x537, 10) ^ 0x5412; // level M = 00
  const drawFormat = (mask) => {
    const bits = formatBits(mask);
    const bit = (i) => (bits >>> i) & 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (v >= 7) {
    const bits = bch(v, 0x1f25, 12);
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3), b = Math.floor(i / 3), d = (bits >>> i) & 1;
      set(a, b, d); set(b, a, d);
    }
  }
  // data, zig-zag
  let i = 0;
  const total = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!fn[y][x] && i < total) { mod[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
      }
    }
  }
  // choose the best mask
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const cand = mod.map((row) => row.slice());
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[mask](y, x)) cand[y][x] = !cand[y][x];
    // write format bits for this mask into the candidate
    const bits = formatBits(mask);
    const bit = (k) => ((bits >>> k) & 1) === 1;
    const put = (x, y, d) => { cand[y][x] = d; };
    for (let k = 0; k <= 5; k++) put(8, k, bit(k));
    put(8, 7, bit(6)); put(8, 8, bit(7)); put(7, 8, bit(8));
    for (let k = 9; k < 15; k++) put(14 - k, 8, bit(k));
    for (let k = 0; k < 8; k++) put(size - 1 - k, 8, bit(k));
    for (let k = 8; k < 15; k++) put(8, size - 15 + k, bit(k));
    put(8, size - 8, true);
    const score = penalty(cand);
    if (!best || score < best.score) best = { score, cand, mask };
  }
  return best.cand;
}

/** The module matrix (rows of booleans, true = dark) for `text` (UTF-8), or null when it exceeds 213 bytes. */
export function qrMatrix(text) {
  const bytes = Array.from(new TextEncoder().encode(String(text)));
  for (let v = 1; v <= 10; v++) {
    const need = 4 + (v >= 10 ? 16 : 8) + bytes.length * 8;
    if (need > dataCodewords(v) * 8) continue;
    return build(interleave(buildData(bytes, v), v), v);
  }
  return null;
}

/** Single SVG path (1 unit per module, `margin` modules of quiet zone) for `text`, or null. */
export function qrPath(text, margin = 4) {
  const m = qrMatrix(text);
  if (!m) return null;
  let d = '';
  for (let y = 0; y < m.length; y++) {
    let x = 0;
    while (x < m.length) {
      if (!m[y][x]) { x++; continue; }
      let e = x;
      while (e < m.length && m[y][e]) e++;
      d += `M${x + margin} ${y + margin}h${e - x}v1h${x - e}z`;
      x = e;
    }
  }
  const size = m.length + margin * 2;
  return { d, size };
}
