'use strict';

/* =========================================================================
   Constants & small helpers
   ========================================================================= */

const STORE_KEY = 'trackfit:v1';
// The Apps Script web app attached to the Trackfit sheet. It rejects anything without the password.
const SHEET_URL = 'https://script.google.com/macros/s/AKfycbx71NmUZdOI1tereW-LWlX9UOhbsv32yLI-v7gkR-VRn3BmkWfo1mvH7NaXqSXNYGDO/exec';
const SYNC_FILE = 'trackfit-data.json';
const KG_PER_LB = 0.45359237;
const MUSCLES = ['Chest', 'Back', 'Shoulders', 'Biceps', 'Triceps', 'Legs', 'Glutes', 'Core', 'Cardio', 'Full body', 'Other'];
const PLATES = { lb: [45, 35, 25, 10, 5, 2.5], kg: [25, 20, 15, 10, 5, 2.5, 1.25] };
const DEFAULT_SETTINGS = { unit: 'lb', restSeconds: 90, barLb: 45, barKg: 20, stepLb: 5, stepKg: 2.5, updatedAt: 0 };

const LINK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><path d="M10 14l4-4M8.5 11.5l-2 2a3.5 3.5 0 0 0 5 5l2-2M15.5 12.5l2-2a3.5 3.5 0 0 0-5-5l-2 2"/></svg>';
const app = document.getElementById('app');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const clone = (x) => JSON.parse(JSON.stringify(x));

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmtNum(n, digits = 2) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits });
}

function fmtWeight(w, unit) {
  return Number(w) === 0 ? 'Bodyweight' : `${fmtNum(w)} ${unit}`;
}

function fmtDate(ts, opts = { month: 'short', day: 'numeric' }) {
  return new Date(ts).toLocaleDateString(undefined, opts);
}

function fmtDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function fmtSecs(sec) {
  sec = Math.round(Number(sec) || 0);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function fmtHuman(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

function fmtAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return fmtDate(ts);
}

// "45s", "90 sec", "1:30", "2m" → seconds. Anything else (10, 8-12, AMRAP) → null.
function parseTime(reps) {
  const s = String(reps).trim().toLowerCase();
  let m;
  if ((m = s.match(/^(\d+):(\d{1,2})$/))) return Number(m[1]) * 60 + Number(m[2]);
  if ((m = s.match(/^(\d+)\s*(s|sec|secs|seconds?)$/))) return Number(m[1]);
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?)$/))) return Math.round(Number(m[1]) * 60);
  return null;
}

function fmtTarget(reps) {
  const t = parseTime(reps);
  return t != null ? fmtSecs(t) : `${reps} reps`;
}

// Reps like "8-12" or "AMRAP" can't prefill a number box; use the first number if there is one.
function defaultReps(reps) {
  const m = String(reps).match(/\d+/);
  return m ? m[0] : '';
}

function convert(w, from, to) {
  if (from === to) return w;
  return from === 'lb' ? w * KG_PER_LB : w / KG_PER_LB;
}

// Converted weights get rounded to something loadable on a bar.
function convertForBar(w, from, to) {
  if (from === to) return w;
  const step = to === 'kg' ? 1.25 : 2.5;
  return Math.round(convert(w, from, to) / step) * step;
}

// Estimated one-rep max (Epley).
function epley(w, reps) {
  reps = Number(reps);
  if (!w || !reps || reps < 1) return 0;
  return reps === 1 ? w : w * (1 + Math.min(reps, 15) / 30);
}

function weekStart(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  return d.getTime();
}

/* =========================================================================
   Storage: everything lives in localStorage on this device.
   ========================================================================= */

function emptyDb() {
  return {
    version: 2,
    workouts: [], // { id, name, createdAt, updatedAt, exercises: [{ id, name, sets, reps, link }] }
    history: [], // finished sessions, oldest first
    meta: {}, // per exercise (keyed by normalized name): { name, muscle, note, target, updatedAt }
    deleted: {}, // id → deletion time, so deletes survive a sync merge
    active: null, // the session currently being executed (never synced)
    settings: { ...DEFAULT_SETTINGS },
    sync: { token: '', gistId: '', lastSync: 0, auto: true, error: '' }, // device-only
    sheets: { lastPush: 0, dirty: false, error: '' }, // device-only
    auth: { hash: '', at: 0 }, // device-only: SHA-256 of the password in Workouts!Z100
  };
}

// Accepts saved data of any version (or a backup file) and returns a complete v2 db.
function migrate(d) {
  const out = emptyDb();
  if (!d || typeof d !== 'object') return out;
  out.workouts = (Array.isArray(d.workouts) ? d.workouts : []).map((w) => ({
    ...w,
    id: w.id || uid(),
    name: String(w.name || 'Workout'),
    updatedAt: w.updatedAt || w.createdAt || 0,
    exercises: (w.exercises || []).map((e) => ({
      id: e.id || uid(),
      name: String(e.name || ''),
      sets: e.sets || 1,
      reps: String(e.reps ?? '10'),
      link: !!e.link,
    })),
  }));
  out.history = (Array.isArray(d.history) ? d.history : []).map((s) => ({
    note: '',
    unit: 'lb',
    ...s,
    updatedAt: s.updatedAt || s.finishedAt || 0,
  }));
  if (d.meta && typeof d.meta === 'object') out.meta = d.meta;
  if (d.deleted && typeof d.deleted === 'object') out.deleted = d.deleted;
  out.active = d.active || null;
  out.settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
  out.sync = { ...out.sync, ...(d.sync || {}) };
  out.sheets = { ...out.sheets, ...(d.sheets || {}) };
  out.auth = { ...out.auth, ...(d.auth || {}) };
  return out;
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch (err) {
    console.error('Failed to load saved data', err);
  }
  return emptyDb();
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
  } catch (err) {
    alert('Could not save your data: ' + err.message);
  }
}

// Save a change that other devices should receive.
function commit() {
  save();
  scheduleSync();
  schedulePush();
}

let db = load();

// Ask the browser not to evict our data when the device is low on space.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

/* =========================================================================
   Exercise knowledge: muscle groups, notes, targets, history, PRs
   ========================================================================= */

const MUSCLE_RULES = [
  ['Core', /plank|crunch|\babs?\b|sit.?up|core|leg raise|russian twist|hollow|oblique|ab wheel|dead ?bug/],
  ['Cardio', /\brun|treadmill|bike|cycl|rowing machine|\berg\b|elliptical|jump rope|skipping|stair|cardio|sprint|burpee/],
  ['Triceps', /tricep|pushdown|push-down|skull|close.?grip|\bdips?\b|kickback.*tri|overhead extension/],
  ['Legs', /squat|\blegs?\b|lunge|calf|calves|hamstring|quad|romanian|\brdl\b|stiff.?leg|step.?up|hack|leg press/],
  ['Biceps', /bicep|curl|hammer|preacher/],
  ['Glutes', /glute|hip thrust|bridge|kickback|abduct/],
  ['Chest', /bench|chest|\bfly|flye|pec|push.?up/],
  ['Shoulders', /shoulder|overhead press|\bohp\b|military|lateral|raise|delt|arnold|face pull|upright row/],
  ['Back', /\brow|pull.?up|chin.?up|\blat\b|pulldown|pull-down|deadlift|back ext|shrug|pullover/],
  ['Full body', /clean|snatch|thruster|kettlebell swing|swing|turkish/],
];

function guessMuscle(name) {
  const n = norm(name);
  for (const [muscle, re] of MUSCLE_RULES) if (re.test(n)) return muscle;
  return 'Other';
}

function getMeta(name) {
  return db.meta[norm(name)] || {};
}

function setMeta(name, patch) {
  const key = norm(name);
  db.meta[key] = { ...(db.meta[key] || {}), name: String(name).trim(), ...patch, updatedAt: Date.now() };
}

function muscleOf(name) {
  return getMeta(name).muscle || guessMuscle(name);
}

const workSets = (ex) => ex.sets.filter((s) => !s.warmup);

// Chronological list of past performances of one exercise (working sets only).
function exerciseLog(key) {
  const out = [];
  for (const s of db.history) {
    for (const e of s.exercises) {
      if (norm(e.name) !== key) continue;
      const sets = workSets(e);
      if (sets.length) out.push({ session: s, name: e.name, date: s.finishedAt, unit: s.unit, sets });
    }
  }
  return out;
}

function lastPerformance(name) {
  const log = exerciseLog(norm(name));
  return log.length ? log[log.length - 1] : null;
}

// Best marks across entries, weights normalized to kg.
function bestsFrom(entries) {
  const b = { weight: 0, e1rm: 0, seconds: 0, bwReps: 0, count: 0, weightAt: 0, e1rmAt: 0 };
  for (const en of entries) {
    for (const x of en.sets) {
      if (x.warmup) continue;
      b.count++;
      const kg = convert(Number(x.weight) || 0, en.unit, 'kg');
      if (kg > b.weight) Object.assign(b, { weight: kg, weightAt: en.date || 0 });
      if (x.seconds != null) {
        b.seconds = Math.max(b.seconds, Number(x.seconds) || 0);
      } else {
        const e = epley(kg, x.reps);
        if (e > b.e1rm) Object.assign(b, { e1rm: e, e1rmAt: en.date || 0 });
        if (kg === 0) b.bwReps = Math.max(b.bwReps, Number(x.reps) || 0);
      }
    }
  }
  return b;
}

function exerciseCatalog() {
  const names = new Map();
  for (const w of db.workouts) for (const e of w.exercises) names.set(norm(e.name), e.name);
  for (const s of db.history) for (const e of s.exercises) names.set(norm(e.name), e.name);
  for (const [key, m] of Object.entries(db.meta)) if (!names.has(key) && m.name) names.set(key, m.name);
  return names; // key → display name
}

function lastSessionFor(workoutId) {
  for (let i = db.history.length - 1; i >= 0; i--) if (db.history[i].workoutId === workoutId) return db.history[i];
  return null;
}

// Consecutive exercises with `link` set form a superset. Returns a group number per exercise.
function assignGroups(exercises) {
  let g = 0;
  return exercises.map((e) => {
    const mine = g;
    if (!e.link) g++;
    return mine;
  });
}

function sessionStats(s) {
  const sets = s.exercises.flatMap(workSets);
  const count = (d) => sets.filter((x) => x.difficulty === d).length;
  return {
    duration: s.finishedAt - s.startedAt,
    sets: sets.length,
    volume: sets.reduce((sum, x) => sum + (x.seconds != null ? 0 : (Number(x.weight) || 0) * (Number(x.reps) || 0)), 0),
    prs: sets.filter((x) => x.pr && x.pr.length).length,
    easy: count('easy'),
    medium: count('medium'),
    hard: count('hard'),
  };
}

/* =========================================================================
   UI plumbing: router, toast, modal
   ========================================================================= */

