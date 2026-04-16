/**
 * Regression test for the "pH 6.6 gets no corrective dose" bug.
 *
 * Original report: a 20k-gal salt pool with pH 6.6, TA 102, CH 181, CYA 5,
 * salt 2845 got a treatment plan containing only Aeration, CYA, chlorine,
 * phosphate remover, and SWG adjustment — no soda ash. Projected LSI
 * remained at -1.16 (corrosive). Engine was skipping dosePH() whenever
 * doseAlkalinity() returned an Aeration advisory, even when pH was
 * dangerously low.
 */

import { calculateDosing, buildTargets } from '../src/index';

const input = {
  pH: 6.6,
  temperature: 69,
  totalAlkalinity: 102,
  calciumHardness: 181,
  cya: 5,
  tds: 264,
  freeChlorine: 0.1,
  totalChlorine: 0.14,
  phosphates: 1716,
  salt: 2845,
  copper: 0.2,
  poolVolume: 20000,
};

const targets = buildTargets(/* isSpa */ false, 'plaster', /* isSaltSystem */ true);
const result = calculateDosing(input, targets, false, false, {}, true, false, 'plaster');

if (!result) {
  console.error('FAIL: calculateDosing returned null');
  process.exit(1);
}

const chemicals = result.doses.map((d) => d.chemical);
const phDose = result.doses.find(
  (d) => d.parameterName === 'pH' && d.amount > 0,
);

let failed = false;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed = true;
  } else {
    console.log('PASS:', msg);
  }
}

assert(phDose !== undefined, `pH dose present (chemicals: ${chemicals.join(', ')})`);
if (phDose) {
  assert(
    phDose.chemical.toLowerCase().includes('soda ash') ||
      phDose.chemical.toLowerCase().includes('sodium carbonate'),
    `pH dose uses soda ash / sodium carbonate (got ${phDose.chemical})`,
  );
  assert(phDose.amount > 0, `pH dose amount > 0 (got ${phDose.amount} ${phDose.unit})`);
}

assert(
  result.projectedValues !== undefined && result.projectedValues.pH >= 7.3,
  `projected pH >= 7.3 (got ${result.projectedValues?.pH})`,
);

assert(
  result.projectedLSI !== undefined && result.projectedLSI > -0.5,
  `projected LSI > -0.5 (got ${result.projectedLSI})`,
);

assert(
  result.readingWarnings?.some((w) => /extremely low/i.test(w)) ?? false,
  'extreme-low-pH advisory fires for pH 6.6',
);

console.log('\n--- treatment plan ---');
for (const d of result.doses) {
  console.log(`  ${d.order}. ${d.chemical}: ${d.amount} ${d.unit} — ${d.purpose}`);
}
console.log(`\nstarting LSI: ${result.startingLSI?.toFixed(2)}`);
console.log(`projected LSI: ${result.projectedLSI?.toFixed(2)}`);
console.log(`projected pH: ${result.projectedValues?.pH}`);
console.log(`projected TA: ${result.projectedValues?.totalAlkalinity}`);

if (failed) process.exit(1);
console.log('\nAll assertions passed.');
