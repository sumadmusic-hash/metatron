# METATRON LIVE INSTRUMENT IMPORT CAPABILITY TEST (PHASE D)

The task of **Phase D**:

> Can an `InstrumentPreset v0.1` created from a REAL SOURCE project with the
> productive Phase-B exporter (`src/core/instrument/InstrumentPresetExport.ts`)
> be imported into a SECOND real TARGET project with the Phase-C engine
> (`src/core/instrument/InstrumentPresetImport.ts`) so that chain, current
> parameter values, topology and Metatron bindings are correctly resolved onto
> the NEW target entities — and independently read back as equal?

Exactly **one** answer is produced:

```
INSTRUMENT IMPORT: PASS      — real OAuth + real SOURCE + real TARGET + real
                               mutation + chain/topology/bindings/preset verified + read-back
INSTRUMENT IMPORT: PARTIAL   — mutation ran, but ≥1 required check/probe is off
INSTRUMENT IMPORT: BLOCKED   — OAuth/project missing, capability missing, or the
                               engine refused (never PASS)
```

No PASS without a real TARGET mutation and an independent read-back. The POC
lives entirely under `poc/instrument-preset-live/`; no productive `src/` file is
modified (the Phase-C import engine is USED, not changed).

---

## Status (honest)

- **Implemented + offline-gated:** browser harness, pure report/verdict layer and
  unit tests. Gates after Phase D:
  `npm test` → **348 passed**, `npx tsc --noEmit` → clean, `npm run build` → OK.
  The machine verdict rules (`report.ts`) are unit-tested — PASS can never be
  claimed without an executed mutation.
- **Live run: NOT executed in this repository session** — a real run requires a
  browser with an OAuth session for a real Audiotool account and real projects.
  The harness (page below) performs the run when the user presses
  `IMPORT INSTRUMENT PRESET`. Until that happens, the documented state is
  "harness ready, live verdict pending", and **no PASS is claimed**.

---

## Run

```bash
npm run dev
# open http://127.0.0.1:5175/poc/instrument-preset-live/
```

1. **CONNECT** (OAuth popup, scope `project:write`).
2. **OPEN SOURCE** — paste the real SOURCE project URL
   (reuse the proven chain from `poc/chain-clone-live/README.md`:
   `https://www.audiotool.com/studio?project=38e6b0b9-1888-4148-9f3b-c8e86510f140` —
   chain `pulverisateur → stompboxChorus → stompboxFlanger → mixerChannel`,
   or any other real project), then select the root device.
3. **DISCOVER + EXPORT PRESET** — read-only: snapshot the real SOURCE chain,
   select a representative set of REAL control fields (one float-linear, one
   integer-linear, one boolean, plus a second float-linear on a different device
   — proving cross-device binding + idMap), and export via Phase B. The
   emitted envelope + capability gate are shown. **No mutation**.
4. **OPEN TARGET** — paste the real TARGET project URL; TARGET BEFORE is read.
5. **IMPORT INSTRUMENT PRESET** — the ONLY mutation step. Runs the Phase-C
   engine (clone → parameter writes → cables → idMap → bindings → preset
   values → verification), then §9 mapping probes on the real target, then the
   final §20 report + source→target id map.

Build / verify locally:

```bash
npm run build
npm test
```

`vite.config.ts` `input` and `tsconfig.json` `include` were extended additively
with `poc/instrument-preset-live`.

---

## Flow

```
REAL SOURCE PROJECT → SOURCE DISCOVERY → InstrumentPreset EXPORT (Phase B)
→ CAPABILITY GATE → REAL TARGET PROJECT → TARGET BEFORE → USER CONFIRMATION
→ INSTRUMENT PRESET IMPORT (Phase C: chain clone / id mapping / binding
  resolution / preset application) → TARGET RE-DISCOVERY → READ-BACK
  VERIFICATION → FINAL VERDICT
```

`sourceEntityIndex` stays the logical identity (index in
`preset.chain.snapshot.devices`); bindings resolve via
`idMap: sourceEntityIndex → sourceEntityId → targetEntityId`. There is no
`find device by name`, no source-id reuse as target-id (§7).

---

## §15 honesty guards (`report.ts`, unit-tested)

- environment failure (OAuth / project / network / thrown before a result)
  → `BLOCKED (ENVIRONMENT)`.
- missing required capability or Phase-B refusal on real SOURCE data
  → `BLOCKED (CAPABILITY)`.
- engine answers `CHAIN CLONE: NOT POSSIBLE WITH CURRENT NEXUS API`
  → `BLOCKED (CAPABILITY)`.
- PASS requires: real mutation executed **and** engine `ok` **and**
  chain/topology/bindings/preset checks all true **and** every §9 mapping probe
  passes.
- mutation ran but a check failed → `PARTIAL`.
- no mutation executed → `PARTIAL` ("never PASS").

---

## §9 mapping probes

For every applied binding the harness probes the real TARGET field with the
stored `valueMapping` and reads it back (`mapNexusToNormalized`):

- linear float → `0.0`, `0.5`, `1.0`
- linear integer → `0.0`, `1.0` (0.5 is not representable on an integral field)
- boolean → `0.0`, `1.0`

Probe writes are real Nexus mutations, read back immediately, and the applied
preset value is restored afterwards (restore is verified too). These probes are
clearly labeled as TARGET-side range-proofs — they are never inserted into the
envelope as SOURCE data.

---

## Files

```
poc/instrument-preset-live/
├── index.html          UI page (served by vite)
├── main.ts             phase orchestration + OAuth + real project handling +
│                       control selection + §9 mapping probes
├── report.ts           pure §20 report builder + §15 verdict rules + probe schedule
├── report.test.ts      unit tests for verdict honesty and report layout
└── README.md
```

Reuses (read-only / non-invasive):
- `../chain-clone-live/report.ts` → `assessRequiredCapabilities` (§3 gate)
- `../chain-clone` → snapshot, clone engine, `KNOWN_CREATABLE_TYPES`, planning,
  verify
- `../chain-discovery` → live read layer
- `src/core/instrument/InstrumentPresetExport|Import`, `src/core/BindingManager`,
  `src/nexus/NexusValueMapping`, `src/core/model/Device|Control|Preset`
  (used, never modified)