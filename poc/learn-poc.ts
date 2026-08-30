import { audiotool, SyncedDocument, PrimitiveField } from "@audiotool/nexus";
import { getSchemaLocationDetails } from "@audiotool/nexus/document";

// Browser-manual Learn PoC against the LIVE Audiotool backend.
//
// Prerequisites:
//   1. A client registered at https://developer.audiotool.com/applications
//      with http://127.0.0.1:5175/ as allowed redirect URL.
//   2. Set `VITE_AUDIOTOOL_CLIENT_ID` in a local `npm run dev` (see .env) or
//      hardcode it below, then call `window.runLearnPoC(projectUrl)` from the
//      devtools console after the app boots, OR paste the project URL into the
//      project-url field.
//
// This MUST be run on the live DAW; the automated offline equivalent lives in
// tests/nexus/NexusPipeline.integration.test.ts (bidirectional, real lib).

// Browser-safe env read: Vite exposes import.meta.env; never touch process.env
// here (it does not exist in the browser and would break the import).
const CLIENT_ID =
    (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_AUDIOTOOL_CLIENT_ID as string | undefined) ||
    "YOUR_CLIENT_ID";

function isAutomatableField(field: any): boolean {
    try {
        const details = getSchemaLocationDetails(field.location);
        if (details && details.type === "primitive") {
            const tts = (details as any).targetTypes as string[] | undefined;
            if (tts && !tts.includes("AutomatableParameter")) return false;
        }
    } catch (e) {
        // unknown schema => assume valid so Learn can never be blocked
    }
    return true;
}

async function runLearnPoC(projectUrl: string) {
    const client = await audiotool({
        clientId: CLIENT_ID,
        // Must match the redirect registered for this client id.
        redirectUrl: "http://127.0.0.1:5175/",
        scope: "project:write",
    });

    if (client.status === "unauthenticated") {
        console.log("Please authenticate in the Audiotool window.");
        client.login();
        return;
    }

    console.log(`Connected to Nexus as ${client.userName}`);
    console.log(`Opening project: ${projectUrl}`);

    const doc = await client.open(projectUrl);
    await doc.start();

    console.log("Fetching all entities...");
    const allEntities = doc.queryEntities.get();
    console.log(`Found ${allEntities.length} entities in the document.`);

    console.log("\n--- STARTING LEARN POC ---");
    console.log("STOP PLAYBACK. Then move ONE parameter in the Audiotool DAW...");

    const cleanupFns: Array<() => void> = [];
    let isLearning = true;

    for (const entity of allEntities) {
        const fields = entity.fields as Record<string, any>;
        for (const fieldName in fields) {
            const field = fields[fieldName];
            if (!field || typeof field !== "object") continue;
            if (!("location" in field) || !("value" in field)) continue;
            if (field.mutable === false) continue;
            if (!isAutomatableField(field)) continue;

            // NOTE: the third argument (initialTrigger) must be `false`.
            // The SDK fires the callback immediately with the current value
            // when initialTrigger is omitted (defaults to true), which would
            // make Learn "succeed" instantly with the wrong parameter.
            const cleanup = doc.events.onUpdate(field as PrimitiveField, (newValue) => {
                if (isLearning) {
                    isLearning = false;
                    cleanupFns.forEach(fn => fn());

                    console.log("\n--- LEARN SUCCESS ---");
                    console.log(`Entity ID: ${entity.id}`);
                    console.log(`Entity Type: ${entity.entityType}`);
                    console.log(`Field Name: ${fieldName}`);
                    console.log(`New Value: ${newValue}`);

                    writeTest(doc, field as PrimitiveField<any, "mut">, newValue);
                }
            }, false);

            if (typeof cleanup === "function") {
                cleanupFns.push(cleanup);
            } else if (cleanup && typeof cleanup.terminate === "function") {
                cleanupFns.push(() => cleanup.terminate());
            }
        }
    }
    console.log("Learn armed.");
}

async function writeTest(doc: SyncedDocument, field: PrimitiveField<any, "mut">, value: any) {
    console.log(`\nTesting write-back to ${field.location.toString()}...`);
    try {
        await doc.modify(t => {
            t.update(field, value);
        });
        console.log("WRITE TEST PASS");
    } catch (e) {
        console.error("WRITE TEST FAILED:", e);
    }
}

if (typeof window !== "undefined") {
    (window as any).runLearnPoC = runLearnPoC;
    console.log("Learn PoC loaded. Call runLearnPoC(projectUrl) or set VITE_AUDIOTOOL_CLIENT_ID.");
}