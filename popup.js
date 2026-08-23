import * as store from "./lib/store.js";
import * as jenkins from "./lib/jenkins.js";
import { icon } from "./lib/icons.js";
import { BUILD } from "./lib/build.js";
import { $, el, clear, elapsed, ago } from "./lib/dom.js";
import { qualifiedName, buildLabel, normalizeSearchText } from "./lib/format.js";
import { blockReason, isPatternBlock, blockedTitle } from "./lib/guard.js";
import { anyWanted } from "./lib/watch.js";

const MAX_RESULTS = 7;
const SEARCH_DEBOUNCE_MS = 200;

let config = null;
let starred = [];
let paramValues = {};
let blocked = []; // pipeline ids blocked by hand
let subscribed = []; // pipelines being watched whoever starts them
let runs = [];
let index = null; // flat job list, null until loaded
let indexError = null;

// Parameter definitions for jobs that are not starred, so search can trigger
// them without a round trip on every keystroke.
const jobMeta = new Map();

const ui = {
  query: "",
  openId: null,
  openResult: null, // search result whose parameter panel is expanded
  addOpen: false,
  subsOpen: false, // the subscribed-pipelines list under the footer
  connection: "checking", // checking | online | offline | unauthorized
  worker: "ok", // ok | stale | silent
  activeResult: 0,
  justOpened: null, // the one card whose panel should animate on this render
  dragId: null,
  drafts: new Map(), // pipelineId -> { KEY: value } being edited
  busy: new Set(), // pipeline ids mid-trigger
  errors: new Map(), // pipelineId -> message
};

init();

async function init() {
  [config, starred, paramValues, blocked, subscribed, runs] = await Promise.all(
    [
      store.getConfig(),
      store.getStarred(),
      store.getAllParamValues(),
      store.getBlocked(),
      store.getSubscriptions(),
      store.getRuns(),
    ],
  );

  mountChrome();
  renderAll();

  store.onChange(onStorageChanged);
  setInterval(tickElapsed, 1000);

  chrome.runtime.sendMessage({ type: "poll" }).catch(() => {});
  checkWorker();
  refreshConnection();
  warmIndex();
}

// The popup always loads fresh from disk; the service worker may not. When they
// disagree the worker is running code the user already replaced, and every
// symptom after that is a red herring.
async function checkWorker() {
  const res = await chrome.runtime
    .sendMessage({ type: "ping" })
    .catch(() => null);
  if (!res?.ok) ui.worker = "silent";
  else ui.worker = res.data?.build === BUILD ? "ok" : "stale";
  renderBanner();
}

/* ---------- static chrome ---------- */

function mountChrome() {
  $("#refresh").append(icon("refresh-cw"));
  $("#settings").append(icon("settings", { size: 17 }));
  $("#search-icon").append(icon("search", { size: 14 }));
  $("#q-clear").append(icon("x", { size: 13 }));

  $("#settings").addEventListener("click", () =>
    chrome.runtime.openOptionsPage(),
  );
  $("#refresh").addEventListener("click", onRefresh);
  $("#q").addEventListener("input", onQueryInput);
  $("#q").addEventListener("keydown", onSearchKey);
  $("#q-clear").addEventListener("click", clearQuery);
  $("#add-toggle").addEventListener("click", toggleAdd);
  $("#add-btn").addEventListener("click", onAdd);
  $("#add-url").addEventListener("keydown", (e) => {
    if (e.key === "Enter") onAdd();
  });
}

function renderAll() {
  renderHeader();
  renderBanner();
  renderMode();
  renderResults();
  renderActivity();
  renderStarred();
  renderFooter();
}

/* ---------- header and connection ---------- */

function renderHeader() {
  const dot = $("#conn-dot");
  const state = ui.connection;
  dot.className = `conn-dot ${state === "checking" ? "" : state}`;
  dot.title = {
    checking: "Checking the controller…",
    online: "Reachable — last checked just now",
    offline: "Controller unreachable. Are you on the VPN?",
    unauthorized:
      "Jenkins rejected the credentials — check your API token in settings",
  }[state];

  $("#conn-label").textContent = {
    checking: "Checking…",
    online: "Connected",
    offline: "No VPN",
    unauthorized: "Auth failed",
  }[state];

  const host = jenkins.hostOf(config.baseUrl);
  const bits = [host, `polling every ${config.pollSeconds}s`].filter(Boolean);
  $("#conn-context").textContent = bits.length ? `· ${bits.join(" · ")}` : "";
}

