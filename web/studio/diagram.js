// studio/diagram.js — the Studio `diagram` block: a tiny text DSL, a parser, an automatic layout and two SVG back ends.
// Pure and dependency free (no DOM, no clock, no randomness), so the browser, the hub (judging and export) and node:test all load
// the same file. The DOM renderer is in diagramdom.js; the string renderer for export is `diagramSvgString` below, and both walk
// the same list of drawing primitives (`diagramPrims`), so what you edit is what you export.
//
// The DSL (one statement per line, or separated by `;`; `#` and `//` start a comment line):
//
//   dir LR                                  direction: TB (top to bottom, the default) or LR (left to right)
//   group "Hub" { a[Mod] -> b[Hub] }        a titled box around nodes; the body may span lines; groups do not nest
//   b -> c[(DB)] : events                   edge with an optional label after `:`; chains work: a -> b -> c
//   a --> d                                 a dashed edge
//
// Nodes: `id[Label]` box, `id(Label)` rounded, `id[(Label)]` database, `id{Label}` diamond, or just `id` (a box labelled id).
// Ids are letters, digits and `_`. A label is plain text up to the closing bracket, or "quoted" when it needs brackets or quotes.
// A node is declared where it is first written with a label; later mentions can use the bare id. In a chain the label after
// `:` belongs to the last edge. A node written inside a group belongs to that group.

export const DIAGRAM_MAX_SOURCE = 8000;
export const MAX_NODES = 60;
export const MAX_EDGES = 120;
export const MAX_GROUPS = 12;
export const MAX_LABEL = 80;
export const MAX_ERRORS = 20;
export const SHAPES = ['box', 'round', 'db', 'diamond'];
/** What a new, empty diagram block starts with. */
export const DIAGRAM_STARTER = 'dir LR\ngroup "Hub" { mod[Mod] -> hub[Hub] }\nhub -> db[(Events)] : store\nhub --> ui(Web UI) : stream';

const ID_START = /[A-Za-z_]/;
const ID_CHAR = /[A-Za-z0-9_]/;
const clipLabel = (s) => (s.length > MAX_LABEL ? s.slice(0, MAX_LABEL - 1) + '…' : s);

// ------------------------------------------------------------------------------ parser
/**
 * Parse DSL text. Never throws. Returns { dir, nodes, edges, groups, errors }:
 *   nodes  [{ id, label, shape, group }]            group is a group id (g1, g2, …) or null
 *   edges  [{ from, to, label, dashed }]
 *   groups [{ id, title, nodes: [nodeId] }]
 *   errors [{ line, message }]                      empty when the diagram is valid (and has at least one node)
 */
