import type { DosingTarget } from './dosing-engine';

// ─── Types ───────────────────────────────────────────────────────────────────

export type SurfaceType = 'plaster' | 'vinyl' | 'fiberglass';

// ─── Shared ranges (same across all profiles) ───────────────────────────────
// Sources: CPO Handbook, ANSI/APSP-11 2019, TFP, Orenda

const SHARED = {
  pH: { min: 7.4, max: 7.6, ideal: 7.5 },      // CPO/APSP-11: 7.2-7.8; TFP/Orenda: 7.4-7.6 ideal
  bromine: { min: 3, max: 5, ideal: 4 },         // ANSI/APSP-11: 3-5 ppm for spas; SU Hot Tub Handbook
  combinedChlorine: { max: 0.4 },                // ANSI/APSP-11 2019: max 0.4 ppm (unified pools+spas)
  copper: { max: 0.2 },                          // Conservative; TFP staining threshold 0.3 ppm
  iron: { max: 0.2 },                            // Conservative; TFP staining threshold 0.3 ppm
};

// ─── Pool Profiles (CPO Handbook / TFP / Swim University consensus) ──────────

export const POOL_VINYL: DosingTarget = {
  ...SHARED,
  alkalinity: { min: 80, max: 120, ideal: 100 },     // CPO: 80-120; TFP: 60-80 for SWG, 80-120 otherwise
  calciumHardness: { min: 150, max: 300, ideal: 200 },// CPO: 200-400; vinyl needs less (no plaster erosion)
  cya: { min: 30, max: 50, ideal: 30 },               // TFP: 30-50 non-SWG; SU: 30-50; CPO: 30-50
  freeChlorine: { min: 2, max: 4, ideal: 3 },         // SU: 1-3 (3 ideal); CPO: 1-4; we use 2-4 (conservative)
  phosphates: { max: 500 },                           // Orenda: 500 ppb threshold; TFP: 1000 ppb
  salt: { min: 2700, max: 3400, ideal: 3200 },        // SWG manufacturer specs (Hayward/Pentair: 2700-3400)
};

export const POOL_PLASTER: DosingTarget = {
  ...POOL_VINYL,
  calciumHardness: { min: 200, max: 400, ideal: 275 }, // CPO: 200-400; plaster needs higher CH to prevent erosion
};

export const POOL_FIBERGLASS: DosingTarget = {
  ...POOL_VINYL,
  calciumHardness: { min: 150, max: 250, ideal: 175 }, // Fiberglass: high CH damages gelcoat (Reddit/industry forums)
};

export const POOL_SALT: DosingTarget = {
  ...POOL_VINYL,
  alkalinity: { min: 60, max: 80, ideal: 70 },         // TFP/PCTI: lower TA reduces pH bounce from SWG NaOH
  calciumHardness: { min: 200, max: 400, ideal: 300 },  // CPO: 200-400; salt cell calcification risk at >400
  cya: { min: 30, max: 50, ideal: 30 },                 // TFP: 60-90 for SWG; we use 30-50 (Orenda/field pref)
  salt: { min: 2700, max: 3400, ideal: 3200 },          // Hayward/Pentair SWG manufacturer specs
};

// ─── Spa Profiles (CPO Handbook / ANSI-11 2019 / Swim University) ────────────

export const SPA_STANDARD: DosingTarget = {
  ...SHARED,
  alkalinity: { min: 80, max: 120, ideal: 100 },       // CPO/APSP-11: 80-120 for spas
  calciumHardness: { min: 150, max: 250, ideal: 175 },  // CPO: 150-250 for spas (lower than pools)
  cya: { min: 30, max: 50, ideal: 30 },                 // SU Hot Tub Handbook; dichlor adds CYA quickly
  freeChlorine: { min: 3, max: 5, ideal: 3 },           // ANSI/APSP-11: 3-5 ppm for spas
  bromine: { min: 4, max: 6, ideal: 5 },                // ANSI/APSP-11: 4-6 ppm bromine for spas
  phosphates: { max: 500 },                             // Orenda: 500 ppb threshold
  salt: { min: 2700, max: 3400, ideal: 3200 },          // SWG manufacturer specs (if salt spa with standard cell)
};

export const SPA_SALT: DosingTarget = {
  ...SPA_STANDARD,
  calciumHardness: { min: 150, max: 250, ideal: 175 },   // Same as SPA_STANDARD — salt cell scaling risk is at 400+, not 75+
  phosphates: { max: 300 },                             // SU Hot Tub Handbook: <300 ppb for salt spas
  salt: { min: 1500, max: 2500, ideal: 2000 },          // SU Hot Tub Handbook: 1500-2500 ppm salt spas
};

// ─── Target Builder ──────────────────────────────────────────────────────────

export function buildTargets(
  isSpa: boolean,
  surfaceType: SurfaceType,
  isSaltSystem: boolean,
): DosingTarget {
  if (isSpa) return isSaltSystem ? SPA_SALT : SPA_STANDARD;

  // Base profile for surface type
  const base = surfaceType === 'fiberglass' ? POOL_FIBERGLASS
    : surfaceType === 'vinyl' ? POOL_VINYL
    : POOL_PLASTER;

  // Salt system: overlay TA, CYA, and salt targets onto the surface base
  // This preserves fiberglass's low CH while applying salt-specific ranges
  if (isSaltSystem) {
    return {
      ...base,
      alkalinity: POOL_SALT.alkalinity,
      cya: POOL_SALT.cya,
      salt: POOL_SALT.salt,
    };
  }

  return base;
}

