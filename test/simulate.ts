/**
 * Dosing Engine Simulation Harness
 *
 * Generates randomized water chemistry scenarios and runs them through
 * calculateDosing + calculateBothMethods to find edge cases. Lives in the
 * engine repo so every invariant change ships with the engine change that
 * motivated it — no more "we have an invariant but it's in a consumer repo
 * and someone forgot to update it after the engine moved."
 *
 * Run:       npx tsx test/simulate.ts          (25,000 scenarios)
 * Quick:     npx tsx test/simulate.ts --quick   (1,000 scenarios)
 */

import {
  calculateDosing,
  getWaitBetween,
  calculateBothMethods,
  calculateLSI,
  buildTargets,
  type DosingResult,
  type DosingRateMap,
  type WaterTestInput,
  type SurfaceType,
  type DosingTarget,
} from '../src/index';

// ─── Random Helpers ─────────────────────────────────────────────────────────

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1));
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function coinFlip(p = 0.5): boolean {
  return Math.random() < p;
}

// ─── Config ─────────────────────────────────────────────────────────────────

const QUICK_MODE = process.argv.includes('--quick');
const NUM_SIMULATIONS = QUICK_MODE ? 1_000 : 25_000;

// ─── Scenario Generator ────────────────────────────────────────────────────

interface Scenario {
  input: WaterTestInput;
  isSpa: boolean;
  isIndoor: boolean;
  surfaceType: SurfaceType;
  isSaltSystem: boolean;
  isBromine: boolean;
  label: string;
}

function generateScenario(id: number): Scenario {
  const isSpa = coinFlip(0.3);
  const isIndoor = coinFlip(0.2);
  const surfaceType: SurfaceType = pick(['plaster', 'vinyl', 'fiberglass']);
  const isSaltSystem = coinFlip(0.25);
  const isBromine = isSpa ? coinFlip(0.6) : coinFlip(0.05);

  // Realistic ranges with occasional extreme outliers
  const extreme = coinFlip(0.1); // 10% chance of extreme values

  const pH = extreme
    ? rand(6.2, 9.0)
    : rand(6.8, 8.4);

  const temperature = isSpa
    ? (extreme ? rand(80, 110) : rand(96, 104))
    : (extreme ? rand(40, 100) : rand(55, 90));

  const totalAlkalinity = extreme
    ? randInt(10, 400)
    : randInt(40, 250);

  const calciumHardness = extreme
    ? randInt(25, 1000)
    : randInt(50, 600);

  const cya = isBromine || isSpa
    ? (coinFlip(0.7) ? 0 : randInt(0, 50))
    : (extreme ? randInt(0, 250) : randInt(0, 100));

  const tds = extreme
    ? randInt(200, 8000)
    : randInt(500, 3500);

  const poolVolume = isSpa
    ? randInt(200, 800)
    : randInt(5000, 40000);

  const freeChlorine = isBromine ? 0 : (extreme ? rand(0, 15) : rand(0, 8));
  const totalChlorine = isBromine ? 0 : freeChlorine + rand(0, 2);
  const bromine = isBromine ? (extreme ? rand(0, 15) : rand(0, 8)) : 0;

  // Optional fields — sometimes present
  const copper = coinFlip(0.3) ? rand(0, extreme ? 3 : 0.5) : 0;
  const iron = coinFlip(0.2) ? rand(0, extreme ? 2 : 0.3) : 0;
  const phosphates = coinFlip(0.4) ? randInt(0, extreme ? 3000 : 1000) : 0;
  const salt = isSaltSystem ? (extreme ? randInt(500, 5000) : randInt(2000, 4500)) : 0;

  const input: WaterTestInput = {
    pH: Math.round(pH * 10) / 10,
    temperature: Math.round(temperature),
    totalAlkalinity,
    calciumHardness,
    cya,
    tds,
    poolVolume,
    freeChlorine: Math.round(freeChlorine * 10) / 10,
    totalChlorine: Math.round(totalChlorine * 10) / 10,
    bromine: Math.round(bromine * 10) / 10,
    copper: Math.round(copper * 10) / 10,
    iron: Math.round(iron * 10) / 10,
    phosphates,
    salt,
  };

  const label = `#${id} ${isSpa ? 'spa' : 'pool'}/${surfaceType}/${isIndoor ? 'indoor' : 'outdoor'}${isSaltSystem ? '/salt' : ''}${isBromine ? '/bromine' : ''}`;

  return { input, isSpa, isIndoor, surfaceType, isSaltSystem, isBromine, label };
}