function currentView() {
  return location.hash.replace(/^#\/?/, '').split('/')[0] || '';
}

function route(keepScroll) {
  const [view = '', rawId] = location.hash.replace(/^#\/?/, '').split('/');
  const id = rawId ? decodeURIComponent(rawId) : rawId;
  const locked = !db.auth.hash;
  document.body.classList.toggle('locked', locked);
  if (locked) {
    stopTicker();
    releaseWakeLock();
    document.body.classList.remove('running');
    renderLock();
    return;
  }
  stopTicker();
  if (keepScroll !== true) {
    window.scrollTo(0, 0);
    document.getElementById('toast').classList.remove('show');
  }
  document.body.classList.toggle('running', view === 'run');
  if (view !== 'run') releaseWakeLock();

  switch (view) {
    case 'new': renderBuilder(); break;
    case 'edit': renderBuilder(id); break;
    case 'run': renderRun(); break;
    case 'done': renderSession(id, true); break;
    case 'history': id ? renderSession(id, false) : renderHistory(); break;
    case 'progress': renderProgress(); break;
    case 'exercise': renderExercise(id); break;
    case 'settings': renderSettings(); break;
    default: renderHome();
  }

  const tab = { history: 'history', done: 'history', progress: 'progress', exercise: 'progress', settings: 'settings' }[view] || 'home';
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  initCharts();
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

// Re-render after background changes (sync), but never under the user's fingers.
function refreshView() {
  const focused = document.activeElement;
  if (focused && app.contains(focused) && /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName)) return;
  if (['', 'history', 'progress', 'exercise', 'settings'].includes(currentView())) route(true);
}

let toastTimer = null;
function toast(html, ms = 3500) {
  const el = document.getElementById('toast');
  el.innerHTML = html;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

const modal = document.getElementById('modal');

function openModal(html) {
  document.getElementById('modal-body').innerHTML = html;
  if (!modal.open) modal.showModal();
  const first = modal.querySelector('input, textarea');
  if (first) first.focus();
}

function closeModal() {
  if (modal.open) modal.close();
}

modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal(); // tap on the backdrop
});

/* =========================================================================
   Home: list of saved workouts
   ========================================================================= */

let selectedId = null;

function renderHome() {
  const banner = db.active
    ? `<div class="banner">
         <div><strong>Workout in progress</strong><span>${esc(db.active.workoutName)}</span></div>
         <a class="btn primary" href="#/run">Resume</a>
       </div>`
    : '';

  const list = db.workouts.length
    ? db.workouts.map(workoutCard).join('')
    : `<div class="empty"><span class="emoji">🏋️</span>No workouts yet.<br>Tap <strong>+ New</strong> to build your first one.</div>`;

  app.innerHTML = `
    <header class="page-head">
      <div><p class="brand">TRACK<span>FIT</span></p><h1>Workouts</h1></div>
      <a class="btn primary" href="#/new">+ New</a>
    </header>
    ${banner}
    <div class="list">${list}</div>`;
}

function workoutCard(w) {
  const selected = w.id === selectedId;
  const last = lastSessionFor(w.id);
  const meta = `${plural(w.exercises.length, 'exercise')} · ${last ? 'Last done ' + fmtDate(last.finishedAt) : 'Never done'}`;
  const body = selected
    ? `<div class="card-body">
         <ol class="ex-preview">
           ${w.exercises.map((e, i) => {
             const inSS = e.link || (i > 0 && w.exercises[i - 1].link);
             return `<li class="${inSS ? 'ss' : ''}"><span>${esc(e.name)}</span><span class="muted">${e.sets} × ${esc(fmtTarget(e.reps).replace(/ reps$/, ''))}</span></li>`;
           }).join('')}
         </ol>
         <button class="btn primary big block" data-action="execute" data-id="${w.id}">▶ Execute</button>
         <div class="row gap">
           <a class="btn small" href="#/edit/${w.id}">Edit</a>
           <button class="btn small" data-action="duplicate" data-id="${w.id}">Duplicate</button>
           <button class="btn small danger" data-action="delete-workout" data-id="${w.id}">Delete</button>
         </div>
       </div>`
    : '';
  return `
    <article class="card workout ${selected ? 'selected' : ''}">
      <button class="card-main" data-action="select" data-id="${w.id}" aria-expanded="${selected}">
        <div><h2>${esc(w.name)}</h2><p class="muted">${meta}</p></div>
        <span class="chev" aria-hidden="true">›</span>
      </button>
      ${body}
    </article>`;
}

function executeWorkout(id) {
  const w = db.workouts.find((x) => x.id === id);
  if (!w) return;
  if (db.active) {
    if (db.active.workoutId === id) return go('#/run');
    if (!confirm(`"${db.active.workoutName}" is still in progress. Discard it and start "${w.name}"?`)) return;
  }
  const groups = assignGroups(w.exercises);
  db.active = {
    id: uid(),
    workoutId: w.id,
    workoutName: w.name,
    unit: db.settings.unit,
    startedAt: Date.now(),
    index: 0,
    pendingWeight: '',
    pendingReps: '',
    warmup: false,
    restEndsAt: null,
    hold: null,
    exercises: w.exercises.map((e, i) => {
      const seconds = parseTime(e.reps);
      return {
        name: e.name,
        targetSets: e.sets,
        targetReps: e.reps,
        timed: seconds != null,
        targetSeconds: seconds,
        group: groups[i],
        sets: [],
      };
    }),
  };
  setIndex(0);
  save();
  go('#/run');
}

/* =========================================================================
   Builder: create / edit a workout in a table
   ========================================================================= */

let draft = null;

const blankRow = () => ({ id: uid(), name: '', sets: 3, reps: '10', link: false });

function renderBuilder(id) {
  const existing = id ? db.workouts.find((w) => w.id === id) : null;
  if (id && !existing) return go('#/');
  draft = existing ? clone(existing) : { id: null, name: '', exercises: [blankRow(), blankRow(), blankRow()] };

  app.innerHTML = `
    <header class="page-head">
      <a href="#/" class="back">‹ Back</a>
      <h1>${existing ? 'Edit workout' : 'New workout'}</h1>
      <span style="width:3em"></span>
    </header>
    <label class="field">
      <span>Workout name</span>
      <input id="wname" data-draft="name" value="${esc(draft.name)}" placeholder="e.g. Push Day" autocomplete="off" maxlength="80">
    </label>
    <div class="table-wrap">
      <table class="builder">
        <thead><tr><th></th><th>Equipment / exercise</th><th class="n">Sets</th><th class="n">Reps</th><th></th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
    <button class="btn block" data-action="add-row">+ Add exercise</button>
    <p class="help">Reps can be a number, a range like <b>8-12</b>, or a time like <b>45s</b> for timed exercises (planks, carries).
      Tap ${LINK_ICON.replace('<svg', '<svg class="icon-inline"')} to superset an exercise with the one below it, so you alternate sets between them.</p>
    <datalist id="ex-names">${[...exerciseCatalog().values()].sort().map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
    <div class="sticky-actions">
      <button class="btn primary big block" data-action="save-workout">Save workout</button>
    </div>`;
  renderRows();
  if (!existing) document.getElementById('wname').focus();
}

function renderRows() {
  const exs = draft.exercises;
  const last = exs.length - 1;
  document.getElementById('rows').innerHTML = exs
    .map((e, i) => {
      const inSS = e.link || (i > 0 && exs[i - 1].link);
      return `
      <tr data-i="${i}" class="${inSS ? 'ss' : ''} ${e.link ? 'ss-link' : ''}">
        <td class="num">${i + 1}</td>
        <td><input data-field="name" value="${esc(e.name)}" list="ex-names" placeholder="e.g. Bench press" autocomplete="off" maxlength="80" aria-label="Exercise ${i + 1} name"></td>
        <td class="n"><input data-field="sets" type="number" inputmode="numeric" min="1" max="99" value="${esc(e.sets)}" aria-label="Sets"></td>
        <td class="n"><input data-field="reps" value="${esc(e.reps)}" maxlength="10" aria-label="Reps or time" placeholder="10"></td>
        <td class="row-actions">
          <span class="mv">
            <button data-action="row-up" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>▲</button>
            <button data-action="row-down" aria-label="Move down" ${i === last ? 'disabled' : ''}>▼</button>
          </span>
          <button data-action="row-link" class="link-btn ${e.link ? 'on' : ''}" aria-pressed="${e.link}" aria-label="Superset with next exercise" ${i === last ? 'disabled' : ''}>${LINK_ICON}</button>
          <button data-action="row-del" class="del" aria-label="Remove">✕</button>
        </td>
      </tr>`;
    })
    .join('');
}

function saveWorkout() {
  const name = draft.name.trim();
  const exercises = draft.exercises
    .filter((e) => e.name.trim())
    .map((e) => ({
      id: e.id || uid(),
      name: e.name.trim(),
      sets: Math.min(99, Math.max(1, parseInt(e.sets, 10) || 1)),
      reps: String(e.reps).trim() || '10',
      link: !!e.link,
    }));
  if (exercises.length) exercises[exercises.length - 1].link = false;

  if (!name) {
    alert('Give the workout a name.');
    return document.getElementById('wname').focus();
  }
  if (!exercises.length) return alert('Add at least one exercise.');

  const now = Date.now();
  if (draft.id) {
    Object.assign(db.workouts.find((x) => x.id === draft.id), { name, exercises, updatedAt: now });
  } else {
    draft.id = uid();
    db.workouts.push({ id: draft.id, name, createdAt: now, updatedAt: now, exercises });
  }
  selectedId = draft.id;
  commit();
  go('#/');
}

/* =========================================================================
   Run: executing a workout one exercise at a time
   ========================================================================= */

function weightIsValid(v) {
  return v !== '' && v != null && !Number.isNaN(Number(v)) && Number(v) >= 0;
}

function groupMembers(a, group) {
  return a.exercises.map((e, i) => (e.group === group ? i : -1)).filter((i) => i >= 0);
}

function supersetLetter(a, group) {
  const multi = [...new Set(a.exercises.map((e) => e.group))].filter((g) => groupMembers(a, g).length > 1);
  return 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[multi.indexOf(group)] || '';
}

// Target weight for today, in the session's unit: saved after the last workout, or worked out from history.
function targetFor(ex, unit) {
  if (ex.timed) return null;
  let t = getMeta(ex.name).target;
  if (!t || !t.weight) {
    const perf = lastPerformance(ex.name);
    t = perf && progression(perf.sets, perf.unit);
  }
  if (!t) return null;
  return { ...t, weight: convertForBar(t.weight, t.unit, unit), from: convertForBar(t.from, t.unit, unit) };
}

function renderRun() {
  const a = db.active;
  if (!a) return go('#/');
  const ex = a.exercises[a.index];
  const total = a.exercises.length;
  const done = workSets(ex).length;
  const met = done >= ex.targetSets;
  const isLast = a.index === total - 1;
  const members = groupMembers(a, ex.group);
  const perf = lastPerformance(ex.name);
  const target = targetFor(ex, a.unit);
  const note = getMeta(ex.name).note;
  const undoFrom = lastLoggedIndex(a);

  let hint = '';
  if (perf || target) {
    const why = target && { up: 'last time was all Easy', hold: 'last time had a Hard set — repeat it', same: 'repeat it, go up once it feels Easy' }[target.reason];
    hint = `
      <div class="hint">
        ${perf ? `<div class="muted">Last time · ${fmtDate(perf.date)}</div>
          <div class="sets">${perf.sets.map((s) => `<span class="tag ${s.difficulty}">${fmtNum(s.weight)} × ${esc(s.seconds != null ? fmtSecs(s.seconds) : s.reps)}</span>`).join('')}</div>` : ''}
        ${target ? `<div class="suggest">
            <span>${target.reason === 'up' ? '⬆ ' : ''}Target: ${fmtWeight(target.weight, a.unit)}<small class="muted"> · ${why}</small></span>
            <button class="btn small" data-action="use-weight" data-w="${target.weight}">Use</button>
          </div>` : ''}
      </div>`;
  }

  app.innerHTML = `
    <div class="run">
      <div class="run-top"><span class="muted">${esc(a.workoutName)}</span><span class="muted mono" id="elapsed"></span></div>
      <div class="progress" aria-hidden="true">
        ${a.exercises.map((e, i) => `<span class="${i === a.index ? 'current' : e.sets.length ? 'has' : ''} ${e.group === (a.exercises[i + 1] || {}).group ? 'joined' : ''}"></span>`).join('')}
      </div>

      <p class="eyebrow">Exercise ${a.index + 1} of ${total}
        ${members.length > 1 ? `<span class="tag plain">Superset ${supersetLetter(a, ex.group)} · ${members.indexOf(a.index) + 1}/${members.length}</span>` : ''}
      </p>
      <h1 class="ex-name">${esc(ex.name)}</h1>
      <p class="muted">Target: ${plural(ex.targetSets, 'set')} × ${esc(fmtTarget(ex.targetReps))}</p>
      <div class="note-line">
        ${note ? `<span>📝 ${esc(note)}</span>` : ''}
        <button class="link" data-action="edit-note">${note ? 'Edit note' : '📝 Add note'}</button>
      </div>

      <div class="card set-counter ${met ? 'met' : ''}">
        <div class="now"><span class="muted">${a.warmup ? 'Warm-up' : 'Set'}</span><b>${a.warmup ? 'W' : done + 1}</b></div>
        <div class="done-count"><b>${done} / ${ex.targetSets}</b>${met ? 'target hit ✓' : 'sets done'}</div>
      </div>

      ${hint}

      <div class="inputs">
        <div class="field">
          <span class="label-row"><label for="weight">Weight (${a.unit})</label><button class="mini" data-action="plates">Plates</button></span>
          <input id="weight" type="number" inputmode="decimal" step="any" min="0" placeholder="—" value="${esc(a.pendingWeight)}">
        </div>
        <label class="field"><span>${ex.timed ? 'Seconds' : 'Reps'}</span>
          <input id="reps" type="number" inputmode="numeric" min="0" step="1" placeholder="—" value="${esc(a.pendingReps)}">
        </label>
      </div>
      ${ex.timed ? `
        <div class="hold-box">
          <span class="time" id="hold-time">${fmtSecs(a.pendingReps || ex.targetSeconds)}</span>
          <button class="btn" data-action="hold-start" id="hold-start">▶ Start timer</button>
          <button class="btn" data-action="hold-stop" id="hold-stop" hidden>■ Stop</button>
        </div>` : ''}
      <p class="need" id="need"></p>

      <label class="switch">
        <input type="checkbox" id="warmup" ${a.warmup ? 'checked' : ''}>
        <span>Warm-up set <small class="muted">— not counted in sets, volume or PRs</small></span>
      </label>

      <p class="setdone-label">${a.warmup ? 'Warm-up done' : 'Set done'} — how did it feel?</p>
      <div class="difficulty">
        <button class="btn easy" data-action="set-done" data-d="easy">Easy<small>could do more</small></button>
        <button class="btn medium" data-action="set-done" data-d="medium">Medium<small>solid effort</small></button>
        <button class="btn hard" data-action="set-done" data-d="hard">Hard<small>near failure</small></button>
      </div>

      <div class="rest" id="rest" hidden>
        <span class="label" id="rest-label">Rest</span>
        <span class="time" id="rest-time"></span>
        <button class="btn small" data-action="rest-add">+30s</button>
        <button class="btn small" data-action="rest-skip">Skip</button>
      </div>

      ${ex.sets.length ? setsList(ex.sets, a.unit) : ''}
      ${undoFrom >= 0 ? `<button class="link" data-action="undo-set">Undo last set${undoFrom !== a.index ? ` (${esc(a.exercises[undoFrom].name)})` : ''}</button>` : ''}

      <div class="run-nav">
        <button class="btn big" data-action="prev-ex" ${a.index === 0 ? 'disabled' : ''}>‹ Prev</button>
        ${isLast
          ? `<button class="btn big primary" data-action="finish">Finish workout ✓</button>`
          : `<button class="btn big ${met ? 'primary' : ''}" data-action="next-ex">Next exercise ›</button>`}
      </div>
      <div class="run-foot"><button class="link danger" data-action="discard">Discard workout</button></div>
    </div>`;

  updateSetButtons();
  updateHoldUI();
  startTicker();
  requestWakeLock();
}

// The exercise holding the most recently logged set, or -1.
function lastLoggedIndex(a) {
  let best = -1;
  let at = -1;
  a.exercises.forEach((e, i) => {
    const last = e.sets[e.sets.length - 1];
    if (last && (last.at || 0) >= at) {
      at = last.at || 0;
      best = i;
    }
  });
  return best;
}

function setLabel(sets, i) {
  if (sets[i].warmup) return 'Warm-up';
  return 'Set ' + sets.slice(0, i + 1).filter((x) => !x.warmup).length;
}

function setsList(sets, unit) {
  return `<ol class="logged">${sets.map((s, i) => `
    <li class="${s.warmup ? 'warm' : ''}">
      <span>${setLabel(sets, i)}</span>
      <span>${fmtWeight(s.weight, unit)} × ${esc(s.seconds != null ? fmtSecs(s.seconds) : s.reps)}${s.pr && s.pr.length ? ' <span title="Personal record">🏆</span>' : ''}</span>
      <span class="tag ${s.difficulty}">${cap(s.difficulty)}</span>
    </li>`).join('')}</ol>`;
}

function updateSetButtons() {
  const input = document.getElementById('weight');
  if (!input) return;
  const ok = weightIsValid(input.value);
  document.querySelectorAll('[data-action="set-done"]').forEach((b) => (b.disabled = !ok));
  document.getElementById('need').textContent = ok ? '' : 'Enter the weight to log this set (0 for bodyweight)';
}

// Move to an exercise and prefill its inputs.
function setIndex(i) {
  const a = db.active;
  a.index = i;
  const ex = a.exercises[i];
  const last = ex.sets[ex.sets.length - 1];
  a.pendingWeight = last ? String(last.weight) : '';
  a.pendingReps = last
    ? String(last.seconds != null ? last.seconds : last.reps)
    : ex.timed ? String(ex.targetSeconds) : defaultReps(ex.targetReps);
  a.warmup = false;
  a.hold = null;
}

function checkPRs(ex, set, unit) {
  if (set.warmup) return [];
  const b = bestsFrom([...exerciseLog(norm(ex.name)), { unit, sets: ex.sets }]);
  if (!b.count) return []; // first time doing it: nothing to beat
  const kg = convert(set.weight, unit, 'kg');
  const prs = [];
  if (kg > b.weight + 1e-9) prs.push('weight');
  if (set.seconds != null) {
    if (set.seconds > b.seconds) prs.push('time');
  } else {
    if (epley(kg, set.reps) > b.e1rm + 1e-9) prs.push('e1rm');
    if (kg === 0 && Number(set.reps) > b.bwReps) prs.push('reps');
  }
  return prs;
}

function prMessage(prs, set, unit, name) {
  const parts = [];
  if (prs.includes('weight')) parts.push(`heaviest ever (${fmtWeight(set.weight, unit)})`);
  if (prs.includes('e1rm')) parts.push(`best est. 1RM (${fmtNum(epley(set.weight, set.reps), 1)} ${unit})`);
  if (prs.includes('reps')) parts.push(`most reps (${set.reps})`);
  if (prs.includes('time')) parts.push(`longest hold (${fmtSecs(set.seconds)})`);
  return `<strong>🏆 New PR — ${esc(name)}</strong><br>${parts.join(' · ')}`;
}

function logSet(difficulty) {
  const a = db.active;
  const ex = a.exercises[a.index];
  const weight = document.getElementById('weight').value;
  const amount = document.getElementById('reps').value;
  if (!weightIsValid(weight)) return updateSetButtons();

  const set = { weight: Number(weight), difficulty, at: Date.now() };
  if (ex.timed) set.seconds = amount === '' ? ex.targetSeconds : Number(amount);
  else set.reps = amount === '' ? Number(defaultReps(ex.targetReps)) || ex.targetReps : Number(amount);
  if (a.warmup) set.warmup = true;
  const prs = checkPRs(ex, set, a.unit);
  if (prs.length) set.pr = prs;
  ex.sets.push(set);
  a.pendingWeight = weight; // keep the same weight for the next set
  a.hold = null;

  // Supersets: after a working set, hop to the next exercise in the group that still needs sets.
  let rest = true;
  const members = groupMembers(a, ex.group);
  if (members.length > 1 && !set.warmup) {
    const pos = members.indexOf(a.index);
    const order = [...members.slice(pos + 1), ...members.slice(0, pos + 1)];
    const next = order.find((i) => workSets(a.exercises[i]).length < a.exercises[i].targetSets);
    if (next !== undefined && next !== a.index) {
      rest = next < a.index; // rest only once the whole round is done
      setIndex(next);
      if (!prs.length) toast(`Superset → <strong>${esc(a.exercises[next].name)}</strong>`, 2000);
    }
  }

  a.restEndsAt = rest && db.settings.restSeconds > 0 ? Date.now() + db.settings.restSeconds * 1000 : null;
  restAlerted = false;
  unlockAudio();
  if (prs.length) {
    toast(prMessage(prs, set, a.unit, ex.name), 5000);
    if (navigator.vibrate) navigator.vibrate([60, 60, 60, 60, 120]);
  } else if (navigator.vibrate) navigator.vibrate(30);
  save();
  schedulePush(true);
  renderRun();
}

function moveExercise(delta) {
  const a = db.active;
  const next = a.index + delta;
  if (next < 0 || next >= a.exercises.length) return;
  setIndex(next);
  a.restEndsAt = null;
  save();
  window.scrollTo(0, 0);
  renderRun();
}

// Next time's target: up a step when every working set felt Easy, otherwise repeat the top weight.
function progression(sets, unit) {
  const work = sets.filter((s) => !s.warmup && s.seconds == null);
  if (!work.length) return null;
  const top = Math.max(...work.map((s) => Number(s.weight) || 0));
  if (top <= 0) return null;
  const step = unit === 'kg' ? db.settings.stepKg : db.settings.stepLb;
  const allEasy = work.every((s) => s.difficulty === 'easy');
  const reason = allEasy ? 'up' : work.some((s) => s.difficulty === 'hard') ? 'hold' : 'same';
  return { weight: allEasy ? top + step : top, from: top, unit, reason };
}

function applyProgression(session) {
  const ups = [];
  for (const e of session.exercises) {
    const t = e.timed ? null : progression(e.sets, session.unit);
    if (!t) continue;
    setMeta(e.name, { target: { ...t, at: session.finishedAt } });
    if (t.reason === 'up') ups.push({ name: e.name, from: t.from, to: t.weight });
  }
  return ups;
}

function finishWorkout() {
  const a = db.active;
  const logged = a.exercises.filter((e) => e.sets.length);
  if (!logged.length) {
    if (confirm('No sets were logged. Discard this workout?')) discardWorkout(true);
    return;
  }
  const skipped = a.exercises.length - logged.length;
  const msg = skipped ? `${plural(skipped, 'exercise')} had no sets logged. Finish anyway?` : 'Finish and save this workout?';
  if (!confirm(msg)) return;

  const now = Date.now();
  const session = {
    id: a.id,
    workoutId: a.workoutId,
    workoutName: a.workoutName,
    unit: a.unit,
    startedAt: a.startedAt,
    finishedAt: now,
    updatedAt: now,
    note: '',
    exercises: logged.map((e) => ({
      name: e.name,
      targetSets: e.targetSets,
      targetReps: e.targetReps,
      timed: e.timed,
      slot: a.exercises.indexOf(e),
      superset: groupMembers(a, e.group).length > 1 ? supersetLetter(a, e.group) : '',
      sets: e.sets,
    })),
  };
  session.progressions = applyProgression(session);
  db.history.push(session);
  db.active = null;
  commit();
  go('#/done/' + session.id);
}

function discardWorkout(skipConfirm) {
  if (!skipConfirm && !confirm('Discard this workout? Logged sets will be lost.')) return;
  db.active = null;
  save();
  schedulePush();
  go('#/');
}

/* ---- Timed exercises (planks etc.) ---- */

function updateHoldUI() {
  const start = document.getElementById('hold-start');
  if (!start) return;
  const running = !!(db.active && db.active.hold);
  start.hidden = running;
  document.getElementById('hold-stop').hidden = !running;
  document.querySelector('.hold-box').classList.toggle('running', running);
}

function holdStart() {
  const a = db.active;
  const secs = Number(document.getElementById('reps').value) || a.exercises[a.index].targetSeconds || 30;
  a.hold = { startedAt: Date.now(), target: secs };
  a.restEndsAt = null;
  unlockAudio();
  save();
  updateHoldUI();
  tick();
}

function holdFinish(seconds, alertUser) {
  const a = db.active;
  a.hold = null;
  a.pendingReps = String(seconds);
  const input = document.getElementById('reps');
  if (input) input.value = seconds;
  const time = document.getElementById('hold-time');
  if (time) time.textContent = fmtSecs(seconds) + ' ✓';
  if (alertUser) {
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    beep();
    toast('Time! Now rate the set below.', 2500);
  }
  save();
  updateHoldUI();
}

/* ---- Ticker: elapsed time, rest countdown, hold timer ---- */

let ticker = null;
let restAlerted = false;

function startTicker() {
  stopTicker();
  tick();
  ticker = setInterval(tick, 250);
}

function stopTicker() {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

function tick() {
  const a = db.active;
  if (!a) return stopTicker();
  const elapsed = document.getElementById('elapsed');
  if (elapsed) elapsed.textContent = fmtDuration(Date.now() - a.startedAt);

  if (a.hold) {
    const left = a.hold.target * 1000 - (Date.now() - a.hold.startedAt);
    const el = document.getElementById('hold-time');
    if (left <= 0) holdFinish(a.hold.target, true);
    else if (el) el.textContent = fmtClock(left);
  }

  const rest = document.getElementById('rest');
  if (!rest) return;
  if (!a.restEndsAt) {
    rest.hidden = true;
    return;
  }
  const left = a.restEndsAt - Date.now();
  rest.hidden = false;
  if (left > 0) {
    rest.classList.remove('over');
    document.getElementById('rest-label').textContent = 'Rest';
    document.getElementById('rest-time').textContent = fmtClock(left);
  } else {
    rest.classList.add('over');
    document.getElementById('rest-label').textContent = 'Rest over — go!';
    document.getElementById('rest-time').textContent = '0:00';
    if (!restAlerted) {
      restAlerted = true;
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      beep();
    }
    if (left < -15000) {
      a.restEndsAt = null;
      save();
    }
  }
}

/* ---- Beep (audio must be unlocked by a tap first) ---- */

let audioCtx = null;

function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* audio unsupported */ }
}

