# METATRON LIVE CHAIN CLONE CAPABILITY TEST

**Honest live test** — the decisive question:

> CAN Nexus v0.0.17 reconstruct an Audiotool instrument/FX chain (devices +
> current parameter values + audio cables) in a **second real** Audiotool
> project?

Exactly **one** answer is produced:

```
CHAIN CLONE: PASS        — full reconstruction, real mutation on a real project
CHAIN CLONE: PARTIAL     — reconstructed, but ≥1 required mutation is missing
CHAIN CLONE: BLOCKED     — a required operation is not provided (or no OAuth/live access)
```

No PASS without a real mutation. The POC lives entirely in `poc/chain-clone-live/`
and does not touch the productive Metatron/Metatron source (`src/`, `tests/`).

---

## Live test result — PASS (2026-08-30)

Real OAuth session (user `sumad`), real projects, real mutation.

```
SOURCE:   https://www.audiotool.com/studio?project=38e6b0b9-1888-4148-9f3b-c8e86510f140
TARGET:   https://www.audiotool.com/studio?project=77c45a2f-2f2b-4b09-b874-77f740b8e503

SOURCE        chain: pulverisateur → stompboxChorus → stompboxFlanger → mixerChannel
              entities: 13 (project), 4 in chain | parameters: 93 | cables: 3
TARGET BEFORE entities: 5 | cables: 0
CLONE         entity creation: PASS | parameter writes: PASS | cable creation: PASS | topology: PASS
TARGET AFTER  entities: 12 | parameters: 93 | cables: 3
FAILURES:      [] (every write/tryUpdate succeeded)
FINAL RESULT:  CHAIN CLONE: PASS
```

The verification step re-reads the TARGET and compares topology and every
parameter value (float32-tolerant) against the SOURCE snapshot; the empty
failure list and `topology: PASS` are the machine verdict, not a UI claim.
Source entity ids are never reused — the printed source→target id map keeps
logical identity only (4 mappings for the 4 cloned devices).

---

## Run

```bash
npm run dev
# open http://127.0.0.1:5175/poc/chain-clone-live/
```

Build / verify:

```bash
npm run build
npm test
```

`tsconfig.json` `include` and `vite.config.ts` `input` were extended additively.

---

## Phases

| # | Phase | Behavior |
| --- | --- | --- |
| 1 | SOURCE DISCOVERY | read-only chain detection (reuses `../chain-discovery`) |
| 2 | SNAPSHOT | serializable capture via `../chain-clone/snapshot.ts` (reuses `createSnapshot` / `serializeSnapshot`) |
| 3 | CAPABILITY REPORT | gate BEFORE any mutation: required ops (`Entity erzeugen`, `Parameter schreiben`, `Cable erzeugen`) must be proven usable; device types outside the tested creatable set → `BLOCKED`, no workaround invented |
| 4 | TARGET BEFORE | read-only counts of the target project |
| 5 | CLONE PLAN | display only — no mutation |
| 6 | USER CONFIRMATION | the ONLY way the target is mutated |
| 7 | CLONE | via `../chain-clone/clone.ts` `cloneChainFromSnapshot` (create → parameters → cables, every op checked) |
| 8 | POST-CLONE DISCOVERY | target re-read, logical structure compared (ids differ, structure identical) |
| 9 | VERIFICATION REPORT | exact §9 block + machine verdict |

### Identity

Logical identity comes from the snapshot's chain order (source ids are captured
once in the snapshot); Audiotool entity ids are never reused as target ids
(source → target id map is a pure mapping). No `"find device named X"`
heuristics.

### Honesty guards (`report.ts`, unit-tested)

- capability/environment block → `BLOCKED` with reason — never PASS.
- engine answer `NOT POSSIBLE WITH CURRENT NEXUS API` → `BLOCKED` (CAPABILITY).
- PASS requires `finalVerdict === PASS` **and** `mutationExecuted === true`.
- blocked OAuth / project access → `BLOCKED` (ENVIRONMENT).

---

## Files

```
poc/chain-clone-live/
├── index.html          UI page (served by vite)
├── main.ts             phase orchestration + OAuth + real project handling
├── report.ts           pure §9 report builder + §3 capability gate (no Nexus import)
├── report.test.ts      unit tests for verdict rules and report layout
└── README.md
```

Reuses (read-only / non-invasive) `../chain-discovery` and `../chain-clone`.
The only additive change to `../chain-clone` is the exported
`cloneChainFromSnapshot(snapshot, target, …)` orchestration entry point
(`cloneChainToDoc` now delegates to it).