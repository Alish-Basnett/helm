// studio/export.js — download a Studio document as HTML, PDF or Word through the hub (POST /v1/docs/export).
// A browser-only document sends its block tree in the request body; a hub document is exported by id. Nothing is
// built with innerHTML: the response is a Blob handed to a temporary <a download>.
export const EXPORT_FORMATS = [
  { format: 'html', label: 'HTML', ext: 'html' },
  { format: 'pdf', label: 'PDF', ext: 'pdf' },
  { format: 'docx', label: 'Word', ext: 'docx' },
];

const fileName = (title, ext) => `${String(title || 'document').replace(/[\u0000-\u001f\u007f<>:"|?*\\/]/g, '_').trim().slice(0, 80) || 'document'}.${ext}`;

/** Resolves with the saved file name. Rejects with an Error whose `.hint` suggests window.print() when the hub lacks the tool. */
export async function exportDoc({ format, title, blocks, docId = null }) {
  const spec = EXPORT_FORMATS.find((f) => f.format === format);
  if (!spec) throw new Error(`Unknown export format: ${format}`);
  let res;
  try {
    // A document the hub holds is exported from the hub's copy (it keeps bold, links and tables the editor shows as plain text).
    res = docId
      ? await fetch(`/v1/docs/${encodeURIComponent(docId)}/export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ format }) })
      : await fetch('/v1/docs/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ format, title, blocks }) });
  } catch { throw new Error('Hub unreachable'); }
  if (!res.ok) {
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    const err = new Error((data && data.error) || `Export failed (${res.status})`);
    err.status = res.status;
    err.hint = data && data.hint;
    throw err;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const name = fileName(title, spec.ext);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}
