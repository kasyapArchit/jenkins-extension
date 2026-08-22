import * as store from './lib/storage.js';
import * as jenkins from './lib/jenkins.js';

const $ = sel => document.querySelector(sel);
const el = (tag, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of [].concat(kids)) if (k) n.append(k);
  return n;
};

let settings, pipelines, runs;
const open = new Set();      // pipeline ids whose parameter form is expanded

init();

async function init() {
  [settings, pipelines, runs] = await Promise.all([
    store.getSettings(), store.getPipelines(), store.getRuns()
  ]);

  $('#settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('#refresh').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'poll' }));
  $('#clear-runs').addEventListener('click', async () => {
    runs = await store.clearFinishedRuns();
    renderRuns();
  });
  $('#add-form').addEventListener('submit', onAdd);

  chrome.storage.onChanged.addListener(async changes => {
    if (changes.runs) { runs = changes.runs.newValue || []; renderRuns(); }
    if (changes.pipelines) { pipelines = changes.pipelines.newValue || []; renderPipelines(); }
  });

  render();
  chrome.runtime.sendMessage({ type: 'poll' });
}

function render() {
  if (!settings.baseUrl) {
    banner('Set your Jenkins URL and API token in settings first.', true);
  } else if (settings.authMode === 'token' && !settings.token) {
    banner('No API token saved. Open settings to add one.', true);
  }
  renderRuns();
  renderPipelines();
}

function banner(text, isError) {
  const b = $('#banner');
  b.textContent = text;
  b.classList.toggle('error', !!isError);
  b.hidden = false;
}

/* ---------- runs ---------- */

function renderRuns() {
  const list = $('#run-list');
  list.textContent = '';
  const recent = runs.slice(0, 6);
  $('#runs').hidden = recent.length === 0;

  for (const r of recent) {
    const state = r.state === 'done' ? (r.result || 'UNKNOWN') : r.state;
    const label = r.number ? `${r.pipelineName} #${r.number}` : r.pipelineName;
    const link = el('a', { href: r.buildUrl || r.jobUrl, target: '_blank' }, [
      el('span', { className: 'name', textContent: label }),
      el('span', { className: 'sub', textContent: subtitle(r) })
    ]);
    list.append(el('li', { className: 'run' }, [el('span', { className: `dot ${state}` }), link]));
  }
}

function subtitle(r) {
  if (r.state === 'queued') return r.why || 'queued';
  if (r.state === 'building') return progressText(r);
  if (r.state === 'error') return r.error || 'error';
  return `${r.result || 'finished'} · ${ago(r.startedAt)}`;
}

function progressText(r) {
  const started = r.buildStartedAt || r.startedAt;
  const elapsed = Date.now() - started;
  if (r.estimatedDuration > 0) {
    const pct = Math.min(99, Math.round((elapsed / r.estimatedDuration) * 100));
    return `building · ~${pct}%`;
  }
  return `building · ${duration(elapsed)}`;
}

function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function ago(ts) {
  const ms = Date.now() - ts;
  return ms < 60000 ? 'just now' : `${duration(ms)} ago`;
}

/* ---------- pipelines ---------- */

function renderPipelines() {
  const list = $('#pipeline-list');
  list.textContent = '';
  $('#empty').hidden = pipelines.length > 0;

  for (const p of pipelines) {
    const li = el('li', { className: 'pipeline' });
    const caret = el('button', {
      className: 'icon-btn',
      textContent: open.has(p.id) ? '▾' : '▸',
      title: p.params?.length ? 'Edit parameters' : 'Options'
    });
    const runBtn = el('button', { className: 'run-btn', textContent: 'Run' });

    caret.addEventListener('click', () => {
      open.has(p.id) ? open.delete(p.id) : open.add(p.id);
      renderPipelines();
    });
    runBtn.addEventListener('click', () => doTrigger(p, effectiveValues(p), li, runBtn));

    li.append(el('div', { className: 'row' }, [
      caret,
      el('div', { className: 'title' }, [
        el('b', { textContent: p.name }),
        el('span', { textContent: paramSummary(p) })
      ]),
      runBtn
    ]));

    if (open.has(p.id)) li.append(paramForm(p, li));
    list.append(li);
  }
}

function paramSummary(p) {
  if (!p.params?.length) return 'no parameters';
  const vals = effectiveValues(p);
  const shown = p.params
    .filter(d => d.type !== 'PasswordParameterDefinition')
    .slice(0, 3)
    .map(d => `${d.name}=${truncate(String(vals[d.name] ?? ''), 14)}`);
  const extra = p.params.length - shown.length;
  return shown.join(', ') + (extra > 0 ? ` +${extra}` : '');
}

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s || '–');

function effectiveValues(p) {
  const out = {};
  for (const d of p.params || []) {
    const saved = p.lastValues?.[d.name];
    out[d.name] = saved !== undefined ? saved : normalizeDefault(d);
  }
  return out;
}

function normalizeDefault(d) {
  if (d.type === 'BooleanParameterDefinition') return d.default === true || d.default === 'true';
  if (d.choices?.length && (d.default === '' || d.default == null)) return d.choices[0];
  return d.default ?? '';
}