export function parseDiagram(src) {
  const text = String(src ?? '').replace(/\r\n?/g, '\n');
  const out = { dir: 'TB', nodes: [], edges: [], groups: [], errors: [] };
  const err = (message, line) => { if (out.errors.length < MAX_ERRORS) out.errors.push({ line, message }); };
  if (text.length > DIAGRAM_MAX_SOURCE) { err(`the diagram source is longer than ${DIAGRAM_MAX_SOURCE} characters`, 1); return out; }
  const byId = new Map();
  const explicit = new Set();           // nodes whose label/shape was written with brackets
  let i = 0;
  const lineAt = (pos) => { let n = 1; for (let k = 0; k < pos && k < text.length; k++) if (text[k] === '\n') n++; return n; };
  const ws = () => { while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++; };
  const atEnd = () => i >= text.length;
  const skipToEnd = (inGroup) => { while (i < text.length && text[i] !== '\n' && text[i] !== ';' && !(inGroup && text[i] === '}')) i++; };

  /** A "quoted" string starting at i (text[i] === '"'). Returns the string, or null when it is not closed on this line. */
  const quoted = () => {
    let s = '';
    i++;
    while (i < text.length && text[i] !== '\n') {
      if (text[i] === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) { s += text[i + 1]; i += 2; continue; }
      if (text[i] === '"') { i++; return s; }
      s += text[i++];
    }
    return null;
  };
  const readId = () => {
    if (!ID_START.test(text[i] || '')) return null;
    const s = i;
    while (i < text.length && ID_CHAR.test(text[i])) i++;
    return text.slice(s, i);
  };
  /** `[Label]`, `[(Label)]`, `(Label)` or `{Label}` right after an id. Returns { label, shape } | null (no bracket) | false (error reported). */
  const readShape = (line) => {
    const save = i;
    ws();
    const c = text[i];
    let open, close, shape;
    if (c === '[' && text[i + 1] === '(') { open = '[('; close = ')]'; shape = 'db'; }
    else if (c === '[') { open = '['; close = ']'; shape = 'box'; }
    else if (c === '(') { open = '('; close = ')'; shape = 'round'; }
    else if (c === '{') { open = '{'; close = '}'; shape = 'diamond'; }
    else { i = save; return null; }
    i += open.length;
    ws();
    let label;
    if (text[i] === '"') {
      label = quoted();
      if (label === null) { err('unterminated "quoted" label', line); return false; }
      ws();
      if (!text.startsWith(close, i)) { err(`expected ${close} after the label`, line); return false; }
      i += close.length;
    } else {
      const s = i;
      while (i < text.length && text[i] !== '\n' && !text.startsWith(close, i)) i++;
      if (!text.startsWith(close, i)) { err(`missing ${close} to close the label`, line); return false; }
      label = text.slice(s, i).trim();
      i += close.length;
    }
    return { label: clipLabel(label), shape };
  };

  let groupSeq = 0;
  const declare = (id, shaped, group, line) => {
    let n = byId.get(id);
    if (!n) {
      if (out.nodes.length >= MAX_NODES) { err(`too many nodes (at most ${MAX_NODES})`, line); return null; }
      n = { id, label: id, shape: 'box', group: null };
      byId.set(id, n);
      out.nodes.push(n);
    }
    if (shaped) {
      const label = shaped.label || id;
      if (explicit.has(id) && (n.label !== label || n.shape !== shaped.shape)) err(`node ${id} is already defined as ${n.label} (${n.shape}); use the bare id to refer to it`, line);
      else { n.label = label; n.shape = shaped.shape; explicit.add(id); }
    }
    if (group) {
      if (n.group && n.group !== group.id) err(`node ${id} is in two groups (${out.groups.find((g) => g.id === n.group).title} and ${group.title})`, line);
      else if (!n.group) { n.group = group.id; group.nodes.push(id); }
    }
    return n;
  };
  const readRef = (group) => {
    const line = lineAt(i);
    const id = readId();
    if (!id) { err(`expected a node id, found ${text[i] === undefined || text[i] === '\n' ? 'the end of the line' : `"${text[i]}"`}`, line); return null; }
    const shaped = readShape(line);
    if (shaped === false) return null;
    return declare(id, shaped, group, line);
  };

  /** A statement list up to `}` (inside a group) or the end of the text. */
  const block = (group, depth) => {
    for (;;) {
      while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === ';')) i++;
      if (atEnd()) { if (group) err(`group "${group.title}" is not closed (missing })`, group.line); return; }
      if (text[i] === '}') {
        i++;
        if (group) { if (!group.nodes.length) err(`group "${group.title}" is empty`, group.line); return; }
        err('unexpected }', lineAt(i - 1));
        continue;
      }
      if (text[i] === '#' || (text[i] === '/' && text[i + 1] === '/')) { while (i < text.length && text[i] !== '\n') i++; continue; }
      const line = lineAt(i);
      const start = i;
      const word = readId();
      // keywords only count when they are followed by their operand, so `dir` and `group` stay usable as node ids
      const dirOp = word === 'dir' ? /^[ \t]+([A-Za-z]+)[ \t]*(?=$|\n|;|#|\})/.exec(text.slice(i)) : null;
      if (dirOp) {
        i += dirOp[0].length;
        if (dirOp[1] === 'LR') out.dir = 'LR';
        else if (dirOp[1] === 'TB' || dirOp[1] === 'TD') out.dir = 'TB';
        else err(`dir must be TB or LR, not "${dirOp[1]}"`, line);
        if (group) err('dir belongs at the top, outside any group', line);
        continue;
      }
      if (word === 'group' && /^[ \t]+"/.test(text.slice(i, i + 6))) {
        ws();
        const title = quoted();
        if (title === null) { err('unterminated "quoted" group title', line); skipToEnd(!!group); continue; }
        ws();
        if (text[i] !== '{') { err('expected { after the group title', line); skipToEnd(!!group); continue; }
        i++;
        if (group) err('groups cannot be nested', line);
        if (out.groups.length >= MAX_GROUPS) { err(`too many groups (at most ${MAX_GROUPS})`, line); }
        const g = { id: `g${++groupSeq}`, title: clipLabel(title.trim() || 'Group'), nodes: [], line };
        out.groups.push(g);
        block(g, depth + 1);
        continue;
      }
      i = start;
      // node statement or edge chain
      const first = readRef(group);
      if (!first) { skipToEnd(!!group); continue; }
      const refs = [first];
      const dashes = [];
      let bad = false;
      for (;;) {
        ws();
        const arrow = text.startsWith('-->', i) ? '-->' : text.startsWith('->', i) ? '->' : null;
        if (!arrow) break;
        i += arrow.length;
        ws();
        const next = readRef(group);
        if (!next) { bad = true; break; }
        refs.push(next); dashes.push(arrow === '-->');
      }
      if (bad) { skipToEnd(!!group); continue; }
      let label = '';
      ws();
      if (text[i] === ':') {
        i++;
        ws();
        if (text[i] === '"') {
          const q = quoted();
          if (q === null) { err('unterminated "quoted" edge label', line); skipToEnd(!!group); continue; }
          label = q;
        } else {
          const s = i;
          while (i < text.length && text[i] !== '\n' && text[i] !== ';' && !(group && text[i] === '}')) i++;
          label = text.slice(s, i).trim();
        }
        if (refs.length < 2) err('a label with ":" needs an edge (a -> b : label)', line);
      }
      ws();
      if (!atEnd() && text[i] !== '\n' && text[i] !== ';' && text[i] !== '}' && text[i] !== '#') {
        const s = i; skipToEnd(!!group);
        err(`unexpected "${text.slice(s, i).trim().slice(0, 20)}" (an edge is written a -> b)`, line);
        continue;
      }
      for (let k = 1; k < refs.length; k++) {
        if (out.edges.length >= MAX_EDGES) { err(`too many edges (at most ${MAX_EDGES})`, line); break; }
        out.edges.push({ from: refs[k - 1].id, to: refs[k].id, label: k === refs.length - 1 ? clipLabel(label) : '', dashed: dashes[k - 1] });
      }
    }
  };
  block(null, 0);
  if (!out.nodes.length && !out.errors.length) err('the diagram has no nodes (write a -> b)', 1);
  for (const g of out.groups) delete g.line;
  return out;
}

