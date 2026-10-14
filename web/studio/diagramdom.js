// studio/diagramdom.js — draws a `diagram` block as SVG with DOM calls only (createElementNS, setAttribute, textContent).
// Labels never touch innerHTML. The picture comes from diagram.js (parse, layout, drawing primitives); colours come from the
// .dg-* rules in studio.css, so the editor follows the app theme and the paper preview stays white.
import { parseDiagram, layoutDiagram, diagramPrims, diagramLabel } from './diagram.js';

const NS = 'http://www.w3.org/2000/svg';

/** Build the <svg> element for a layout. */
export function svgFromLayout(layout, parsed) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'dg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', diagramLabel(parsed));
  svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
  svg.setAttribute('width', String(layout.width));
  svg.setAttribute('height', String(layout.height));
  svg.style.maxWidth = '100%';
  svg.style.height = 'auto';
  for (const p of diagramPrims(layout)) {
    const el = document.createElementNS(NS, p.tag);
    for (const k in p.attrs) el.setAttribute(k, String(p.attrs[k]));
    if (p.text !== undefined) el.textContent = p.text;
    svg.appendChild(el);
  }
  return svg;
}

/**
 * Parse the source and draw what could be read. Returns { svg, errors, empty }: `svg` is null when there is nothing to draw
 * (no nodes), `errors` is the parser's list ({ line, message }) so the caller can show it next to the source.
 */
export function buildDiagram(source) {
  const parsed = parseDiagram(source);
  if (!parsed.nodes.length) return { svg: null, errors: parsed.errors, empty: !String(source || '').trim() };
  return { svg: svgFromLayout(layoutDiagram(parsed), parsed), errors: parsed.errors, empty: false };
}
