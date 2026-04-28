/**
 * Regression test for two bugs found on shared report 9CnLMp-V3UxhAALfD3g24
 * (30k gal plaster pool, salt 623, CH 195, pH 7.4, TA 80, CYA 8, FC 0.13):
 *
 *   1. Salt detection threshold was 1000 ppm. A salt pool reading 623 ppm
 *      (depleted cell, dilution from rain/snow) was treated as a chlorine
 *      pool — no salt-flavored targets, no salt addition recommendation.
 *
 *   2. The LSI optimizer's CH lever computed a per-10k-gal cap on Calcium
 *      Chloride and ignored the absolute 10-lb visit ceiling. For a 30k pool
 *      it overrode the splitter and prescribed 30 lbs of CaCl in one visit.
 */

import { calculateDosing, buildTargets } from '../src/index';

const input = {
  pH: 7.4,
  temperature: 65,
  totalAlkalinity: 80,
  calciumHardness: 195,
  cya: 8,
  tds: 640,
  freeChlorine: 0.13,
  totalChlorine: 0.13,
  phosphates: 322,
  salt: 623,
  copper: 0.1,
  iron: 0,
  poolVolume: 30000,
};

// Caller passed isSaltSystem=false (the form bug we're guarding against).
const targets = buildTargets(/* isSpa */ false, 'plaster', /* isSaltSystem */ false);
const result = calculateDosing(input, targets, false, false, {}, /* isSaltSystemOverride */ false, false, 'plaster');

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

// ─── Issue #2: Calcium Chloride must respect the 10-lb hard cap ────────────
const cacl = [...result.doses, ...result.returnVisitDoses]
  .find((d) => d.chemical === 'Calcium Chloride (100%)');

if (cacl) {
  assert(
    cacl.amount <= 10,
    `Calcium Chloride dose <= 10 lbs (got ${cacl.amount} ${cacl.unit}, target ${cacl.targetValue} ppm)`,
  );
} else {
  console.log('PASS: no Calcium Chloride dose (CH already adequate)');
}

// Belt-and-suspenders: scan every dose to make sure no CaCl entry slips through.
for (const d of [...result.doses, ...result.returnVisitDoses]) {
  if (d.chemical === 'Calcium Chloride (100%)') {
    assert(d.amount <= 10, `every CaCl dose <= 10 lbs (found ${d.amount} ${d.unit} in ${d.purpose})`);
  }
}

// ─── Issue #1: Salt 623 ppm should auto-detect as salt pool ─────────────────
const warnings = result.readingWarnings ?? [];
assert(
  warnings.some((w) => w.includes('Salt reading is 623') && w.toLowerCase().includes('treating this as a salt pool')),
  `salt auto-detect warning present (warnings: ${JSON.stringify(warnings)})`,
);

// Engine should have rebuilt targets internally — salt addition recommendation
// should be in the doses (or return-visit doses) since 623 < 2700 ppm target min.
// The dose may split across visits (visit_limit_per_10k = 100 lbs Pool Salt),
// so the final visit's targetValue is the one that needs to hit salt-pool range.
const saltDoses = [...result.doses, ...result.returnVisitDoses].filter(
  (d) => d.chemical === 'Pool Salt',
);
assert(
  saltDoses.length > 0 && saltDoses.every((d) => d.amount > 0),
  `Pool Salt dose present (found ${saltDoses.length})`,
);

const finalSaltTarget = Math.max(...saltDoses.map((d) => d.targetValue));
assert(
  finalSaltTarget >= 2700 && finalSaltTarget <= 3400,
  `final Pool Salt target in salt-pool range 2700-3400 (got ${finalSaltTarget} across ${saltDoses.length} visit(s))`,
);

if (failed) {
  console.error('\n❌ One or more assertions failed.');
  process.exit(1);
} else {
  console.log('\n✅ All assertions passed.');
}
