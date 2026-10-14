// v0.25 (T-74): the project brief that goes into a doc_draft job. Pure builder (cap, selection), the safe file reader, and the
// hub wiring (POST /v1/docs with a prompt puts the brief in the job input).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTest, tmpDir } from './helpers.mjs';
import {
  buildBrief, excerpt, planHeadline, readHead, gatherBrief, estimateTokens,
  BRIEF_MAX_CHARS, README_CHARS, PLAN_CHARS, BRIEF_CONCEPTS, BRIEF_RECAPS, RECAP_CHARS,
} from '../docbrief.mjs';

const T0 = 1_800_000_000_000;

// ------------------------------------------------------------------------------ pure builder
test('brief: includes the name, folder, README start, plan headline, concepts and recap lines, in that order', () => {
  const b = buildBrief({
    name: 'Helm', path: '/work/helm', readme: '# Helm\n\nMission control for Claude Code.', plan: '# Plan: ship Studio\n\nStep one.',
    concepts: [{ name: 'SQLite', count: 4 }, { name: 'Testing', count: 1 }], recaps: [{ id: 'T-9', title: 'Add diagrams', what: 'Added the diagram block.' }],
  });
  const t = b.text;
  assert.match(t, /^Project: Helm \(folder: \/work\/helm\)/);
  assert.ok(t.indexOf('README') < t.indexOf('plan.md') && t.indexOf('plan.md') < t.indexOf('Top Learn concepts') && t.indexOf('Top Learn concepts') < t.indexOf('Latest finished work'));
  assert.match(t, /Mission control for Claude Code\./);
  assert.match(t, /plan\.md \(headline: Plan: ship Studio\)/);
  assert.match(t, /SQLite \(4 tasks\), Testing/);
  assert.match(t, /- T-9 Add diagrams: Added the diagram block\./);
  assert.deepEqual(b.sections, ['project', 'readme', 'plan', 'concepts', 'recaps']);
});

test('brief: only the parts that exist appear (a project with nothing known is just its name)', () => {
  const b = buildBrief({ name: 'Bare' });
  assert.equal(b.text, 'Project: Bare');
  assert.deepEqual(b.sections, ['project']);
  assert.deepEqual(buildBrief({ name: 'X', recaps: [{ id: 'T-1', title: 't', what: '' }] }).sections, ['project'], 'a recap with no "what" is skipped');
});

test('brief: selection limits (README ~1500 chars, plan ~600, top 8 concepts, last 6 recaps, each "what" cut)', () => {
  const readme = '# Title\n' + 'Lorem ipsum dolor sit amet. '.repeat(400);
  const plan = '# Headline\n' + 'Plan text. '.repeat(400);
  const concepts = Array.from({ length: 20 }, (_, i) => ({ name: `concept${i}`, count: 20 - i }));
  const recaps = Array.from({ length: 15 }, (_, i) => ({ id: `T-${i}`, title: `Task ${i}`, what: `What ${i} ` + 'x'.repeat(500) }));
  const t = buildBrief({ name: 'P', readme, plan, concepts, recaps }).text;
  const readmePart = t.slice(t.indexOf('README'), t.indexOf('plan.md'));
  assert.ok(readmePart.length <= README_CHARS + 60, `readme part ${readmePart.length}`);
  const planPart = t.slice(t.indexOf('plan.md'), t.indexOf('Top Learn'));
  assert.ok(planPart.length <= PLAN_CHARS + 80, `plan part ${planPart.length}`);
  assert.equal((t.match(/concept\d+/g) || []).length, BRIEF_CONCEPTS);
  assert.ok(t.includes('concept0 (20 tasks)') && !t.includes('concept8'));
  const lines = t.split('\n').filter((l) => /^- T-\d+/.test(l));
  assert.equal(lines.length, BRIEF_RECAPS);
  assert.ok(lines.every((l) => l.length <= RECAP_CHARS + 40), 'each recap line is cut');
  assert.ok(lines[0].startsWith('- T-0') && lines.at(-1).startsWith('- T-5'), 'the caller sends newest first; the brief keeps that order');
});

test('brief: the total never exceeds the cap (about 2.5k tokens), whatever is thrown at it', () => {
  const huge = 'word '.repeat(50_000);
  const b = buildBrief({
    name: 'N'.repeat(5000), path: '/p/' + 'd'.repeat(5000), readme: huge, plan: huge,
    concepts: Array.from({ length: 500 }, (_, i) => ({ name: 'c'.repeat(300) + i, count: 3 })), recaps: Array.from({ length: 500 }, (_, i) => ({ id: `T-${i}`, title: 't'.repeat(500), what: huge })),
  });
  assert.ok(b.text.length <= BRIEF_MAX_CHARS, `${b.text.length} chars`);
  assert.ok(b.tokens <= 2500 && b.tokens === estimateTokens(b.text));
  const tight = buildBrief({ name: 'P', readme: huge }, { max: 300 });
  assert.ok(tight.text.length <= 300);
  assert.ok(tight.text.startsWith('Project: P'));
  assert.ok(buildBrief({ name: 'P', readme: 'tiny' }).text.length < 100, 'a small brief stays small');
});