function renderBanner() {
  const b = clear($("#banner"));

  // First, because a stale worker makes every other diagnosis untrustworthy.
  if (ui.worker !== "ok") {
    b.hidden = false;
    b.append(
      icon("alert-triangle", { size: 14 }),
      el("span", {
        class: "banner-text",
        textContent:
          ui.worker === "stale"
            ? "The background script is running older code than this popup."
            : "The background script is not responding.",
      }),
      el("button", {
        textContent: "Reload",
        onclick: () => chrome.runtime.reload(),
      }),
    );
    return;
  }

  if (!config.baseUrl) {
    b.hidden = false;
    b.append(
      icon("alert-triangle", { size: 14 }),
      el("span", {
        class: "banner-text",
        textContent: "No Jenkins controller configured yet.",
      }),
      el("button", {
        textContent: "Settings",
        onclick: () => chrome.runtime.openOptionsPage(),
      }),
    );
    return;
  }

  if (ui.connection === "unauthorized") {
    const missing =
      config.authMode === "token" && (!config.userId || !config.token);
    b.hidden = false;
    b.append(
      icon("alert-triangle", { size: 14 }),
      el("span", {
        class: "banner-text",
        textContent: missing
          ? "No API token saved yet."
          : "Jenkins rejected the credentials.",
      }),
      el("button", {
        textContent: "Fix in settings",
        onclick: () => chrome.runtime.openOptionsPage(),
      }),
    );
    return;
  }

  if (ui.connection === "offline") {
    b.hidden = false;
    b.append(
      icon("alert-triangle", { size: 14 }),
      el("span", {
        class: "banner-text",
        textContent: "Controller unreachable. Showing last known data.",
      }),
      el("button", { textContent: "Retry", onclick: onRefresh }),
    );
    return;
  }

  b.hidden = true;
}

async function refreshConnection() {
  if (!config.baseUrl) {
    ui.connection = "offline";
    renderHeader();
    renderBanner();
    return;
  }
  ui.connection = await jenkins.probe(config);
  $("#body").classList.toggle("stale", ui.connection === "offline");
  renderHeader();
  renderBanner();
}

async function onRefresh() {
  const btn = $("#refresh");
  btn.classList.add("spinning");
  store.clearIndex();
  index = null;
  indexError = null;
  await Promise.all([
    refreshConnection(),
    chrome.runtime.sendMessage({ type: "poll" }).catch(() => {}),
    warmIndex(),
  ]);
  runs = await store.getRuns();
  renderActivity();
  renderFooter();
  if (ui.query) renderResults();
  btn.classList.remove("spinning");
}

/* ---------- search ---------- */

let searchTimer = null;

function onQueryInput(ev) {
  ui.query = ev.target.value;
  ui.activeResult = 0;
  $("#q-clear").hidden = !ui.query;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    renderMode();
    renderResults();
  }, SEARCH_DEBOUNCE_MS);
}

function clearQuery() {
  ui.query = "";
  $("#q").value = "";
  $("#q-clear").hidden = true;
  clearTimeout(searchTimer);
  renderMode();
  $("#q").focus();
}

function renderMode() {
  const searching = ui.query.trim().length > 0;
  $("#search-mode").hidden = !searching;
  $("#browse-mode").hidden = searching;
}

async function warmIndex() {
  if (!config.baseUrl) return;
  const cached = await store.getCachedIndex();
  if (cached) {
    index = cached;
    if (ui.query) renderResults();
    return;
  }
  try {
    index = await jenkins.fetchJobIndex(config);
    indexError = null;
    await store.cacheIndex(index);
  } catch (err) {
    indexError = err.message;
  }
  if (ui.query) renderResults();
}

function matches(query) {
  const q = normalizeSearchText(query);
  if (!q) return [];
  // Every space-separated word has to show up somewhere in the path, in any
  // order, so "email backup qa" still finds "email-backup/QA".
  const qWords = q.split(" ");
  const scored = [];
  for (const job of index || []) {
    const name = normalizeSearchText(job.name);
    const full = normalizeSearchText(job.fullName);
    if (!qWords.every((w) => full.includes(w))) continue;
    // Prefix and contiguous hits rank above hits that only match word-by-word.
    const score = name.startsWith(q) ? 0 : name.includes(q) ? 1 : full.includes(q) ? 2 : 3;
    scored.push({ job, score });
  }
  scored.sort(
    (a, b) => a.score - b.score || a.job.fullName.localeCompare(b.job.fullName),
  );
  return scored.slice(0, MAX_RESULTS).map((s) => s.job);
}

function renderResults() {
  const wrap = clear($("#results"));
  const note = $("#results-empty");
  const q = ui.query.trim();
  if (!q) return;

  if (index === null) {
    note.hidden = false;
    note.textContent = indexError ? indexError : "Loading the pipeline list…";
    $("#results-label").textContent = "ALL PIPELINES";
    return;
  }

  const hits = matches(q);
  $("#results-label").textContent = `ALL PIPELINES · ${hits.length}`;
  note.hidden = hits.length > 0;
  if (!hits.length) {
    note.textContent = `No pipeline matches “${q}”.`;
    return;
  }

  ui.activeResult = Math.min(ui.activeResult, hits.length - 1);

  hits.forEach((job, i) => {
    const on = starred.some((p) => p.id === job.id);
    const open = ui.openResult === job.id;
    const busy = ui.busy.has(job.id);

    const starBtn = el(
      "button",
      {
        class: `star-btn${on ? " on" : ""}`,
        title: on ? "Unstar" : "Star",
        onclick: (e) => {
          e.stopPropagation();
          toggleStar(job);
        },
      },
      icon("star", { size: 14, fill: on }),
    );

    const held = whyBlocked(job);
    const runBtn = el("button", {
      class: `run-btn compact${held ? " held" : ""}`,
      textContent: held ? "Open" : busy ? "…" : "Run",
      disabled: !held && busy,
      title: held
        ? blockedTitle(held, "Opens the job in Jenkins.")
        : "Trigger with the saved or default parameters",
      onclick: (e) => {
        e.stopPropagation();
        held ? openInJenkins(job) : runJob(job);
      },
    });

    const row = el(
      "div",
      {
        class: `result${i === ui.activeResult ? " active" : ""}`,
        onclick: () => toggleResult(job),
        onmouseenter: () => {
          ui.activeResult = i;
          highlightResults();
        },
      },
      [
        starBtn,
        // The lock appears here only when it has something to say. A row carrying
        // star, lock, name, time and Run inside 400px leaves the name nothing, and
        // an unblocked pipeline is the normal case that needs no mark. Blocking
        // one from search therefore means starring it first, or writing a pattern.
        el("div", { class: "result-text" }, [
          bellButton(job, renderResults),
          held ? lockButton(job, renderResults) : null,
          el("div", {
            class: "result-name",
            textContent: qualifiedName(job.fullName, job.name),
            title: job.fullName || job.name,
          }),
        ]),
        el("div", {
          class: "result-last",
          textContent: job.lastBuildAt
            ? `${ago(job.lastBuildAt)} ago`
            : "never run",
        }),
        runBtn,
      ],
    );

    const opening = open && ui.justOpened === job.id;
    const card = el(
      "div",
      {
        class: `result-card${open && !opening ? " open" : ""}`,
        dataset: { id: job.id },
      },
      row,
    );

    if (open) {
      const p = pipelineFor(job);
      const panel = p
        ? paramPanel(p, on)
        : el(
            "div",
            { class: "panel" },
            el("div", {
              class: "pdesc",
              textContent: ui.errors.get(job.id) || "Reading parameters…",
            }),
          );
      const slide = el(
        "div",
        { class: `panel-wrap${opening ? "" : " open"}` },
        panel,
      );
      card.append(slide);
      if (opening) reveal(card, slide);
    }
    wrap.append(card);
  });
}