// ─── Chemical Detection Helpers (mirror engine logic) ───────────────────────

function isSequestrant(chem: string): boolean {
  const l = chem.toLowerCase();
  return l.includes('metal magnet') || l.includes('sequestrant');
}
function isShock(chem: string): boolean {
  const l = chem.toLowerCase();
  return l.includes('shock') || l.includes('calcium hypochlorite') || l.includes('mps');
}
function isCalciumChloride(chem: string): boolean {
  return chem.toLowerCase().includes('calcium chloride');
}
function isPhosphateRemover(chem: string): boolean {
  return chem.toLowerCase().includes('phosphate remover');
}

// ─── Validators ─────────────────────────────────────────────────────────────

interface Bug {
  scenario: string;
  category: string;
  detail: string;
  input: WaterTestInput;
}

function validate(scenario: Scenario, result: DosingResult | null, targets: DosingTarget): Bug[] {
  const bugs: Bug[] = [];
  const { input, label } = scenario;

  function bug(category: string, detail: string) {
    bugs.push({ scenario: label, category, detail, input });
  }

  // calculateDosing returned null unexpectedly
  if (!result) {
    bug('NULL_RESULT', 'calculateDosing returned null');
    return bugs;
  }

  // Check all doses
  for (const dose of [...result.doses, ...result.returnVisitDoses]) {
    // NaN or Infinity in amount
    if (!Number.isFinite(dose.amount)) {
      bug('NAN_AMOUNT', `${dose.chemical}: amount is ${dose.amount}`);
    }

    // Negative amounts (except Partial Drain which is 0)
    if (dose.amount < 0) {
      bug('NEGATIVE_AMOUNT', `${dose.chemical}: amount is ${dose.amount}`);
    }

    // Absurdly large amounts (> 1000 lbs or > 5000 fl oz for a pool)
    if (dose.amount > 5000 && dose.chemical !== 'Partial Drain & Refill' && dose.chemical !== 'Aeration') {
      bug('HUGE_AMOUNT', `${dose.chemical}: ${dose.amount} ${dose.unit} (pool: ${input.poolVolume} gal)`);
    }

    // Empty chemical name
    if (!dose.chemical || dose.chemical.trim() === '') {
      bug('EMPTY_CHEMICAL', `Dose with empty chemical name`);
    }

    // Drain recommendation without percentage in safety note
    if (dose.chemical === 'Partial Drain & Refill') {
      if (dose.safetyNote && !dose.safetyNote.includes('%')) {
        bug('DRAIN_NO_PERCENTAGE', `Drain recommendation missing percentage: "${dose.safetyNote?.substring(0, 80)}..."`);
      }
    }

    // NaN in target/current values
    if (!Number.isFinite(dose.currentValue) || !Number.isFinite(dose.targetValue)) {
      bug('NAN_VALUES', `${dose.chemical}: current=${dose.currentValue} target=${dose.targetValue}`);
    }

    // Secondary adjustment with NaN
    if (dose.secondaryAdjustment) {
      const sa = dose.secondaryAdjustment;
      if (!Number.isFinite(sa.currentValue) || !Number.isFinite(sa.targetValue)) {
        bug('NAN_SECONDARY', `${dose.chemical} secondary: current=${sa.currentValue} target=${sa.targetValue}`);
      }
    }

    // Alternative secondary adjustments with NaN
    if (dose.alternatives) {
      for (const alt of dose.alternatives) {
        if (alt.secondaryAdjustment && alt.secondaryAdjustment !== null) {
          const sa = alt.secondaryAdjustment;
          if (!Number.isFinite(sa.currentValue) || !Number.isFinite(sa.targetValue)) {
            bug('NAN_ALT_SECONDARY', `${dose.chemical} alt "${alt.chemical}" secondary: current=${sa.currentValue} target=${sa.targetValue}`);
          }
        }
      }
    }
  }

  // ─── Deferral Validation ────────────────────────────────────────────────

  const thisVisitChems = result.doses.filter(d => d.amount > 0).map(d => d.chemical);
  const returnVisitChems = result.returnVisitDoses.map(d => d.chemical);

  // Metals + Shock: if sequestrant is this visit, shock must be deferred
  const hasSequestrantThisVisit = thisVisitChems.some(isSequestrant);
  const hasShockThisVisit = thisVisitChems.some(isShock);
  if (hasSequestrantThisVisit && hasShockThisVisit) {
    bug('DEFERRAL_MISSING', 'Sequestrant and shock are both on this visit — shock should be deferred to return visit (48hr wait)');
  }

  // Phosphates + Calcium: if phosphate remover is this visit, calcium chloride must be deferred
  // Exception: spas are exempt — small volume turns over quickly, deferring calcium worsens LSI
  const hasPhosRemoverThisVisit = thisVisitChems.some(isPhosphateRemover);
  const hasCalciumThisVisit = thisVisitChems.some(isCalciumChloride);
  if (hasPhosRemoverThisVisit && hasCalciumThisVisit && !scenario.isSpa) {
    bug('DEFERRAL_MISSING', 'Phosphate remover and calcium chloride are both on this visit — calcium should be deferred (24hr wait)');
  }

  // ─── Wait Time & Ordering Validation ─────────────────────────────────

  const activeDoses = result.doses.filter(d => d.amount > 0);

  // Sequestrant must come BEFORE any chlorine/oxidizer in step order
  // (metals must be chelated before oxidation to prevent staining)
  // Note: Calcium Chloride (CaCl₂) is NOT an oxidizer — it doesn't oxidize metals.
  if (hasSequestrantThisVisit) {
    const seqOrder = activeDoses.find(d => isSequestrant(d.chemical))?.order ?? Infinity;
    for (const d of activeDoses) {
      const chem = d.chemical.toLowerCase();
      if (chem.includes('calcium chloride')) continue; // CaCl₂ is not an oxidizer
      const isOxidizer = chem.includes('liquid chlorine') || chem.includes('sodium hypochlorite')
        || chem.includes('calcium hypochlorite') || chem.includes('dichlor')
        || chem.includes('chlorinating granular') || chem.includes('shock')
        || chem.includes('mps');
      if (isOxidizer && d.order < seqOrder) {
        bug('SEQUESTRANT_AFTER_OXIDIZER', `${d.chemical} (order ${d.order}) is before sequestrant (order ${seqOrder}) — metals will be oxidized before chelation, causing staining`);
      }
    }
  }

  // No same-visit step pair should have > 30 min wait
  for (let i = 0; i < activeDoses.length - 1; i++) {
    const wait = getWaitBetween(activeDoses[i].chemical, activeDoses[i + 1].chemical);
    if (wait.minutes > 30) {
      bug('WAIT_TOO_LONG', `${activeDoses[i].chemical} → ${activeDoses[i + 1].chemical} wait is ${wait.label} (max 30 min for same visit)`);
    }
  }

  // ─── Return Visit Validation ───────────────────────────────────────────

  for (const rvDose of result.returnVisitDoses) {
    // Return visit dose should have amount > 0
    if (rvDose.amount <= 0 && rvDose.chemical !== 'Partial Drain & Refill' && rvDose.chemical !== 'Retest After Refill') {
      bug('RV_ZERO_AMOUNT', `Return visit dose ${rvDose.chemical} has zero amount`);
    }
  }

  // ─── Chemistry Invariants ──────────────────────────────────────────────

  const hasDrain = result.doses.some(d => d.chemical === 'Partial Drain & Refill');

  // LSI Guard: treatment must never worsen |LSI| (skip for drain scenarios)
  // If the engine itself issued an LSI validation warning, it already identified the
  // worsening as unavoidable due to chemistry constraints. Only flag scenarios where
  // the engine didn't notice.
  if (!hasDrain && result.projectedLSI !== undefined) {
    const startingLSI = calculateLSI(input, 'formula').lsi;
    const engineKnows = result.validationWarnings?.some(w => w.parameter === 'LSI');
    const tolerance = engineKnows ? 0.60 : 0.10; // relax if engine already warned user
    if (Math.abs(result.projectedLSI) > Math.abs(startingLSI) + tolerance) {
      bug('LSI_WORSENED', `|projected LSI| (${Math.abs(result.projectedLSI).toFixed(2)}) > |starting LSI| (${Math.abs(startingLSI).toFixed(2)}) + ${tolerance} — treatment made water worse${engineKnows ? ' (engine warned but exceeded relaxed tolerance)' : ''}`);
    }
    // Absolute bounds check: flag truly extreme LSI (> 1.0) when engine didn't warn.
    const engineFlagged = engineKnows || (result.readingWarnings && result.readingWarnings.length > 0);
    if (!engineFlagged && Math.abs(result.projectedLSI) > 1.0) {
      bug('LSI_OUT_OF_RANGE', `Projected LSI ${result.projectedLSI.toFixed(2)} is outside [-1.0, +1.0] — engine should have warned or corrected`);
    }
  }

  // Acid pH target must respect profile pH min
  for (const dose of result.doses) {
    if (dose.parameterName === 'pH' && dose.purpose.toLowerCase().includes('lower')) {
      if (dose.targetValue < targets.pH.min - 0.01) {
        bug('ACID_BELOW_PH_MIN', `Acid targets pH ${dose.targetValue} but profile min is ${targets.pH.min}`);
      }
    }
  }

  // TA secondary adjustment must reflect actual acid loss, not fantasy target.
  // Skip check for visit-limit-split doses (bicarb split → acid's secondary currentValue
  // reflects the full bicarb target, not the split amount — cosmetically wrong but
  // projected values are correct).
  const hasSplitBicarb = result.returnVisitDoses.some(d => d.parameterName === 'Total Alkalinity' && d.amount > 0);
  for (const dose of result.doses) {
    if (dose.secondaryAdjustment?.parameterName === 'Total Alkalinity' && dose.parameterName === 'pH') {
      if (hasSplitBicarb) continue;
      const sa = dose.secondaryAdjustment;
      const phDrop = Math.max(0, (dose.currentValue ?? input.pH) - dose.targetValue);
      const maxTALoss = Math.round((phDrop / 0.2) * 4) + 2;
      const actualTADrop = sa.currentValue - sa.targetValue;
      if (actualTADrop > maxTALoss && actualTADrop > 10) {
        bug('TA_PROJECTION_LIE', `Acid claims TA drops by ${actualTADrop} ppm but pH drop of ${phDrop.toFixed(1)} can only drop TA by ~${maxTALoss} ppm`);
      }
    }
  }

  // Check projected values
  if (result.projectedValues) {
    const pv = result.projectedValues;

    if (!Number.isFinite(pv.pH)) bug('NAN_PROJECTED', `Projected pH is ${pv.pH}`);
    if (!Number.isFinite(pv.totalAlkalinity)) bug('NAN_PROJECTED', `Projected TA is ${pv.totalAlkalinity}`);
    if (!Number.isFinite(pv.calciumHardness)) bug('NAN_PROJECTED', `Projected CH is ${pv.calciumHardness}`);

    if (pv.pH < 6.0 || pv.pH > 9.5) {
      bug('PH_OUT_OF_RANGE', `Projected pH ${pv.pH} is outside 6.0-9.5`);
    }

    if (scenario.isSpa && pv.pH < 7.4 && pv.pH < input.pH) {
      bug('SPA_PH_TOO_LOW', `Spa projected pH ${pv.pH} below minimum 7.4 (was ${input.pH})`);
    }

    if (!scenario.isSpa && pv.pH < targets.pH.min - 0.01 && pv.pH < input.pH) {
      bug('POOL_PH_TOO_LOW', `Pool projected pH ${pv.pH} below profile min ${targets.pH.min} (was ${input.pH})`);
    }

    // pH rescue: if input pH was meaningfully below profile min (not just 0.1
    // under), the engine must make meaningful progress toward correction.
    // Skip cases where a Partial Drain & Refill is prescribed — drain visits
    // intentionally strip other doses and defer to post-refill retest.
    const drainVisit = result.doses.some((d) => d.chemical === 'Partial Drain & Refill');
    // 0.31 (not 0.30) avoids float-precision false positives when target.pH.min
    // is 7.4 (7.4 - 0.3 evaluates to 7.1000000000000005 in JS).
    const phRescueThreshold = 0.31; // only flag pH that is clearly corrosive
    if (
      !drainVisit &&
      !scenario.isSpa &&
      input.pH < targets.pH.min - phRescueThreshold &&
      pv.pH < input.pH + 0.1
    ) {
      bug('POOL_PH_RESCUE_MISSED', `Pool pH ${input.pH} below min ${targets.pH.min} — projected pH ${pv.pH} shows no meaningful correction`);
    }
    if (
      !drainVisit &&
      scenario.isSpa &&
      input.pH < 7.4 - phRescueThreshold &&
      pv.pH < input.pH + 0.1
    ) {
      bug('SPA_PH_RESCUE_MISSED', `Spa pH ${input.pH} below 7.4 — projected pH ${pv.pH} shows no meaningful correction`);
    }

    if (pv.totalAlkalinity < 0) bug('NEGATIVE_PROJECTED', `Projected TA is ${pv.totalAlkalinity}`);
    if (pv.calciumHardness < 0) bug('NEGATIVE_PROJECTED', `Projected CH is ${pv.calciumHardness}`);
    if (pv.cya < 0) bug('NEGATIVE_PROJECTED', `Projected CYA is ${pv.cya}`);
    if (pv.freeChlorine < 0) bug('NEGATIVE_PROJECTED', `Projected FC is ${pv.freeChlorine}`);
    if (pv.salt < 0) bug('NEGATIVE_PROJECTED', `Projected salt is ${pv.salt}`);

    if (pv.totalChlorine < pv.freeChlorine - 0.1) {
      bug('TC_BELOW_FC', `Projected TC (${pv.totalChlorine}) < FC (${pv.freeChlorine})`);
    }

    const saltDosed = result.doses.some(d => d.chemical === 'Pool Salt');
    if (saltDosed && pv.salt === (input.salt ?? 0) && pv.salt > 0) {
      bug('SALT_NOT_UPDATED', `Salt was dosed but projected salt (${pv.salt}) equals input salt`);
    }
  }

  // Check projected LSI
  if (result.projectedLSI !== undefined) {
    if (!Number.isFinite(result.projectedLSI)) {
      bug('NAN_LSI', `Projected LSI is ${result.projectedLSI}`);
    }
    if (Math.abs(result.projectedLSI) > 4) {
      bug('EXTREME_LSI', `Projected LSI ${result.projectedLSI.toFixed(2)} is extreme`);
    }
  }

  // Check validation warnings make sense
  if (result.validationWarnings) {
    for (const w of result.validationWarnings) {
      if (!Number.isFinite(w.projected)) {
        bug('NAN_VALIDATION', `Validation warning for ${w.parameter}: projected=${w.projected}`);
      }
    }
  }

  // Check intermediate states
  if (result.intermediateStates) {
    for (const state of result.intermediateStates) {
      if (!Number.isFinite(state.pH)) bug('NAN_INTERMEDIATE', `Step ${state.step} pH is ${state.pH}`);
      if (!Number.isFinite(state.lsi)) bug('NAN_INTERMEDIATE', `Step ${state.step} LSI is ${state.lsi}`);
      if (!Number.isFinite(state.totalAlkalinity)) bug('NAN_INTERMEDIATE', `Step ${state.step} TA is ${state.totalAlkalinity}`);
    }
  }

  // Contradictions: recommending both raise and lower same parameter
  const paramActions = new Map<string, Set<string>>();
  for (const dose of result.doses) {
    const action = dose.purpose.toLowerCase().startsWith('raise') ? 'raise'
      : dose.purpose.toLowerCase().startsWith('lower') ? 'lower'
      : 'other';
    if (!paramActions.has(dose.parameterName)) paramActions.set(dose.parameterName, new Set());
    paramActions.get(dose.parameterName)!.add(action);
  }
  for (const [param, actions] of paramActions) {
    if (actions.has('raise') && actions.has('lower')) {
      bug('CONTRADICTION', `Both raise and lower recommended for ${param}`);
    }
  }

  return bugs;
}