function beep() {
  if (!audioCtx) return;
  try {
    [0, 0.25].forEach((offset) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.2, audioCtx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + offset + 0.2);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(audioCtx.currentTime + offset);
      osc.stop(audioCtx.currentTime + offset + 0.2);
    });
  } catch { /* ignore */ }
}

/* ---- Keep the screen awake during a workout ---- */

let wakeLock = null;

async function requestWakeLock() {
  if (wakeLock || !('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => (wakeLock = null));
  } catch { /* denied or unsupported */ }
}

function releaseWakeLock() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && document.body.classList.contains('running')) requestWakeLock();
});

/* ---- Plate calculator ---- */

function plateBreakdown(total, bar, unit) {
  let side = (total - bar) / 2;
  if (side < 0) return null;
  const plates = [];
  for (const p of PLATES[unit]) {
    while (side >= p - 1e-9) {
      plates.push(p);
      side -= p;
    }
  }
  return { plates, leftover: Math.round(side * 2 * 100) / 100 };
}

function openPlates(weight) {
  const unit = db.active ? db.active.unit : db.settings.unit;
  const bar = unit === 'kg' ? db.settings.barKg : db.settings.barLb;
  openModal(`
    <h2>Plate calculator</h2>
    <div class="inputs" style="margin-top:12px">
      <label class="field"><span>Total weight (${unit})</span><input id="pc-total" type="number" inputmode="decimal" step="any" min="0" value="${esc(weight)}"></label>
      <label class="field"><span>Bar (${unit})</span><input id="pc-bar" type="number" inputmode="decimal" step="any" min="0" value="${bar}"></label>
    </div>
    <div id="pc-out" data-unit="${unit}"></div>
    <div class="row gap" style="margin-top:16px">
      ${db.active ? '<button class="btn" data-action="plates-use">Use this weight</button>' : ''}
      <button class="btn primary" data-action="close-modal">Done</button>
    </div>`);
  renderPlates();
}

