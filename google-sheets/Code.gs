/**
 * Trackfit → Google Sheets bridge.
 *
 * Paste this into the sheet's Apps Script editor (Extensions → Apps Script), run `setup` once,
 * then deploy it as a web app. Full steps: google-sheets/README.md in the Trackfit repo.
 *
 * Access: the app's password is whatever is in Workouts!Z100. Every request must carry a
 * SHA-256 hash of it; change the cell and every device has to sign in again.
 *
 * The app sends a full snapshot of its data. Each tab is matched on its first column (ID):
 * existing rows are updated in place, new ones are appended, and rows the app no longer has
 * are removed. Only the Trackfit columns are written; whole rows are never inserted or
 * deleted, so cells to the right (like Z100) stay exactly where they are.
 */

const TABS = {
  SetLog: {
    headers: ['ID', 'DATE', 'SESSION ID', 'WORKOUT', 'EXERCISE', 'MUSCLE', 'SET #', 'WARM-UP', 'WEIGHT', 'UNIT',
      'REPS', 'SECONDS', 'DIFFICULTY', 'EST 1RM', 'VOLUME', 'PR', 'SUPERSET', 'TIMESTAMP'],
    dates: ['DATE'],
    times: ['TIMESTAMP'],
  },
  Sessions: {
    headers: ['ID', 'DATE', 'WORKOUT', 'START', 'END', 'DURATION (MIN)', 'EXERCISES', 'WORKING SETS', 'VOLUME', 'UNIT',
      'PRS', 'EASY', 'MEDIUM', 'HARD', 'NEXT TIME', 'NOTE', 'TIMESTAMP'],
    dates: ['DATE'],
    times: ['START', 'END', 'TIMESTAMP'],
  },
  Workouts: {
    headers: ['ID', 'WORKOUT ID', 'WORKOUT', 'ORDER', 'EXERCISE', 'SETS', 'REPS', 'TIMED', 'SUPERSET WITH NEXT', 'UPDATED'],
    times: ['UPDATED'],
    text: ['REPS'], // keeps "8-12" from turning into a date
  },
  Exercises: {
    headers: ['EXERCISE', 'MUSCLE', 'NOTE', 'BEST WEIGHT', 'BEST EST 1RM', 'LONGEST HOLD (S)', 'TARGET WEIGHT', 'UNIT',
      'TARGET REASON', 'LAST DONE', 'SESSIONS', 'UPDATED'],
    dates: ['LAST DONE'],
    times: ['UPDATED'],
  },
};

const DATE_FORMAT = 'M/d/yyyy';
const TIME_FORMAT = 'M/d/yyyy H:mm:ss';
const PASSWORD_SHEET = 'Workouts';
const PASSWORD_CELL = 'Z100';
const MAX_FAILS = 20; // wrong passwords allowed per 10 minutes before everyone is paused

/** Run once from the editor: creates the tabs. Then type a password into Workouts!Z100. */
function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(TABS).forEach((name) => ensureTab(ss, name));
  const blank = ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) ss.deleteSheet(blank);
  Logger.log('Tabs ready. Set the app password in ' + PASSWORD_SHEET + '!' + PASSWORD_CELL + '.');
}

function doGet() {
  return json({ ok: true, app: 'trackfit', message: 'Trackfit sheet bridge is running.' });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const auth = checkPassword(body.passwordHash);
    if (!auth.ok) return json(auth);
    if (body.action === 'login') return json({ ok: true });

    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      const ss = SpreadsheetApp.getActive();
      const counts = {};
      Object.keys(TABS).forEach((name) => {
        const rows = body.tabs && body.tabs[name];
        if (Array.isArray(rows)) counts[name] = syncTab(ensureTab(ss, name), TABS[name], rows);
      });
      return json({ ok: true, counts: counts });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) });
  }
}

function checkPassword(hash) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('fails') || 0);
  if (fails >= MAX_FAILS) return { ok: false, code: 'paused', error: 'Too many wrong passwords. Try again in 10 minutes.' };
  const sheet = SpreadsheetApp.getActive().getSheetByName(PASSWORD_SHEET);
  const password = sheet ? String(sheet.getRange(PASSWORD_CELL).getDisplayValue()).trim() : '';
  if (!password) return { ok: false, code: 'nopassword', error: 'No password set yet. Type one into cell ' + PASSWORD_CELL + ' of the ' + PASSWORD_SHEET + ' tab.' };
  if (typeof hash !== 'string' || hash !== sha256Hex(password)) {
    cache.put('fails', String(fails + 1), 600);
    return { ok: false, code: 'auth', error: 'Wrong password.' };
  }
  return { ok: true };
}

function sha256Hex(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map((b) => ((b + 256) % 256).toString(16).padStart(2, '0'))
    .join('');
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function ensureTab(ss, name) {
  const spec = TABS[name];
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  const head = sheet.getRange(1, 1, 1, spec.headers.length);
  if (head.getValues()[0].join('|') !== spec.headers.join('|')) {
    head.setValues([spec.headers]).setFontWeight('bold').setBackground('#0b0b0d').setFontColor('#ffb800');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

const normId = (v) => String(v).trim().toLowerCase();

function toCells(spec, row) {
  return row.map((v, i) => {
    const h = spec.headers[i];
    const isTime = (spec.dates || []).includes(h) || (spec.times || []).includes(h);
    if (isTime) return typeof v === 'number' && v > 0 ? new Date(v) : '';
    return v === null || v === undefined ? '' : v;
  });
}

// Last row with an ID in column A (other columns, like Z100, don't count).
function lastIdRow(sheet) {
  const max = sheet.getLastRow();
  if (max < 2) return max;
  const col = sheet.getRange(1, 1, max, 1).getValues();
  for (let i = col.length - 1; i >= 0; i--) if (col[i][0] !== '' && col[i][0] != null) return i + 1;
  return 0;
}

function syncTab(sheet, spec, rows) {
  const width = spec.headers.length;
  const incoming = new Map();
  rows.forEach((r) => {
    if (Array.isArray(r) && r.length === width && r[0] !== '' && r[0] != null) incoming.set(normId(r[0]), toCells(spec, r));
  });

  // Keep the sheet's current order: update rows that still exist, drop removed ones, append new ones.
  const used = Math.max(1, lastIdRow(sheet));
  const existing = used > 1 ? sheet.getRange(2, 1, used - 1, 1).getValues().map((r) => normId(r[0])) : [];
  const out = [];
  const seen = new Set();
  existing.forEach((id) => {
    if (incoming.has(id) && !seen.has(id)) {
      out.push(incoming.get(id));
      seen.add(id);
    }
  });
  incoming.forEach((row, id) => {
    if (!seen.has(id)) out.push(row);
  });

  const needed = out.length + 1 - sheet.getMaxRows();
  if (needed > 0) sheet.insertRowsAfter(sheet.getMaxRows(), needed);
  if (out.length) {
    const format = (names, fmt) => (names || []).forEach((h) => {
      sheet.getRange(2, spec.headers.indexOf(h) + 1, out.length, 1).setNumberFormat(fmt);
    });
    format(spec.dates, DATE_FORMAT);
    format(spec.times, TIME_FORMAT);
    format(spec.text, '@');
    sheet.getRange(2, 1, out.length, width).setValues(out);
  }
  // Clear leftover Trackfit cells below (only Trackfit's columns).
  const leftover = used - 1 - out.length;
  if (leftover > 0) sheet.getRange(2 + out.length, 1, leftover, width).clearContent();
  return out.length;
}
