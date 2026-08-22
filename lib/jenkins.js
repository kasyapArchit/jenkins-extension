// Thin Jenkins REST client. Every call runs from an extension page or the
// service worker, where declared host permissions exempt us from CORS, so
// response headers such as Location are readable.

export class JenkinsError extends Error {
  constructor(message, kind, status) {
    super(message);
    this.name = 'JenkinsError';
    this.kind = kind;       // 'network' | 'auth' | 'notfound' | 'http'
    this.status = status ?? null;
  }
}

/* ---------- URL handling ---------- */

export function normalizeJobUrl(input) {
  const u = new URL(input.trim());
  const parts = u.pathname.split('/').filter(Boolean);

  // Jenkins may sit under a reverse-proxy context path such as /jenkins.
  // Keep whatever precedes the first Jenkins-owned segment.
  let i = 0;
  const prefix = [];
  while (i < parts.length && parts[i] !== 'job' && parts[i] !== 'view') {
    prefix.push(parts[i]);
    i++;
  }

  // From here on, consume view/<name> and job/<name> pairs. Only jobs survive.
  const path = [];
  for (; i < parts.length; i++) {
    if ((parts[i] === 'job' || parts[i] === 'view') && parts[i + 1]) {
      if (parts[i] === 'job') path.push('job', decodeURIComponent(parts[i + 1]));
      i++;
    }
  }
  if (!path.length) throw new JenkinsError('That URL has no /job/ segment in it.', 'notfound');

  const encoded = path.map((s, n) => (n % 2 ? encodeURIComponent(s) : s));
  return [u.origin, ...prefix, ...encoded].join('/');
}

export const originOf = url => new URL(url).origin + '/*';

// The Jenkins root for any controller URL, keeping a reverse-proxy context
// path. More reliable than config.baseUrl when jobs live on more than one
// controller. Works for job, build and queue URLs alike.
const ROOT_MARKERS = ['/job/', '/queue/', '/view/', '/computer/'];

export function rootOf(url) {
  const u = new URL(url);
  let cut = -1;
  for (const m of ROOT_MARKERS) {
    const i = u.pathname.indexOf(m);
    if (i >= 0 && (cut < 0 || i < cut)) cut = i;
  }
  return u.origin + (cut >= 0 ? u.pathname.slice(0, cut) : u.pathname.replace(/\/+$/, ''));
}

export function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

// Jenkins returns absolute URLs built from its own configured root, which is
// often wrong behind a proxy. Re-home them onto the URL we actually reached.
function rehome(url, root) {
  if (!url) return url;
  try {
    const rootU = new URL(root);
    const u = new URL(url);
    const base = rootU.pathname.replace(/\/+$/, '');
    const path = u.pathname.startsWith(base) ? u.pathname : base + u.pathname;
    return rootU.origin + path;
  } catch {
    return url;
  }
}

/* ---------- transport ---------- */

function authHeaders(config) {
  if (config.authMode !== 'token') return {};
  if (!config.userId || !config.token) return {};
  return { Authorization: 'Basic ' + btoa(`${config.userId}:${config.token}`) };
}

async function request(url, config, init = {}) {
  let res;
  try {
    res = await fetch(url, {
      ...init,
      credentials: config.authMode === 'cookie' ? 'include' : 'omit',
      headers: { ...authHeaders(config), ...(init.headers || {}) }
    });
  } catch (cause) {
    throw new JenkinsError('Could not reach the Jenkins controller. Are you on the VPN?', 'network');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw describeFailure(res, body);
  }
  return res;
}

function describeFailure(res, body) {
  if (res.status === 401) {
    return new JenkinsError('Jenkins rejected the credentials. Check the user ID and API token.', 'auth', 401);
  }
  if (res.status === 403) {
    const msg = /crumb/i.test(body)
      ? 'Jenkins wants a CSRF crumb. Switch auth to API token, or log in to Jenkins in this browser.'
      : 'Not permitted. The account may lack Build permission on this job.';
    return new JenkinsError(msg, 'auth', 403);
  }
  if (res.status === 404) {
    return new JenkinsError('Not found. The job path may be wrong, or the job was renamed.', 'notfound', 404);
  }
  const snippet = body.slice(0, 160).replace(/\s+/g, ' ').trim();
  return new JenkinsError(`Jenkins returned ${res.status}${snippet ? `: ${snippet}` : ''}`, 'http', res.status);
}

export async function getJson(url, config) {
  return (await request(url, config)).json();
}

/* ---------- connection ---------- */

// Resolves to 'online' | 'offline' | 'unauthorized'. Never throws.
export async function probe(config) {
  const base = (config.baseUrl || '').replace(/\/+$/, '');
  if (!base) return 'offline';
  try {
    const me = await getJson(`${base}/me/api/json?tree=id,fullName`, config);
    return me.id && me.id !== 'anonymous' ? 'online' : 'unauthorized';
  } catch (err) {
    if (err.kind === 'auth') return 'unauthorized';
    if (err.kind === 'network') return 'offline';
    return 'unauthorized';
  }
}

