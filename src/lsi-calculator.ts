// ─── Types ───────────────────────────────────────────────────────────────────

export interface WaterTestInput {
  pH: number;
  temperature: number; // Fahrenheit
  calciumHardness: number; // ppm
  totalAlkalinity: number; // ppm
  tds: number; // ppm
  cya: number; // ppm
  freeChlorine?: number; // ppm
  totalChlorine?: number; // ppm
  bromine?: number; // ppm
  copper?: number; // ppm
  iron?: number; // ppm
  phosphates?: number; // ppb
  salt?: number; // ppm
  poolVolume?: number; // gallons
}

export interface LSIFactors {
  temperatureFactor: number;
  calciumFactor: number;
  alkalinityFactor: number;
  tdsFactor: number;
  carbonateAlkalinity: number;
  cyaCorrectionFactor: number;
  pHs: number;
}

export type LSIStatus = 'scale-forming' | 'ideal' | 'acceptable' | 'corrosive';

export interface LSIResult {
  lsi: number;
  pHs: number;
  factors: LSIFactors;
  status: LSIStatus;
  statusColor: 'purple' | 'green' | 'yellow' | 'red';
  statusLabel: string;
  statusDescription: string;
}

export type LSICalculationMethod = 'table' | 'formula';

// ─── Factor Lookup Tables ────────────────────────────────────────────────────
// Source: CPO Handbook Appendix B-5 (p. 262), PHTA Water Balance fact sheets
// Each table is [inputValue, factor] pairs, sorted ascending by inputValue.

const TEMP_TABLE: [number, number][] = [ // CPO Handbook Table B-5: Temperature Factor
  [32, 0.0],
  [37, 0.1],
  [46, 0.2],
  [53, 0.3],
  [60, 0.4],
  [66, 0.5],
  [76, 0.6],
  [84, 0.7],
  [94, 0.8],
  [105, 0.9],
  [128, 1.0],
];

const CALCIUM_TABLE: [number, number][] = [ // CPO Handbook Table B-5: Calcium Hardness Factor
  [5, 0.3],
  [25, 1.0],
  [50, 1.3],
  [75, 1.5],
  [100, 1.6],
  [125, 1.7],
  [150, 1.8],
  [200, 1.9],
  [250, 2.0],
  [300, 2.1],
  [400, 2.2],
  [600, 2.4],
  [800, 2.5],
  [1000, 2.6],
];

const ALK_TABLE: [number, number][] = [ // CPO Handbook Table B-5: Alkalinity Factor
  [5, 0.7],
  [25, 1.4],
  [50, 1.7],
  [75, 1.9],
  [100, 2.0],
  [125, 2.1],
  [150, 2.2],
  [200, 2.3],
  [250, 2.4],
  [300, 2.5],
  [400, 2.6],
  [600, 2.8],
  [800, 2.9],
  [1000, 3.0],
];

const TDS_TABLE: [number, number][] = [ // CPO Handbook Table B-5: TDS Correction Factor
  [0, 12.1],
  [1000, 12.19],
  [2000, 12.29],
  [3000, 12.35],
  [4000, 12.41],
  [5000, 12.44],
];

// CYA correction factor by pH — how much of each ppm of CYA to subtract from TA
// Source: Wojtowicz cyanurate alkalinity table (confirmed by TFP / Richard Falk,
// and derivable from CYA pKa1 = 6.88 via: fraction_ionized × 50/129.07)
const CYA_CORRECTION_TABLE: [number, number][] = [
  [6.0, 0.04],
  [6.2, 0.06],
  [6.5, 0.10],
  [6.8, 0.16],
  [7.0, 0.23],
  [7.2, 0.27],
  [7.4, 0.31],
  [7.6, 0.33],
  [7.8, 0.35],
  [8.0, 0.36],
  [8.2, 0.37],
];

// ─── Interpolation ──────────────────────────────────────────────────────────

