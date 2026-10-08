import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
const local = { token: 'expired', runs: [] };
const sync = {
  config: { baseUrl: 'https://ci.test', authMode: 'token', userId: 'user' },
  subscriptions: [{ id: 'a', url: 'https://ci.test/job/a' }, { id: 'b', url: 'https://ci.test/job/b' }],
};
const area = data => ({
  async get(key) { return { [key]: data[key] }; },
  async set(patch) { Object.assign(data, patch); },
  async remove(key) { delete data[key]; },
});
let onMessage;
const event = { addListener() {} };
globalThis.chrome = {
  storage: { local: area(local), sync: area(sync) },
  runtime: { onInstalled: event, onStartup: event, onMessage: { addListener(fn) { onMessage = fn; } } },
  alarms: { create() {}, onAlarm: event },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
};
let calls = 0;
let status = 401;
globalThis.fetch = async () => {
  calls++;
  return new Response(status === 200 ? '{"lastBuild":null}' : 'rejected', { status });
};
const poll = () => new Promise(resolve => onMessage({ type: 'poll' }, {}, resolve));
await import('../background.js?first');
assert.equal((await poll()).ok, true);
assert.equal(calls, 1, 'first rejection stops the remaining subscriptions');
await poll();
assert.equal(calls, 1, 'next poll sends no requests');
await import('../background.js?restart');
await poll();
assert.equal(calls, 1, 'pause survives worker restart');
sync.config.notify = false;
await poll();
assert.equal(calls, 1, 'unrelated settings do not resume rejected credentials');
local.token = 'replacement';
status = 200;
await poll();
assert.equal(calls, 3, 'changed token resumes both subscriptions');
assert.equal(await (await import('../lib/auth.js')).isAuthBlocked({ ...sync.config, token: local.token }), false);
local.runs = [{ id: 'run', status: 'RUNNING', url: 'https://ci.test/job/a/1', startedAt: Date.now() }];
status = 401;
await poll();
assert.equal(calls, 4, 'run rejection stops all remaining requests');
assert.equal(local.runs[0].status, 'RUNNING', 'paused run can resume after credentials change');
await poll();
assert.equal(calls, 4, 'next poll sends no requests');
local.token = 'third';
status = 403;
await poll();
assert.equal(local.runs[0].status, 'ERROR', 'a 403 on one run fails that run only');
assert.equal(calls, 7, 'a 403 does not stop the subscriptions');
await poll();
assert.equal(calls, 9, 'a 403 does not block later polls');
console.log('all polling auth assertions passed');
