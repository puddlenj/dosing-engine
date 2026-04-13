# puddle-dosing-engine

Canonical pool/spa water chemistry engine. LSI calculation, target profiles, treatment plans, safe-to-swim. Used by [LSEye](https://lseye.com) and [puddlenj.com](https://puddlenj.com).

## The rule

**There is exactly one dosing engine, and it lives here.** If you find yourself writing dosing math, LSI math, or chemistry-target logic in any other repo, stop and import from this package instead.

No local copies. No "temporary" duplicates. No "mirror for the edge function." The reason: when the engine evolved in LSEye but the edge-function mirror didn't, `/checklist` started recommending acid doses 50–150% higher than the real engine said. One source of truth.

## Consumers

| Repo | How it imports |
|---|---|
| LSEye browser app | npm dep `github:puddlenj/dosing-engine#main`, `import { calculateDosing } from 'puddle-dosing-engine'` |
| puddlenj browser app (`/checklist`) | same as above |
| puddlenj Supabase edge function (`chemistry-engine`) | `import { calculateDosing } from 'https://esm.sh/gh/puddlenj/dosing-engine@main/src/index.ts'` — esm.sh compiles TS on its CDN |

## What's inside

- `src/dosing-engine.ts` — the full treatment-plan engine. Includes the Knorr cumulative acid lookup table, intermediate-state walking, return-visit doses, safe-to-swim calculation.
- `src/lsi-calculator.ts` — Langelier Saturation Index (formula + franchise method), CYA correction, carbonate alkalinity.
- `src/chemistry-targets.ts` — target profiles by pool type, surface, salt, spa, bromine.
- `src/index.ts` — barrel.

## Updating

Any change to the engine ships from this repo. Both LSEye and puddlenj pull via their package-lock — bump the pinned ref on both sides in the same session, redeploy.
