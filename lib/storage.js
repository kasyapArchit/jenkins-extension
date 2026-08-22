const DEFAULTS = {
  settings: {
    baseUrl: '',
    username: '',
    token: '',
    authMode: 'token',   // 'token' = API token via basic auth, 'cookie' = reuse browser session
    pollSeconds: 30,
    notify: true
  },
  pipelines: [],
  runs: []
};

export async function get(key) {
  const res = await chrome.storage.local.get(key);
  return res[key] ?? structuredClone(DEFAULTS[key]);
}

export async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

export const getSettings = () => get('settings');
export const getPipelines = () => get('pipelines');
export const getRuns = () => get('runs');

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await set('settings', next);
  return next;
}

export async function upsertPipeline(pipeline) {
  const list = await getPipelines();
  const i = list.findIndex(p => p.id === pipeline.id);
  if (i >= 0) list[i] = { ...list[i], ...pipeline };
  else list.push(pipeline);
  await set('pipelines', list);
  return list;
}

export async function removePipeline(id) {
  const list = (await getPipelines()).filter(p => p.id !== id);
  await set('pipelines', list);
  return list;
}

export async function movePipeline(id, delta) {
  const list = await getPipelines();
  const i = list.findIndex(p => p.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return list;
  [list[i], list[j]] = [list[j], list[i]];
  await set('pipelines', list);
  return list;
}

// Runs are capped so storage cannot grow without bound.
const MAX_RUNS = 40;

export async function addRun(run) {
  const runs = await getRuns();
  runs.unshift(run);
  await set('runs', runs.slice(0, MAX_RUNS));
  return run;
}

export async function updateRun(id, patch) {
  const runs = await getRuns();
  const i = runs.findIndex(r => r.id === id);
  if (i < 0) return null;
  runs[i] = { ...runs[i], ...patch };
  await set('runs', runs);
  return runs[i];
}

export async function clearFinishedRuns() {
  const runs = (await getRuns()).filter(r => r.state !== 'done' && r.state !== 'error');
  await set('runs', runs);
  return runs;
}