// ------------------------------------------------------------------------------ layout
const R1 = (v) => { const r = Math.round(v * 10) / 10; return r === 0 ? 0 : r; };
const CHAR_W = { i: 3.6, l: 3.6, j: 3.6, t: 4.6, f: 4.6, r: 4.8, I: 4.2, ' ': 3.8, '.': 3.6, ',': 3.6, ':': 3.6, ';': 3.6, '|': 3.6, '!': 3.8, '\'': 3.2, m: 10.8, w: 9.6, M: 11.6, W: 12.6 };
/** A close, deterministic width estimate for 13px sans text (the layout needs the same numbers in every environment). */
export function textWidth(s, size = 13) {
  let w = 0;
  for (const ch of String(s)) w += CHAR_W[ch] ?? (ch >= 'A' && ch <= 'Z' ? 8.6 : ch >= '0' && ch <= '9' ? 7.4 : 6.9);
  return w * size / 13;
}
const WRAP_AT = 22, MAX_LINES = 3;
/** Break a label at spaces into at most three lines of about 22 characters. */
export function wrapLabel(label) {
  const words = String(label).split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > WRAP_AT) { lines.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
  }
  lines.push(cur);
  if (lines.length > MAX_LINES) { const keep = lines.slice(0, MAX_LINES); keep[MAX_LINES - 1] = keep[MAX_LINES - 1].replace(/.?$/, '…'); return keep; }
  return lines;
}

const LINE_H = 16, PAD_X = 16, GAP_ACROSS = 36, GAP_GROUP = 40, GAP_DUMMY = 14, LOOP = 26, MARGIN = 14;
const GROUP_PAD = 14, GROUP_TOP = 26, ARROW = 9;

function sizeOf(n) {
  const lines = wrapLabel(n.label);
  const tw = Math.max(...lines.map((l) => textWidth(l)));
  let w = Math.max(60, tw + PAD_X * 2), h = Math.max(40, lines.length * LINE_H + 18);
  if (n.shape === 'round') w += 10;
  else if (n.shape === 'diamond') { w = Math.max(80, w * 1.45); h = Math.max(54, h * 1.55); }
  else if (n.shape === 'db') h += 12;
  return { w: R1(w), h: R1(h), lines };
}

/**
 * Layered layout ("Sugiyama-lite"): break cycles with a DFS, give every node its longest-path layer, add dummy nodes where an edge
 * spans layers, order each layer with barycenter sweeps (keeping the best crossing count and group members side by side), then
 * place nodes across the layers by relaxing towards their neighbours without ever overlapping. Fully deterministic.
 * Returns { width, height, dir, nodes:[{id,label,shape,x,y,w,h,lines}], edges:[{from,to,label,dashed,pts,labelBox,loop}], groups:[{id,title,x,y,w,h}] }.
 */
