// Thin Jenkins REST client. Every call runs from an extension page or the
// service worker, where declared host permissions exempt us from CORS, so
// response headers such as Location are readable.

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
  if (!path.length) throw new Error('That URL has no /job/ segment in it.');

  const encoded = path.map((s, n) => (n % 2 ? encodeURIComponent(s) : s));
  return [u.origin, ...prefix, ...encoded].join('/');
}

export function originOf(url) {
  return new URL(url).origin + '/*';
}

function authHeaders(settings) {
  if (settings.authMode !== 'token') return {};
  if (!settings.username || !settings.token) return {};
  return { Authorization: 'Basic ' + btoa(`${settings.username}:${settings.token}`) };
}

function credentialsMode(settings) {
  return settings.authMode === 'cookie' ? 'include' : 'omit';
}

async function request(url, settings, init = {}) {
  const res = await fetch(url, {
    ...init,
    credentials: credentialsMode(settings),
    headers: { ...authHeaders(settings), ...(init.headers || {}) }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(describeFailure(res, body));
  }
  return res;
}

function describeFailure(res, body) {
  if (res.status === 401) return 'Jenkins rejected the credentials (401). Check the user ID and API token.';
  if (res.status === 403) {
    if (/crumb/i.test(body)) return 'Jenkins wants a CSRF crumb (403). Switch auth mode to API token, or log in to Jenkins in this browser.';
    return 'Not permitted (403). The account may lack Build permission on this job.';
  }
  if (res.status === 404) return 'Not found (404). The job path may be wrong, or the job was renamed.';
  const snippet = body.slice(0, 160).replace(/\s+/g, ' ').trim();
  return `Jenkins returned ${res.status}${snippet ? `: ${snippet}` : ''}`;
}

export async function getJson(url, settings) {
  const res = await request(url, settings);
  return res.json();
}

export async function whoAmI(settings) {
  const base = settings.baseUrl.replace(/\/+$/, '');
  return getJson(`${base}/me/api/json?tree=id,fullName`, settings);
}

const JOB_TREE = [
  'displayName',
  'fullName',
  'buildable',
  '_class',
  'property[parameterDefinitions[name,type,description,choices,defaultParameterValue[value]]]'
].join(',');

export async function getJobMeta(jobUrl, settings) {
  const data = await getJson(`${jobUrl}/api/json?tree=${encodeURIComponent(JOB_TREE)}`, settings);
  const defs = (data.property || [])
    .flatMap(p => p.parameterDefinitions || [])
    .map(d => ({
      name: d.name,
      type: d.type || (d._class || '').split('.').pop() || 'StringParameterDefinition',
      description: d.description || '',
      choices: d.choices || null,
      default: d.defaultParameterValue ? d.defaultParameterValue.value : ''
    }));
  return {
    displayName: data.displayName || data.fullName || jobUrl,
    fullName: data.fullName || '',
    buildable: data.buildable !== false,
    isFolder: /Folder|MultiBranch|OrganizationFolder/.test(data._class || ''),
    params: defs
  };
}

// The Jenkins root for a job URL, keeping any reverse-proxy context path.
// More reliable than settings.baseUrl when jobs live on more than one controller.
export function rootOf(jobUrl) {
  const u = new URL(jobUrl);
  const cut = u.pathname.indexOf('/job/');
  const path = cut >= 0 ? u.pathname.slice(0, cut) : '';
  return u.origin + path;
}

async function getCrumb(jobUrl, settings) {
  const base = rootOf(jobUrl);
  try {
    const c = await getJson(`${base}/crumbIssuer/api/json`, settings);
    return { [c.crumbRequestField]: c.crumb };
  } catch {
    return {};   // CSRF protection may be disabled; let the POST decide.
  }
}

// Returns the queue item URL Jenkins hands back in the Location header.
export async function triggerBuild(jobUrl, params, settings) {
  const hasParams = Object.keys(params).length > 0;
  const endpoint = `${jobUrl}/${hasParams ? 'buildWithParameters' : 'build'}`;
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.append(k, String(v));

  const headers = settings.authMode === 'cookie' ? await getCrumb(jobUrl, settings) : {};
  const res = await request(endpoint, settings, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: hasParams ? body.toString() : undefined
  });

  const loc = res.headers.get('Location');
  return loc ? loc.replace(/\/+$/, '') + '/' : null;
}

export async function getQueueItem(queueUrl, settings) {
  return getJson(`${queueUrl}api/json?tree=id,why,cancelled,blocked,stuck,executable[number,url]`, settings);
}

export async function getBuild(buildUrl, settings) {
  const url = buildUrl.replace(/\/+$/, '') + '/api/json?tree=number,building,result,timestamp,estimatedDuration,url';
  return getJson(url, settings);
}
