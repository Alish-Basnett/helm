// A tiny zip reader/writer (node:zlib only) for one job: putting PNG diagrams into the .docx that macOS `textutil` writes.
// textutil's docx writer drops every image, so the export makes a docx with a text placeholder per diagram, then this module
// adds the PNGs, their relationships and the <w:drawing> elements. Not a general zip library: no zip64, no encryption, no
// multi-disk archives. Entries are read from the central directory, so data descriptors (sizes after the data) are fine.
import zlib from 'node:zlib';

const EOCD = 0x06054b50, CEN = 0x02014b50, LOC = 0x04034b50;

/** Map of entry name -> Buffer (decompressed), in archive order. Throws on anything it does not understand. */
export function readZip(buf) {
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === EOCD) { e = i; break; }
  if (e < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const out = new Map();
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== CEN) throw new Error('bad zip directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (buf.readUInt32LE(off) !== LOC) throw new Error('bad zip entry');
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.subarray(start, start + csize);
    if (name.endsWith('/')) continue;
    if (method === 0) out.set(name, Buffer.from(raw));
    else if (method === 8) out.set(name, zlib.inflateRawSync(raw));
    else throw new Error(`unsupported zip method ${method}`);
  }
  return out;
}

/** Zip a Map (or array of [name, Buffer]) with deflate. [Content_Types].xml first, as Word expects. */
export function writeZip(entries) {
  const list = [...(entries instanceof Map ? entries : new Map(entries))].sort((a, b) => (a[0] === '[Content_Types].xml' ? -1 : b[0] === '[Content_Types].xml' ? 1 : 0));
  const parts = [], central = [];
  let off = 0;
  for (const [name, data] of list) {
    const nb = Buffer.from(name, 'utf8');
    const raw = Buffer.from(data);
    const comp = zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(LOC, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(0x0800, 6); loc.writeUInt16LE(8, 8);
    loc.writeUInt32LE(0x00210000, 10); // 1980-01-01, so the archive is reproducible
    loc.writeUInt32LE(crc, 14); loc.writeUInt32LE(comp.length, 18); loc.writeUInt32LE(raw.length, 22); loc.writeUInt16LE(nb.length, 26);
    parts.push(loc, nb, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(CEN, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(0x00210000, 12);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(raw.length, 24); cen.writeUInt16LE(nb.length, 28);
    cen.writeUInt32LE(off, 42);
    central.push(cen, nb);
    off += loc.length + nb.length + comp.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0); end.writeUInt16LE(list.length, 8); end.writeUInt16LE(list.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, dir, end]);
}

const EMU = 9525;                    // EMU per CSS pixel
const MAX_W = 5_900_000;             // about 6.2 inches: fits an A4 page between 20 mm margins
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Inline picture run for word/document.xml. */
function drawing(n, rid, w, h, alt) {
  let cx = Math.round(w * EMU), cy = Math.round(h * EMU);
  if (cx > MAX_W) { cy = Math.round(cy * MAX_W / cx); cx = MAX_W; }
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${9000 + n}" name="Diagram ${n}" descr="${xml(alt)}"/>`
    + `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${9000 + n}" name="diagram-${n}.png"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>`
    + `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}
export const diagramToken = (n) => `[[helm-diagram-${n}]]`;

/**
 * Replace each `[[helm-diagram-N]]` text run in a textutil .docx with picture N. `pictures` is [{ n, png: Buffer, w, h, alt }]
 * (w, h in CSS pixels). Returns the new docx Buffer. Throws when a token is missing, so the caller can fall back.
 */
export function embedDiagrams(docx, pictures) {
  const files = readZip(docx);
  let doc = files.get('word/document.xml')?.toString('utf8');
  let rels = files.get('word/_rels/document.xml.rels')?.toString('utf8');
  let types = files.get('[Content_Types].xml')?.toString('utf8');
  if (!doc || !rels || !types) throw new Error('unexpected docx layout');
  for (const p of pictures) {
    const re = new RegExp(`<w:r>(?:(?!</w:r>)[\\s\\S])*?<w:t[^>]*>${diagramToken(p.n).replace(/[[\]]/g, '\\$&')}</w:t></w:r>`);
    if (!re.test(doc)) throw new Error(`diagram ${p.n} placeholder not found in the docx`);
    const rid = `rIdHelmDiagram${p.n}`;
    doc = doc.replace(re, () => drawing(p.n, rid, p.w, p.h, p.alt));
    rels = rels.replace('</Relationships>', `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/diagram-${p.n}.png"/></Relationships>`);
    files.set(`word/media/diagram-${p.n}.png`, p.png);
  }
  if (!/Extension="png"/i.test(types)) types = types.replace(/(<Types[^>]*>)/, '$1<Default Extension="png" ContentType="image/png"/>');
  files.set('word/document.xml', Buffer.from(doc));
  files.set('word/_rels/document.xml.rels', Buffer.from(rels));
  files.set('[Content_Types].xml', Buffer.from(types));
  return writeZip(files);
}
