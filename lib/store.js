// Storage layout follows the design handoff, with one deliberate exception:
// the API token lives in chrome.storage.local, not sync. Sync uploads to
// Google's servers and propagates to every Chrome profile signed into the
// same account, which is the wrong place for a Jenkins credential. Everything
// else in `config` syncs as specified.

const CONFIG_DEFAULTS = {
  baseUrl: '',
  authMode: 'token',      // 'token' = API token via basic auth, 'cookie' = browser session
  userId: '',
  pollSeconds: 30,
  notify: true,
  searchDepth: 3          // how many folder levels the job index walks
};

const listeners = new Set();

/* ---------- low level ---------- */

async function readArea(area, key, fallback) {
  const res = await chrome.storage[area].get(key);
  return res[key] ?? fallback;
}

const writeArea = (area, key, value) => chrome.storage[area].set({ [key]: value });

/* ---------- config ---------- */

export async function getConfig() {
  const [config, token] = await Promise.all([
    readArea('sync', 'config', {}),
    readArea('local', 'token', '')
  ]);
  return { ...CONFIG_DEFAULTS, ...config, token };
}

export async function saveConfig(patch) {
  const current = await getConfig();
  const { token, ...rest } = { ...current, ...patch };
  await Promise.all([
    writeArea('sync', 'config', rest),
    writeArea('local', 'token', token ?? '')
  ]);
  return { ...rest, token: token ?? '' };
}

/* ---------- starred pipelines ---------- */
// [ { id, fullName, name, folder, url, params: [def], lastRunAt } ] — order is the display order.

export const getStarred = () => readArea('sync', 'starred', []);

export async function isStarred(id) {
  return (await getStarred()).some(p => p.id === id);
}

export async function star(pipeline) {
  const list = await getStarred();
  const i = list.findIndex(p => p.id === pipeline.id);
  if (i >= 0) list[i] = { ...list[i], ...pipeline };
  else list.push(pipeline);
  await writeArea('sync', 'starred', list);
  return list;
}

export async function unstar(id) {
  const list = (await getStarred()).filter(p => p.id !== id);
  await Promise.all([writeArea('sync', 'starred', list), clearParamValues(id)]);
  return list;
}

export async function setOrder(ids) {
  const list = await getStarred();
  const byId = new Map(list.map(p => [p.id, p]));
  const ordered = ids.map(id => byId.get(id)).filter(Boolean);
  // Anything the caller forgot keeps its place at the end rather than vanishing.
  for (const p of list) if (!ids.includes(p.id)) ordered.push(p);
  await writeArea('sync', 'starred', ordered);
  return ordered;
}

/* ---------- parameter values ---------- */
// { [jobId]: { KEY: value } }

export const getAllParamValues = () => readArea('sync', 'paramValues', {});

export async function getParamValues(jobId) {
  return (await getAllParamValues())[jobId] || {};
}

export async function setParamValues(jobId, values) {
  const all = await getAllParamValues();
  all[jobId] = values;
  await writeArea('sync', 'paramValues', all);
  return values;
}

async function clearParamValues(jobId) {
  const all = await getAllParamValues();
  if (!(jobId in all)) return;
  delete all[jobId];
  await writeArea('sync', 'paramValues', all);
}

/* ---------- runs ---------- */
// { id, jobId, name, build, url, queueUrl, status, startedAt, finishedAt, error, why }
// status: QUEUED | RUNNING | SUCCESS | FAILURE | UNSTABLE | ABORTED | ERROR

// Built here rather than inline in the service worker: this shape is read by the
// popup, and the params field was once lost in a rewrite of background.js with
// nothing to catch it.
export function newRun({ jobId, name, fullName, jobUrl, queueUrl, params, now = Date.now() }) {
  return {
    id: `${jobId}::${now}`,
    jobId,
    name,
    fullName: fullName ?? null,
    jobUrl,
    queueUrl: queueUrl ?? null,
    url: null,
    build: null,
    displayName: null,
    status: queueUrl ? 'QUEUED' : 'RUNNING',
    params: params ?? {},
    startedAt: now,
    finishedAt: null,
    error: null
  };
}

const MAX_RUNS = 40;
export const RUNNING_STATES = ['QUEUED', 'RUNNING'];
export const isActive = run => RUNNING_STATES.includes(run.status);

export const getRuns = () => readArea('local', 'runs', []);

export async function addRun(run) {
  const runs = await getRuns();
  runs.unshift(run);
  await writeArea('local', 'runs', runs.slice(0, MAX_RUNS));
  return run;
}

export async function updateRun(id, patch) {
  const runs = await getRuns();
  const i = runs.findIndex(r => r.id === id);
  if (i < 0) return null;
  runs[i] = { ...runs[i], ...patch };
  await writeArea('local', 'runs', runs);
  return runs[i];
}

export async function dismissRun(id) {
  const runs = (await getRuns()).filter(r => r.id !== id);
  await writeArea('local', 'runs', runs);
  return runs;
}

/* ---------- job index cache ---------- */
// Session storage so the list is rebuilt once per browser session, not per popup open.

const INDEX_KEY = 'jobIndex';

export async function getCachedIndex(maxAgeMs = 10 * 60 * 1000) {
  const hit = await readArea('session', INDEX_KEY, null);
  if (!hit || Date.now() - hit.at > maxAgeMs) return null;
  return hit.jobs;
}

export const cacheIndex = jobs => writeArea('session', INDEX_KEY, { at: Date.now(), jobs });
export const clearIndex = () => chrome.storage.session.remove(INDEX_KEY);

/* ---------- change notification ---------- */

export function onChange(fn) {
  if (!listeners.size) chrome.storage.onChanged.addListener(dispatch);
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function dispatch(changes, area) {
  for (const fn of listeners) fn(changes, area);
}

/* ---------- migration from the pre-redesign layout ---------- */

export async function migrate() {
  const old = await chrome.storage.local.get(['settings', 'pipelines']);
  if (!old.settings && !old.pipelines) return false;

  if (old.settings) {
    const s = old.settings;
    await saveConfig({
      baseUrl: s.baseUrl || '',
      authMode: s.authMode || 'token',
      userId: s.username || '',
      token: s.token || '',
      pollSeconds: s.pollSeconds || 30,
      notify: s.notify !== false
    });
  }

  if (Array.isArray(old.pipelines) && old.pipelines.length) {
    const starred = [];
    const values = await getAllParamValues();
    for (const p of old.pipelines) {
      starred.push({
        id: p.id,
        url: p.url,
        name: p.name,
        fullName: p.fullName || p.name,
        folder: p.fullName || '',
        params: p.params || [],
        lastRunAt: p.lastTriggeredAt || null
      });
      if (p.lastValues && Object.keys(p.lastValues).length) values[p.id] = p.lastValues;
    }
    await Promise.all([
      writeArea('sync', 'starred', starred),
      writeArea('sync', 'paramValues', values)
    ]);
  }

  // Old runs used a different shape; drop them rather than half-translate.
  await chrome.storage.local.remove(['settings', 'pipelines']);
  await writeArea('local', 'runs', []);
  return true;
}
