// node test/normalize.test.mjs
import { normalizeJobUrl, originOf } from '../lib/jenkins.js';

const cases = [
  ['https://jenkins.corp/job/Deploy/',                          'https://jenkins.corp/job/Deploy'],
  ['https://jenkins.corp/job/Platform/job/api-deploy/',          'https://jenkins.corp/job/Platform/job/api-deploy'],
  ['https://jenkins.corp/job/Platform/job/api-deploy/482/console','https://jenkins.corp/job/Platform/job/api-deploy'],
  ['https://jenkins.corp/view/Prod/job/Platform/job/api/482/',    'https://jenkins.corp/job/Platform/job/api'],
  ['https://jenkins.corp/job/A/job/feature%2Fmine/',              'https://jenkins.corp/job/A/job/feature%2Fmine'],
  ['https://jenkins.corp/job/My%20Job/build?delay=0sec',          'https://jenkins.corp/job/My%20Job'],
  ['https://jenkins.corp:8443/jenkins/job/X/',                    'https://jenkins.corp:8443/jenkins/job/X'],
  ['https://ci.corp/jenkins/view/Prod/job/A/job/b/12/console',     'https://ci.corp/jenkins/job/A/job/b'],
  ['https://ci.corp/ci/tools/jenkins/job/A/job/b/',                'https://ci.corp/ci/tools/jenkins/job/A/job/b'],
];

let failed = 0;
for (const [input, want] of cases) {
  const got = normalizeJobUrl(input);
  if (got !== want) { failed++; console.error(`FAIL ${input}\n  got  ${got}\n  want ${want}`); }
}

for (const bad of ['https://jenkins.corp/view/all/', 'https://jenkins.corp/']) {
  try { normalizeJobUrl(bad); failed++; console.error(`FAIL should reject ${bad}`); }
  catch { /* expected */ }
}

if (originOf('https://jenkins.corp:8443/jenkins/job/X') !== 'https://jenkins.corp:8443/*') {
  failed++; console.error('FAIL originOf');
}

console.log(failed ? `${failed} failing` : `${cases.length + 3} assertions passed`);
process.exit(failed ? 1 : 0);
