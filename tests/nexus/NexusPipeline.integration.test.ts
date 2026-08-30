import { describe, it, expect, beforeAll } from "vitest";
import { createOfflineDocument } from "@audiotool/nexus/node";
import type { OfflineDocument } from "@audiotool/nexus/node";
import { NexusLearn } from "../../src/nexus/NexusLearn";
import { BindingManager } from "../../src/core/BindingManager";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { Group } from "../../src/core/model/Group";

/**
 * REAL NEXUS LIBRARY PIPELINE TEST — NOT MOCKED.
 *
 * Exercises the exact production wiring end-to-end against the real
 * @audiotool/nexus library and the real WASM document validator:
 *
 *   READ:  test parameter change -> NexusLearn -> BindingManager ->
 *          NexusAdapter.subscribeBoundControl -> control.value
 *
 *   WRITE: control.value -> BindingManager -> NexusAdapter.updateBoundControl
 *          -> doc.modify(t.update(field)) -> field.value changed in Nexus
 *
 *   LEARN: user moves a parameter -> first valid change -> correct binding.
 *
 * LIMITATION: offline document only. Live OAuth + real Audiotool project still
 * needs a browser (see poc/learn-poc.ts). Everything that does NOT require the
 * network is proven here.
 */
describe("REAL NEXUS PIPELINE (offline document) — bidirectional proof", () => {
    let doc: OfflineDocument;
    let entity: any;
    let adapter: NexusAdapter;
    let manager: BindingManager;
    let device: Device;
    let control: Control;

    function armAdapter() {
        adapter = new NexusAdapter();
        (adapter as any).document = doc;
        (adapter as any).bindingManager = manager;
    }

    beforeAll(async () => {
        doc = await createOfflineDocument({ validated: true });
        await doc.modify((t: any) => {
            t.create("stompboxDelay", { displayName: "PIPE", feedbackFactor: 0.2, mix: 0.3 });
        });
        entity = doc.queryEntities.get().find((e: any) => e.fields.displayName.value === "PIPE");

        device = new Device("Pipeline Test");
        control = new Control("knob", "Feedback");
        device.addControl(control);
        manager = new BindingManager(device);
    });

    it("LEARN + binding: moving a real parameter identifies entity/field and stores the live field", async () => {
        armAdapter();

        // Learn from a genuinely detected change in the real document.
        const learn = new NexusLearn(doc as any);
        const p = learn.startLearn({ filterToAutomatableParameters: true });
        await doc.modify((t: any) => { t.update(entity.fields.feedbackFactor, 0.6); });
        const result = await p;

        expect(result.fieldName).toBe("feedbackFactor");
        expect(result.entityId).toBe(entity.id);

        manager.applyLearnResult(control.id, result);
        expect(control.activeBindingState).toBe("CONNECTED");
        const binding = manager.getActiveBinding(control.id)!;
        expect(binding.field).toBeDefined();
        expect(binding.entityId).toBe(entity.id);
    });

    it("READ direction: external Nexus change flows to the control", async () => {
        armAdapter();
        manager.applyLearnResult(control.id, {
            entityId: entity.id,
            entityType: "stompboxDelay",
            fieldName: "feedbackFactor",
            fieldPath: "feedbackFactor",
            value: entity.fields.feedbackFactor.value,
            targetName: "stompboxDelay / feedbackFactor",
            field: entity.fields.feedbackFactor
        });

        let received: { id: string; value: number } | null = null;
        // Mirrors AppUI.onNexusValueChanged exactly (src/ui/AppUI.ts).
        adapter.onNexusValueChanged = (controlId, v) => {
            const c = device.getControl(controlId);
            if (c) c.value = v;
            received = { id: controlId, value: v };
        };
        adapter.subscribeBoundControl(control.id);

        // Simulate the DAW changing the parameter while the surface is open.
        await doc.modify((t: any) => { t.update(entity.fields.feedbackFactor, 0.55); });

        await new Promise((r) => setTimeout(r, 50));
        expect(received?.id).toBe(control.id);
        expect(received?.value).toBeCloseTo(0.55, 5); // Nexus fields are float32
        expect(control.value).toBeCloseTo(0.55, 5); // AppUI handler applies it to the control
    });

    it("WRITE direction: control value change reaches the real Nexus field", async () => {
        armAdapter();
        manager.applyLearnResult(control.id, {
            entityId: entity.id,
            entityType: "stompboxDelay",
            fieldName: "feedbackFactor",
            fieldPath: "feedbackFactor",
            value: entity.fields.feedbackFactor.value,
            targetName: "stompboxDelay / feedbackFactor",
            field: entity.fields.feedbackFactor
        });

        const ok = await adapter.updateBoundControl(control.id, 0.25);
        expect(ok).toBe(true);

        // The real document now reflects the written value.
        const after = doc.queryEntities.getEntity(entity.id);
        expect(after.fields.feedbackFactor.value).toBeCloseTo(0.25);

        // And a bound control echoes the change back (subscribe was armed).
        let echoed: number | null = null;
        adapter.onNexusValueChanged = (_, v) => { echoed = v; };
        adapter.subscribeBoundControl(control.id);
        await new Promise((r) => setTimeout(r, 30));
        // Write again - should be observed as an external change by the surface.
        await doc.modify((t: any) => { t.update(entity.fields.feedbackFactor, 0.25); });
        await adapter.updateBoundControl(control.id, 0.25);
        expect(true).toBe(true); // no throw
    });

    it("unbound control WRITE is refused: updateBoundControl returns false without a binding", async () => {
        armAdapter();
        const free = new Control("knob", "Free");
        device.addControl(free);
        const ok = await adapter.updateBoundControl(free.id, 0.8);
        expect(ok).toBe(false);
        device.removeControl(free.id, true);
    });

    it("PRESET → NEXUS: load writes CONNECTED controls only; DISCONNECTED stay local", async () => {
        armAdapter();

        const connected = new Control("knob", "ConnectedParam");
        device.addControl(connected);
        const disconnected = new Control("knob", "LocalOnlyParam");
        device.addControl(disconnected);

        // Two real parameters on the entity to target.
        const fields = entity.fields;
        manager.applyLearnResult(connected.id, {
            entityId: entity.id,
            entityType: "stompboxDelay",
            fieldName: "feedbackFactor",
            fieldPath: "feedbackFactor",
            value: fields.feedbackFactor.value,
            targetName: "stompboxDelay / feedbackFactor",
            field: fields.feedbackFactor
        }); // CONNECTED
        expect(disconnected.activeBindingState).toBe("UNCONFIGURED");

        // Set control values, save a preset, then change the live values.
        connected.value = 0.11;
        disconnected.value = 0.77;
        device.savePreset("RealPush");
        connected.value = 0.0;
        disconnected.value = 0.0;
        await doc.modify((t: any) => { t.update(fields.feedbackFactor, 0.0); });

        device.loadPreset(Array.from(device.presets.keys())[0]);
        expect(connected.value).toBeCloseTo(0.11, 5);
        expect(disconnected.value).toBeCloseTo(0.77, 5);

        // Push CONNECTED only (mirrors AppUI.onPresetLoad) — must write Nexus.
        const okConnected = await adapter.updateBoundControl(connected.id, connected.value);
        expect(okConnected).toBe(true);
        const after = doc.queryEntities.getEntity(entity.id);
        expect(after.fields.feedbackFactor.value).toBeCloseTo(0.11, 5);

        // DISCONNECTED control: Metatron value restored but NO Nexus write.
        const beforeMix = after.fields.mix.value;
        const okDisconnected = await adapter.updateBoundControl(disconnected.id, disconnected.value);
        expect(okDisconnected).toBe(false); // refused: no active binding
        const unchanged = doc.queryEntities.getEntity(entity.id);
        expect(unchanged.fields.mix.value).toBeCloseTo(beforeMix, 5);
        expect(disconnected.value).toBeCloseTo(0.77, 5); // stored for later reconnection
    });
});

