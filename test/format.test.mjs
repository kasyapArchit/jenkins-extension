// node test/format.test.mjs
import { qualifiedName, buildLabel, normalizeSearchText } from '../lib/format.js';

const cases = [
  [['Webmail/QA', 'QA'],            'QA · Webmail'],
  [['Drive-web/QA', 'QA'],          'QA · Drive-web'],
  [['Email-Backup/QA', 'QA'],       'QA · Email-Backup'],
  [['QA', 'QA'],                    'QA'],           // root job keeps its bare name
  [['Frontend/Sub/QA', 'QA'],       'QA · Sub'], // immediate parent, not the top folder
  [['', 'QA'],                      'QA'],
  [[null, 'QA'],                    'QA'],
  [[undefined, 'QA'],               'QA'],
  [['Folder/job-path', 'Display'],  'Display · Folder'],
  [['Folder/only', null],           'only · Folder'],
];

let failed = 0;
for (const [args, want] of cases) {
  const got = qualifiedName(...args);
  if (got !== want) { failed++; console.error(`FAIL ${JSON.stringify(args)} -> ${got} (want ${want})`); }
}
const labels = [
  [{ build: 527, displayName: '#527' },   '#527'],   // Jenkins default, unchanged
  [{ build: 527, displayName: null },     '#527'],   // not polled yet
  [{ build: 527, displayName: '' },       '#527'],
  [{ build: 527, displayName: '  ' },     '#527'],   // whitespace is not a version
  [{ build: 527, displayName: '9.2.1' },  '9.2.1'],  // pipeline set a version
  [{ build: 527, displayName: '#527 - v9.2.1' }, '#527 - v9.2.1'],
  [{ build: null, displayName: null },    ''],       // queued, no number yet
  [{ build: null, displayName: '9.2.1' }, '9.2.1'],
];
for (const [run, want] of labels) {
  const got = buildLabel(run);
  if (got !== want) { failed++; console.error(`FAIL buildLabel ${JSON.stringify(run)} -> "${got}" (want "${want}")`); }
}

const normalized = [
  ['email backup qa',   'email backup qa'],
  ['email-backup/QA',   'email backup qa'],
  ['Email_Backup/qa',   'email backup qa'],
  ['  Deploy   Prod ',  'deploy prod'],
  ['',                  ''],
  [null,                ''],
];
for (const [input, want] of normalized) {
  const got = normalizeSearchText(input);
  if (got !== want) { failed++; console.error(`FAIL normalizeSearchText(${JSON.stringify(input)}) -> "${got}" (want "${want}")`); }
}

console.log(failed ? `${failed} failing` : `${cases.length + labels.length + normalized.length} format assertions passed`);
process.exit(failed ? 1 : 0);
