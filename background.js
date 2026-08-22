import * as store from './lib/storage.js';
import * as jenkins from './lib/jenkins.js';

const ALARM = 'poll-runs';
const GIVE_UP_MS = 3 * 60 * 60 * 1000;   // stop chasing a run after three hours

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);

async function ensureAlarm() {
  const { pollSeconds } = await store.getSettings();
  const minutes = Math.max(0.5, (pollSeconds || 30) / 60);
  chrome.alarms.create(ALARM, { periodInMinutes: minutes });
}

chrome.alarms.onAlarm.addListener(a => {
  if (a.name === ALARM) pollAll();
});

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  handle(msg)
    .then(data => respond({ ok: true, data }))
    .catch(err => respond({ ok: false, error: err.message || String(err) }));
  return true;   // keep the channel open for the async reply
});

async function handle(msg) {
  switch (msg.type) {
    case 'trigger':  return trigger(msg.pipelineId, msg.params, msg.persist);
    case 'poll':     return pollAll();
    case 'ensureAlarm': return ensureAlarm();
    default: throw new Error(`Unknown message: ${msg.type}`);
  }
}

async function trigger(pipelineId, params, persist) {
  const settings = await store.getSettings();
  const pipelines = await store.getPipelines();
  const pipeline = pipelines.find(p => p.id === pipelineId);
  if (!pipeline) throw new Error('That pipeline is no longer saved.');

  const queueUrl = await jenkins.triggerBuild(pipeline.url, params, settings);

  // Remember the values so the next run starts pre-filled.
  await store.upsertPipeline({ id: pipeline.id, lastValues: persist ?? params, lastTriggeredAt: Date.now() });

  const run = await store.addRun({
    id: `${pipelineId}-${Date.now()}`,
    pipelineId,
    pipelineName: pipeline.name,
    jobUrl: pipeline.url,
    queueUrl,
    buildUrl: null,
    number: null,
    state: queueUrl ? 'queued' : 'unknown',
    result: null,
    params: persist ?? params,
    startedAt: Date.now()
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
    const settings = await store.getSettings();
    const runs = await store.getRuns();
    const active = runs.filter(r => r.state === 'queued' || r.state === 'building');
    for (const run of active) {
      if (Date.now() - run.startedAt > GIVE_UP_MS) {
        await store.updateRun(run.id, { state: 'error', error: 'Stopped tracking after three hours.' });
        continue;
      }
      try {
        await advance(run, settings);
      } catch (err) {
        await store.updateRun(run.id, { state: 'error', error: err.message });
      }
    }
    await refreshBadge();
  } finally {
    polling = false;
  }
}

async function advance(run, settings) {
  if (run.state === 'queued' && run.queueUrl) {
    const item = await jenkins.getQueueItem(run.queueUrl, settings);
    if (item.cancelled) {
      await store.updateRun(run.id, { state: 'error', error: 'Cancelled while queued.' });
      return;
    }
    if (item.executable) {
      await store.updateRun(run.id, {
        state: 'building',
        buildUrl: item.executable.url,
        number: item.executable.number
      });
      return;
    }
    await store.updateRun(run.id, { why: item.why || 'Waiting in queue' });
    return;
  }

  if (run.state === 'building' && run.buildUrl) {
    const build = await jenkins.getBuild(run.buildUrl, settings);
    if (build.building) {
      await store.updateRun(run.id, { estimatedDuration: build.estimatedDuration, buildStartedAt: build.timestamp });
      return;
    }
    await store.updateRun(run.id, { state: 'done', result: build.result || 'UNKNOWN' });
    await announce(run, build.result || 'UNKNOWN');
  }
}

async function announce(run, result) {
  const { notify } = await store.getSettings();
  if (!notify) return;
  chrome.notifications.create(`${run.id}-done`, {
    type: 'basic',
    iconUrl: 'icons/128.png',
    title: `${run.pipelineName} #${run.number ?? ''} ${result}`,
    message: result === 'SUCCESS' ? 'Build finished successfully.' : `Build finished: ${result}`,
    priority: result === 'SUCCESS' ? 0 : 2
  });
}

chrome.notifications?.onClicked.addListener(async id => {
  const runId = id.replace(/-done$/, '');
  const run = (await store.getRuns()).find(r => r.id === runId);
  if (run?.buildUrl) chrome.tabs.create({ url: run.buildUrl });
});

async function refreshBadge() {
  const runs = await store.getRuns();
  const active = runs.filter(r => r.state === 'queued' || r.state === 'building').length;
  const failed = runs.some(r => r.state === 'done' && r.result && r.result !== 'SUCCESS');
  await chrome.action.setBadgeText({ text: active ? String(active) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: failed ? '#c0392b' : '#2f6fdb' });
}

ensureAlarm();
