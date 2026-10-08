import assert from 'node:assert/strict';
import { getJson, triggerBuild, abortBuild, probe, verifyAuthentication, haltsPolling } from '../lib/jenkins.js';
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

status = 403;
await assert.rejects(triggerBuild('https://ci.test/job/a', {}, config));
status = 200;
await getJson('https://ci.test/api/json', config);
assert.equal(calls, 8, 'a 403 on one job does not block the credentials');

status = 401;
await assert.rejects(getJson('https://ci.test/api/json', config));
assert.equal(calls, 9);
await assert.rejects(verifyAuthentication({ ...config, token: 'typo' }));
assert.equal(calls, 10, 'testing other credentials sends one request');
await assert.rejects(getJson('https://ci.test/api/json', config));
assert.equal(calls, 10, 'saved credentials stay blocked after testing others');

const cookie = { ...config, authMode: 'cookie', token: '' };
await assert.rejects(getJson('https://ci.test/api/json', cookie));
status = 200;
await getJson('https://ci.test/api/json', cookie);
assert.equal(calls, 12, 'cookie mode is never blocked');

state.pollingAuthFailure = await (await import('../lib/auth.js')).credentialKey(config);
await assert.rejects(getJson('https://ci.test/api/json', config));
assert.equal(calls, 12, 'a single digest from an older build is still honoured');

// A logged-out browser session: Jenkins answers 403, not 401.
const reject = (response) => { globalThis.fetch = async () => { calls++; return response(); }; };
reject(() => new Response('denied', { status: 403, headers: { 'X-You-Are-Authenticated-As': 'anonymous' } }));
let err = await triggerBuild('https://ci.test/job/a', {}, cookie).catch(e => e);
assert.match(err.message, /not logged in/, 'anonymous 403 by header reads as logged out');
assert.equal(haltsPolling(err), true, 'logged out stops the whole poll');
assert.equal(await probe(cookie), 'unauthorized');
reject(() => new Response("<meta http-equiv='refresh' content='1;url=/login?from=%2Fjob%2Fa'/>Authentication required", { status: 403 }));
err = await getJson('https://ci.test/api/json', cookie).catch(e => e);
assert.match(err.message, /not logged in/, 'anonymous 403 by login page reads as logged out');
reject(() => new Response('denied', { status: 403, headers: { 'X-You-Are-Authenticated-As': 'user' } }));
err = await triggerBuild('https://ci.test/job/a', {}, cookie).catch(e => e);
assert.match(err.message, /lack Build permission/, 'signed-in 403 still reads as a permission problem');
assert.equal(haltsPolling(err), false, 'a permission 403 does not stop the poll');
reject(() => new Response('{"id":"user"}', { status: 200 }));
assert.equal(await probe(cookie), 'online', 'logging back in resumes without settings');
console.log('all request auth lock assertions passed');
