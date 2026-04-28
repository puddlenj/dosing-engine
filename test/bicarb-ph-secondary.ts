/**
 * Regression test for the bicarb-pH-secondary projection bug.
 *
 * Bug: a pool with pH 7 (extreme low) and TA 44 (low) got a 48 lb baking soda
 * dose to raise TA to ~140. Bicarb raises pH ~0.05 per 10 ppm TA bump, so
 * that dose should push pH from 7.0 to ~7.5. But the dose record had no
 * secondaryAdjustment for pH, so the projection showed pH still at 7 and
 * the LSI calc was based on uncorrected pH — making the report look like
 * the treatment did nothing.
 *
 * Fix: doseAlkalinity attaches a pH secondary on the standalone bicarb
 * branch, and the LSI optimizer's TA lever ensures the secondary is
 * present after re-sizing the dose.
 *
 * Found via fuzz harness — POOL_PH_RESCUE_MISSED was firing several
 * times per 25,000 random scenarios.
 */

import { calculateDosing, buildTargets } from '../src/index';

const input = {
  pH: 7,
  temperature: 59,
  totalAlkalinity: 44,
  calciumHardness: 519,
  cya: 7,
  tds: 1000,
  freeChlorine: 1.5,
  totalChlorine: 1.5,
  phosphates: 0,
  copper: 0,
  iron: 0,
  poolVolume: 36014,
};

const targets = buildTargets(false, 'vinyl', false);
const result = calculateDosing(input, targets, false, false, {}, false, false, 'vinyl');

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

const bicarb = result.doses.find((d) => d.chemical === 'Sodium Bicarbonate (Baking Soda)');
assert(bicarb !== undefined && bicarb.amount > 0, `bicarb dose present`);

if (bicarb) {
  // Bicarb raises pH ~0.05 per 10 ppm TA bump. With a ~96 ppm bump (TA 44 → 140),
  // pH should rise by ~0.5 — clearly a meaningful change, not "trivial."
  const sec = bicarb.secondaryAdjustment;
  assert(
    sec !== undefined && sec.parameterName === 'pH',
    `bicarb has pH secondaryAdjustment (got ${sec ? sec.parameterName : 'none'})`,
  );
  if (sec && sec.parameterName === 'pH') {
    assert(
      sec.targetValue > sec.currentValue + 0.3,
      `pH secondary projects meaningful rise (currentValue ${sec.currentValue} → targetValue ${sec.targetValue})`,
    );
  }
}

// And the engine's overall projection must reflect the pH bump.
const projectedPH = result.projectedValues?.pH ?? input.pH;
assert(
  projectedPH > input.pH + 0.3,
  `projectedValues.pH reflects bicarb pH bump (input pH ${input.pH} → projected pH ${projectedPH})`,
);

if (failed) {
  console.error('\n❌ One or more assertions failed.');
  process.exit(1);
} else {
  console.log('\n✅ All assertions passed.');
}
