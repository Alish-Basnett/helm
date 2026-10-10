// attachments.js — v0.4: drag/drop + paste uploads for note composers, chips, and rendering of a note's files.
// Uploads go to POST /v1/attachments (raw body); notes then carry `attachments: [ids]`.
import { h, setHidden } from './dom.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { toast } from './ui.js';

export const MAX_BYTES = 20 * 1024 * 1024;
export const MAX_FILES = 10;
export const NO_HUB_SUPPORT = 'This hub can’t take attachments yet. Update the Helm hub and try again. Your text is kept.';

export function fmtSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0).replace(/\.0$/, '')} KB`;
  return `${(n / 1048576).toFixed(1).replace(/\.0$/, '')} MB`;
}
export const isImage = (a) => !!a && /^image\//i.test(a.mime || a.type || '');

/* ---------- lightbox ---------- */
let lightbox = null;
export function closeLightbox() {
  if (!lightbox) return;
  const { el, off, prev } = lightbox;
  lightbox = null;
  off();
  el.remove();
  if (prev && prev.isConnected) prev.focus({ preventScroll: true });
}
export function openLightbox(url, name) {
  closeLightbox();
  const prev = document.activeElement;
  const close = h('button', { class: 'icon-btn lb-close', type: 'button', 'aria-label': 'Close image', title: 'Close (Esc)', onclick: () => closeLightbox() }, icon('close', 18));
  const img = h('img', { class: 'lb-img', src: url, alt: name || 'attachment' });
  const el = h('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': name || 'Image preview', onclick: (e) => { if (e.target !== img) closeLightbox(); } },
    close, img, name ? h('div', { class: 'lb-name mono' }, name) : null);
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeLightbox(); }
    else if (e.key === 'Tab') { e.preventDefault(); close.focus(); }
  };
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(el);
  lightbox = { el, prev, off: () => document.removeEventListener('keydown', onKey, true) };
  close.focus({ preventScroll: true });
}

/* ---------- a note's attachments (thumbnails + file links) ---------- */
export function createAttachmentList() {
  const el = h('div', { class: 'att-list', hidden: true });
  let sig = '';
  function update(atts) {
    const list = Array.isArray(atts) ? atts : [];
    const next = list.map((a) => a.id).join(',');
    setHidden(el, list.length === 0);
    if (next === sig) return;
    sig = next;
    el.textContent = '';
    for (const a of list) {
      const url = api.attachmentUrl(a.id);
      if (isImage(a)) {
        el.append(h('button', { class: 'att-thumb', type: 'button', title: `${a.name} · ${fmtSize(a.size)}`, 'aria-label': `Open image ${a.name}`, onclick: (e) => { e.stopPropagation(); openLightbox(url, a.name); } },
          h('img', { src: url, alt: a.name || 'image', loading: 'lazy' })));
      } else {
        el.append(h('a', { class: 'att-file', href: url, target: '_blank', rel: 'noopener', title: `${a.name} · ${fmtSize(a.size)}`, onclick: (e) => e.stopPropagation() },
          icon('file', 14), h('span', { class: 'att-name' }, a.name || a.id), h('span', { class: 'att-size mono' }, fmtSize(a.size))));
      }
    }
  }
  return { el, update };
}

/* ---------- the composer's pending-upload tray ---------- */
let keySeq = 0;

/** opts.onChange(): called whenever the set / status of pending items changes. */
export function createAttachTray(opts = {}) {
  const el = h('div', { class: 'att-tray', hidden: true, 'aria-label': 'Attachments' });
  let items = []; // { key, file, name, size, mime, status:'uploading'|'done'|'error', progress, att, thumb, ctl, node }

  const changed = () => { setHidden(el, items.length === 0); opts.onChange && opts.onChange(); };

  function paint(it) {
    const n = it.node;
    n.className = `att-chip ${it.status}`;
    const bar = n.querySelector('.att-bar-fill');
    if (bar) bar.style.width = `${Math.round((it.status === 'done' ? 1 : it.progress) * 100)}%`;
    const st = n.querySelector('.att-state');
    st.textContent = it.status === 'uploading' ? `Uploading ${Math.round(it.progress * 100)}%` : it.status === 'error' ? (it.error || 'Failed') : fmtSize(it.size);
    n.setAttribute('aria-busy', String(it.status === 'uploading'));
  }

  function makeChip(it) {
    let visual;
    if (/^image\//i.test(it.mime) && it.thumb) visual = h('img', { class: 'att-chip-thumb', src: it.thumb, alt: '' });
    else visual = h('span', { class: 'att-chip-icon' }, icon('file', 16));
    const x = h('button', { class: 'att-x', type: 'button', 'aria-label': `Remove ${it.name}`, title: 'Remove', onclick: () => remove(it.key) }, icon('close', 12));
    return h('div', { class: 'att-chip', role: 'group', 'aria-label': it.name },
      visual,
      h('div', { class: 'att-chip-text' }, h('span', { class: 'att-name', title: it.name }, it.name), h('span', { class: 'att-state mono' })),
      h('span', { class: 'att-bar' }, h('span', { class: 'att-bar-fill' })),
      x);
  }

  function remove(key) {
    const it = items.find((x) => x.key === key);
    if (!it) return;
    items = items.filter((x) => x !== it);
    if (it.ctl && it.status === 'uploading') it.ctl.abort();
    if (it.thumb && it.ownThumb) { try { URL.revokeObjectURL(it.thumb); } catch { /* ignore */ } }
    it.node.remove();
    changed();
  }

  async function upload(it) {
    it.status = 'uploading'; it.progress = 0;
    it.ctl = typeof AbortController === 'function' ? new AbortController() : null;
    paint(it);
    try {
      const res = await api.uploadAttachment(it.file, { signal: it.ctl && it.ctl.signal, onProgress: (p) => { it.progress = p; paint(it); } });
      if (!items.includes(it)) return;
      it.att = res.attachment; it.status = 'done'; it.progress = 1;
      paint(it);
    } catch (e) {
      if (!items.includes(it) || (e && e.name === 'AbortError')) return;
      if (e && (e.status === 404 || e.status === 405)) {
        toast(NO_HUB_SUPPORT, { kind: 'error', duration: 8000 });
        remove(it.key);
        return;
      }
      it.status = 'error';
      it.error = e && e.status === 413 ? 'Too large' : 'Upload failed';
      toast(`Could not upload ${it.name}: ${e && e.message ? e.message : 'unknown error'}`, { kind: 'error' });
      paint(it);
    }
    changed();
  }

  /** Add File objects (from a drop, a paste or the picker) and start uploading each. */
  function add(files) {
    const list = Array.from(files || []).filter((f) => f && typeof f.size === 'number');
    for (const file of list) {
      if (items.length >= MAX_FILES) { toast(`At most ${MAX_FILES} files per note`, { kind: 'error' }); break; }
      if (file.size > MAX_BYTES) { toast(`${file.name || 'File'} is over 20 MB`, { kind: 'error' }); continue; }
      if (!file.size) { toast(`${file.name || 'File'} is empty`, { kind: 'error' }); continue; }
      let thumb = null;
      try { if (/^image\//i.test(file.type) && URL.createObjectURL) thumb = URL.createObjectURL(file); } catch { thumb = null; }
      const it = { key: ++keySeq, file, name: file.name || 'file', size: file.size, mime: file.type || 'application/octet-stream', status: 'uploading', progress: 0, att: null, thumb, ownThumb: !!thumb, ctl: null, node: null, error: '' };
      it.node = makeChip(it);
      items.push(it);
      el.append(it.node);
      upload(it);
    }
    changed();
  }

  /** Take the finished attachments and empty the tray (restore() undoes it when the send fails). */
  function take() {
    const taken = items;
    items = [];
    for (const it of taken) it.node.remove();
    changed();
    return taken;
  }
  function restore(taken) {
    for (const it of taken) { items.push(it); el.append(it.node); }
    changed();
  }

  return {
    el, add, take, restore,
    get count() { return items.length; },
    get busy() { return items.some((i) => i.status === 'uploading'); },
    /** Attachment rows (id, name, mime, size, path) of every finished upload. */
    done() { return items.filter((i) => i.status === 'done' && i.att).map((i) => i.att); },
    hasFailed() { return items.some((i) => i.status === 'error'); },
    destroy() { for (const it of items) { if (it.ctl && it.status === 'uploading') it.ctl.abort(); } items = []; },
  };
}

/** Pull the items taken from the tray into what addNote wants. */
export const attsOf = (taken) => taken.filter((i) => i.status === 'done' && i.att).map((i) => i.att);

/* ---------- drop overlay + paste on a composer ---------- */
const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

/**
 * Make `box` accept dropped files and `ta` accept pasted ones. Returns { destroy, pick } where pick() opens the file chooser.
 */
export function bindAttachInput({ box, ta, tray, disabled = () => false }) {
  const overlay = h('div', { class: 'drop-overlay', 'aria-hidden': 'true', hidden: true }, icon('upload', 22), h('span', {}, 'Drop to attach'));
  box.classList.add('has-drop');
  box.append(overlay);
  let depth = 0;
  const show = (on) => { setHidden(overlay, !on); box.classList.toggle('dragging', on); };
  const onEnter = (e) => { if (!hasFiles(e) || disabled()) return; e.preventDefault(); depth++; show(true); };
  const onOver = (e) => { if (!hasFiles(e) || disabled()) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; show(true); };
  const onLeave = (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) show(false); };
  const onDrop = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0; show(false);
    if (disabled()) return;
    tray.add(e.dataTransfer.files);
  };
  box.addEventListener('dragenter', onEnter);
  box.addEventListener('dragover', onOver);
  box.addEventListener('dragleave', onLeave);
  box.addEventListener('drop', onDrop);

  const onPaste = (e) => {
    const cd = e.clipboardData;
    if (!cd || disabled()) return;
    let files = Array.from(cd.files || []);
    if (!files.length && cd.items) files = Array.from(cd.items).filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
    if (!files.length) return; // plain text paste: leave it alone
    e.preventDefault();
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    tray.add(files.map((f, i) => {
      if (f.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(f.name)) return f;
      const ext = ((f.type || 'image/png').split('/')[1] || 'png').replace('jpeg', 'jpg');
      try { return new File([f], `pasted-${stamp}${files.length > 1 ? '-' + (i + 1) : ''}.${ext}`, { type: f.type || 'image/png' }); } catch { return f; }
    }));
  };
  ta.addEventListener('paste', onPaste);

  const input = h('input', { type: 'file', multiple: true, hidden: true, tabindex: '-1', 'aria-hidden': 'true', onchange: () => { tray.add(input.files); input.value = ''; } });
  box.append(input);
  return {
    pick: () => input.click(),
    destroy() {
      box.removeEventListener('dragenter', onEnter); box.removeEventListener('dragover', onOver);
      box.removeEventListener('dragleave', onLeave); box.removeEventListener('drop', onDrop);
      ta.removeEventListener('paste', onPaste);
      overlay.remove(); input.remove();
    },
  };
}
