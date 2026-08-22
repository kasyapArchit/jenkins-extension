// node test/auth.test.mjs
import { getJson, probe, triggerBuild, JenkinsError, CLIENT_BUILD } from '../lib/jenkins.js';

let failed = 0;
const check = (name, cond) => { if (!cond) { failed++; console.error(`FAIL ${name}`); } };

const TOKEN_CFG = { baseUrl: 'https://ci.test', authMode: 'token', userId: 'a.k', token: 't0ken' };
const stub = handler => { globalThis.fetch = handler; };
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/* A missing token must fail loudly, not send an unauthenticated request. */
{
  let called = false;
  stub(async () => { called = true; return json({}); });
  let err = null;
  try {
    await getJson('https://ci.test/api/json', { ...TOKEN_CFG, token: '' });
  } catch (e) { err = e; }
  check('missing token throws', err instanceof JenkinsError);
  check('missing token is an auth error', err?.kind === 'auth');
  check('missing token mentions saving', /Save/.test(err?.message || ''));
  check('missing token never hits the network', called === false);
}

{
  let err = null;
  stub(async () => json({}));
  try { await getJson('https://ci.test/api/json', { ...TOKEN_CFG, userId: '' }); } catch (e) { err = e; }
  check('missing user id throws', err?.kind === 'auth');
}

/* A present token is sent as basic auth. */
{
  let seen = null;
  stub(async (_u, init) => { seen = init.headers.Authorization; return json({ id: 'a.k' }); });
  await getJson('https://ci.test/api/json', TOKEN_CFG);
  check('sends basic auth', seen === 'Basic ' + btoa('a.k:t0ken'));
}

/* Cookie mode sends no Authorization header and does not demand a token. */
{
  let seen = 'unset';
  stub(async (_u, init) => { seen = init.headers.Authorization; return json({ id: 'a.k' }); });
  await getJson('https://ci.test/api/json', { baseUrl: 'https://ci.test', authMode: 'cookie' });
  check('cookie mode sends no auth header', seen === undefined);
}

/* probe() maps failures to the three header states and never throws. */
{
  stub(async () => json({ id: 'a.k', fullName: 'A K' }));
  check('probe online', await probe(TOKEN_CFG) === 'online');

  stub(async () => json({ id: 'anonymous' }));
  check('probe anonymous is unauthorized', await probe(TOKEN_CFG) === 'unauthorized');

  stub(async () => new Response('nope', { status: 401 }));
  check('probe 401 is unauthorized', await probe(TOKEN_CFG) === 'unauthorized');

  stub(async () => { throw new TypeError('Failed to fetch'); });
  check('probe network failure is offline', await probe(TOKEN_CFG) === 'offline');

  stub(async () => json({}));
  check('probe with no base url is offline', await probe({ ...TOKEN_CFG, baseUrl: '' }) === 'offline');

  // A missing token now throws inside request; probe must still classify it.
  stub(async () => json({ id: 'a.k' }));
  check('probe with no token is unauthorized', await probe({ ...TOKEN_CFG, token: '' }) === 'unauthorized');
}

/* triggerBuild posts form-encoded params and returns the queue URL. */
{
  let seen = null;
  stub(async (url, init) => {
    seen = { url, body: init.body, method: init.method };
    return new Response('', { status: 201, headers: { Location: 'https://ci.test/queue/item/91/' } });
  });
  const queue = await triggerBuild('https://ci.test/job/A', { BRANCH: 'develop', CLEAN: true }, TOKEN_CFG);
  check('posts to buildWithParameters', seen.url === 'https://ci.test/job/A/buildWithParameters');
  check('posts form body', seen.body === 'BRANCH=develop&CLEAN=true');
  check('returns queue url', queue === 'https://ci.test/queue/item/91/');
}

{
  stub(async url => {
    if (url.endsWith('/build')) return new Response('', { status: 201, headers: { Location: 'https://ci.test/queue/item/92/' } });
    throw new Error('wrong endpoint: ' + url);
  });
  await triggerBuild('https://ci.test/job/A', {}, TOKEN_CFG);
  check('no params uses /build', true);
}

check('client build stamp is set', typeof CLIENT_BUILD === 'string' && CLIENT_BUILD.length > 0);

console.log(failed ? `${failed} failing` : 'all auth assertions passed');
process.exit(failed ? 1 : 0);