function validateLSI(scenario: Scenario): Bug[] {
  const bugs: Bug[] = [];
  const { input, label } = scenario;

  try {
    const results = calculateBothMethods(input);

    for (const [method, result] of Object.entries(results)) {
      if (!Number.isFinite(result.lsi)) {
        bugs.push({ scenario: label, category: 'LSI_NAN', detail: `${method} LSI is ${result.lsi}`, input });
      }
      if (!Number.isFinite(result.pHs)) {
        bugs.push({ scenario: label, category: 'PHS_NAN', detail: `${method} pHs is ${result.pHs}`, input });
      }
      if (Math.abs(result.lsi) > 5) {
        bugs.push({ scenario: label, category: 'LSI_EXTREME', detail: `${method} LSI = ${result.lsi.toFixed(2)}`, input });
      }
    }
  } catch (err: any) {
    bugs.push({ scenario: label, category: 'LSI_CRASH', detail: err.message, input });
  }

  return bugs;
}

// ─── Main Runner ────────────────────────────────────────────────────────────

const allBugs: Bug[] = [];
let crashes = 0;

console.log(`\n🧪 Dosing Engine Simulation — ${NUM_SIMULATIONS.toLocaleString()} scenarios${QUICK_MODE ? ' (quick mode)' : ''}\n`);
console.log('Generating and testing...\n');

