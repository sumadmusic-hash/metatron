/**
 * NEXUS 0.0.17 API CAPABILITY TABLE (§16).
 *
 * Every answer is backed by SDK code (type definitions in
 * `node_modules/@audiotool/nexus/dist/document/transaction-builder/builder.d.ts`),
 * a runtime offline probe, or the offline clone suite in `clone.offline.test.ts`.
 *
 * Nothing here is assumed.
 */

export type CapabilityVerdict =
    | "YES"
    | "PARTIAL"
    | "NOT PROVIDED BY NEXUS"
    | "REQUIRES CLIENTSIDE RECONSTRUCTION";

export interface CapabilityRow {
    capability: string;
    verdict: CapabilityVerdict;
    proof: string;
}

/** §16 capability table with a proof line per row. */
export const CAPABILITY_TABLE: CapabilityRow[] = [
    {
        capability: "Entity lesen",
        verdict: "YES",
        proof: "`SyncedDocument.queryEntities` (entity.d.ts) + `EntityQuery.ofTypes/get` — used by discovery POC (193 tests green).",
    },
    {
        capability: "Entity erzeugen",
        verdict: "YES",
        proof: "`TransactionBuilder.create<T>(name, args)` (builder.d.ts) — offline probe `creatable-probe.test.ts`: 42/42 SDK device slugs + audioDevice + mixerChannel created with default args; some types still throw at runtime (see note).",
    },
    {
        capability: "Entity löschen",
        verdict: "YES",
        proof: "`TransactionBuilder.remove(idOrEntity)` + `removeWithDependencies(idOrEntity)` (builder.d.ts). `removeWithDependencies` is used by nested/branching chains.",
    },
    {
        capability: "Parameter schreiben",
        verdict: "YES",
        proof: "`TransactionBuilder.update` / `tryUpdate(field, value)` (builder.d.ts). tryUpdate returns an error STRING for out-of-range; throws for type mismatches — proven by offline probe.",
    },
    {
        capability: "Cable erzeugen",
        verdict: "YES",
        proof: "`t.create(\"desktopAudioCable\", { fromSocket: NexusLocation, toSocket: NexusLocation })` — required constructor args `fromSocket`/`toSocket` (desktop_audio_cable_nexus.d.ts); proven in clone.offline.test.ts.",
    },
    {
        capability: "Cable löschen",
        verdict: "YES",
        proof: "Cable is an ordinary entity → `t.remove(cableId)`. `build-remove` exists for every entity type.",
    },
    {
        capability: "Device duplizieren",
        verdict: "YES",
        proof: "`TransactionBuilder.clone(entity, overwrites?)` and `cloneLinked(...entities)` (builder.d.ts) — pointer-preserving multi-entity clone.",
    },
    {
        capability: "Projekt verändern",
        verdict: "YES",
        proof: "`SyncedDocument.modify(cb)` / `createTransaction()` roll transactions atomically to the backend (document.d.ts); scope `project:write` requested at OAuth.",
    },
    {
        capability: "Chain direkt klonen",
        verdict: "REQUIRES CLIENTSIDE RECONSTRUCTION",
        proof: "No dedicated 'clone a chain' API. Options: reconstruct device-by-device + cables with an id map (this POC), or `cloneLinked` for the whole object graph (single call, internal pointers rewritten).",
    },
    {
        capability: "Parameter stets setzbar",
        verdict: "PARTIAL",
        proof: "Immutable/read-only primitive fields cannot be written (schema `immutable:true`); NexusPointers (nexus-location primitives) are skipped — no audio device exposes immutable automatable params (offline probe: none).",
    },
    {
        capability: "Beliebiger Entity-Typ erzeugbar",
        verdict: "PARTIAL",
        proof: "Type-wise every key exists in `ConstructorTypes`; runtime create can fail (offline probe: `gravitator` → 'No defaults found for entity type gravitator'). Only types with defaults / satisfied required args are actually creatable.",
    },
];

/** Mutation operations the clone engine is built on. */
export const MUTATION_SURFACE: string[] = [
    "t.create(type, args)",
    "t.tryUpdate(field, value)",
    "t.remove(entity)",
    "t.clone(entity)",
    "t.cloneLinked(entities)",
    "document.modify(callback)",
];

/** Read-only operations used on the SOURCE document. */
export const READONLY_SURFACE: string[] = [
    "document.queryEntities.get()",
    "document.queryEntities.getEntity(id)",
    "getSchemaLocationDetails(location)",
    "schemaLocationToSchemaPath(location)",
];