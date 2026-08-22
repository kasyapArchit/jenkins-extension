// node test/guard.test.mjs
import { blockReason, isPatternBlock, firstBadPattern, compileDeny } from '../lib/guard.js';

const job = (id, fullName) => ({ id, fullName, name: fullName.split('/').pop() });
const QA = job('a', 'Frontend/QA');
const PROD = job('b', 'Frontend/web-prod-deploy');
const REL = job('c', 'Release/9.2/ship');

let failed = 0;
const is = (got, want, label) => {
  if (got !== want) { failed++; console.error(`FAIL ${label}\n  got  ${got}\n  want ${want}`); }
};

/* nothing configured lets everything through */
is(blockReason(QA), null, 'no options at all');
is(blockReason(QA, {}), null, 'empty options');
is(blockReason(QA, { blocked: [], patterns: [] }), null, 'empty lists');
is(blockReason(null, { blocked: ['a'] }), null, 'no pipeline');

/* blocked by hand, matched on id rather than on any part of the name */
is(blockReason(QA, { blocked: ['a'] }), 'blocked by hand', 'hand block');
is(blockReason(QA, { blocked: ['b'] }), null, 'another id blocked');

/* patterns match the full path, unanchored and case-insensitively */
is(blockReason(PROD, { patterns: ['prod'] }), 'blocked by the pattern prod', 'substring');
is(blockReason(PROD, { patterns: ['PROD'] }), 'blocked by the pattern PROD', 'case-insensitive');
is(blockReason(QA, { patterns: ['prod'] }), null, 'no match');
is(blockReason(REL, { patterns: ['^Release/'] }), 'blocked by the pattern ^Release/', 'anchored');
is(blockReason(PROD, { patterns: ['^Release/'] }), null, 'anchor excludes');
is(blockReason(PROD, { patterns: ['deploy$'] }), 'blocked by the pattern deploy$', 'end anchor');
is(blockReason(PROD, { patterns: ['nope', 'prod'] }), 'blocked by the pattern prod', 'second wins');

/* a folder name is part of the path, so it can block everything inside it */
is(blockReason(job('d', 'Prod/anything'), { patterns: ['^Prod/'] }),
   'blocked by the pattern ^Prod/', 'folder blocks its contents');

/* a root job with no path is still matchable by name */
is(blockReason({ id: 'e', name: 'prod-deploy' }, { patterns: ['prod'] }),
   'blocked by the pattern prod', 'falls back to the name');

/* a broken pattern is skipped rather than taking the good ones down */
is(blockReason(PROD, { patterns: ['[unclosed', 'prod'] }),
   'blocked by the pattern prod', 'bad pattern skipped');
is(blockReason(QA, { patterns: ['[unclosed'] }), null, 'only a bad pattern blocks nothing');
is(compileDeny(['[unclosed', 'ok']).length, 1, 'compileDeny drops the broken one');
is(compileDeny(['  ', '', 'ok']).length, 1, 'compileDeny drops blanks');
is(compileDeny(null).length, 0, 'compileDeny tolerates null');

/* a hand block wins the reporting when both apply, but either alone blocks */
is(blockReason(PROD, { blocked: ['b'], patterns: ['prod'] }), 'blocked by hand', 'hand reported first');

/* only pattern blocks are unliftable from the popup */
is(isPatternBlock('blocked by hand'), false, 'hand block is liftable');
is(isPatternBlock('blocked by the pattern prod'), true, 'pattern block is not');
is(isPatternBlock(null), false, 'no block is not a pattern block');

/* settings validation reports the offending line */
is(firstBadPattern(['ok', '[unclosed']).source, '[unclosed', 'reports the bad source');
is(firstBadPattern(['ok', 'also ok']), null, 'all good');
is(firstBadPattern([]), null, 'empty list');
is(firstBadPattern(['  ']), null, 'blank is not bad');

console.log(failed ? `${failed} failing` : 'all guard assertions passed');
process.exit(failed ? 1 : 0);