function renderPlates() {
  const out = document.getElementById('pc-out');
  if (!out) return;
  const unit = out.dataset.unit;
  const total = Number(document.getElementById('pc-total').value);
  const bar = Number(document.getElementById('pc-bar').value) || 0;
  if (!total) {
    out.innerHTML = '<p class="muted">Enter a total weight.</p>';
    return;
  }
  const r = plateBreakdown(total, bar, unit);
  if (!r) {
    out.innerHTML = `<p class="muted">That's less than the bar (${fmtNum(bar)} ${unit}).</p>`;
    return;
  }
  const max = PLATES[unit][0];
  out.innerHTML = `
    <p class="plates-per-side"><b>Each side:</b> ${r.plates.length ? r.plates.map((p) => fmtNum(p)).join(' + ') : 'no plates — just the bar'}</p>
    <div class="barbell" aria-hidden="true">
      <span class="sleeve"></span>
      ${r.plates.map((p) => `<span class="plate" style="height:${Math.round(38 + 62 * (p / max))}%">${fmtNum(p)}</span>`).join('')}
      <span class="collar"></span>
    </div>
    ${r.leftover ? `<p class="need">Can't make exactly ${fmtNum(total)} — ${fmtNum(r.leftover)} ${unit} short with standard plates.</p>` : ''}`;
}

/* ---- Exercise notes ---- */

function openNoteEditor(name) {
  openModal(`
    <h2>Note · ${esc(name)}</h2>
    <p class="muted" style="margin:6px 0 12px">Shown every time you do this exercise — seat height, grip, cues.</p>
    <textarea id="note-text" rows="4" maxlength="500" placeholder="e.g. Seat on 4, handles at chest height">${esc(getMeta(name).note || '')}</textarea>
    <div class="row gap" style="margin-top:16px">
      <button class="btn" data-action="close-modal">Cancel</button>
      <button class="btn primary" data-action="save-note" data-name="${esc(name)}">Save note</button>
    </div>`);
}

/* =========================================================================
   Session summary & history
   ========================================================================= */

