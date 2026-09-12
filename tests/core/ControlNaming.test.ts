import { describe, it, expect } from "vitest";
import { Control } from "../../src/core/model/Control";
import { Device } from "../../src/core/model/Device";
import { BindingManager } from "../../src/core/BindingManager";
import {
    buildLearnedControlName,
    applyLearnedControlName,
    resolveEntityDisplayName,
} from "../../src/nexus/ControlNaming";
import type { LearnResult } from "../../src/nexus/NexusLearn";

describe("Control automatic naming on Learn success (M4)", () => {

    it("1 — dotted path shortens the last segment", () => {
        expect(buildLearnedControlName("Pulverisateur", "heisenberg", "filter.cutoffFrequency"))
            .toBe("Cutoff");
    });

    it("2 — single-segment path is transformed to its title label", () => {
        expect(buildLearnedControlName("Stompbox Delay", "stompboxDelay", "feedbackFactor"))
            .toBe("Feedback Factor");
    });

    it("3 — deeply nested path extracts the final segment", () => {
        expect(buildLearnedControlName("Device A", "heisenberg", "oscillatorA.channel.isActive"))
            .toBe("Is Active");
    });

    it("4 — empty/whitespace fieldPath falls back to displayName then entityType", () => {
        expect(buildLearnedControlName("My Device", "stompboxDelay", ""))
            .toBe("My Device");
        expect(buildLearnedControlName("My Device", "stompboxDelay", "   "))
            .toBe("My Device");
        expect(buildLearnedControlName("", "stompboxDelay", "  "))
            .toBe("stompboxDelay");
        expect(buildLearnedControlName(undefined, "stompboxDelay", "  "))
            .toBe("stompboxDelay");
        expect(buildLearnedControlName(undefined, "stompboxDelay", ""))
            .toBe("stompboxDelay");
    });

    it("5 — leading/trailing whitespace in fieldPath is trimmed", () => {
        expect(buildLearnedControlName("D", "heisenberg", "  filter.resonance  "))
            .toBe("Resonance");
    });

    it("6 — a control with nameSource manual keeps its name", () => {
        const c = new Control("knob", "My Knob");
        c.nameSource = "manual";
        const applied = applyLearnedControlName(c, "Cutoff");
        expect(applied).toBe(false);
        expect(c.name).toBe("My Knob");
        expect(c.nameSource).toBe("manual");
    });

    it("7 — CRITICAL REGRESSION: fresh control learns, receives shortened Learn name", () => {
        // A brand-new Control with no manual-naming marker performs a
        // successful Learn. No pre-seeding of nameSource = "auto".
        const c = new Control("knob", "Knob");
        expect(c.nameSource).toBeUndefined();

        const name = buildLearnedControlName("Stompbox Delay", "stompboxDelay", "stompboxDelay.feedbackFactor");
        const applied = applyLearnedControlName(c, name);
        expect(applied).toBe(true);
        expect(c.name).toBe("Feedback Factor");
        expect(c.nameSource).toBe("auto");
    });

    it("8 — a legacy control with nameSource undefined receives the Learn name", () => {
        const c = new Control("knob", "Cutoff");
        delete (c as any).nameSource;
        expect(c.nameSource).toBeUndefined();

        const applied = applyLearnedControlName(c, "Cutoff");
        expect(applied).toBe(true);
        expect(c.name).toBe("Cutoff");
        expect(c.nameSource).toBe("auto");
    });

    it("9 — an auto-named control receives a new name on re-Learn", () => {
        const c = new Control("knob", "Old auto name");
        c.nameSource = "auto";
        const applied = applyLearnedControlName(c, "Feedback Factor");
        expect(applied).toBe(true);
        expect(c.name).toBe("Feedback Factor");
        expect(c.nameSource).toBe("auto");
    });

    it("10 — generated Learn names set nameSource to auto", () => {
        const c = new Control("knob", "Knob");
        applyLearnedControlName(c, "Cutoff");
        expect(c.nameSource).toBe("auto");
    });

    it("resolveEntityDisplayName reads entity.fields.displayName.value and is defensive", () => {
        const doc = {
            queryEntities: {
                getEntity: (id: string) =>
                    id === "e1"
                        ? { fields: { displayName: { value: "Proto Box" } } }
                        : undefined,
            },
        };
        expect(resolveEntityDisplayName(doc, "e1")).toBe("Proto Box");
        expect(resolveEntityDisplayName(doc, "missing")).toBeUndefined();
        expect(resolveEntityDisplayName(undefined, "e1")).toBeUndefined();
        expect(resolveEntityDisplayName({ queryEntities: undefined }, "e1")).toBeUndefined();
    });

    it("11 — existing binding behavior remains unchanged (targetName, state, mapping, subscriptions)", () => {
        const device = new Device("D");
        const control = new Control("knob", "Knob");
        device.addControl(control);
        const bm = new BindingManager(device);

        const result: LearnResult = {
            entityId: "entity-1",
            entityType: "stompboxDelay",
            fieldName: "feedbackFactor",
            fieldPath: "stompboxDelay.feedbackFactor",
            value: 0.42,
            valueMapping: { kind: "linear", min: 0, max: 1 } as any,
            targetName: "stompboxDelay / feedbackFactor",
            field: { location: "x", value: 0.42 },
        };
        bm.applyLearnResult(control.id, result);

        expect(control.activeBindingState).toBe("CONNECTED");
        expect(control.audiotoolBindingDefinition?.targetName).toBe("stompboxDelay / feedbackFactor");
        const binding = bm.getActiveBinding(control.id);
        expect(binding).toBeDefined();
        expect(binding?.entityId).toBe("entity-1");
        expect(binding?.fieldPath).toBe("stompboxDelay.feedbackFactor");
        expect(binding?.valueMapping).toBe(result.valueMapping);
        expect(binding?.field).toBe(result.field);

        // Applying an auto name must never disturb the binding.
        applyLearnedControlName(control, "Cutoff");
        expect(control.activeBindingState).toBe("CONNECTED");
        expect(control.audiotoolBindingDefinition?.targetName).toBe("stompboxDelay / feedbackFactor");
        expect(bm.getActiveBinding(control.id)).toBe(binding);
    });

    it("12 — generated name round-trips through serialization with nameSource auto", () => {
        const device = new Device("D");
        const control = new Control("knob", "Knob");
        applyLearnedControlName(control, "Cutoff");
        device.addControl(control);

        const restored = Device.deserialize(device.serialize());
        const restoredCtl = restored.getControl(control.id)!;
        expect(restoredCtl.name).toBe("Cutoff");
        expect(restoredCtl.nameSource).toBe("auto");
    });
});