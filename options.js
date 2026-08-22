import * as store from './lib/store.js';
import * as jenkins from './lib/jenkins.js';
import { BUILD } from './lib/build.js';
import { blockReason, firstBadPattern } from './lib/guard.js';

const $ = id => document.getElementById(id);
const TEXT_FIELDS = ['baseUrl', 'authMode', 'userId', 'token', 'pollSeconds', 'searchDepth'];

let config = await store.getConfig();
for (const f of TEXT_FIELDS) $(f).value = config[f] ?? '';
$('notify').checked = config.notify !== false;
$('denyPatterns').value = (config.denyPatterns || []).join('\n');
toggleTokenFields();
checkPatterns();

$('authMode').addEventListener('change', toggleTokenFields);
$('save').addEventListener('click', save);
$('test').addEventListener('click', test);
$('denyPatterns').addEventListener('input', checkPatterns);
$('denyTest').addEventListener('input', checkPatterns);

function toggleTokenFields() {
  $('token-fields').hidden = $('authMode').value !== 'token';
}

function status(text, kind = '') {
  $('status').textContent = text;
  $('status').className = kind;
}

function collect() {
  return {
    baseUrl: $('baseUrl').value.trim().replace(/\/+$/, ''),
    authMode: $('authMode').value,
    userId: $('userId').value.trim(),
    token: $('token').value,
    pollSeconds: clamp(Number($('pollSeconds').value) || 30, 30, 600),
    searchDepth: clamp(Number($('searchDepth').value) || 3, 1, 6),
    notify: $('notify').checked,
    denyPatterns: readPatterns()
  };
}

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
  const next = collect();
  const bad = firstBadPattern(next.denyPatterns);
  if (bad) {
    return status(`Fix the block pattern ${bad.source} first: ${bad.message}`, 'err');
  }
  if (next.baseUrl && !(await grant(next.baseUrl))) {
    return status('Host permission declined, so requests would be blocked.', 'err');
  }
  config = await store.saveConfig(next);
  $('pollSeconds').value = config.pollSeconds;
  $('searchDepth').value = config.searchDepth;
  await store.clearIndex();   // depth or host may have changed
  await chrome.runtime.sendMessage({ type: 'ensureAlarm' }).catch(() => {});
  status('Saved.', 'ok');
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
