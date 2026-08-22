import * as store from './lib/store.js';
import * as jenkins from './lib/jenkins.js';

const $ = id => document.getElementById(id);
const TEXT_FIELDS = ['baseUrl', 'authMode', 'userId', 'token', 'pollSeconds', 'searchDepth'];

let config = await store.getConfig();
for (const f of TEXT_FIELDS) $(f).value = config[f] ?? '';
$('notify').checked = config.notify !== false;
toggleTokenFields();

$('authMode').addEventListener('change', toggleTokenFields);
$('save').addEventListener('click', save);
$('test').addEventListener('click', test);

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
    notify: $('notify').checked
  };
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

async function grant(baseUrl) {
  return chrome.permissions.request({ origins: [jenkins.originOf(baseUrl)] });
}

async function save() {
  const next = collect();
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

async function test() {
  const candidate = collect();
  if (!candidate.baseUrl) return status('Enter a base URL first.', 'err');
  if (!(await grant(candidate.baseUrl))) return status('Host permission declined.', 'err');

  status('Checking…');
  try {
    const me = await jenkins.whoAmI(candidate);
    if (!me.id || me.id === 'anonymous') {
      return status('Reached Jenkins but you are anonymous. Check the token.', 'err');
    }
    const jobs = await jenkins.fetchJobIndex(candidate).catch(() => null);
    const count = jobs ? ` · ${jobs.length} pipelines visible` : '';
    status(`Connected as ${me.fullName || me.id}${count}.`, 'ok');
  } catch (err) {
    status(err.message, 'err');
  }
}