// The pipeline shape the parameter panel and trigger path expect. A starred
// entry wins; otherwise it is assembled from the search hit plus whatever
// definitions have been fetched. Null means the definitions are not in yet.
function pipelineFor(job) {
  const entry = starred.find((x) => x.id === job.id);
  if (entry) return entry;
  const meta = jobMeta.get(job.id);
  if (!meta) return null;
  return {
    id: job.id,
    url: job.url,
    name: meta.name || job.name,
    fullName: meta.fullName || job.fullName,
    folder: meta.fullName || job.fullName,
    params: meta.params,
    lastRunAt: meta.lastBuildAt ?? job.lastBuildAt ?? null,
  };
}

async function loadMeta(job) {
  if (starred.some((x) => x.id === job.id) || jobMeta.has(job.id))
    return pipelineFor(job);
  try {
    jobMeta.set(job.id, await jenkins.getJobMeta(job.url, config));
    ui.errors.delete(job.id);
  } catch (err) {
    ui.errors.set(job.id, err.message);
    return null;
  }
  return pipelineFor(job);
}

async function toggleResult(job) {
  if (ui.openResult === job.id) {
    ui.openResult = null;
    collapse(
      $(`#results .result-card[data-id="${CSS.escape(job.id)}"]`),
      renderResults,
    );
    return;
  }
  ui.openResult = job.id;
  ui.justOpened = job.id;
  const known = Boolean(pipelineFor(job));
  renderResults(); // show the panel straight away
  if (known) return; // nothing to fetch, so nothing to re-render
  await loadMeta(job);
  renderResults(); // swaps in the form, or surfaces the error
}

async function runJob(job) {
  // Checked before the round trip for definitions, so Enter on a blocked result
  // does what its Run button does rather than fetching and then refusing.
  if (whyBlocked(job)) {
    openInJenkins(job);
    return;
  }
  const p = await loadMeta(job);
  if (!p) {
    renderResults();
    return;
  }
  triggerPipeline(p);
}

function highlightResults() {
  [...$("#results").children].forEach((card, i) =>
    card
      .querySelector(".result")
      ?.classList.toggle("active", i === ui.activeResult),
  );
}

function onSearchKey(ev) {
  if (ev.key === "Escape") {
    clearQuery();
    return;
  }
  const rows = $("#results").children;
  if (!ui.query.trim() || !rows.length) return;

  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    const delta = ev.key === "ArrowDown" ? 1 : -1;
    ui.activeResult = (ui.activeResult + delta + rows.length) % rows.length;
    highlightResults();
    rows[ui.activeResult].scrollIntoView({ block: "nearest" });
    return;
  }
  if (ev.key === "Enter") {
    ev.preventDefault();
    const job = matches(ui.query)[ui.activeResult];
    // Enter runs the highlighted result, starred or not. Shift+Enter opens its
    // parameters instead, for when the saved values need a look first.
    if (job) ev.shiftKey ? toggleResult(job) : runJob(job);
  }
}

async function toggleStar(job) {
  if (starred.some((p) => p.id === job.id)) {
    starred = await store.unstar(job.id);
    delete paramValues[job.id];
    if (ui.openId === job.id) ui.openId = null;
  } else {
    // Star immediately so the click feels instant, then fill in the parameters.
    starred = await store.star({
      id: job.id,
      url: job.url,
      name: job.name,
      fullName: job.fullName,
      folder: job.fullName,
      params: [],
      lastRunAt: job.lastBuildAt ?? null,
    });
    renderResults();
    renderStarred();
    try {
      const meta = await jenkins.getJobMeta(job.url, config);
      starred = await store.star({
        id: job.id,
        name: meta.name,
        fullName: meta.fullName || job.fullName,
        folder: meta.fullName || job.fullName,
        params: meta.params,
        lastRunAt: meta.lastBuildAt,
      });
    } catch (err) {
      ui.errors.set(job.id, err.message);
    }
  }
  renderResults();
  renderStarred();
  renderActivity();
  renderFooter();
}

