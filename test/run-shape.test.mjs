// node test/run-shape.test.mjs
//
// Guards the run record the popup renders. The params field was silently lost
// once when background.js was rewritten, and nothing failed.
import { newRun, isActive, RUNNING_STATES } from '../lib/store.js';

let failed = 0;
const check = (name, cond) => { if (!cond) { failed++; console.error(`FAIL ${name}`); } };

const params = { BRANCH: 'develop', CLEAN: false, CMD: 'qaStaging' };
const run = newRun({
  jobId: 'https://ci/job/A', name: 'A', fullName: 'Webmail/A', jobUrl: 'https://ci/job/A',
  queueUrl: 'https://ci/queue/item/9/', params, now: 1000
});

// Every field the popup reads must be present, params included.
for (const field of ['id', 'jobId', 'name', 'fullName', 'jobUrl', 'queueUrl', 'url', 'build',
                     'displayName', 'status', 'params', 'startedAt', 'finishedAt', 'error']) {
  check(`has ${field}`, field in run);
}

check('params round-trip', JSON.stringify(run.params) === JSON.stringify(params));
check('queued when Jenkins gave a queue url', run.status === 'QUEUED');
check('id is stable for a given clock', run.id === 'https://ci/job/A::1000');
check('starts active', isActive(run));
check('keeps the full path for the folder-qualified name', run.fullName === 'Webmail/A');
check('full path defaults to null', newRun({ jobId: 'x' }).fullName === null);
check('display name starts unset', run.displayName === null);

const noQueue = newRun({ jobId: 'x', name: 'x', jobUrl: 'u', queueUrl: null, params: {} });
check('running when there is no queue url', noQueue.status === 'RUNNING');
check('missing params default to an object', JSON.stringify(newRun({ jobId: 'x' }).params) === '{}');
check('active states are queued and running', RUNNING_STATES.join() === 'QUEUED,RUNNING');
check('finished runs are not active', !isActive({ ...run, status: 'SUCCESS' }));

console.log(failed ? `${failed} failing` : 'all run-shape assertions passed');
process.exit(failed ? 1 : 0);