export async function whoAmI(config) {
  const base = config.baseUrl.replace(/\/+$/, '');
  return getJson(`${base}/me/api/json?tree=id,fullName`, config);
}

/* ---------- job index (search) ---------- */

const LEAF = 'name,fullName,url,_class,buildable,lastBuild[number,timestamp,result]';
const FOLDERISH = /Folder|MultiBranchProject|OrganizationFolder/;

function jobsTree(depth) {
  let inner = LEAF;
  for (let i = 0; i < depth; i++) inner = `${LEAF},jobs[${inner}]`;
  return `jobs[${inner}]`;
}

// Flat list of every runnable job the account can see, to the configured depth.
export async function fetchJobIndex(config) {
  const base = (config.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new JenkinsError('No Jenkins base URL configured.', 'notfound');

  const tree = jobsTree(Math.max(1, Math.min(6, config.searchDepth ?? 3)));
  const data = await getJson(`${base}/api/json?tree=${encodeURIComponent(tree)}`, config);

  const out = [];
  const walk = jobs => {
    for (const j of jobs || []) {
      if (FOLDERISH.test(j._class || '')) {
        walk(j.jobs);
        continue;
      }
      if (j.buildable === false) continue;
      const url = rehome(j.url, base).replace(/\/+$/, '');
      out.push({
        id: url,
        url,
        name: j.name || (j.fullName || '').split('/').pop(),
        fullName: j.fullName || j.name || '',
        lastBuildAt: j.lastBuild?.timestamp ?? null,
        lastResult: j.lastBuild?.result ?? null
      });
      walk(j.jobs);   // multibranch children arrive nested under a buildable parent
    }
  };
  walk(data.jobs);

  const seen = new Set();
  return out.filter(j => (seen.has(j.id) ? false : seen.add(j.id)));
}

/* ---------- job metadata ---------- */

const JOB_TREE = [
  'name',
  'displayName',
  'fullName',
  'buildable',
  '_class',
  'lastBuild[number,timestamp,result]',
  'property[parameterDefinitions[name,type,description,choices,defaultParameterValue[value]]]'
].join(',');

export async function getJobMeta(jobUrl, config) {
  const data = await getJson(`${jobUrl}/api/json?tree=${encodeURIComponent(JOB_TREE)}`, config);
  const params = (data.property || [])
    .flatMap(p => p.parameterDefinitions || [])
    .map(d => ({
      name: d.name,
      type: d.type || (d._class || '').split('.').pop() || 'StringParameterDefinition',
      description: d.description || '',
      choices: d.choices || null,
      default: d.defaultParameterValue ? d.defaultParameterValue.value : ''
    }));
  return {
    name: data.displayName || data.name || data.fullName || jobUrl,
    fullName: data.fullName || '',
    buildable: data.buildable !== false,
    isFolder: FOLDERISH.test(data._class || ''),
    lastBuildAt: data.lastBuild?.timestamp ?? null,
    params
  };
}

/* ---------- triggering ---------- */

async function getCrumb(jobUrl, config) {
  try {
    const c = await getJson(`${rootOf(jobUrl)}/crumbIssuer/api/json`, config);
    return { [c.crumbRequestField]: c.crumb };
  } catch {
    return {};   // CSRF protection may be off; let the POST decide.
  }
}

// Returns the queue item URL Jenkins hands back in the Location header.
export async function triggerBuild(jobUrl, params, config) {
  const hasParams = Object.keys(params).length > 0;
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.append(k, String(v));

  const crumb = config.authMode === 'cookie' ? await getCrumb(jobUrl, config) : {};
  const res = await request(`${jobUrl}/${hasParams ? 'buildWithParameters' : 'build'}`, config, {
    method: 'POST',
    headers: { ...crumb, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: hasParams ? body.toString() : undefined
  });

  const loc = res.headers.get('Location');
  return loc ? rehome(loc, rootOf(jobUrl)).replace(/\/+$/, '') + '/' : null;
}

export async function abortBuild(buildUrl, config) {
  const crumb = config.authMode === 'cookie' ? await getCrumb(buildUrl, config) : {};
  await request(`${buildUrl.replace(/\/+$/, '')}/stop`, config, { method: 'POST', headers: crumb });
}

/* ---------- polling ---------- */

export async function getQueueItem(queueUrl, config) {
  const item = await getJson(
    `${queueUrl}api/json?tree=id,why,cancelled,blocked,stuck,executable[number,url]`, config);
  if (item.executable?.url) {
    item.executable.url = rehome(item.executable.url, rootOf(queueUrl));
  }
  return item;
}

export async function getBuild(buildUrl, config) {
  const base = buildUrl.replace(/\/+$/, '');
  return getJson(`${base}/api/json?tree=number,building,result,timestamp,estimatedDuration`, config);
}