export function interpolate(value: number, table: [number, number][]): number {
  if (value <= table[0][0]) return table[0][1];
  if (value >= table[table.length - 1][0]) return table[table.length - 1][1];

  for (let i = 0; i < table.length - 1; i++) {
    if (value >= table[i][0] && value <= table[i + 1][0]) {
      const ratio =
        (value - table[i][0]) / (table[i + 1][0] - table[i][0]);
      return table[i][1] + ratio * (table[i + 1][1] - table[i][1]);
    }
  }
  return table[table.length - 1][1];
}

// ─── CYA Correction ─────────────────────────────────────────────────────────

export function getCyaCorrectionFactor(pH: number): number {
  return interpolate(pH, CYA_CORRECTION_TABLE);
}

export function getCarbonateAlkalinity(
  totalAlkalinity: number,
  cya: number,
  pH: number
): number {
  const factor = getCyaCorrectionFactor(pH);
  return Math.max(0, totalAlkalinity - cya * factor);
}

// ─── LSI Status Classification ──────────────────────────────────────────────

// Source: Orenda color classification (purple/green/yellow/red)
// Thresholds: +0.31 scale-forming (Orenda), -0.3 to +0.3 balanced (APSP-11/Orenda), <-0.7 corrosive
export function classifyLSI(lsi: number): Pick<
  LSIResult,
  'status' | 'statusColor' | 'statusLabel' | 'statusDescription'
> {
  if (lsi >= 0.31) { // Orenda: >+0.30 begins precipitating CaCO3
    return {
      status: 'scale-forming',
      statusColor: 'purple',
      statusLabel: 'Scale-Forming',
      statusDescription:
        'Over-saturated with calcium carbonate. Risk of scale deposits on surfaces and equipment.',
    };
  }
  if (lsi >= -0.3) {
    return {
      status: 'ideal',
      statusColor: 'green',
      statusLabel: 'Balanced',
      statusDescription:
        'Water is properly saturated. This is the target range (−0.30 to +0.30).',
    };
  }
  if (lsi >= -0.7) {
    return {
      status: 'acceptable',
      statusColor: 'yellow',
      statusLabel: 'Slightly Corrosive',
      statusDescription:
        'Under-saturated. Adjust chemistry to prevent surface and equipment damage.',
    };
  }
  return {
    status: 'corrosive',
    statusColor: 'red',
    statusLabel: 'Corrosive',
    statusDescription:
      'Aggressive water — will etch plaster, corrode equipment, and fade surfaces. Correct immediately.',
  };
}

// ─── Method 1: Table Interpolation ──────────────────────────────────────────

function calculateLSI_table(input: WaterTestInput): LSIResult {
  const { pH, temperature, calciumHardness, totalAlkalinity, tds, cya } = input;

  const cyaCorrectionFactor = getCyaCorrectionFactor(pH);
  const carbonateAlkalinity = getCarbonateAlkalinity(totalAlkalinity, cya, pH);

  const TF = interpolate(temperature, TEMP_TABLE);
  const CF = interpolate(calciumHardness, CALCIUM_TABLE);
  const AF = interpolate(carbonateAlkalinity, ALK_TABLE);
  const TDSF = interpolate(tds, TDS_TABLE);

  const pHs = TDSF - TF - CF - AF;
  const lsi = pH - pHs;
  const rounded = Math.round(lsi * 100) / 100;

  return {
    lsi: rounded,
    pHs: Math.round(pHs * 100) / 100,
    factors: {
      temperatureFactor: Math.round(TF * 1000) / 1000,
      calciumFactor: Math.round(CF * 1000) / 1000,
      alkalinityFactor: Math.round(AF * 1000) / 1000,
      tdsFactor: Math.round(TDSF * 1000) / 1000,
      carbonateAlkalinity: Math.round(carbonateAlkalinity * 10) / 10,
      cyaCorrectionFactor: Math.round(cyaCorrectionFactor * 1000) / 1000,
      pHs: Math.round(pHs * 100) / 100,
    },
    ...classifyLSI(rounded),
  };
}

