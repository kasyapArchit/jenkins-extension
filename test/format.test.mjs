// node test/format.test.mjs
import { qualifiedName, buildLabel } from '../lib/format.js';

const cases = [
  [['Webmail/QA', 'QA'],            'Webmail/QA'],
  [['Drive-web/QA', 'QA'],          'Drive-web/QA'],
  [['Email-Backup/QA', 'QA'],       'Email-Backup/QA'],
  [['QA', 'QA'],                    'QA'],           // root job keeps its bare name
  [['Frontend/Sub/QA', 'QA'],       'Sub/QA'],       // immediate parent, not the top folder
  [['', 'QA'],                      'QA'],
  [[null, 'QA'],                    'QA'],
  [[undefined, 'QA'],               'QA'],
  [['Folder/job-path', 'Display'],  'Folder/Display'],
  [['Folder/only', null],           'Folder/only'],
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

console.log(failed ? `${failed} failing` : `${cases.length + labels.length} format assertions passed`);
process.exit(failed ? 1 : 0);
