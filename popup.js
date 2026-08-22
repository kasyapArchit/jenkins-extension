import * as store from './lib/store.js';
import * as jenkins from './lib/jenkins.js';
import { icon } from './lib/icons.js';
import { $, el, clear, elapsed, ago } from './lib/dom.js';

const MAX_RESULTS = 7;
const SEARCH_DEBOUNCE_MS = 200;

let config = null;
let starred = [];
let paramValues = {};
let runs = [];
let index = null;             // flat job list, null until loaded
let indexError = null;

// Parameter definitions for jobs that are not starred, so search can trigger
// them without a round trip on every keystroke.
const jobMeta = new Map();

const ui = {
  query: '',
  openId: null,
  openResult: null,       // search result whose parameter panel is expanded
  addOpen: false,
  connection: 'checking',     // checking | online | offline | unauthorized
  activeResult: 0,
  dragId: null,
  drafts: new Map(),          // pipelineId -> { KEY: value } being edited
  busy: new Set(),            // pipeline ids mid-trigger
  errors: new Map()           // pipelineId -> message
};

init();

async function init() {
  [config, starred, paramValues, runs] = await Promise.all([
    store.getConfig(), store.getStarred(), store.getAllParamValues(), store.getRuns()
  ]);

  mountChrome();
  renderAll();

  store.onChange(onStorageChanged);
  setInterval(tickElapsed, 1000);

  chrome.runtime.sendMessage({ type: 'poll' }).catch(() => {});
  refreshConnection();
  warmIndex();
}

/* ---------- static chrome ---------- */

function mountChrome() {
  $('#refresh').append(icon('refresh-cw'));
  $('#settings').append(icon('settings', { size: 17 }));
  $('#search-icon').append(icon('search', { size: 14 }));
  $('#q-clear').append(icon('x', { size: 13 }));

  $('#settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('#refresh').addEventListener('click', onRefresh);
  $('#q').addEventListener('input', onQueryInput);
  $('#q').addEventListener('keydown', onSearchKey);
  $('#q-clear').addEventListener('click', clearQuery);
  $('#add-toggle').addEventListener('click', toggleAdd);
  $('#add-btn').addEventListener('click', onAdd);
  $('#add-url').addEventListener('keydown', e => { if (e.key === 'Enter') onAdd(); });
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
  const dot = $('#conn-dot');
  const state = ui.connection;
  dot.className = `conn-dot ${state === 'checking' ? '' : state}`;
  dot.title = {
    checking: 'Checking the controller…',
    online: 'Reachable — last checked just now',
    offline: 'Controller unreachable. Are you on the VPN?',
    unauthorized: 'Jenkins rejected the credentials — check your API token in settings'
  }[state];

  $('#conn-label').textContent = {
    checking: 'Checking…', online: 'Connected', offline: 'No VPN', unauthorized: 'Auth failed'
  }[state];

  const host = jenkins.hostOf(config.baseUrl);
  const bits = [host, `polling every ${config.pollSeconds}s`].filter(Boolean);
  $('#conn-context').textContent = bits.length ? `· ${bits.join(' · ')}` : '';
}

function renderBanner() {
  const b = clear($('#banner'));

  if (!config.baseUrl) {
    b.hidden = false;
    b.append(icon('alert-triangle', { size: 14 }),
      el('span', { class: 'banner-text', textContent: 'No Jenkins controller configured yet.' }),
      el('button', { textContent: 'Settings', onclick: () => chrome.runtime.openOptionsPage() }));
    return;
  }

  if (ui.connection === 'unauthorized') {
    const missing = config.authMode === 'token' && (!config.userId || !config.token);
    b.hidden = false;
    b.append(icon('alert-triangle', { size: 14 }),
      el('span', {
        class: 'banner-text',
        textContent: missing ? 'No API token saved yet.' : 'Jenkins rejected the credentials.'
      }),
      el('button', { textContent: 'Fix in settings', onclick: () => chrome.runtime.openOptionsPage() }));
    return;
  }

  if (ui.connection === 'offline') {
    b.hidden = false;
    b.append(icon('alert-triangle', { size: 14 }),
      el('span', { class: 'banner-text', textContent: 'Controller unreachable. Showing last known data.' }),
      el('button', { textContent: 'Retry', onclick: onRefresh }));
    return;
  }

  b.hidden = true;
}

async function refreshConnection() {
  if (!config.baseUrl) { ui.connection = 'offline'; renderHeader(); renderBanner(); return; }
  ui.connection = await jenkins.probe(config);
  $('#body').classList.toggle('stale', ui.connection === 'offline');
  renderHeader();
  renderBanner();
}

async function onRefresh() {
  const btn = $('#refresh');
  btn.classList.add('spinning');
  store.clearIndex();
  index = null;
  indexError = null;
  await Promise.all([
    refreshConnection(),
    chrome.runtime.sendMessage({ type: 'poll' }).catch(() => {}),
    warmIndex()
  ]);
  runs = await store.getRuns();
  renderActivity();
  renderFooter();
  if (ui.query) renderResults();
  btn.classList.remove('spinning');
}

/* ---------- search ---------- */

let searchTimer = null;

function onQueryInput(ev) {
  ui.query = ev.target.value;
  ui.activeResult = 0;
  $('#q-clear').hidden = !ui.query;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { renderMode(); renderResults(); }, SEARCH_DEBOUNCE_MS);
}