/* ---------- activity ---------- */

function renderActivity() {
  const host = clear($("#activity"));

  // With nothing starred there is nothing that could have been triggered, so the
  // empty box would just stack a second empty state above the starred one.
  host.hidden = !runs.length && !starred.length;
  if (host.hidden) return;

  if (!runs.length) {
    host.append(
      el("div", {
        class: "empty-box",
        textContent: "Nothing triggered from here yet.",
      }),
    );
    return;
  }

  const list = el("div", { class: "runs" });
  for (const run of runs) list.append(runCard(run));
  host.append(list);
}

function runCard(run) {
  const active = store.isActive(run);
  // Queued gets its own dot rather than sharing the running one: the dot is now
  // the only thing carrying status, and "waiting" is not "working".
  const dotClass =
    run.status === "QUEUED" ? "queued" : active ? "active" : run.status;
  const dot = el("div", {
    class: `run-dot ${dotClass}`,
    title: statusLabel(run),
  });

  const buttons = [];
  if (active && run.url) {
    buttons.push(
      el("button", {
        class: "abort-btn",
        textContent: "Abort",
        onclick: (e) => abortRun(run, e.currentTarget),
      }),
    );
  }
  if (run.url) {
    buttons.push(
      el(
        "button",
        {
          class: "run-icon-btn",
          title: "Open this build in a new tab",
          onclick: () => chrome.tabs.create({ url: run.url }),
        },
        icon("eye", { size: 13 }),
      ),
    );
  }
  if (!active && run.jobUrl) {
    // A replay is still a trigger, so it answers to the same guard.
    const held = whyBlocked({
      id: run.jobId,
      fullName: run.fullName,
      name: run.name,
    });
    buttons.push(
      el(
        "button",
        {
          class: "run-icon-btn",
          title: held
            ? blockedTitle(held)
            : "Run again with these same parameters",
          disabled: Boolean(held) || ui.busy.has(run.id),
          onclick: () => rerun(run),
        },
        icon("rotate-cw", { size: 13 }),
      ),
    );
  }
  if (!active) {
    buttons.push(
      el(
        "button",
        {
          class: "run-icon-btn",
          title: "Dismiss",
          onclick: async () => {
            runs = await store.dismissRun(run.id);
            renderActivity();
            renderFooter();
          },
        },
        icon("x", { size: 12 }),
      ),
    );
  }

  return el("div", { class: "run", dataset: { runId: run.id } }, [
    dot,
    el("div", { class: "run-text" }, [
      el("div", { class: "run-head" }, [
        el("span", {
          class: "run-name",
          textContent: qualifiedName(run.fullName, run.name),
          title: run.fullName || run.name,
        }),
        buildLabel(run)
          ? el("span", {
              class: "run-build",
              textContent: buildLabel(run),
              title: run.build ? `Build #${run.build}` : "",
            })
          : null,
        el("span", { class: "run-time", textContent: runTime(run) }),
      ]),
      // A failed re-run has no parameter panel to report into, so it reports on
      // the card it was launched from.
      ui.errors.has(run.id)
        ? el("div", { class: "run-error", textContent: ui.errors.get(run.id) })
        : run.status === "ERROR"
          ? el("div", {
              class: "run-error",
              textContent: run.error || "Failed to start",
            })
          : paramsLine(run),
    ]),
    // Grouped rather than spread into the row: the row's 10px gap is the spacing
    // between name, values and controls, which is too loose between the controls
    // themselves. Dropped entirely when there are none, so an empty group cannot
    // add a gap of its own.
    buttons.length ? el("div", { class: "run-actions" }, buttons) : null,
  ]);
}

// Values only: a branch name or a build command says what it is without its key,
// and the key doubles the length of a line that has to fit in 400px. The keys
// are still in the tooltip for the rare ambiguous pair.
//
// Checkboxes are stored as real booleans, so their type is enough to leave them
// out; a row full of `false` says nothing about what this build was.
function paramsLine(run) {
  const kept = Object.entries(run.params || {}).filter(
    ([, v]) => typeof v !== "boolean" && String(v).trim() !== "",
  );
  if (!kept.length) return null;
  return el("div", {
    class: "run-params",
    textContent: kept.map(([, v]) => v).join(", "),
    title: kept.map(([k, v]) => `${k}=${v}`).join("\n"),
  });
}

// Time only. The dot carries the status, so repeating RUNNING or SUCCESS here
// just spends a line saying what the colour already said.
function runTime(run) {
  if (run.status === "QUEUED") return elapsed(run.startedAt);
  if (run.status === "RUNNING")
    return elapsed(run.buildStartedAt || run.startedAt);
  return `${ago(run.finishedAt || run.startedAt)} ago`;
}

// The word still exists for the dot's tooltip, and for queued, where `why`
// explains a wait the colour cannot.
function statusLabel(run) {
  if (run.status === "QUEUED")
    return run.why ? `Queued — ${run.why}` : "Queued";
  if (run.status === "RUNNING") return "Running";
  if (run.status === "ERROR") return run.error || "Failed to start";
  return run.status;
}