function paramForm(p, li) {
  const wrap = el('div', { className: 'params' });
  const values = effectiveValues(p);
  const inputs = {};

  for (const d of p.params || []) {
    const id = `f-${p.id}-${d.name}`;
    if (d.type === 'BooleanParameterDefinition') {
      const box = el('input', { type: 'checkbox', id, checked: values[d.name] === true || values[d.name] === 'true' });
      inputs[d.name] = () => box.checked;
      wrap.append(el('div', { className: 'field bool' }, [box, el('label', { htmlFor: id, textContent: d.name })]));
      continue;
    }

    let input;
    if (d.choices?.length) {
      input = el('select', { id });
      for (const c of d.choices) input.append(el('option', { value: c, textContent: c, selected: c === values[d.name] }));
    } else if (d.type === 'TextParameterDefinition') {
      input = el('textarea', { id, rows: 3, value: values[d.name] ?? '' });
    } else if (d.type === 'PasswordParameterDefinition') {
      input = el('input', { type: 'password', id, value: '' });
    } else {
      input = el('input', { type: 'text', id, value: values[d.name] ?? '' });
    }
    inputs[d.name] = () => input.value;

    const label = el('label', { htmlFor: id, textContent: d.name });
    if (d.description) label.append(el('span', { className: 'desc', textContent: stripHtml(d.description) }));
    wrap.append(el('div', { className: 'field' }, [label, input]));
  }

  const trigger = el('button', { className: 'run-btn', textContent: 'Trigger build' });
  const refresh = el('button', { className: 'ghost-btn', textContent: 'Sync params' });
  const remove = el('button', { className: 'ghost-btn danger', textContent: 'Remove' });
  const idx = pipelines.findIndex(x => x.id === p.id);
  const up = el('button', { className: 'icon-btn', textContent: '\u25b2', title: 'Move up', disabled: idx <= 0 });
  const down = el('button', { className: 'icon-btn', textContent: '\u25bc', title: 'Move down', disabled: idx === pipelines.length - 1 });

  up.addEventListener('click', () => reorder(p.id, -1));
  down.addEventListener('click', () => reorder(p.id, 1));

  trigger.addEventListener('click', () => {
    const params = {};
    for (const [name, read] of Object.entries(inputs)) params[name] = read();
    doTrigger(p, params, li, trigger);
  });
  refresh.addEventListener('click', () => syncParams(p, li, refresh));
  remove.addEventListener('click', async () => {
    open.delete(p.id);
    pipelines = await store.removePipeline(p.id);
    renderPipelines();
  });

  wrap.append(el('div', { className: 'params-actions' }, [
    trigger,
    el('a', { href: p.url, target: '_blank', className: 'link-btn', textContent: 'open in Jenkins' }),
    el('span', { className: 'spacer' }),
    up, down,
    refresh,
    remove
  ]));
  return wrap;
}

const stripHtml = s => s.replace(/<[^>]*>/g, '').trim();

async function reorder(id, delta) {
  pipelines = await store.movePipeline(id, delta);
  renderPipelines();
}

/* ---------- actions ---------- */

async function doTrigger(p, params, li, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Starting…';
  clearRowError(li);

  // Password values are sent but never stored.
  const persist = { ...params };
  for (const d of p.params || []) {
    if (d.type === 'PasswordParameterDefinition') delete persist[d.name];
  }

  const res = await chrome.runtime.sendMessage({ type: 'trigger', pipelineId: p.id, params, persist });
  btn.disabled = false;
  btn.textContent = original;

  if (!res?.ok) return rowError(li, res?.error || 'Trigger failed.');
  open.delete(p.id);
  runs = await store.getRuns();
  pipelines = await store.getPipelines();
  render();
}

async function syncParams(p, li, btn) {
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Syncing…';
  try {
    const meta = await jenkins.getJobMeta(p.url, settings);
    pipelines = await store.upsertPipeline({ id: p.id, name: meta.displayName, params: meta.params });
    renderPipelines();
  } catch (err) {
    rowError(li, err.message);
    btn.disabled = false;
    btn.textContent = original;
  }
}

function rowError(li, text) {
  clearRowError(li);
  li.append(el('div', { className: 'row-error', textContent: text }));
}
function clearRowError(li) {
  li.querySelectorAll('.row-error').forEach(n => n.remove());
}

async function onAdd(ev) {
  ev.preventDefault();
  const input = $('#add-url');
  const btn = $('#add-btn');
  btn.disabled = true;
  btn.textContent = '…';

  try {
    const url = jenkins.normalizeJobUrl(input.value);
    const granted = await chrome.permissions.request({ origins: [jenkins.originOf(url)] });
    if (!granted) throw new Error('Permission for that host was declined.');

    if (!settings.baseUrl) settings = await store.saveSettings({ baseUrl: new URL(url).origin });

    const meta = await jenkins.getJobMeta(url, settings);
    if (meta.isFolder) throw new Error('That is a folder, not a runnable job. Open it and copy a job URL.');

    pipelines = await store.upsertPipeline({
      id: url,
      url,
      name: meta.displayName,
      fullName: meta.fullName,
      params: meta.params,
      lastValues: {}
    });
    input.value = '';
    $('#banner').hidden = true;
    renderPipelines();
  } catch (err) {
    banner(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add';
  }
}