function clearQuery() {
  ui.query = '';
  $('#q').value = '';
  $('#q-clear').hidden = true;
  clearTimeout(searchTimer);
  renderMode();
  $('#q').focus();
}

function renderMode() {
  const searching = ui.query.trim().length > 0;
  $('#search-mode').hidden = !searching;
  $('#browse-mode').hidden = searching;
}

async function warmIndex() {
  if (!config.baseUrl) return;
  const cached = await store.getCachedIndex();
  if (cached) { index = cached; if (ui.query) renderResults(); return; }
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
  const q = query.trim().toLowerCase();
  const scored = [];
  for (const job of index || []) {
    const name = job.name.toLowerCase();
    const full = job.fullName.toLowerCase();
    if (!name.includes(q) && !full.includes(q)) continue;
    // Prefix hits on the leaf name rank above folder-path hits.
    const score = name.startsWith(q) ? 0 : name.includes(q) ? 1 : 2;
    scored.push({ job, score });
  }
  scored.sort((a, b) => a.score - b.score || a.job.fullName.localeCompare(b.job.fullName));
  return scored.slice(0, MAX_RESULTS).map(s => s.job);
}

function renderResults() {
  const wrap = clear($('#results'));
  const note = $('#results-empty');
  const q = ui.query.trim();
  if (!q) return;

  if (index === null) {
    note.hidden = false;
    note.textContent = indexError ? indexError : 'Loading the pipeline list…';
    $('#results-label').textContent = 'ALL PIPELINES';
    return;
  }

  const hits = matches(q);
  $('#results-label').textContent = `ALL PIPELINES · ${hits.length}`;
  note.hidden = hits.length > 0;
  if (!hits.length) { note.textContent = `No pipeline matches “${q}”.`; return; }

  ui.activeResult = Math.min(ui.activeResult, hits.length - 1);

  hits.forEach((job, i) => {
    const on = starred.some(p => p.id === job.id);
    const open = ui.openResult === job.id;
    const busy = ui.busy.has(job.id);

    const starBtn = el('button', {
      class: `star-btn${on ? ' on' : ''}`,
      title: on ? 'Unstar' : 'Star',
      onclick: e => { e.stopPropagation(); toggleStar(job); }
    }, icon('star', { size: 14, fill: on }));

    const runBtn = el('button', {
      class: 'run-btn compact',
      textContent: busy ? '…' : 'Run',
      disabled: busy,
      title: 'Trigger with the saved or default parameters',
      onclick: e => { e.stopPropagation(); runJob(job); }
    });

    const row = el('div', {
      class: `result${i === ui.activeResult ? ' active' : ''}`,
      onclick: () => toggleResult(job),
      onmouseenter: () => { ui.activeResult = i; highlightResults(); }
    }, [
      starBtn,
      el('div', { class: 'result-text' }, [
        el('div', { class: 'result-name', textContent: job.name }),
        el('div', { class: 'result-folder', textContent: job.fullName })
      ]),
      el('div', {
        class: 'result-last',
        textContent: job.lastBuildAt ? `${ago(job.lastBuildAt)} ago` : 'never run'
      }),
      runBtn
    ]);

    const card = el('div', { class: `result-card${open ? ' open' : ''}` }, row);

    if (open) {
      const p = pipelineFor(job);
      card.append(p
        ? paramPanel(p, on)
        : el('div', { class: 'panel' }, el('div', {
            class: 'pdesc', textContent: ui.errors.get(job.id) || 'Reading parameters…'
          })));
    }
    wrap.append(card);
  });
}

