// node test/format.test.mjs
import { qualifiedName } from '../lib/format.js';

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
console.log(failed ? `${failed} failing` : `${cases.length} format assertions passed`);
process.exit(failed ? 1 : 0);