// ─── Method 2: Precise Mathematical Formula (Langelier 1936) ─────────────────
// pHs = (9.3 + A + B) - (C + D)
// where A = (log10(TDS) - 1) / 10, B = -13.12 * log10(tempK) + 34.55,
//       C = log10(CH) - 0.4, D = log10(CA)
// Source: Langelier Saturation Index, CPO Handbook pp. 68-70

function calculateLSI_formula(input: WaterTestInput): LSIResult {
  const { pH, temperature, calciumHardness, totalAlkalinity, tds, cya } = input;

  const cyaCorrectionFactor = getCyaCorrectionFactor(pH);
  const carbonateAlkalinity = getCarbonateAlkalinity(totalAlkalinity, cya, pH);

  const tempC = (temperature - 32) * (5 / 9);
  const tempK = tempC + 273.15;

  // Clamp inputs to avoid log(0) issues
  const safeTDS = Math.max(1, tds);
  const safeCH = Math.max(1, calciumHardness);
  const safeCA = Math.max(1, carbonateAlkalinity);

  const A = (Math.log10(safeTDS) - 1) / 10;
  const B = -13.12 * Math.log10(tempK) + 34.55;
  const C = Math.log10(safeCH) - 0.4;
  const D = Math.log10(safeCA);

  const pHs = (9.3 + A + B) - (C + D);
  const lsi = pH - pHs;
  const rounded = Math.round(lsi * 100) / 100;

  return {
    lsi: rounded,
    pHs: Math.round(pHs * 100) / 100,
    factors: {
      temperatureFactor: Math.round(B * 1000) / 1000,
      calciumFactor: Math.round(C * 1000) / 1000,
      alkalinityFactor: Math.round(D * 1000) / 1000,
      tdsFactor: Math.round(A * 1000) / 1000,
      carbonateAlkalinity: Math.round(carbonateAlkalinity * 10) / 10,
      cyaCorrectionFactor: Math.round(cyaCorrectionFactor * 1000) / 1000,
      pHs: Math.round(pHs * 100) / 100,
    },
    ...classifyLSI(rounded),
  };
}

// ─── Method 3: Franchise Simplified (no CYA correction, TDS = 12.1) ────────
// This matches the standard Puddle Pools / Orenda franchise tool.
// Uses raw Total Alkalinity (no CYA correction) and a fixed TDS factor of 12.1.

function calculateLSI_franchise(input: WaterTestInput): LSIResult {
  const { pH, temperature, calciumHardness, totalAlkalinity } = input;

  const TF = interpolate(temperature, TEMP_TABLE);
  const CF = interpolate(calciumHardness, CALCIUM_TABLE);
  const AF = interpolate(totalAlkalinity, ALK_TABLE); // raw TA, no CYA correction
  const TDSF = 12.1; // Orenda franchise simplified: fixed TDS factor (assumes ~0 TDS)

  const pHs = TDSF - TF - CF - AF;
  const lsi = pH - pHs;
  const rounded = Math.round(lsi * 100) / 100;

  return {
    lsi: rounded,
    pHs: Math.round(pHs * 100) / 100,
    factors: {
      temperatureFactor: Math.round(TF * 1000) / 1000,
      calciumFactor: Math.round(CF * 1000) / 1000,
      alkalinityFactor: Math.round(AF * 1000) / 1000,
      tdsFactor: TDSF,
      carbonateAlkalinity: totalAlkalinity, // no correction applied
      cyaCorrectionFactor: 0,
      pHs: Math.round(pHs * 100) / 100,
    },
    ...classifyLSI(rounded),
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function calculateLSI(
  input: WaterTestInput,
  method: LSICalculationMethod = 'formula'
): LSIResult {
  return method === 'table'
    ? calculateLSI_table(input)
    : calculateLSI_formula(input);
}

export function calculateFranchiseLSI(input: WaterTestInput): LSIResult {
  return calculateLSI_franchise(input);
}

export function calculateBothMethods(
  input: WaterTestInput
): { table: LSIResult; formula: LSIResult; franchise: LSIResult } {
  return {
    table: calculateLSI_table(input),
    formula: calculateLSI_formula(input),
    franchise: calculateLSI_franchise(input),
  };
}
