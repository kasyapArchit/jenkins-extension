import * as store from './lib/store.js';
import * as jenkins from './lib/jenkins.js';

const ALARM = 'poll-runs';
const GIVE_UP_MS = 3 * 60 * 60 * 1000;   // stop chasing a run after three hours

chrome.runtime.onInstalled.addListener(async () => {
  await store.migrate();
  await ensureAlarm();
});
chrome.runtime.onStartup.addListener(ensureAlarm);

async function ensureAlarm() {
  const { pollSeconds } = await store.getConfig();
  chrome.alarms.create(ALARM, { periodInMinutes: Math.max(0.5, (pollSeconds || 30) / 60) });
}

chrome.alarms.onAlarm.addListener(a => { if (a.name === ALARM) pollAll(); });

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  handle(msg)
    .then(data => respond({ ok: true, data }))
    .catch(err => respond({ ok: false, error: err.message || String(err) }));
  return true;   // keep the channel open for the async reply
});

async function handle(msg) {
  switch (msg.type) {
    case 'trigger':     return trigger(msg.pipelineId, msg.params, msg.persist, msg.job);
    case 'diagnose':    return diagnose();
    case 'poll':        return pollAll();
    case 'ensureAlarm': return ensureAlarm();
    default: throw new Error(`Unknown message: ${msg.type}`);
  }
}

// Reports what a build would actually use: the stored config, read by this
// service worker, through this copy of the Jenkins client.
async function diagnose() {
  const config = await store.getConfig();
  const out = {
    clientBuild: jenkins.CLIENT_BUILD,
    version: chrome.runtime.getManifest().version,
    baseUrl: config.baseUrl,
    userId: config.userId,
    authMode: config.authMode,
    hasToken: Boolean(config.token)
  };
  try {
    const me = await jenkins.whoAmI(config);
    out.ok = Boolean(me.id) && me.id !== 'anonymous';
    out.who = me.fullName || me.id;
  } catch (err) {
    out.ok = false;
    out.error = err.message;
  }
  return out;
}

// `job` lets search trigger a pipeline that was never starred. Starred entries
// still win, so a starred pipeline keeps its own name and saved values.
async function trigger(pipelineId, params, persist, job) {
  const config = await store.getConfig();
  const entry = (await store.getStarred()).find(p => p.id === pipelineId);
  const pipeline = entry || job;
  if (!pipeline?.url) throw new Error('That pipeline is no longer available.');

  const queueUrl = await jenkins.triggerBuild(pipeline.url, params, config);

  await store.setParamValues(pipelineId, persist ?? params);
  // Guard the star write: store.star upserts, so calling it unconditionally
  // would silently star every pipeline run from search.
  if (entry) await store.star({ id: pipelineId, lastRunAt: Date.now() });

  const run = await store.addRun({
    id: `${pipelineId}::${Date.now()}`,
    jobId: pipelineId,
    name: pipeline.name,
    jobUrl: pipeline.url,
    queueUrl,
    url: null,
    build: null,
    status: queueUrl ? 'QUEUED' : 'RUNNING',
    startedAt: Date.now(),
    finishedAt: null,
    error: null
  });

  await ensureAlarm();
  pollAll();
  return run;
}

let polling = false;

async function pollAll() {
  if (polling) return;
  polling = true;
  try {
    const config = await store.getConfig();
    for (const run of (await store.getRuns()).filter(store.isActive)) {
      if (Date.now() - run.startedAt > GIVE_UP_MS) {
        await store.updateRun(run.id, {
          status: 'ERROR', error: 'Stopped tracking after three hours.', finishedAt: Date.now()
        });
        continue;
      }
      try {
        await advance(run, config);
      } catch (err) {
        // A network blip should not kill a run we are still tracking. Only give
        // up on errors that will not fix themselves.
        if (err.kind === 'network') continue;
        await store.updateRun(run.id, { status: 'ERROR', error: err.message, finishedAt: Date.now() });
      }
    }
    await refreshBadge();
  } finally {
    polling = false;
  }
}

async function advance(run, config) {
  if (run.status === 'QUEUED' && run.queueUrl) {
    const item = await jenkins.getQueueItem(run.queueUrl, config);
    if (item.cancelled) {
      await store.updateRun(run.id, { status: 'ABORTED', finishedAt: Date.now() });
      return;
    }
    if (item.executable) {
      await store.updateRun(run.id, {
        status: 'RUNNING', url: item.executable.url, build: item.executable.number,
        buildStartedAt: Date.now(), why: null
      });
      return;
    }
    await store.updateRun(run.id, { why: item.why || null });
    return;
  }

  if (run.status === 'RUNNING' && run.url) {
    const build = await jenkins.getBuild(run.url, config);
    if (build.building) {
      await store.updateRun(run.id, {
        estimatedDuration: build.estimatedDuration,
        buildStartedAt: build.timestamp || run.buildStartedAt
      });
      return;
    }
    const status = build.result || 'UNKNOWN';
    await store.updateRun(run.id, { status, finishedAt: Date.now() });
    await announce({ ...run, status }, config);
  }
}

async function announce(run, config) {
  if (config.notify === false) return;
  chrome.notifications.create(`${run.id}::done`, {
    type: 'basic',
    iconUrl: 'icons/128-mark.png',
    title: `${run.name}${run.build ? ` #${run.build}` : ''} ${run.status}`,
    message: run.status === 'SUCCESS' ? 'Build finished successfully.' : `Build finished: ${run.status}`,
    priority: run.status === 'SUCCESS' ? 0 : 2
  });
}

chrome.notifications?.onClicked.addListener(async id => {
  const run = (await store.getRuns()).find(r => `${r.id}::done` === id);
  if (run?.url) chrome.tabs.create({ url: run.url });
});

async function refreshBadge() {
  const runs = await store.getRuns();
  const active = runs.filter(store.isActive).length;
  const bad = runs.some(r => !store.isActive(r) && r.status !== 'SUCCESS');
  await chrome.action.setBadgeText({ text: active ? String(active) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: bad ? '#c0392b' : '#2f6fdb' });
}

ensureAlarm();