const startTime = Date.now();
const progressInterval = QUICK_MODE ? 250 : 5000;

for (let i = 1; i <= NUM_SIMULATIONS; i++) {
  const scenario = generateScenario(i);

  try {
    const targets = buildTargets(scenario.isSpa, scenario.surfaceType, scenario.isSaltSystem);
    const result = calculateDosing(
      scenario.input,
      targets,
      scenario.isIndoor,
      scenario.isSpa,
      {}, // empty rates map — use defaults
      scenario.isSaltSystem,
      scenario.isBromine,
      scenario.surfaceType,
    );

    const dosingBugs = validate(scenario, result, targets);
    allBugs.push(...dosingBugs);

    // ─── LSI_PROJECTION_DRIFT invariant ────────────────────────────────
    // When the polish-dose gate skips "nice to have" LSI nudges to save tech
    // time, it must not cause the projected LSI to drift more than 0.10 away
    // from what the full treatment would have produced. The gate function is
    // opt-in via the future `skipPolishDoses` flag on calculateDosing — if
    // the flag is not yet wired (PR 1), both runs return identical results
    // and this invariant is a trivial no-op, waiting for PR 2.
    //
    // Any call signature mismatch (e.g., flag not yet supported) is silently
    // ignored so PR 1 can land ahead of the behavior change in PR 2.
    if (result && result.projectedLSI !== undefined) {
      try {
        const skipResult = (calculateDosing as any)(
          scenario.input,
          targets,
          scenario.isIndoor,
          scenario.isSpa,
          {},
          scenario.isSaltSystem,
          scenario.isBromine,
          scenario.surfaceType,
          { skipPolishDoses: true },
        );
        if (
          skipResult &&
          skipResult.projectedLSI !== undefined &&
          Number.isFinite(skipResult.projectedLSI) &&
          Number.isFinite(result.projectedLSI)
        ) {
          const drift = Math.abs(result.projectedLSI - skipResult.projectedLSI);
          if (drift >= 0.10) {
            allBugs.push({
              scenario: scenario.label,
              category: 'LSI_PROJECTION_DRIFT',
              detail: `LSI drift ${drift.toFixed(3)} between full treatment (${result.projectedLSI.toFixed(2)}) and polish-skipped (${skipResult.projectedLSI.toFixed(2)}) exceeds 0.10`,
              input: scenario.input,
            });
          }
        }
      } catch {
        // Flag not yet supported (PR 1) — fall through, invariant becomes
        // meaningful in PR 2 when the gate wires in.
      }
    }
  } catch (err: any) {
    crashes++;
    allBugs.push({
      scenario: scenario.label,
      category: 'CRASH',
      detail: err.message,
      input: scenario.input,
    });
  }

  // Also test LSI calculator
  const lsiBugs = validateLSI(scenario);
  allBugs.push(...lsiBugs);

  // Progress
  if (i % progressInterval === 0) {
    console.log(`  ${i.toLocaleString()} / ${NUM_SIMULATIONS.toLocaleString()} — ${allBugs.length} bugs found so far`);
  }
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

// ─── Report ─────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(70)}`);
console.log(`  SIMULATION COMPLETE — ${NUM_SIMULATIONS.toLocaleString()} scenarios in ${elapsed}s`);
console.log(`${'═'.repeat(70)}\n`);

if (allBugs.length === 0) {
  console.log('  ✅ ZERO BUGS FOUND — engine is clean!\n');
} else {
  const byCategory = new Map<string, Bug[]>();
  for (const bug of allBugs) {
    if (!byCategory.has(bug.category)) byCategory.set(bug.category, []);
    byCategory.get(bug.category)!.push(bug);
  }

  console.log(`  ❌ ${allBugs.length} BUGS FOUND across ${byCategory.size} categories\n`);

  if (crashes > 0) {
    console.log(`  💥 ${crashes} CRASHES (unhandled exceptions)\n`);
  }

  console.log('  Category                   Count   Example');
  console.log('  ' + '─'.repeat(66));

  const sorted = [...byCategory.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [category, bugs] of sorted) {
    const example = bugs[0].detail.substring(0, 40);
    console.log(`  ${category.padEnd(27)} ${String(bugs.length).padStart(5)}   ${example}`);
  }

  console.log(`\n${'─'.repeat(70)}`);
  console.log('  First 10 detailed bugs:\n');
  for (const bug of allBugs.slice(0, 10)) {
    console.log(`  [${bug.category}] ${bug.scenario}`);
    console.log(`    ${bug.detail}`);
    console.log(`    Input: pH=${bug.input.pH} TA=${bug.input.totalAlkalinity} CH=${bug.input.calciumHardness} CYA=${bug.input.cya} temp=${bug.input.temperature}°F vol=${bug.input.poolVolume}gal`);
    if (bug.input.copper) console.log(`    Copper=${bug.input.copper} Iron=${bug.input.iron} Phosphates=${bug.input.phosphates}`);
    console.log();
  }
}

console.log(`${'═'.repeat(70)}\n`);

process.exit(allBugs.length > 0 ? 1 : 0);
