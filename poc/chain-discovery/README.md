# METATRON CHAIN DISCOVERY POC

**Read-only Proof of Concept:** detect an Audiotool device / FX chain
(`Synth → Effect 1 → Effect 2 → Effect 3`) from a real Audiotool project
using the real `@audiotool/nexus` (v0.0.17) library — without ever mutating
the project.

```
Audiotool Project
      ↓
Nexus (real, read-only)
      ↓
Chain Discovery
      ↓
Diagnostic output (Entities / Connections / Parameters / Values / Bindings)
```

This POC intentionally ends BEFORE cloning / installing / rebinding (see §22
of the task). It lives in `poc/chain-discovery/` and does **not** touch the
productive Metatron source (`src/`, `tests/`).

---

## Run

```bash
npm run dev
# open http://127.0.0.1:5175/poc/chain-discovery/
```

The dev server runs on `127.0.0.1:5175` (project root `index.html` is the
productive Metatron app; the POC is a separate page).

Build (emits the POC page alongside the main app):

```bash
npx vite build
npx tsc --noEmit
npm test
```

The POC source is type-checked together with `src/` (added to `tsconfig.json`
`include`). The multi-page `vite.config.ts` `build.rollupOptions.input` entry
is additive and does not change the main entry.

---

## Authentication (OAuth)

Same mechanism and same `VITE_AUDIOTOOL_CLIENT_ID` as the existing Metatron
PoC — no second auth architecture:

- `CONNECT` performs a browser **OAuth popup** via `audiotoolPopup()`.
- On load the POC calls `audiotool({ clientId, redirectUrl, scope })` to
  detect an already stored session.

Tokens are stored in origin-scoped `localStorage` (the SDK's own
`audiotool-oauth` keys), so the POC shares the login with the productive
Metatron app on the same origin.

- `VITE_AUDIOTOOL_CLIENT_ID` is required for a real client; the code falls
  back to the same dev client id the productive app uses.
- Popup OAuth requires that the **origin** of the app is registered as a
  redirect origin for the client. Path does not matter for the popup flow.
- If the popup is blocked / origin not registered → reported as
  `ENVIRONMENTAL BLOCK`, never as a discovery result.

---

## Read-only guarantee

The POC never calls any write API. The following are **never** used:

```
document.modify(), createTransaction().create/update/remove,
removeWithDependencies(), clone(), cloneLinked(),
createPreset(), applyPreset()
```

The live layer (`live.ts`) only uses:

| API | Purpose | Provenance |
| --- | --- | --- |
| `client.open(projectUrl)` + `document.start()` | connect / sync (read) | `PROVEN BY REAL NEXUS` |
| `document.queryEntities.get()` / `.ofTypes("desktopAudioCable")` | entity + cable enumeration | `PROVEN BY REAL NEXUS` |
| `entity.id`, `entity.entityType`, `entity.fields…` | raw entity data | `PROVEN BY REAL NEXUS` |
| `getSchemaLocationDetails(field.location)` | schema metadata (range, scalar type, target types, default) | `PROVEN BY REAL NEXUS` |
| `schemaLocationToSchemaPath(location)` | human readable field paths | `PROVEN BY REAL NEXUS` |
| `localStorage["metatron_devices"]` (raw JSON) | persisted Metatron bindings | `PROVEN BY OFFLINE TEST` |

---

## How chain discovery works

1. **Entities** — `listEntitiesLive()` reads every entity:
   `{ entityId, entityType, displayName, schema target types }`.
2. **Audio devices** — an entity counts as an audio device when it carries at
   least one socket field with target type `AudioInput` / `AudioOutput` /
   `NotesInput` (schema data, not names).
3. **Connections** — every `desktopAudioCable` entity is read. Each cable's
   `fromSocket` / `toSocket` are `PrimitiveField<NexusLocation>` whose values
   Nexus already resolved to `NexusLocation { entityId, fieldIndex }`. The
   `entityId` is the owning device, the path (via
   `schemaLocationToSchemaPath`) names the socket (`audioOutput`/`audioInput`).
4. **Traversal** — `discovery.ts` `traverseChain()` runs a read-only
   depth-first traversal with a visited set (duplicate + cycle protection),
   max depth (default 32), and truncation reporting. This function is pure and
   unit-tested with mocks.
5. **Parameters / current values** — for each chain member all fields whose
   schema target types include `AutomatableParameter` are shown with their live
   value, schema range, scalar type, default and mutable state.

> Field-path note: Nexus exposes field keys in camelCase only
> (`filter.cutoffFrequencyHz`, `filter.resonance`). The snake_case proto names
> (`filter.cutoff_frequency_hz`) exist in the generated descriptor but are not
> exposed by the SDK metadata API — so paths are reported as-is (PROVEN) and
> never transliterated by heuristics.

**Non-goals (deferred):** curve heuristics (log/exp), parameter meaning, preset
migration, cloning. Parameter *mapping* is explicitly out of scope for this POC.

---

## Files

```
poc/chain-discovery/
├── index.html          UI page (served by vite)
├── main.ts             UI wiring + OAuth + project connect
├── live.ts             REAL Nexus read-only access layer
├── discovery.ts        pure algorithm (no @audiotool/nexus import)
├── bindings.ts         read-only Metatron persisted bindings
├── types.ts            shared types + provenance ledger
├── discovery.test.ts   vitest unit tests (mocks only)
└── README.md
```

---

## Provenance rules

Every result is tagged exactly one of:

- `PROVEN BY REAL NEXUS` — read out of a live project document.
- `PROVEN BY OFFLINE TEST` — deterministic, tested offline (unit tests,
  persisted Metatron store).
- `ASSUMED` — inferred, not proven.
- `NOT AVAILABLE` — Nexus does not expose it.
- `ENVIRONMENTAL BLOCK` — OAuth / network / browser limitation.

An offline unit test is **never** presented as proof of a working live
Audiotool connection.