// Only the elapsed text changes every second, so patch it in place rather than
// re-rendering rows and stealing focus from anything the user is editing.
function tickElapsed() {
  for (const run of runs) {
    if (!store.isActive(run)) continue;
    const row = document.querySelector(
      `.run[data-run-id="${CSS.escape(run.id)}"]`,
    );
    if (!row) continue;
    row.querySelector(".run-time").textContent = runTime(run);
    row.querySelector(".run-dot").title = statusLabel(run);
  }
}

async function abortRun(run, btn) {
  btn.disabled = true;
  btn.textContent = "Aborting…";
  try {
    await jenkins.abortBuild(run.url, config);
    await store.updateRun(run.id, {
      status: "ABORTED",
      finishedAt: Date.now(),
    });
  } catch (err) {
    await store.updateRun(run.id, { error: err.message });
  }
  runs = await store.getRuns();
  renderActivity();
  renderFooter();
}

/* ---------- starred ---------- */

function renderStarred() {
  const host = clear($("#starred"));
  if (!starred.length) {
    host.append(
      el("div", {
        class: "empty-box",
        textContent:
          "No pipelines starred yet. Search above, or add one by URL.",
      }),
    );
    return;
  }
  for (const p of starred) host.append(pipelineCard(p));
}

function pipelineCard(p) {
  const open = ui.openId === p.id;
  // Only the render that follows the click animates. Every other render while
  // the card is open, a poll landing for instance, rebuilds it already expanded.
  const opening = open && ui.justOpened === p.id;
  const card = el("div", {
    class: `card${open && !opening ? " open" : ""}`,
    dataset: { id: p.id },
  });

  card.addEventListener("dragstart", (ev) => {
    ui.dragId = p.id;
    ev.dataTransfer.effectAllowed = "move";
    card.classList.add("dragging");
  });
  card.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    if (!ui.dragId || ui.dragId === p.id) return;
    const host = $("#starred");
    const dragged = host.querySelector(
      `.card[data-id="${CSS.escape(ui.dragId)}"]`,
    );
    if (!dragged) return;
    const after =
      card.compareDocumentPosition(dragged) & Node.DOCUMENT_POSITION_PRECEDING;
    host.insertBefore(dragged, after ? card.nextSibling : card);
  });
  card.addEventListener("dragend", () => {
    card.draggable = false;
    persistOrder();
  });

  const reason = whyBlocked(p);
  const runBtn = el("button", {
    class: `run-btn${reason ? " held" : ""}`,
    textContent: reason ? "Open" : ui.busy.has(p.id) ? "Starting…" : "Run",
    disabled: !reason && ui.busy.has(p.id),
    title: reason ? blockedTitle(reason, "Opens the job in Jenkins.") : "",
    onclick: (e) => {
      e.stopPropagation();
      reason ? openInJenkins(p) : triggerPipeline(p);
    },
  });

  card.append(
    el("div", { class: "card-row" }, [
      el(
        "div",
        {
          class: "grip",
          title: "Drag to reorder",
          onmousedown: () => {
            card.draggable = true;
          },
          onmouseup: () => {
            card.draggable = false;
          },
        },
        icon("grip", { size: 14 }),
      ),
      el(
        "div",
        {
          class: "card-main",
          onclick: () => {
            if (!open) {
              ui.openId = p.id;
              ui.justOpened = p.id;
              renderStarred();
              return;
            }
            ui.openId = null;
            collapse(card, renderStarred);
          },
        },
        [
          el("div", { class: "card-title" }, [
            el("span", {
              class: "card-name",
              textContent: qualifiedName(p.fullName, p.name),
              title: p.fullName || p.name,
            }),
            // One chevron rotated by CSS rather than two swapped: a swap cannot animate.
            el("span", { class: "caret" }, icon("chevron-right", { size: 12 })),
            // Pushed to the far end by .title-tools, so the caret stays attached to
            // the name and the two toggles read as one group.
            el("div", { class: "title-tools" }, [
              bellButton(p, renderStarred),
              lockButton(p, renderStarred),
            ]),
          ]),
          el("div", { class: "card-summary", textContent: summaryFor(p) }),
        ],
      ),
      runBtn,
    ]),
  );

  if (open) {
    const wrap = el(
      "div",
      { class: `panel-wrap${opening ? "" : " open"}` },
      paramPanel(p),
    );
    card.append(wrap);
    if (opening) reveal(card, wrap);
  }
  return card;
}

async function persistOrder() {
  const host = $("#starred");
  host
    .querySelectorAll(".card.dragging")
    .forEach((n) => n.classList.remove("dragging"));
  ui.dragId = null;
  const ids = [...host.querySelectorAll(".card")].map((n) => n.dataset.id);
  if (ids.length) starred = await store.setOrder(ids);
}

function valuesFor(p) {
  if (ui.drafts.has(p.id)) return ui.drafts.get(p.id);
  const saved = paramValues[p.id] || {};
  const out = {};
  for (const d of p.params || []) {
    out[d.name] = saved[d.name] !== undefined ? saved[d.name] : defaultFor(d);
  }
  return out;
}

function defaultFor(d) {
  if (d.type === "BooleanParameterDefinition")
    return d.default === true || d.default === "true";
  if (d.choices?.length && (d.default === "" || d.default == null))
    return d.choices[0];
  return d.default ?? "";
}

