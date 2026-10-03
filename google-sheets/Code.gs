/**
 * Trackfit → Google Sheets bridge.
 *
 * Paste this into the sheet's Apps Script editor (Extensions → Apps Script), run `setup` once,
 * then deploy it as a web app. Full steps: google-sheets/README.md in the Trackfit repo.
 *
 * The app sends a full snapshot of its data. Each tab is matched on its first column (ID):
 * existing rows are updated in place, new ones are appended, and rows the app no longer has
 * (deleted workouts or sessions) are removed. Extra columns you add to the right of the
 * Trackfit columns are left alone.
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
const KEY_PROPERTY = 'TRACKFIT_KEY';

/** Run once from the editor: creates the tabs and prints the key to paste into Trackfit. */
function setup() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty(KEY_PROPERTY);
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '').slice(0, 24);
    props.setProperty(KEY_PROPERTY, key);
  }
  const ss = SpreadsheetApp.getActive();
  Object.keys(TABS).forEach((name) => ensureTab(ss, name));
  const blank = ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) ss.deleteSheet(blank);
  Logger.log('Trackfit key (paste this into Trackfit → Settings → Google Sheets): ' + key);
  return key;
}

/** Run from the editor if the key ever leaks: the app will need the new one. */
function resetKey() {
  PropertiesService.getScriptProperties().deleteProperty(KEY_PROPERTY);
  return setup();
}

function doGet() {
  return json({ ok: true, app: 'trackfit', message: 'Trackfit sheet bridge is running.' });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const key = PropertiesService.getScriptProperties().getProperty(KEY_PROPERTY);
    if (!key) return json({ ok: false, error: 'Run setup in the Apps Script editor first.' });
    if (body.key !== key) return json({ ok: false, error: 'Wrong key. Copy it again from the setup log.' });

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

function syncTab(sheet, spec, rows) {
  const width = spec.headers.length;
  const incoming = new Map();
  rows.forEach((r) => {
    if (Array.isArray(r) && r.length === width && r[0] !== '' && r[0] != null) incoming.set(normId(r[0]), toCells(spec, r));
  });

  // 1. Remove rows the app no longer has, bottom-up so row numbers stay valid.
  let last = sheet.getLastRow();
  if (last > 1) {
    const ids = sheet.getRange(2, 1, last - 1, 1).getValues().map((r) => normId(r[0]));
    if (ids.every((id) => !incoming.has(id))) {
      // Sheets refuses to delete every unfrozen row, so clear them instead.
      sheet.getRange(2, 1, last - 1, sheet.getMaxColumns()).clearContent();
    } else {
      for (let i = ids.length - 1; i >= 0; i--) {
        if (incoming.has(ids[i])) continue;
        let j = i;
        while (j > 0 && !incoming.has(ids[j - 1])) j--;
        sheet.deleteRows(j + 2, i - j + 1);
        i = j;
      }
    }
  }

  // 2. Update existing rows in place, then append new ones.
  last = sheet.getLastRow();
  const existing = last > 1 ? sheet.getRange(2, 1, last - 1, 1).getValues().map((r) => normId(r[0])) : [];
  const seen = new Set(existing);
  const out = existing.map((id) => incoming.get(id));
  incoming.forEach((row, id) => {
    if (!seen.has(id)) out.push(row);
  });
  if (!out.length) return 0;

  const needed = out.length + 1 - sheet.getMaxRows();
  if (needed > 0) sheet.insertRowsAfter(sheet.getMaxRows(), needed);
  const format = (names, fmt) => (names || []).forEach((h) => {
    sheet.getRange(2, spec.headers.indexOf(h) + 1, out.length, 1).setNumberFormat(fmt);
  });
  format(spec.dates, DATE_FORMAT);
  format(spec.times, TIME_FORMAT);
  format(spec.text, '@');
  sheet.getRange(2, 1, out.length, width).setValues(out);
  return out.length;
}
