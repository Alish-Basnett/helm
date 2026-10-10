// replay.js — scrubber over a task's activity (oldest → newest): range input, play/pause, 1×/4×.
// The owner shows `visibleRows()` in its timeline while `active`; this module owns only the controls.
import { h, setText, reducedMotion } from './dom.js';
import { icon } from './icons.js';
import { fmtClock, fmtElapsed, truncate } from './format.js';

const STEP_MS = 700; // at 1×
const SPEEDS = [1, 4];

/**
 * opts.getRows(): Activity[] ascending (all of them)
 * opts.onChange(): called whenever the visible window changes
 */
export function createReplay(opts) {
  let active = false;
  let index = 0;
  let follow = true; // sitting on the newest row → keep following live activity
  let speed = 1;
  let timer = null;
  let playing = false;

  const range = h('input', {
    type: 'range', class: 'rp-range', min: '0', max: '0', step: '1', value: '0', 'aria-label': 'Replay position',
    oninput: () => { pause(); setIndex(Number(range.value)); },
  });
  const playBtn = h('button', { class: 'icon-btn sm rp-play', type: 'button', 'aria-label': 'Play replay', title: 'Play', onclick: () => (playing ? pause() : play()) }, icon('play', 16));
  const speedBtn = h('button', { class: 'btn btn-quiet btn-sm rp-speed mono', type: 'button', 'aria-label': 'Playback speed 1×', title: 'Playback speed', onclick: () => cycleSpeed() }, '1×');
  const stepEl = h('span', { class: 'rp-step mono' });
  const timeEl = h('span', { class: 'rp-time mono' });
  const nowEl = h('div', { class: 'rp-now mono' });
  const el = h('div', { class: 'replay', hidden: true, role: 'group', 'aria-label': 'Activity replay' },
    h('div', { class: 'rp-controls' }, playBtn, range, speedBtn),
    h('div', { class: 'rp-readout' }, stepEl, timeEl),
    nowEl);

  const rows = () => opts.getRows() || [];

  function sync() {
    const all = rows();
    const n = all.length;
    range.max = String(Math.max(0, n - 1));
    if (follow || index > n - 1) index = Math.max(0, n - 1);
    range.value = String(index);
    range.disabled = n < 2;
    playBtn.disabled = n < 2;
    const cur = all[index];
    if (!cur) {
      setText(stepEl, 'No activity yet');
      setText(timeEl, '');
      setText(nowEl, '');
      range.setAttribute('aria-valuetext', 'No activity');
      return;
    }
    setText(stepEl, `Step ${index + 1} / ${n}`);
    const since = all[0] ? cur.at - all[0].at : 0;
    setText(timeEl, `${fmtClock(cur.at)}  +${fmtElapsed(since)}`);
    setText(nowEl, `${cur.tool || cur.kind}  ${truncate(cur.summary || '', 90)}`);
    range.setAttribute('aria-valuetext', `Step ${index + 1} of ${n}, ${fmtClock(cur.at)}`);
  }

  function setIndex(i) {
    const n = rows().length;
    index = Math.max(0, Math.min(Math.max(0, n - 1), i));
    follow = index >= n - 1;
    sync();
    opts.onChange && opts.onChange();
  }

  function tick() {
    const n = rows().length;
    if (index >= n - 1) { pause(); return; }
    setIndex(index + 1);
    if (index >= n - 1) pause();
  }
  function restartTimer() {
    clearInterval(timer);
    timer = playing ? setInterval(tick, Math.round(STEP_MS / speed) * (reducedMotion() ? 2 : 1)) : null;
  }
  function setPlayIcon() {
    playBtn.textContent = '';
    playBtn.append(icon(playing ? 'pause' : 'play', 16));
    playBtn.setAttribute('aria-label', playing ? 'Pause replay' : 'Play replay');
    playBtn.title = playing ? 'Pause' : 'Play';
  }
  function play() {
    const n = rows().length;
    if (n < 2) return;
    if (index >= n - 1) { index = 0; follow = false; sync(); opts.onChange && opts.onChange(); } // replay from the start
    playing = true;
    setPlayIcon();
    restartTimer();
  }
  function pause() {
    if (!playing) return;
    playing = false;
    setPlayIcon();
    restartTimer();
  }
  function cycleSpeed() {
    speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setText(speedBtn, `${speed}×`);
    speedBtn.setAttribute('aria-label', `Playback speed ${speed}×`);
    restartTimer();
  }

  return {
    el,
    get active() { return active; },
    setActive(on) {
      on = !!on;
      if (on === active) return;
      active = on;
      el.hidden = !on;
      if (on) { follow = true; sync(); } else pause();
      opts.onChange && opts.onChange();
    },
    /** Rows the owner's timeline should show right now. */
    visibleRows() {
      const all = rows();
      return active ? all.slice(0, index + 1) : all;
    },
    currentId() {
      if (!active) return null;
      const cur = rows()[index];
      return cur ? cur.id : null;
    },
    /** Call when the underlying activity may have changed. */
    refresh() { if (active) sync(); },
    destroy() { clearInterval(timer); timer = null; playing = false; },
  };
}