function summaryFor(p) {
  if (!p.params?.length) return "no parameters";
  const vals = valuesFor(p);
  const parts = p.params
    .filter((d) => d.type !== "PasswordParameterDefinition")
    .map((d) => `${d.name}=${vals[d.name]}`);
  const head = parts.slice(0, 2).join(", ");
  return head + (parts.length > 2 ? `  +${parts.length - 2}` : "");
}

/* ---------- expanding panels ---------- */

// Matches --motion in popup.css. Only used to know when a collapsed panel can be
// removed from the DOM, so it errs on the side of the CSS finishing first.
const MOTION_MS = matchMedia("(prefers-reduced-motion: reduce)").matches
  ? 0
  : 190;

// Two frames, not one. The first lets the collapsed state land in layout; the
// second transitions away from it. With a single frame the browser is free to
// coalesce both styles and the panel simply appears.
//
// The flag is cleared here rather than at render time because a render can be
// thrown away before its reveal ever runs, which is exactly what happens when a
// result's parameter definitions arrive a tick after the panel is opened. Left
// set, the render that replaces it animates instead.
function reveal(card, wrap) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (!wrap.isConnected) return;
      ui.justOpened = null;
      card.classList.add("open");
      wrap.classList.add("open");
    }),
  );
}

// The card outlives its own collapse: the state is already closed, but the panel
// stays in the DOM until the height animation has run, then the caller re-renders
// over it. A re-render arriving mid-animation cuts it short rather than breaking.
function collapse(card, done) {
  const wrap = card?.querySelector(".panel-wrap");
  card?.classList.remove("open");
  if (!wrap) {
    done();
    return;
  }
  wrap.classList.remove("open");
  setTimeout(done, MOTION_MS);
}

function paramPanel(p, isStarred = true) {
  const panel = el("div", { class: "panel" });
  const values = { ...valuesFor(p) };
  ui.drafts.set(p.id, values);
  const write = (key, v) => {
    values[key] = v;
    const summary = panel.parentElement?.querySelector(".card-summary");
    if (summary) summary.textContent = summaryFor(p);
  };

  for (const d of p.params || []) {
    panel.append(paramField(d, values[d.name], (v) => write(d.name, v)));
  }

  const reason = whyBlocked(p);
  const trigger = el("button", {
    class: `trigger-btn${reason ? " held" : ""}`,
    textContent: reason
      ? "Open in Jenkins"
      : ui.busy.has(p.id)
        ? "Starting…"
        : "Trigger build",
    disabled: !reason && ui.busy.has(p.id),
    title: blockedTitle(reason),
    onclick: () => (reason ? openInJenkins(p) : triggerPipeline(p)),
  });
  const sync = el("button", {
    class: "outline-btn",
    title: "Re-read parameters from Jenkins",
    textContent: "Sync params",
    onclick: (e) => syncParams(p, e.currentTarget),
  });
  const starToggle = el(
    "button",
    {
      class: `unstar-btn${isStarred ? "" : " off"}`,
      title: isStarred ? "Unstar" : "Star",
      onclick: () =>
        toggleStar({
          id: p.id,
          url: p.url,
          name: p.name,
          fullName: p.fullName,
          lastBuildAt: p.lastRunAt,
        }),
    },
    icon("star", { size: 13, fill: isStarred }),
  );

  panel.append(
    el("div", { class: "panel-actions" }, [trigger, sync, starToggle]),
  );

  const err = ui.errors.get(p.id);
  if (err) panel.append(el("div", { class: "field-error", textContent: err }));

  panel.append(
    el("div", { class: "panel-footer" }, [
      el("a", { href: p.url, target: "_blank", rel: "noreferrer" }, [
        document.createTextNode("open in Jenkins"),
        icon("external-link", { size: 11 }),
      ]),
      el("span", {
        textContent: p.lastRunAt
          ? `last run ${ago(p.lastRunAt)} ago`
          : "never run",
      }),
    ]),
  );

  return panel;
}

function paramField(d, value, onWrite) {
  if (d.type === "BooleanParameterDefinition") {
    const box = el("input", {
      type: "checkbox",
      checked: value === true || value === "true",
      onchange: (e) => onWrite(e.target.checked),
    });
    return el("label", { class: "pbool" }, [
      box,
      el("span", { textContent: d.name }),
    ]);
  }

  const label = el("div", { class: "plabel" }, [
    el("span", { class: "pkey", textContent: d.name }),
    d.description
      ? el("span", { class: "pdesc", textContent: stripHtml(d.description) })
      : null,
  ]);

  let input;
  if (d.choices?.length) {
    input = el("select", { onchange: (e) => onWrite(e.target.value) });
    for (const c of d.choices)
      input.append(
        el("option", { value: c, textContent: c, selected: c === value }),
      );
  } else if (d.type === "PasswordParameterDefinition") {
    input = el("input", {
      type: "password",
      value: "",
      oninput: (e) => onWrite(e.target.value),
    });
  } else {
    input = el("input", {
      type: "text",
      value: value ?? "",
      oninput: (e) => onWrite(e.target.value),
    });
  }

  return el("div", { class: "pfield" }, [label, input]);
}

const stripHtml = (s) => s.replace(/<[^>]*>/g, "").trim();

