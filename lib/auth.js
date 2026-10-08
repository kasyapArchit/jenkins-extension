// Shared by extension pages and the worker. Only digests are persisted.
// Several are kept so testing other credentials in settings cannot push the
// saved, rejected ones out of the list and let polling resume with them.
const KEY = 'pollingAuthFailure';
const MAX_BLOCKED = 10;
let fallbackFailures = [];
let pending = Promise.resolve();
export async function credentialKey(config) {
  const bytes = new TextEncoder().encode(JSON.stringify([
    config.baseUrl, config.authMode, config.userId, config.token,
  ]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
async function readFailures() {
  if (!globalThis.chrome?.storage?.local) return fallbackFailures;
  const stored = (await chrome.storage.local.get(KEY))[KEY];
  // Older builds stored a single digest.
  return Array.isArray(stored) ? stored : stored ? [stored] : [];
}
async function writeFailures(list) {
  if (!globalThis.chrome?.storage?.local) fallbackFailures = list;
  else if (list.length) await chrome.storage.local.set({ [KEY]: list });
  else await chrome.storage.local.remove(KEY);
}
// Cookie mode sends no credentials, so it cannot count towards a lockout, and
// logging back in to Jenkins would not change the digest to release a block.
export async function isAuthBlocked(config) {
  if (config.authMode !== 'token') return false;
  return (await readFailures()).includes(await credentialKey(config));
}
export async function rejectAuth(config) {
  if (config.authMode !== 'token') return;
  const failure = await credentialKey(config);
  const list = await readFailures();
  if (list.includes(failure)) return;
  await writeFailures([...list, failure].slice(-MAX_BLOCKED));
}
export async function clearAuthFailure(config) {
  const failure = await credentialKey(config);
  const list = await readFailures();
  if (!list.includes(failure)) return;
  await writeFailures(list.filter(f => f !== failure));
}
// Serialize requests across pages and the worker so concurrent startup requests
// cannot keep sending credentials after the first rejection.
export function withAuthLock(fn) {
  if (globalThis.navigator?.locks) return navigator.locks.request('jenkins-auth', fn);
  const result = pending.then(fn);
  pending = result.catch(() => {});
  return result;
}
