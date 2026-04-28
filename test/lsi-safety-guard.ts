/**
 * Regression test for the LSI safety guard.
 *
 * When visit-cap walls (CaCl absolute 10 lbs, drain limits) prevent the
 * engine from making matched pH/CH moves, the optimizer used to ship a
 * plan that pushed water further from balance than where it started.
 *
 * Common shape: high pH + very low CH on cold water. Engine drops pH to
 * 7.6 and adds 10 lbs CaCl, but the cap can only raise CH by ~30 ppm.
 * Net effect: water goes from balanced (LSI ~0) to corrosive (LSI -0.6).
 *
 * Fix: after the LSI optimizer runs, if projected LSI is meaningfully
 * outside the safe band (-0.3..+0.3) AND removing the pH dose brings it
 * closer to balance, defer that dose to the return visit. Customer's
 * water sits at imperfect pH for a week but stays out of corrosive
 * territory.
 *
 * pH safety overrides the guard: when input pH is critically low (< 7.1)
 * or critically high (> 8.5), the rescue dose ships even if LSI takes a
 * hit, because dissolving plaster / surface damage trumps temporary scale
 * risk.
 */

import { calculateDosing, calculateLSI, buildTargets } from '../src/index';

let failed = false;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed = true;
  } else {
    console.log('PASS:', msg);
  }
}

// ─── Scenario 1: cold pool, high pH, low CH — guard should defer acid ──────
{
  console.log('\n[Scenario 1] cold pool / high pH / very low CH');
  const input = {
    pH: 8.4, totalAlkalinity: 95, calciumHardness: 66, cya: 15,
    temperature: 59, tds: 1000,
    freeChlorine: 2, totalChlorine: 2,
    copper: 0.2, iron: 0, phosphates: 0,
    poolVolume: 34218,
  };
  const startingLSI = calculateLSI(input, 'formula').lsi;
  const targets = buildTargets(false, 'vinyl', false);
  const result = calculateDosing(input, targets, true /* indoor */, false, {}, false, false, 'vinyl');

  assert(result !== null, 'returned a result');
  if (!result) process.exit(1);

  const projectedLSI = result.projectedLSI ?? 999;
  console.log(`  starting LSI=${startingLSI.toFixed(2)}, projected LSI=${projectedLSI.toFixed(2)}`);

  assert(
    Math.abs(projectedLSI) <= Math.abs(startingLSI) + 0.4,
    `projected LSI does not push water meaningfully further from balance (${startingLSI.toFixed(2)} → ${projectedLSI.toFixed(2)})`,
  );

  // Acid should be deferred to return visit
  const hasAcidThisVisit = result.doses.some((d) => d.parameterName === 'pH' && d.currentValue > d.targetValue);
  const hasAcidNextVisit = result.returnVisitDoses.some((d) => d.parameterName === 'pH' && d.currentValue > d.targetValue);
  assert(!hasAcidThisVisit, `acid deferred — no acid prescribed this visit`);
  assert(hasAcidNextVisit, `acid present in return visit doses`);

  // Engine should warn the tech about the deferral
  const warnings = result.readingWarnings ?? [];
  assert(
    warnings.some((w) => w.toLowerCase().includes('deferred')),
    `reading warning explains deferral (warnings: ${warnings.join(' / ') || 'none'})`,
  );
}

// ─── Scenario 2: pH critically low — guard does NOT defer the rescue ───────
{
  console.log('\n[Scenario 2] critical low pH — rescue overrides guard');
  const input = {
    pH: 6.8, totalAlkalinity: 380, calciumHardness: 384, cya: 3,
    temperature: 98, tds: 1000,
    freeChlorine: 1, totalChlorine: 1,
    copper: 0, iron: 0, phosphates: 0,
    poolVolume: 18089,
  };
  const targets = buildTargets(false, 'plaster', false);
  const result = calculateDosing(input, targets, true, false, {}, false, false, 'plaster');

  assert(result !== null, 'returned a result');
  if (!result) process.exit(1);

  // Soda ash MUST be dosed this visit despite LSI consequences
  const hasPhUpThisVisit = result.doses.some(
    (d) => d.parameterName === 'pH' && d.amount > 0 && d.currentValue < d.targetValue,
  );
  assert(hasPhUpThisVisit, `pH-rescue dose ships this visit even when LSI would worsen`);

  // Engine should still warn about precipitation risk
  assert(
    result.precipitationWarning !== undefined && result.precipitationWarning.length > 0,
    `precipitation warning emitted`,
  );
}

// ─── Scenario 3: starting LSI already balanced — guard shouldn't fire ──────
{
  console.log('\n[Scenario 3] balanced starting state — guard inactive');
  const input = {
    pH: 7.5, totalAlkalinity: 100, calciumHardness: 250, cya: 30,
    temperature: 78, tds: 1500,
    freeChlorine: 3, totalChlorine: 3,
    copper: 0, iron: 0, phosphates: 0,
    poolVolume: 20000,
  };
  const targets = buildTargets(false, 'plaster', false);
  const result = calculateDosing(input, targets, false, false, {}, false, false, 'plaster');

  assert(result !== null, 'returned a result');
  if (!result) process.exit(1);

  const warnings = result.readingWarnings ?? [];
  assert(
    !warnings.some((w) => w.toLowerCase().includes('deferred')),
    `no spurious deferral warnings on balanced water`,
  );
}

if (failed) {
  console.error('\n❌ One or more assertions failed.');
  process.exit(1);
} else {
  console.log('\n✅ All assertions passed.');
}