// ─── Display Data for Reference Page ─────────────────────────────────────────

export interface TargetDisplay {
  parameter: string;
  unit: string;
  min?: number;
  max?: number;
  ideal?: number;
  maxOnly?: number;
  note: string;
}

export function getDisplayTargets(
  isSpa: boolean,
  surfaceType: SurfaceType,
  isSaltSystem: boolean,
): TargetDisplay[] {
  const t = buildTargets(isSpa, surfaceType, isSaltSystem);
  const targets: TargetDisplay[] = [
    {
      parameter: 'pH',
      unit: '',
      min: t.pH.min,
      max: t.pH.max,
      ideal: t.pH.ideal,
      note: 'Adjust after alkalinity is balanced. High pH inhibits sanitizer.',
    },
    {
      parameter: 'Total Alkalinity',
      unit: 'ppm',
      min: t.alkalinity.min,
      max: t.alkalinity.max,
      ideal: t.alkalinity.ideal,
      note: isSpa
        ? 'Acts as pH buffer. Adjust first before pH.'
        : isSaltSystem
          ? 'SWG electrolysis produces NaOH, constantly raising pH. Lower TA reduces pH bounce and acid demand.'
          : 'Acts as pH buffer. Adjust first before any other chemical.',
    },
    {
      parameter: 'Calcium Hardness',
      unit: 'ppm',
      min: t.calciumHardness.min,
      max: t.calciumHardness.max,
      ideal: t.calciumHardness.ideal,
      note: isSpa && isSaltSystem
        ? 'Salt spa cells are sensitive to calcium — keep very low.'
        : isSpa
          ? 'Low calcium corrodes equipment. High causes scaling on jets and heater.'
          : surfaceType === 'fiberglass'
            ? 'Fiberglass gelcoat is damaged by high calcium — keep very low. High CH causes scaling and chalking on gelcoat surfaces.'
            : isSaltSystem
              ? 'High calcium causes salt cell calcification. Monitor monthly.'
              : surfaceType === 'plaster'
                ? 'Plaster/concrete needs higher calcium to prevent surface erosion.'
                : 'Vinyl needs less calcium than plaster.',
    },
    {
      parameter: 'CYA (Stabilizer)',
      unit: 'ppm',
      min: t.cya.min,
      max: t.cya.max,
      ideal: t.cya.ideal,
      note: isSpa
        ? 'Dichlor adds CYA over time. Only way to lower is drain/refill.'
        : isSaltSystem
          ? 'Salt cells produce chlorine continuously — no need for extra CYA. FC should be 5% of CYA.'
          : 'Protects chlorine from UV. FC should be 7.5% of CYA.',
    },
  ];

  // Sanitizer — chlorine
  targets.push({
    parameter: 'Free Chlorine',
    unit: 'ppm',
    min: t.freeChlorine.min,
    max: t.freeChlorine.max,
    ideal: t.freeChlorine.ideal,
    note: isSpa
      ? 'Hot water causes faster chlorine loss. Test before each use.'
      : isSaltSystem
        ? 'SWG pools: FC minimum is 5% of CYA (continuous chlorine production).'
        : 'FC should be at least 7.5% of CYA for effective sanitization.',
  });

  // Bromine
  targets.push({
    parameter: 'Bromine',
    unit: 'ppm',
    min: t.bromine.min,
    max: t.bromine.max,
    ideal: t.bromine.ideal,
    note: isSpa
      ? 'More stable in hot water than chlorine. No CYA needed.'
      : 'Alternative to chlorine. More stable at higher temps. No CYA needed.',
  });

  // Combined chlorine
  targets.push({
    parameter: 'Combined Chlorine',
    unit: 'ppm',
    maxOnly: t.combinedChlorine.max,
    note: 'Causes "chlorine smell" and irritation. Shock if above 0.4 ppm.',
  });

  // Salt — only for salt systems
  if (isSaltSystem) {
    targets.push({
      parameter: 'Salt',
      unit: 'ppm',
      min: t.salt.min,
      max: t.salt.max,
      ideal: t.salt.ideal,
      note: isSpa
        ? 'Check manufacturer specs — range varies by model.'
        : 'Salt does not evaporate. Gets diluted by rain or water additions.',
    });
  }

  // Phosphates
  if (isSpa && isSaltSystem) {
    targets.push({
      parameter: 'Phosphates',
      unit: 'ppb',
      maxOnly: t.phosphates.max,
      note: 'High phosphates affect salt system performance. Use remover if above 300.',
    });
  }

  // Metals
  targets.push({
    parameter: 'Copper',
    unit: 'ppm',
    maxOnly: t.copper.max,
    note: 'Causes blue-green stains. Test source water, especially well water.',
  });

  targets.push({
    parameter: 'Iron',
    unit: 'ppm',
    maxOnly: t.iron.max,
    note: 'Causes brown-rust stains. Use metal sequestrant if present.',
  });

  return targets;
}

// ─── Profile Label ───────────────────────────────────────────────────────────

export function getProfileLabel(
  isSpa: boolean,
  surfaceType: SurfaceType,
  isSaltSystem: boolean,
): string {
  const type = isSpa ? 'Spa' : 'Pool';
  const surface = isSpa ? ''
    : surfaceType === 'plaster' ? ' — Plaster'
    : surfaceType === 'fiberglass' ? ' — Fiberglass'
    : ' — Vinyl';
  const salt = isSaltSystem ? ' — Salt Water' : '';
  return `${type}${surface}${salt}`;
}
