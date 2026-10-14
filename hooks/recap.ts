// T-76: parse a builder's final report (DONE / HOW / FILES / LEARNED / TAGS) into a recap, with no model call.
// Typed copy of hub/recap.mjs for the mod (keep the two in step; both are tested against the same real reports).
// Handles plain labels, **bold** labels (`**DONE:**`, `**DONE**:`), `## DONE` headings, multi-line and bulleted sections.

const LABELS = ['DONE', 'HOW', 'FILES', 'LEARNED', 'TAGS'];
// A label line: optional heading/quote marks, optional bold, the label in capitals, optional bold, a colon or dash, the rest of the line.
const LABEL_RE = /^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]*)?(\*\*|__)?(DONE|HOW|FILES|LEARNED|TAGS)(\*\*|__)?[ \t]*(:|[-–—])?[ \t]*(\*\*|__)?[ \t]*(.*)$/;

/** Split a report into { DONE, HOW, ... } raw texts, taking the last DONE label onward (a quoted earlier report is ignored). */
export function reportSections(answer: unknown) {
  const lines = String(answer ?? '').replace(/\r\n?/g, '\n').split('\n');
  const marks: { label: string; line: number; rest: string }[] = [];
  let inFence = false;
  lines.forEach((line: string, i: number) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    const m = LABEL_RE.exec(line);
    if (!m) return;
    // A bare capital word is only a label with a colon/dash, bold or a heading mark in front of it.
    const decorated = !!(m[4] || m[1] || /^[ \t]{0,3}#/.test(line));
    if (!decorated) return;
    marks.push({ label: m[2], line: i, rest: m[6] ?? '' });
  });
  let start = 0;
  marks.forEach((m, k) => { if (m.label === 'DONE') start = k; });
  const out: Record<string, string> = {};
  for (let k = start; k < marks.length; k++) {
    const m = marks[k]!;
    const end = k + 1 < marks.length ? marks[k + 1]!.line : lines.length;
    const text = [m.rest, ...lines.slice(m.line + 1, end)].join('\n').trim();
    if (!(m.label in out) && text) out[m.label] = text;
  }
  return out;
}

/** Markdown to one plain line: no bullets, bold, backticks, links or heading marks. */
export function plain(text: unknown) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .split('\n')
    .map((l: string) => l.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, '').replace(/^\s*#{1,6}\s+/, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cut at a sentence end if one falls in the second half of the budget, else at a word, with an ellipsis. */
export function fit(text: unknown, max: number) {
  const t = String(text ?? '').trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (sentence >= max * 0.5) return head.slice(0, sentence + 1);
  const space = head.lastIndexOf(' ');
  return (space > max * 0.5 ? head.slice(0, space) : head.slice(0, max - 1)).replace(/[\s,;:(\-–—]+$/, '') + '…';
}

const tagList = (raw: string) => plain(raw).split(/[,;]\s*/)
  .map((t: string) => t.replace(/^#/, '').trim().toLowerCase())
  .filter((t: string) => t && !/^none\.?$/.test(t))
  .slice(0, 3)
  .map((t: string) => fit(t, 24));

/** { what, how, learned, concepts } from a final report, or null when DONE or LEARNED is missing. */
export function recapFromReport(answer: unknown): { what: string; how: string; learned: string; concepts: string[] } | null {
  const s = reportSections(answer);
  const what = plain(s.DONE), learned = plain(s.LEARNED);
  if (!what || !learned) return null;
  return {
    what: fit(what, 220),
    how: fit(plain(s.HOW), 360),
    learned: fit(learned, 400),
    concepts: tagList(s.TAGS ?? ''),
  };
}

/** The FILES line as a list of paths (backticks stripped, "none" ignored, multi-line lists allowed). */
export function reportedFiles(answer: unknown): string[] {
  const raw = reportSections(answer).FILES;
  if (!raw) return [];
  return raw.split(/,\s*|\n/).map((f: string) => f.replace(/^\s*(?:[-*+•]\s+)?/, '').trim().replace(/^`+|`+$/g, ''))
    .filter((f: string) => f && !/^none\.?$/i.test(f)).slice(0, 100);
}

/** True when a stored recap looks like the output of the old line-based parser (cut off, or a HOW that is only a label). */
export function looksDegraded(recap: any) {
  if (!recap) return false;
  const how = String(recap.how ?? '').trim();
  return /…$/.test(String(recap.what ?? '')) || /…$/.test(String(recap.learned ?? ''))
    || /^[-*\s]*\**[^.]{0,40}:\**$/.test(how) || how === '';
}
