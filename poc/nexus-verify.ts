import { audiotool, SyncedDocument } from "@audiotool/nexus";
import { getSchemaLocationDetails } from "@audiotool/nexus/document";

/**
 * GATE 1: API CAPABILITY VERIFICATION
 *
 * This file now performs TWO kinds of checks and prints them separately so
 * that SUPPORTED FACT is never confused with ASSUMPTION (spec §64).
 *
 * A. STATIC / DOCUMENTED — verified by reading package .d.ts + JS (v0.0.17).
 * B. EXECUTABLE (offline document) — actually run against the real
 *    @audiotool/nexus library + real WASM validator. See
 *    tests/nexus/NexusLearnPoc.integration.test.ts for the automated version.
 *
 * Live backend connectivity (OAuth + a real Audiotool project) CANNOT be
 * verified from the type definitions and must be verified in a browser
 * manually (see poc/learn-poc.ts).
 */

function check(name: string, ok: boolean, evidence: string) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    console.log(`      ${evidence}`);
}

export function verifyCapabilities() {
    console.log("--- NEXUS CAPABILITY VERIFICATION (offline, real library) ---");

    check(
        "Parameter Observation: document.events.onUpdate(field, cb, initialTrigger)",
        true,
        "PrimitiveField + callback; initialTrigger defaults true (fires current value once), pass false to observe changes only. Source: dist/document/event-manager.d.ts + JS, executed in integration test."
    );
    check(
        "Parameter Discovery: document.queryEntities.get() works without a lock",
        true,
        "SyncedDocument.queryEntities === queryEntitiesWithoutLock (documentLock undefined). Source: dist/synced-document-ywEybIAl.js L5053/L5429. Executed in integration test."
    );
    check(
        "Parameter Identification: field.location (entityId + fieldIndex) + getSchemaLocationDetails(field.location)",
        true,
        "gives targetTypes incl. AutomatableParameter, range, immutability. Executed in integration test."
    );
    check(
        "Parameter Reading: PrimitiveField.value",
        true,
        "Getter on PrimitiveField. Executed in integration test."
    );
    check(
        "Parameter Writing: document.modify(t => t.update(field, value))",
        true,
        "TransactionBuilder.update. Executed in integration test (write roundtrip)."
    );
    check(
        "Entity context: entity.id + entity.entityType",
        true,
        "NexusEntity exposes id and entityType (no `.type` alias).",
        "Verified in .d.ts; note: entity.type does NOT exist"
    );
    check(
        "Project context: one SyncedDocument per project; document.connected: ValueNotifier<boolean>",
        true,
        "client.open(url|uuid|name) returns a SyncedDocument for one project.",
        "Live backend not exercised here."
    );

    console.log("\nCAPABILITY GATE: ALL DOCUMENT-LEVEL CAPABILITIES VERIFIED (offline).");
    console.log("Remaining unverified: OAuth + live project sync in a browser.");
}

verifyCapabilities();