async function syncParams(p, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Syncing…";
  try {
    const meta = await jenkins.getJobMeta(p.url, config);
    // Keep the values the user already set wherever the key survived.
    const kept = {};
    const current = valuesFor(p);
    for (const d of meta.params) {
      kept[d.name] =
        current[d.name] !== undefined ? current[d.name] : defaultFor(d);
    }
    ui.drafts.set(p.id, kept);
    await store.setParamValues(p.id, stripSecrets(meta.params, kept));
    paramValues[p.id] = stripSecrets(meta.params, kept);
    starred = await store.star({
      id: p.id,
      name: meta.name,
      params: meta.params,
      lastRunAt: meta.lastBuildAt,
    });
    ui.errors.delete(p.id);
    btn.textContent = "Synced ✓";
    setTimeout(() => {
      renderStarred();
    }, 1400);
  } catch (err) {
    ui.errors.set(p.id, err.message);
    btn.disabled = false;
    btn.textContent = original;
    renderStarred();
  }
}

/* ---------- subscriptions ---------- */

const isSubscribed = (id) => subscribed.some((p) => p.id === id);

// Sits beside the padlock, so the two things that change what a pipeline does
// without opening it are in one place. Filled means subscribed.
function bellButton(p, rerender) {
  const on = isSubscribed(p.id);
  const muted = on && !anyWanted(config?.notifyOn);
  return el(
    "button",
    {
      class: `bell-btn${on ? " on" : ""}`,
      title: muted
        ? "Subscribed, but every notification kind is switched off in settings."
        : on
          ? "Subscribed. Click to stop being notified."
          : "Notify me whenever this pipeline runs.",
      onclick: async (e) => {
        e.stopPropagation();
        subscribed = on
          ? await store.unsubscribe(p.id)
          : await store.subscribe({
              id: p.id,
              url: p.url,
              name: p.name,
              fullName: p.fullName,
            });
        rerender();
        renderFooter();
      },
    },
    icon("bell", { size: 12, fill: on }),
  );
}

/* ---------- blocking ---------- */

// Null when the pipeline may be triggered, otherwise the reason, ready to print.
const whyBlocked = (p) =>
  blockReason(p, { blocked, patterns: config?.denyPatterns });

// The lock beside a pipeline's name. Always shown on a starred card, so the
// guard is discoverable and its state readable without expanding anything.
// Pattern blocks are shown but not liftable: a deny-list you can click away on
// the card it is protecting is not a deny-list.
function lockButton(p, rerender) {
  const reason = whyBlocked(p);
  const fromPattern = isPatternBlock(reason);
  return el(
    "button",
    {
      class: `lock-btn${reason ? " on" : ""}`,
      disabled: fromPattern,
      title: fromPattern
        ? blockedTitle(reason)
        : reason
          ? "Blocked. Click to allow triggering again."
          : "Allow triggering. Click to block it.",
      onclick: async (e) => {
        e.stopPropagation();
        blocked = await store.setBlocked(p.id, !reason);
        rerender();
      },
    },
    icon(reason ? "lock" : "lock-open", { size: 12 }),
  );
}

// What the Run button becomes when a pipeline is blocked. The point of the
// block is that you go and look at the job in Jenkins instead of firing it from
// a popup, so the button takes you there rather than going dead.
function openInJenkins(p) {
  chrome.tabs.create({ url: p.url });
}

/* ---------- triggering ---------- */

function stripSecrets(defs, values) {
  const out = { ...values };
  for (const d of defs || [])
    if (d.type === "PasswordParameterDefinition") delete out[d.name];
  return out;
}

// Replays a finished run. The values come off the run record rather than the
// pipeline's saved ones, so this reproduces what that build actually used even
// if the saved values have been edited since. For the same reason it does not
// write them back as the new saved values.
//
// Secrets are the one gap: password parameters are stripped before a run is
// recorded, so a replay leaves them out and Jenkins falls back to its defaults.
async function rerun(run) {
  if (ui.busy.has(run.id)) return;
  ui.busy.add(run.id);
  ui.errors.delete(run.id);
  renderActivity();

  const res = await chrome.runtime
    .sendMessage({
      type: "trigger",
      pipelineId: run.jobId,
      params: run.params || {},
      remember: false,
      // Sent so a run whose pipeline was never starred, or has since been
      // unstarred, can still be replayed.
      job: {
        id: run.jobId,
        url: run.jobUrl,
        name: run.name,
        fullName: run.fullName,
      },
    })
    .catch((err) => ({ ok: false, error: err.message }));

  ui.busy.delete(run.id);
  if (!res?.ok)
    ui.errors.set(run.id, res?.error || "Could not start it again.");

  runs = await store.getRuns();
  renderActivity();
  renderFooter();
}

