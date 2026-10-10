// icons.js — inline SF-Symbols-like stroke icons (24 grid, 1.5px, round caps).
const P = {
  board: '<rect x="3.5" y="4.5" width="17" height="15" rx="3.5"/><path d="M8 8.5v5M12 8.5v8M16 8.5v3.5"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.2a2 2 0 0 1 1.5.7l.8.9a2 2 0 0 0 1.5.7h5.5a2 2 0 0 1 2 2v7.7a2 2 0 0 1-2 2h-12.5a2 2 0 0 1-2-2z"/>',
  office: '<rect x="3.5" y="5" width="17" height="11" rx="2.5"/><path d="M8.5 20h7M12 16v4"/>',
  threads: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6.5" r="2.5"/><circle cx="18" cy="17.5" r="2.5"/><path d="M8.3 11l7.4-3.5M8.3 13l7.4 3.5"/>',
  learn: '<path d="M9 17.5h6M10 20.5h4"/><path d="M12 3.5a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3.5z"/>',
  review: '<rect x="4.5" y="4.5" width="15" height="15" rx="3.5"/><path d="M8.5 12.2l2.4 2.4 4.6-5"/><path d="M4.5 9h15" opacity=".35"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M8.2 12.3l2.6 2.6 5-5.4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  templates: '<rect x="7" y="8.5" width="13" height="11" rx="2.5"/><path d="M4.5 15V7A2.5 2.5 0 0 1 7 4.5h8M10.5 13h6M10.5 16h3.5"/>',
  bookmark: '<path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-4.2L6 20V5.5a1 1 0 0 1 1-1z"/>',
  retry: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
  archive: '<rect x="3.5" y="4.5" width="17" height="4.5" rx="1.5"/><path d="M5 9v8.5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>',
  blocked: '<circle cx="12" cy="12" r="8.5"/><path d="M6.2 6.2l11.6 11.6"/>',
  minimize: '<path d="M6 12h12"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  chevronRight: '<path d="M9.5 6l6 6-6 6"/>',
  chevronLeft: '<path d="M14.5 6l-6 6 6 6"/>',
  chevronDown: '<path d="M6 9.5l6 6 6-6"/>',
  chevronUp: '<path d="M6 14.5l6-6 6 6"/>',
  chevrons: '<path d="M8 9.5l4-4 4 4M8 14.5l4 4 4-4"/>',
  sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="3.5"/><path d="M9.5 4.5v15"/>',
  sun: '<circle cx="12" cy="12" r="3.8"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6L18 18M18 6l-1.4 1.4M7.4 16.6L6 18"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  auto: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/>',
  file: '<path d="M7 3.5h6.5l5 5V19a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M13.5 3.5v5h5"/>',
  link: '<path d="M10 14a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1"/><path d="M14 10a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1"/>',
  terminal: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M7.5 10l3 2.5-3 2.5M13 15h4"/>',
  bolt: '<path d="M13 3.5L5.5 13.5H11l-1 7 7.5-10H12z"/>',
  note: '<path d="M6 3.5h12a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 6 3.5z"/><path d="M8.5 9h7M8.5 13h7M8.5 17h4"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.5h6.4a1.5 1.5 0 0 0 1.5-1.5L17.5 7M10 11v6M14 11v6"/>',
  pencil: '<path d="M5 19l1-4L16.5 4.5a2 2 0 0 1 2.8 0l.2.2a2 2 0 0 1 0 2.8L9 18z"/><path d="M14.5 6.5l3 3"/>',
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  send: '<circle cx="12" cy="12" r="8.5"/><path d="M12 16.5v-9M8.2 11.2L12 7.5l3.8 3.7"/>',
  tag: '<path d="M3.5 12.5V5.5a2 2 0 0 1 2-2h7l8 8-9 9z"/><circle cx="8.5" cy="8.5" r="1.2"/>',
  sparkle: '<path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z"/>',
  warning: '<path d="M12 4l9 15.5H3z"/><path d="M12 10v4M12 16.8v.2"/>',
  cpu: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.5"/><path d="M10 3.5v3M14 3.5v3M10 17.5v3M14 17.5v3M3.5 10h3M3.5 14h3M17.5 10h3M17.5 14h3"/><rect x="10" y="10" width="4" height="4" rx="1"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  pulse: '<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>',
  command: '<path d="M4 7l6 5-6 5M12 18h8"/>',
  circle: '<circle cx="12" cy="12" r="8.5"/>',
  spinner: '<path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5"/>',
  inbox: '<path d="M3.5 13l2.7-7a1.5 1.5 0 0 1 1.4-1h8.8a1.5 1.5 0 0 1 1.4 1l2.7 7v4.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M3.5 13h5l1 2.5h5l1-2.5h5"/>',
  question: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.7a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.2 1-1.2 1.8M12 16.6v.2"/>',
  pause: '<rect x="7" y="5.5" width="3.5" height="13" rx="1"/><rect x="13.5" y="5.5" width="3.5" height="13" rx="1"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3.5v3M16 3.5v3"/>',
  radar: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><path d="M12 12l5.5-5.5"/>',
  chat: '<path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-7L8 20v-3.5H5A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5z"/>',
  paperclip: '<path d="M19 11.5l-6.8 6.8a4.2 4.2 0 0 1-6-6l7.2-7.2a2.8 2.8 0 0 1 4 4l-7.2 7.2a1.4 1.4 0 0 1-2-2l6.5-6.5"/>',
  upload: '<path d="M12 16V5M7.5 9.5L12 5l4.5 4.5M5 19.5h14"/>',
  checklist: '<path d="M4 7.5l1.6 1.6L8.2 6.3M4 14l1.6 1.6 2.6-2.8M11.5 7.5H20M11.5 14H20M4 19.5h.01M11.5 19.5H20"/>',
  gear: '<path d="M10.8 5.0L11.0 2.9L13.0 2.9L13.2 5.0L16.1 6.2L17.8 4.8L19.2 6.2L17.8 7.9L19.0 10.8L21.1 11.0L21.1 13.0L19.0 13.2L17.8 16.1L19.2 17.8L17.8 19.2L16.1 17.8L13.2 19.0L13.0 21.1L11.0 21.1L10.8 19.0L7.9 17.8L6.2 19.2L4.8 17.8L6.2 16.1L5.0 13.2L2.9 13.0L2.9 11.0L5.0 10.8L6.2 7.9L4.8 6.2L6.2 4.8L7.9 6.2z"/><circle cx="12" cy="12" r="3"/>',
  code: '<path d="M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5M13.5 5l-3 14"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
  columns: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M12 4.5v15"/>',
  rows: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M7.5 9.5h9M7.5 14.5h9"/>',
  wrap: '<path d="M4 7h16M4 12h12.5a3 3 0 0 1 0 6H12m0 0l2-2m-2 2l2 2M4 17h4"/>',
  external: '<path d="M13.5 4.5h6v6M19.5 4.5l-8 8M17.5 14v3.5a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2H10"/>',
  diff: '<path d="M7 4.5v10a3 3 0 0 0 3 3h3.5M17 19.5v-10a3 3 0 0 0-3-3h-3.5"/><circle cx="7" cy="4.5" r="1.6"/><circle cx="17" cy="19.5" r="1.6"/>',
  popout: '<rect x="3.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M13.5 4.5h6v6M19.5 4.5l-7 7"/>',
  dockin: '<rect x="3.5" y="4.5" width="17" height="15" rx="3.5"/><path d="M14.5 4.5v15"/><path d="M11 10l-2.5 2 2.5 2"/>',
  gate: '<path d="M12 3.5l7 2.5v5.5c0 4.2-2.9 7.3-7 9-4.1-1.7-7-4.8-7-9V6z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
  workflow: '<rect x="3.5" y="4.5" width="7" height="5.5" rx="1.8"/><rect x="13.5" y="14" width="7" height="5.5" rx="1.8"/><path d="M7 10v2.5a2 2 0 0 0 2 2h4.5"/>',
  fit: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>',
  undo: '<path d="M9 8L5 12l4 4"/><path d="M5 12h9.5a4.5 4.5 0 0 1 0 9H12"/>',
  redo: '<path d="M15 8l4 4-4 4"/><path d="M19 12H9.5a4.5 4.5 0 0 0 0 9H12"/>',
  minus: '<path d="M5 12h14"/>',
  hand: '<path d="M8 12V6.5a1.5 1.5 0 0 1 3 0V11M11 11V5a1.5 1.5 0 0 1 3 0v6M14 11V6.5a1.5 1.5 0 0 1 3 0V13M8 12l-1.4-1.9a1.5 1.5 0 0 0-2.4 1.8L7 17a5 5 0 0 0 4 3h2.5a5 5 0 0 0 5-5v-2"/>',
  pointer: '<path d="M6 4l12 6.5-5.2 1.6L11 18z"/>',
  tidy: '<rect x="3.5" y="4.5" width="6" height="5" rx="1.5"/><rect x="14.5" y="4.5" width="6" height="5" rx="1.5"/><rect x="9" y="14.5" width="6" height="5" rx="1.5"/><path d="M6.5 9.5v2.5h11V9.5M12 12v2.5"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2.5"/>',
  skip: '<path d="M5 6l8 6-8 6zM16.5 6v12"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4.5v4h4"/><path d="M12 7.5V12l3 2"/>',
  more: '<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>',
  grip: '<circle cx="9" cy="6.5" r="1.1"/><circle cx="15" cy="6.5" r="1.1"/><circle cx="9" cy="12" r="1.1"/><circle cx="15" cy="12" r="1.1"/><circle cx="9" cy="17.5" r="1.1"/><circle cx="15" cy="17.5" r="1.1"/>',
  replay: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4.5v4h4"/><path d="M10.3 9.4l4.4 2.6-4.4 2.6z"/>',
};

const cache = new Map();
export function icon(name, size = 16, cls = '') {
  let tpl = cache.get(name);
  if (!tpl) {
    tpl = document.createElement('template');
    tpl.innerHTML =
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${P[name] || P.circle}</svg>`;
    cache.set(name, tpl);
  }
  const svg = tpl.content.firstChild.cloneNode(true);
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('class', 'icon' + (cls ? ' ' + cls : ''));
  return svg;
}
export const iconNames = Object.keys(P);
