// Shared by extension pages and the worker. Only a digest is persisted.
const KEY = 'pollingAuthFailure';
let fallbackFailure;
let pending = Promise.resolve();
export async function credentialKey(config) {
  const bytes = new TextEncoder().encode(JSON.stringify([
    config.baseUrl, config.authMode, config.userId, config.token,
  ]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
export async function isAuthBlocked(config) {
  const failure = globalThis.chrome?.storage?.local
    ? (await chrome.storage.local.get(KEY))[KEY] : fallbackFailure;
  return Boolean(failure && failure === await credentialKey(config));
}
export async function rejectAuth(config) {
  const failure = await credentialKey(config);
  if (globalThis.chrome?.storage?.local) await chrome.storage.local.set({ [KEY]: failure });
  else fallbackFailure = failure;
}
export async function clearAuthFailure(config) {
  if (!await isAuthBlocked(config)) return;
  if (globalThis.chrome?.storage?.local) await chrome.storage.local.remove(KEY);
  else fallbackFailure = undefined;
}
// Serialize requests across pages and the worker so concurrent startup requests
// cannot keep sending credentials after the first rejection.
export function withAuthLock(fn) {
  if (globalThis.navigator?.locks) return navigator.locks.request('jenkins-auth', fn);
  const result = pending.then(fn);
  pending = result.catch(() => {});
  return result;
}
