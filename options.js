import * as store from './lib/store.js';
import * as jenkins from './lib/jenkins.js';
import { BUILD } from './lib/build.js';
import { blockReason, firstBadPattern } from './lib/guard.js';
import { NOTIFY_ON_DEFAULTS } from './lib/watch.js';

const $ = id => document.getElementById(id);
const TEXT_FIELDS = ['baseUrl', 'authMode', 'userId', 'token', 'pollSeconds', 'searchDepth'];

let config = await store.getConfig();
for (const f of TEXT_FIELDS) $(f).value = config[f] ?? '';
$('notify').checked = config.notify !== false;
$('notifyStale').checked = config.notifyStale === true;
$('denyPatterns').value = (config.denyPatterns || []).join('\n');

const NOTIFY_ON = { triggered: 'on-triggered', deployed: 'on-deployed', failed: 'on-failed' };
const savedOn = { ...NOTIFY_ON_DEFAULTS, ...(config.notifyOn || {}) };
for (const [key, id] of Object.entries(NOTIFY_ON)) $(id).checked = Boolean(savedOn[key]);

toggleTokenFields();
checkPatterns();
lockLastNotifyKind();

$('authMode').addEventListener('change', toggleTokenFields);
$('save').addEventListener('click', save);
$('test').addEventListener('click', test);
$('denyTest').addEventListener('input', checkPatterns);

// Which fieldset each control reports into, so the confirmation lands beside it.
const AUTOSAVED = {
  tracking: ['pollSeconds', 'notify'],
  subs: ['on-triggered', 'on-deployed', 'on-failed', 'notifyStale'],
  search: ['searchDepth'],
  deny: ['denyPatterns']
};
for (const [fieldset, ids] of Object.entries(AUTOSAVED)) {
  for (const id of ids) {
    $(id).addEventListener('input', () => autosave(fieldset));
    $(id).addEventListener('change', () => autosave(fieldset));
  }
}
$('denyPatterns').addEventListener('input', checkPatterns);
for (const id of Object.values(NOTIFY_ON)) {
  $(id).addEventListener('change', lockLastNotifyKind);
}

// A subscription that announces nothing is a subscription that does nothing, so
// the last box still ticked is disabled rather than validated on save. Nothing
// to read, nothing to undo: it simply will not come off.
function lockLastNotifyKind() {
  const boxes = Object.values(NOTIFY_ON).map($);
  const on = boxes.filter(b => b.checked);
  for (const b of boxes) b.disabled = on.length === 1 && b.checked;
}

function toggleTokenFields() {
  $('token-fields').hidden = $('authMode').value !== 'token';
}

function status(text, kind = '') {
  $('status').textContent = text;
  $('status').className = kind;
}

// Two groups, because they behave differently. The connection cannot save
// itself: writing it also asks Chrome for host permission, which is only
// allowed from a click. Everything else is a preference and saves as you
// change it, which is what the page looked like it was doing anyway.
function collectConnection() {
  return {
    baseUrl: $('baseUrl').value.trim().replace(/\/+$/, ''),
    authMode: $('authMode').value,
    userId: $('userId').value.trim(),
    token: $('token').value
  };
}

function collectPreferences() {
  return {
    pollSeconds: clamp(Number($('pollSeconds').value) || 30, 30, 600),
    searchDepth: clamp(Number($('searchDepth').value) || 3, 1, 6),
    notify: $('notify').checked,
    notifyStale: $('notifyStale').checked,
    notifyOn: Object.fromEntries(
      Object.entries(NOTIFY_ON).map(([key, id]) => [key, $(id).checked])),
    denyPatterns: readPatterns()
  };
}

const collect = () => ({ ...collectConnection(), ...collectPreferences() });

// Blank lines are dropped rather than kept as empty patterns, which would match
// everything and block the entire controller.
//
// A declaration, not a const: the first validation runs while the module is
// still evaluating, above this line, and a const would still be in its temporal
// dead zone there. That throws at import and leaves the whole page unwired.
function readPatterns() {
  return $('denyPatterns').value.split('\n').map(line => line.trim()).filter(Boolean);
}

