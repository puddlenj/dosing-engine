import type { WaterTestInput } from './lsi-calculator';
import { calculateLSI, getCyaCorrectionFactor, getCarbonateAlkalinity } from './lsi-calculator';
import { buildTargets, type SurfaceType } from './chemistry-targets';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DosingTarget {
  pH: { min: number; max: number; ideal: number };
  alkalinity: { min: number; max: number; ideal: number };
  calciumHardness: { min: number; max: number; ideal: number };
  cya: { min: number; max: number; ideal: number };
  freeChlorine: { min: number; max: number; ideal: number };
  bromine: { min: number; max: number; ideal: number };
  phosphates: { max: number };
  copper: { max: number };
  iron: { max: number };
  salt: { min: number; max: number; ideal: number };
  combinedChlorine: { max: number };
}

export interface ChemicalAlternative {
  chemical: string;
  amount: number;
  unit: string;
  note: string;
  /** null = explicitly no secondary; undefined = inherit from primary */
  secondaryAdjustment?: ParameterAdjustment | null;
}

export interface ParameterAdjustment {
  parameterName: string;
  currentValue: number;
  targetValue: number;
  /** true = moving away from ideal (warning amber), false = moving toward target (green) */
  isAdverse?: boolean;
}

export interface ChemicalDose {
  chemical: string;
  purpose: string;
  amount: number;
  unit: string;
  order: number;
  safetyNote?: string;
  currentValue: number;
  targetValue: number;
  parameterName: string;
  alternatives?: ChemicalAlternative[];
  skipVisitLimit?: boolean;
  secondaryAdjustment?: ParameterAdjustment;
}

export interface ChemicalInteraction {
  chemicals: [string, string];
  warning: string;
  severity: 'danger' | 'caution';
}

export interface ProjectedValues {
  pH: number;
  totalAlkalinity: number;
  calciumHardness: number;
  cya: number;
  freeChlorine: number;
  totalChlorine: number;
  salt: number;
  bromine: number;
  phosphates: number;
}

export interface ValidationWarning {
  parameter: string;
  projected: number;
  targetMin: number;
  targetMax: number;
  message: string;
}

// Tracks when the LSI optimizer chose NOT to apply a polish nudge because the
// water was already in an acceptable state and the added tech time wasn't
// worth the marginal LSI improvement. Surfaced in the UI so techs/customers
// see what the engine chose not to do and why.
export interface PolishSkip {
  parameter: 'pH' | 'TA' | 'CH';
  reason: string;
  startingLSI: number;
  projectedLSIWithDose: number;
  projectedLSIWithoutDose: number;
  estimatedMinutesSaved: number;
}

// Options bag on calculateDosing — keeps the positional API stable while
// letting callers flip behavior flags without a breaking signature change.
export interface CalculateDosingOptions {
  // When true, the LSI optimizer runs `isPolishDoseWorthIt` before applying
  // any pH/TA/CH nudge. If the polish fails the gate (water already
  // acceptable, marginal LSI gain, etc.) the nudge is skipped and a
  // PolishSkip record is added to the result. Opt-in so we can field-test
  // before making it default-on.
  skipPolishDoses?: boolean;
}

export interface IntermediateState {
  step: number;
  chemical: string;
  pH: number;
  totalAlkalinity: number;
  calciumHardness: number;
  lsi: number;
  precipitationRisk: boolean;
}

export interface DosingResult {
  doses: ChemicalDose[];
  returnVisitDoses: ChemicalDose[];
  interactions: ChemicalInteraction[];
  disclaimer: string;
  projectedValues?: ProjectedValues;
  projectedLSI?: number;
  returnVisitProjectedLSI?: number;
  validationWarnings?: ValidationWarning[];
  intermediateStates?: IntermediateState[];
  precipitationWarning?: string;
  readingWarnings?: string[];
  // Authoritative swim-safety result — computed at dosing time and persisted alongside
  // the plan so every downstream consumer (LSEye shared report, puddlenj service report,
  // any future tool) reads the SAME answer instead of re-implementing the logic.
  // Duration-only; callers render absolute times relative to their own completion moment.
  safeToSwim?: SafeToSwimResult;
  // LSI-optimizer polish nudges that the gate function chose not to apply
  // because the water was already acceptable. Empty/undefined when
  // skipPolishDoses is false or no polish was ever considered.
  polishSkips?: PolishSkip[];
}

export interface SafeToSwimResult {
  type: 'none' | 'simple' | 'calculated';
  waitMinutes: number;
  safeTime: Date;
  reason: string;
}

export interface DosingRate {
  dose_per_10k: number;
  dose_unit: string;
  visit_limit_per_10k: number | null;
}

export type DosingRateMap = Record<string, DosingRate>;

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_TARGETS: DosingTarget = {
  pH: { min: 7.4, max: 7.6, ideal: 7.5 },
  alkalinity: { min: 80, max: 120, ideal: 100 },
  calciumHardness: { min: 200, max: 400, ideal: 275 },
  cya: { min: 30, max: 50, ideal: 30 },
  freeChlorine: { min: 2, max: 4, ideal: 3 },
  bromine: { min: 3, max: 5, ideal: 4 },
  phosphates: { max: 500 },
  copper: { max: 0.2 },
  iron: { max: 0.2 },
  salt: { min: 2700, max: 3400, ideal: 3200 },
  combinedChlorine: { max: 0.4 },
};

const DISCLAIMER =
  'These are estimates based on industry-standard dosing rates. Pre-dissolve granular chemicals in a bucket of pool water before adding. Liquid chemicals can be poured directly with the pump running. Never mix chemicals directly.';

// ─── Dosing Rates — fallbacks used when DB rates unavailable ─────────────────
// Primary source: Knorr Systems chemical dosing charts (knorrsystems.com/chemical-dosing-charts)
// Cross-referenced: CPO Handbook Ch.3, Swim University dosing guide, Indiana DOH guide
// Acid amounts now use the Knorr non-linear lookup table (totalAcidDose). Visit limits still reference these entries.

export const FALLBACK_RATES: DosingRateMap = {
  'Muriatic Acid (31.45%)':                    { dose_per_10k: 12,   dose_unit: 'fl oz', visit_limit_per_10k: 52 },  // Knorr: ~10.7 fl oz/0.2 pH at TA 90; scaled to TA 100 ≈ 12
  'Sodium Bisulfate (pH Down)':                { dose_per_10k: 1.0,  dose_unit: 'lbs',   visit_limit_per_10k: 4 },   // Knorr cross-ref; stoichiometric equiv of muriatic
  'Soda Ash (Sodium Carbonate)':               { dose_per_10k: 6,    dose_unit: 'oz',    visit_limit_per_10k: null }, // Knorr: 6 oz/0.2 pH; SU: 6-8 oz/0.2 pH
  'pH Up':                                     { dose_per_10k: 6,    dose_unit: 'oz',    visit_limit_per_10k: null }, // Same as soda ash (active ingredient)
  'Sodium Bicarbonate (Baking Soda)':          { dose_per_10k: 1.4,  dose_unit: 'lbs',   visit_limit_per_10k: 3 },   // Knorr: 1.4 lbs/10 ppm TA (exact match)
  'Calcium Chloride (100%)':                   { dose_per_10k: 0.9,  dose_unit: 'lbs',   visit_limit_per_10k: 10 },  // Knorr: 0.9 lbs/10 ppm CH (100%); 1.2 for 77%
  'Cyanuric Acid (Stabilizer)':                { dose_per_10k: 13,   dose_unit: 'oz',    visit_limit_per_10k: 26 },  // Knorr: 13 oz/10 ppm CYA (exact match)
  'Liquid Chlorine (12.5% Sodium Hypochlorite)': { dose_per_10k: 10, dose_unit: 'fl oz', visit_limit_per_10k: null }, // Knorr: 10 fl oz/1 ppm FC (exact match)
  'Calcium Hypochlorite (Shock)':              { dose_per_10k: 2,    dose_unit: 'oz',    visit_limit_per_10k: 24 },  // Knorr: 2 oz/1 ppm FC (67% cal-hypo, exact match)
  'MPS Oxidizing Shock (Non-Chlorine)':        { dose_per_10k: 1,    dose_unit: 'lbs',   visit_limit_per_10k: null }, // Manufacturer label (1 lb/10k gal standard dose)
  'Brominating Granular':                      { dose_per_10k: 3.3,  dose_unit: 'oz',    visit_limit_per_10k: null }, // Stoichiometric ~2.7-2.9; 3.3 is conservative field value
  'Chlorinating Granular (Dichlor)':           { dose_per_10k: 2.4,  dose_unit: 'oz',    visit_limit_per_10k: null }, // Stoichiometric from 56% available chlorine (dihydrate, standard retail product)
  'Phosphate Remover':                         { dose_per_10k: 8,    dose_unit: 'fl oz', visit_limit_per_10k: null }, // Orenda PR-10,000 label (8 oz/10k for 500-1000 ppb)
  'Metal Magnet (Sequestrant)':                { dose_per_10k: 32,   dose_unit: 'fl oz', visit_limit_per_10k: null }, // Manufacturer label (initial dose 32 oz/10k gal)
  'Pool Salt':                                 { dose_per_10k: 30,   dose_unit: 'lbs',   visit_limit_per_10k: 100 }, // SU Pool Care Handbook: 267 lbs/10k = 0→3200; 30/360
};

// Hard ceiling on Calcium Chloride per visit, regardless of pool size.
// Tech preference / handling safety — pre-dissolving more than 10 lbs in a single
// visit is impractical. Remainder is dropped (not deferred) so we don't cap-and-
// schedule a 30-lb dose across three weekly visits.
const CACL_ABSOLUTE_CAP_LBS = 10;

// Salt reading at or above this is treated as evidence of a salt system even when
// the caller's `is_salt_system` flag is false. Spintouch in non-salt pools usually
// reads <300 ppm; >=500 indicates either a real SWG (possibly depleted) or a pool
// with very high TDS — both worth flagging and dosing as salt-flavored.
const SALT_AUTO_DETECT_THRESHOLD = 500;

// ─── Fill Water Defaults (Monmouth County NJ municipal water) ────────────────
// Source: Joint Water Commission 2025/2026 water quality reports
// These are used to model blended dilution when calculating drain results.
// CYA is always 0 in municipal water; FC is negligible post-drain.

export const FILL_WATER = {
  calciumHardness: 25,    // ~25 ppm CH (total hardness 30, ~80% is calcium)
  totalAlkalinity: 30,    // 28-34 ppm measured
  tds: 150,               // estimated for soft NJ water
  cya: 0,                 // no CYA in tap water
  freeChlorine: 0,        // negligible after drain/refill mixing
};

/** Blended dilution: models what happens when you drain X% and refill with tap water */
function blendedDilute(poolValue: number, fillValue: number, drainFraction: number): number {
  return poolValue * (1 - drainFraction) + fillValue * drainFraction;
}

function getRate(rates: DosingRateMap, name: string): DosingRate | undefined {
  return rates[name] ?? FALLBACK_RATES[name];
}

function r(rates: DosingRateMap, name: string, fallback: number): number {
  return getRate(rates, name)?.dose_per_10k ?? fallback;
}

function rUnit(rates: DosingRateMap, name: string, fallback: string): string {
  return getRate(rates, name)?.dose_unit ?? fallback;
}

// ─── Knorr Cumulative Acid Lookup Table ─────────────────────────────────────
// Cumulative muriatic acid (31.45% HCl, fl oz per 10,000 gal) to reach pH 7.6.
// Source: Knorr Systems Chemical Dosing Charts (knorrsystems.com/chemical-dosing-charts)
// Chart states "TA between 60-120 ppm"; calibrated here at TA 90 (midpoint).
// Above 8.4 and below 7.6: extrapolated from buffer-capacity decay trends.
// Orenda equivalence: 12.1 fl oz muriatic acid (31.45%) = 1 lb sodium bisulfate (93.2%).
//
// Why a lookup table instead of constant rate?
// The acid needed per 0.2 pH step varies dramatically with pH due to carbonate buffering:
//   7.8→7.6: 10.7 fl oz  |  8.0→7.8: 9.3  |  8.2→8.0: 8.0  |  8.4→8.2: 4.0
// A constant rate (calibrated at 7.8→7.6) over-doses by 50-150% at higher starting pH.

const KNORR_ACID_TABLE: [number, number][] = [
  [7.2, -21.4],  // extrapolated — near carbonate pKa₁, high buffering
  [7.4, -10.7],  // extrapolated — ~10.7 fl oz per 0.2 in this zone
  [7.6,   0  ],  // baseline (Knorr target pH)
  [7.8,  10.7],  // Knorr: 1⅓ cups (measured)
  [8.0,  20.0],  // Knorr: 2½ cups (measured)
  [8.2,  28.0],  // Knorr: 3½ cups (measured)
  [8.4,  32.0],  // Knorr: ¼ gallon (measured)
  [8.6,  34.0],  // extrapolated — weak buffering above 8.4
  [8.8,  35.0],  // extrapolated
  [9.0,  35.5],  // extrapolated
];
const KNORR_TA_BASELINE = 90; // ppm — TA midpoint of Knorr's "60-120 ppm" range
const MA_FLOZ_PER_LB_SB = 12.1; // Orenda: 12.1 fl oz 31.45% HCl ≡ 1 lb 93.2% NaHSO₄

/** Interpolate cumulative acid (fl oz MA per 10k gal at TA 90) from the Knorr table. */
function interpolateKnorr(pH: number): number {
  const t = KNORR_ACID_TABLE;
  if (pH <= t[0][0]) {
    const rate = (t[1][1] - t[0][1]) / (t[1][0] - t[0][0]);
    return t[0][1] + (pH - t[0][0]) * rate;
  }
  const last = t.length - 1;
  if (pH >= t[last][0]) {
    const rate = (t[last][1] - t[last - 1][1]) / (t[last][0] - t[last - 1][0]);
    return t[last][1] + (pH - t[last][0]) * rate;
  }
  for (let i = 1; i < t.length; i++) {
    if (pH <= t[i][0]) {
      const [pLo, aLo] = t[i - 1];
      const [pHi, aHi] = t[i];
      return aLo + (pH - pLo) / (pHi - pLo) * (aHi - aLo);
    }
  }
  return t[last][1];
}

/**
 * Total acid needed to lower pH, using the Knorr non-linear lookup table.
 * Returns amount in the chemical's native unit (fl oz for muriatic, lbs for bisulfate).
 * Scales linearly with TA (from Knorr baseline of 90 ppm) and pool volume.
 */
function totalAcidDose(fromPH: number, toPH: number, chemical: 'ma' | 'sb', taPPM: number, scale: number): number {
  if (fromPH <= toPH) return 0;
  const maFlOzPer10k = interpolateKnorr(fromPH) - interpolateKnorr(toPH);
  const maFlOz = maFlOzPer10k * (taPPM / KNORR_TA_BASELINE) * scale;
  if (chemical === 'ma') return round1(maFlOz);
  return round1(maFlOz / MA_FLOZ_PER_LB_SB);
}

