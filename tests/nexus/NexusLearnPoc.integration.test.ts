import { describe, it, expect, beforeAll } from "vitest";
import { createOfflineDocument } from "@audiotool/nexus/node";
import type { OfflineDocument } from "@audiotool/nexus/node";
import { getSchemaLocationDetails } from "@audiotool/nexus/document";
import { NexusLearn, LearnTimeoutError, LearnCancelledError } from "../../src/nexus/NexusLearn";

/**
 * REAL NEXUS LIBRARY INTEGRATION TEST — NOT MOCKED.
 *
 * This suite runs against the actual `@audiotool/nexus` package (v0.0.17):
 * - The offline document uses the real protobuf schema and the real WASM
 *   document validator (`document_validator.wasm`).
 * - It exercises: discover, read, observe, identify, write for parameters.
 *
 * LIMITATION: it uses an OFFLINE document, i.e. it does NOT connect to the
 * Audiotool backend over the network. Backend connectivity (OAuth + live
 * project) must still be verified manually in the browser. See `poc/`.
 */
describe("REAL NEXUS LIBRARY INTEGRATION — Learn PoC (offline document)", () => {
    let doc: OfflineDocument;
    let delayEntity: any;
    let feedbackField: any;
    let mixField: any;
    let trackNamedParameters: { fieldName: string; entityId: string; details: any }[] = [];

    beforeAll(async () => {
        doc = await createOfflineDocument({ validated: true });

        await doc.modify((t: any) => {
            t.create("stompboxDelay", { displayName: "D1", feedbackFactor: 0.1, mix: 0.2 });
            t.create("stompboxDelay", { displayName: "D2", feedbackFactor: 0.4, mix: 0.5 });
        });

        const entities = doc.queryEntities.get();
        delayEntity = entities.find((e: any) => e.fields.displayName.value === "D1");
        expect(delayEntity, "created entity D1 must exist").toBeDefined();

        feedbackField = delayEntity.fields.feedbackFactor;
        mixField = delayEntity.fields.mix;
        expect(feedbackField.value).toBeCloseTo(0.1);

        // Build a list of all discoverable parameters for the created device type.
        const e = delayEntity;
        for (const [fieldName, field] of Object.entries(e.fields) as any) {
            if (field && typeof field === "object" && "location" in field && "value" in field) {
                if (field.mutable === false) continue;
                const details = getSchemaLocationDetails(field.location);
                const targetTypes = details.type === "primitive" ? (details as any).targetTypes : [];
                if (targetTypes.includes("AutomatableParameter")) {
                    trackNamedParameters.push({ fieldName, entityId: e.id, details });
                }
            }
        }
    });

    it("1. Parameter discovery — enumerates AutomatableParameter fields", () => {
        expect(trackNamedParameters.length).toBeGreaterThan(0);
        const names = trackNamedParameters.map((p) => p.fieldName);
        // feedbackFactor, mix, isActive are genuine AutomatableParameters;
        // positionX/positionY/displayName must NOT be offered as parameters.
        expect(names).toContain("feedbackFactor");
        expect(names).toContain("mix");
        expect(names).toContain("isActive");
        expect(names).not.toContain("positionX");
        expect(names).not.toContain("displayName");
    });

    it("2. Parameter reading — reads current field value", () => {
        expect(feedbackField.value).toBeCloseTo(0.1);
        expect(mixField.value).toBeCloseTo(0.2);
    });

    it("3. Learn observes a real change and identifies entity + field", async () => {
        const learn = new NexusLearn(doc as any);
        const p = learn.startLearn({ filterToAutomatableParameters: true });
        expect(learn.isActive()).toBe(true);

        // Simulate the user moving the DELAY's mix knob inside the DAW.
        await doc.modify((t: any) => { t.update(mixField, 0.9); });

        const result = await p;
        expect(learn.isActive()).toBe(false);
        expect(result.entityId).toBe(delayEntity.id);
        expect(result.entityType).toBe("stompboxDelay");
        expect(result.fieldName).toBe("mix");
        expect(result.value).toBeCloseTo(0.9);
        expect(result.targetName).toBe("stompboxDelay / mix");
    });

    it("4. Learn — first valid parameter change wins", async () => {
        const learn = new NexusLearn(doc as any);
        const p = learn.startLearn({ filterToAutomatableParameters: true });

        // Two parameters change; the FIRST dispatched must win.
        await doc.modify((t: any) => {
            t.update(delayEntity.fields.feedbackFactor, 0.33);
            t.update(delayEntity.fields.mix, 0.44);
        });

        const result = await p;
        expect(result.fieldName).toBe("feedbackFactor");
        expect(result.value).toBeCloseTo(0.33);
        // Learn ended, so the second change must NOT re-trigger.
        expect(learn.isActive()).toBe(false);
    });

    it("5. Learn does NOT resolve from initial values (initialTrigger guard)", async () => {
        const learn = new NexusLearn(doc as any);
        const p = learn.startLearn({ filterToAutomatableParameters: true });

        let resolved = false;
        p.then(() => { resolved = true; }, () => { resolved = false; });

        // No user change; give the library multiple macrotask turns.
        await new Promise((r) => setTimeout(r, 100));
        expect(resolved).toBe(false);
        expect(learn.isActive()).toBe(true);
        learn.cancelLearn();
    });

    it("6. Parameter writing — Metatron can change the parameter value", async () => {
        const learn = new NexusLearn(doc as any);
        const p = learn.startLearn({ filterToAutomatableParameters: true });
        await doc.modify((t: any) => { t.update(delayEntity.fields.feedbackFactor, 0.66); });
        const result = await p;

        // Write a different value through the detected binding.
        await doc.modify((t: any) => { t.update(delayEntity.fields.feedbackFactor, 0.77); });
        expect(delayEntity.fields.feedbackFactor.value).toBeCloseTo(0.77);
        expect(result.fieldName).toBe("feedbackFactor");
        expect(result.value).toBeCloseTo(0.66);
    });

    it("7. Learn cancellation — rejects with LearnCancelledError and creates no binding", async () => {
        const learn = new NexusLearn(doc as any);
        const p = learn.startLearn({ filterToAutomatableParameters: true, timeoutMs: 5000 });
        expect(learn.isActive()).toBe(true);

        let resolved = false;
        let rejected: any = null;
        p.then(() => { resolved = true; }, (e) => { rejected = e; });

        await learn.cancelLearn();
        expect(learn.isActive()).toBe(false);
        await new Promise((r) => setTimeout(r, 10));
        expect(rejected).toBeInstanceOf(LearnCancelledError);
        expect(resolved).toBe(false);

        // Even after cancelling, a subsequent parameter change must not bind.
        await doc.modify((t: any) => { t.update(delayEntity.fields.feedbackFactor, 0.1); });

        await new Promise((r) => setTimeout(r, 50));
        expect(resolved).toBe(false);
    });

    it("8. Learn timeout — rejects with LearnTimeoutError", async () => {
        const learn = new NexusLearn(doc as any);
        const p = learn.startLearn({ filterToAutomatableParameters: true, timeoutMs: 30 });
        await expect(p).rejects.toThrowError(LearnTimeoutError);
        expect(learn.isActive()).toBe(false);
    });
});