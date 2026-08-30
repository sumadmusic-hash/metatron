# METATRON CHAIN CLONE POC

**Writable Proof of Concept (contract: `CHAIN CLONE: PASS`):** reconstruct an
Audiotool device / FX chain (`Synth → Effect 1 → Effect 2 → …`) **including
current parameter values and audio cables** in a **second** (target) project,
using the real `@audiotool/nexus` (v0.0.17) library.

```
SOURCE project (READ-ONLY)
      ↓  chain-discovery (live layer, unchanged semantics)
Snapshot (devices · current parameter values · cables)
      ↓  planning (pure, schema-driven)
ClonePlan for TARGET project
      ↓  live writes (create devices → parameters → cables → verify)
TARGET project (CLONE payload)
      ↓
CHAIN CLONE: PASS / PARTIAL / NOT POSSIBLE
```

Answer to the question "can the Nexus 0.0.17 API restore a discovered chain?":
**YES for devices, current parameter values and audio cables — but only via
clientside reconstruction, never by cloning the chain in one API call** (§16
capability table in `api-capabilities.ts`).

The SOURCE document is **never** mutated. The TARGET document is mutated only
when the user presses CLONE CHAIN.

---

## Run

```bash
npm run dev
# open http://127.0.0.1:5175/poc/chain-clone/
```

Build / verify (same commands as the discovery POC):

```bash
npx vite build
npx tsc --noEmit
npm test
```

The POC source is type-checked with `src/` (added to `tsconfig.json`
`include`); the `vite.config.ts` `input` entry is additive.

---

## Authentication (OAuth)

Identical to the chain-discovery POC: `CONNECT` opens an OAuth popup via
`audiotoolPopup()`, on load `audiotool()` detects a stored session. Both POCs
share the same `VITE_AUDIOTOOL_CLIENT_ID` / dev fallback and the same
origin-scoped `localStorage` token store.

- Popup requires the **origin** registered as redirect origin for the client.
- A blocked/denied popup is reported as `ENVIRONMENTAL BLOCK`, never as a
  clone result.

---

## Provenance rules

Same tags as the discovery POC (`PROVEN BY REAL NEXUS`, `PROVEN BY OFFLINE
TEST`, `ASSUMED`, `NOT AVAILABLE`, `ENVIRONMENTAL BLOCK`).

The live TARGET mutation layer (`clone.ts`) only uses APIs proven by offline
tests against the real SDK:

| API | Purpose | Provenance |
| --- | --- | --- |
| `doc.modify(cb)` + `t.create` / `t.tryUpdate` | write inside transaction | `PROVEN BY OFFLINE TEST` (real SDK v0.0.17) |
| `t.create("desktopAudioCable", { fromSocket, toSocket })` | audio cable with `NexusLocation` | `PROVEN BY OFFLINE TEST` |
| `createDefaultEntityMessage` / `entityDefaultsMap` | creatable entity types (pulverisateur, stompboxCompressor/Reverb/Delay, audioDevice) | `PROVEN BY OFFLINE TEST` |
| `getSchemaLocationDetails(field.location)` | range / scalar type / immutable / default | `PROVEN BY OFFLINE TEST` |
| `tryUpdate(field, value)` range error → string return (value unchanged) | parameter restore semantics | `PROVEN BY OFFLINE TEST` |
| Chain-direct clone (one call) | does not exist in 0.0.17 | `NOT AVAILABLE` |

"Clone a whole chain" in one API call is **NOT AVAILABLE** in Nexus 0.0.17;
the only path is clientside reconstruction with the transaction builder.

---

## How the clone works

1. **Snapshot** (`snapshot.ts`) — reads the SOURCE via the chained-discovery
   live layer: device order from chain traversal, per-device current values of
   every `AutomatableParameter` field (schema target types, live values), and
   every `desktopAudioCable` (`fromSocket`/`toSocket` + owning sockets).
2. **Planning** (`planning.ts`, pure + unit-tested) — decides per field based
   on the **TARGET** schema:
   - `clamp` if target range is broader/narrower than the source value,
   - `integer round` if the target scalar type is integral,
   - `useDefault`/`missingField` if absent on target,
   - `skipImmutable`, `typeMismatch`, `unsupported` otherwise.
   No name heuristics, no guessed ranges — everything schema-driven.
3. **Clone** (`clone.ts`) — on the TARGET document:
   - `createDevicesInDoc` (transaction), builds Source→Target ID map
     (source IDs never reused as target IDs),
   - `restoreParametersInDoc` via `tryUpdate` (errors become FailureRecords,
     transaction stays consistent),
   - `createConnectionsInDoc` from translated paths (`audioOutput`→`audioInput`,
     fan-out correct),
   - then re-verification via the chained-discovery layer on TARGET:
     devices / parameters / connections / topology equal → **PASS**.
4. **Verdict** — `entity creation failed` → `NOT POSSIBLE WITH CURRENT NEXUS
   API`; otherwise `PASS` when every plan step verifies, else `PARTIAL`.

Float32 tolerance: relative 1e-5, absolute floor 0.01 (values are stored
as float32 in Nexus).

---

## §10 report

`buildCloneReport` produces:

- `sections`: ENTITY CREATION / PARAMETER RESTORE / CURRENT VALUES /
  CONNECTION CREATION / TOPOLOGY RESTORE / VERIFICATION — each with a verdict
  and detail array,
- `supportedEntityTypes` / `unsupportedEntityTypes` (offset-only or
  no-defaults types are reported, never guessed),
- `nexusApiLimitations` (e.g. "no chain-clone API, clientside reconstruction
  required", "immutable parameter fields skipped", "entity type X has no
  defaults"),
- `finalVerdict`.

A live run requires OAuth + two real projects. Without a working OAuth the UI
reports `LIVE TEST: ENVIRONMENTAL BLOCK` — this is never counted as PASS.

---

## Files

```
poc/chain-clone/
├── index.html            UI page (served by vite)
├── main.ts               UI wiring + OAuth + SOURCE/TARGET project handling
├── types.ts              snapshots, ClonePlan, CloneReport, verdicts, id map
├── snapshot.ts           read SOURCE chain → ChainSnapshot (+ serialization)
├── planning.ts           pure, schema-driven plan (clamp/round/skipImmutable…)
├── verify.ts             float32-tolerant snapshot vs target comparison
├── clone.ts              live TARGET writes (devices → parameters → cables → verify)
├── api-capabilities.ts   §16 capability table with proof rows
├── clone.test.ts         pure unit tests (35) — mocks only
├── clone.offline.test.ts real SDK v0.0.17 offline fixtures (A→B, A→B→C, fan-out, tryUpdate ranges, immutable)
└── README.md
```

Reuses (read-only) from `../chain-discovery/` (`live.ts`, `discovery.ts`).
The productive Metatron source (`src/`) is untouched.