export function layoutDiagram(parsed) {
  const dir = parsed.dir === 'LR' ? 'LR' : 'TB';
  const nodes = parsed.nodes || [];
  const empty = { width: 0, height: 0, dir, nodes: [], edges: [], groups: [] };
  if (!nodes.length) return empty;
  const idx = new Map(nodes.map((n, k) => [n.id, k]));
  const edges = (parsed.edges || []).filter((e) => idx.has(e.from) && idx.has(e.to));
  const dims = nodes.map(sizeOf);
  const across = (k) => (dir === 'TB' ? dims[k].w : dims[k].h);   // size across a layer
  const along = (k) => (dir === 'TB' ? dims[k].h : dims[k].w);    // size along the layer axis
  const hasLoop = new Set(edges.filter((e) => e.from === e.to).map((e) => idx.get(e.from)));

  // 1. break cycles: DFS in node order, an edge to a node on the stack is flipped for layout
  const out = nodes.map(() => []);
  edges.forEach((e, ei) => { if (e.from !== e.to) out[idx.get(e.from)].push(ei); });
  const state = new Array(nodes.length).fill(0);
  const flipped = new Set();
  const dfs = (v) => {
    state[v] = 1;
    for (const ei of out[v]) {
      const t = idx.get(edges[ei].to);
      if (state[t] === 1) flipped.add(ei); else if (state[t] === 0) dfs(t);
    }
    state[v] = 2;
  };
  for (let v = 0; v < nodes.length; v++) if (state[v] === 0) dfs(v);
  const lay = edges.map((e, ei) => (e.from === e.to ? null : flipped.has(ei) ? [idx.get(e.to), idx.get(e.from)] : [idx.get(e.from), idx.get(e.to)]));

  // 2. layers by longest path; a source is pulled down next to its nearest successor so edges stay short
  const preds = nodes.map(() => []), succs = nodes.map(() => []);
  lay.forEach((p) => { if (p) { preds[p[1]].push(p[0]); succs[p[0]].push(p[1]); } });
  const layer = new Array(nodes.length).fill(-1);
  const depth = (v) => { if (layer[v] >= 0) return layer[v]; layer[v] = 0; layer[v] = preds[v].reduce((m, u) => Math.max(m, depth(u) + 1), 0); return layer[v]; };
  for (let v = 0; v < nodes.length; v++) depth(v);
  for (let v = 0; v < nodes.length; v++) if (!preds[v].length && succs[v].length) layer[v] = Math.min(...succs[v].map((s) => layer[s])) - 1;
  const minLayer = Math.min(...layer);
  for (let v = 0; v < layer.length; v++) layer[v] -= minLayer;

  // 3. chains with dummy nodes (keys: real nodes 0..n-1, dummies n..)
  const keyLayer = layer.slice();
  const keyAcross = nodes.map((_, k) => across(k));
  const keyGroup = nodes.map((n) => n.group);
  const chains = lay.map((p, ei) => {
    if (!p) return null;
    const c = [p[0]];
    for (let l = layer[p[0]] + 1; l < layer[p[1]]; l++) { keyLayer.push(l); keyAcross.push(0); keyGroup.push(null); c.push(keyLayer.length - 1); }
    c.push(p[1]);
    return c;
  });
  const total = keyLayer.length;
  const nLayers = Math.max(...keyLayer) + 1;
  const up = Array.from({ length: total }, () => []), down = Array.from({ length: total }, () => []);
  chains.forEach((c) => { if (c) for (let k = 0; k + 1 < c.length; k++) { down[c[k]].push(c[k + 1]); up[c[k + 1]].push(c[k]); } });

  // 4. order each layer
  let layers = Array.from({ length: nLayers }, () => []);
  for (let v = 0; v < total; v++) layers[keyLayer[v]].push(v);
  const posOf = (ls) => { const p = new Array(total); ls.forEach((l) => l.forEach((v, k) => { p[v] = k; })); return p; };
  const crossings = (ls) => {
    const pos = posOf(ls);
    let n = 0;
    for (let l = 0; l + 1 < ls.length; l++) {
      const es = [];
      for (const v of ls[l]) for (const w of down[v]) es.push([pos[v], pos[w]]);
      for (let a = 0; a < es.length; a++) for (let b = a + 1; b < es.length; b++) if ((es[a][0] - es[b][0]) * (es[a][1] - es[b][1]) < 0) n++;
    }
    return n;
  };
  /** Sort one layer by barycenter of its neighbours in `nbr`, then keep members of a group together at the group's mean place. */
  const sortLayer = (ls, l, nbr) => {
    const pos = posOf(ls);
    const cur = ls[l];
    const bary = new Map(cur.map((v, k) => [v, nbr && nbr[v].length ? nbr[v].reduce((s, u) => s + pos[u], 0) / nbr[v].length : k]));
    const order = cur.slice().sort((a, b) => bary.get(a) - bary.get(b) || pos[a] - pos[b]);
    const clusters = [];
    const byGroup = new Map();
    for (const v of order) {
      const g = keyGroup[v];
      if (g && byGroup.has(g)) byGroup.get(g).members.push(v);
      else { const c = { members: [v] }; clusters.push(c); if (g) byGroup.set(g, c); }
    }
    for (const c of clusters) c.mean = c.members.reduce((s, v) => s + order.indexOf(v), 0) / c.members.length;
    clusters.sort((a, b) => a.mean - b.mean);
    ls[l] = clusters.flatMap((c) => c.members);
  };
  for (let l = 0; l < nLayers; l++) sortLayer(layers, l, null); // group members side by side from the start
  let best = layers.map((l) => l.slice()), bestX = crossings(best);
  for (let pass = 0; pass < 10 && bestX > 0; pass++) {
    if (pass % 2 === 0) for (let l = 1; l < nLayers; l++) sortLayer(layers, l, up);
    else for (let l = nLayers - 2; l >= 0; l--) sortLayer(layers, l, down);
    const x = crossings(layers);
    if (x < bestX) { bestX = x; best = layers.map((l) => l.slice()); }
  }
  layers = best;

  // 5. positions across the layers
  const sep = (a, b) => {
    const dummy = a >= nodes.length || b >= nodes.length;
    let gap = dummy ? GAP_DUMMY : GAP_ACROSS;
    if (keyGroup[a] !== keyGroup[b] && (keyGroup[a] || keyGroup[b]) && !dummy) gap = GAP_GROUP;
    return keyAcross[a] / 2 + keyAcross[b] / 2 + gap + (a < nodes.length && hasLoop.has(a) ? LOOP : 0);
  };
  const cx = new Array(total).fill(0);
  layers.forEach((ls) => {
    let x = 0;
    ls.forEach((v, k) => { if (k) x += sep(ls[k - 1], v); cx[v] = x; });
    const mid = (cx[ls[0]] + cx[ls[ls.length - 1]]) / 2;
    ls.forEach((v) => { cx[v] -= mid; });
  });
  const relax = (ls, nbr) => {
    const want = ls.map((v) => (nbr[v].length ? nbr[v].reduce((s, u) => s + cx[u], 0) / nbr[v].length : cx[v]));
    const left = [], right = [];
    ls.forEach((v, k) => { left[k] = k ? Math.max(want[k], left[k - 1] + sep(ls[k - 1], v)) : want[k]; });
    for (let k = ls.length - 1; k >= 0; k--) right[k] = k < ls.length - 1 ? Math.min(want[k], right[k + 1] - sep(ls[k], ls[k + 1])) : want[k];
    ls.forEach((v, k) => { cx[v] = (left[k] + right[k]) / 2; });
  };
  for (let it = 0; it < 6; it++) {
    for (let l = 1; l < nLayers; l++) relax(layers[l], up);
    for (let l = nLayers - 2; l >= 0; l--) relax(layers[l], down);
  }
  const minAcross = Math.min(...layers.flat().map((v) => cx[v] - keyAcross[v] / 2));
  for (let v = 0; v < total; v++) cx[v] -= minAcross;

  // 6. positions along the layers
  const anyLabel = edges.some((e) => e.label);
  // left to right, a label sits on a horizontal run, so the gap between layers has to be as wide as the widest label
  const widest = dir === 'LR' ? Math.max(0, ...edges.map((e) => (e.label ? textWidth(e.label, 11.5) + 12 : 0))) : 0;
  const gap = Math.max(anyLabel ? 66 : 50, widest + 34) + (parsed.groups && parsed.groups.length ? 22 : 0);
  const layerSize = layers.map((ls) => Math.max(0, ...ls.filter((v) => v < nodes.length).map((v) => along(v))));
  const layerMid = [];
  let run = 0;
  for (let l = 0; l < nLayers; l++) { layerMid[l] = run + layerSize[l] / 2; run += layerSize[l] + gap; }
  const toXY = (a, r) => (dir === 'TB' ? { x: a, y: r } : { x: r, y: a });
  const center = (v) => toXY(cx[v], layerMid[keyLayer[v]]);

  // 7. edge attachment points, spread along the node side
  const slots = new Map(); // `${v}:${side}` -> [{ ei, other }]
  const slot = (v, side, ei, other) => { const k = `${v}:${side}`; if (!slots.has(k)) slots.set(k, []); slots.get(k).push({ ei, other }); };
  chains.forEach((c, ei) => { if (c) { slot(c[0], 'out', ei, c[1]); slot(c[c.length - 1], 'in', ei, c[c.length - 2]); } });
  const attach = new Map(); // `${ei}:${'s'|'e'}` -> across offset
  for (const [k, list] of slots) {
    const [v, side] = k.split(':');
    list.sort((p, q) => cx[p.other] - cx[q.other] || p.ei - q.ei);
    const n = list.length, a = keyAcross[+v];
    const step = n > 1 ? Math.min(18, (a * 0.7) / (n - 1)) : 0;
    list.forEach((s, j) => attach.set(`${s.ei}:${side === 'out' ? 's' : 'e'}`, (j - (n - 1) / 2) * step));
  }
  const borderGap = (v, off) => {
    const n = nodes[v];
    const half = along(v) / 2;
    if (n.shape !== 'diamond') return half;
    const ah = across(v) / 2;
    return half * Math.max(0, 1 - Math.abs(off) / ah);
  };
  const edgeOut = edges.map((e, ei) => {
    const c = chains[ei];
    if (!c) {
      const v = idx.get(e.from), p = center(v), a = across(v) / 2;
      const o = dir === 'TB' ? { x: p.x + a, y: p.y } : { x: p.x, y: p.y + a };
      const pts = dir === 'TB'
        ? [{ x: o.x, y: o.y - 8 }, { x: o.x + LOOP - 4, y: o.y - 8 }, { x: o.x + LOOP - 4, y: o.y + 8 }, { x: o.x, y: o.y + 8 }]
        : [{ x: o.x - 8, y: o.y }, { x: o.x - 8, y: o.y + LOOP - 4 }, { x: o.x + 8, y: o.y + LOOP - 4 }, { x: o.x + 8, y: o.y }];
      return { from: e.from, to: e.to, label: e.label, dashed: e.dashed, pts, loop: true };
    }
    const so = attach.get(`${ei}:s`) || 0, eo = attach.get(`${ei}:e`) || 0;
    const pts = c.map((v, k) => {
      const base = center(v);
      if (k === 0) return toXY(cx[v] + so, layerMid[keyLayer[v]] + borderGap(v, so));
      if (k === c.length - 1) return toXY(cx[v] + eo, layerMid[keyLayer[v]] - borderGap(v, eo));
      return base;
    });
    if (flipped.has(ei)) pts.reverse();
    return { from: e.from, to: e.to, label: e.label, dashed: e.dashed, pts, loop: false };
  });

  // 8. assemble in screen coordinates
  const outNodes = nodes.map((n, k) => {
    const c = center(k);
    return { id: n.id, label: n.label, shape: n.shape, x: R1(c.x - dims[k].w / 2), y: R1(c.y - dims[k].h / 2), w: dims[k].w, h: dims[k].h, lines: dims[k].lines };
  });
  const outGroups = (parsed.groups || []).filter((g) => g.nodes.length).map((g) => {
    const m = g.nodes.map((id) => outNodes[idx.get(id)]);
    const x0 = Math.min(...m.map((n) => n.x)) - GROUP_PAD, y0 = Math.min(...m.map((n) => n.y)) - GROUP_TOP;
    const x1 = Math.max(...m.map((n) => n.x + n.w)) + GROUP_PAD, y1 = Math.max(...m.map((n) => n.y + n.h)) + GROUP_PAD;
    return { id: g.id, title: g.title, x: R1(x0), y: R1(y0), w: R1(Math.max(x1 - x0, textWidth(g.title, 11) + 24)), h: R1(y1 - y0) };
  });
  const placed = [];
  for (const e of edgeOut) {
    if (!e.label) continue;
    const pts = e.pts;
    let p;
    if (e.loop) p = dir === 'TB' ? { x: pts[1].x + 4, y: (pts[1].y + pts[2].y) / 2 } : { x: (pts[1].x + pts[2].x) / 2, y: pts[1].y + 12 };
    else {
      const k = Math.floor((pts.length - 1) / 2);
      p = { x: (pts[k].x + pts[k + 1].x) / 2, y: (pts[k].y + pts[k + 1].y) / 2 };
    }
    const w = textWidth(e.label, 11.5) + 12;
    const box = e.loop && dir === 'TB' ? { x: R1(p.x), y: R1(p.y - 9), w: R1(w), h: 18, anchor: 'start' } : { x: R1(p.x - w / 2), y: R1(p.y - 9), w: R1(w), h: 18, anchor: 'middle' };
    // two labels never sit on top of each other: slide a colliding one up and down the line until it is free
    const hits = (b) => placed.some((q) => b.x < q.x + q.w + 2 && q.x < b.x + b.w + 2 && b.y < q.y + q.h + 2 && q.y < b.y + b.h + 2);
    const home = box.y;
    for (const d of [0, 20, -20, 40, -40, 60, -60]) { box.y = R1(home + d); if (!hits(box)) break; }
    placed.push(box);
    e.labelBox = box;
  }
  const xs = [], ys = [];
  const grow = (x0, y0, x1, y1) => { xs.push(x0, x1); ys.push(y0, y1); };
  outNodes.forEach((n) => grow(n.x, n.y, n.x + n.w, n.y + n.h));
  outGroups.forEach((g) => grow(g.x, g.y, g.x + g.w, g.y + g.h));
  edgeOut.forEach((e) => { e.pts.forEach((p) => grow(p.x, p.y, p.x, p.y)); if (e.labelBox) grow(e.labelBox.x, e.labelBox.y, e.labelBox.x + e.labelBox.w, e.labelBox.y + e.labelBox.h); });
  const ox = MARGIN - Math.min(...xs), oy = MARGIN - Math.min(...ys);
  const mv = (o) => ({ ...o, x: R1(o.x + ox), y: R1(o.y + oy) });
  return {
    width: R1(Math.max(...xs) - Math.min(...xs) + MARGIN * 2), height: R1(Math.max(...ys) - Math.min(...ys) + MARGIN * 2), dir,
    nodes: outNodes.map(mv), groups: outGroups.map(mv),
    edges: edgeOut.map((e) => ({ ...e, pts: e.pts.map((p) => ({ x: R1(p.x + ox), y: R1(p.y + oy) })), labelBox: e.labelBox ? mv(e.labelBox) : null })),
  };
}