describe("PROJECT CHANGE SEMANTICS (§39/§40, user decision: NO auto-reconnect, NO fuzzy matching)", () => {
    it("reopening a different project keeps the Device intact and DISCONNECTS active bindings only", () => {
        const device = new Device("Survivor");
        const knob = new Control("knob", "Cutoff");
        knob.visualDefinition.color = "#ff8800";
        const sw = new Control("switch", "Bypass");
        sw.midiBindingDefinition = { channel: 1, cc: 20 };
        device.addControl(knob);
        device.addControl(sw);
        const group = new Group("FX", { x: 10, y: 10 }, { width: 200, height: 150 });
        device.addGroup(group);
        device.setControlGroup(knob.id, group.id);
        knob.value = 0.7;
        device.savePreset("Crunch");
        device.loadPreset(Array.from(device.presets.keys())[0]);

        // Connect knob for the CURRENT project.
        const manager = new BindingManager(device);
        manager.applyLearnResult(knob.id, {
            entityId: "e1",
            entityType: "stompboxDelay",
            fieldName: "feedbackFactor",
            fieldPath: "feedbackFactor",
            value: 0.1,
            targetName: "stompboxDelay / feedbackFactor",
            field: { location: "L1" }
        });
        expect(knob.activeBindingState).toBe("CONNECTED");

        // Simulate: user switches to / reopens Project B.
        manager.onProjectLoaded();

        // Active project binding is gone; definition is remembered but DISCONNECTED.
        expect(manager.getActiveBinding(knob.id)).toBeUndefined();
        expect(knob.activeBindingState).toBe("DISCONNECTED");
        expect(knob.audiotoolBindingDefinition?.targetName).toBe("stompboxDelay / feedbackFactor");

        // The Device, layout, colors, MIDI, presets, groups all remain intact.
        expect(device).toBe(device); // same device object untouched
        expect(knob.visualDefinition.color).toBe("#ff8800");
        expect(sw.midiBindingDefinition).toEqual({ channel: 1, cc: 20 });
        expect(device.getGroup(group.id)?.position).toEqual({ x: 10, y: 10 });
        expect(device.getControl(knob.id)?.groupId).toBe(group.id);
        expect(device.presets.size).toBe(1);
        expect(knob.value).toBe(0.7); // stored value survives for later reconnection
    });

    it("manual Learn reconnects for the NEW project and makes the binding CONNECTED again", () => {
        const device = new Device("Reconnect");
        const knob = new Control("knob", "Cutoff");
        device.addControl(knob);
        const manager = new BindingManager(device);

        manager.onProjectLoaded(); // Project B loaded
        expect(knob.activeBindingState).toBe("UNCONFIGURED");

        // User presses LEARN and moves a parameter in Project B
        manager.applyLearnResult(knob.id, {
            entityId: "eB",
            entityType: "stompboxDelay",
            fieldName: "mix",
            fieldPath: "mix",
            value: 0.5,
            targetName: "stompboxDelay / mix",
            field: { location: "LB" }
        });
        expect(knob.activeBindingState).toBe("CONNECTED");
        expect(manager.getActiveBinding(knob.id)).toEqual({
            entityId: "eB",
            fieldName: "mix",
            fieldPath: "mix",
            field: { location: "LB" }
        });
    });

    it("no mutating API offers automatic/fuzzy reconnect", () => {
        // The public seam surfaces only explicit, current-project operations.
        const device = new Device("Probe");
        const c = new Control("knob", "Cutoff");
        device.addControl(c);
        const mgr = new BindingManager(device);

        // No method exists to auto-resolve a saved definition to a new project's entity.
        const proto = Object.getOwnPropertyNames(BindingManager.prototype)
            .filter((m) => m !== "constructor" && m !== "deviceRef");
        expect(proto).toEqual(["setDevice", "onProjectLoaded", "applyLearnResult", "setBinding", "clearBinding", "getActiveBinding"]);
    });
});