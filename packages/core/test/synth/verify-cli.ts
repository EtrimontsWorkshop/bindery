import { verifyAll } from './verifyClaims.js';

const results = await verifyAll();
let anyFailed = false;
for (const r of results) {
  if (r.passed) {
    console.log(`OK    ${r.id}`);
  } else {
    anyFailed = true;
    console.log(`FAIL  ${r.id}`);
    for (const f of r.failures) console.log(`        - ${f}`);
  }
}
console.log(
  `\n${results.length} fixture'ow, ${results.filter((r) => r.passed).length} OK, ${
    results.filter((r) => !r.passed).length
  } FAIL`,
);
if (anyFailed) process.exit(1);
