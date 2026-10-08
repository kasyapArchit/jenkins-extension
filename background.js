import { isAuthBlocked } from "./lib/auth.js";
import * as store from "./lib/store.js";
import * as jenkins from "./lib/jenkins.js";
import { BUILD } from "./lib/build.js";
import { qualifiedName, buildLabel } from "./lib/format.js";
import { blockReason } from "./lib/guard.js";
import { nextEvent, eventTime, isStale, wants } from "./lib/watch.js";

const ALARM = "poll-runs";
const GIVE_UP_MS = 3 * 60 * 60 * 1000; // stop chasing a run after three hours

chrome.runtime.onInstalled.addListener(async () => {
  await store.migrate();
  await ensureAlarm();
});
chrome.runtime.onStartup.addListener(ensureAlarm);

async function ensureAlarm() {
  const { pollSeconds } = await store.getConfig();
  chrome.alarms.create(ALARM, {
    periodInMinutes: Math.max(0.5, (pollSeconds || 30) / 60),
  });
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) pollAll();
});

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  handle(msg)
    .then((data) => respond({ ok: true, data }))
    .catch((err) => respond({ ok: false, error: err.message || String(err) }));
  return true; // keep the channel open for the async reply
});

async function handle(msg) {
  switch (msg.type) {
    case "trigger":
      return trigger(
        msg.pipelineId,
        msg.params,
        msg.persist,
        msg.job,
        msg.remember !== false,
      );
    case "diagnose":
      return diagnose();
    case "ping":
      return { build: BUILD };
    case "poll":
      return pollAll();
    case "ensureAlarm":
      return ensureAlarm();
    default:
      throw new Error(`Unknown message: ${msg.type}`);
  }
}

// Reports what a build would actually use: the stored config, read by this
// service worker, through this copy of the Jenkins client.
async function diagnose() {
  const config = await store.getConfig();
  const out = {
    clientBuild: BUILD,
    version: chrome.runtime.getManifest().version,
    baseUrl: config.baseUrl,
    userId: config.userId,
    authMode: config.authMode,
    hasToken: Boolean(config.token),
  };
  try {
    const me = await jenkins.whoAmI(config);
    out.ok = Boolean(me.id) && me.id !== "anonymous";
    out.who = me.fullName || me.id;
  } catch (err) {
    out.ok = false;
    out.error = err.message;
  }
  return out;
}

// `job` lets search trigger a pipeline that was never starred. Starred entries
// still win, so a starred pipeline keeps its own name and saved values.
// remember=false is a replay of an old run: it triggers with that run's values
// without adopting them as the pipeline's saved ones, which have probably moved
// on since.
async function trigger(pipelineId, params, persist, job, remember = true) {
  const config = await store.getConfig();
  const entry = (await store.getStarred()).find((p) => p.id === pipelineId);
  const pipeline = entry || job;
  if (!pipeline?.url) throw new Error("That pipeline is no longer available.");

  // Checked here and not only in the popup. The popup swaps its button for one
  // that opens Jenkins, but that is an affordance, not a guard: a stale popup, a
  // replay of an old run, or a message from anywhere else would still arrive
  // here. This is the line the build cannot get past.
  const reason = blockReason(pipeline, {
    blocked: await store.getBlocked(),
    patterns: config.denyPatterns,
  });
  if (reason)
    throw new Error(
      `${qualifiedName(pipeline.fullName, pipeline.name)} is ${reason}.`,
    );

  const queueUrl = await jenkins.triggerBuild(pipeline.url, params, config);

  if (remember) await store.setParamValues(pipelineId, persist ?? params);
  // Guard the star write: store.star upserts, so calling it unconditionally
  // would silently star every pipeline run from search.
  if (entry) await store.star({ id: pipelineId, lastRunAt: Date.now() });

  const run = await store.addRun(
    store.newRun({
      jobId: pipelineId,
      name: pipeline.name,
      fullName: pipeline.fullName ?? null,
      jobUrl: pipeline.url,
      queueUrl,
      params: persist ?? params,
    }),
  );

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
    if (await isAuthBlocked(config)) return;
    for (const run of (await store.getRuns()).filter(store.isActive)) {
      if (Date.now() - run.startedAt > GIVE_UP_MS) {
        await store.updateRun(run.id, {
          status: "ERROR",
          error: "Stopped tracking after three hours.",
          finishedAt: Date.now(),
        });
        continue;
      }
      try {
        await advance(run, config);
      } catch (err) {
        // Stop the entire batch at the first rejected token, including subscriptions.
        if (err.kind === "auth") return;
        // A network blip should not kill a run we are still tracking. Only give
        // up on errors that will not fix themselves.
        if (err.kind === "network") continue;
        await store.updateRun(run.id, {
          status: "ERROR",
          error: err.message,
          finishedAt: Date.now(),
        });
      }
    }
    await pollSubscriptions(config);
    await refreshBadge();
  } finally {
    polling = false;
  }
}

/* ---------- subscriptions ---------- */