test('excerpt: badges, images and HTML comments are dropped, blank runs collapse, the cut prefers a line end', () => {
  const md = '<!-- hidden -->\n[![ci](x)](y)\n![logo](l.png)\n# Real\n\n\n\nText here.\n<img src="a.png">\nMore.';
  assert.equal(excerpt(md, 500), '# Real\n\nText here.\nMore.');
  const long = Array.from({ length: 50 }, (_, i) => `line number ${i}`).join('\n');
  const cut = excerpt(long, 100);
  assert.ok(cut.length <= 102 && cut.endsWith('…'));
  assert.ok(/line number \d+\n…$/.test(cut), 'cut at a line end');
  assert.equal(excerpt('', 10), '');
  assert.equal(excerpt(null, 10), '');
  assert.equal(planHeadline('\n\n## The headline\nbody'), 'The headline');
  assert.equal(planHeadline(''), '');
});

// ------------------------------------------------------------------------------ file reading
test('readHead: reads the start of a regular file; refuses symlinks, folders and missing files; never throws', () => {
  const dir = tmpDir('brief-');
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), 'x'.repeat(20_000));
    assert.equal(readHead(path.join(dir, 'a.md'), 100).length, 100);
    fs.writeFileSync(path.join(dir, 'u.md'), '€'.repeat(10)); // a multi-byte character cut in half is trimmed, not shown as garbage
    assert.ok(!readHead(path.join(dir, 'u.md'), 7).includes('�'));
    fs.symlinkSync(path.join(dir, 'a.md'), path.join(dir, 'link.md'));
    assert.equal(readHead(path.join(dir, 'link.md')), null, 'a symlink is not followed');
    fs.mkdirSync(path.join(dir, 'README.md.d'));
    assert.equal(readHead(path.join(dir, 'README.md.d')), null);
    assert.equal(readHead(path.join(dir, 'missing.md')), null);
    assert.equal(readHead('\u0000bad'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------------------ hub wiring
async function setup(cwd) {
  const h = await startTest();
  const clock = { t: T0 };
  h.hub.setClock(() => clock.t);
  h.send(h.ev('s1', 'session.started', { cwd, title: 'Main', model: 'm' }, clock.t));
  const pid = h.state().projects[0].id;
  let n = 0;
  const recap = (title, what, concepts, at) => {
    const { task } = h.hub.createTask({ projectId: pid, title }, at);
    h.send(h.ev('s1', 'recap.generated', { taskId: task.id, what, how: 'how', learned: 'learned', concepts }, at + ++n));
    return task.id;
  };
  return { h, clock, pid, recap };
}

test('hub: POST /v1/docs with a prompt puts the project brief in the doc_draft input (README, plan, concepts, newest recaps)', async (t) => {
  const dir = tmpDir('brief-proj-');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Acme Billing\n\nAcme Billing sends invoices and chases late payments.\n');
  fs.writeFileSync(path.join(dir, 'plan.md'), '# Plan: invoice reminders\n\nPhase one is reminders by email.\n');
  const { h, pid, recap } = await setup(dir);
  t.after(async () => { await h.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 8; i++) recap(`Task ${i}`, `Did thing number ${i}`, i % 2 ? ['Stripe', 'Webhooks'] : ['Stripe', 'Cron'], T0 + i * 1000);
  const r = await h.api('POST', '/v1/docs', { projectId: pid, title: 'One pager', prompt: 'a one page overview, 40% diagrams' });
  assert.equal(r.status, 201);
  const input = r.json.job.input;
  assert.equal(typeof input.brief, 'string');
  const brief = input.brief;
  assert.match(brief, new RegExp(`^Project: ${h.state().projects[0].name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.ok(brief.includes(dir.replace(process.env.HOME, '~')) || brief.includes(dir), 'the folder is named');
  assert.match(brief, /Acme Billing sends invoices and chases late payments\./);
  assert.match(brief, /plan\.md \(headline: Plan: invoice reminders\)/);
  assert.match(brief, /stripe \(8 tasks\)/);
  assert.match(brief, /Did thing number 7/, 'the newest recap is there');
  assert.ok(!brief.includes('Did thing number 0'), 'recaps older than the last six are left out');
  assert.ok(brief.length <= BRIEF_MAX_CHARS);
  assert.equal(input.projectName, h.state().projects[0].name);
  assert.equal(input.prompt, 'a one page overview, 40% diagrams');
});

test('hub: a project folder without README or plan still gets a brief from concepts and recaps; a missing folder is fine', async (t) => {
  const { h, pid, recap } = await setup('/definitely/not/a/folder');
  t.after(h.stop);
  recap('Only task', 'Fixed the login redirect.', ['OAuth'], T0);
  const r = await h.api('POST', '/v1/docs', { projectId: pid, title: 'Doc', prompt: 'write something' });
  const b = r.json.job.input.brief;
  assert.ok(!/README|plan\.md/.test(b));
  assert.match(b, /oauth/);
  assert.match(b, /Fixed the login redirect\./);
});

test('hub: no prompt means no job and no brief work; gatherBrief reads only README.md and plan.md', async (t) => {
  const dir = tmpDir('brief-proj-');
  fs.writeFileSync(path.join(dir, 'README.md'), 'Readme body');
  fs.writeFileSync(path.join(dir, 'secrets.txt'), 'DO NOT LEAK');
  fs.writeFileSync(path.join(dir, 'notes.md'), 'DO NOT LEAK either');
  const { h, pid } = await setup(dir);
  t.after(async () => { await h.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const r = await h.api('POST', '/v1/docs', { projectId: pid, title: 'Blank' });
  assert.equal(r.json.job, null);
  const g = gatherBrief(h.hub.db, h.hub.p.getProject(pid), 's1');
  assert.match(g.text, /Readme body/);
  assert.ok(!/DO NOT LEAK/.test(g.text));
});