// The pipeline shape the parameter panel and trigger path expect. A starred
// entry wins; otherwise it is assembled from the search hit plus whatever
// definitions have been fetched. Null means the definitions are not in yet.
function pipelineFor(job) {
  const entry = starred.find(x => x.id === job.id);
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
    lastRunAt: meta.lastBuildAt ?? job.lastBuildAt ?? null
  };
}

async function loadMeta(job) {
  if (starred.some(x => x.id === job.id) || jobMeta.has(job.id)) return pipelineFor(job);
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
    renderResults();
    return;
  }
  ui.openResult = job.id;
  renderResults();                 // show the panel straight away
  if (await loadMeta(job)) renderResults();
  else renderResults();            // surfaces the error in the panel
}

async function runJob(job) {
  const p = await loadMeta(job);
  if (!p) { renderResults(); return; }
  triggerPipeline(p);
}

function highlightResults() {
  [...$('#results').children].forEach((card, i) =>
    card.querySelector('.result')?.classList.toggle('active', i === ui.activeResult));
}

function onSearchKey(ev) {
  if (ev.key === 'Escape') { clearQuery(); return; }
  const rows = $('#results').children;
  if (!ui.query.trim() || !rows.length) return;

  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    const delta = ev.key === 'ArrowDown' ? 1 : -1;
    ui.activeResult = (ui.activeResult + delta + rows.length) % rows.length;
    highlightResults();
    rows[ui.activeResult].scrollIntoView({ block: 'nearest' });
    return;
  }
  if (ev.key === 'Enter') {
    ev.preventDefault();
    const job = matches(ui.query)[ui.activeResult];
    // Enter runs the highlighted result, starred or not. Shift+Enter opens its
    // parameters instead, for when the saved values need a look first.
    if (job) ev.shiftKey ? toggleResult(job) : runJob(job);
  }
}