// ------------------------------------------------------------------------------ drawing primitives
/** The path through `pts` (screen coordinates): S-shaped cubic segments that leave and enter along the layer axis. */
function edgePath(pts, dir, loop) {
  const f = (p) => `${p.x} ${p.y}`;
  if (loop) return `M${f(pts[0])} L${f(pts[1])} L${f(pts[2])} L${f(pts[3])}`;
  let d = `M${f(pts[0])}`;
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k], b = pts[k + 1];
    d += dir === 'TB'
      ? ` C${a.x} ${R1((a.y + b.y) / 2)} ${b.x} ${R1((a.y + b.y) / 2)} ${b.x} ${b.y}`
      : ` C${R1((a.x + b.x) / 2)} ${a.y} ${R1((a.x + b.x) / 2)} ${b.y} ${b.x} ${b.y}`;
  }
  return d;
}
function arrowHead(pts, dir, loop) {
  const tip = pts[pts.length - 1], prev = pts[pts.length - 2];
  let dx, dy;
  if (loop) { dx = dir === 'TB' ? -1 : 0; dy = dir === 'TB' ? 0 : -1; }
  else if (dir === 'TB') { dx = 0; dy = Math.sign(tip.y - prev.y) || 1; if (Math.abs(tip.y - prev.y) < 1) { dx = Math.sign(tip.x - prev.x) || 1; dy = 0; } }
  else { dy = 0; dx = Math.sign(tip.x - prev.x) || 1; if (Math.abs(tip.x - prev.x) < 1) { dy = Math.sign(tip.y - prev.y) || 1; dx = 0; } }
  const bx = tip.x - dx * ARROW, by = tip.y - dy * ARROW, px = -dy * ARROW * 0.5, py = dx * ARROW * 0.5;
  return `${R1(tip.x)},${R1(tip.y)} ${R1(bx + px)},${R1(by + py)} ${R1(bx - px)},${R1(by - py)}`;
}
function nodePrim(n) {
  const { x, y, w, h } = n;
  if (n.shape === 'round') return { tag: 'rect', attrs: { class: 'dg-node', x, y, width: w, height: h, rx: R1(h / 2), ry: R1(h / 2) } };
  if (n.shape === 'diamond') return { tag: 'polygon', attrs: { class: 'dg-node', points: `${R1(x + w / 2)},${y} ${R1(x + w)},${R1(y + h / 2)} ${R1(x + w / 2)},${R1(y + h)} ${x},${R1(y + h / 2)}` } };
  if (n.shape === 'db') {
    const e = 7, rx = R1(w / 2);
    return { tag: 'path', attrs: { class: 'dg-node', d: `M${x} ${y + e} A${rx} ${e} 0 0 1 ${x + w} ${y + e} V${R1(y + h - e)} A${rx} ${e} 0 0 1 ${x} ${R1(y + h - e)} Z M${x} ${y + e} A${rx} ${e} 0 0 0 ${x + w} ${y + e}` } };
  }
  return { tag: 'rect', attrs: { class: 'dg-node', x, y, width: w, height: h, rx: 5, ry: 5 } };
}
/** A flat, ordered list of { tag, attrs, text? } for the whole picture: both renderers just serialise it. Back to front. */
export function diagramPrims(layout) {
  const prims = [];
  for (const g of layout.groups) {
    prims.push({ tag: 'rect', attrs: { class: 'dg-group', x: g.x, y: g.y, width: g.w, height: g.h, rx: 8, ry: 8 } });
    prims.push({ tag: 'text', attrs: { class: 'dg-gtitle', x: R1(g.x + 12), y: R1(g.y + 17) }, text: g.title });
  }
  for (const e of layout.edges) {
    prims.push({ tag: 'path', attrs: { class: e.dashed ? 'dg-edge dg-dash' : 'dg-edge', d: edgePath(e.pts, layout.dir, e.loop) } });
    prims.push({ tag: 'polygon', attrs: { class: 'dg-arrow', points: arrowHead(e.pts, layout.dir, e.loop) } });
  }
  for (const e of layout.edges) {
    if (!e.labelBox) continue;
    const b = e.labelBox;
    prims.push({ tag: 'rect', attrs: { class: 'dg-elabel-bg', x: b.x, y: b.y, width: b.w, height: b.h, rx: 4, ry: 4 } });
    prims.push({ tag: 'text', attrs: { class: 'dg-elabel', x: b.anchor === 'start' ? R1(b.x + 6) : R1(b.x + b.w / 2), y: R1(b.y + 13), 'text-anchor': b.anchor }, text: e.label });
  }
  for (const n of layout.nodes) {
    prims.push(nodePrim(n));
    n.lines.forEach((line, k) => {
      prims.push({ tag: 'text', attrs: { class: 'dg-ntext', x: R1(n.x + n.w / 2), y: R1(n.y + n.h / 2 + (k - (n.lines.length - 1) / 2) * LINE_H + 4.5), 'text-anchor': 'middle' }, text: line });
    });
  }
  return prims;
}
/** Short accessible name for the picture. */
export const diagramLabel = (parsed) => {
  const names = parsed.nodes.slice(0, 6).map((n) => n.label);
  return `Diagram of ${parsed.nodes.length} node${parsed.nodes.length === 1 ? '' : 's'}: ${names.join(', ')}${parsed.nodes.length > 6 ? ', …' : ''}`;
};

