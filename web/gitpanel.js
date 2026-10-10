// gitpanel.js — the "Git" section of a task (Task details and the Review pane): create a branch from the task's
// files, update it, push it behind a confirm dialog that names the remote URL / branch / files, paste or follow the PR,
// and watch CI. Nothing here pushes on its own: the only call to the push endpoint is the dialog's confirm button.
// Everything from git and GitHub (branch names, URLs, check names) is rendered as text nodes; links only use http(s).
import { h, setText, setHidden, setClass, reconcile } from './dom.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { toast } from './ui.js';
import { createBranch, updateBranch, pushBranch, linkPr, cleanBranch, refreshCi } from './actions.js';
import { branchNameFor, shortSha, safeHref, ciSummary, checkTone, checkLabel, prChip, unpushed } from './git.js';
import { plural } from './format.js';

async function copyText(text) {
  try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall back */ }
  try {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }); ta.value = text; document.body.append(ta); ta.select();
    const ok = document.execCommand && document.execCommand('copy'); ta.remove(); return !!ok;
  } catch { return false; }
}
const relTo = (root, f) => (root && f.startsWith(root + '/') ? f.slice(root.length + 1) : f);

/** A small modal. `body` is a node, `actions` buttons; Esc and the scrim close it. Returns { close, el }. */
function openDialog({ title, body, actions, label }) {
  const prev = document.activeElement;
  const dlg = h('div', { class: 'git-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': label || title },
    h('h3', { class: 'git-dlg-title' }, icon('branch', 16), title), body, h('div', { class: 'git-dlg-actions' }, actions));
  dlg.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); }); // the page's single-key shortcuts stay out of the dialog
  const scrim = h('div', { class: 'git-scrim', onmousedown: (e) => { if (e.target === scrim) close(); } }, dlg);
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') { // keep focus inside
      const f = Array.from(dlg.querySelectorAll('button, select, input, a[href]')).filter((x) => !x.disabled && !x.hidden);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  function close() {
    document.removeEventListener('keydown', onKey, true);
    scrim.remove();
    if (prev && prev.isConnected && typeof prev.focus === 'function') prev.focus({ preventScroll: true });
  }
  document.addEventListener('keydown', onKey, true);
  document.body.append(scrim);
  const first = dlg.querySelector('[data-autofocus]') || dlg.querySelector('button');
  if (first) first.focus({ preventScroll: true });
  return { close, el: dlg };
}

