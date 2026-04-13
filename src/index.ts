// Canonical entry point — every consumer (LSEye, puddlenj browser, puddlenj
// edge function) imports from here. There is no other copy of this engine.
// See README.md for the rule.

export * from './dosing-engine';
export * from './lsi-calculator';
export * from './chemistry-targets';
