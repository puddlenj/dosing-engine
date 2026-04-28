/**
 * Regression test for the visit-limit splitter scaling secondaryAdjustment.
 *
 * Bug: when an acid dose with a TA secondaryAdjustment was split because
 * its amount exceeded the per-visit cap, the splitter updated the primary
 * (pH) targetValue to the proportional intermediate but left the secondary
 * (TA) targetValue claiming the FULL drop. Result: dose record showed
 * "this visit pH 8.4 → 7.8" alongside "TA 200 → 188" (the full 12 ppm drop)
 * even though only half the chemical actually landed.
 *
 * Fix: scale dose.secondaryAdjustment proportionally on both the capped
 * this-visit dose and the return-visit remainder.
 */

import { calculateDosing, buildTargets } from '../src/index';

// Construct a scenario that forces a large acid dose for TA reduction:
//   TA = 220 (high), pH = 8.4 (high), large pool volume so the acid amount
//   exceeds the per-10k visit limit and the splitter has to engage.
const input = {
  pH: 8.4,
  temperature: 75,
  totalAlkalinity: 220,
  calciumHardness: 250,
  cya: 30,
  tds: 1000,
  freeChlorine: 3,
  totalChlorine: 3,
  phosphates: 0,
  copper: 0,
  iron: 0,
  poolVolume: 40000,
};

const targets = buildTargets(false, 'plaster', false);
const result = calculateDosing(input, targets, false, false, {}, false, false, 'plaster');

if (!result) {
  console.error('FAIL: calculateDosing returned null');
  process.exit(1);
}

let failed = false;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed = true;
  } else {
    console.log('PASS:', msg);
  }
}

// Find the acid dose (parameterName 'pH', currentValue > targetValue, with a TA secondary)
const acidDose = result.doses.find(
  (d) =>
    d.parameterName === 'pH' &&
    d.currentValue > d.targetValue &&
    d.secondaryAdjustment?.parameterName === 'Total Alkalinity',
);

assert(acidDose !== undefined, `acid dose with TA secondary present (chemicals: ${result.doses.map((d) => d.chemical).join(', ')})`);

if (!acidDose) {
  process.exit(failed ? 1 : 0);
}

// If the splitter engaged, this-visit pH target should be between starting pH
// and the original acid pH target (not at the original target).
const splitEngaged = acidDose.targetValue > 7.21 && acidDose.targetValue < 8.4;

if (splitEngaged) {
  console.log(`Splitter engaged — this visit: pH ${acidDose.currentValue} → ${acidDose.targetValue}`);

  // The secondaryAdjustment.targetValue must reflect the partial pH drop.
  // Acid drops TA ~4 ppm per 0.2 pH. So proportional TA drop = (phDelta / 0.2) * 4.
  const secondary = acidDose.secondaryAdjustment!;
  const phDelta = acidDose.currentValue - acidDose.targetValue;
  const expectedTaDrop = (phDelta / 0.2) * 4;
  const expectedSecondaryTarget = secondary.currentValue - expectedTaDrop;
  const actualTaDrop = secondary.currentValue - secondary.targetValue;

  console.log(`  TA secondary: ${secondary.currentValue} → ${secondary.targetValue} (drop ${actualTaDrop})`);
  console.log(`  Expected drop for ${phDelta.toFixed(1)} pH: ~${expectedTaDrop.toFixed(0)} ppm`);

  // Allow 4 ppm tolerance (rounding + Math.round on intermediate)
  assert(
    Math.abs(actualTaDrop - expectedTaDrop) <= 4,
    `this-visit TA secondary scales with capped acid dose (expected ~${expectedTaDrop.toFixed(0)} ppm drop, got ${actualTaDrop} ppm)`,
  );

  // Return visit's remainder must pick up where this visit left off
  const rvAcid = result.returnVisitDoses.find(
    (d) =>
      d.parameterName === 'pH' &&
      d.currentValue > d.targetValue &&
      d.secondaryAdjustment?.parameterName === 'Total Alkalinity',
  );

  assert(rvAcid !== undefined, `return-visit acid dose present`);

  if (rvAcid) {
    assert(
      Math.abs(rvAcid.currentValue - acidDose.targetValue) <= 0.2,
      `return-visit pH starts where this visit ended (expected ~${acidDose.targetValue}, got ${rvAcid.currentValue})`,
    );

    const rvSec = rvAcid.secondaryAdjustment!;
    assert(
      Math.abs(rvSec.currentValue - secondary.targetValue) <= 4,
      `return-visit TA secondary starts where this visit ended (expected ~${secondary.targetValue}, got ${rvSec.currentValue})`,
    );
  }
} else {
  console.log(`Splitter did not engage on this scenario (acid dose ${acidDose.amount} ${acidDose.unit} fit under cap) — adjust scenario if you want coverage`);
}

if (failed) {
  console.error('\n❌ One or more assertions failed.');
  process.exit(1);
} else {
  console.log('\n✅ All assertions passed.');
}