async function triggerPipeline(p) {
  if (ui.busy.has(p.id)) return;
  // Every button that reaches here has already been swapped for one that opens
  // Jenkins, so this only catches a keyboard path or a render that went stale
  // mid-click. The worker checks again regardless.
  const reason = whyBlocked(p);
  if (reason) {
    ui.errors.set(p.id, `Cannot be triggered — ${reason}.`);
    renderAll();
    return;
  }
  const fromSearch = Boolean(ui.query.trim());
  ui.busy.add(p.id);
  ui.errors.delete(p.id);
  fromSearch ? renderResults() : renderStarred();

  const params = valuesFor(p);
  const persist = stripSecrets(p.params, params);

  const res = await chrome.runtime
    .sendMessage({
      type: "trigger",
      pipelineId: p.id,
      params,
      persist,
      // Sent so the worker can run a pipeline that was never starred.
      job: { id: p.id, url: p.url, name: p.name, fullName: p.fullName },
    })
    .catch((err) => ({ ok: false, error: err.message }));

  ui.busy.delete(p.id);

  if (!res?.ok) {
    ui.errors.set(p.id, res?.error || "Trigger failed.");
    if (fromSearch) ui.openResult = p.id;
    else ui.openId = p.id;
    runs = await store.getRuns();
    renderAll();
    return;
  }

  paramValues[p.id] = persist;
  ui.openId = null;
  ui.openResult = null;
  ui.drafts.delete(p.id);
  starred = await store.getStarred();
  runs = await store.getRuns();

  // Drop back to browse so the new run is actually visible; left in search mode
  // the activity list it lands in is hidden.
  if (fromSearch) clearQuery();
  renderAll();
}

/* ---------- footer ---------- */

function renderFooter() {
  const running = runs.filter(store.isActive).length;
  const line = clear($("#status-line"));
  line.append(document.createTextNode(`${starred.length} starred`));

  // The one count worth clicking. A subscription is invisible unless you happen
  // to be looking at the pipeline it is on, so this is the only place the whole
  // set can be seen and unpicked.
  if (subscribed.length) {
    line.append(
      document.createTextNode(" · "),
      el("button", {
        class: `count-btn${ui.subsOpen ? " on" : ""}`,
        textContent: `${subscribed.length} subscribed`,
        title: ui.subsOpen
          ? "Hide the list"
          : "Show everything you are subscribed to",
        onclick: () => {
          ui.subsOpen = !ui.subsOpen;
          renderFooter();
        },
      }),
    );
  } else {
    ui.subsOpen = false;
  }
  if (running) line.append(document.createTextNode(` · ${running} running`));

  renderSubsList();

  const toggle = clear($("#add-toggle"));
  toggle.append(
    icon(ui.addOpen ? "minus" : "plus", { size: 12 }),
    document.createTextNode(
      ui.addOpen ? "Hide URL field" : "Add pipeline by URL",
    ),
  );
  $("#add-row").hidden = !ui.addOpen;
}

function renderSubsList() {
  const host = clear($("#subs-list"));
  host.hidden = !ui.subsOpen;
  if (!ui.subsOpen) return;

  for (const p of subscribed) {
    host.append(
      el("div", { class: "subs-row" }, [
        el("span", {
          class: "subs-name",
          textContent: qualifiedName(p.fullName, p.name),
          title: p.fullName || p.name,
        }),
        el(
          "button",
          {
            class: "subs-open",
            title: "Open this pipeline in a new tab",
            onclick: () => chrome.tabs.create({ url: p.url }),
          },
          icon("external-link", { size: 11 }),
        ),
        el(
          "button",
          {
            class: "subs-off",
            title: "Stop being notified about this pipeline",
            onclick: async () => {
              subscribed = await store.unsubscribe(p.id);
              renderStarred();
              renderResults();
              renderFooter();
            },
          },
          icon("x", { size: 12 }),
        ),
      ]),
    );
  }
}

function toggleAdd() {
  ui.addOpen = !ui.addOpen;
  renderFooter();
  if (ui.addOpen) $("#add-url").focus();
  else {
    $("#add-error").hidden = true;
  }
}

async function onAdd() {
  const input = $("#add-url");
  const btn = $("#add-btn");
  const err = $("#add-error");
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = "…";

  try {
    const url = jenkins.normalizeJobUrl(input.value);
    const granted = await chrome.permissions.request({
      origins: [jenkins.originOf(url)],
    });
    if (!granted) throw new Error("Permission for that host was declined.");

    if (!config.baseUrl)
      config = await store.saveConfig({ baseUrl: jenkins.rootOf(url) });

    const meta = await jenkins.getJobMeta(url, config);
    if (meta.isFolder)
      throw new Error(
        "That is a folder, not a runnable job. Open it and copy a job URL.",
      );

    starred = await store.star({
      id: url,
      url,
      name: meta.name,
      fullName: meta.fullName,
      folder: meta.fullName,
      params: meta.params,
      lastRunAt: meta.lastBuildAt,
    });
    input.value = "";
    ui.addOpen = false;
    renderAll();
    refreshConnection();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Add";
  }
}

/* ---------- reacting to background writes ---------- */

async function onStorageChanged(changes, area) {
  if (area === "local" && changes.runs) {
    runs = changes.runs.newValue || [];
    renderActivity();
    renderFooter();
  }
  if (area === "sync" && changes.starred) {
    starred = changes.starred.newValue || [];
    renderStarred();
    renderActivity();
    renderFooter();
  }
  if (area === "sync" && changes.paramValues) {
    paramValues = changes.paramValues.newValue || {};
  }
  if (area === "sync" && changes.subscriptions) {
    subscribed = changes.subscriptions.newValue || [];
    renderStarred();
    renderResults();
    renderFooter();
  }
  if (area === "sync" && changes.blocked) {
    blocked = changes.blocked.newValue || [];
    renderStarred();
    renderResults();
  }
  if (area === "sync" && changes.config) {
    config = await store.getConfig();
    renderHeader();
    // Deny patterns are config, and editing them in settings changes which
    // pipelines are blocked without touching any pipeline.
    renderStarred();
    renderResults();
  }
}