function applyAdjustment(proj: ProjectedValues, paramName: string, targetValue: number) {
  switch (paramName) {
    case 'pH': proj.pH = targetValue; break;
    case 'Total Alkalinity': proj.totalAlkalinity = targetValue; break;
    case 'Calcium Hardness': proj.calciumHardness = targetValue; break;
    case 'CYA (Stabilizer)': proj.cya = targetValue; break;
    case 'Free Chlorine': proj.freeChlorine = targetValue; break;
    case 'Salt': proj.salt = targetValue; break;
    case 'Bromine': proj.bromine = targetValue; break;
    case 'Phosphates': proj.phosphates = targetValue; break;
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ─── LSI Solvers ────────────────────────────────────────────────────────────
// Algebraically solve for the parameter value that achieves a target LSI.
// LSI = pH - pHs,  pHs = (9.3 + A + B) - (C + D)
// A = (log10(TDS) - 1) / 10,  B = -13.12 * log10(tempK) + 34.55
// C = log10(CH) - 0.4,  D = log10(carbonateAlk)

const LSI_TARGET = 0.10; // Orenda: target slightly positive (~+0.1) for calcium stability

function lsiConstants(temperature: number, tds: number) {
  const tempC = (temperature - 32) * (5 / 9);
  const tempK = tempC + 273.15;
  const A = (Math.log10(Math.max(1, tds)) - 1) / 10;
  const B = -13.12 * Math.log10(tempK) + 34.55;
  return { A, B };
}

function solveTA_forLSI(
  pH: number, temperature: number, calciumHardness: number, tds: number, cya: number,
  targetLSI: number = LSI_TARGET,
): number | null {
  const { A, B } = lsiConstants(temperature, tds);
  const C = Math.log10(Math.max(1, calciumHardness)) - 0.4;
  const targetPHs = pH - targetLSI;
  const D = (9.3 + A + B) - targetPHs - C;
  if (D <= 0) return null;
  const carbonateAlk = Math.pow(10, D);
  return Math.round(carbonateAlk + cya * getCyaCorrectionFactor(pH));
}

function solveCH_forLSI(
  pH: number, temperature: number, totalAlkalinity: number, tds: number, cya: number,
  targetLSI: number = LSI_TARGET,
): number | null {
  const { A, B } = lsiConstants(temperature, tds);
  const carbonateAlk = getCarbonateAlkalinity(totalAlkalinity, cya, pH);
  const D = Math.log10(Math.max(1, carbonateAlk));
  const targetPHs = pH - targetLSI;
  const C = (9.3 + A + B) - targetPHs - D;
  const ch = Math.round(Math.pow(10, C + 0.4));
  return ch > 0 ? ch : null;
}

function solvePH_forLSI(
  temperature: number, calciumHardness: number, totalAlkalinity: number, tds: number, cya: number,
  targetLSI: number = LSI_TARGET,
): number | null {
  // LSI = pH - pHs.  pHs depends on pH through CYA correction factor,
  // so we iterate: guess pH, compute pHs, check LSI, adjust.
  let pH = 7.5; // start at ideal
  for (let i = 0; i < 20; i++) {
    const { A, B } = lsiConstants(temperature, tds);
    const carbonateAlk = getCarbonateAlkalinity(totalAlkalinity, cya, pH);
    const C = Math.log10(Math.max(1, calciumHardness)) - 0.4;
    const D = Math.log10(Math.max(1, carbonateAlk));
    const pHs = (9.3 + A + B) - (C + D);
    const lsi = pH - pHs;
    const err = lsi - targetLSI;
    if (Math.abs(err) < 0.005) return round1(pH);
    pH -= err * 0.5; // damped Newton step
  }
  return round1(pH);
}

// ─── LSI-First Target Adjustment ────────────────────────────────────────────
// Orenda principle: "LSI first, range chemistry second." Water cares about
// calcium carbonate equilibrium, not individual parameter ranges.
// When the profile ideals don't produce balanced LSI (common in cold water,
// low-CH vinyl pools, or salt systems), adjust CH and TA ideals so the
// individual dosers naturally target balanced water.
//
// Priority: CH first (no cross-effects on pH/TA), then TA if needed.

function adjustTargetsForLSI(input: WaterTestInput, targets: DosingTarget): DosingTarget {
  // Compute LSI at profile ideal targets (using current CYA and temp as approximations)
  const projectedCYA = input.cya < targets.cya.min ? targets.cya.ideal : input.cya;
  const idealLSI = calculateLSI({
    ...input,
    pH: targets.pH.ideal,
    totalAlkalinity: targets.alkalinity.ideal,
    calciumHardness: targets.calciumHardness.ideal,
    cya: projectedCYA,
  }, 'formula').lsi;

  // If ideal targets already produce balanced LSI, no adjustment needed
  if (Math.abs(idealLSI) <= 0.20) return targets;

  // Clone targets to avoid mutating the caller's object
  const adj: DosingTarget = {
    ...targets,
    calciumHardness: { ...targets.calciumHardness },
    alkalinity: { ...targets.alkalinity },
  };

  // Step 1: Solve for CH that gives LSI ≈ +0.10 at ideal pH and TA
  const lsiCH = solveCH_forLSI(
    targets.pH.ideal, input.temperature,
    targets.alkalinity.ideal, input.tds, projectedCYA,
    LSI_TARGET,
  );

  if (lsiCH !== null && lsiCH > 0) {
    // Clamp to profile range — don't go below min or above max
    adj.calciumHardness.ideal = Math.round(
      Math.max(adj.calciumHardness.min, Math.min(adj.calciumHardness.max, lsiCH))
    );
    // If current CH is below the new ideal, also lower min to trigger dosing
    // (but never below the original profile min)
    if (adj.calciumHardness.ideal > adj.calciumHardness.min && input.calciumHardness < adj.calciumHardness.ideal) {
      adj.calciumHardness.min = Math.min(adj.calciumHardness.ideal, adj.calciumHardness.min);
    }
  }

  // Step 2: Check if adjusted CH fixes LSI
  const afterCH = calculateLSI({
    ...input,
    pH: targets.pH.ideal,
    totalAlkalinity: targets.alkalinity.ideal,
    calciumHardness: adj.calciumHardness.ideal,
    cya: projectedCYA,
  }, 'formula').lsi;

  if (Math.abs(afterCH) > 0.20) {
    // CH alone wasn't enough (e.g., clamped at max) — also adjust TA
    const lsiTA = solveTA_forLSI(
      targets.pH.ideal, input.temperature,
      adj.calciumHardness.ideal, input.tds, projectedCYA,
      LSI_TARGET,
    );

    if (lsiTA !== null && lsiTA > 0) {
      adj.alkalinity.ideal = Math.round(
        Math.max(adj.alkalinity.min, Math.min(adj.alkalinity.max, lsiTA))
      );
    }
  }

  return adj;
}

// ─── Spa / System Detection ─────────────────────────────────────────────────

function isSpa(input: WaterTestInput): boolean {
  // Residential hot tubs run 200-700 gal; larger swim spas 1500+. The 800-gal
  // cutoff catches typical spas without grabbing dipping pools or cold plunges.
  // Callers should pass isSpaOverride when known — this fallback only fires
  // when the form/OCR didn't supply one.
  return (input.poolVolume ?? 0) > 0 && (input.poolVolume ?? 0) <= 800;
}

function isBromineSystem(input: WaterTestInput): boolean {
  // Spintouch is mode-selectable (chlorine OR bromine), so trace bromine on a
  // chlorine pool isn't a cross-reagent issue. Real risk: stale form data,
  // OCR mis-reads, or a tech running the wrong test. A real bromine reading
  // sits at 3-5 ppm; require >= 0.5 ppm so the heuristic doesn't trip on noise
  // when isBromineOverride is unset. Depleted bromine spas under 0.5 ppm need
  // an explicit override from the form.
  return (input.bromine ?? 0) >= 0.5;
}

// ─── Individual Dosing Functions ─────────────────────────────────────────────

function dosePH(
  current: number,
  target: DosingTarget['pH'],
  volumeGallons: number,
  spa: boolean,
  rates: DosingRateMap,
  taCurrentPPM: number = 0,
): ChemicalDose | null {
  const scale = volumeGallons / 10000;
  const MA = 'Muriatic Acid (31.45%)';
  const SB = 'Sodium Bisulfate (pH Down)';
  const SA = 'Soda Ash (Sodium Carbonate)';
  const PU = 'pH Up';

  if (current > target.max) {
    if (spa) {
      const amount = totalAcidDose(current, target.ideal, 'sb', taCurrentPPM, scale);
      return {
        chemical: SB,
        purpose: `Lower pH from ${current.toFixed(1)} to ${target.ideal.toFixed(1)}`,
        amount,
        unit: rUnit(rates, SB, 'lbs'),
        order: 2,
        safetyNote: 'Pre-dissolve in a bucket of warm water before adding to spa.',
        currentValue: current,
        targetValue: target.ideal,
        parameterName: 'pH',
      };
    }

    const amount = totalAcidDose(current, target.ideal, 'ma', taCurrentPPM, scale);
    return {
      chemical: MA,
      purpose: `Lower pH from ${current.toFixed(1)} to ${target.ideal.toFixed(1)}`,
      amount,
      unit: rUnit(rates, MA, 'fl oz'),
      order: 2,
      safetyNote:
        'Pour slowly around the deep end with the pump running. Never add water to acid.',
      currentValue: current,
      targetValue: target.ideal,
      parameterName: 'pH',
      alternatives: [
        {
          chemical: 'Sodium Bisulfate (Dry Acid)',
          amount: totalAcidDose(current, target.ideal, 'sb', taCurrentPPM, scale),
          unit: rUnit(rates, SB, 'lbs'),
          note: 'Granular — pre-dissolve in bucket. Easier to handle and safer to store than liquid acid.',
        },
      ],
    };
  }

  if (current < target.min) {
    const delta = target.ideal - current;
    const doses = delta / 0.2;
    const chemName = spa ? PU : SA;
    const amount = round1(doses * r(rates, chemName, 6) * scale);
    const taIncrease = Math.round(doses * 5); // Pool Spa News: soda ash raises TA ~5 ppm per 0.2 pH
    return {
      chemical: chemName,
      purpose: `Raise pH from ${current.toFixed(1)} to ${target.ideal.toFixed(1)}`,
      amount,
      unit: rUnit(rates, chemName, 'oz'),
      order: 2,
      safetyNote: 'Pre-dissolve in a bucket of warm water before adding. Soda ash is caustic (pH ~11.5).',
      currentValue: current,
      targetValue: target.ideal,
      parameterName: 'pH',
      secondaryAdjustment: taIncrease >= 3 ? {
        parameterName: 'Total Alkalinity',
        currentValue: taCurrentPPM,
        targetValue: taCurrentPPM + taIncrease,
      } : undefined,
    };
  }

  return null;
}

function doseAlkalinity(
  current: number,
  target: DosingTarget['alkalinity'],
  volumeGallons: number,
  currentPH: number,
  spa: boolean,
  rates: DosingRateMap,
  phTarget?: { min: number; max: number; ideal: number },
): ChemicalDose | null {
  const scale = volumeGallons / 10000;
  const BICARB = 'Sodium Bicarbonate (Baking Soda)';
  const MA = 'Muriatic Acid (31.45%)';
  const SB = 'Sodium Bisulfate (pH Down)';

  if (current < target.min) {
    const delta = target.ideal - current;
    const increments = delta / 10;
    const amount = round1(increments * r(rates, BICARB, 1.4) * scale);
    // Bicarb raises pH ~0.05 per 10 ppm TA bump (Pool Spa News). Attach the
    // side effect so projection reflects the actual chemistry — without this,
    // a low-pH/low-TA pool gets a big bicarb dose and the report shows pH
    // unchanged even though the chemistry says it should rise meaningfully.
    const phBump = round1(increments * 0.05);
    return {
      chemical: BICARB,
      purpose: `Raise Total Alkalinity from ${current} to ${target.ideal} ppm`,
      amount,
      unit: rUnit(rates, BICARB, 'lbs'),
      order: 1,
      currentValue: current,
      targetValue: target.ideal,
      parameterName: 'Total Alkalinity',
      secondaryAdjustment: phBump >= 0.1 ? {
        parameterName: 'pH',
        currentValue: currentPH,
        targetValue: round1(currentPH + phBump),
      } : undefined,
    };
  }

  if (current > target.max) {
    // pH is high enough to dose acid — lower pH toward target min, which also lowers TA.
    // Never go below the profile's pH min (salt pools: 7.4, standard: 7.2, spa: 7.4).
    const acidPHTarget = phTarget?.min ?? (spa ? 7.4 : 7.2);

    // When pH is already at or below the acid target, only aeration can lower TA
    if (currentPH <= acidPHTarget) {
      return {
        chemical: 'Aeration',
        purpose: `Lower Total Alkalinity from ${current} toward ${target.ideal} ppm`,
        amount: 0,
        unit: '',
        order: 1,
        safetyNote:
          spa
            ? `pH is ${currentPH} — no acid needed this visit. Run jets with cover open to off-gas CO₂. TA will drift down over time.`
            : `pH is ${currentPH} — no acid needed this visit. Run water features or point returns up to off-gas CO₂. TA will drift down over time.`,
        currentValue: current,
        targetValue: target.ideal,
        parameterName: 'Total Alkalinity',
      };
    }

    const phDelta = currentPH - acidPHTarget;
    const phDoses = phDelta / 0.2;

    // Acid drops TA by ~4 ppm per 0.2 pH (CPO Handbook). Project single-visit TA loss.
    const taLossFromAcid = Math.round(phDoses * 4);
    const projectedTA = Math.max(target.ideal, current - taLossFromAcid);

    if (spa) {
      const amount = totalAcidDose(currentPH, acidPHTarget, 'sb', current, scale);
      return {
        chemical: SB,
        purpose: `Lower pH and Total Alkalinity`,
        amount,
        unit: rUnit(rates, SB, 'lbs'),
        order: 1,
        safetyNote:
          current - taLossFromAcid > target.ideal
            ? `Pre-dissolve and add to spa. Run jets with cover open after dosing to aerate. TA will continue dropping over multiple visits (target: ${target.ideal} ppm).`
            : `Pre-dissolve and add to spa. Run jets with cover open after dosing to aerate.`,
        currentValue: currentPH,
        targetValue: acidPHTarget,
        parameterName: 'pH',
        secondaryAdjustment: {
          parameterName: 'Total Alkalinity',
          currentValue: current,
          targetValue: projectedTA,
        },
      };
    }

    const amount = totalAcidDose(currentPH, acidPHTarget, 'ma', current, scale);
    return {
      chemical: MA,
      purpose: `Lower pH and Total Alkalinity`,
      amount,
      unit: rUnit(rates, MA, 'fl oz'),
      order: 1,
      safetyNote:
        current - taLossFromAcid > target.ideal
          ? `Pour acid slowly around deep end with pump running. Aerate after dosing (water features, returns up). TA will continue dropping over multiple visits (target: ${target.ideal} ppm).`
          : `Pour acid slowly around deep end with pump running. Aerate after dosing (water features, returns up).`,
      currentValue: currentPH,
      targetValue: acidPHTarget,
      parameterName: 'pH',
      secondaryAdjustment: {
        parameterName: 'Total Alkalinity',
        currentValue: current,
        targetValue: projectedTA,
      },
      alternatives: [
        {
          chemical: 'Sodium Bisulfate (Dry Acid)',
          amount: totalAcidDose(currentPH, acidPHTarget, 'sb', current, scale),
          unit: rUnit(rates, SB, 'lbs'),
          note: 'Granular — pre-dissolve in bucket. Easier to handle and safer to store than liquid acid.',
        },
      ],
    };
  }

  return null;
}

function doseCalcium(
  current: number,
  target: DosingTarget['calciumHardness'],
  volumeGallons: number,
  spa: boolean,
  rates: DosingRateMap,
  startingLSI: number = 0,
): ChemicalDose | null {
  const scale = volumeGallons / 10000;
  const CC = 'Calcium Chloride (100%)';

  if (current < target.min) {
    const delta = target.ideal - current;
    const increments = delta / 10;
    const amount = round1(increments * r(rates, CC, 0.9) * scale);

    if (spa) {
      return {
        chemical: CC,
        purpose: `Raise Calcium Hardness from ${current} to ${target.ideal} ppm`,
        amount,
        unit: rUnit(rates, CC, 'lbs'),
        order: 0,
        safetyNote: 'Pre-dissolve in a bucket of warm water and pour directly into spa. Vacuum while calcium disperses — recirculating vacuum helps distribute evenly. Turn jets on after vacuuming, then proceed to next step.',
        currentValue: current,
        targetValue: target.ideal,
        parameterName: 'Calcium Hardness',
      };
    }

    return {
      chemical: CC,
      purpose: `Raise Calcium Hardness from ${current} to ${target.ideal} ppm`,
      amount,
      unit: rUnit(rates, CC, 'lbs'),
      order: 3,
      safetyNote: 'Pre-dissolve in a bucket of water. Add slowly around the pool perimeter.',
      currentValue: current,
      targetValue: target.ideal,
      parameterName: 'Calcium Hardness',
    };
  }

  if (current > target.max) {
    // Don't drain CH when water is already corrosive — higher CH helps LSI.
    // Draining calcium from slightly-above-max makes LSI worse, fighting the
    // LSI-first adjustment that just tried to raise CH for balance.
    if (startingLSI < -0.3) return null;

    // Blended dilution: drain% = (current - target) / (current - fillWater)
    const fillCH = FILL_WATER.calciumHardness;
    const drainPct = current > fillCH
      ? Math.round(((current - target.ideal) / (current - fillCH)) * 100)
      : Math.round((1 - target.ideal / current) * 100);
    const drainGal = Math.round(volumeGallons * drainPct / 100);
    return {
      chemical: 'Partial Drain & Refill',
      purpose: `Lower Calcium Hardness from ${current} to ~${target.ideal} ppm`,
      amount: 0,
      unit: '',
      order: spa ? 0 : 3,
      safetyNote:
        `Calcium can only be reduced by dilution. Drain ~${drainPct}% (~${drainGal} gal) and refill with fresh water.`,
      currentValue: current,
      targetValue: target.ideal,
      parameterName: 'Calcium Hardness',
    };
  }

  return null;
}

function doseCYA(
  current: number,
  target: DosingTarget['cya'],
  volumeGallons: number,
  rates: DosingRateMap
): ChemicalDose | null {
  const scale = volumeGallons / 10000;
  const CYA = 'Cyanuric Acid (Stabilizer)';

  if (current < target.min) {
    const delta = target.ideal - current;
    const increments = delta / 10;
    const amount = round1(increments * r(rates, CYA, 13) * scale);
    return {
      chemical: CYA,
      purpose: `Raise CYA from ${current} to ${target.ideal} ppm`,
      amount,
      unit: rUnit(rates, CYA, 'oz'),
      order: 4,
      safetyNote: 'Add to skimmer basket with pump running, or dissolve in warm water first.',
      currentValue: current,
      targetValue: target.ideal,
      parameterName: 'CYA (Stabilizer)',
    };
  }

  if (current > target.max) {
    const drainPct = Math.round((1 - target.ideal / current) * 100);
    const drainGal = Math.round(volumeGallons * drainPct / 100);
    return {
      chemical: 'Partial Drain & Refill',
      purpose: `Lower CYA from ${current} to ${target.ideal} ppm`,
      amount: 0,
      unit: '',
      order: 4,
      safetyNote:
        `CYA can only be reduced by dilution. Drain ~${drainPct}% (~${drainGal} gal) and refill with fresh water.`,
      currentValue: current,
      targetValue: target.ideal,
      parameterName: 'CYA (Stabilizer)',
    };
  }

  return null;
}

function doseChlorine(
  current: number | undefined,
  target: DosingTarget['freeChlorine'],
  volumeGallons: number,
  cya: number,
  isSaltPool: boolean,
  spa: boolean,
  rates: DosingRateMap
): ChemicalDose | null {
  if (current === undefined) return null;
  const scale = volumeGallons / 10000;
  const LC = 'Liquid Chlorine (12.5% Sodium Hypochlorite)';
  const DI = 'Chlorinating Granular (Dichlor)';
  const CH = 'Calcium Hypochlorite (Shock)';

  // Adjust FC target based on CYA — Source: TFP FC/CYA Chart (chem_geek)
  // SWG: 5% minimum (PCTI/TFP); Non-SWG: 7.5% min (TFP), ~11.5% target, ~40% shock
  const cyaRatio = isSaltPool ? 0.05 : 0.075;
  const cyaMinFC = round1(cya * cyaRatio);
  const effectiveIdeal = Math.max(target.ideal, cyaMinFC);
  const effectiveMin = Math.max(target.min, cyaMinFC);

  if (current < effectiveMin) {
    const delta = effectiveIdeal - current;
    const lcAmount = round1(delta * r(rates, LC, 10) * scale);
    const diAmount = round1(delta * r(rates, DI, 3.3) * scale);
    const chAmount = round1(delta * r(rates, CH, 2) * scale);
    const saltNote = isSaltPool
      ? ' If SWG (salt chlorine generator) is installed, consider increasing output % before adding liquid chlorine.'
      : '';

    // Secondary effects
    const cyaFromDichlor = Math.round(delta * 0.9); // Stoichiometric: 129.07/143.35 = 0.900 (exact)
    const secondaryEffect: ParameterAdjustment | undefined =
      spa && cyaFromDichlor >= 1
        ? { parameterName: 'CYA (Stabilizer)', currentValue: cya, targetValue: cya + cyaFromDichlor, isAdverse: true }
        : undefined;

    const cyaPct = isSaltPool ? '5' : '7.5';
    const cyaNote = effectiveIdeal > target.ideal
      ? ` FC target raised to ${effectiveIdeal} ppm — minimum ${cyaPct}% of CYA (${cya} ppm) for effective sanitization.`
      : '';

    return {
      chemical: spa ? DI : LC,
      purpose: `Raise Free Chlorine from ${current} to ${effectiveIdeal} ppm`,
      amount: spa ? diAmount : lcAmount,
      unit: spa ? rUnit(rates, DI, 'oz') : rUnit(rates, LC, 'fl oz'),
      order: 5,
      safetyNote: spa
        ? `Pre-dissolve in a bucket of warm water. Add with jets running.${cyaNote}`
        : `Add with pump running. Liquid chlorine has a high pH (~13) and may raise pH slightly.${saltNote}${cyaNote}`,
      currentValue: current,
      targetValue: effectiveIdeal,
      parameterName: 'Free Chlorine',
      secondaryAdjustment: secondaryEffect,
      alternatives: spa
        ? [
            {
              chemical: 'Liquid Chlorine (12.5%)',
              amount: lcAmount,
              unit: rUnit(rates, LC, 'fl oz'),
              note: 'Add with jets running. High pH (~13) — may raise pH slightly.',
              secondaryAdjustment: null,
            },
            {
              chemical: '1" Chlorine Tabs',
              amount: 0,
              unit: '',
              note: 'Slow-release via floating dispenser — best for ongoing maintenance',
              secondaryAdjustment: null,
            },
          ]
        : isSaltPool
          ? [
              {
                chemical: 'Increase SWG Output',
                amount: 0,
                unit: '',
                note: 'If SWG is installed, consider increasing output % before adding liquid chlorine.',
              },
            ]
          : [
              {
                chemical: 'Calcium Hypochlorite (Cal-Hypo Granules)',
                amount: chAmount,
                unit: rUnit(rates, CH, 'oz'),
                note: `Fast-dissolving granules — pre-dissolve in bucket. Also raises calcium hardness (~${round1(delta * 0.8)} ppm CH).`, // 0.8: PHTA industry figure for commercial cal-hypo
              },
              {
                chemical: '3" Chlorine Tabs (Pucks)',
                amount: 0,
                unit: '',
                note: 'Slow-release via floating dispenser or chlorinator — best for ongoing maintenance, adds CYA over time',
              },
            ],
    };
  }

  return null;
}

function doseBromine(
  current: number | undefined,
  target: DosingTarget['bromine'],
  volumeGallons: number,
  rates: DosingRateMap
): ChemicalDose | null {
  if (current === undefined || current <= 0) return null;
  const scale = volumeGallons / 10000;
  const BG = 'Brominating Granular';

  if (current < target.min) {
    const delta = target.ideal - current;
    const amount = round1(delta * r(rates, BG, 3.3) * scale);
    return {
      chemical: BG,
      purpose: `Raise Bromine from ${current} to ${target.ideal} ppm`,
      amount,
      unit: rUnit(rates, BG, 'oz'),
      order: 5,
      safetyNote: 'Pre-dissolve in a bucket of warm water. Add with jets running.',
      currentValue: current,
      targetValue: target.ideal,
      parameterName: 'Bromine',
      alternatives: [
        {
          chemical: '1" Bromine Tabs',
          amount: 0,
          unit: '',
          note: 'Slow-release via floating dispenser — best for ongoing maintenance',
        },
      ],
    };
  }

  return null;
}

function doseShock(
  input: WaterTestInput,
  target: DosingTarget['combinedChlorine'],
  volumeGallons: number,
  spa: boolean,
  bromineSystem: boolean,
  rates: DosingRateMap,
  surfaceType: string = 'vinyl',
  isSaltPool: boolean = false,
  chTarget?: DosingTarget['calciumHardness'],
): ChemicalDose | null {
  const fc = input.freeChlorine;
  const tc = input.totalChlorine;
  if (fc === undefined || tc === undefined) return null;

  // If TC < FC, readings are suspect — skip shock based on bad combined chlorine math.
  // ANSI/APSP-11 2019: shock when combined chlorine EXCEEDS 0.4 ppm — strict
  // comparison so a borderline 0.4 reading still triggers the protocol.
  const ccl = tc - fc;
  if (ccl < target.max) return null;

  const scale = volumeGallons / 10000;
  const MPS = 'MPS Oxidizing Shock (Non-Chlorine)';
  const CH = 'Calcium Hypochlorite (Shock)';
  const LC = 'Liquid Chlorine (12.5% Sodium Hypochlorite)';

  // Bromine systems and spas use MPS (non-chlorine shock)
  if (bromineSystem || spa) {
    // MPS rate is per 10K gal for 1 ppm oxidation; scale by CC level (min 1 ppm equivalent)
    const mpsMultiplier = Math.max(ccl, 1);
    let amount = round1(mpsMultiplier * r(rates, MPS, 1) * scale);
    let unit = rUnit(rates, MPS, 'lbs');
    // Convert to oz for small volumes (spas) where lbs rounds to 0
    if (amount < 0.1) {
      amount = round1(mpsMultiplier * r(rates, MPS, 1) * scale * 16);
      unit = 'oz';
    }
    return {
      chemical: MPS,
      purpose: `Oxidize Combined Chlorine (${ccl.toFixed(1)} ppm)`,
      amount,
      unit,
      order: 7,
      safetyNote: `Non-chlorine oxidizer — can swim 15 minutes after application.${bromineSystem ? ' Safe for bromine systems.' : ''}`,
      currentValue: round1(ccl),
      targetValue: 0,
      parameterName: 'Combined Chlorine',
    };
  }

  const breakpointFC = ccl * 10; // CPO Handbook / SU: breakpoint = 10x combined chlorine

  // Use liquid chlorine instead of cal-hypo when calcium is already high, or for fiberglass/salt pools
  const chAlreadyHigh = chTarget && input.calciumHardness >= chTarget.max;
  if (surfaceType === 'fiberglass' || isSaltPool || chAlreadyHigh) {
    const amount = round1(breakpointFC * r(rates, LC, 10) * scale);
    const mpsMultiplier = Math.max(ccl, 1);
    const mpsAmount = round1(mpsMultiplier * r(rates, MPS, 1) * scale);
    return {
      chemical: LC,
      purpose: `Breakpoint chlorinate — oxidize ${ccl.toFixed(1)} ppm Combined Chlorine`,
      amount,
      unit: rUnit(rates, LC, 'fl oz'),
      order: 7,
      safetyNote: `Add with pump running at dusk for best results. Do not swim until FC drops below ${SAFE_FC_THRESHOLD} ppm. Liquid chlorine has a high pH (~13) and may raise pH slightly.${surfaceType === 'fiberglass' ? ' Liquid chlorine used instead of cal-hypo to avoid adding calcium to fiberglass pool.' : chAlreadyHigh ? ` Liquid chlorine used instead of cal-hypo because Calcium Hardness is already at ${input.calciumHardness} ppm.` : ' Liquid chlorine used instead of cal-hypo to avoid calcium buildup on salt cell.'}`,
      currentValue: round1(ccl),
      targetValue: 0,
      parameterName: 'Combined Chlorine',
      secondaryAdjustment: { parameterName: 'Free Chlorine', currentValue: fc, targetValue: round1(fc + breakpointFC) },
      alternatives: [
        {
          chemical: MPS,
          amount: mpsAmount,
          unit: rUnit(rates, MPS, 'lbs'),
          note: 'Non-chlorine oxidizer — swim-ready in 15 min. Does not raise FC for breakpoint, but oxidizes organics and chloramines.',
          secondaryAdjustment: null,
        },
      ],
    };
  }

  // Standard chlorine pools use cal-hypo to breakpoint (10× CCL)
  const amount = round1(breakpointFC * r(rates, CH, 2) * scale);
  const chIncrease = round1(breakpointFC * 0.8); // PHTA industry figure for commercial cal-hypo
  const lcAmount = round1(breakpointFC * r(rates, LC, 10) * scale);
  const mpsMultiplier = Math.max(ccl, 1);
  const mpsAmount = round1(mpsMultiplier * r(rates, MPS, 1) * scale);
  return {
    chemical: CH,
    purpose: `Breakpoint chlorinate — oxidize ${ccl.toFixed(1)} ppm Combined Chlorine`,
    amount,
    unit: rUnit(rates, CH, 'oz'),
    order: 7,
    safetyNote: `Pre-dissolve in a bucket of water. Add at dusk for best results. Do not swim until FC drops below ${SAFE_FC_THRESHOLD} ppm. Cal-hypo will also raise Calcium Hardness by ~${chIncrease} ppm.`,
    currentValue: round1(ccl),
    targetValue: 0,
    parameterName: 'Combined Chlorine',
    secondaryAdjustment: { parameterName: 'Free Chlorine', currentValue: fc, targetValue: round1(fc + breakpointFC) },
    alternatives: [
      {
        chemical: LC,
        amount: lcAmount,
        unit: rUnit(rates, LC, 'fl oz'),
        note: `Doesn't add calcium. High pH (~13) — may raise pH slightly.`,
      },
      {
        chemical: MPS,
        amount: mpsAmount,
        unit: rUnit(rates, MPS, 'lbs'),
        note: 'Non-chlorine oxidizer — swim-ready in 15 min. Does not raise FC for breakpoint, but oxidizes organics and chloramines.',
        secondaryAdjustment: null,
      },
    ],
  };
}

function dosePhosphates(
  current: number | undefined,
  target: DosingTarget['phosphates'],
  volumeGallons: number,
  rates: DosingRateMap
): ChemicalDose | null {
  if (current === undefined || current <= target.max) return null;
  const scale = volumeGallons / 10000;
  const PR = 'Phosphate Remover';

  const reduction = current - target.max;
  const amount = round1((reduction / 1000) * r(rates, PR, 8) * scale);
  if (amount <= 0) return null; // too small to dose (tiny spa volumes)
  return {
    chemical: PR,
    purpose: `Reduce Phosphates from ${current} to <${target.max} ppb`,
    amount,
    unit: rUnit(rates, PR, 'fl oz'),
    order: 8,
    safetyNote: 'Add with pump running. May cause temporary clouding — this is normal. Run filter continuously for 24-48 hours after treatment. Dosing varies by product — check manufacturer label.',
    currentValue: current,
    targetValue: target.max,
    parameterName: 'Phosphates',
  };
}

function doseMetals(
  copper: number | undefined,
  iron: number | undefined,
  copperMax: number,
  ironMax: number,
  volumeGallons: number,
  rates: DosingRateMap
): ChemicalDose | null {
  const cu = copper ?? 0;
  const fe = iron ?? 0;
  if (cu <= copperMax && fe <= ironMax) return null;

  const scale = volumeGallons / 10000;
  const MM = 'Metal Magnet (Sequestrant)';
  const amount = round1(r(rates, MM, 32) * scale);

  const metals: string[] = [];
  if (cu > copperMax) metals.push(`Copper ${cu} ppm`);
  if (fe > ironMax) metals.push(`Iron ${fe} ppm`);

  return {
    chemical: MM,
    purpose: `Sequester elevated metals: ${metals.join(', ')}`,
    amount,
    unit: rUnit(rates, MM, 'fl oz'),
    order: 4, // Before any chlorine/oxidizer (order 5+) to prevent metal oxidation staining
    safetyNote: 'Sequesters metals in solution to prevent staining — does not remove them. Run filter continuously and clean filter after 48 hours. DO NOT shock or super-chlorinate until metals are under control — oxidizing elevated metals causes them to plate out and stain surfaces.',
    currentValue: Math.max(cu, fe),
    targetValue: 0,
    parameterName: 'Metals',
  };
}

function doseSalt(
  current: number | undefined,
  target: DosingTarget['salt'],
  volumeGallons: number,
  rates: DosingRateMap,
  isSaltPool: boolean = false,
): ChemicalDose | null {
  // Only recommend if this is a salt pool — caller already resolved isSaltPool,
  // local guard catches uncovered call paths.
  if (current === undefined) return null;
  if (!isSaltPool && current < SALT_AUTO_DETECT_THRESHOLD) return null;
  if (current >= target.min) return null;

  const scale = volumeGallons / 10000;
  const PS = 'Pool Salt';
  const delta = target.ideal - current;
  const increments = delta / 360; // SU Pool Care Handbook: 267 lbs/10k for 0→3200 ppm (≈30 lbs/360 ppm)
  const amount = round1(increments * r(rates, PS, 30) * scale);

  return {
    chemical: PS,
    purpose: `Raise Salt from ${current} to ${target.ideal} ppm`,
    amount,
    unit: rUnit(rates, PS, 'lbs'),
    order: 9,
    safetyNote: 'Broadcast evenly around pool with pump running. Allow 24 hours to fully dissolve and circulate before retesting.',
    currentValue: current,
    targetValue: target.ideal,
    parameterName: 'Salt',
  };
}

// ─── Maintenance Tabs ───────────────────────────────────────────────────────

function doseMaintenanceTabs(
  input: WaterTestInput,
  spa: boolean,
  bromineSystem: boolean,
  isIndoor: boolean,
  isSaltPool: boolean,
  cyaIsHigh: boolean,
): ChemicalDose | null {
  const volume = input.poolVolume ?? 0;
  if (volume <= 0) return null;

  if (spa) {
    // Salt spas — cell generates sanitizer, recommend output adjustment
    if (isSaltPool) {
      const sanitizer = bromineSystem ? 'bromine' : 'chlorine';
      const current = bromineSystem ? (input.bromine ?? 0) : (input.freeChlorine ?? 0);
      const target = bromineSystem ? 4 : 3; // ideal maintenance levels
      let suggestedPct = 50;
      if (current < target * 0.5) suggestedPct = 80;
      else if (current < target * 0.75) suggestedPct = 70;
      else if (current < target) suggestedPct = 60;
      else if (current >= target * 1.5) suggestedPct = 30;
      else if (current >= target) suggestedPct = 40;
      const temp = input.temperature ?? 100;
      const tempAdj = Math.round((temp - 100) / 10) * 10; // spas baseline at 100°F
      suggestedPct = Math.min(100, Math.max(20, suggestedPct + tempAdj));
      return {
        chemical: 'SWG Adjustment',
        purpose: `Set salt ${sanitizer} generator to ~${suggestedPct}% output`,
        amount: 0,
        unit: '',
        order: 10,
        safetyNote: `Set cell output to approximately ${suggestedPct}%. Current ${sanitizer} is ${current} ppm (target ${target} ppm). Recheck in 2–3 days and adjust ±10% until stable. Verify cell is clean — inspect for scale buildup.`,
        currentValue: 0,
        targetValue: 0,
        parameterName: 'Maintenance',
      };
    }

    const tabs = volume <= 400 ? 3 : volume <= 700 ? 4 : 5; // Field-derived; conservative vs ~1 tab/100 gal industry rule
    if (bromineSystem) {
      return {
        chemical: '1" Bromine Tabs',
        purpose: 'Maintain bromine levels between visits',
        amount: tabs,
        unit: 'tabs in dispenser',
        order: 10,
        safetyNote: 'Adjust dispenser dial to maintain 3–5 ppm bromine. Check weekly.',
        currentValue: 0,
        targetValue: 0,
        parameterName: 'Maintenance',
      };
    }
    // Chlorine spas: use dichlor granular instead of trichlor tabs.
    // Tabs are too acidic for small hot water volumes and add CYA too fast.
    const spaScale = volume / 10000;
    return {
      chemical: 'Chlorinating Granular (Dichlor)',
      purpose: 'Maintain chlorine levels between visits',
      amount: round1(Math.max(0.5, spaScale * 3.3)),
      unit: 'oz every other day',
      order: 10,
      safetyNote: 'Add 1 tsp per 250 gallons every other day to maintain 3–5 ppm. Test before each use. Dichlor does add CYA — monitor stabilizer and drain when CYA exceeds 50 ppm.', // SU Hot Tub Handbook: 0.5 tsp/100 gal
      currentValue: 0,
      targetValue: 0,
      parameterName: 'Maintenance',
    };
  }

  // ── Pool path ──

  // Salt pools — SWG handles chlorine production, tabs not needed
  if (isSaltPool) {
    // Estimate a practical SWG output % based on current FC vs target.
    // FC/CYA minimum: SWG pools target 5% of CYA (PCTI/TFP) for effective sanitation.
    const cya = input.cya ?? 0;
    const fc = input.freeChlorine ?? 0;
    const fcTarget = Math.max(3, round1(cya * 0.05)); // minimum 3 ppm, or 5% of CYA
    const temp = input.temperature ?? 80;

    // Base output estimate: 50% is typical midseason starting point.
    // Adjust up/down based on FC gap and temperature.
    let suggestedPct = 50;
    if (fc < fcTarget * 0.5) suggestedPct = 80;        // way below target
    else if (fc < fcTarget * 0.75) suggestedPct = 70;   // significantly below
    else if (fc < fcTarget) suggestedPct = 60;           // slightly below
    else if (fc >= fcTarget * 1.5) suggestedPct = 30;    // well above target
    else if (fc >= fcTarget) suggestedPct = 40;           // at or above target

    // Temperature modifier: +10% for every 10°F above 80, -10% below
    const tempAdj = Math.round((temp - 80) / 10) * 10;
    suggestedPct = Math.min(100, Math.max(20, suggestedPct + tempAdj));

    const pctStr = `${suggestedPct}%`;
    const fcStr = fc > 0 ? `Current FC is ${fc} ppm (target ${fcTarget} ppm for CYA ${cya}).` : `Target FC is ${fcTarget} ppm for CYA ${cya}.`;
    const tempNote = temp >= 90 ? ' High water temp increases chlorine demand.' : temp <= 65 ? ' Low water temp reduces chlorine demand.' : '';

    return {
      chemical: 'SWG Adjustment',
      purpose: `Set salt chlorine generator to ~${pctStr} output`,
      amount: 0,
      unit: '',
      order: 10,
      safetyNote: `Set SWG output to approximately ${pctStr}. ${fcStr}${tempNote} Recheck FC in 2–3 days and adjust up or down by 10% until holding steady at ${fcTarget} ppm. Verify cell is clean and producing — inspect for scale buildup.`,
      currentValue: 0,
      targetValue: 0,
      parameterName: 'Maintenance',
    };
  }

  // Bromine pool — use bromine tabs, not chlorine tabs
  if (bromineSystem) {
    const tabs = Math.max(2, Math.ceil(volume / 5000)); // Pool Research: ~1 per 5k gal for 3" tabs; min 2 practical
    return {
      chemical: '1" Bromine Tabs',
      purpose: 'Maintain bromine levels between visits',
      amount: tabs,
      unit: 'tabs in dispenser',
      order: 10,
      safetyNote: 'Adjust dispenser to maintain 3–5 ppm bromine. Check weekly. Never mix with chlorine products.',
      currentValue: 0,
      targetValue: 0,
      parameterName: 'Maintenance',
    };
  }

  // Indoor pools — liquid chlorine (no CYA), tabs contain stabilizer
  if (isIndoor) {
    const scale = volume / 10000;
    return {
      chemical: 'Liquid Chlorine (12.5%)',
      purpose: 'Maintain chlorine levels between visits (CYA-free)',
      amount: round1(scale * 32), // ~3 ppm/week at 12.5%; low-use residential estimate (no published standard)
      unit: 'fl oz per week',
      order: 10,
      safetyNote: 'Add daily or every other day to maintain 2–4 ppm. Chlorine tabs contain CYA — not recommended for indoor pools without UV exposure.',
      currentValue: 0,
      targetValue: 0,
      parameterName: 'Maintenance',
    };
  }

  // Outdoor chlorine pool — use liquid chlorine if CYA is already high (tabs add more CYA)
  if (cyaIsHigh) {
    const scale = volume / 10000;
    return {
      chemical: 'Liquid Chlorine (12.5%)',
      purpose: 'Maintain chlorine levels between visits (CYA-free)',
      amount: round1(scale * 32), // ~3 ppm/week; same as indoor estimate
      unit: 'fl oz per week',
      order: 10,
      safetyNote: 'CYA is already high — use liquid chlorine instead of tabs to avoid adding more stabilizer. Add every other day to maintain 2–4 ppm.',
      currentValue: 0,
      targetValue: 0,
      parameterName: 'Maintenance',
    };
  }

  // Outdoor chlorine pool — 3" chlorine tabs; ~1 per 5,000 gallons per week (SU, manufacturer labels)
  const tabs = Math.ceil(volume / 5000);
  return {
    chemical: '3" Chlorine Tabs (Pucks)',
    purpose: 'Maintain chlorine levels between visits',
    amount: tabs,
    unit: 'tabs in skimmer or dispenser',
    order: 10,
    safetyNote: 'Never mix tabs with other chlorine types. Tabs add CYA — monitor stabilizer levels over time.',
    currentValue: 0,
    targetValue: 0,
    parameterName: 'Maintenance',
  };
}

// ─── Chemical Interaction Detection ─────────────────────────────────────────

function isAcid(chemical: string): boolean {
  const lower = chemical.toLowerCase();
  return lower.includes('muriatic') || lower.includes('bisulfate') || lower.includes('ph down');
}

function isChlorine(chemical: string): boolean {
  const lower = chemical.toLowerCase();
  return (lower.includes('chlorine') || lower.includes('hypochlorite')) && !lower.includes('calcium hypochlorite');
}

function isShock(chemical: string): boolean {
  const lower = chemical.toLowerCase();
  return lower.includes('shock') || lower.includes('calcium hypochlorite') || lower.includes('mps');
}

function isBase(chemical: string): boolean {
  const lower = chemical.toLowerCase();
  return lower.includes('soda ash') ||
    lower.includes('sodium carbonate') ||
    lower.includes('sodium bicarbonate') ||
    lower.includes('baking soda') ||
    lower.includes('ph up');
}

function isCalciumChloride(chemical: string): boolean {
  return chemical.toLowerCase().includes('calcium chloride');
}

function isSequestrant(chemical: string): boolean {
  return chemical.toLowerCase().includes('metal magnet') || chemical.toLowerCase().includes('sequestrant');
}

// ─── Polish Dose Gate ──────────────────────────────────────────────────────
//
// The LSI optimizer tries to nudge pH/TA/CH beyond what base chemistry
// required, to shift projected LSI toward +0.10. That's useful when water
// is drifting corrosive or scale-forming — but when the water is already
// acceptable (|LSI| ≤ 0.30, parameter already in range), the nudge costs
// tech on-site time with negligible benefit. This function is the gate:
// returns `true` to keep the polish nudge, `false` to skip it.
//
// A skip ONLY happens when every safety condition below is met. The gate
// defaults to "keep" whenever there's ambiguity — the cost of an
// unnecessary nudge is 15-30 min of tech time; the cost of skipping a
// needed one is bad chemistry. Bias heavily toward "keep."
function isPolishDoseWorthIt(params: {
  parameter: 'pH' | 'TA' | 'CH';
  startingLSI: number;
  projectedLSIWithDose: number;
  projectedLSIWithoutDose: number;
  parameterCurrentlyInRange: boolean;
  surface: string;
  isCoupledAcidPair: boolean;
}): { keep: boolean; reason: string } {
  // Hard no-go: coupled bicarb+acid pair. Bicarb is load-bearing for the
  // acid TA math — skipping it lets acid overshoot TA low.
  if (params.isCoupledAcidPair) {
    return { keep: true, reason: 'coupled bicarb+acid pair is load-bearing' };
  }

  // Hard no-go: plaster/concrete with starting LSI already below -0.15.
  // Extra margin because cumulative etching is cheap to avoid and
  // expensive to remedy.
  const isPlasterOrConcrete = params.surface === 'plaster' || params.surface === 'concrete';
  if (isPlasterOrConcrete && params.startingLSI < -0.15) {
    return { keep: true, reason: 'plaster/concrete with corrosive starting LSI — extra margin' };
  }

  // Hard no-go: parameter is out of range. Base chemistry needed it;
  // optimizer tuning it further is part of the same treatment.
  if (!params.parameterCurrentlyInRange) {
    return { keep: true, reason: `${params.parameter} not yet in range` };
  }

  // Hard no-go: starting LSI is already outside ±0.30. The nudge is
  // compensating for a real imbalance, not polishing.
  if (Math.abs(params.startingLSI) > 0.30) {
    return { keep: true, reason: `starting LSI ${params.startingLSI.toFixed(2)} outside ±0.30` };
  }

  // Hard no-go: the nudge would move LSI by ≥ 0.08. That's a meaningful
  // chemistry change worth the time.
  const lsiDelta = Math.abs(params.projectedLSIWithDose - params.projectedLSIWithoutDose);
  if (lsiDelta >= 0.08) {
    return { keep: true, reason: `polish would move LSI by ${lsiDelta.toFixed(3)} (≥0.08 threshold)` };
  }

  // All skip conditions met — skip the polish.
  return {
    keep: false,
    reason: `${params.parameter} already in range, starting LSI ${params.startingLSI.toFixed(2)} acceptable, polish would only move LSI ${lsiDelta.toFixed(3)}`,
  };
}

function isPhosphateRemover(chemical: string): boolean {
  return chemical.toLowerCase().includes('phosphate remover');
}

/**
 * Returns the recommended on-site wait (in minutes) between two consecutive chemicals.
 * Only returns waits that are realistic for a single service stop (≤30 min).
 * Pairs requiring longer separation (shock+sequestrant, phosphate remover+calcium)
 * are auto-deferred to return visits by the engine — they should never appear
 * in the same visit's dose list.
 */
export function getWaitBetween(chemA: string, chemB: string, spa: boolean = false): { minutes: number; label: string } {
  // Acid + Chlorine/Shock → 30 min (toxic gas risk — never reduce, even for spas)
  if ((isAcid(chemA) && (isChlorine(chemB) || isShock(chemB))) ||
      ((isChlorine(chemA) || isShock(chemA)) && isAcid(chemB))) {
    return { minutes: 30, label: '30 min' };
  }
  // Calcium Chloride + Base or Chlorine → 30 min pool / 15 min spa
  if ((isCalciumChloride(chemA) && (isBase(chemB) || isChlorine(chemB))) ||
      ((isBase(chemA) || isChlorine(chemA)) && isCalciumChloride(chemB))) {
    return spa ? { minutes: 15, label: '15 min' } : { minutes: 30, label: '30 min' };
  }
  // Acid + Base → 30 min pool / 15 min spa (neutralization — spa needs full turnover)
  if ((isAcid(chemA) && isBase(chemB)) || (isBase(chemA) && isAcid(chemB))) {
    return spa ? { minutes: 15, label: '15 min' } : { minutes: 30, label: '30 min' };
  }
  // Default: 15 min pool / 10 min spa (one full turnover with margin)
  return spa ? { minutes: 10, label: '10 min' } : { minutes: 15, label: '15 min' };
}

function detectInteractions(doses: ChemicalDose[], spa: boolean = false): ChemicalInteraction[] {
  const raw: ChemicalInteraction[] = [];
  const chemicals = doses.filter(d => d.amount > 0).map(d => d.chemical);

  for (let i = 0; i < chemicals.length; i++) {
    for (let j = i + 1; j < chemicals.length; j++) {
      const a = chemicals[i];
      const b = chemicals[j];

      // Acid + Chlorine → toxic gas (never reduce — real danger regardless of volume)
      if ((isAcid(a) && isChlorine(b)) || (isChlorine(a) && isAcid(b))) {
        raw.push({
          chemicals: [a, b],
          warning: 'NEVER add acid and chlorine at the same time or in close sequence. Mixing produces toxic chlorine gas. Wait at least 30 minutes between additions with the pump running.',
          severity: 'danger',
        });
      }

      // Acid + Base → neutralization
      if ((isAcid(a) && isBase(b)) || (isBase(a) && isAcid(b))) {
        raw.push({
          chemicals: [a, b],
          warning: spa
            ? 'Acid and base neutralize each other. Add one first, run jets for 15 minutes, then add the other.'
            : 'Acid and base chemicals neutralize each other. Add one first, allow 30 minutes of circulation, then retest before adding the other.',
          severity: 'caution',
        });
      }

      // Calcium Chloride + Sodium Bicarbonate → clouding (CaCO3 precipitation)
      if ((isCalciumChloride(a) && isBase(b)) || (isBase(a) && isCalciumChloride(b))) {
        raw.push({
          chemicals: [a, b],
          warning: spa
            ? 'Add calcium and bicarb separately — run jets for 15 minutes between additions to prevent clouding.'
            : 'Adding calcium chloride and sodium bicarbonate too close together precipitates calcium carbonate, causing cloudy water. Ideally wait 24 hours; minimum 30 minutes with pump running. Add calcium last.',
          severity: 'caution',
        });
      }

      // Calcium Chloride + Chlorine → localized scaling
      if ((isCalciumChloride(a) && isChlorine(b)) || (isChlorine(a) && isCalciumChloride(b))) {
        raw.push({
          chemicals: [a, b],
          warning: spa
            ? 'Add calcium and chlorine separately — run jets for 15 minutes between additions.'
            : 'Add calcium chloride and chlorine separately — liquid chlorine has a high pH (~13) which can cause localized scaling near calcium. Ideally wait 24 hours; minimum 30 minutes with pump running.',
          severity: 'caution',
        });
      }

      // Shock + Sequestrant → oxidizes metals + degrades sequestrant
      if ((isShock(a) && isSequestrant(b)) || (isSequestrant(a) && isShock(b))) {
        raw.push({
          chemicals: [a, b],
          warning: 'DO NOT shock when metals are elevated — shocking oxidizes dissolved metals, causing them to plate out and permanently stain surfaces. Apply sequestrant first and wait at least 48 hours before shocking. High chlorine also degrades the sequestrant itself.',
          severity: 'danger',
        });
      }

      // Phosphate Remover + Calcium Chloride → clouding (pools only — spas turn over too fast)
      if (!spa && ((isPhosphateRemover(a) && isCalciumChloride(b)) || (isCalciumChloride(a) && isPhosphateRemover(b)))) {
        raw.push({
          chemicals: [a, b],
          warning: 'Phosphate remover and calcium chloride can cause excessive clouding if added together. Wait 24 hours between these additions.',
          severity: 'caution',
        });
      }
    }
  }

  // Deduplicate by warning text
  const seen = new Set<string>();
  const interactions: ChemicalInteraction[] = [];
  for (const interaction of raw) {
    if (!seen.has(interaction.warning)) {
      seen.add(interaction.warning);
      interactions.push(interaction);
    }
  }

  // General spacing warning if multiple chemicals but no specific interactions
  if (chemicals.length >= 2 && interactions.length === 0) {
    interactions.push({
      chemicals: [chemicals[0], chemicals[1]],
      warning: spa
        ? 'Add each chemical separately with jets running between additions. Never add different chemicals at the same time.'
        : 'Add each chemical separately with 15–30 minutes of circulation between additions. Never pour different chemicals into the pool at the same time.',
      severity: 'caution',
    });
  }

  return interactions;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function calculateDosing(
  input: WaterTestInput,
  targets: DosingTarget = DEFAULT_TARGETS,
  isIndoor: boolean = false,
  isSpaOverride: boolean = false,
  rates: DosingRateMap = {},
  isSaltSystemOverride: boolean = false,
  isBromineOverride: boolean = false,
  surfaceType: string = 'vinyl',
  options: CalculateDosingOptions = {},
): DosingResult | null {
  if (!input.poolVolume || input.poolVolume <= 0) return null;

  const polishSkips: PolishSkip[] = [];

  const spa = isSpaOverride || isSpa(input);
  // Salt systems generate their own sanitizer — never treat as bromine system
  const bromineSystem = !isSaltSystemOverride && (isBromineOverride || isBromineSystem(input));
  const startingLSIResult = calculateLSI(input, 'formula');
  const startingLSI = startingLSIResult.lsi;
  const doses: ChemicalDose[] = [];
  const returnVisitDoses: ChemicalDose[] = [];
  const readingWarnings: string[] = [];

  // ─── Salt auto-detection ────────────────────────────────────────────────
  // Trust the caller's flag if set, otherwise infer from the salt reading.
  // When auto-detected, overlay salt-flavored targets so dosing matches an SWG
  // pool (lower TA, salt-cell-safe CH, salt addition recommendation).
  const saltReading = input.salt ?? 0;
  const detectedSalt = saltReading >= SALT_AUTO_DETECT_THRESHOLD;
  const isSaltPool = isSaltSystemOverride || detectedSalt;

  if (detectedSalt && !isSaltSystemOverride) {
    const validSurface: SurfaceType =
      surfaceType === 'plaster' || surfaceType === 'vinyl' || surfaceType === 'fiberglass'
        ? (surfaceType as SurfaceType)
        : 'vinyl';
    targets = buildTargets(spa, validSurface, true);
  }

  // ─── LSI-First Target Adjustment (Orenda: "LSI first, range chemistry second") ──
  // Before individual dosing, check if the profile's ideal targets produce balanced
  // LSI. If not, adjust CH ideal (foundation, no cross-effects) and TA ideal so
  // the dosers naturally produce water closer to LSI equilibrium.
  // This prevents scenarios where parameter-driven doses (bicarb→TA, acid→pH)
  // conflict and leave LSI worse than it started.
  targets = adjustTargetsForLSI(input, targets);

  // ─── Reading Validation ──────────────────────────────────────────────────
  // TC must always be >= FC (TC = FC + CC). If not, test data is unreliable.
  const fc = input.freeChlorine ?? 0;
  const tc = input.totalChlorine ?? 0;
  const tcLessThanFc = fc > 0 && tc > 0 && tc < fc;
  if (tcLessThanFc) {
    readingWarnings.push(
      `Total Chlorine (${tc} ppm) is lower than Free Chlorine (${fc} ppm). This is physically impossible — TC must always equal or exceed FC. Recommend retesting with fresh reagents before treating. Chemical doses below are based on other parameters and may need adjustment after retest.`
    );
  }

  // ─── Extreme Reading Warnings ─────────────────────────────────────────────
  // Flag readings that are far outside normal ranges so techs know what they're dealing with.
  if (input.pH < 6.9) {
    readingWarnings.push(
      `pH is ${input.pH} — extremely low. Immediate correction needed to prevent equipment corrosion and surface damage. Add soda ash or sodium bicarbonate before other treatments.`
    );
  } else if (input.pH > 8.5) {
    readingWarnings.push(
      `pH is ${input.pH} — very high. May need aeration (run water features, point returns up) in addition to acid. High pH reduces chlorine effectiveness and promotes scaling.`
    );
  }
  if (input.totalAlkalinity === 0 || input.totalAlkalinity < 10) {
    readingWarnings.push(
      `Total Alkalinity is ${input.totalAlkalinity} ppm — critically low. pH will be extremely unstable. Raise TA with sodium bicarbonate before making other adjustments.`
    );
  }
  if (input.cya > 100) {
    readingWarnings.push(
      `CYA is ${input.cya} ppm — very high. Drain and refill is the most effective correction. Maintaining adequate chlorine at this CYA level requires FC ${round1(input.cya * 0.075)}+ ppm, which is impractical long-term.`
    );
  }
  if (input.calciumHardness > 500) {
    readingWarnings.push(
      `Calcium Hardness is ${input.calciumHardness} ppm — extremely high. Monitor for scaling on surfaces, heater, and salt cell (if applicable). Partial drain recommended.`
    );
  }
  if (input.temperature < 60 && startingLSI < -0.5) {
    readingWarnings.push(
      `Water is ${input.temperature}°F with LSI ${startingLSI >= 0 ? '+' : ''}${round1(startingLSI)} — cold water is inherently corrosive. LSI will improve as water warms to operating temperature. Consider dosing for anticipated warm-weather chemistry rather than current cold readings.`
    );
  }

  // ─── Salt System Advisories ─────────────────────────────────────────────
  if (detectedSalt && !isSaltSystemOverride) {
    readingWarnings.push(
      `Salt reading is ${saltReading} ppm — treating this as a salt pool. Targets and salt dose are calibrated for SWG operation. If this is a non-salt pool with elevated TDS, set the salt-system flag to off and recalculate.`
    );
  }
  if (isSaltPool && startingLSI > -0.1 && input.calciumHardness > 300) {
    readingWarnings.push(
      `Salt pool with positive LSI (+${round1(startingLSI)}) and CH ${input.calciumHardness} ppm — elevated salt cell scaling risk. Water temperature at the cell electrode is much higher than bulk water, accelerating calcium carbonate deposits. Inspect cell for scale buildup.`
    );
  }

  // ─── CH:TA Ratio Advisory ───────────────────────────────────────────────────
  if (input.calciumHardness > 0 && input.totalAlkalinity > 0) {
    const chTaRatio = input.calciumHardness / input.totalAlkalinity;
    if (chTaRatio < 2.0 && input.totalAlkalinity >= 80) {
      readingWarnings.push(
        `Calcium-to-Alkalinity ratio is ${round1(chTaRatio)}:1 (CH ${input.calciumHardness} / TA ${input.totalAlkalinity}). Orenda recommends ≥3:1 for pH stability. Consider raising calcium and/or lowering alkalinity for easier pH management.`
      );
    }
  }

  // 1. Alkalinity + 2. pH (solved together for cross-effect compensation)
  //
  // Baking soda raises TA AND pH. Acid lowers pH AND TA.
  // When both are needed, we solve algebraically so net TA lands at ideal:
  //   bicarb_ta = (taIdeal - taCurrent + 20 * (pH - pHIdeal)) / 0.9
  //   Derived from: acid TA loss = 4 ppm per 0.2 pH = 20 per 1.0 pH;
  //   bicarb pH bump = 0.05 per 10 ppm TA = 0.005 per ppm TA;
  //   denominator = 1 - (20 * 0.005) = 0.9
  const needsTAUp = input.totalAlkalinity < targets.alkalinity.min;
  const needsPHDown = input.pH > targets.pH.max;
  const taUsedAcid = input.totalAlkalinity > targets.alkalinity.max && input.pH > 7.2;

  if (needsTAUp && needsPHDown) {
    // Simultaneous solve: overshoot baking soda so net TA = ideal after acid's cross-effect
    // For spas, target pH max (7.6) not ideal (7.5) — less overshoot, less acid needed
    const scale = input.poolVolume / 10000;
    const BICARB = 'Sodium Bicarbonate (Baking Soda)';
    const coupledPHTarget = spa ? targets.pH.max : targets.pH.ideal;
    const bicarb_ta = Math.max(
      targets.alkalinity.ideal - input.totalAlkalinity,
      (targets.alkalinity.ideal - input.totalAlkalinity + 20 * (input.pH - coupledPHTarget)) / 0.9,
    );
    const compensatedTATarget = Math.round(input.totalAlkalinity + bicarb_ta);
    const increments = bicarb_ta / 10;
    const bicarbAmount = round1(increments * r(rates, BICARB, 1.4) * scale);

    // pH bump from the (larger) baking soda dose
    const rawPhBump = (bicarb_ta / 10) * 0.05;
    // For spas: discount bicarb pH bump by 50% — aeration outgasses CO2,
    // naturally pulling pH back down. Dosing acid for the full bump overshoots.
    // Sources: Orenda pH ceiling, TFP acid+aerate method, manufacturer consensus.
    const effectivePhBump = spa ? rawPhBump * 0.5 : rawPhBump;
    const postBicarbPH = round1(input.pH + rawPhBump); // display: show full bump
    const effectivePH = input.pH + effectivePhBump;     // dosing: use discounted bump

    // Acid dose based on post-bicarb pH
    // For spas: target pH max (7.6) instead of ideal (7.5), and cap TA scaling
    // at 100 ppm — aeration counteracts TA buffering (CO2 outgassing works with
    // acid, not against it), so inflated post-bicarb TA overstates acid demand.
    const acidPHTarget = spa
      ? { ...targets.pH, ideal: targets.pH.max }
      : targets.pH;
    const acidTA = spa ? Math.min(compensatedTATarget, 100) : compensatedTATarget;
    const phDose = dosePH(effectivePH, acidPHTarget, input.poolVolume, spa, rates, acidTA);

    // TA loss from acid
    const acidTargetPH = spa ? targets.pH.max : targets.pH.ideal;
    const phDrop = effectivePH - acidTargetPH;
    const taLoss = Math.round((phDrop / 0.2) * 4);
    const netTA = compensatedTATarget - taLoss;

    // Push baking soda dose
    const alkDose: ChemicalDose = {
      chemical: BICARB,
      purpose: `Raise Total Alkalinity from ${input.totalAlkalinity} to ${compensatedTATarget} ppm`,
      amount: bicarbAmount,
      unit: rUnit(rates, BICARB, 'lbs'),
      order: 1,
      currentValue: input.totalAlkalinity,
      targetValue: compensatedTATarget,
      parameterName: 'Total Alkalinity',
      secondaryAdjustment: {
        parameterName: 'pH',
        currentValue: input.pH,
        targetValue: postBicarbPH,
        isAdverse: true,
      },
    };
    doses.push(alkDose);

    // Push acid dose with TA cross-effect
    if (phDose) {
      phDose.currentValue = postBicarbPH; // show post-bicarb pH (where acid actually starts)
      phDose.secondaryAdjustment = {
        parameterName: 'Total Alkalinity',
        currentValue: compensatedTATarget,
        targetValue: netTA,
      };
      doses.push(phDose);
    }
  } else {
    // Standard independent dosing (no simultaneous TA up + pH down)
    const alkDose = doseAlkalinity(input.totalAlkalinity, targets.alkalinity, input.poolVolume, input.pH, spa, rates, targets.pH);
    const aerationActive = alkDose?.chemical === 'Aeration';
    // pH rescue: when pH is below profile min, aeration alone is too slow
    // (days to weeks). The pool is actively corrosive right now — soda ash
    // must be dosed even though it will push TA above target. TA can be
    // brought back down on a follow-up visit once pH is safe.
    const phRescueNeeded = input.pH < targets.pH.min;

    // Normally push the alk dose. But when pH rescue is needed, drop the
    // Aeration advisory — its "TA will drift to target" messaging would
    // contradict the soda ash step that raises TA. TA correction happens
    // next visit.
    if (alkDose && !(aerationActive && phRescueNeeded)) doses.push(alkDose);

    if (!taUsedAcid) {
      // Only skip pH dosing when aeration is handling it (pH mildly low,
      // TA high — aeration raises pH naturally). During pH rescue, dose soda ash.
      const skipPHDose = aerationActive && !phRescueNeeded;

      if (!skipPHDose) {
        // Simple cross-effect: if bicarb raised TA, account for pH bump in acid dose
        const bicarbRaisedTA = alkDose && needsTAUp;
        const taIncrease = bicarbRaisedTA ? (alkDose.targetValue - alkDose.currentValue) : 0;
        const phBumpFromBicarb = taIncrease > 0 ? (taIncrease / 10) * 0.05 : 0;
        const effectivePH = input.pH + phBumpFromBicarb;

        const phDose = dosePH(effectivePH, targets.pH, input.poolVolume, spa, rates, input.totalAlkalinity);
        if (phDose) {
          if (phBumpFromBicarb > 0) phDose.currentValue = round1(effectivePH);
          // If we dropped the Aeration step for pH rescue, annotate the soda ash
          // dose so the tech knows TA will overshoot and needs a follow-up.
          if (phRescueNeeded && aerationActive && input.totalAlkalinity > targets.alkalinity.max) {
            phDose.safetyNote =
              `${phDose.safetyNote ?? ''} pH is below minimum — soda ash takes priority over TA management. TA will rise above target; bring TA back to target on the next visit with acid plus aeration once pH is stable.`.trim();
          }
          doses.push(phDose);
        }
      }
    }
  }

  // 3. Calcium (order 0 for spas — broadcast + vacuum first; order 3 for pools)
  const chDose = doseCalcium(input.calciumHardness, targets.calciumHardness, input.poolVolume, spa, rates, startingLSI);
  if (chDose) doses.push(chDose);

  // 4. CYA — skip ADDING for indoor pools, spas, and bromine systems (CYA only stabilizes chlorine),
  //    but always check if CYA is too high and recommend draining
  const needsCya = !isIndoor && !spa && !bromineSystem;
  if (needsCya) {
    const cyaDose = doseCYA(input.cya, targets.cya, input.poolVolume, rates);
    // Skip separate CYA addition if trichlor tabs will be prescribed (they contain ~54% CYA).
    // Only add CYA separately if the deficit is large (>15 ppm) or tabs won't be used (salt/high-CYA).
    const willUseTrichlor = !isSaltSystemOverride && input.cya <= targets.cya.max && !isIndoor;
    const tabsWillAddCYA = willUseTrichlor && cyaDose && cyaDose.chemical !== 'Partial Drain & Refill';
    const cyaDeficit = targets.cya.ideal - input.cya;
    if (cyaDose && !(tabsWillAddCYA && cyaDeficit <= 15)) {
      doses.push(cyaDose);
    }
  } else if (input.cya > targets.cya.max) {
    const reason = isIndoor ? 'indoor pools do not need stabilizer'
      : spa ? 'spas do not need stabilizer'
      : 'bromine systems are not stabilized by CYA';
    doses.push({
      chemical: 'Partial Drain & Refill',
      purpose: `Lower CYA from ${input.cya} to ${targets.cya.ideal} ppm`,
      amount: 0,
      unit: '',
      order: 4,
      safetyNote:
        `CYA is ${input.cya} ppm — ${reason}. Drain ~${Math.round((1 - targets.cya.ideal / input.cya) * 100)}% (~${Math.round(input.poolVolume * (1 - targets.cya.ideal / input.cya))} gal) and refill to reduce CYA.`,
      currentValue: input.cya,
      targetValue: targets.cya.ideal,
      parameterName: 'CYA (Stabilizer)',
    });
  }

  // 5. Sanitizer — chlorine OR bromine (not both)
  // 6. Shock — combined chlorine
  //
  // If shock is needed, skip the separate FC raise — shock already raises FC.
  // Don't stack two chlorine products in the same visit.
  //
  // Use post-drain CYA for FC targeting: if we're draining to lower CYA,
  // the FC target should be based on the CYA level AFTER the drain.
  const cyaDrainDose = doses.find(d => d.chemical === 'Partial Drain & Refill' && d.parameterName === 'CYA (Stabilizer)');
  const effectiveCYA = cyaDrainDose ? cyaDrainDose.targetValue : input.cya;
  const shockDose = doseShock(input, targets.combinedChlorine, input.poolVolume, spa, bromineSystem, rates, surfaceType, isSaltPool, targets.calciumHardness);

  // 6. Metals (sequestrant) — must come BEFORE any chlorine/oxidizer to prevent metal plating.
  //    When metals are elevated, sequestrant chelates them in solution; any oxidizer added
  //    before chelation will oxidize dissolved metals, causing permanent staining on surfaces.
  const metalDose = doseMetals(input.copper, input.iron, targets.copper.max, targets.iron.max, input.poolVolume, rates);
  if (metalDose) doses.push(metalDose);

  // When metals are elevated, shock is deferred to return visit (48 hr wait).
  // In that case, still dose regular chlorine this visit to maintain sanitation,
  // but sequestrant (order 4) will be applied first to chelate metals before
  // chlorine (order 5) is added.
  const shockDeferred = !!(shockDose && metalDose);

  if (bromineSystem && !isSaltPool) {
    // Non-salt bromine systems: dose granular bromine to raise levels
    // Salt bromine systems: cell generates bromine, suggest output adjustment instead
    const brDose = doseBromine(input.bromine, targets.bromine, input.poolVolume, rates);
    if (brDose) doses.push(brDose);
  } else if (bromineSystem && isSaltPool) {
    // Salt bromine: if bromine is low, note it but let SWG adjustment handle it
    if ((input.bromine ?? 0) < targets.bromine.min) {
      doses.push({
        chemical: 'SWG Boost',
        purpose: `Raise Bromine from ${input.bromine} to ${targets.bromine.ideal} ppm`,
        amount: 0,
        unit: '',
        order: 5,
        safetyNote: `Bromine is ${input.bromine} ppm (target ${targets.bromine.min}–${targets.bromine.max} ppm). Increase salt cell output and verify cell is clean and producing. If bromine is critically low, add brominating granular as a one-time boost while cell catches up.`,
        currentValue: input.bromine ?? 0,
        targetValue: targets.bromine.ideal,
        parameterName: 'Bromine',
      });
    }
  } else if (!shockDose || shockDeferred) {
    // Only dose chlorine if we're NOT shocking this visit — shock already raises FC
    const clDose = doseChlorine(input.freeChlorine, targets.freeChlorine, input.poolVolume, effectiveCYA, isSaltPool, spa, rates);
    if (clDose) doses.push(clDose);
  }

  // 7. Shock — if metals are elevated, defer shock to return visit (48 hr wait after sequestrant)
  if (shockDeferred) {
    returnVisitDoses.push({ ...shockDose!, safetyNote: (shockDose!.safetyNote ? shockDose!.safetyNote + ' ' : '') + 'Deferred to return visit — sequestrant must work for 48 hours before shocking to prevent metal staining.' });
  } else if (shockDose) {
    doses.push(shockDose);
  }

  // 8. Phosphates
  // Phosphate remover + calcium chloride require 24 hr separation (clouding risk) in pools.
  // Spas are exempt: small volume turns over in minutes, clouding clears quickly with
  // jets running, and deferring calcium worsens LSI for the entire return-visit interval.
  const phosDose = dosePhosphates(input.phosphates, targets.phosphates, input.poolVolume, rates);
  if (!spa) {
    const chDoseIdx = doses.findIndex(d => d.chemical.includes('Calcium Chloride'));
    if (phosDose && chDoseIdx >= 0) {
      const deferredCH = doses.splice(chDoseIdx, 1)[0];
      returnVisitDoses.push({ ...deferredCH, safetyNote: (deferredCH.safetyNote ? deferredCH.safetyNote + ' ' : '') + 'Deferred to return visit — phosphate remover and calcium chloride require 24 hours separation to prevent clouding.' });
    }
  }
  if (phosDose) doses.push(phosDose);

  // 9. Salt
  const saltDose = doseSalt(input.salt, targets.salt, input.poolVolume, rates, isSaltPool);
  if (saltDose) doses.push(saltDose);

  // 10. Maintenance tabs
  const cyaIsHigh = input.cya > targets.cya.max;
  const tabsDose = doseMaintenanceTabs(input, spa, bromineSystem, isIndoor, isSaltPool, cyaIsHigh);
  if (tabsDose) doses.push(tabsDose);

  doses.sort((a, b) => a.order - b.order);

  // ─── Skip micro-adjustments ────────────────────────────────────────────
  // Don't recommend chemical additions for trivial deviations that are
  // within test variance. Wastes chemicals and service visits.
  for (let i = doses.length - 1; i >= 0; i--) {
    const d = doses[i];
    if (d.chemical === 'Partial Drain & Refill' || d.chemical === 'Aeration' || d.parameterName === 'Maintenance') continue;
    if (d.amount <= 0) continue;

    const delta = Math.abs(d.targetValue - d.currentValue);
    const isTrivial =
      (d.parameterName === 'CYA (Stabilizer)' && delta <= 3) ||
      (d.parameterName === 'pH' && delta <= 0.1) ||
      (d.parameterName === 'Calcium Hardness' && delta <= 15 && d.currentValue >= (targets.calciumHardness.min - 10)) ||
      (d.parameterName === 'Total Alkalinity' && delta <= 10 && d.currentValue >= (targets.alkalinity.min - 5)) ||
      (d.parameterName === 'Free Chlorine' && delta <= 0.5);

    if (isTrivial) {
      doses.splice(i, 1);
    }
  }

  // Drop zero-amount doses (rounding edge case with tiny volumes)
  for (let i = doses.length - 1; i >= 0; i--) {
    const d = doses[i];
    if (d.amount <= 0 && d.chemical !== 'Partial Drain & Refill' && d.chemical !== 'Aeration' && d.parameterName !== 'Maintenance') {
      doses.splice(i, 1);
    }
  }

  // Consolidate multiple "Partial Drain & Refill" recommendations into one.
  // Cap at 50% per visit — stage larger drains across return visits.
  // Place drain first (order 0) so chemicals aren't immediately diluted.
  const MAX_DRAIN_PCT = 50;
  const drainDoses = doses.filter(d => d.chemical === 'Partial Drain & Refill');
  if (drainDoses.length >= 1) {
    const params = drainDoses.map(d => `${d.parameterName} (${d.currentValue} → ${d.targetValue})`);
    const idealDrainPct = drainDoses.length > 1
      ? Math.max(...drainDoses.map(d =>
          d.currentValue > 0 && d.targetValue > 0 ? Math.round((1 - d.targetValue / d.currentValue) * 100) : 0
        ))
      : (drainDoses[0].currentValue > 0 && drainDoses[0].targetValue > 0
          ? Math.round((1 - drainDoses[0].targetValue / drainDoses[0].currentValue) * 100)
          : 0);

    const thisVisitPct = Math.min(idealDrainPct, MAX_DRAIN_PCT);
    const drainGal = Math.round(input.poolVolume * thisVisitPct / 100);

    const merged: ChemicalDose = {
      chemical: 'Partial Drain & Refill',
      purpose: drainDoses.length > 1
        ? `Lower ${drainDoses.map(d => d.parameterName).join(' and ')} by dilution`
        : drainDoses[0].purpose,
      amount: 0,
      unit: '',
      order: 0, // drain first — before chemical additions
      safetyNote: idealDrainPct > MAX_DRAIN_PCT
        ? `Drain ~${thisVisitPct}% (~${drainGal} gal) this visit and refill. Full correction requires ~${idealDrainPct}% — remaining ${idealDrainPct - thisVisitPct}% on return visit. ${drainDoses.length > 1 ? `Targets: ${params.join(', ')}.` : ''}`
        : `Can only be reduced by dilution. Drain ~${thisVisitPct}% (~${drainGal} gal) and refill with fresh water. ${drainDoses.length > 1 ? `Targets: ${params.join(', ')}.` : ''}`,
      currentValue: 0,
      targetValue: 0,
      parameterName: drainDoses.map(d => d.parameterName).join(' + '),
    };

    // Remove all drain doses and insert the merged one at the beginning
    for (let i = doses.length - 1; i >= 0; i--) {
      if (doses[i].chemical === 'Partial Drain & Refill') doses.splice(i, 1);
    }
    doses.unshift(merged);

    // If drain exceeds cap, note it in the drain's safetyNote (return visit
    // will just say "retest" — the multi-stage drain info is in the drain step).
  }

  // ─── Drain visit logic ─────────────────────────────────────────────────────
  // When a significant drain is prescribed, the drain IS the visit. The tech
  // drains, leaves, and the homeowner refills over hours/days. We don't know
  // the fill water chemistry, so all pre-drain chemical doses are invalid.
  //
  // This visit: drain + urgent FC only (can't leave pool at 0 FC for days)
  // Return visit: retest everything after refill — no estimated doses.
  const RETEST_DRAIN_THRESHOLD = 25;
  const hasDrain = doses.some(d => d.chemical === 'Partial Drain & Refill');
  if (hasDrain) {
    const drainNote = doses.find(d => d.chemical === 'Partial Drain & Refill')?.safetyNote ?? '';
    const drainPctMatch = drainNote.match(/~(\d+)%/);
    const drainPct = drainPctMatch ? parseInt(drainPctMatch[1]) : 0;

    if (drainPct >= RETEST_DRAIN_THRESHOLD) {
      // Strip ALL non-drain doses from this visit — drain changes everything
      for (let i = doses.length - 1; i >= 0; i--) {
        if (doses[i].chemical !== 'Partial Drain & Refill') doses.splice(i, 1);
      }

      // Clear any return-visit doses that were calculated pre-drain — they're all
      // based on guessed post-drain values. Tech will retest and run calculator fresh.
      returnVisitDoses.length = 0;

      // Single return-visit instruction: retest after refill
      returnVisitDoses.push({
        chemical: 'Retest After Refill',
        purpose: 'Retest all parameters after refill is complete',
        amount: 0,
        unit: '',
        order: 0,
        safetyNote: `After the homeowner refills, retest all water chemistry parameters and run the calculator with fresh readings. Fill water chemistry is unknown — all doses must be calculated from actual post-refill test results.`,
        currentValue: 0,
        targetValue: 0,
        parameterName: 'Retest',
      });
    }
  }

  // Build visit limits from DB rates (with fallback)
  const visitLimits: Record<string, number> = {};
  for (const [name, rate] of Object.entries({ ...FALLBACK_RATES, ...rates })) {
    if (rate.visit_limit_per_10k !== null) {
      visitLimits[name] = rate.visit_limit_per_10k;
    }
  }

  // Split oversized doses into this-visit and return-visit amounts
  // Skip visit limits for spas — amounts are already tiny (ounces) and circulate fast
  const scale = input.poolVolume / 10000;
  for (let i = 0; i < doses.length; i++) {
    const dose = doses[i];
    const limit = visitLimits[dose.chemical];
    if (!limit || dose.amount <= 0 || dose.skipVisitLimit || spa) continue;

    // Absolute ceiling overrides the per-10k scaled limit for specific chemicals.
    // Calcium Chloride: hard-capped per visit regardless of pool size, and no return-visit carryover.
    const isCalciumChloride = dose.chemical === 'Calcium Chloride (100%)';
    const absoluteCap = isCalciumChloride ? CACL_ABSOLUTE_CAP_LBS : Infinity;
    const scaledLimit = Math.min(round1(limit * scale), absoluteCap);
    if (dose.amount > scaledLimit) {
      const ratio = scaledLimit / dose.amount;
      const remainder = round1(dose.amount - scaledLimit);

      // Compute intermediate target value for this visit
      const origCurrent = dose.currentValue;
      const origTarget = dose.targetValue;
      const delta = origTarget - origCurrent;
      const intermediateTarget = dose.parameterName === 'pH'
        ? round1(origCurrent + delta * ratio)
        : Math.round(origCurrent + delta * ratio);

      // When a dose has a secondaryAdjustment (e.g., acid → primarily pH, also
      // drops TA), the side effect is proportional to how much chemical we
      // actually added. Capping the dose to half means the side effect is half
      // too. Without scaling here, the dose record claims the full secondary
      // drop even though only half the chemical landed.
      const secOrig = dose.secondaryAdjustment;
      const secDelta = secOrig ? secOrig.targetValue - secOrig.currentValue : 0;
      const secIntermediate = secOrig
        ? (secOrig.parameterName === 'pH'
            ? round1(secOrig.currentValue + secDelta * ratio)
            : Math.round(secOrig.currentValue + secDelta * ratio))
        : 0;
      const thisVisitSecondary = secOrig
        ? { ...secOrig, targetValue: secIntermediate }
        : undefined;
      const returnVisitSecondary = secOrig
        ? { ...secOrig, currentValue: secIntermediate, targetValue: secOrig.targetValue }
        : undefined;

      // Return visit dose = remainder (skipped for hard-capped chemicals like CaCl)
      if (!isCalciumChloride) {
        returnVisitDoses.push({
          ...dose,
          amount: remainder,
          currentValue: intermediateTarget,
          targetValue: origTarget,
          purpose: dose.purpose.replace(`from ${origCurrent}`, `from ~${intermediateTarget}`),
          alternatives: dose.alternatives?.map(alt => ({
            ...alt,
            amount: alt.amount > 0 ? round1(alt.amount * (1 - ratio)) : 0,
          })),
          secondaryAdjustment: returnVisitSecondary,
        });
      }

      // Cap this visit
      doses[i] = {
        ...dose,
        amount: scaledLimit,
        targetValue: intermediateTarget,
        purpose: dose.purpose.replace(`to ${origTarget}`, `to ~${intermediateTarget}`),
        alternatives: dose.alternatives?.map(alt => ({
          ...alt,
          amount: alt.amount > 0 ? round1(alt.amount * ratio) : 0,
        })),
        secondaryAdjustment: thisVisitSecondary,
      };

      // When a bicarb dose is split (simultaneous TA+pH path), the coupled acid dose
      // was calculated for the full bicarb. Recalculate the acid for the partial bicarb,
      // and optionally ease off acid to preserve LSI balance (Orenda: "LSI first").
      if (dose.parameterName === 'Total Alkalinity') {
        for (let j = i + 1; j < doses.length; j++) {
          const later = doses[j];
          // This "ease off acid" block only applies to acid doses (currentValue > targetValue).
          // A soda ash dose with a TA secondaryAdjustment looks structurally similar but is
          // raising pH, not lowering it — easing off would defeat the pH rescue.
          const laterIsAcidDose = later.currentValue > later.targetValue;
          if (
            later.parameterName === 'pH' &&
            later.secondaryAdjustment?.parameterName === 'Total Alkalinity' &&
            laterIsAcidDose
          ) {
            // Partial bicarb raises TA to intermediateTarget (not origTarget)
            // pH bump is proportionally smaller
            const partialBicarbPPM = intermediateTarget - dose.currentValue;
            const phBump = (partialBicarbPPM / 10) * 0.05;
            const newPostBicarbPH = round1(input.pH + phBump);

            // ─── LSI-aware acid targeting ───────────────────────────────
            // When bicarb is visit-limited, the aggressive pH target (e.g., 7.5)
            // drops TA so much that LSI tanks. Instead, solve for the pH that
            // preserves LSI balance given the limited TA and projected CH.
            // This is the key fix for the "high pH + low TA + acid eats bicarb" pattern.
            let acidPhTarget = later.targetValue; // default: original pH target

            // Predict this-visit CH (may also be visit-limited)
            const chDoseInArray = doses.find(d => d.parameterName === 'Calcium Hardness' && d.amount > 0);
            let predictedCH = input.calciumHardness;
            if (chDoseInArray) {
              const chLimit = visitLimits[chDoseInArray.chemical];
              const chScaledLimit = chLimit ? round1(chLimit * scale) : Infinity;
              if (chDoseInArray.amount > chScaledLimit) {
                // CH will also be visit-limited — predict the intermediate value
                const chRatio = chScaledLimit / chDoseInArray.amount;
                predictedCH = Math.round(chDoseInArray.currentValue +
                  (chDoseInArray.targetValue - chDoseInArray.currentValue) * chRatio);
              } else {
                predictedCH = chDoseInArray.targetValue;
              }
            }

            // Solve for pH that gives LSI ≈ 0.0 at (partialTA, predictedCH)
            // We target 0.0 (not +0.10) to split the difference between corrosive/scaling
            const lsiBalancedPH = solvePH_forLSI(
              input.temperature, predictedCH, intermediateTarget,
              input.tds, input.cya, 0.0,
            );

            // Use the LSI-balanced pH if it's less aggressive than the original target.
            // Cap at 8.2 (safe for swimmers/equipment per CPO Handbook) and never above
            // the post-bicarb pH minus 0.1 (always add at least a little acid).
            // This is more generous than the profile max because we're accepting that
            // this visit can't fully correct all parameters — preserving TA for LSI
            // is more important than hitting the exact pH target.
            const phCeiling = round1(Math.min(newPostBicarbPH - 0.1, 8.2));
            if (lsiBalancedPH !== null && lsiBalancedPH > acidPhTarget && phCeiling > acidPhTarget) {
              acidPhTarget = round1(Math.min(lsiBalancedPH, phCeiling));
            }
            // If even the ceiling is at or above the post-bicarb pH, skip acid entirely
            if (acidPhTarget >= newPostBicarbPH) {
              // No acid needed — the limited bicarb barely bumped pH
              doses[j] = {
                ...later,
                amount: 0,
                currentValue: newPostBicarbPH,
                targetValue: newPostBicarbPH,
                purpose: `pH at ${newPostBicarbPH} — acid deferred to preserve TA for LSI balance`,
                secondaryAdjustment: {
                  ...later.secondaryAdjustment!,
                  currentValue: intermediateTarget,
                  targetValue: intermediateTarget,
                },
              };
              break;
            }

            const newPhDrop = Math.max(0, newPostBicarbPH - acidPhTarget);
            const newAcidDoses = newPhDrop / 0.2;
            const newTALoss = Math.round(newAcidDoses * 4);
            const newNetTA = intermediateTarget - newTALoss;

            // Recalculate acid amount using Knorr non-linear lookup
            const newAcidAmount = spa
              ? totalAcidDose(newPostBicarbPH, acidPhTarget, 'sb', intermediateTarget, scale)
              : totalAcidDose(newPostBicarbPH, acidPhTarget, 'ma', intermediateTarget, scale);

            doses[j] = {
              ...later,
              amount: newAcidAmount,
              currentValue: newPostBicarbPH,
              targetValue: acidPhTarget,
              secondaryAdjustment: {
                ...later.secondaryAdjustment,
                currentValue: intermediateTarget,
                targetValue: newNetTA,
              },
              purpose: acidPhTarget !== later.targetValue
                ? later.purpose.replace(/to [\d.]+/, `to ${acidPhTarget.toFixed(1)} (LSI-balanced)`)
                : later.purpose,
              alternatives: later.alternatives?.map(alt => {
                return {
                  ...alt,
                  amount: totalAcidDose(newPostBicarbPH, acidPhTarget, 'sb', intermediateTarget, scale),
                };
              }),
            };
            break;
          }
        }
      }
    }
  }

  // Convert small amounts to friendlier units for readability
  function convertSmallUnit(amt: number, unit: string): { amount: number; unit: string } {
    if (unit === 'lbs' && amt > 0 && amt < 1) {
      const oz = round1(amt * 16);
      if (oz < 1) return { amount: round1(oz * 6), unit: 'tsp' };
      return { amount: oz, unit: 'oz' };
    }
    if ((unit === 'oz' || unit === 'fl oz') && amt > 0 && amt < 1) {
      return { amount: round1(amt * 6), unit: 'tsp' };
    }
    return { amount: amt, unit };
  }

  function convertSmallAmounts(dose: ChemicalDose): ChemicalDose {
    const converted = convertSmallUnit(dose.amount, dose.unit);
    if (converted.unit !== dose.unit) {
      dose = { ...dose, amount: converted.amount, unit: converted.unit };
    }
    if (dose.alternatives) {
      dose = {
        ...dose,
        alternatives: dose.alternatives.map(alt => {
          const c = convertSmallUnit(alt.amount, alt.unit);
          return c.unit !== alt.unit ? { ...alt, amount: c.amount, unit: c.unit } : alt;
        }),
      };
    }
    return dose;
  }

  // ─── LSI Optimization ────────────────────────────────────────────────────
  // After computing all doses, check projected LSI. If negative, evaluate
  // every chemical we're already dosing that touches an LSI parameter
  // (pH, TA, CH). Solve each independently for LSI = +0.10, rank by
  // smallest deviation from current target, and apply the gentlest tweak.

  function computeProjected(doseList: ChemicalDose[]): { proj: ProjectedValues; lsi: number } {
    const p: ProjectedValues = {
      pH: input.pH,
      totalAlkalinity: input.totalAlkalinity,
      calciumHardness: input.calciumHardness,
      cya: input.cya,
      freeChlorine: input.freeChlorine ?? 0,
      totalChlorine: input.totalChlorine ?? 0,
      salt: input.salt ?? 0,
      bromine: input.bromine ?? 0,
      phosphates: input.phosphates ?? 0,
    };
    for (const d of doseList) {
      // Drains blend pool water with fill water — don't use applyAdjustment
      // (merged drain has targetValue: 0 and combined parameterName).
      if (d.chemical === 'Partial Drain & Refill') {
        const pctMatch = d.safetyNote?.match(/~(\d+)%/);
        if (pctMatch) {
          const drainFrac = parseInt(pctMatch[1]) / 100;
          p.totalAlkalinity = Math.round(blendedDilute(p.totalAlkalinity, FILL_WATER.totalAlkalinity, drainFrac));
          p.calciumHardness = Math.round(blendedDilute(p.calciumHardness, FILL_WATER.calciumHardness, drainFrac));
          p.cya = Math.round(blendedDilute(p.cya, FILL_WATER.cya, drainFrac));
          p.freeChlorine = round1(blendedDilute(p.freeChlorine, FILL_WATER.freeChlorine, drainFrac));
          p.salt = Math.round(blendedDilute(p.salt, 0, drainFrac)); // fill water has ~0 salt
        }
        continue;
      }
      // Skip zero-amount advice doses (Aeration, Retest After Refill) — they represent
      // multi-visit processes, not instant chemistry changes.
      if (d.amount === 0 && d.chemical !== 'Partial Drain & Refill') continue;
      applyAdjustment(p, d.parameterName, d.targetValue);
      if (d.secondaryAdjustment) {
        applyAdjustment(p, d.secondaryAdjustment.parameterName, d.secondaryAdjustment.targetValue);
      }
    }
    // Safety clamp: if cross-effects produced unrealistic projections, bound them
    p.pH = Math.max(6.2, Math.min(8.8, p.pH));
    p.totalAlkalinity = Math.max(0, p.totalAlkalinity);
    p.calciumHardness = Math.max(0, p.calciumHardness);
    p.cya = Math.max(0, p.cya);
    p.freeChlorine = Math.max(0, p.freeChlorine);
    p.salt = Math.max(0, p.salt);

    // Recompute TC from projected FC + breakpoint logic
    const startingCC = Math.max(0, (input.totalChlorine ?? 0) - (input.freeChlorine ?? 0));
    if (startingCC > 0 && p.freeChlorine >= startingCC * 10) {
      // Breakpoint chlorination destroys chloramines → CC ≈ 0
      p.totalChlorine = p.freeChlorine;
    } else {
      // TC = projected FC + remaining CC
      p.totalChlorine = round1(p.freeChlorine + startingCC);
    }

    const lsiResult = calculateLSI({ ...input, pH: p.pH, totalAlkalinity: p.totalAlkalinity, calciumHardness: p.calciumHardness, cya: p.cya }, 'formula');
    return { proj: p, lsi: lsiResult.lsi };
  }

  const preliminary = computeProjected(doses);

  // ─── LSI Guard: never worsen |LSI| ────────────────────────────────────────
  // Dynamic target: if starting is near-balanced, preserve it; otherwise improve toward +0.10
  const lsiOptTarget = Math.abs(startingLSI) < LSI_TARGET ? startingLSI : LSI_TARGET;
  // Trigger: projected is worse than target OR treatment worsened |LSI|
  const projectedWorse = Math.abs(preliminary.lsi) > Math.abs(startingLSI) + 0.02;
  const shouldOptimize = preliminary.lsi < lsiOptTarget || projectedWorse;

  if (shouldOptimize) {
    const optScale = input.poolVolume / 10000;

    // Build candidate levers from existing doses that touch LSI parameters
    interface LSILever {
      param: 'pH' | 'TA' | 'CH';
      doseIdx: number;
      solvedValue: number;
      currentTarget: number;
      deviation: number;   // fraction of acceptable range
      priority: number;    // tiebreaker: lower = preferred (pH 0, TA 1, CH 2)
    }
    const levers: LSILever[] = [];

    // pH lever — if we're dosing acid, we can ease off (target slightly higher pH)
    // or if dosing pH up, we can push a bit higher.
    // Clamp to target range: even if we can't reach LSI +0.10, moving toward it helps.
    const phIdx = doses.findIndex(d => d.parameterName === 'pH' && (d.order === 1 || d.order === 2));
    if (phIdx >= 0) {
      const phDose = doses[phIdx];
      const isCoupledAcidTA = phDose.secondaryAdjustment?.parameterName === 'Total Alkalinity';

      let solved: number | null;
      if (isCoupledAcidTA) {
        // Acid-for-TA dose: pH and TA are coupled. As we ease off acid (raise pH target),
        // TA drops less. Binary search for pH where LSI ≈ lsiOptTarget.
        const startPH = phDose.currentValue ?? input.pH;
        const startTA = phDose.secondaryAdjustment!.currentValue ?? input.totalAlkalinity;
        let lo = phDose.targetValue; // original target (e.g., 7.2) — full acid
        let hi = startPH;             // current pH (e.g., 7.6) — no acid at all
        solved = null;
        for (let iter = 0; iter < 20; iter++) {
          const mid = (lo + hi) / 2;
          const phDrop = Math.max(0, startPH - mid);
          const taLoss = Math.round((phDrop / 0.2) * 4);
          const midTA = startTA - taLoss;
          const lsi = calculateLSI({
            ...input, pH: mid, totalAlkalinity: midTA,
            calciumHardness: preliminary.proj.calciumHardness, cya: preliminary.proj.cya,
          }, 'formula').lsi;
          if (lsi < lsiOptTarget) {
            lo = mid; // LSI too low → need higher pH (less acid)
          } else {
            hi = mid; // LSI at or above target → can use more acid
          }
        }
        solved = round1((lo + hi) / 2);
      } else {
        solved = solvePH_forLSI(
          input.temperature, preliminary.proj.calciumHardness,
          preliminary.proj.totalAlkalinity, input.tds, preliminary.proj.cya,
          lsiOptTarget,
        );
      }

      if (solved !== null) {
        const clamped = round1(Math.max(targets.pH.min, Math.min(targets.pH.max, solved)));
        if (clamped !== phDose.targetValue) {
          const range = targets.pH.max - targets.pH.min;
          const deviation = range > 0 ? Math.abs(clamped - phDose.targetValue) / range : 999;
          levers.push({ param: 'pH', doseIdx: phIdx, solvedValue: clamped, currentTarget: phDose.targetValue, deviation, priority: 0 });
        }
      }
    }

    // TA lever — nudge baking soda target upward (clamp to max + 20 ppm buffer)
    const taIdx = doses.findIndex(d => d.parameterName === 'Total Alkalinity' && d.amount > 0);
    if (taIdx >= 0) {
      const solved = solveTA_forLSI(
        preliminary.proj.pH, input.temperature,
        preliminary.proj.calciumHardness, input.tds, preliminary.proj.cya,
        lsiOptTarget,
      );
      if (solved !== null && solved > doses[taIdx].targetValue) {
        const clamped = Math.min(solved, targets.alkalinity.max + 20);
        const range = targets.alkalinity.max - targets.alkalinity.min;
        const deviation = range > 0 ? Math.abs(clamped - doses[taIdx].targetValue) / range : 999;
        levers.push({ param: 'TA', doseIdx: taIdx, solvedValue: clamped, currentTarget: doses[taIdx].targetValue, deviation, priority: 1 });
      }
    }

    // CH lever — nudge calcium target (up if corrosive, down if scale-forming)
    const chIdx = doses.findIndex(d => d.parameterName === 'Calcium Hardness' && d.amount > 0);
    if (chIdx >= 0) {
      const solved = solveCH_forLSI(
        preliminary.proj.pH, input.temperature,
        preliminary.proj.totalAlkalinity, input.tds, preliminary.proj.cya,
        lsiOptTarget,
      );
      if (solved !== null && solved !== doses[chIdx].targetValue) {
        const CC = 'Calcium Chloride (100%)';
        if (solved > doses[chIdx].targetValue) {
          // Raise CH (corrosive LSI) — cap to visit-limit and target max.
          // Effective lb cap for THIS pool is the smaller of (per-10k limit
          // scaled by volume) and the absolute hard cap. Convert that lb
          // ceiling back to a CH ppm delta so the LSI solver clamps correctly.
          const chLimit = visitLimits[CC];
          const ratePerCC = r(rates, CC, 0.9);
          const maxLbs = chLimit
            ? Math.min(chLimit * optScale, CACL_ABSOLUTE_CAP_LBS)
            : CACL_ABSOLUTE_CAP_LBS;
          const maxDeltaPpm = ratePerCC > 0 && optScale > 0
            ? (maxLbs * 10) / (ratePerCC * optScale)
            : Infinity;
          const visitLimitMax = Math.round(input.calciumHardness + maxDeltaPpm);
          const clamped = Math.min(solved, targets.calciumHardness.max, visitLimitMax);
          if (clamped > doses[chIdx].targetValue) {
            const range = targets.calciumHardness.max - targets.calciumHardness.min;
            const deviation = range > 0 ? Math.abs(clamped - doses[chIdx].targetValue) / range : 999;
            levers.push({ param: 'CH', doseIdx: chIdx, solvedValue: clamped, currentTarget: doses[chIdx].targetValue, deviation, priority: 2 });
          }
        } else {
          // Back off CH (scale-forming LSI) — clamp to at least current CH (never dose negative)
          const clamped = Math.max(solved, input.calciumHardness);
          if (clamped < doses[chIdx].targetValue) {
            const range = targets.calciumHardness.max - targets.calciumHardness.min;
            const deviation = range > 0 ? Math.abs(clamped - doses[chIdx].targetValue) / range : 999;
            levers.push({ param: 'CH', doseIdx: chIdx, solvedValue: clamped, currentTarget: doses[chIdx].targetValue, deviation, priority: 2 });
          }
        }
      }
    }

    // Sort by smallest deviation first, then prefer pH > TA > CH
    levers.sort((a, b) => a.deviation - b.deviation || a.priority - b.priority);

    // ─── Polish gate ────────────────────────────────────────────────────
    // When caller set skipPolishDoses, ask isPolishDoseWorthIt() before
    // applying the best lever. If the gate says skip, record it and clear
    // the levers array so the application block below no-ops. The gate
    // biases heavily toward "keep" — only skips when every safety condition
    // is met.
    if (options.skipPolishDoses && levers.length > 0) {
      const best = levers[0];

      // Is the starting reading for this lever's parameter already in range?
      const targetRange =
        best.param === 'pH' ? targets.pH :
        best.param === 'TA' ? targets.alkalinity :
        targets.calciumHardness;
      const currentReading =
        best.param === 'pH' ? input.pH :
        best.param === 'TA' ? input.totalAlkalinity :
        input.calciumHardness;
      const parameterCurrentlyInRange =
        currentReading >= targetRange.min && currentReading <= targetRange.max;

      // Is this pH lever attached to a bicarb+acid coupled pair? Those are
      // load-bearing and must never be skipped.
      const phDoseAtBest = best.param === 'pH' ? doses[best.doseIdx] : null;
      const isCoupledAcidPair =
        phDoseAtBest?.secondaryAdjustment?.parameterName === 'Total Alkalinity';

      // Compute projected LSI as if we applied the lever vs didn't.
      // preliminary.lsi is the "without" baseline — the LSI the engine would
      // produce with only base dosing, no optimizer. For "with," swap in the
      // lever's solvedValue for its own parameter and re-run calculateLSI.
      const projectedLSIWithoutDose = preliminary.lsi;
      const withDoseInput = {
        ...input,
        pH: best.param === 'pH' ? best.solvedValue : preliminary.proj.pH,
        totalAlkalinity: best.param === 'TA' ? best.solvedValue : preliminary.proj.totalAlkalinity,
        calciumHardness: best.param === 'CH' ? best.solvedValue : preliminary.proj.calciumHardness,
        cya: preliminary.proj.cya,
      };
      const projectedLSIWithDose = calculateLSI(withDoseInput, 'formula').lsi;

      const gate = isPolishDoseWorthIt({
        parameter: best.param,
        startingLSI,
        projectedLSIWithDose,
        projectedLSIWithoutDose,
        parameterCurrentlyInRange,
        surface: surfaceType,
        isCoupledAcidPair,
      });

      if (!gate.keep) {
        polishSkips.push({
          parameter: best.param,
          reason: gate.reason,
          startingLSI: round1(startingLSI),
          projectedLSIWithDose: round1(projectedLSIWithDose),
          projectedLSIWithoutDose: round1(projectedLSIWithoutDose),
          // Conservative placeholder — polish nudges modify existing doses
          // rather than adding new ones, so the true on-site savings depend
          // on whether the CH back-off case removes a dose entirely. 15 min
          // is the floor (per-chemical wait when two chems need separation).
          estimatedMinutesSaved: 15,
        });
        // Short-circuit the optimization for this visit — no lever applied.
        levers.length = 0;
      }
    }

    // Apply the gentlest lever
    if (levers.length > 0) {
      const best = levers[0];
      const idx = best.doseIdx;

      if (best.param === 'pH') {
        // Adjust pH target for better LSI. For acid doses, a higher target
        // means less acid (easing off). Compare against current dose target,
        // not input.pH — the solved value is typically between target and reading.
        const oldDose = doses[idx];
        const isAcidDose = oldDose.purpose.toLowerCase().includes('lower');

        if (isAcidDose && best.solvedValue > oldDose.targetValue) {
          // Ease off acid: target higher pH → less acid → higher LSI
          const phDrop = (oldDose.currentValue ?? input.pH) - best.solvedValue;
          const acidDoses = Math.max(0, phDrop / 0.2);
          const optTA = preliminary.proj.totalAlkalinity;
          const acidFrom = oldDose.currentValue ?? input.pH;
          const newAmount = spa
            ? totalAcidDose(acidFrom, best.solvedValue, 'sb', optTA, optScale)
            : totalAcidDose(acidFrom, best.solvedValue, 'ma', optTA, optScale);

          // Update TA secondary adjustment if this is an acid-for-TA dose
          let updatedSecondary = oldDose.secondaryAdjustment;
          if (updatedSecondary?.parameterName === 'Total Alkalinity') {
            const taLoss = Math.round(acidDoses * 4);
            const startTA = updatedSecondary.currentValue ?? input.totalAlkalinity;
            updatedSecondary = {
              ...updatedSecondary,
              targetValue: startTA - taLoss,
            };
          }

          doses[idx] = {
            ...oldDose,
            amount: newAmount,
            targetValue: round1(best.solvedValue),
            secondaryAdjustment: updatedSecondary,
            purpose: oldDose.purpose.replace(/to [\d.]+/, `to ${best.solvedValue.toFixed(1)} (LSI-optimized)`),
          };
        } else if (!isAcidDose && best.solvedValue < oldDose.targetValue && best.solvedValue >= (oldDose.currentValue ?? input.pH)) {
          // Ease off base: target lower pH → less soda ash → lower LSI (prevents scale-forming).
          // Floor at profile pH min — LSI optimization must not leave pH below safe range
          // even if the solver says a lower pH is LSI-optimal.
          const easedTarget = Math.max(best.solvedValue, targets.pH.min);
          const chemName = spa ? 'pH Up' : 'Soda Ash (Sodium Carbonate)';
          const delta = easedTarget - (oldDose.currentValue ?? input.pH);
          const baseDoses = Math.max(0, delta / 0.2);
          const newAmount = round1(baseDoses * r(rates, chemName, 6) * optScale);

          // Update TA secondary adjustment if soda ash affects TA (~5 ppm per 0.2 pH)
          let updatedSecondary = oldDose.secondaryAdjustment;
          if (updatedSecondary?.parameterName === 'Total Alkalinity') {
            const taRise = Math.round(baseDoses * 5);
            const startTA = updatedSecondary.currentValue ?? input.totalAlkalinity;
            updatedSecondary = { ...updatedSecondary, targetValue: startTA + taRise };
          }

          doses[idx] = {
            ...oldDose,
            amount: newAmount,
            targetValue: round1(easedTarget),
            secondaryAdjustment: updatedSecondary,
            purpose: oldDose.purpose.replace(/to [\d.]+/, `to ${easedTarget.toFixed(1)} (LSI-optimized)`),
          };
        }
      }

      if (best.param === 'TA') {
        const taDose = doses[idx];
        const BICARB = 'Sodium Bicarbonate (Baking Soda)';
        const newDelta = best.solvedValue - input.totalAlkalinity;
        if (newDelta <= 0) { /* solver wants TA lower — can't do that with bicarb, skip */ }
        else {
        const increments = newDelta / 10;
        const newAmount = round1(increments * r(rates, BICARB, 1.4) * optScale);

        // Bicarb raises pH ~0.05 per 10 ppm TA bump. After LSI-optimizing the
        // bicarb amount, recompute the secondary so projection matches the
        // larger dose. If the original dose lacked a pH secondary, attach one
        // — projection only reflects what's recorded on the dose object.
        const phBump = round1((newDelta / 10) * 0.05);
        const postBicarbPH = round1(input.pH + phBump);
        const phSecondary = phBump >= 0.1 ? {
          parameterName: 'pH',
          currentValue: input.pH,
          targetValue: postBicarbPH,
          // Preserve isAdverse if it was set on the original (e.g., simultaneous-solve path)
          ...(taDose.secondaryAdjustment?.parameterName === 'pH' && { isAdverse: taDose.secondaryAdjustment.isAdverse }),
        } : taDose.secondaryAdjustment;

        doses[idx] = {
          ...taDose,
          amount: newAmount,
          targetValue: best.solvedValue,
          purpose: `Raise Total Alkalinity from ${input.totalAlkalinity} to ${best.solvedValue} ppm (LSI-optimized)`,
          secondaryAdjustment: phSecondary,
        };

        // Recalculate the coupled pH dose if present. This block was written for
        // bicarb+acid (TA up, pH down) coupling — recomputing acid amount for the
        // new bicarb level. It must NOT touch a soda ash dose (currentValue <
        // targetValue), which raises pH; running it through totalAcidDose would
        // zero it out and leave pH uncorrected.
        const coupledPHIdx = doses.findIndex(d => d.parameterName === 'pH' && d.order === 2);
        if (coupledPHIdx >= 0) {
          const phDose = doses[coupledPHIdx];
          const phDoseIsAcid = phDose.currentValue > phDose.targetValue;
          const phBump = (newDelta / 10) * 0.05;
          const newEffectivePH = round1(input.pH + phBump);

          if (phDoseIsAcid) {
            const phDrop = newEffectivePH - targets.pH.ideal;
            const newAcidAmount = spa
              ? totalAcidDose(newEffectivePH, targets.pH.ideal, 'sb', best.solvedValue, optScale)
              : totalAcidDose(newEffectivePH, targets.pH.ideal, 'ma', best.solvedValue, optScale);
            const taLoss = Math.round((phDrop / 0.2) * 4);
            const netTA = best.solvedValue - taLoss;

            doses[coupledPHIdx] = {
              ...phDose,
              amount: newAcidAmount,
              currentValue: newEffectivePH,
              secondaryAdjustment: phDose.secondaryAdjustment ? {
                ...phDose.secondaryAdjustment,
                currentValue: best.solvedValue,
                targetValue: netTA,
              } : undefined,
            };
          } else {
            // Soda ash dose: recompute amount for the new post-bicarb starting pH.
            // More bicarb → higher starting pH → less soda ash needed.
            const SA = spa ? 'pH Up' : 'Soda Ash (Sodium Carbonate)';
            const baseDelta = Math.max(0, phDose.targetValue - newEffectivePH);
            const baseDoses = baseDelta / 0.2;
            const newBaseAmount = round1(baseDoses * r(rates, SA, 6) * optScale);

            doses[coupledPHIdx] = {
              ...phDose,
              amount: newBaseAmount,
              currentValue: newEffectivePH,
              secondaryAdjustment: phDose.secondaryAdjustment?.parameterName === 'Total Alkalinity' ? {
                ...phDose.secondaryAdjustment,
                currentValue: best.solvedValue,
                targetValue: best.solvedValue + Math.round(baseDoses * 5),
              } : phDose.secondaryAdjustment,
            };
          }
        }
        }
      }

      if (best.param === 'CH') {
        const chDose = doses[idx];
        const CC = 'Calcium Chloride (100%)';
        const newDelta = best.solvedValue - input.calciumHardness;
        if (newDelta > 0) {
          const increments = newDelta / 10;
          const newAmount = round1(increments * r(rates, CC, 0.9) * optScale);

          doses[idx] = {
            ...chDose,
            amount: newAmount,
            targetValue: best.solvedValue,
            purpose: `Raise Calcium Hardness from ${input.calciumHardness} to ${best.solvedValue} ppm (LSI-optimized)`,
          };
        } else {
          // Back off: solver says CH should be ≤ current — remove the dose entirely
          doses[idx] = { ...chDose, amount: 0, targetValue: input.calciumHardness,
            purpose: `Calcium Hardness dose removed (LSI-optimized — starting ${input.calciumHardness} ppm is adequate)` };
        }
      }
    }
  }

  // ─── LSI Safety Guard ───────────────────────────────────────────────────
  // The LSI optimizer fights to bring projected LSI toward balance, but when
  // visit-cap walls (e.g., 10 lb CaCl absolute) prevent matching pH/CH moves,
  // the optimizer hits a wall and the engine ships a plan that pushes water
  // FURTHER from balance than where it started. Common pattern: high pH +
  // very low CH on a cold pool — acid drops pH but CaCl can't raise CH
  // enough in one visit, leaving water corrosive.
  //
  // Guard: after the optimizer, if projected LSI is meaningfully outside the
  // safe band (-0.3..+0.3) AND removing the pH dose would bring it closer to
  // balance, defer that dose to the return visit. Customer's water sits at
  // imperfect pH for a week, but stays in a non-corrosive / non-scaling state.
  {
    const SAFE_LO = -0.3;
    const SAFE_HI = 0.3;
    const distFromSafe = (lsi: number) =>
      lsi < SAFE_LO ? SAFE_LO - lsi : lsi > SAFE_HI ? lsi - SAFE_HI : 0;

    const postOpt = computeProjected(doses);
    const currentDist = distFromSafe(postOpt.lsi);

    // pH safety overrides LSI optimization. When input pH is itself dangerous,
    // shipping the pH correction is non-negotiable — even if it pushes LSI
    // scale-forming or corrosive, the alternative (leaving pH at 7.0 or 8.6
    // for another week) is worse for surfaces and sanitation. The 7.1 threshold
    // matches the fuzz harness's pH-rescue trigger so the guard and the harness
    // agree on what counts as "critical."
    const PH_CRITICALLY_LOW = 7.1;
    const PH_CRITICALLY_HIGH = 8.5;

    if (currentDist > 0.1) {
      // Find a pH-correction dose to try removing. Either a primary pH dose
      // (acid or soda ash) or a bicarb dose whose secondary is pushing pH up.
      const phPrimaryIdx = doses.findIndex(d => d.parameterName === 'pH' && d.amount > 0);
      const bicarbIdx = doses.findIndex(d =>
        d.parameterName === 'Total Alkalinity' &&
        d.amount > 0 &&
        d.secondaryAdjustment?.parameterName === 'pH'
      );
      // Prefer deferring the primary pH dose if present; otherwise the bicarb dose
      // (only when LSI was driven scale-forming by bicarb's pH bump).
      const deferIdx =
        phPrimaryIdx >= 0 ? phPrimaryIdx :
        (postOpt.lsi > SAFE_HI && bicarbIdx >= 0 ? bicarbIdx : -1);

      // Don't defer if the dose is rescuing critically dangerous starting pH.
      const candidate = deferIdx >= 0 ? doses[deferIdx] : null;
      const isPhUpDose = candidate ? candidate.currentValue < candidate.targetValue : false;
      const isPhDownDose = candidate ? candidate.currentValue > candidate.targetValue : false;
      const skipForPHSafety =
        (isPhUpDose && input.pH < PH_CRITICALLY_LOW) ||
        (isPhDownDose && input.pH > PH_CRITICALLY_HIGH);

      if (deferIdx >= 0 && !skipForPHSafety) {
        const candidateDoses = doses.filter((_, i) => i !== deferIdx);
        const candidate = computeProjected(candidateDoses);
        const candidateDist = distFromSafe(candidate.lsi);

        if (candidateDist < currentDist - 0.15) {
          const deferredDose = doses[deferIdx];
          doses.splice(deferIdx, 1);
          returnVisitDoses.push({
            ...deferredDose,
            safetyNote: (deferredDose.safetyNote ? deferredDose.safetyNote + ' ' : '') +
              `Deferred — single-visit ${deferredDose.parameterName.toLowerCase()} correction would push LSI to ${postOpt.lsi.toFixed(2)} (outside safe -0.3/+0.3 band). Bring calcium up first this visit; complete this dose next visit once water can absorb the change without going corrosive or scale-forming.`,
          });
          readingWarnings.push(
            `${deferredDose.parameterName} correction deferred to return visit. Single-visit treatment would push LSI to ${postOpt.lsi.toFixed(2)}; deferring brings projected LSI to ${candidate.lsi.toFixed(2)}. Pool sits at imperfect ${deferredDose.parameterName.toLowerCase()} for the week but stays out of corrosive/scaling territory.`
          );
        }
      }
    }
  }

  // ─── Intermediate State Simulation ──────────────────────────────────────
  // Walk through the dose sequence step-by-step, computing LSI after each
  // chemical addition. If any intermediate state is highly scale-forming
  // (precipitation risk), try reordering to reduce the peak.
  //
  // NOTE: Aeration (and other zero-amount advisory doses) are skipped here
  // because they represent multi-visit processes, not instant chemistry
  // changes. That means projected LSI on an aeration-prescribed visit is
  // pessimistic — the actual pH/TA drift toward target over hours/days
  // isn't visible until the next reading.

  function simulateSequence(
    doseList: ChemicalDose[],
  ): { states: IntermediateState[]; maxLSI: number } {
    // Full ProjectedValues so applyAdjustment's switch can write any param.
    // Salt/bromine/phosphates aren't read by the LSI calc that follows, but
    // the switch case for those parameters must have a slot to write into
    // or tsc complains and any future read of those fields would crash.
    const running: ProjectedValues = {
      pH: input.pH,
      totalAlkalinity: input.totalAlkalinity,
      calciumHardness: input.calciumHardness,
      cya: input.cya,
      freeChlorine: input.freeChlorine ?? 0,
      totalChlorine: input.totalChlorine ?? 0,
      salt: input.salt ?? 0,
      bromine: input.bromine ?? 0,
      phosphates: input.phosphates ?? 0,
    };
    const states: IntermediateState[] = [];
    let maxLSI = -Infinity;
    let stepNum = 0;

    for (const d of doseList) {
      if (d.amount <= 0 || d.parameterName === 'Maintenance') continue;

      applyAdjustment(running, d.parameterName, d.targetValue);
      if (d.secondaryAdjustment) {
        applyAdjustment(running, d.secondaryAdjustment.parameterName, d.secondaryAdjustment.targetValue);
      }

      const lsiResult = calculateLSI({
        ...input,
        pH: running.pH,
        totalAlkalinity: running.totalAlkalinity,
        calciumHardness: running.calciumHardness,
        cya: running.cya,
      }, 'formula');

      stepNum++;
      // Precipitation thresholds: +0.5 for spas/hot water (APSP-11), +0.6 for pools (TFP "scaling likely")
      const threshold = (spa || input.temperature >= 95) ? 0.5 : 0.6;
      states.push({
        step: stepNum,
        chemical: d.chemical,
        pH: round1(running.pH),
        totalAlkalinity: Math.round(running.totalAlkalinity),
        calciumHardness: Math.round(running.calciumHardness),
        lsi: lsiResult.lsi,
        precipitationRisk: lsiResult.lsi > threshold,
      });
      if (lsiResult.lsi > maxLSI) maxLSI = lsiResult.lsi;
    }
    return { states, maxLSI };
  }

  const initialSim = simulateSequence(doses);
  let finalStates = initialSim.states;
  let precipitationWarning: string | undefined;

  if (initialSim.states.some(s => s.precipitationRisk)) {
    // Try alternative orderings to reduce intermediate LSI peaks
    const candidates: { label: string; doseArr: ChemicalDose[]; sim: ReturnType<typeof simulateSequence> }[] = [];

    // Strategy A: Move acid before base (lower pH first)
    const reorderedA = doses.map(d =>
      isAcid(d.chemical) ? { ...d, order: 0.5 } : d
    ).sort((a, b) => a.order - b.order);
    candidates.push({ label: 'acid-first', doseArr: reorderedA, sim: simulateSequence(reorderedA) });

    // Strategy B: Move calcium after acid
    const reorderedB = doses.map(d =>
      isCalciumChloride(d.chemical) ? { ...d, order: 2.5 } : d
    ).sort((a, b) => a.order - b.order);
    candidates.push({ label: 'calcium-after-acid', doseArr: reorderedB, sim: simulateSequence(reorderedB) });

    // Pick the best alternative
    const best = candidates.reduce((a, b) => a.sim.maxLSI < b.sim.maxLSI ? a : b);
    if (best.sim.maxLSI < initialSim.maxLSI) {
      // Apply the better ordering
      doses.length = 0;
      doses.push(...best.doseArr);
      finalStates = best.sim.states;
      precipitationWarning = `Treatment order adjusted to reduce precipitation risk (peak LSI ${initialSim.maxLSI.toFixed(2)} → ${best.sim.maxLSI.toFixed(2)}).`;
    }

    // If risk still persists after reordering, warn about the worst step
    const riskSteps = finalStates.filter(s => s.precipitationRisk);
    if (riskSteps.length > 0) {
      const worst = riskSteps.reduce((a, b) => a.lsi > b.lsi ? a : b);
      const riskMsg = `Precipitation risk after step ${worst.step} (${worst.chemical}): intermediate LSI +${worst.lsi.toFixed(2)} at pH ${worst.pH.toFixed(1)} with CH ${worst.calciumHardness}${input.temperature >= 95 ? ` at ${input.temperature}°F` : ''}. Add each chemical slowly, allow full circulation between steps, and monitor for cloudiness.`;
      precipitationWarning = precipitationWarning ? precipitationWarning + ' ' + riskMsg : riskMsg;
    }
  }

  for (let i = 0; i < doses.length; i++) doses[i] = convertSmallAmounts(doses[i]);
  for (let i = 0; i < returnVisitDoses.length; i++) returnVisitDoses[i] = convertSmallAmounts(returnVisitDoses[i]);

  const interactions = detectInteractions(doses, spa);

  // Compute final projected values (may have been adjusted by LSI optimization)
  const allThisVisitDoses = doses;
  const final = computeProjected(allThisVisitDoses);
  const projected = final.proj;

  const projectedInput: WaterTestInput = {
    ...input,
    pH: projected.pH,
    totalAlkalinity: projected.totalAlkalinity,
    calciumHardness: projected.calciumHardness,
    cya: projected.cya,
  };
  const projectedLSIResult = calculateLSI(projectedInput, 'formula');

  // Project LSI after return visit (this-visit + return-visit doses combined).
  // Use the profile's ideal pH instead of this-visit's projected pH, because
  // pH drifts back toward equilibrium between visits (CO₂ exchange, natural
  // buffering). This gives a more realistic return visit projection than
  // assuming the tech's acid target holds for days.
  function computeReturnLSI(): number {
    const rv = computeProjected([...allThisVisitDoses, ...returnVisitDoses]);
    const rvInput: WaterTestInput = {
      ...input,
      pH: Math.min(rv.proj.pH, targets.pH.ideal),
      totalAlkalinity: rv.proj.totalAlkalinity,
      calciumHardness: rv.proj.calciumHardness,
      cya: rv.proj.cya,
    };
    return calculateLSI(rvInput, 'formula').lsi;
  }

  let returnVisitProjectedLSI: number | undefined;
  if (returnVisitDoses.length > 0) {
    returnVisitProjectedLSI = computeReturnLSI();

    // ─── Return Visit LSI Guard ──────────────────────────────────────────
    // The return visit doses were calculated from original targets before this
    // visit's improvements. Now that TA/pH/CH are partially corrected, the
    // original return targets may overshoot LSI. Scale back CH and/or TA to
    // produce balanced water after both visits.
    // Scale back return visit CH if it would overshoot LSI. The this-visit
    // improvements (TA, pH) change the LSI landscape, so the original full
    // CH target may be too high. TA adjustments are skipped because modifying
    // return bicarb breaks the split-dose TA consistency — and in practice
    // the tech retests on the return visit anyway.
    if (Math.abs(returnVisitProjectedLSI) > 0.30) {
      const rvChIdx = returnVisitDoses.findIndex(d => d.parameterName === 'Calcium Hardness' && d.amount > 0);
      if (rvChIdx >= 0) {
        const rvRaw = computeProjected([...allThisVisitDoses, ...returnVisitDoses]);
        // Use equilibrium pH for the solver (same as the projection)
        const rvPH = Math.min(rvRaw.proj.pH, targets.pH.ideal);
        const balancedCH = solveCH_forLSI(
          rvPH, input.temperature, rvRaw.proj.totalAlkalinity, input.tds, rvRaw.proj.cya, LSI_TARGET,
        );
        if (balancedCH !== null && balancedCH > 0) {
          const rvDose = returnVisitDoses[rvChIdx];
          const currentCH = rvDose.currentValue;
          const newTarget = Math.round(Math.max(currentCH, Math.min(rvDose.targetValue, balancedCH)));
          const rvScale = input.poolVolume / 10000;
          if (newTarget < rvDose.targetValue && newTarget > currentCH) {
            const CC = 'Calcium Chloride (100%)';
            returnVisitDoses[rvChIdx] = {
              ...rvDose,
              amount: round1(((newTarget - currentCH) / 10) * r(rates, CC, 0.9) * rvScale),
              targetValue: newTarget,
              purpose: `Raise Calcium Hardness from ${currentCH} to ${newTarget} ppm (LSI-balanced)`,
            };
          } else if (newTarget <= currentCH) {
            returnVisitDoses[rvChIdx] = { ...rvDose, amount: 0, targetValue: currentCH,
              purpose: `Calcium Hardness at ${currentCH} ppm is adequate for LSI balance` };
          }
          returnVisitProjectedLSI = computeReturnLSI();
        }
      }
    }
  }

  // ─── Validation Engine ──────────────────────────────────────────────────
  // Feed projected values back through the dosing engine as a verification
  // pass. If it says more adjustments are needed, our projections are off.
  const validationWarnings: ValidationWarning[] = [];

  // Skip CYA/chlorine checks when not applicable (bromine systems, spas, indoor pools)
  const hasCYADose = allThisVisitDoses.some(d => d.parameterName === 'CYA (Stabilizer)');
  // When acid was used to intentionally lower TA (targets pH below normal min),
  // widen pH validation floor so the engine doesn't flag its own target as an error.
  const lowestPhTarget = allThisVisitDoses
    .filter(d => d.parameterName === 'pH' && d.targetValue < targets.pH.min)
    .reduce((min, d) => Math.min(min, d.targetValue), targets.pH.min);
  const phValidationMin = lowestPhTarget;
  const checks: { param: string; value: number; target: { min: number; max: number } }[] = [
    { param: 'pH', value: projected.pH, target: { min: phValidationMin, max: targets.pH.max } },
    { param: 'Total Alkalinity', value: projected.totalAlkalinity, target: targets.alkalinity },
    { param: 'Calcium Hardness', value: projected.calciumHardness, target: targets.calciumHardness },
  ];
  if (!bromineSystem) {
    checks.push({ param: 'Free Chlorine', value: projected.freeChlorine, target: targets.freeChlorine });
  }
  if (hasCYADose || input.cya > 0) {
    checks.push({ param: 'CYA (Stabilizer)', value: projected.cya, target: targets.cya });
  }

  for (const c of checks) {
    // Check if a return visit dose will address this parameter
    const returnFix = returnVisitDoses.find(d =>
      d.parameterName === c.param ||
      d.parameterName.includes(c.param) ||
      (c.param === 'CYA (Stabilizer)' && d.parameterName === 'CYA (Stabilizer)')
    );
    const returnNote = returnFix ? ` — will be corrected on return visit` : '';

    if (c.value < c.target.min) {
      validationWarnings.push({
        parameter: c.param,
        projected: c.value,
        targetMin: c.target.min,
        targetMax: c.target.max,
        message: `${c.param} projected at ${c.value} — below minimum ${c.target.min}${returnNote}`,
      });
    } else if (c.value > c.target.max) {
      validationWarnings.push({
        parameter: c.param,
        projected: c.value,
        targetMin: c.target.min,
        targetMax: c.target.max,
        message: `${c.param} projected at ${c.value} — above maximum ${c.target.max}${returnNote}`,
      });
    }
  }

  // High-temperature scaling warning — hot water + positive LSI = rapid scale formation (Orenda)
  if (input.temperature >= 85 && projectedLSIResult.lsi > 0.3) {
    validationWarnings.push({
      parameter: 'Temperature + LSI',
      projected: projectedLSIResult.lsi,
      targetMin: -0.3,
      targetMax: 0.3,
      message: `Water is ${input.temperature}°F with projected LSI +${projectedLSIResult.lsi.toFixed(2)} — elevated scaling risk at high temperatures. Prioritize pH/TA correction and monitor surfaces for calcium deposits.`,
    });
  }

  // Copper cyanurate warning — CYA > 100 + copper present = purple staining risk (Reddit/TFP forums)
  if (input.cya > 100 && (input.copper ?? 0) > 0) {
    validationWarnings.push({
      parameter: 'CYA + Copper',
      projected: input.cya,
      targetMin: 0,
      targetMax: 100,
      message: `CYA is ${input.cya} ppm with copper at ${input.copper} ppm — risk of copper cyanurate formation (purple staining). Lower CYA below 100 ppm by draining.`,
    });
  }

  // LSI guard warning — if treatment worsens |LSI| or leaves it outside balanced range
  const hasDrainRetest = returnVisitDoses.some(d => d.chemical === 'Retest After Refill');
  if (!hasDrainRetest) {
    const lsiWorsened = Math.abs(projectedLSIResult.lsi) > Math.abs(startingLSI) + 0.05;
    const lsiOutOfRange = Math.abs(projectedLSIResult.lsi) > 0.30;
    if (lsiWorsened || lsiOutOfRange) {
      const reason = lsiWorsened
        ? `further from balanced than starting (${startingLSI >= 0 ? '+' : ''}${startingLSI.toFixed(2)})`
        : `outside balanced range [-0.30, +0.30]`;
      validationWarnings.push({
        parameter: 'LSI',
        projected: projectedLSIResult.lsi,
        targetMin: -0.30,
        targetMax: 0.30,
        message: `Projected LSI (${projectedLSIResult.lsi >= 0 ? '+' : ''}${projectedLSIResult.lsi.toFixed(2)}) is ${reason}. Treatment adjustments were limited by chemistry constraints.`,
      });
    }
  }

  // Drop any return-visit doses that rounded to zero amount (edge case from
  // proportional scaling or tiny volumes). Drain & refill entries use amount=0
  // by design (info is in safetyNote), so exclude them from the filter.
  const filteredRV = returnVisitDoses.filter(
    d => d.amount > 0 || d.chemical === 'Partial Drain & Refill' || d.chemical === 'Retest After Refill'
  );

  // Compute safe-to-swim once, at the same moment as the dosing plan, so every
  // downstream consumer reads the same answer. startTime is captured now; readers
  // that care about wall-clock timing (e.g. customer service emails sent later)
  // should use waitMinutes and the completion timestamp from their own context.
  const safeToSwim = calculateSafeToSwim(doses, input, new Date(), isIndoor);

  return {
    doses,
    returnVisitDoses: filteredRV,
    interactions,
    disclaimer: DISCLAIMER,
    projectedValues: projected,
    projectedLSI: projectedLSIResult.lsi,
    returnVisitProjectedLSI,
    validationWarnings: validationWarnings.length > 0 ? validationWarnings : undefined,
    intermediateStates: finalStates.length > 0 ? finalStates : undefined,
    precipitationWarning,
    readingWarnings: readingWarnings.length > 0 ? readingWarnings : undefined,
    safeToSwim,
    polishSkips: polishSkips.length > 0 ? polishSkips : undefined,
  };
}

// ─── Safe to Swim Calculator ────────────────────────────────────────────────

const MINUTES_BETWEEN_CHEMICALS = 20; // TFP/SU: 15-30 min between chemicals; 20 is consensus midpoint

function getChlorineDegradationRate(hour: number, isIndoor: boolean, cya: number): number {
  // Returns estimated FC loss in ppm per hour.
  // Sources: Nowell & Hoigne 1992 (UV photolysis), TFP OCLT data, Orenda CYA research.
  // Indoor/night rates include oxidation demand only (no UV). Daytime outdoor includes UV.
  if (isIndoor) return 0.05;

  const isSunHours = hour >= 9 && hour < 18;
  if (!isSunHours) return 0.1;

  // Daytime outdoor — CYA protects against UV degradation
  // No CYA: UV half-life ~35-45 min (Nowell & Hoigne). Linearized ~2 ppm/hr at typical FC.
  // CYA 30+: 98% remains after 1 hr UV (Orenda/O'Brien). Total loss ~0.3-0.5 ppm/hr.
  // CYA 50+: even greater protection. Total loss ~0.15-0.25 ppm/hr.
  if (cya < 30) return 2;
  if (cya <= 50) return 0.4;
  return 0.2;
}

const SAFE_FC_THRESHOLD = 4; // ppm — safe to swim below this; CPO/ANSI-11: FC 1-5 ppm acceptable

function hoursUntilFCSafe(
  resultingFC: number,
  startTime: Date,
  isIndoor: boolean,
  cya: number,
): number {
  if (resultingFC <= SAFE_FC_THRESHOLD) return 0;

  let fc = resultingFC;
  let hours = 0;

  while (fc > SAFE_FC_THRESHOLD && hours < 72) {
    const currentHour = new Date(startTime.getTime() + hours * 3600000).getHours();
    const rate = getChlorineDegradationRate(currentHour, isIndoor, cya);
    fc -= rate;
    hours++;
  }

  return hours;
}

export function calculateSafeToSwim(
  doses: ChemicalDose[],
  input: WaterTestInput,
  startTime: Date,
  isIndoor: boolean,
): SafeToSwimResult {
  if (doses.length === 0) {
    return { type: 'none', waitMinutes: 0, safeTime: startTime, reason: '' };
  }

  // Chemical load assessment — count significant adds (exclude maintenance tabs and zero-amount)
  const significantDoses = doses.filter(d => d.amount > 0 && d.parameterName !== 'Maintenance');
  const hasAcid = significantDoses.some(d => d.chemical.toLowerCase().includes('muriatic') || d.chemical.toLowerCase().includes('bisulfate'));
  const hasLargeAdd = significantDoses.some(d =>
    (d.unit === 'lbs' && d.amount >= 10) || (d.unit === 'fl oz' && d.amount >= 64)
  );

  // Minimum circulation floor based on chemical load
  // Small volumes (spas) with tiny doses don't need 4-hour waits
  const isSpa = (input.poolVolume ?? 0) <= 1000;
  const totalLbs = significantDoses.reduce((sum, d) => {
    if (d.unit === 'lbs') return sum + d.amount;
    if (d.unit === 'oz') return sum + d.amount / 16;
    if (d.unit === 'fl oz') return sum + d.amount / 128; // rough weight proxy
    return sum;
  }, 0);

  let minFloorMinutes = 30; // Master Spas, O-Care, TFP: 20-30 min minimum after chemicals
  if (isSpa) {
    // Spa: 30 min base, 60 min if acid (Master Spas: "30-60 min after acid")
    if (hasAcid) minFloorMinutes = 60;
  } else if (hasLargeAdd) {
    // Pool: large add needs extended circulation (~½ turnover); SU: "up to 4 hours for large dose"
    minFloorMinutes = 240;
  } else if (hasAcid) {
    // Pool: acid needs pH stabilization; TFP: 30 min min, SU: "1-2 hours"
    minFloorMinutes = 60;
  }

  // Check if shock (cal-hypo) is in the plan — this is the only chemical
  // that pushes FC high enough to need a calculated wait
  const shockDose = doses.find(d => d.chemical.includes('Calcium Hypochlorite') && d.parameterName === 'Combined Chlorine');

  if (!shockDose) {
    // Use actual per-step waits for spas (5 min default, 10 min for reactive pairs)
    let treatmentMinutes = 0;
    for (let i = 0; i < significantDoses.length - 1; i++) {
      treatmentMinutes += getWaitBetween(significantDoses[i].chemical, significantDoses[i + 1].chemical, isSpa).minutes;
    }
    const totalMinutes = Math.max(treatmentMinutes + 30, minFloorMinutes);
    const safeTime = new Date(startTime.getTime() + totalMinutes * 60000);
    const reason = minFloorMinutes >= 240
      ? 'Large chemical add — full circulation recommended'
      : hasAcid
        ? 'Acid added — allow time for pH to stabilize'
        : 'Standard circulation wait';
    return {
      type: 'simple',
      waitMinutes: totalMinutes,
      safeTime,
      reason,
    };
  }

  // Shock is in the plan — calculate resulting FC and degradation time
  const currentFC = input.freeChlorine ?? 0;
  const combinedChlorine = shockDose.currentValue; // CCL stored in currentValue
  const breakpointFC = combinedChlorine * 10;
  const resultingFC = currentFC + breakpointFC;

  // Shock is added at its position in the sequence
  const shockIndex = significantDoses.indexOf(shockDose);
  let minutesUntilShockAdded = 0;
  for (let i = 0; i < shockIndex; i++) {
    minutesUntilShockAdded += getWaitBetween(significantDoses[i].chemical, significantDoses[i + 1].chemical, isSpa).minutes;
  }
  const shockTime = new Date(startTime.getTime() + minutesUntilShockAdded * 60000);

  // Calculate hours for FC to drop below safe threshold
  const fcWaitHours = hoursUntilFCSafe(resultingFC, shockTime, isIndoor, input.cya);
  const fcWaitMinutes = fcWaitHours * 60;

  // Also calculate when the full treatment sequence ends + 30 min.
  // Sums the actual per-step waits via getWaitBetween — matches the
  // no-shock path above. (Fixes pre-existing `gapMinutes is not defined`
  // crash from an incomplete LSEye refactor — the constant was removed
  // when the no-shock path migrated to per-step waits but this line
  // wasn't updated.)
  let treatmentSequenceMinutes = 0;
  for (let i = 0; i < significantDoses.length - 1; i++) {
    treatmentSequenceMinutes += getWaitBetween(significantDoses[i].chemical, significantDoses[i + 1].chemical, isSpa).minutes;
  }
  const treatmentEndMinutes = treatmentSequenceMinutes + 30;

  // Safe time is whichever is later: FC dropping below 5, treatment end + 30 min, or chemical load floor
  const fcSafeTime = new Date(shockTime.getTime() + fcWaitMinutes * 60000);
  const treatmentSafeTime = new Date(startTime.getTime() + treatmentEndMinutes * 60000);
  const floorSafeTime = new Date(startTime.getTime() + minFloorMinutes * 60000);

  let safeTime = fcSafeTime > treatmentSafeTime ? fcSafeTime : treatmentSafeTime;
  if (floorSafeTime > safeTime) safeTime = floorSafeTime;
  const totalMinutes = Math.round((safeTime.getTime() - startTime.getTime()) / 60000);

  return {
    type: 'calculated',
    waitMinutes: totalMinutes,
    safeTime,
    reason: `Shock raises FC to ~${Math.round(resultingFC)} ppm — waiting for FC to drop below ${SAFE_FC_THRESHOLD} ppm`,
  };
}
