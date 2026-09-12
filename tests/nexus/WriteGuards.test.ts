import { describe, it, expect, vi } from "vitest";
import { createOfflineDocument } from "@audiotool/nexus/node";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { BindingManager } from "../../src/core/BindingManager";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { createNexusValueMapping, mapNormalizedToNexus } from "../../src/nexus/NexusValueMapping";

/**
 * M6 — write-path guards in NexusAdapter.updateBoundControl.
 *
 * Deterministic behavior: connected -> write; disconnected/immutable/unsupported
 * -> no modify call + returns false + no pending async operation.
 * Uses the REAL offline Nexus document where a write must land, and stub
 * documents only where we assert "modify was NEVER called".
 */

function makeAdapter(doc: any, manager: BindingManager, controlId: string, field: any): NexusAdapter {
    const adapter = new NexusAdapter();
    (adapter as any).document = doc;
    (adapter as any).bindingManager = manager;
    return adapter;
}

function bindControl(device: Device, manager: BindingManager, control: Control, entityId: string, field: any): BindingManager {
    manager.setBinding(control.id, entityId, "feedbackFactor", "stompboxDelay / feedbackFactor", field, field ? "feedbackFactor" : undefined);
    return manager;
}

describe("M6 write guards — connected write still lands on the real document", () => {
    it("1. connected + mutable field -> write occurs and the correct mapped value reaches the field", async () => {
        const doc = await createOfflineDocument({ validated: true });
        await doc.modify((t: any) => {
            t.create("stompboxDelay", { displayName: "M6", feedbackFactor: 0.2, mix: 0.3 });
        });
        const entity = doc.queryEntities.get().find((e: any) => e.fields.displayName.value === "M6");
        expect(entity).toBeDefined();

        const device = new Device("M6 Device");
        const control = new Control("knob", "Feedback");
        device.addControl(control);
        const manager = new BindingManager(device);
        bindControl(device, manager, control, entity.id, entity.fields.feedbackFactor);
        expect(control.activeBindingState).toBe("CONNECTED");

        const adapter = makeAdapter(doc, manager, control.id, entity.fields.feedbackFactor);
        const mapping = createNexusValueMapping(entity.fields.feedbackFactor);
        const expected = mapNormalizedToNexus(mapping, 0.4);
        expect(expected).not.toBeUndefined();

        const ok = await adapter.updateBoundControl(control.id, 0.4);
        expect(ok).toBe(true);

        const after = doc.queryEntities.getEntity(entity.id);
        expect(after.fields.feedbackFactor.value).toBeCloseTo(expected as number, 5);
    });

    it("2. binding state remains unchanged after a successful write", async () => {
        const doc = await createOfflineDocument({ validated: true });
        await doc.modify((t: any) => {
            t.create("stompboxDelay", { displayName: "M6B", feedbackFactor: 0.2 });
        });
        const entity = doc.queryEntities.get().find((e: any) => e.fields.displayName.value === "M6B");

        const device = new Device("M6 Device B");
        const control = new Control("knob", "Feedback");
        device.addControl(control);
        const manager = new BindingManager(device);
        manager.setBinding(control.id, entity.id, "feedbackFactor", "stompboxDelay / feedbackFactor", entity.fields.feedbackFactor, "feedbackFactor");
        const before = manager.getActiveBinding(control.id);
        const beforeState = control.activeBindingState;

        const adapter = makeAdapter(doc, manager, control.id, entity.fields.feedbackFactor);
        const ok = await adapter.updateBoundControl(control.id, 0.5);
        expect(ok).toBe(true);

        const after = manager.getActiveBinding(control.id);
        expect(after).toBe(before); // same live binding object
        expect(control.activeBindingState).toBe(beforeState);
        expect(control.activeBindingState).toBe("CONNECTED");
    });
});

describe("M6 write guards — refusals never call modify and never stay pending", () => {
    const connectedDoc = (modify: any) => ({
        connected: { getValue: () => true },
        queryEntities: { getEntity: () => ({}), get: () => [] },
        events: { onUpdate: () => () => {} },
        modify,
    });

    it("3. disconnected document -> no modify call and returns false", async () => {
        const modify = vi.fn(async () => { throw new Error("modify must not be called when disconnected"); });
        const doc: any = {
            connected: { getValue: () => false },
            queryEntities: { getEntity: () => ({}), get: () => [] },
            events: { onUpdate: () => () => {} },
            modify,
        };
        const device = new Device("D");
        const control = new Control("knob", "K");
        device.addControl(control);
        const manager = new BindingManager(device);
        manager.setBinding(control.id, "e1", "feedbackFactor", "stompboxDelay / feedbackFactor", { location: "L", value: 0.5, mutable: true }, "feedbackFactor");

        const adapter = makeAdapter(doc, manager, control.id, { location: "L", value: 0.5, mutable: true });
        const ok = await adapter.updateBoundControl(control.id, 0.3);

        expect(ok).toBe(false);
        expect(modify).not.toHaveBeenCalled();
        // no pending async operation: the promise already settled with a value.
        expect(await adapter.updateBoundControl(control.id, 0.3)).toBe(false);
    });

    it("4. immutable field -> no modify call and returns false", async () => {
        const modify = vi.fn(async () => { throw new Error("modify must not be called for immutable fields"); });
        const doc: any = connectedDoc(modify);
        const device = new Device("I");
        const control = new Control("knob", "K");
        device.addControl(control);
        const manager = new BindingManager(device);
        const field = { location: "L", value: 0.5, mutable: false };
        manager.setBinding(control.id, "e1", "feedbackFactor", "stompboxDelay / feedbackFactor", field, "feedbackFactor");

        const adapter = makeAdapter(doc, manager, control.id, field);
        const ok = await adapter.updateBoundControl(control.id, 0.3);

        expect(ok).toBe(false);
        expect(modify).not.toHaveBeenCalled();
    });

    it("5. unsupported value mapping -> no modify call and returns false", async () => {
        const modify = vi.fn(async () => { throw new Error("modify must not be called for unsupported mappings"); });
        const doc: any = connectedDoc(modify);
        const device = new Device("U");
        const control = new Control("knob", "K");
        device.addControl(control);
        const manager = new BindingManager(device);
        const field = { location: "L", value: 0.5, mutable: true };
        manager.setBinding(control.id, "e1", "feedbackFactor", "stompboxDelay / feedbackFactor", field, "feedbackFactor");
        // Force an unsupported mapping (no numeric transform, e.g. a string field).
        (manager.getActiveBinding(control.id) as any).valueMapping = { kind: "unsupported", typeLabel: "string" };

        const adapter = makeAdapter(doc, manager, control.id, field);
        const ok = await adapter.updateBoundControl(control.id, 0.3);

        expect(ok).toBe(false);
        expect(modify).not.toHaveBeenCalled();
    });

    it("6. unbound control -> no modify call and returns false (guard unchanged)", async () => {
        const modify = vi.fn(async () => { throw new Error("modify must not be called unbound"); });
        const doc: any = connectedDoc(modify);
        const device = new Device("UB");
        const control = new Control("knob", "Free");
        device.addControl(control);
        const manager = new BindingManager(device);

        const adapter = makeAdapter(doc, manager, control.id, undefined);
        const ok = await adapter.updateBoundControl(control.id, 0.3);

        expect(ok).toBe(false);
        expect(modify).not.toHaveBeenCalled();
    });
});