// Runs on every keystroke, so a broken pattern is caught while it is being
// typed rather than on save, and the test box says what the rules would do
// before they are ever in force.
function checkPatterns() {
  const patterns = readPatterns();
  const bad = firstBadPattern(patterns);
  const out = $('deny-status');

  if (bad) {
    out.textContent = `Not a usable pattern: ${bad.source} — ${bad.message}`;
    out.className = 'hint err';
  } else if (!patterns.length) {
    out.textContent = 'No patterns. Only pipelines you have padlocked are blocked.';
    out.className = 'hint';
  } else {
    out.textContent = `${patterns.length} pattern${patterns.length > 1 ? 's' : ''}, all usable.`;
    out.className = 'hint ok';
  }

  const path = $('denyTest').value.trim();
  const result = $('deny-test-result');
  if (!path) { result.textContent = ''; result.className = 'hint'; return; }

  // Given an id no padlock could match, so the answer is about the patterns
  // alone rather than about anything blocked by hand.
  const reason = blockReason({ id: '\u0000none', fullName: path }, { patterns });
  result.textContent = reason
    ? `${path} would be ${reason}.`
    : `${path} would be allowed to run.`;
  result.className = reason ? 'hint err' : 'hint ok';
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

async function grant(baseUrl) {
  return chrome.permissions.request({ origins: [jenkins.originOf(baseUrl)] });
}

async function save() {
  const next = collectConnection();
  if (next.baseUrl && !(await grant(next.baseUrl))) {
    return status('Host permission declined, so requests would be blocked.', 'err');
  }
  try {
    config = await store.saveConfig(next);
  } catch (err) {
    // A refused write used to end up in an unhandled rejection while the page
    // still said Saved. Anything that does not persist should say why.
    return status(`Chrome refused to store the settings: ${err.message}`, 'err');
  }
  await store.clearIndex();   // the host may have changed
  status('Saved.', 'ok');
}

/* ---------- preferences, saved as they change ---------- */

let pending = null;

// Debounced, because the text and number fields fire on every keystroke and
// each save is a sync write. Checkboxes come through the same path; 350ms of
// lag on a click is not noticeable and keeps one code path.
function autosave(fieldset) {
  clearTimeout(pending);
  pending = setTimeout(() => writePreferences(fieldset), 350);
}

async function writePreferences(fieldset) {
  const next = collectPreferences();

  // A pattern that will not compile is not written at all. Saving it would mean
  // storing a rule the guard silently skips, which reads as "blocking is
  // broken" rather than "that line is wrong".
  const bad = firstBadPattern(next.denyPatterns);
  if (bad) return flash(fieldset, 'Not saved while a pattern is broken.', 'err');

  try {
    config = await store.saveConfig(next);
  } catch (err) {
    return flash(fieldset, `Chrome refused to store this: ${err.message}`, 'err');
  }

  await store.clearIndex();   // search depth may have changed
  await chrome.runtime.sendMessage({ type: 'ensureAlarm' }).catch(() => {});
  flash(fieldset, 'Saved.', 'ok');
}

// Confirmation next to the thing that changed, not at the top of the page. The
// whole bug this replaces was a Save button too far from what it saved.
const flashTimers = new Map();

function flash(fieldset, text, kind) {
  const out = $(`${fieldset}-saved`);
  if (!out) return;
  out.textContent = text;
  out.className = `hint autosave ${kind}`;
  clearTimeout(flashTimers.get(fieldset));
  flashTimers.set(fieldset, setTimeout(() => {
    out.textContent = 'Saves automatically.';
    out.className = 'hint autosave';
  }, kind === 'ok' ? 2000 : 6000));
}

// Two checks, because they can disagree and that difference is the whole point.
// The first uses the values currently in this form. The second asks the service
// worker, which is what actually runs a build: stored config, its own copy of
// the client. A green form check with a red worker check means the settings were
// never saved, or Chrome is running a stale background script.
async function test() {
  const candidate = collect();
  if (!candidate.baseUrl) return status('Enter a base URL first.', 'err');
  if (!(await grant(candidate.baseUrl))) return status('Host permission declined.', 'err');

  status('Checking\u2026');

  let form;
  try {
    const me = await jenkins.whoAmI(candidate);
    form = (me.id && me.id !== 'anonymous')
      ? { ok: true, who: me.fullName || me.id }
      : { ok: false, error: 'Reached Jenkins but you are anonymous. Check the token.' };
  } catch (err) {
    form = { ok: false, error: err.message };
  }

  const worker = await chrome.runtime.sendMessage({ type: 'diagnose' })
    .then(r => (r?.ok ? r.data : { ok: false, error: r?.error || 'The service worker did not answer.' }))
    .catch(err => ({ ok: false, error: err.message }));

  report(candidate, form, worker);
}

function report(candidate, form, worker) {
  if (worker.clientBuild !== BUILD) {
    return status(
      'The background script is running older code than this page. Open chrome://extensions, '
      + 'toggle Jenkins Launcher off and on, then test again.', 'err');
  }

  if (!form.ok) return status(form.error, 'err');

  if (!worker.ok) {
    if (!worker.hasToken || !worker.userId) {
      return status('These credentials work, but nothing is saved yet. Press Save, then test again.', 'err');
    }
    return status(`These credentials work, but a build would fail: ${worker.error}`, 'err');
  }

  if (worker.userId !== candidate.userId || worker.baseUrl !== candidate.baseUrl) {
    return status(`Connected as ${form.who}, but the saved settings differ from this form. Press Save.`, 'err');
  }

  status(`Connected as ${worker.who}. Builds will run as this account.`, 'ok');
}
