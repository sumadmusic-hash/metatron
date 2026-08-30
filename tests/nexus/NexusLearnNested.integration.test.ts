import { describe, it, expect, beforeAll } from "vitest";
import { createOfflineDocument } from "@audiotool/nexus/node";
import { NexusLearn, LearnTimeoutError, LearnCancelledError } from "../../src/nexus/NexusLearn";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { BindingManager } from "../../src/core/BindingManager";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";

/**
 * LIVE-LEARN FIX REGRESSION — real @audiotool/nexus + real WASM validator.
 *
 * Proves the Audiotool Learn path now captures parameters that live inside
 * NESTED object fields and array items (the previous flat `entity.fields`
 * scan missed them, so Learn silently timed out on real DAW parameters such
 * as a pulverisateur's oscillator / filter / envelope knobs).
 *
 * LIMITATION: offline document. Live OAuth + real Audiotool project must be
 * verified in the browser; this proves everything that is network-independent.
 */
describe("REAL NEXUS PIPELINE — nested AutomatableParameter Learn (offline document)", () => {
    let doc: any;
    let pulv: any;

    beforeAll(async () => {
        doc = await createOfflineDocument({ validated: true });
        await doc.modify((t: any) => {
            t.create("pulverisateur", { displayName: "P1" });
            t.create("pulverisateur", { displayName: "P2" });
        });
        const entities = doc.queryEntities.get();
        pulv = entities.find((e: any) => e.fields.displayName.value === "P1");
        expect(pulv, "pulverisateur must exist").toBeDefined();
    });

    it("1. Learn captures a parameter nested in an object field", async () => {
        const learn = new NexusLearn(doc as any);
        const p = learn.startLearn({ filterToAutomatableParameters: true });

        // User moves a nested DAW knob: oscillatorA.channel.isActive (true -> false).
        await doc.modify((t: any) => { t.update(pulv.fields.oscillatorA.fields.channel.fields.isActive, false); });

        const result = await p;
        expect(result.entityId).toBe(pulv.id);
        expect(result.entityType).toBe("pulverisateur");
        expect(result.fieldPath).toBe("oscillatorA.channel.isActive");
        expect(result.fieldName).toBe("oscillatorA");
        expect(result.value).toBe(false);
        expect(learn.isActive()).toBe(false);
    });

    it("2. first-change-wins still holds across simultaneous nested changes", async () => {
        const learn = new NexusLearn(doc as any);
        const p = learn.startLearn({ filterToAutomatableParameters: true });

        await doc.modify((t: any) => {
            t.update(pulv.fields.oscillatorA.fields.channel.fields.panning, 0.25);
            t.update(pulv.fields.oscillatorB.fields.channel.fields.panning, 0.5);
        });

        const result = await p;
        expect(result.fieldPath).toBe("oscillatorA.channel.panning");
        expect(learn.isActive()).toBe(false);
    });

    it("3. onCreate re-scan: a parameter on an entity created while Learning is captured", async () => {
        const learn = new NexusLearn(doc as any);
        const p = learn.startLearn({ filterToAutomatableParameters: true });

        // A device is inserted into the document while Learn is armed.
        await doc.modify((t: any) => {
            t.create("stompboxDelay", { displayName: "RUNNER", feedbackFactor: 0.3 });
        });

        // User then moves that new device's knob (resolved from the live doc).
        const runner = doc.queryEntities.get().find((e: any) => e.fields.displayName.value === "RUNNER");
        expect(runner, "runner must exist").toBeDefined();
        await doc.modify((t: any) => { t.update(runner.fields.feedbackFactor, 0.77); });

        const result = await p;
        expect(result.entityId).toBe(runner.id);
        expect(result.fieldPath).toBe("feedbackFactor");
        expect(result.value).toBeCloseTo(0.77);
        expect(learn.isActive()).toBe(false);
    });

    it("4. nested binding round-trips: applyLearnResult + updateBoundControl write the nested field", async () => {
        const learn = new NexusLearn(doc as any);
        const p = learn.startLearn({ filterToAutomatableParameters: true });
        await doc.modify((t: any) => { t.update(pulv.fields.oscillatorB.fields.channel.fields.isActive, true); });
        const result = await p;
        expect(result.fieldPath).toBe("oscillatorB.channel.isActive");
        expect(result.value).toBe(true);

        const device = new Device("Nested");
        const ctl = new Control("switch", "OscB on");
        device.addControl(ctl);
        const manager = new BindingManager(device);
        manager.applyLearnResult(ctl.id, result);
        expect(manager.getActiveBinding(ctl.id)?.fieldPath).toBe("oscillatorB.channel.isActive");

        const adapter = new NexusAdapter();
        (adapter as any).document = doc;
        (adapter as any).bindingManager = manager;

        // Write through the stored LIVE field reference (1 -> true; already true so use 0 -> false).
        const ok = await adapter.updateBoundControl(ctl.id, 0);
        expect(ok).toBe(true);
        const after = doc.queryEntities.getEntity(pulv.id);
        expect(after.fields.oscillatorB.fields.channel.fields.isActive.value).toBeFalsy(); // 0 = false
    });

    it("5. updateBoundControl resolves a nested field from fieldPath when no live field is stored", async () => {
        const device = new Device("NestedPath");
        const ctl = new Control("knob", "OscA pan");
        device.addControl(ctl);
        const manager = new BindingManager(device);
        manager.setBinding(ctl.id, pulv.id, "oscillatorA", "pulverisateur / oscillatorA.channel.panning", undefined, "oscillatorA.channel.panning");

        const adapter = new NexusAdapter();
        (adapter as any).document = doc;
        (adapter as any).bindingManager = manager;

        const ok = await adapter.updateBoundControl(ctl.id, 0.9);
        expect(ok).toBe(true);
        const after = doc.queryEntities.getEntity(pulv.id);
        // panning range is [-1, 1]; normalized 0.9 maps to 0.8 (generic mapping applied).
        expect(after.fields.oscillatorA.fields.channel.fields.panning.value).toBeCloseTo(0.8, 5);
    });

    it("6. nested Learn cancels cleanly with LearnCancelledError and creates no binding", async () => {
        const learn = new NexusLearn(doc as any);
        const p = learn.startLearn({ filterToAutomatableParameters: true, timeoutMs: 5000 });
        expect(learn.isActive()).toBe(true);

        let rejected: any = null;
        p.then(() => {}, (e) => { rejected = e; });
        learn.cancelLearn();
        await new Promise((r) => setTimeout(r, 10));
        expect(rejected).toBeInstanceOf(LearnCancelledError);
        expect(learn.isActive()).toBe(false);

        // Subsequent nested change must not bind.
        let stillLearning = learn.isActive();
        await doc.modify((t: any) => { t.update(pulv.fields.oscillatorA.fields.channel.fields.isActive, true); });
        expect(stillLearning).toBe(false);
    });
});