// ------------------------------------------------------------------------------ string renderer (export)
/** XML-escape text and attribute values (labels come from users and models, so every one goes through this). */
export const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const FONT = "-apple-system,'Helvetica Neue',Arial,sans-serif";
/** Fixed colours for paper (the export is printed on white, whatever the app theme is). */
export const DIAGRAM_PRINT_CSS = `.dg-group{fill:#f3f5f9;stroke:#c3cad6;stroke-width:1;stroke-dasharray:4 3}.dg-gtitle{font:600 11px ${FONT};fill:#5b6575}`
  + `.dg-node{fill:#fff;stroke:#2f3a4d;stroke-width:1.4}.dg-ntext{font:13px ${FONT};fill:#15171a}`
  + `.dg-edge{fill:none;stroke:#566175;stroke-width:1.4}.dg-dash{stroke-dasharray:5 4}.dg-arrow{fill:#566175}`
  + `.dg-elabel-bg{fill:#fff}.dg-elabel{font:11.5px ${FONT};fill:#3a4252}`;
/** A standalone <svg> string for a layout. Every label and attribute value is escaped; the only static markup is ours. */
export function diagramSvgString(layout, parsed, { id = '' } = {}) {
  if (!layout.nodes.length) return '';
  const body = diagramPrims(layout).map((p) => {
    const attrs = Object.entries(p.attrs).map(([k, v]) => ` ${k}="${xmlEsc(v)}"`).join('');
    return p.text !== undefined ? `<${p.tag}${attrs}>${xmlEsc(p.text)}</${p.tag}>` : `<${p.tag}${attrs}/>`;
  }).join('');
  const label = xmlEsc(diagramLabel(parsed));
  return `<svg xmlns="http://www.w3.org/2000/svg"${id ? ` id="${xmlEsc(id)}"` : ''} class="dg" role="img" aria-label="${label}" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" style="max-width:100%;height:auto"><title>${label}</title><style>${DIAGRAM_PRINT_CSS}</style>${body}</svg>`;
}
/** Parse + layout + string in one call: { svg, width, height, errors, parsed }. `svg` is '' when the source has errors or no nodes. */
export function renderDiagramSvg(src, opts) {
  const parsed = parseDiagram(src);
  if (parsed.errors.length || !parsed.nodes.length) return { svg: '', width: 0, height: 0, errors: parsed.errors, parsed };
  const layout = layoutDiagram(parsed);
  return { svg: diagramSvgString(layout, parsed, opts), width: layout.width, height: layout.height, errors: [], parsed };
}
/** First problem as one line ("line 2: expected a node id…"), or '' when the source is a valid diagram. */
export function diagramProblem(src) {
  const p = parseDiagram(src);
  if (p.errors.length) return `line ${p.errors[0].line}: ${p.errors[0].message}`;
  return '';
}