function renderSession(id, justFinished) {
  const s = db.history.find((x) => x.id === id);
  if (!s) return go('#/history');
  const st = sessionStats(s);
  const ups = s.progressions || [];

  app.innerHTML = `
    <header class="page-head">
      ${justFinished ? '<span></span>' : '<a href="#/history" class="back">‹ History</a>'}
    </header>
    ${justFinished ? '<p class="eyebrow">Workout complete 🎉</p>' : `<p class="eyebrow">${fmtDate(s.finishedAt, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</p>`}
    <h1>${esc(s.workoutName)}</h1>

    <div class="stats">
      <div class="card stat"><b>${fmtHuman(st.duration)}</b><span>Duration</span></div>
      <div class="card stat"><b>${st.sets}</b><span>Working sets</span></div>
      <div class="card stat"><b>${fmtNum(st.volume, 0)}</b><span>Volume (${s.unit})</span></div>
      <div class="card stat"><b>${st.prs ? '🏆 ' + st.prs : '—'}</b><span>Personal records</span></div>
    </div>
    <p class="muted diff-line">
      <span class="tag easy">${st.easy} Easy</span> <span class="tag medium">${st.medium} Medium</span> <span class="tag hard">${st.hard} Hard</span>
    </p>

    ${ups.length ? `
      <section class="card ex-block next-time">
        <h3>⬆ Next time</h3>
        <p class="muted" style="font-size:.9rem;margin-bottom:6px">Everything felt Easy, so these targets went up:</p>
        <ul>${ups.map((u) => `<li><span>${esc(u.name)}</span><span>${fmtNum(u.from)} → <b>${fmtNum(u.to)} ${s.unit}</b></span></li>`).join('')}</ul>
      </section>` : ''}

    <div class="list">
      ${s.exercises.map((e) => `
        <section class="card ex-block">
          <h3><a href="#/exercise/${encodeURIComponent(norm(e.name))}">${esc(e.name)}</a></h3>
          ${setsList(e.sets, s.unit)}
        </section>`).join('')}
    </div>

    <label class="field" style="margin-top:16px">
      <span>Session note</span>
      <textarea data-session-note="${s.id}" rows="3" maxlength="1000" placeholder="How did it go? Slept badly, new gym, felt strong…">${esc(s.note || '')}</textarea>
    </label>

    <div class="stack" style="margin-top:8px">
      ${justFinished
        ? '<a class="btn primary big block" href="#/">Done</a>'
        : `<button class="btn danger block" data-action="delete-session" data-id="${s.id}">Delete this entry</button>`}
    </div>`;
}

function renderHistory() {
  if (!db.history.length) {
    app.innerHTML = `
      <header class="page-head"><h1>History</h1></header>
      <div class="empty"><span class="emoji">📅</span>No workouts logged yet.<br>Execute a workout and it will show up here.</div>`;
    return;
  }

  let html = '';
  let month = '';
  for (const s of [...db.history].reverse()) {
    const m = fmtDate(s.finishedAt, { month: 'long', year: 'numeric' });
    if (m !== month) {
      month = m;
      html += `<h2 class="month">${m}</h2>`;
    }
    const st = sessionStats(s);
    html += `
      <a class="card history-item" href="#/history/${s.id}">
        <div><h2>${esc(s.workoutName)}${st.prs ? ' <span title="Personal records">🏆</span>' : ''}</h2>
          <p class="muted">${fmtDate(s.finishedAt, { weekday: 'short', month: 'short', day: 'numeric' })} · ${fmtHuman(st.duration)}${s.note ? ' · 📝' : ''}</p></div>
        <div class="right">${plural(st.sets, 'set')}<br>${fmtNum(st.volume, 0)} ${s.unit}</div>
      </a>`;
  }

  app.innerHTML = `
    <header class="page-head"><h1>History</h1><span class="muted">${plural(db.history.length, 'workout')}</span></header>
    <div class="list">${html}</div>`;
}

/* =========================================================================
   Progress: weekly overview, per-exercise charts and PRs
   ========================================================================= */

let chartMetric = 'weight';

function renderProgress() {
  const unit = db.settings.unit;
  const now = Date.now();
  const thisWeek = weekStart(now);

  // Workouts per week, last 12 weeks.
  const perWeek = new Map();
  for (const s of db.history) {
    const k = weekStart(s.finishedAt);
    perWeek.set(k, (perWeek.get(k) || 0) + 1);
  }
  const weeks = [];
  const d = new Date(thisWeek);
  for (let i = 0; i < 12; i++) {
    weeks.unshift(d.getTime());
    d.setDate(d.getDate() - 7);
  }

  // Streak: consecutive weeks with a workout (this week counts once it has one).
  let streak = 0;
  const w = new Date(thisWeek);
  if (!perWeek.get(w.getTime())) w.setDate(w.getDate() - 7);
  while (perWeek.get(w.getTime())) {
    streak++;
    w.setDate(w.getDate() - 7);
  }

  const weekSessions = db.history.filter((s) => s.finishedAt >= thisWeek);
  const weekSets = weekSessions.flatMap((s) => s.exercises.map((e) => ({ e, s })));
  const muscles = new Map();
  let setCount = 0;
  let volume = 0;
  for (const { e, s } of weekSets) {
    const n = workSets(e).length;
    setCount += n;
    muscles.set(muscleOf(e.name), (muscles.get(muscleOf(e.name)) || 0) + n);
    for (const x of workSets(e)) if (x.seconds == null) volume += convert(Number(x.weight) || 0, s.unit, unit) * (Number(x.reps) || 0);
  }
  const muscleRows = [...muscles.entries()].filter(([, n]) => n).sort((a, b) => b[1] - a[1]);
  const maxMuscle = Math.max(1, ...muscleRows.map(([, n]) => n));

  const catalog = exerciseCatalog();
  const exRows = [...catalog.entries()]
    .map(([key, name]) => {
      const log = exerciseLog(key);
      return { key, name, log, b: bestsFrom(log), last: log.length ? log[log.length - 1].date : 0 };
    })
    .sort((a, b) => b.last - a.last || a.name.localeCompare(b.name));

  app.innerHTML = `
    <header class="page-head"><h1>Progress</h1></header>

    <p class="eyebrow">This week</p>
    <div class="stats">
      <div class="card stat"><b>${weekSessions.length}</b><span>Workouts</span></div>
      <div class="card stat"><b>${streak ? '🔥 ' + streak : '0'}</b><span>Week streak</span></div>
      <div class="card stat"><b>${setCount}</b><span>Working sets</span></div>
      <div class="card stat"><b>${fmtNum(volume, 0)}</b><span>Volume (${unit})</span></div>
    </div>

    <section class="card chart-card">
      <h2>Workouts per week</h2>
      ${db.history.length
        ? barChart(weeks.map((k) => ({ x: k, y: perWeek.get(k) || 0, label: fmtDate(k), tip: `Week of ${fmtDate(k)}<br><b>${plural(perWeek.get(k) || 0, 'workout')}</b>` })))
        : '<p class="muted">Finish a workout to start the chart.</p>'}
    </section>

    <section class="card chart-card">
      <h2>Sets per muscle group · this week</h2>
      ${muscleRows.length
        ? `<div class="hbars">${muscleRows.map(([m, n]) => `
            <div class="hbar"><span class="name">${m}</span><span class="track"><span style="width:${(n / maxMuscle) * 100}%"></span></span><span class="val">${n}</span></div>`).join('')}</div>
           <p class="muted small-note">Muscle groups are guessed from exercise names — tap an exercise below to change one.</p>`
        : '<p class="muted">No sets logged this week yet.</p>'}
    </section>

    <h2 class="month">Exercises</h2>
    ${exRows.length ? `<div class="list">${exRows.map((r) => `
      <a class="card history-item" href="#/exercise/${encodeURIComponent(r.key)}">
        <div><h2>${esc(r.name)}</h2><p class="muted">${muscleOf(r.name)} · ${r.log.length ? plural(r.log.length, 'session') : 'not done yet'}</p></div>
        <div class="right">${r.b.weight ? `Best<br><b>${fmtNum(convertForBar(r.b.weight, 'kg', unit))} ${unit}</b>` : r.b.seconds ? `Best<br><b>${fmtSecs(r.b.seconds)}</b>` : r.b.bwReps ? `Best<br><b>${r.b.bwReps} reps</b>` : ''}</div>
      </a>`).join('')}</div>` : '<div class="empty">Exercises you add to workouts show up here.</div>'}`;
}

function renderExercise(key) {
  const catalog = exerciseCatalog();
  const name = catalog.get(key);
  if (!name) return go('#/progress');
  const unit = db.settings.unit;
  const log = exerciseLog(key);
  const b = bestsFrom(log);
  const meta = getMeta(name);
  const timed = log.some((en) => en.sets.some((s) => s.seconds != null));
  const metrics = timed
    ? [['time', 'Longest hold'], ['weight', 'Top weight']]
    : [['weight', 'Top weight'], ['e1rm', 'Est. 1RM'], ['volume', 'Volume']];
  if (!metrics.some(([k]) => k === chartMetric)) chartMetric = metrics[0][0];

  const points = log.map((en) => {
    const kgs = en.sets.map((s) => convert(Number(s.weight) || 0, en.unit, 'kg'));
    let y;
    if (chartMetric === 'weight') y = convert(Math.max(...kgs), 'kg', unit);
    else if (chartMetric === 'e1rm') y = convert(Math.max(...en.sets.map((s, i) => epley(kgs[i], s.reps))), 'kg', unit);
    else if (chartMetric === 'volume') y = en.sets.reduce((sum, s, i) => sum + convert(kgs[i], 'kg', unit) * (Number(s.reps) || 0), 0);
    else y = Math.max(...en.sets.map((s) => Number(s.seconds) || 0));
    const shown = chartMetric === 'time' ? fmtSecs(y) : `${fmtNum(y, 1)} ${unit}`;
    return { x: en.date, y, tip: `${fmtDate(en.date, { month: 'short', day: 'numeric', year: 'numeric' })}<br><b>${shown}</b>` };
  });

  const tiles = [];
  if (b.weight) tiles.push([`${fmtNum(convertForBar(b.weight, 'kg', unit))} ${unit}`, `Heaviest · ${fmtDate(b.weightAt)}`]);
  if (b.e1rm) tiles.push([`${fmtNum(convert(b.e1rm, 'kg', unit), 0)} ${unit}`, `Best est. 1RM · ${fmtDate(b.e1rmAt)}`]);
  if (b.seconds) tiles.push([fmtSecs(b.seconds), 'Longest hold']);
  if (b.bwReps) tiles.push([b.bwReps, 'Most bodyweight reps']);
  tiles.push([log.length, 'Sessions']);
  const target = timed ? null : targetFor({ name, timed }, unit);
  if (target) tiles.push([`${fmtNum(target.weight)} ${unit}`, 'Next target']);

  app.innerHTML = `
    <header class="page-head"><a href="#/progress" class="back">‹ Progress</a></header>
    <h1>${esc(name)}</h1>
    <label class="field inline-field" style="margin-top:12px">
      <span>Muscle group</span>
      <select data-meta="muscle" data-name="${esc(name)}">
        ${MUSCLES.map((m) => `<option ${m === muscleOf(name) ? 'selected' : ''}>${m}</option>`).join('')}
      </select>
    </label>

    <div class="stats">${tiles.map(([v, l]) => `<div class="card stat"><b>${v}</b><span>${l}</span></div>`).join('')}</div>

    <section class="card chart-card">
      <div class="segmented" role="tablist">
        ${metrics.map(([k, l]) => `<button role="tab" aria-selected="${k === chartMetric}" class="${k === chartMetric ? 'on' : ''}" data-action="metric" data-m="${k}">${l}</button>`).join('')}
      </div>
      ${points.length >= 2 ? lineChart(points, chartMetric === 'time' ? fmtSecs : (v) => fmtNum(v, 0))
        : `<p class="muted">${points.length ? 'One more session and you get a chart.' : 'No sets logged yet.'}</p>`}
      ${chartMetric === 'e1rm' ? '<p class="muted small-note">Estimated 1-rep max = weight × (1 + reps ÷ 30), from your best set each session.</p>' : ''}
    </section>

    <label class="field">
      <span>Note</span>
      <textarea data-meta="note" data-name="${esc(name)}" rows="2" maxlength="500" placeholder="Seat height, grip, cues…">${esc(meta.note || '')}</textarea>
    </label>

    ${log.length ? `<h2 class="month">Sessions</h2>
      <div class="list">${[...log].reverse().map((en) => `
        <section class="card ex-block">
          <h3><a href="#/history/${en.session.id}">${fmtDate(en.date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</a> <span class="muted" style="font-weight:400">· ${esc(en.session.workoutName)}</span></h3>
          ${setsList(en.sets, en.unit)}
        </section>`).join('')}</div>` : ''}`;
}

/* ---- Charts (inline SVG, single series, hover/tap tooltip) ---- */

const chartData = new Map();
let chartSeq = 0;

function niceTicks(lo, hi, count) {
  const raw = (hi - lo) / count || 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let t = min; t <= max + step / 2; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
  return { min, max: max === min ? min + step : max, ticks };
}

function lineChart(points, fmtY) {
  const id = 'chart' + ++chartSeq;
  const W = 600, H = 250, m = { t: 30, r: 24, b: 34, l: 64 };
  const ys = points.map((p) => p.y);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  const pad = (hi - lo) * 0.15 || Math.max(1, hi * 0.1);
  const { min, max, ticks } = niceTicks(Math.max(0, lo - pad), hi + pad, 4);
  const x0 = points[0].x, x1 = points[points.length - 1].x;
  const px = (x) => (x1 === x0 ? (m.l + W - m.r) / 2 : m.l + ((x - x0) / (x1 - x0)) * (W - m.l - m.r));
  const py = (y) => H - m.b - ((y - min) / (max - min)) * (H - m.t - m.b);
  const pts = points.map((p) => ({ ...p, px: px(p.x), py: py(p.y) }));
  chartData.set(id, { W, H, pts });
  const last = pts[pts.length - 1];

  return `
    <div class="chart-wrap">
      <svg class="chart" id="${id}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Line chart, ${points.length} sessions, latest ${esc(fmtY(last.y))}">
        ${ticks.map((t) => `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${py(t)}" y2="${py(t)}"/><text class="axis" x="${m.l - 10}" y="${py(t) + 6}" text-anchor="end">${esc(fmtY(t))}</text>`).join('')}
        <text class="axis" x="${pts[0].px}" y="${H - 6}" text-anchor="start">${fmtDate(points[0].x)}</text>
        <text class="axis" x="${last.px}" y="${H - 6}" text-anchor="end">${fmtDate(last.x)}</text>
        <path class="line" d="${pts.map((p, i) => (i ? 'L' : 'M') + p.px.toFixed(1) + ' ' + p.py.toFixed(1)).join('')}"/>
        ${pts.length <= 60 ? pts.map((p) => `<circle class="dot" cx="${p.px}" cy="${p.py}" r="5"/>`).join('') : ''}
        <text class="direct" x="${last.px}" y="${last.py - 14}" text-anchor="end">${esc(fmtY(last.y))}</text>
        <line class="cross" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" style="display:none"/>
        <circle class="focus" r="7" style="display:none"/>
      </svg>
      <div class="tip" hidden></div>
    </div>`;
}

function barChart(items) {
  const id = 'chart' + ++chartSeq;
  const W = 600, H = 220, m = { t: 16, r: 8, b: 34, l: 36 };
  const { max, ticks } = niceTicks(0, Math.max(3, ...items.map((i) => i.y)), 3);
  const band = (W - m.l - m.r) / items.length;
  const bw = band * 0.7;
  const py = (y) => H - m.b - (y / max) * (H - m.t - m.b);
  const base = py(0);
  const pts = items.map((it, i) => ({ ...it, px: m.l + band * i + band / 2, py: py(it.y), band }));
  chartData.set(id, { W, H, pts, bars: true });

  const bar = (p) => {
    if (!p.y) return '';
    const x = p.px - bw / 2, y = p.py, r = Math.min(6, base - y);
    return `<path class="bar" data-i="${pts.indexOf(p)}" d="M${x} ${base}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + bw - r}Q${x + bw} ${y} ${x + bw} ${y + r}V${base}Z"/>`;
  };

  return `
    <div class="chart-wrap">
      <svg class="chart" id="${id}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart of workouts per week for the last ${items.length} weeks">
        ${ticks.filter((t) => Number.isInteger(t)).map((t) => `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${py(t)}" y2="${py(t)}"/><text class="axis" x="${m.l - 10}" y="${py(t) + 6}" text-anchor="end">${t}</text>`).join('')}
        ${pts.map(bar).join('')}
        ${pts.map((p, i) => (i % 3 === 2 || i === pts.length - 1) && i !== pts.length - 2 ? `<text class="axis" x="${p.px}" y="${H - 8}" text-anchor="middle">${i === pts.length - 1 ? 'This wk' : esc(p.label)}</text>` : '').join('')}
        <line class="baseline" x1="${m.l}" x2="${W - m.r}" y1="${base}" y2="${base}"/>
      </svg>
      <div class="tip" hidden></div>
    </div>`;
}

function initCharts() {
  document.querySelectorAll('svg.chart').forEach((svg) => {
    svg.addEventListener('pointermove', onChartPointer);
    svg.addEventListener('pointerdown', onChartPointer);
    svg.addEventListener('pointerleave', hideChartTip);
  });
}

function onChartPointer(e) {
  const svg = e.currentTarget;
  const d = chartData.get(svg.id);
  if (!d) return;
  const rect = svg.getBoundingClientRect();
  const vx = ((e.clientX - rect.left) / rect.width) * d.W;
  let best = d.pts[0];
  for (const p of d.pts) if (Math.abs(p.px - vx) < Math.abs(best.px - vx)) best = p;

  if (d.bars) {
    svg.querySelectorAll('.bar').forEach((b) => b.classList.toggle('hl', Number(b.dataset.i) === d.pts.indexOf(best)));
  } else {
    const cross = svg.querySelector('.cross');
    const focus = svg.querySelector('.focus');
    cross.setAttribute('x1', best.px);
    cross.setAttribute('x2', best.px);
    cross.style.display = '';
    focus.setAttribute('cx', best.px);
    focus.setAttribute('cy', best.py);
    focus.style.display = '';
  }
  const tip = svg.parentElement.querySelector('.tip');
  tip.innerHTML = best.tip;
  tip.hidden = false;
  const leftPct = Math.min(82, Math.max(18, (best.px / d.W) * 100));
  tip.style.left = leftPct + '%';
  tip.style.top = (best.py / d.H) * rect.height + 'px';
}

function hideChartTip(e) {
  const svg = e.currentTarget;
  svg.parentElement.querySelector('.tip').hidden = true;
  svg.querySelectorAll('.cross, .focus').forEach((el) => (el.style.display = 'none'));
  svg.querySelectorAll('.bar.hl').forEach((b) => b.classList.remove('hl'));
}

/* =========================================================================
   Sync across devices (optional): a private GitHub Gist in the user's account
   ========================================================================= */

// Merge two copies of the data. Newest edit wins per item; deletions win over older edits.
function mergeData(a, b) {
  const deleted = { ...a.deleted };
  for (const [k, v] of Object.entries(b.deleted || {})) deleted[k] = Math.max(deleted[k] || 0, v);
  const pick = (la, lb) => {
    const map = new Map();
    for (const x of la) map.set(x.id, x);
    for (const x of lb) {
      const cur = map.get(x.id);
      if (!cur || (x.updatedAt || 0) > (cur.updatedAt || 0)) map.set(x.id, x);
    }
    return [...map.values()].filter((x) => !(deleted[x.id] >= (x.updatedAt || 0)));
  };
  const meta = { ...a.meta };
  for (const [k, v] of Object.entries(b.meta || {})) if (!meta[k] || (v.updatedAt || 0) > (meta[k].updatedAt || 0)) meta[k] = v;
  return {
    workouts: pick(a.workouts, b.workouts),
    history: pick(a.history, b.history).sort((x, y) => x.finishedAt - y.finishedAt),
    meta,
    deleted,
    settings: (b.settings.updatedAt || 0) > (a.settings.updatedAt || 0) ? b.settings : a.settings,
  };
}

function applyMerged(m) {
  Object.assign(db, m);
}

function sharedData() {
  const { workouts, history, meta, deleted, settings } = db;
  return { app: 'trackfit', version: 2, savedAt: new Date().toISOString(), workouts, history, meta, deleted, settings };
}

let syncing = false;
let syncTimer = null;

function scheduleSync() {
  if (!db.sync.token || !db.sync.auto) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(true), 3000);
}

async function gh(path, opts = {}) {
  const res = await fetch('https://api.github.com' + path, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + db.sync.token,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    const msg = res.status === 401 ? 'GitHub rejected the token (expired or revoked?)'
      : res.status === 403 ? 'the token lacks the "gist" permission, or GitHub rate-limited it'
      : `GitHub error ${res.status}`;
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return res.json();
}

async function syncNow(quiet) {
  if (syncing || !db.sync.token) return;
  if (!navigator.onLine) {
    if (!quiet) toast('Offline — will sync later.');
    return;
  }
  syncing = true;
  setSyncStatus('Syncing…');
  try {
    let gist = null;
    if (db.sync.gistId) {
      try {
        gist = await gh('/gists/' + db.sync.gistId);
      } catch (err) {
        if (err.status !== 404) throw err;
        db.sync.gistId = '';
      }
    }
    if (!gist) {
      // Another device may already have created it: look for it by file name.
      for (let page = 1; page <= 10 && !gist; page++) {
        const list = await gh(`/gists?per_page=100&page=${page}`);
        const hit = list.find((g) => g.files && g.files[SYNC_FILE]);
        if (hit) gist = await gh('/gists/' + hit.id);
        if (list.length < 100) break;
      }
    }
    if (gist) {
      const file = gist.files[SYNC_FILE];
      const text = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
      applyMerged(mergeData(db, migrate(JSON.parse(text))));
    }
    const content = JSON.stringify(sharedData());
    if (gist) {
      await gh('/gists/' + gist.id, { method: 'PATCH', body: JSON.stringify({ files: { [SYNC_FILE]: { content } } }) });
      db.sync.gistId = gist.id;
    } else {
      const created = await gh('/gists', {
        method: 'POST',
        body: JSON.stringify({ description: 'Trackfit workout data (synced by the Trackfit app)', public: false, files: { [SYNC_FILE]: { content } } }),
      });
      db.sync.gistId = created.id;
    }
    db.sync.lastSync = Date.now();
    db.sync.error = '';
    save();
    if (!quiet) toast('✓ Synced');
  } catch (err) {
    db.sync.error = err.message;
    save();
    if (!quiet) toast('Sync failed: ' + esc(err.message), 5000);
  } finally {
    syncing = false;
    refreshView();
  }
}

function setSyncStatus(text) {
  const el = document.getElementById('sync-status');
  if (el) el.textContent = text;
}

window.addEventListener('online', () => {
  scheduleSync();
  if (db.sheets.dirty) schedulePush(true);
});

/* =========================================================================
   Google Sheets (optional): live rows sent to an Apps Script web app in the user's sheet.
   Column order must match TABS in google-sheets/Code.gs.
   ========================================================================= */

const TARGET_REASONS = { up: 'All Easy → up', hold: 'Had a Hard set → hold', same: 'Repeat' };

function sheetTabs() {
  const sets = [];
  const sessions = [];
  const sessionRows = (s, live) => {
    s.exercises.forEach((e, ei) => {
      const slot = e.slot ?? ei;
      let n = 0;
      e.sets.forEach((x, si) => {
        if (!x.warmup) n++;
        const timed = x.seconds != null;
        sets.push([
          `${s.id}-${slot + 1}-${si + 1}`, x.at || s.finishedAt || s.startedAt, s.id, s.workoutName, e.name, muscleOf(e.name),
          x.warmup ? '' : n, x.warmup ? 'yes' : '', Number(x.weight) || 0, s.unit,
          timed ? '' : x.reps, timed ? x.seconds : '', cap(x.difficulty),
          timed ? '' : Math.round(epley(Number(x.weight) || 0, x.reps) * 10) / 10,
          timed || x.warmup ? '' : (Number(x.weight) || 0) * (Number(x.reps) || 0),
          (x.pr || []).join(', '), e.superset || '', x.at || s.finishedAt || s.startedAt,
        ]);
      });
    });
    const work = s.exercises.flatMap(workSets);
    const count = (d) => work.filter((x) => x.difficulty === d).length;
    const volume = work.reduce((sum, x) => sum + (x.seconds != null ? 0 : (Number(x.weight) || 0) * (Number(x.reps) || 0)), 0);
    sessions.push([
      s.id, s.startedAt, s.workoutName, s.startedAt, live ? '' : s.finishedAt,
      live ? '' : Math.round((s.finishedAt - s.startedAt) / 60000), s.exercises.filter((e) => e.sets.length).length,
      work.length, Math.round(volume), s.unit, work.filter((x) => x.pr && x.pr.length).length,
      count('easy'), count('medium'), count('hard'),
      (s.progressions || []).map((u) => `${u.name} ${fmtNum(u.from)}→${fmtNum(u.to)}`).join('; '),
      live ? 'In progress' : s.note || '', live ? Date.now() : s.updatedAt || s.finishedAt,
    ]);
  };
  for (const s of db.history) sessionRows(s, false);
  if (db.active) {
    const a = db.active;
    sessionRows({
      ...a,
      exercises: a.exercises.map((e, i) => ({
        ...e,
        slot: i,
        superset: groupMembers(a, e.group).length > 1 ? supersetLetter(a, e.group) : '',
      })),
    }, true);
  }

  const workouts = [];
  for (const w of db.workouts) {
    w.exercises.forEach((e, i) => {
      workouts.push([e.id, w.id, w.name, i + 1, e.name, e.sets, String(e.reps), parseTime(e.reps) != null ? 'yes' : '', e.link ? 'yes' : '', w.updatedAt || w.createdAt || 0]);
    });
  }

  const unit = db.settings.unit;
  const exercises = [];
  for (const [key, name] of exerciseCatalog()) {
    const log = exerciseLog(key);
    const b = bestsFrom(log);
    const meta = db.meta[key] || {};
    const timed = log.some((en) => en.sets.some((x) => x.seconds != null));
    const target = timed ? null : targetFor({ name, timed }, unit);
    exercises.push([
      name, muscleOf(name), meta.note || '',
      b.weight ? convertForBar(b.weight, 'kg', unit) : '', b.e1rm ? Math.round(convert(b.e1rm, 'kg', unit)) : '',
      b.seconds || '', target ? target.weight : '', unit, target ? TARGET_REASONS[target.reason] || '' : '',
      log.length ? log[log.length - 1].date : '', log.length, meta.updatedAt || (log.length ? log[log.length - 1].date : 0),
    ]);
  }
  return { SetLog: sets, Sessions: sessions, Workouts: workouts, Exercises: exercises };
}

let pushing = false;
let pushAgain = false;
let pushTimer = null;

function schedulePush(fast) {
  db.sheets.dirty = true;
  save();
  if (!db.auth.hash) return; // sent after the next sign-in
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => pushToSheet(true), fast ? 1500 : 4000);
}

async function callSheet(body) {
  const res = await fetch(SHEET_URL, {
    method: 'POST',
    // text/plain avoids a CORS preflight, which Apps Script web apps don't answer.
    body: JSON.stringify({ app: 'trackfit', sentAt: Date.now(), ...body }),
  });
  try {
    return await res.json();
  } catch {
    throw new Error('The sheet sent an unexpected reply. Check the Apps Script deployment allows access to "Anyone".');
  }
}

function sheetError(err) {
  if (err.message === 'Failed to fetch') return "Can't reach the sheet. Check your connection.";
  if (/\bkey\b/i.test(err.message)) return "The sheet's script is out of date: paste the new Code.gs into Apps Script and deploy a new version.";
  return err.message;
}

// Password changed or removed in the sheet: lock this device until the new one is entered.
function handleAuthFailure(out) {
  if (out.code !== 'auth' && out.code !== 'nopassword') return false;
  signOut(out.code === 'auth' ? 'The password was changed. Enter the new one.' : out.error);
  return true;
}

async function pushToSheet(quiet) {
  if (!db.auth.hash) return;
  if (pushing) {
    pushAgain = true; // a change arrived mid-send: send again right after
    return;
  }
  if (!navigator.onLine) {
    if (!quiet) toast('Offline — will send to the sheet when you reconnect.');
    return;
  }
  pushing = true;
  pushAgain = false;
  setSheetStatus('Sending…');
  try {
    const out = await callSheet({ passwordHash: db.auth.hash, tabs: sheetTabs() });
    if (!out.ok) {
      if (handleAuthFailure(out)) return;
      throw new Error(out.error || 'The sheet rejected the data.');
    }
    db.sheets.lastPush = Date.now();
    db.sheets.dirty = pushAgain;
    db.sheets.error = '';
    save();
    if (!quiet) toast(`✓ Sent to Google Sheets · ${plural((out.counts && out.counts.SetLog) || 0, 'set')}`);
  } catch (err) {
    db.sheets.error = sheetError(err);
    save();
    if (!quiet) toast('Google Sheets: ' + esc(db.sheets.error), 5000);
  } finally {
    pushing = false;
    if (pushAgain && db.auth.hash) schedulePush(true);
    setSheetStatus();
  }
}

/* ---- Password lock (password lives in Workouts!Z100) ---- */

let lockMessage = '';
let lastVerify = 0;

async function hashPassword(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function renderLock() {
  app.innerHTML = `
    <div class="lock">
      <p class="brand">TRACK<span>FIT</span></p>
      <h1>Locked</h1>
      <p class="muted">Enter your password to open Trackfit.</p>
      <form id="lock-form" class="stack">
        <input id="lock-pass" type="password" autocomplete="current-password" placeholder="Password" aria-label="Password">
        <p class="need" id="lock-msg" role="alert">${esc(lockMessage)}</p>
        <button class="btn primary big block" type="submit" id="lock-btn">Unlock</button>
      </form>
    </div>`;
  document.getElementById('lock-pass').focus();
}

async function unlock() {
  const input = document.getElementById('lock-pass');
  const msg = document.getElementById('lock-msg');
  const btn = document.getElementById('lock-btn');
  const password = input.value.trim();
  if (!password) return input.focus();
  btn.disabled = true;
  msg.textContent = 'Checking…';
  try {
    const hash = await hashPassword(password);
    const out = await callSheet({ action: 'login', passwordHash: hash });
    if (!out.ok) throw new Error(out.error || 'Wrong password.');
    db.auth = { hash, at: Date.now() };
    lockMessage = '';
    lastVerify = Date.now();
    save();
    route();
    if (db.sheets.dirty || !db.sheets.lastPush) schedulePush(true);
  } catch (err) {
    msg.textContent = sheetError(err);
    btn.disabled = false;
    input.select();
  }
}

function signOut(message) {
  db.auth = emptyDb().auth;
  lockMessage = message || '';
  closeModal();
  save();
  route();
}

// Re-check the password with the sheet now and then; offline, the app keeps working.
async function verifySession() {
  if (!db.auth.hash || !navigator.onLine || Date.now() - lastVerify < 5 * 60000) return;
  lastVerify = Date.now();
  try {
    const out = await callSheet({ action: 'login', passwordHash: db.auth.hash });
    if (!out.ok) handleAuthFailure(out);
  } catch { /* unreachable: try again later */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') verifySession();
});

function setSheetStatus(text) {
  const el = document.getElementById('sheet-status');
  if (!el) return;
  const sh = db.sheets;
  el.textContent = text || (sh.error ? sh.error : sh.lastPush ? 'Last sent ' + fmtAgo(sh.lastPush) : 'Not sent yet');
  const tag = document.getElementById('sheet-tag');
  if (tag && !text) {
    tag.className = 'tag ' + (sh.error ? 'hard' : 'easy');
    tag.textContent = sh.error ? 'Problem' : 'Live';
  }
}

/* =========================================================================
   Settings & backup
   ========================================================================= */

function renderSettings() {
  const s = db.settings;
  const sy = db.sync;
  const syncSection = sy.token
    ? `<p><span class="tag ${sy.error ? 'hard' : 'easy'}">${sy.error ? 'Problem' : 'Connected'}</span>
         <span class="muted" id="sync-status">${sy.error ? esc(sy.error) : sy.lastSync ? 'Last synced ' + fmtAgo(sy.lastSync) : 'Not synced yet'}</span></p>
       <label class="switch"><input type="checkbox" data-sync="auto" ${sy.auto ? 'checked' : ''}><span>Sync automatically after changes</span></label>
       <div class="row gap"><button class="btn" data-action="sync-now">⟳ Sync now</button><button class="btn danger" data-action="sync-disconnect">Disconnect</button></div>`
    : `<ol class="steps">
         <li>Create a GitHub token with only the <b>gist</b> permission:
           <a href="https://github.com/settings/tokens/new?scopes=gist&description=Trackfit%20sync" target="_blank" rel="noopener">create token ↗</a></li>
         <li>Paste it below — on each phone or computer you use.</li>
       </ol>
       <label class="field"><span>GitHub token</span><input id="sync-token" type="password" autocomplete="off" placeholder="ghp_… or github_pat_…"></label>
       <button class="btn primary block" data-action="sync-connect">Connect &amp; sync</button>
       <p class="muted small-note">Your data goes to a <b>secret gist</b> in your GitHub account: unlisted, but anyone with its exact link can read it. The token is stored only in this browser and can only touch gists.</p>`;

  const sh = db.sheets;
  const sheetSection = `
    <p><span class="tag ${sh.error ? 'hard' : 'easy'}" id="sheet-tag">${sh.error ? 'Problem' : 'Live'}</span>
      <span class="muted" id="sheet-status">${sh.error ? esc(sh.error) : sh.lastPush ? 'Last sent ' + fmtAgo(sh.lastPush) : 'Not sent yet'}</span></p>
    <div class="row gap"><button class="btn" data-action="sheet-send">⟳ Send now</button><button class="btn" data-action="lock-app">🔒 Lock app</button></div>
    <p class="muted small-note">The password is cell <b>Z100</b> in the sheet's Workouts tab. Change it there and every device has to enter the new one.</p>`;

  app.innerHTML = `
    <header class="page-head"><h1>Settings</h1></header>
    <div class="settings">
      <section class="card">
        <h2>Workout</h2>
        <label class="field"><span>Weight unit</span>
          <select data-setting="unit">
            <option value="lb" ${s.unit === 'lb' ? 'selected' : ''}>Pounds (lb)</option>
            <option value="kg" ${s.unit === 'kg' ? 'selected' : ''}>Kilograms (kg)</option>
          </select>
        </label>
        <label class="field"><span>Rest timer after each set (seconds, 0 = off)</span>
          <input data-setting="restSeconds" type="number" inputmode="numeric" min="0" max="900" step="15" value="${s.restSeconds}">
        </label>
        <div class="inputs-2">
          <label class="field"><span>Bar weight (lb)</span><input data-setting="barLb" type="number" inputmode="decimal" step="any" min="0" value="${s.barLb}"></label>
          <label class="field"><span>Bar weight (kg)</span><input data-setting="barKg" type="number" inputmode="decimal" step="any" min="0" value="${s.barKg}"></label>
          <label class="field"><span>Auto-increase (lb)</span><input data-setting="stepLb" type="number" inputmode="decimal" step="any" min="0" value="${s.stepLb}"></label>
          <label class="field"><span>Auto-increase (kg)</span><input data-setting="stepKg" type="number" inputmode="decimal" step="any" min="0" value="${s.stepKg}"></label>
        </div>
        <p class="muted small-note">When every working set of an exercise felt Easy, its target for next time goes up by the auto-increase amount.</p>
        <button class="btn block" data-action="plates-standalone" style="margin-top:12px">🧮 Plate calculator</button>
      </section>

      <section class="card">
        <h2>Google Sheets</h2>
        <p class="muted">Every set, session, workout and exercise goes to your Trackfit sheet seconds after you log it.</p>
        <div class="stack">${sheetSection}</div>
      </section>

      <section class="card">
        <h2>Sync across devices <small class="muted">(optional)</small></h2>
        <p class="muted">Off by default: your data stays on this device. Turn it on to keep your phone and other devices in sync through your own GitHub account.</p>
        <div class="stack">${syncSection}</div>
      </section>

      <section class="card">
        <h2>Backup</h2>
        <p class="muted">Clearing browser data erases everything stored here. Export a backup now and then.</p>
        <div class="stack">
          <button class="btn block" data-action="export">⬇ Export backup</button>
          <label class="btn block">⬆ Import &amp; merge<input type="file" data-import="merge" accept="application/json,.json" hidden></label>
          <label class="btn block">⬆ Import &amp; replace everything<input type="file" data-import="replace" accept="application/json,.json" hidden></label>
          <button class="btn block danger" data-action="wipe">Erase all data on this device</button>
        </div>
      </section>

      <p class="muted" style="text-align:center;margin-top:20px;font-size:.85rem">
        ${plural(db.workouts.length, 'workout')} · ${plural(db.history.length, 'logged session')}
      </p>
    </div>`;
}

function exportData() {
  const blob = new Blob([JSON.stringify({ ...sharedData(), active: db.active }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `trackfit-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importData(file, mode) {
  try {
    const raw = JSON.parse(await file.text());
    if (!Array.isArray(raw.workouts) || !Array.isArray(raw.history)) throw new Error('This does not look like a Trackfit backup.');
    const data = migrate(raw);
    const summary = `${plural(data.workouts.length, 'workout')} and ${plural(data.history.length, 'logged session')}`;
    if (mode === 'replace') {
      if (!confirm(`Replace everything on this device with ${summary} from the backup?`)) return;
      db = { ...data, active: data.active || db.active, sync: db.sync };
    } else {
      if (!confirm(`Merge ${summary} from the backup into this device? Nothing here is removed.`)) return;
      applyMerged(mergeData(db, data));
    }
    commit();
    alert('Backup imported.');
    go('#/');
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
}

/* =========================================================================
   Events (delegated)
   ========================================================================= */

const actions = {
  select(el) {
    selectedId = selectedId === el.dataset.id ? null : el.dataset.id;
    renderHome();
  },
  execute: (el) => executeWorkout(el.dataset.id),
  duplicate(el) {
    const w = db.workouts.find((x) => x.id === el.dataset.id);
    const now = Date.now();
    const copy = { ...clone(w), id: uid(), name: w.name + ' (copy)', createdAt: now, updatedAt: now };
    copy.exercises.forEach((e) => (e.id = uid()));
    db.workouts.splice(db.workouts.indexOf(w) + 1, 0, copy);
    selectedId = copy.id;
    commit();
    renderHome();
  },
  'delete-workout'(el) {
    const w = db.workouts.find((x) => x.id === el.dataset.id);
    if (!confirm(`Delete "${w.name}"? Your logged history for it is kept.`)) return;
    db.workouts = db.workouts.filter((x) => x.id !== w.id);
    db.deleted[w.id] = Date.now();
    commit();
    renderHome();
  },

  'add-row'() {
    const prev = draft.exercises[draft.exercises.length - 1];
    draft.exercises.push({ ...blankRow(), sets: prev ? prev.sets : 3, reps: prev ? prev.reps : '10' });
    renderRows();
    const inputs = document.querySelectorAll('#rows input[data-field="name"]');
    inputs[inputs.length - 1].focus();
  },
  'row-up': (el) => moveRow(el, -1),
  'row-down': (el) => moveRow(el, 1),
  'row-link'(el) {
    const e = draft.exercises[rowIndex(el)];
    e.link = !e.link;
    renderRows();
  },
  'row-del'(el) {
    const i = rowIndex(el);
    draft.exercises.splice(i, 1);
    if (!draft.exercises.length) draft.exercises.push(blankRow());
    draft.exercises[draft.exercises.length - 1].link = false;
    renderRows();
  },
  'save-workout': saveWorkout,

  'set-done': (el) => logSet(el.dataset.d),
  'use-weight'(el) {
    const input = document.getElementById('weight');
    input.value = el.dataset.w;
    db.active.pendingWeight = el.dataset.w;
    save();
    updateSetButtons();
  },
  'undo-set'() {
    const a = db.active;
    const i = lastLoggedIndex(a);
    if (i < 0) return;
    if (i !== a.index) setIndex(i); // supersets may have moved on: go back to where the set was logged
    const removed = a.exercises[i].sets.pop();
    if (removed) {
      a.pendingWeight = String(removed.weight);
      a.pendingReps = String(removed.seconds != null ? removed.seconds : removed.reps);
      a.warmup = !!removed.warmup;
    }
    a.restEndsAt = null;
    save();
    schedulePush(true);
    renderRun();
  },
  'rest-add'() {
    const a = db.active;
    a.restEndsAt = Math.max(a.restEndsAt, Date.now()) + 30000;
    restAlerted = false;
    save();
    tick();
  },
  'rest-skip'() {
    db.active.restEndsAt = null;
    save();
    tick();
  },
  'hold-start': holdStart,
  'hold-stop'() {
    const h = db.active.hold;
    if (h) holdFinish(Math.max(1, Math.round((Date.now() - h.startedAt) / 1000)), false);
  },
  'prev-ex': () => moveExercise(-1),
  'next-ex': () => moveExercise(1),
  finish: finishWorkout,
  discard: () => discardWorkout(false),
  plates: () => openPlates(document.getElementById('weight').value),
  'plates-standalone': () => openPlates(''),
  'plates-use'() {
    const v = document.getElementById('pc-total').value;
    closeModal();
    const input = document.getElementById('weight');
    if (input && weightIsValid(v)) {
      input.value = v;
      db.active.pendingWeight = v;
      save();
      updateSetButtons();
    }
  },
  'edit-note': () => openNoteEditor(db.active.exercises[db.active.index].name),
  'save-note'(el) {
    setMeta(el.dataset.name, { note: document.getElementById('note-text').value.trim() });
    commit();
    closeModal();
    if (currentView() === 'run') renderRun();
  },
  'close-modal': closeModal,

  metric(el) {
    chartMetric = el.dataset.m;
    route(true);
  },
  'delete-session'(el) {
    if (!confirm('Delete this workout from your history?')) return;
    db.history = db.history.filter((s) => s.id !== el.dataset.id);
    db.deleted[el.dataset.id] = Date.now();
    commit();
    go('#/history');
  },

  'sync-connect'() {
    const token = document.getElementById('sync-token').value.trim();
    if (!token) return alert('Paste a GitHub token first.');
    db.sync = { ...db.sync, token, gistId: '', error: '', auto: true };
    save();
    renderSettings();
    syncNow(false);
  },
  'sync-now': () => syncNow(false),
  'sheet-send': () => pushToSheet(false),
  'lock-app'() {
    if (confirm('Lock Trackfit on this device? You will need the password to open it again.')) signOut('');
  },
  'sync-disconnect'() {
    if (!confirm('Stop syncing this device? Your data stays here and in the gist.')) return;
    db.sync = emptyDb().sync;
    save();
    renderSettings();
  },
  export: exportData,
  wipe() {
    if (!confirm('Erase ALL workouts and history from this device? This cannot be undone.')) return;
    if (!confirm('Are you sure? Consider exporting a backup first.')) return;
    db = emptyDb(); // also disconnects sync, so the gist copy is left untouched
    selectedId = null;
    save();
    go('#/');
  },
};

function rowIndex(el) {
  return Number(el.closest('tr').dataset.i);
}

function moveRow(el, delta) {
  const i = rowIndex(el);
  const j = i + delta;
  if (j < 0 || j >= draft.exercises.length) return;
  [draft.exercises[i], draft.exercises[j]] = [draft.exercises[j], draft.exercises[i]];
  draft.exercises[draft.exercises.length - 1].link = false;
  renderRows();
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) fn(el);
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.draft === 'name') draft.name = t.value;
  else if (t.dataset.field) draft.exercises[rowIndex(t)][t.dataset.field] = t.value;
  else if (t.id === 'weight' && db.active) {
    db.active.pendingWeight = t.value;
    save();
    updateSetButtons();
  } else if (t.id === 'reps' && db.active) {
    db.active.pendingReps = t.value;
    const time = document.getElementById('hold-time');
    if (time && !db.active.hold) time.textContent = fmtSecs(t.value);
    save();
  } else if (t.id === 'pc-total' || t.id === 'pc-bar') {
    renderPlates();
  } else if (t.dataset.sessionNote) {
    const s = db.history.find((x) => x.id === t.dataset.sessionNote);
    s.note = t.value;
    s.updatedAt = Date.now();
    commit();
  } else if (t.dataset.meta === 'note') {
    setMeta(t.dataset.name, { note: t.value.trim() });
    commit();
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.setting) {
    const key = t.dataset.setting;
    if (key === 'unit') db.settings.unit = t.value;
    else if (key === 'restSeconds') db.settings.restSeconds = Math.min(900, Math.max(0, parseInt(t.value, 10) || 0));
    else db.settings[key] = Math.max(0, Number(t.value) || 0);
    if (key !== 'unit') t.value = db.settings[key];
    db.settings.updatedAt = Date.now();
    commit();
  } else if (t.id === 'warmup' && db.active) {
    db.active.warmup = t.checked;
    save();
    renderRun();
  } else if (t.dataset.meta === 'muscle') {
    setMeta(t.dataset.name, { muscle: t.value });
    commit();
  } else if (t.dataset.sync === 'auto') {
    db.sync.auto = t.checked;
    save();
  } else if (t.dataset.import && t.files[0]) {
    importData(t.files[0], t.dataset.import);
    t.value = '';
  }
});

document.addEventListener('submit', (e) => {
  if (e.target.id === 'lock-form') {
    e.preventDefault();
    unlock();
  }
});

// Enter in the builder adds a new row; Enter in the run inputs hides the keyboard.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.dataset.field) {
    e.preventDefault();
    actions['add-row']();
  } else if (['weight', 'reps', 'pc-total', 'pc-bar'].includes(e.target.id)) {
    e.target.blur();
  }
});

window.addEventListener('hashchange', () => route());
route();

if (db.sync.token && db.sync.auto) setTimeout(() => syncNow(true), 1500);
if (db.auth.hash) {
  verifySession();
  if (db.sheets.dirty) setTimeout(() => pushToSheet(true), 2500);
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
