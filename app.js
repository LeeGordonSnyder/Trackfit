'use strict';

/* =========================================================================
   Storage: everything lives in localStorage on this device.
   ========================================================================= */

const STORE_KEY = 'trackfit:v1';
const DEFAULTS = {
  workouts: [], // { id, name, createdAt, exercises: [{ id, name, sets, reps }] }
  history: [], // finished sessions, oldest first
  active: null, // the session currently being executed
  settings: { unit: 'lb', restSeconds: 90 },
};

let db = load();

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      return { ...DEFAULTS, ...d, settings: { ...DEFAULTS.settings, ...(d.settings || {}) } };
    }
  } catch (err) {
    console.error('Failed to load saved data', err);
  }
  return JSON.parse(JSON.stringify(DEFAULTS));
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
  } catch (err) {
    alert('Could not save your data: ' + err.message);
  }
}

// Ask the browser not to evict our data when the device is low on space.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

/* =========================================================================
   Helpers
   ========================================================================= */

const app = document.getElementById('app');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const norm = (s) => String(s).trim().toLowerCase();
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmtNum(n) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
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

function fmtHuman(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

function setVolume(sets) {
  return sets.reduce((sum, s) => sum + (Number(s.weight) || 0) * (Number(s.reps) || 0), 0);
}

function lastSessionFor(workoutId) {
  for (let i = db.history.length - 1; i >= 0; i--) if (db.history[i].workoutId === workoutId) return db.history[i];
  return null;
}

// Most recent logged sets for an exercise name, across every workout.
function lastPerformance(name) {
  const key = norm(name);
  for (let i = db.history.length - 1; i >= 0; i--) {
    const session = db.history[i];
    const ex = session.exercises.find((e) => norm(e.name) === key && e.sets.length);
    if (ex) return { date: session.finishedAt, unit: session.unit, sets: ex.sets };
  }
  return null;
}

// Simple progression advice based on how the heaviest sets felt last time.
function suggestion(perf) {
  const top = Math.max(...perf.sets.map((s) => Number(s.weight) || 0));
  const topSets = perf.sets.filter((s) => (Number(s.weight) || 0) === top);
  const step = perf.unit === 'kg' ? 2.5 : 5;
  if (top > 0 && topSets.every((s) => s.difficulty === 'easy')) {
    return { weight: top + step, text: `Felt easy last time — try ${fmtNum(top + step)} ${perf.unit}` };
  }
  if (topSets.some((s) => s.difficulty === 'hard')) {
    return { weight: top, text: `Felt hard — stay at ${fmtNum(top)} ${perf.unit}` };
  }
  return { weight: top, text: `Repeat ${fmtNum(top)} ${perf.unit}, go up if it feels easy` };
}

function exerciseNames() {
  const names = new Map();
  for (const w of db.workouts) for (const e of w.exercises) names.set(norm(e.name), e.name);
  for (const s of db.history) for (const e of s.exercises) names.set(norm(e.name), e.name);
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}

/* =========================================================================
   Router
   ========================================================================= */

function route() {
  const [view = '', id] = location.hash.replace(/^#\/?/, '').split('/');
  stopTicker();
  window.scrollTo(0, 0);
  document.body.classList.toggle('running', view === 'run');
  if (view !== 'run') releaseWakeLock();

  switch (view) {
    case 'new': renderBuilder(); break;
    case 'edit': renderBuilder(id); break;
    case 'run': renderRun(); break;
    case 'done': renderSession(id, true); break;
    case 'history': id ? renderSession(id, false) : renderHistory(); break;
    case 'settings': renderSettings(); break;
    default: renderHome();
  }

  const tab = view === 'history' || view === 'done' ? 'history' : view === 'settings' ? 'settings' : 'home';
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

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
      <h1>Workouts</h1>
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
           ${w.exercises.map((e) => `<li><span>${esc(e.name)}</span><span class="muted">${e.sets} × ${esc(e.reps)}</span></li>`).join('')}
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
  db.active = {
    id: uid(),
    workoutId: w.id,
    workoutName: w.name,
    unit: db.settings.unit,
    startedAt: Date.now(),
    index: 0,
    pendingWeight: '',
    pendingReps: defaultReps(w.exercises[0].reps),
    restEndsAt: null,
    exercises: w.exercises.map((e) => ({ name: e.name, targetSets: e.sets, targetReps: e.reps, sets: [] })),
  };
  save();
  go('#/run');
}

/* =========================================================================
   Builder: create / edit a workout in a table
   ========================================================================= */

let draft = null;

const blankRow = () => ({ id: uid(), name: '', sets: 3, reps: '10' });

function renderBuilder(id) {
  const existing = id ? db.workouts.find((w) => w.id === id) : null;
  if (id && !existing) return go('#/');
  draft = existing ? JSON.parse(JSON.stringify(existing)) : { id: null, name: '', exercises: [blankRow(), blankRow(), blankRow()] };

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
    <datalist id="ex-names">${exerciseNames().map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
    <div class="sticky-actions">
      <button class="btn primary big block" data-action="save-workout">Save workout</button>
    </div>`;
  renderRows();
  if (!existing) document.getElementById('wname').focus();
}

function renderRows() {
  const last = draft.exercises.length - 1;
  document.getElementById('rows').innerHTML = draft.exercises
    .map((e, i) => `
      <tr data-i="${i}">
        <td class="num">${i + 1}</td>
        <td><input data-field="name" value="${esc(e.name)}" list="ex-names" placeholder="e.g. Bench press" autocomplete="off" maxlength="80" aria-label="Exercise ${i + 1} name"></td>
        <td class="n"><input data-field="sets" type="number" inputmode="numeric" min="1" max="99" value="${esc(e.sets)}" aria-label="Sets"></td>
        <td class="n"><input data-field="reps" inputmode="numeric" value="${esc(e.reps)}" maxlength="10" aria-label="Reps" placeholder="10"></td>
        <td class="row-actions">
          <button data-action="row-up" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button data-action="row-down" aria-label="Move down" ${i === last ? 'disabled' : ''}>↓</button>
          <button data-action="row-del" class="del" aria-label="Remove">✕</button>
        </td>
      </tr>`)
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
    }));

  if (!name) {
    alert('Give the workout a name.');
    return document.getElementById('wname').focus();
  }
  if (!exercises.length) return alert('Add at least one exercise.');

  if (draft.id) {
    const w = db.workouts.find((x) => x.id === draft.id);
    Object.assign(w, { name, exercises });
  } else {
    draft.id = uid();
    db.workouts.push({ id: draft.id, name, createdAt: Date.now(), exercises });
  }
  selectedId = draft.id;
  save();
  go('#/');
}

/* =========================================================================
   Run: executing a workout one exercise at a time
   ========================================================================= */

// Reps like "8-12" or "AMRAP" can't prefill a number box; use the first number if there is one.
function defaultReps(reps) {
  const m = String(reps).match(/\d+/);
  return m ? m[0] : '';
}

function weightIsValid(v) {
  return v !== '' && v != null && !Number.isNaN(Number(v)) && Number(v) >= 0;
}

function renderRun() {
  const a = db.active;
  if (!a) return go('#/');
  const ex = a.exercises[a.index];
  const total = a.exercises.length;
  const done = ex.sets.length;
  const met = done >= ex.targetSets;
  const isLast = a.index === total - 1;
  const perf = lastPerformance(ex.name);

  let hint = '';
  if (perf) {
    const tip = suggestion(perf);
    hint = `
      <div class="hint">
        <div class="muted">Last time · ${fmtDate(perf.date)}</div>
        <div class="sets">${perf.sets.map((s) => `<span class="tag ${s.difficulty}">${fmtNum(s.weight)} × ${esc(s.reps)}</span>`).join('')}</div>
        <div class="suggest"><span>${esc(tip.text)}</span>
          ${perf.unit === a.unit ? `<button class="btn small" data-action="use-weight" data-w="${tip.weight}">Use</button>` : ''}
        </div>
      </div>`;
  }

  app.innerHTML = `
    <div class="run">
      <div class="run-top"><span class="muted">${esc(a.workoutName)}</span><span class="muted mono" id="elapsed"></span></div>
      <div class="progress" aria-hidden="true">
        ${a.exercises.map((e, i) => `<span class="${i === a.index ? 'current' : e.sets.length ? 'has' : ''}"></span>`).join('')}
      </div>

      <p class="eyebrow">Exercise ${a.index + 1} of ${total}</p>
      <h1 class="ex-name">${esc(ex.name)}</h1>
      <p class="muted">Target: ${plural(ex.targetSets, 'set')} × ${esc(ex.targetReps)} reps</p>

      <div class="card set-counter ${met ? 'met' : ''}">
        <div class="now"><span class="muted">Set</span><b>${done + 1}</b></div>
        <div class="done-count"><b>${done} / ${ex.targetSets}</b>${met ? 'target hit ✓' : 'sets done'}</div>
      </div>

      ${hint}

      <div class="inputs">
        <label class="field"><span>Weight (${a.unit})</span>
          <input id="weight" type="number" inputmode="decimal" step="any" min="0" placeholder="—" value="${esc(a.pendingWeight)}">
        </label>
        <label class="field"><span>Reps</span>
          <input id="reps" type="number" inputmode="numeric" min="0" step="1" placeholder="—" value="${esc(a.pendingReps)}">
        </label>
      </div>
      <p class="need" id="need"></p>

      <p class="setdone-label">Set done — how did it feel?</p>
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

      ${done ? `
        <ol class="logged">
          ${ex.sets.map((s, i) => `<li><span>Set ${i + 1}</span><span>${fmtNum(s.weight)} ${a.unit} × ${esc(s.reps)}</span><span class="tag ${s.difficulty}">${cap(s.difficulty)}</span></li>`).join('')}
        </ol>
        <button class="link" data-action="undo-set">Undo last set</button>` : ''}

      <div class="run-nav">
        <button class="btn big" data-action="prev-ex" ${a.index === 0 ? 'disabled' : ''}>‹ Prev</button>
        ${isLast
          ? `<button class="btn big primary" data-action="finish">Finish workout ✓</button>`
          : `<button class="btn big ${met ? 'primary' : ''}" data-action="next-ex">Next exercise ›</button>`}
      </div>
      <div class="run-foot"><button class="link danger" data-action="discard">Discard workout</button></div>
    </div>`;

  updateSetButtons();
  startTicker();
  requestWakeLock();
}

function updateSetButtons() {
  const input = document.getElementById('weight');
  if (!input) return;
  const ok = weightIsValid(input.value);
  document.querySelectorAll('[data-action="set-done"]').forEach((b) => (b.disabled = !ok));
  document.getElementById('need').textContent = ok ? '' : 'Enter the weight to log this set (0 for bodyweight)';
}

function logSet(difficulty) {
  const a = db.active;
  const weight = document.getElementById('weight').value;
  const reps = document.getElementById('reps').value;
  if (!weightIsValid(weight)) return updateSetButtons();

  a.exercises[a.index].sets.push({
    weight: Number(weight),
    reps: reps === '' ? a.exercises[a.index].targetReps : Number(reps),
    difficulty,
    at: Date.now(),
  });
  a.pendingWeight = weight; // keep the same weight for the next set
  a.restEndsAt = db.settings.restSeconds > 0 ? Date.now() + db.settings.restSeconds * 1000 : null;
  restAlerted = false;
  unlockAudio();
  if (navigator.vibrate) navigator.vibrate(30);
  save();
  renderRun();
}

function moveExercise(delta) {
  const a = db.active;
  const next = a.index + delta;
  if (next < 0 || next >= a.exercises.length) return;
  a.index = next;
  const ex = a.exercises[next];
  const last = ex.sets[ex.sets.length - 1];
  a.pendingWeight = last ? String(last.weight) : '';
  a.pendingReps = last ? String(last.reps) : defaultReps(ex.targetReps);
  a.restEndsAt = null;
  save();
  window.scrollTo(0, 0);
  renderRun();
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

  const session = {
    id: a.id,
    workoutId: a.workoutId,
    workoutName: a.workoutName,
    unit: a.unit,
    startedAt: a.startedAt,
    finishedAt: Date.now(),
    exercises: logged.map((e) => ({ name: e.name, targetSets: e.targetSets, targetReps: e.targetReps, sets: e.sets })),
  };
  db.history.push(session);
  db.active = null;
  save();
  go('#/done/' + session.id);
}

function discardWorkout(skipConfirm) {
  if (!skipConfirm && !confirm('Discard this workout? Logged sets will be lost.')) return;
  db.active = null;
  save();
  go('#/');
}

/* ---- Ticker: elapsed time + rest countdown ---- */

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

/* ---- Beep at the end of rest (audio must be unlocked by a tap first) ---- */

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

/* =========================================================================
   Session summary & history
   ========================================================================= */

function sessionStats(s) {
  const sets = s.exercises.flatMap((e) => e.sets);
  const count = (d) => sets.filter((x) => x.difficulty === d).length;
  return {
    duration: s.finishedAt - s.startedAt,
    sets: sets.length,
    volume: setVolume(sets),
    easy: count('easy'),
    medium: count('medium'),
    hard: count('hard'),
  };
}

function renderSession(id, justFinished) {
  const s = db.history.find((x) => x.id === id);
  if (!s) return go('#/history');
  const st = sessionStats(s);

  app.innerHTML = `
    <header class="page-head">
      ${justFinished ? '<span></span>' : '<a href="#/history" class="back">‹ History</a>'}
    </header>
    ${justFinished ? '<p class="eyebrow">Workout complete 🎉</p>' : `<p class="eyebrow">${fmtDate(s.finishedAt, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</p>`}
    <h1>${esc(s.workoutName)}</h1>

    <div class="stats">
      <div class="card stat"><b>${fmtHuman(st.duration)}</b><span>Duration</span></div>
      <div class="card stat"><b>${st.sets}</b><span>Sets</span></div>
      <div class="card stat"><b>${fmtNum(st.volume)}</b><span>Volume (${s.unit})</span></div>
      <div class="card stat"><b><span class="tag easy">${st.easy}</span> <span class="tag medium">${st.medium}</span> <span class="tag hard">${st.hard}</span></b><span>Easy · Medium · Hard</span></div>
    </div>

    <div class="list">
      ${s.exercises.map((e) => `
        <section class="card ex-block">
          <h3>${esc(e.name)}</h3>
          <ol class="logged">
            ${e.sets.map((x, i) => `<li><span>Set ${i + 1}</span><span>${fmtNum(x.weight)} ${s.unit} × ${esc(x.reps)}</span><span class="tag ${x.difficulty}">${cap(x.difficulty)}</span></li>`).join('')}
          </ol>
        </section>`).join('')}
    </div>

    <div class="stack" style="margin-top:20px">
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
        <div><h2>${esc(s.workoutName)}</h2><p class="muted">${fmtDate(s.finishedAt, { weekday: 'short', month: 'short', day: 'numeric' })} · ${fmtHuman(st.duration)}</p></div>
        <div class="right">${plural(st.sets, 'set')}<br>${fmtNum(st.volume)} ${s.unit}</div>
      </a>`;
  }

  app.innerHTML = `
    <header class="page-head"><h1>History</h1><span class="muted">${plural(db.history.length, 'workout')}</span></header>
    <div class="list">${html}</div>`;
}

/* =========================================================================
   Settings & backup
   ========================================================================= */

function renderSettings() {
  app.innerHTML = `
    <header class="page-head"><h1>Settings</h1></header>
    <div class="settings">
      <section class="card">
        <h2>Workout</h2>
        <label class="field"><span>Weight unit</span>
          <select data-setting="unit">
            <option value="lb" ${db.settings.unit === 'lb' ? 'selected' : ''}>Pounds (lb)</option>
            <option value="kg" ${db.settings.unit === 'kg' ? 'selected' : ''}>Kilograms (kg)</option>
          </select>
        </label>
        <label class="field"><span>Rest timer after each set (seconds, 0 = off)</span>
          <input data-setting="restSeconds" type="number" inputmode="numeric" min="0" max="900" step="15" value="${db.settings.restSeconds}">
        </label>
      </section>

      <section class="card">
        <h2>Your data</h2>
        <p class="muted">Everything is stored only on this device, in this browser. Export a backup now and then — clearing browser data will erase it.</p>
        <div class="stack">
          <button class="btn block" data-action="export">⬇ Export backup</button>
          <label class="btn block">⬆ Import backup<input type="file" id="import-file" accept="application/json,.json" hidden></label>
          <button class="btn block danger" data-action="wipe">Erase all data</button>
        </div>
      </section>

      <p class="muted" style="text-align:center;margin-top:20px;font-size:.85rem">
        ${plural(db.workouts.length, 'workout')} · ${plural(db.history.length, 'logged session')}
      </p>
    </div>`;
}

function exportData() {
  const blob = new Blob([JSON.stringify({ app: 'trackfit', version: 1, exportedAt: new Date().toISOString(), ...db }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `trackfit-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.workouts) || !Array.isArray(data.history)) throw new Error('This does not look like a Trackfit backup.');
    const summary = `${plural(data.workouts.length, 'workout')} and ${plural(data.history.length, 'logged session')}`;
    if (!confirm(`Replace everything on this device with ${summary} from the backup?`)) return;
    db = {
      workouts: data.workouts,
      history: data.history,
      active: data.active || null,
      settings: { ...DEFAULTS.settings, ...(data.settings || {}) },
    };
    save();
    alert('Backup restored.');
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
    const copy = { ...JSON.parse(JSON.stringify(w)), id: uid(), name: w.name + ' (copy)', createdAt: Date.now() };
    copy.exercises.forEach((e) => (e.id = uid()));
    db.workouts.splice(db.workouts.indexOf(w) + 1, 0, copy);
    selectedId = copy.id;
    save();
    renderHome();
  },
  'delete-workout'(el) {
    const w = db.workouts.find((x) => x.id === el.dataset.id);
    if (!confirm(`Delete "${w.name}"? Your logged history for it is kept.`)) return;
    db.workouts = db.workouts.filter((x) => x.id !== w.id);
    save();
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
  'row-del'(el) {
    draft.exercises.splice(rowIndex(el), 1);
    if (!draft.exercises.length) draft.exercises.push(blankRow());
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
    const ex = db.active.exercises[db.active.index];
    const removed = ex.sets.pop();
    if (removed) {
      db.active.pendingWeight = String(removed.weight);
      db.active.pendingReps = String(removed.reps);
    }
    db.active.restEndsAt = null;
    save();
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
  'prev-ex': () => moveExercise(-1),
  'next-ex': () => moveExercise(1),
  finish: finishWorkout,
  discard: () => discardWorkout(false),

  'delete-session'(el) {
    if (!confirm('Delete this workout from your history?')) return;
    db.history = db.history.filter((s) => s.id !== el.dataset.id);
    save();
    go('#/history');
  },

  export: exportData,
  wipe() {
    if (!confirm('Erase ALL workouts and history from this device? This cannot be undone.')) return;
    if (!confirm('Are you sure? Consider exporting a backup first.')) return;
    db = JSON.parse(JSON.stringify(DEFAULTS));
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
  renderRows();
}

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) fn(el);
});

app.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.draft === 'name') draft.name = t.value;
  else if (t.dataset.field) draft.exercises[rowIndex(t)][t.dataset.field] = t.value;
  else if (t.id === 'weight' && db.active) {
    db.active.pendingWeight = t.value;
    save();
    updateSetButtons();
  } else if (t.id === 'reps' && db.active) {
    db.active.pendingReps = t.value;
    save();
  }
});

app.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.setting === 'unit') {
    db.settings.unit = t.value;
    save();
  } else if (t.dataset.setting === 'restSeconds') {
    db.settings.restSeconds = Math.min(900, Math.max(0, parseInt(t.value, 10) || 0));
    t.value = db.settings.restSeconds;
    save();
  } else if (t.id === 'import-file' && t.files[0]) {
    importData(t.files[0]);
    t.value = '';
  }
});

// Enter in the builder's last field adds a new row; Enter in the weight box blurs to hide the keyboard.
app.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.dataset.field) {
    e.preventDefault();
    actions['add-row']();
  } else if (e.target.id === 'weight' || e.target.id === 'reps') {
    e.target.blur();
  }
});

window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
