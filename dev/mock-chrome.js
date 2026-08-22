// Browser-only harness: stubs the extension APIs and a fake Jenkins so the
// popup can be opened directly for design work. Never loaded by the extension.

const areas = { sync: {}, local: {}, session: {} };
const changeListeners = [];

function makeArea(name) {
  return {
    async get(keys) {
      const src = areas[name];
      if (keys == null) return { ...src };
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      return Object.fromEntries(list.filter(k => k in src).map(k => [k, structuredClone(src[k])]));
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: areas[name][k], newValue: v };
        areas[name][k] = structuredClone(v);
      }
      changeListeners.forEach(fn => fn(changes, name));
    },
    async remove(key) {
      const keys = [].concat(key);
      const changes = {};
      for (const k of keys) { changes[k] = { oldValue: areas[name][k] }; delete areas[name][k]; }
      changeListeners.forEach(fn => fn(changes, name));
    }
  };
}

// Kept in step with lib/build.js by importing it at load time below.
let BUILD_STAMP = null;

globalThis.chrome = {
  storage: {
    sync: makeArea('sync'),
    local: makeArea('local'),
    session: makeArea('session'),
    onChanged: { addListener: fn => changeListeners.push(fn) }
  },
  runtime: {
    openOptionsPage: () => console.log('[mock] openOptionsPage'),
    async sendMessage(msg) {
      if (msg.type === 'trigger') {
        const runs = areas.local.runs || [];
        // Mirrors the worker: starred entry wins, otherwise the job the popup sent.
        const p = (areas.sync.starred || []).find(x => x.id === msg.pipelineId) || msg.job;
        runs.unshift({
          id: `${msg.pipelineId}::${Date.now()}`, jobId: msg.pipelineId, name: p.name,
          url: `${p.url}/${++BUILD}`, build: BUILD, status: 'RUNNING',
          params: msg.persist ?? msg.params,
          startedAt: Date.now(), finishedAt: null
        });
        await chrome.storage.local.set({ runs });
        return { ok: true };
      }
      if (msg.type === 'ping') {
        // ?stale reproduces Chrome keeping an old service worker after a reload.
        const stale = new URLSearchParams(location.search).has('stale');
        return { ok: true, data: { build: stale ? 'older' : BUILD_STAMP } };
      }
      if (msg.type === 'diagnose') {
        return { ok: true, data: { ok: true, who: 'Archit Kashyap', clientBuild: '2', hasToken: true } };
      }
      return { ok: true };
    }
  },
  permissions: { request: async () => true },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} }
};

let BUILD = 530;

import('../lib/build.js').then(m => { BUILD_STAMP = m.BUILD; });

/* ---------- fake Jenkins ---------- */

const CATALOG = [
  ['Frontend/QA', 'QA', 17],
  ['Frontend/web-prod-deploy', 'web-prod-deploy', 120],
  ['Frontend/Storybook-Deploy', 'Storybook-Deploy', 1440],
  ['Frontend/Neo-QA', 'Neo-QA', 240],
  ['Platform/api-integration-tests', 'api-integration-tests', 35],
  ['Platform/cache-purge', 'cache-purge', 4320],
  ['Mobile/android-nightly', 'android-nightly', 540],
  ['Tools/lint-all', 'lint-all', 360],
  ['Tools/dependency-audit', 'dependency-audit', 2880]
].map(([fullName, name, mins]) => ({
  fullName, name,
  url: `https://frontend-jenkins/job/${fullName.split('/').join('/job/')}`,
  lastBuild: { number: 500, timestamp: Date.now() - mins * 60000, result: 'SUCCESS' }
}));

const PARAMS = {
  QA: [
    { name: 'CLEAN_INSTALL', type: 'BooleanParameterDefinition', default: false },
    { name: 'DELETE_YARN_CACHE_DIR', type: 'BooleanParameterDefinition', default: false },
    { name: 'BRANCH', type: 'StringParameterDefinition', default: 'develop', description: 'Branch to run QA build on' },
    { name: 'BUILD_CMD', type: 'ChoiceParameterDefinition', default: 'qaStaging', description: 'Build command',
      choices: ['qaStaging', 'qaProd', 'qaNeoStaging', 'qaNeoProd', 'qaPendo', 'qaProdPendo'] }
  ],
  'web-prod-deploy': [
    { name: 'BRANCH', type: 'StringParameterDefinition', default: 'master', description: 'Release branch' },
    { name: 'SKIP_TESTS', type: 'BooleanParameterDefinition', default: false },
    { name: 'TARGET', type: 'ChoiceParameterDefinition', default: 'prod-eu', description: 'Cluster',
      choices: ['prod-eu', 'prod-us', 'prod-in'] }
  ],
  'Neo-QA': [
    { name: 'BRANCH', type: 'StringParameterDefinition', default: 'develop', description: 'Branch to build' },
    { name: 'SKIP_SNAPSHOTS', type: 'BooleanParameterDefinition', default: false },
    { name: 'REGION', type: 'ChoiceParameterDefinition', default: 'eu', description: 'Region', choices: ['eu','us','in'] }
  ],
  'Storybook-Deploy': [
    { name: 'BRANCH', type: 'StringParameterDefinition', default: 'develop', description: 'Branch to publish' },
    { name: 'REBUILD_CACHE', type: 'BooleanParameterDefinition', default: true }
  ]
};

