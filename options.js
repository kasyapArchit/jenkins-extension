import * as store from './lib/storage.js';
import * as jenkins from './lib/jenkins.js';

const $ = id => document.getElementById(id);
const FIELDS = ['baseUrl', 'authMode', 'username', 'token', 'pollSeconds'];

let settings = await store.getSettings();
for (const f of FIELDS) $(f).value = settings[f] ?? '';
$('notify').checked = settings.notify !== false;
toggleTokenFields();

$('authMode').addEventListener('change', toggleTokenFields);
$('save').addEventListener('click', save);
$('test').addEventListener('click', test);

function toggleTokenFields() {
  $('token-fields').hidden = $('authMode').value !== 'token';
}

function status(text, kind) {
  const s = $('status');
  s.textContent = text;
  s.className = kind || '';
}

function collect() {
  return {
    baseUrl: $('baseUrl').value.trim().replace(/\/+$/, ''),
    authMode: $('authMode').value,
    username: $('username').value.trim(),
    token: $('token').value,
    pollSeconds: Math.max(30, Number($('pollSeconds').value) || 30),
    notify: $('notify').checked
  };
}

async function save() {
  const next = collect();
  if (next.baseUrl) {
    const granted = await chrome.permissions.request({ origins: [jenkins.originOf(next.baseUrl)] });
    if (!granted) return status('Host permission declined, so requests would be blocked.', 'err');
  }
  settings = await store.saveSettings(next);
  $('pollSeconds').value = settings.pollSeconds;
  await chrome.runtime.sendMessage({ type: 'ensureAlarm' });
  status('Saved.', 'ok');
}

async function test() {
  const candidate = collect();
  if (!candidate.baseUrl) return status('Enter a base URL first.', 'err');
  const granted = await chrome.permissions.request({ origins: [jenkins.originOf(candidate.baseUrl)] });
  if (!granted) return status('Host permission declined.', 'err');

  status('Checking…');
  try {
    const me = await jenkins.whoAmI(candidate);
    if (!me.id || me.id === 'anonymous') {
      return status('Reached Jenkins but you are anonymous. Check the token.', 'err');
    }
    status(`Connected as ${me.fullName || me.id}.`, 'ok');
  } catch (err) {
    status(err.message, 'err');
  }
}