/** variant 'rv' matches the Review pane's section style; the default matches Task details. */
export function createGitPanel({ getTask, variant = 'sheet' }) {
  const c = {};
  let warnings = [];       // the last create/update warnings (files that changed after the task ended, skipped files)
  let busy = false;
  let lastSig = '';

  c.count = h('span', { class: 'panel-count mono' });
  c.title = h('h3', { class: variant === 'rv' ? 'rv-sec-title' : 'section-title' }, icon('branch', 14), 'Git', c.count);
  // before a branch exists
  c.createBtn = h('button', { class: 'btn btn-accent btn-sm', type: 'button', onclick: () => doCreate() }, icon('branch', 14), h('span', {}, 'Create branch'));
  c.previewHead = h('div', { class: 'git-line' });
  c.previewFiles = h('ul', { class: 'git-files mono' });
  c.previewNote = h('p', { class: 'git-hint' }, 'Helm makes a separate worktree at that commit and copies only this task’s files into it. Your working tree and current branch are not touched, and nothing is pushed until you confirm.');
  c.pre = h('div', { class: 'git-pre' }, c.previewHead, c.previewFiles, c.previewNote, h('div', { class: 'git-actions' }, c.createBtn));
  // after
  c.branchName = h('code', { class: 'git-branch mono' });
  c.copyBtn = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Copy branch name', title: 'Copy branch name', onclick: async () => { const t = getTask(); if (t && t.branch) toast((await copyText(t.branch.name)) ? 'Branch name copied' : 'Could not copy: clipboard blocked', { kind: 'info', duration: 1800 }); } }, icon('copy', 14));
  c.commit = h('span', { class: 'git-commit mono' });
  c.state = h('span', { class: 'git-state mono' });
  c.nameRow = h('div', { class: 'git-line' }, icon('branch', 14, 'git-line-icon'), c.branchName, c.copyBtn, c.commit, c.state);
  c.updateBtn = h('button', { class: 'btn btn-sm', type: 'button', title: 'Re-copy the task’s files from your working tree and add a commit', onclick: () => doUpdate() }, icon('retry', 14), h('span', {}, 'Update branch'));
  c.pushBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openPush() }, icon('upload', 14), h('span', { class: 'git-push-l' }, 'Push & open PR…'));
  c.cleanBtn = h('button', { class: 'btn btn-quiet btn-sm', type: 'button', title: 'Remove the worktree, and optionally the local branch', onclick: () => openClean() }, icon('trash', 14), h('span', {}, 'Clean up…'));
  c.actions = h('div', { class: 'git-actions' }, c.updateBtn, c.pushBtn, c.cleanBtn);
  c.prLink = h('a', { class: 'btn btn-accent btn-sm git-open-pr', target: '_blank', rel: 'noopener noreferrer', hidden: true }, icon('external', 14), h('span', {}, 'Open PR on GitHub'));
  c.pasteIn = h('input', { class: 'git-paste-in mono', type: 'url', placeholder: 'Paste the PR link', 'aria-label': 'Paste the pull request link', spellcheck: 'false',
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); doLink(); } } });
  c.pasteBtn = h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: () => doLink() }, 'Link');
  c.paste = h('div', { class: 'git-paste' }, c.pasteIn, c.pasteBtn);
  c.pushed = h('div', { class: 'git-line git-pushed mono' });
  c.prChipEl = h('a', { class: 'git-pr', target: '_blank', rel: 'noopener noreferrer', hidden: true }, icon('branch', 12), h('span', {}));
  c.unlink = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Unlink the PR', title: 'Unlink the PR', hidden: true, onclick: async () => { const t = getTask(); if (t) await linkPr(t.id, null); } }, icon('close', 12));
  c.prRow = h('div', { class: 'git-line' }, c.prChipEl, c.unlink);
  c.ciSum = h('span', { class: 'git-ci-sum' }, h('span', { class: 'ci-dot', 'aria-hidden': 'true' }), h('span', {}));
  c.ciRetry = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Check CI again', title: 'Check CI again', onclick: async () => { const t = getTask(); if (t) await refreshCi(t.id); } }, icon('retry', 13));
  c.checks = h('ul', { class: 'git-checks' });
  c.ci = h('div', { class: 'git-ci' }, h('div', { class: 'git-line' }, c.ciSum, c.ciRetry), c.checks);
  c.warn = h('ul', { class: 'git-warn' });
  c.has = h('div', { class: 'git-has' }, c.nameRow, c.actions, c.pushed, c.prLink, c.paste, c.prRow, c.ci, c.warn);
  c.el = h('section', { class: `${variant === 'rv' ? 'rv-sec' : 'sheet-section'} git-section`, hidden: true }, c.title, c.pre, c.has);

  function setBusy(on) { busy = on; for (const b of [c.createBtn, c.updateBtn, c.pushBtn, c.cleanBtn]) b.disabled = on; }
  const showWarnings = (r) => { warnings = (r && r.warnings) || []; if (warnings.length) toast(`${plural(warnings.length, 'warning')}: see the Git section`, { kind: 'info', duration: 4500 }); };

  async function doCreate() {
    const t = getTask(); if (!t || busy) return;
    setBusy(true);
    const r = await createBranch(t.id);
    setBusy(false);
    if (r) { showWarnings(r); toast(`Branch ${r.branch.name} created`, { kind: 'success' }); }
    update(getTask(), true);
  }
  async function doUpdate() {
    const t = getTask(); if (!t || busy) return;
    setBusy(true);
    const r = await updateBranch(t.id);
    setBusy(false);
    if (r) { showWarnings(r); toast(r.unchanged ? 'The branch is already up to date' : 'Added a commit to the branch', { kind: r.unchanged ? 'info' : 'success' }); }
    update(getTask(), true);
  }
  async function doLink() {
    const t = getTask(); const v = c.pasteIn.value.trim();
    if (!t || busy) return;
    if (!v) { c.pasteIn.focus(); return; }
    setBusy(true);
    const r = await linkPr(t.id, v);
    setBusy(false);
    if (r) { c.pasteIn.value = ''; toast('PR linked', { kind: 'success', duration: 2000 }); }
    update(getTask(), true);
  }

  /* ----- push: the confirm dialog ----- */
  async function openPush() {
    const t = getTask();
    if (!t || !t.branch || busy) return;
    const id = t.id, b = t.branch;
    const remotesBox = h('div', { class: 'git-remotes' }, h('p', { class: 'git-hint' }, 'Reading the repo’s remotes…'));
    const filesBox = h('ul', { class: 'git-files mono' });
    const files = (b.files && b.files.length ? b.files : t.filesChanged.map((f) => relTo(t.git && t.git.root, f)));
    for (const f of files.slice(0, 12)) filesBox.append(h('li', { title: f }, f));
    if (files.length > 12) filesBox.append(h('li', { class: 'dim' }, `+${files.length - 12} more`));
    let remote = null, remotes = [];
    const go = h('button', { class: 'btn btn-primary btn-sm', type: 'button', disabled: true }, icon('upload', 14), h('span', {}, 'Push branch'));
    const cancel = h('button', { class: 'btn btn-quiet btn-sm', type: 'button' }, 'Cancel');
    const body = h('div', { class: 'git-dlg-body' },
      h('p', { class: 'git-dlg-lead' }, 'This runs ', h('code', { class: 'mono' }, 'git push -u'), ' from Helm’s worktree. It never force-pushes and uses your existing git credentials.'),
      h('dl', { class: 'git-dl' },
        h('dt', {}, 'Remote'), h('dd', {}, remotesBox),
        h('dt', {}, 'Branch'), h('dd', { class: 'mono' }, b.name),
        h('dt', {}, 'Commit'), h('dd', { class: 'mono' }, shortSha(b.commit), b.pushedCommit && b.pushedCommit !== b.commit ? ' (adds commits since the last push)' : ''),
        h('dt', {}, plural(files.length, 'file')), h('dd', {}, filesBox)));
    const dlg = openDialog({ title: 'Push this branch?', label: `Push ${b.name}`, body, actions: [cancel, go] });
    cancel.onclick = () => dlg.close();
    go.onclick = async () => {
      if (!remote || go.disabled) return;
      go.disabled = true; cancel.disabled = true;
      setText(go.lastChild, 'Pushing…');
      setBusy(true);
      const r = await pushBranch(id, remote.name);
      setBusy(false);
      if (r) {
        dlg.close();
        toast(r.compareUrl ? `Pushed ${b.name}: open the PR from the link below` : `Pushed ${b.name} to ${remote.name}`, { kind: 'success' });
        update(getTask(), true);
      } else { go.disabled = false; cancel.disabled = false; setText(go.lastChild, 'Push branch'); }
    };
    const paintRemotes = () => {
      remotesBox.textContent = '';
      if (!remotes.length) { remotesBox.append(h('p', { class: 'git-hint err' }, 'This repo has no remotes, so there is nothing to push to. Add one with git remote add.')); go.disabled = true; return; }
      if (remotes.length > 1) {
        const sel = h('select', { class: 'select select-sm', 'aria-label': 'Remote', 'data-autofocus': '1', onchange: () => { remote = remotes.find((r) => r.name === sel.value) || remotes[0]; paintRemotes(); } },
          remotes.map((r) => h('option', { value: r.name }, r.name)));
        sel.value = remote.name;
        remotesBox.append(sel);
      }
      remotesBox.append(h('div', { class: 'git-remote-url mono' }, h('span', { class: 'git-remote-name' }, remote.name), ' ', h('span', { title: remote.url }, remote.url)));
      if (remote.pushUrl) remotesBox.append(h('div', { class: 'git-remote-url mono dim' }, 'pushes to ', h('span', { title: remote.pushUrl }, remote.pushUrl)));
      remotesBox.append(h('p', { class: 'git-hint' }, remote.github ? 'GitHub: after the push Helm links a pre-filled compare page where you open the PR yourself.' : 'Not a GitHub remote: Helm will push and say so, with no PR link.'));
      go.disabled = false;
    };
    try {
      const info = await api.gitInfo(id);
      remotes = info.remotes || [];
      remote = remotes.find((r) => r.name === (b.remote || 'origin')) || remotes[0] || null;
    } catch (e) { remotesBox.textContent = ''; remotesBox.append(h('p', { class: 'git-hint err' }, `Could not read the remotes: ${e.message}`)); return; }
    paintRemotes();
    if (remote) go.focus({ preventScroll: true });
  }

  /* ----- clean up ----- */
  function openClean() {
    const t = getTask();
    if (!t || !t.branch || busy) return;
    const id = t.id, b = t.branch;
    const del = h('input', { type: 'checkbox', id: `git-del-${id}` });
    const force = h('input', { type: 'checkbox', id: `git-force-${id}` });
    const go = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Clean up');
    const cancel = h('button', { class: 'btn btn-quiet btn-sm', type: 'button' }, 'Cancel');
    const body = h('div', { class: 'git-dlg-body' },
      h('p', { class: 'git-dlg-lead' }, 'Removes Helm’s worktree for ', h('code', { class: 'mono' }, b.name), '. Your working tree is not touched, and remote branches are never deleted.'),
      h('label', { class: 'git-check', for: del.id }, del, h('span', {}, 'Also delete the local branch')),
      h('label', { class: 'git-check', for: force.id }, force, h('span', {}, 'Discard it even if it has unpushed commits')));
    const dlg = openDialog({ title: 'Clean up this branch?', body, actions: [cancel, go] });
    cancel.onclick = () => dlg.close();
    go.onclick = async () => {
      go.disabled = true; setBusy(true);
      const r = await cleanBranch(id, { deleteBranch: del.checked, force: force.checked });
      setBusy(false);
      if (r) { dlg.close(); warnings = []; toast(r.branchDeleted ? 'Worktree and local branch removed' : 'Worktree removed; the branch is kept', { kind: 'success' }); update(getTask(), true); } else go.disabled = false;
    };
  }

  /* ----- painting ----- */
  function update(t, force = false) {
    t = t || getTask();
    if (!t) return;
    const b = t.branch || null;
    const hasFiles = (t.filesChanged || []).length > 0;
    const eligible = !!t.git && hasFiles;
    setHidden(c.el, !b && !eligible);
    if (!b && !eligible) return;
    const sig = JSON.stringify([b, t.title, t.git && t.git.head, t.filesChanged, warnings, busy]);
    if (sig === lastSig && !force) return;
    lastSig = sig;
    setHidden(c.pre, !!b);
    setHidden(c.has, !b);
    setText(c.count, b ? (b.pr ? prChip(b.pr).text : b.pushedAt ? 'pushed' : 'local') : '');
    if (!b) {
      c.previewHead.textContent = '';
      c.previewHead.append(icon('branch', 14, 'git-line-icon'), h('code', { class: 'git-branch mono' }, branchNameFor(t.id, t.title)), h('span', { class: 'git-commit mono', title: 'The commit your HEAD was at when the task started' }, `from ${shortSha(t.git.head)}`));
      const files = t.filesChanged.map((f) => relTo(t.git.root, f));
      c.previewFiles.textContent = '';
      for (const f of files.slice(0, 8)) c.previewFiles.append(h('li', { title: f }, f));
      if (files.length > 8) c.previewFiles.append(h('li', { class: 'dim' }, `+${files.length - 8} more`));
      return;
    }
    setText(c.branchName, b.name);
    const un = unpushed(b);
    setText(c.commit, shortSha(b.commit));
    c.commit.title = `Commit ${b.commit}, branched from ${shortSha(b.base)}`;
    setText(c.state, !b.pushedAt ? 'local only' : un ? 'unpushed commits' : `pushed to ${b.remote}`);
    c.state.className = `git-state mono ${!b.pushedAt ? '' : un ? 'is-warn' : 'is-ok'}`;
    setText(c.pushBtn.querySelector('.git-push-l'), b.pushedAt ? (un ? 'Push update…' : 'Push again…') : 'Push & open PR…');
    // push result
    const href = b.pr ? null : safeHref(b.prUrl);
    setHidden(c.prLink, !href);
    if (href) c.prLink.href = href; else c.prLink.removeAttribute('href');
    c.pushed.textContent = '';
    if (b.pushedAt && !b.prUrl && !b.pr) c.pushed.append(`Pushed to ${b.remote}${b.remoteUrl ? ' · ' + b.remoteUrl : ''}. This host has no PR link, so open the PR there yourself.`);
    setHidden(c.pushed, !(b.pushedAt && !b.prUrl && !b.pr));
    setHidden(c.paste, !b.pushedAt || !!b.pr);
    // PR chip
    const chip = prChip(b.pr);
    setHidden(c.prRow, !chip);
    setHidden(c.prChipEl, !chip);
    setHidden(c.unlink, !chip);
    if (chip) {
      const ph = safeHref(b.pr.url);
      if (ph) c.prChipEl.href = ph; else c.prChipEl.removeAttribute('href');
      c.prChipEl.className = `git-pr pr-${chip.state}`;
      setText(c.prChipEl.lastChild, chip.text);
      c.prChipEl.title = b.pr.url || '';
    }
    // CI
    const ci = ciSummary(b.ci);
    setHidden(c.ci, !ci);
    if (ci) {
      c.ciSum.className = `git-ci-sum tone-${ci.tone}`;
      setText(c.ciSum.lastChild, ci.label);
      c.ciSum.title = b.ci.state === 'unknown' ? (b.ci.reason || '') : '';
      setHidden(c.ciRetry, b.ci.state === 'success');
      reconcile(c.checks, b.ci.checks || [], (k) => k.name, (k) => {
        const dot = h('span', { class: 'ci-dot', 'aria-hidden': 'true' });
        const name = h('span', { class: 'ci-name' });
        const res = h('span', { class: 'ci-res mono' });
        const a = h('a', { class: 'ci-check', target: '_blank', rel: 'noopener noreferrer' }, dot, name, res);
        return h('li', {}, a);
      }, (li, k) => {
        const a = li.firstChild;
        const hr = safeHref(k.url);
        if (hr) a.href = hr; else a.removeAttribute('href');
        a.className = `ci-check tone-${checkTone(k)}`;
        setText(a.children[1], k.name);
        setText(a.children[2], checkLabel(k));
      });
      if (b.ci.state === 'unknown' && b.ci.reason) {
        if (!c.ci.__reason) { c.ci.__reason = h('p', { class: 'git-hint' }); c.ci.append(c.ci.__reason); }
        setText(c.ci.__reason, b.ci.reason);
      } else if (c.ci.__reason) setText(c.ci.__reason, '');
    }
    // warnings
    reconcile(c.warn, warnings.map((w, i) => ({ k: `${i}:${w}`, w })), (x) => x.k, (x) => h('li', {}, icon('warning', 12), h('span', {})), (li, x) => setText(li.lastChild, x.w));
    setHidden(c.warn, !warnings.length);
    setBusy(busy);
  }

  return { el: c.el, update, destroy() { /* dialogs close themselves */ } };
}
