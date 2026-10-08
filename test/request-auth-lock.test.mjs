import assert from 'node:assert/strict';
import { getJson, triggerBuild, abortBuild, probe, verifyAuthentication } from '../lib/jenkins.js';
const state = {};
globalThis.chrome = { storage: { local: {
  async get(key) { return { [key]: state[key] }; },
  async set(patch) { Object.assign(state, patch); },
  async remove(key) { delete state[key]; },
} } };
const config = { baseUrl: 'https://ci.test', authMode: 'token', userId: 'user', token: 'expired' };
let calls = 0;
let status = 401;
globalThis.fetch = async () => {
  calls++;
  return new Response(status === 200 ? '{"id":"user"}' : 'rejected', { status });
};
await Promise.allSettled([
  getJson('https://ci.test/api/json', config),
  triggerBuild('https://ci.test/job/a', {}, config),
  abortBuild('https://ci.test/job/a/1', config),
]);
assert.equal(calls, 1, 'concurrent operations stop after first rejection');
assert.equal(await probe(config), 'unauthorized');
assert.equal(calls, 1, 'connection checks also stay blocked');
const restarted = await import('../lib/jenkins.js?restart');
await assert.rejects(restarted.getJson('https://ci.test/api/json', config));
assert.equal(calls, 1, 'shared stored block applies to another client instance');
await assert.rejects(verifyAuthentication(config));
assert.equal(calls, 2, 'explicit failed verification sends exactly one request');
await assert.rejects(triggerBuild('https://ci.test/job/a', {}, config));
assert.equal(calls, 2, 'failed verification keeps operations blocked');
status = 200;
await verifyAuthentication(config);
await getJson('https://ci.test/api/json', config);
assert.equal(calls, 4, 'successful verification restores requests');
status = 403;
await assert.rejects(getJson('https://ci.test/api/json', config));
status = 200;
await getJson('https://ci.test/api/json', { ...config, token: 'new' });
assert.equal(calls, 6, 'updated credentials permit requests');
console.log('all request auth lock assertions passed');