// Watches pipelines whoever starts them, which the run list cannot do: it only
// knows about builds this extension asked for.
async function pollSubscriptions(config) {
  const subs = await store.getSubscriptions();
  const marks = await store.getWatch();

  // Marks for pipelines no longer subscribed would otherwise accumulate forever,
  // and a re-subscribe would compare against a stale number and announce a build
  // that finished weeks ago.
  const next = {};
  if (!subs.length) {
    if (Object.keys(marks).length) await store.setWatch(next);
    return;
  }

  // Builds this extension started are already tracked and announced by the run
  // list. Without this a pipeline you both subscribed to and triggered would
  // notify twice for the same build.
  const ours = new Set(
    (await store.getRuns()).map((r) => `${r.jobId}::${r.build}`),
  );

  for (const sub of subs) {
    let build;
    try {
      build = await jenkins.getLastBuild(sub.url, config);
    } catch (err) {
      if (err.kind === "auth") return;
      // Off the VPN, renamed, or permissions changed. Keep the existing mark so
      // reconnecting compares against what we last really saw.
      if (marks[sub.id]) next[sub.id] = marks[sub.id];
      continue;
    }

    const ev = nextEvent(marks[sub.id], build);
    if (!ev) continue;
    next[sub.id] = ev.mark;
    if (ev.kind && !ours.has(`${sub.id}::${build.number}`)) {
      await announceEvent(sub, ev, config);
    }
  }

  await store.setWatch(next);
}

const HEADLINE = { started: "started", deployed: "deployed", failed: "failed" };

async function announceEvent(sub, ev, config) {
  if (config.notify === false) return;
  if (!wants(ev.kind, config.notifyOn)) return;

  const at = eventTime(ev.build, ev.kind);
  if (!config.notifyStale && isStale(at)) return;

  const label = ev.build.displayName?.trim() || `#${ev.build.number}`;
  chrome.notifications.create(`sub::${ev.build.number}::${sub.url}`, {
    type: "basic",
    iconUrl: "icons/128-mark.png",
    title: `${qualifiedName(sub.fullName, sub.name)} ${label} ${HEADLINE[ev.kind]}`,
    message:
      ev.kind === "started"
        ? "A build you subscribe to has started."
        : `A build you subscribe to ${ev.kind === "deployed" ? "finished successfully" : `finished: ${ev.build.result}`}.`,
    priority: ev.kind === "failed" ? 2 : 0,
  });
}

async function advance(run, config) {
  if (run.status === "QUEUED" && run.queueUrl) {
    const item = await jenkins.getQueueItem(run.queueUrl, config);
    if (item.cancelled) {
      await store.updateRun(run.id, {
        status: "ABORTED",
        finishedAt: Date.now(),
      });
      return;
    }
    if (item.executable) {
      await store.updateRun(run.id, {
        status: "RUNNING",
        url: item.executable.url,
        build: item.executable.number,
        buildStartedAt: Date.now(),
        why: null,
      });
      return;
    }
    await store.updateRun(run.id, { why: item.why || null });
    return;
  }

  if (run.status === "RUNNING" && run.url) {
    const build = await jenkins.getBuild(run.url, config);
    // Pipelines rename themselves partway through, so this is re-read on every
    // poll rather than captured once when the build started.
    const version = {
      displayName: build.displayName ?? run.displayName ?? null,
    };

    if (build.building) {
      await store.updateRun(run.id, {
        ...version,
        estimatedDuration: build.estimatedDuration,
        buildStartedAt: build.timestamp || run.buildStartedAt,
      });
      return;
    }
    const status = build.result || "UNKNOWN";
    await store.updateRun(run.id, {
      ...version,
      status,
      finishedAt: Date.now(),
    });
    await announce({ ...run, ...version, status }, config);
  }
}

async function announce(run, config) {
  if (config.notify === false) return;
  chrome.notifications.create(`${run.id}::done`, {
    type: "basic",
    iconUrl: "icons/128-mark.png",
    title:
      `${qualifiedName(run.fullName, run.name)} ${buildLabel(run)} ${run.status}`
        .replace(/\s+/g, " ")
        .trim(),
    message:
      run.status === "SUCCESS"
        ? "Build finished successfully."
        : `Build finished: ${run.status}`,
    priority: run.status === "SUCCESS" ? 0 : 2,
  });
}

chrome.notifications?.onClicked.addListener(async (id) => {
  // Subscription ids carry their own target, since the build was never in the
  // run list to look up. The job URL is last because it contains slashes and
  // colons of its own but never a '::'.
  if (id.startsWith("sub::")) {
    const [, number, ...rest] = id.split("::");
    const jobUrl = rest.join("::");
    if (jobUrl) chrome.tabs.create({ url: `${jobUrl}/${number}` });
    return;
  }
  const run = (await store.getRuns()).find((r) => `${r.id}::done` === id);
  if (run?.url) chrome.tabs.create({ url: run.url });
});

async function refreshBadge() {
  const runs = await store.getRuns();
  const active = runs.filter(store.isActive).length;
  const bad = runs.some((r) => !store.isActive(r) && r.status !== "SUCCESS");
  await chrome.action.setBadgeText({ text: active ? String(active) : "" });
  await chrome.action.setBadgeBackgroundColor({
    color: bad ? "#c0392b" : "#2f6fdb",
  });
}

ensureAlarm();
