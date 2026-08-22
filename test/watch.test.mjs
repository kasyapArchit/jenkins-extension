// node test/watch.test.mjs
import { nextEvent, eventTime, isStale, wants, anyWanted, STALE_MS } from '../lib/watch.js';

let failed = 0;
const is = (got, want, label) => {
  if (got !== want) { failed++; console.error(`FAIL ${label}\n  got  ${got}\n  want ${want}`); }
};

const running = n => ({ number: n, building: true, result: null, timestamp: 1000 });
const ok = n => ({ number: n, building: false, result: 'SUCCESS', timestamp: 1000, duration: 60 });
const bad = n => ({ number: n, building: false, result: 'FAILURE', timestamp: 1000, duration: 60 });
const mark = (number, building) => ({ number, building });

/* first sight is recorded silently, or subscribing announces the last build */
is(nextEvent(null, ok(10))?.kind, null, 'first sight says nothing');
is(nextEvent(null, ok(10))?.mark.number, 10, 'first sight still records');
is(nextEvent(undefined, running(10))?.mark.building, true, 'first sight records building');

/* nothing changed */
is(nextEvent(mark(10, false), ok(10))?.kind, null, 'same finished build');
is(nextEvent(mark(10, true), running(10))?.kind, null, 'still building');

/* a build starts */
is(nextEvent(mark(10, false), running(11))?.kind, 'started', 'new build running');
is(nextEvent(mark(10, false), running(11))?.mark.building, true, 'mark says building');

/* a build we were watching finishes */
is(nextEvent(mark(11, true), ok(11))?.kind, 'deployed', 'success');
is(nextEvent(mark(11, true), bad(11))?.kind, 'failed', 'failure');
is(nextEvent(mark(11, true), { ...bad(11), result: 'ABORTED' })?.kind, 'failed', 'aborted is a failure');
is(nextEvent(mark(11, true), ok(11))?.mark.building, false, 'mark says done');

/* started and finished inside one interval: report the finish, not the start */
is(nextEvent(mark(10, false), ok(11))?.kind, 'deployed', 'whole build within one poll');
is(nextEvent(mark(10, false), bad(11))?.kind, 'failed', 'whole failed build within one poll');

/* several builds went by; only the newest is reported */
is(nextEvent(mark(10, false), ok(14))?.kind, 'deployed', 'skipped builds');
is(nextEvent(mark(10, false), ok(14))?.mark.number, 14, 'watermark jumps to newest');

/* Jenkins briefly reports building:false with no result */
const limbo = { number: 12, building: false, result: null, timestamp: 1000 };
is(nextEvent(mark(11, false), limbo)?.kind, 'started', 'no verdict yet is not a failure');
is(nextEvent(mark(11, false), limbo)?.mark.building, true, 'unsettled stays marked building');
is(nextEvent(mark(12, true), limbo)?.kind, null, 'no verdict yet announces nothing');

/* a job that has never run */
is(nextEvent(null, null), null, 'no build at all');
is(nextEvent(mark(1, false), { number: null }), null, 'no build number');

/* when the event actually happened, not when it was noticed */
is(eventTime(ok(3), 'started'), 1000, 'start time');
is(eventTime(ok(3), 'deployed'), 1060, 'end time is start plus duration');
is(eventTime({ timestamp: 500 }, 'failed'), 500, 'missing duration');
is(eventTime(null, 'started'), 0, 'no build');

/* staleness */
is(isStale(1000, 1000 + STALE_MS), false, 'exactly at the limit is not stale');
is(isStale(1000, 1000 + STALE_MS + 1), true, 'past the limit is stale');
is(isStale(1000, 1000), false, 'just happened');
is(STALE_MS, 120000, 'two minutes');

/* which kinds are wanted */
is(wants('deployed', undefined), true, 'deployed on by default');
is(wants('started', undefined), false, 'started off by default');
is(wants('failed', undefined), true, 'failed on by default');
is(wants('started', { triggered: true }), true, 'started maps to the triggered setting');
is(wants('deployed', { deployed: false }), false, 'partial settings override');
is(wants('failed', { deployed: false }), true, 'partial settings keep other defaults');

is(anyWanted({ triggered: false, deployed: false, failed: false }), false, 'all off');
is(anyWanted({ triggered: false, deployed: false, failed: true }), true, 'one on');
is(anyWanted(undefined), true, 'defaults have something on');

console.log(failed ? `${failed} failing` : 'all watch assertions passed');
process.exit(failed ? 1 : 0);