const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

globalThis.fetch = async url => {
  const u = String(url);
  if (u.includes('/me/api/json')) return json({ id: 'a.kashyap', fullName: 'Archit Kashyap' });

  if (u.includes('/api/json') && u.includes('tree=jobs')) {
    const byFolder = {};
    for (const j of CATALOG) {
      const [folder] = j.fullName.split('/');
      (byFolder[folder] ||= []).push({ ...j, _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob', buildable: true });
    }
    return json({
      jobs: Object.entries(byFolder).map(([name, jobs]) => ({
        name, fullName: name, _class: 'com.cloudbees.hudson.plugins.folder.Folder',
        url: `https://frontend-jenkins/job/${name}`, jobs
      }))
    });
  }

  const jobMatch = u.match(/\/job\/([^/?]+)\/api\/json/);
  if (jobMatch) {
    const name = decodeURIComponent(jobMatch[1]);
    const meta = CATALOG.find(c => c.name === name) || CATALOG[0];
    return json({
      name, displayName: name, fullName: meta.fullName, buildable: true,
      _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob',
      lastBuild: meta.lastBuild,
      property: [{ parameterDefinitions: (PARAMS[name] || []).map(p => ({
        ...p, defaultParameterValue: { value: p.default } })) }]
    });
  }
  return json({});
};

/* ---------- seed ---------- */

const starredNames = ['QA', 'web-prod-deploy', 'Storybook-Deploy'];
const starred = starredNames.map(n => {
  const c = CATALOG.find(x => x.name === n);
  return {
    id: c.url, url: c.url, name: c.name, fullName: c.fullName, folder: c.fullName,
    params: (PARAMS[n] || []).map(p => ({
      name: p.name, type: p.type, description: p.description || '',
      choices: p.choices || null, default: p.default
    })),
    lastRunAt: c.lastBuild.timestamp
  };
});

areas.sync.config = {
  baseUrl: 'https://frontend-jenkins', authMode: 'token', userId: 'a.kashyap',
  pollSeconds: 30, notify: true, searchDepth: 3
};
areas.local.token = 'mock';
// ?empty exercises the fresh-profile state: nothing starred, nothing triggered.
const EMPTY = new URLSearchParams(location.search).has('empty');

areas.sync.starred = EMPTY ? [] : starred;
areas.sync.paramValues = EMPTY ? {} : {
  [starred[0].id]: { CLEAN_INSTALL: false, DELETE_YARN_CACHE_DIR: false, BRANCH: 'develop', BUILD_CMD: 'qaStaging' }
};
areas.local.runs = EMPTY ? [] : [
  { id: 'r1', jobId: starred[0].id, name: 'QA', build: 527, url: starred[0].url + '/527',
    params: { CLEAN_INSTALL: true, DELETE_YARN_CACHE_DIR: false, BRANCH: 'develop', BUILD_CMD: 'qaStaging' },
    status: 'RUNNING', startedAt: Date.now() - 119000, buildStartedAt: Date.now() - 119000 },
  { id: 'r2', jobId: starred[0].id, name: 'QA', build: 525, url: starred[0].url + '/525',
    params: { CLEAN_INSTALL: false, BRANCH: 'release/9.2', BUILD_CMD: 'qaProd' },
    status: 'SUCCESS', startedAt: Date.now() - 1080000, finishedAt: Date.now() - 1020000 },
  { id: 'r3', jobId: starred[1].id, name: 'web-prod-deploy', build: 88, url: starred[1].url + '/88',
    params: { BRANCH: 'master', TARGET: 'prod-eu' },
    status: 'FAILURE', startedAt: Date.now() - 7500000, finishedAt: Date.now() - 7200000 },
  { id: 'r4', jobId: starred[2].id, name: 'Storybook-Deploy', build: null, url: null,
    params: { BRANCH: 'feature/design-tokens' }, why: 'Waiting for next available executor',
    status: 'QUEUED', startedAt: Date.now() - 42000 },
  { id: 'r5', jobId: starred[1].id, name: 'web-prod-deploy', build: null, url: null,
    status: 'ERROR', error: 'Not permitted. The account may lack Build permission on this job.',
    startedAt: Date.now() - 300000, finishedAt: Date.now() - 300000 }
];