async function toggleStar(job) {
  if (starred.some(p => p.id === job.id)) {
    starred = await store.unstar(job.id);
    delete paramValues[job.id];
    if (ui.openId === job.id) ui.openId = null;
  } else {
    // Star immediately so the click feels instant, then fill in the parameters.
    starred = await store.star({
      id: job.id, url: job.url, name: job.name,
      fullName: job.fullName, folder: job.fullName,
      params: [], lastRunAt: job.lastBuildAt ?? null
    });
    renderResults();
    renderStarred();
    try {
      const meta = await jenkins.getJobMeta(job.url, config);
      starred = await store.star({
        id: job.id, name: meta.name, fullName: meta.fullName || job.fullName,
        folder: meta.fullName || job.fullName, params: meta.params, lastRunAt: meta.lastBuildAt
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
  const host = clear($('#activity'));

  // With nothing starred there is nothing that could have been triggered, so the
  // empty box would just stack a second empty state above the starred one.
  host.hidden = !runs.length && !starred.length;
  if (host.hidden) return;

  if (!runs.length) {
    host.append(el('div', { class: 'empty-box', textContent: 'Nothing triggered from here yet.' }));
    return;
  }

  const list = el('div', { class: 'runs' });
  for (const run of runs) list.append(runCard(run));
  host.append(list);
}

function runCard(run) {
  const active = store.isActive(run);
  const dot = el('div', { class: `run-dot ${active ? 'active' : run.status}` });

  const buttons = [];
  if (active && run.url) {
    buttons.push(el('button', {
      class: 'abort-btn', textContent: 'Abort',
      onclick: e => abortRun(run, e.currentTarget)
    }));
  }
  if (run.url) {
    buttons.push(el('button', {
      class: 'run-icon-btn', title: 'Copy build URL',
      onclick: e => copyUrl(run.url, e.currentTarget)
    }, icon('copy', { size: 12 })));
  }
  if (!active) {
    buttons.push(el('button', {
      class: 'run-icon-btn', title: 'Dismiss',
      onclick: async () => { runs = await store.dismissRun(run.id); renderActivity(); renderFooter(); }
    }, icon('x', { size: 12 })));
  }

  return el('div', { class: 'run', dataset: { runId: run.id } }, [
    dot,
    el('div', { class: 'run-text' }, [
      el('div', { class: 'run-head' }, [
        el('span', { class: 'run-name', textContent: run.name }),
        run.build ? el('span', { class: 'run-build', textContent: `#${run.build}` }) : null
      ]),
      el('div', { class: 'run-meta', textContent: runMeta(run) }),
      paramsLine(run)
    ]),
    ...buttons
  ]);
}

// Checkboxes are stored as real booleans, so their type is enough to leave them
// out; a row full of FLAG=false says nothing about what this build was.
function paramsLine(run) {
  const shown = Object.entries(run.params || {})
    .filter(([, v]) => typeof v !== 'boolean' && String(v).trim() !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  return shown ? el('div', { class: 'run-params', textContent: shown, title: shown }) : null;
}

function runMeta(run) {
  if (run.status === 'QUEUED') return `Queued · ${run.why || elapsed(run.startedAt)}`;
  if (run.status === 'RUNNING') return `Running · ${elapsed(run.buildStartedAt || run.startedAt)}`;
  if (run.status === 'ERROR') return run.error || 'Failed to start';
  return `${run.status} · ${ago(run.finishedAt || run.startedAt)} ago`;
}

// Only the elapsed text changes every second, so patch it in place rather than
// re-rendering rows and stealing focus from anything the user is editing.
function tickElapsed() {
  for (const run of runs) {
    if (!store.isActive(run)) continue;
    const node = document.querySelector(`.run[data-run-id="${CSS.escape(run.id)}"] .run-meta`);
    if (node) node.textContent = runMeta(run);
  }
}

async function abortRun(run, btn) {
  btn.disabled = true;
  btn.textContent = 'Aborting…';
  try {
    await jenkins.abortBuild(run.url, config);
    await store.updateRun(run.id, { status: 'ABORTED', finishedAt: Date.now() });
  } catch (err) {
    await store.updateRun(run.id, { error: err.message });
  }
  runs = await store.getRuns();
  renderActivity();
  renderFooter();
}

async function copyUrl(url, btn) {
  try { await navigator.clipboard.writeText(url); } catch { return; }
  clear(btn).append(icon('check', { size: 12 }));
  setTimeout(() => { clear(btn).append(icon('copy', { size: 12 })); }, 1200);
}

/* ---------- starred ---------- */

function renderStarred() {
  const host = clear($('#starred'));
  if (!starred.length) {
    host.append(el('div', { class: 'empty-box', textContent: 'No pipelines starred yet. Search above, or add one by URL.' }));
    return;
  }
  for (const p of starred) host.append(pipelineCard(p));
}

function pipelineCard(p) {
  const open = ui.openId === p.id;
  const card = el('div', {
    class: `card${open ? ' open' : ''}`,
    dataset: { id: p.id }
  });

  card.addEventListener('dragstart', ev => {
    ui.dragId = p.id;
    ev.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragover', ev => {
    ev.preventDefault();
    if (!ui.dragId || ui.dragId === p.id) return;
    const host = $('#starred');
    const dragged = host.querySelector(`.card[data-id="${CSS.escape(ui.dragId)}"]`);
    if (!dragged) return;
    const after = card.compareDocumentPosition(dragged) & Node.DOCUMENT_POSITION_PRECEDING;
    host.insertBefore(dragged, after ? card.nextSibling : card);
  });
  card.addEventListener('dragend', () => { card.draggable = false; persistOrder(); });

  const runBtn = el('button', {
    class: 'run-btn',
    textContent: ui.busy.has(p.id) ? 'Starting…' : 'Run',
    disabled: ui.busy.has(p.id),
    onclick: e => { e.stopPropagation(); triggerPipeline(p); }
  });

  card.append(el('div', { class: 'card-row' }, [
    el('div', {
      class: 'grip', title: 'Drag to reorder',
      onmousedown: () => { card.draggable = true; },
      onmouseup: () => { card.draggable = false; }
    }, icon('grip', { size: 14 })),
    el('div', {
      class: 'card-main',
      onclick: () => { ui.openId = open ? null : p.id; renderStarred(); }
    }, [
      el('div', { class: 'card-title' }, [
        el('span', { class: 'card-name', textContent: p.name }),
        el('span', { class: 'caret' }, icon(open ? 'chevron-down' : 'chevron-right', { size: 12 }))
      ]),
      el('div', { class: 'card-summary', textContent: summaryFor(p) })
    ]),
    runBtn
  ]));

  if (open) card.append(paramPanel(p));
  return card;
}

async function persistOrder() {
  const host = $('#starred');
  host.querySelectorAll('.card.dragging').forEach(n => n.classList.remove('dragging'));
  ui.dragId = null;
  const ids = [...host.querySelectorAll('.card')].map(n => n.dataset.id);
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
  if (d.type === 'BooleanParameterDefinition') return d.default === true || d.default === 'true';
  if (d.choices?.length && (d.default === '' || d.default == null)) return d.choices[0];
  return d.default ?? '';
}

function summaryFor(p) {
  if (!p.params?.length) return 'no parameters';
  const vals = valuesFor(p);
  const parts = p.params
    .filter(d => d.type !== 'PasswordParameterDefinition')
    .map(d => `${d.name}=${vals[d.name]}`);
  const head = parts.slice(0, 2).join(', ');
  return head + (parts.length > 2 ? `  +${parts.length - 2}` : '');
}

function paramPanel(p, isStarred = true) {
  const panel = el('div', { class: 'panel' });
  const values = { ...valuesFor(p) };
  ui.drafts.set(p.id, values);
  const write = (key, v) => {
    values[key] = v;
    const summary = panel.parentElement?.querySelector('.card-summary');
    if (summary) summary.textContent = summaryFor(p);
  };

  for (const d of p.params || []) {
    panel.append(paramField(d, values[d.name], v => write(d.name, v)));
  }

  const trigger = el('button', {
    class: 'trigger-btn',
    textContent: ui.busy.has(p.id) ? 'Starting…' : 'Trigger build',
    disabled: ui.busy.has(p.id),
    onclick: () => triggerPipeline(p)
  });
  const sync = el('button', {
    class: 'outline-btn', title: 'Re-read parameters from Jenkins',
    textContent: 'Sync params',
    onclick: e => syncParams(p, e.currentTarget)
  });
  const starToggle = el('button', {
    class: `unstar-btn${isStarred ? '' : ' off'}`,
    title: isStarred ? 'Unstar' : 'Star',
    onclick: () => toggleStar({
      id: p.id, url: p.url, name: p.name,
      fullName: p.fullName, lastBuildAt: p.lastRunAt
    })
  }, icon('star', { size: 13, fill: isStarred }));

  panel.append(el('div', { class: 'panel-actions' }, [trigger, sync, starToggle]));

  const err = ui.errors.get(p.id);
  if (err) panel.append(el('div', { class: 'field-error', textContent: err }));

  panel.append(el('div', { class: 'panel-footer' }, [
    el('a', { href: p.url, target: '_blank', rel: 'noreferrer' },
      [document.createTextNode('open in Jenkins'), icon('external-link', { size: 11 })]),
    el('span', { textContent: p.lastRunAt ? `last run ${ago(p.lastRunAt)} ago` : 'never run' })
  ]));

  return panel;
}

function paramField(d, value, onWrite) {
  if (d.type === 'BooleanParameterDefinition') {
    const box = el('input', {
      type: 'checkbox', checked: value === true || value === 'true',
      onchange: e => onWrite(e.target.checked)
    });
    return el('label', { class: 'pbool' }, [box, el('span', { textContent: d.name })]);
  }

  const label = el('div', { class: 'plabel' }, [
    el('span', { class: 'pkey', textContent: d.name }),
    d.description ? el('span', { class: 'pdesc', textContent: stripHtml(d.description) }) : null
  ]);

  let input;
  if (d.choices?.length) {
    input = el('select', { onchange: e => onWrite(e.target.value) });
    for (const c of d.choices) input.append(el('option', { value: c, textContent: c, selected: c === value }));
  } else if (d.type === 'PasswordParameterDefinition') {
    input = el('input', { type: 'password', value: '', oninput: e => onWrite(e.target.value) });
  } else {
    input = el('input', { type: 'text', value: value ?? '', oninput: e => onWrite(e.target.value) });
  }

  return el('div', { class: 'pfield' }, [label, input]);
}

const stripHtml = s => s.replace(/<[^>]*>/g, '').trim();

async function syncParams(p, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  try {
    const meta = await jenkins.getJobMeta(p.url, config);
    // Keep the values the user already set wherever the key survived.
    const kept = {};
    const current = valuesFor(p);
    for (const d of meta.params) {
      kept[d.name] = current[d.name] !== undefined ? current[d.name] : defaultFor(d);
    }
    ui.drafts.set(p.id, kept);
    await store.setParamValues(p.id, stripSecrets(meta.params, kept));
    paramValues[p.id] = stripSecrets(meta.params, kept);
    starred = await store.star({ id: p.id, name: meta.name, params: meta.params, lastRunAt: meta.lastBuildAt });
    ui.errors.delete(p.id);
    btn.textContent = 'Synced ✓';
    setTimeout(() => { renderStarred(); }, 1400);
  } catch (err) {
    ui.errors.set(p.id, err.message);
    btn.disabled = false;
    btn.textContent = original;
    renderStarred();
  }
}

/* ---------- triggering ---------- */

function stripSecrets(defs, values) {
  const out = { ...values };
  for (const d of defs || []) if (d.type === 'PasswordParameterDefinition') delete out[d.name];
  return out;
}

async function triggerPipeline(p) {
  if (ui.busy.has(p.id)) return;
  const fromSearch = Boolean(ui.query.trim());
  ui.busy.add(p.id);
  ui.errors.delete(p.id);
  fromSearch ? renderResults() : renderStarred();

  const params = valuesFor(p);
  const persist = stripSecrets(p.params, params);

  const res = await chrome.runtime.sendMessage({
    type: 'trigger',
    pipelineId: p.id,
    params,
    persist,
    // Sent so the worker can run a pipeline that was never starred.
    job: { id: p.id, url: p.url, name: p.name }
  }).catch(err => ({ ok: false, error: err.message }));

  ui.busy.delete(p.id);

  if (!res?.ok) {
    ui.errors.set(p.id, res?.error || 'Trigger failed.');
    if (fromSearch) ui.openResult = p.id; else ui.openId = p.id;
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
  const parts = [`${starred.length} starred`];
  if (running) parts.push(`${running} running`);
  $('#status-line').textContent = parts.join(' · ');

  const toggle = clear($('#add-toggle'));
  toggle.append(icon(ui.addOpen ? 'minus' : 'plus', { size: 12 }),
    document.createTextNode(ui.addOpen ? 'Hide URL field' : 'Add pipeline by URL'));
  $('#add-row').hidden = !ui.addOpen;
}

function toggleAdd() {
  ui.addOpen = !ui.addOpen;
  renderFooter();
  if (ui.addOpen) $('#add-url').focus();
  else { $('#add-error').hidden = true; }
}

async function onAdd() {
  const input = $('#add-url');
  const btn = $('#add-btn');
  const err = $('#add-error');
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = '…';

  try {
    const url = jenkins.normalizeJobUrl(input.value);
    const granted = await chrome.permissions.request({ origins: [jenkins.originOf(url)] });
    if (!granted) throw new Error('Permission for that host was declined.');

    if (!config.baseUrl) config = await store.saveConfig({ baseUrl: jenkins.rootOf(url) });

    const meta = await jenkins.getJobMeta(url, config);
    if (meta.isFolder) throw new Error('That is a folder, not a runnable job. Open it and copy a job URL.');

    starred = await store.star({
      id: url, url, name: meta.name,
      fullName: meta.fullName, folder: meta.fullName,
      params: meta.params, lastRunAt: meta.lastBuildAt
    });
    input.value = '';
    ui.addOpen = false;
    renderAll();
    refreshConnection();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add';
  }
}

/* ---------- reacting to background writes ---------- */

async function onStorageChanged(changes, area) {
  if (area === 'local' && changes.runs) {
    runs = changes.runs.newValue || [];
    renderActivity();
    renderFooter();
  }
  if (area === 'sync' && changes.starred) {
    starred = changes.starred.newValue || [];
    renderStarred();
    renderActivity();
    renderFooter();
  }
  if (area === 'sync' && changes.paramValues) {
    paramValues = changes.paramValues.newValue || {};
  }
  if (area === 'sync' && changes.config) {
    config = await store.getConfig();
    renderHeader();
  }
}
