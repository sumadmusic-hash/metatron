import { describe, it, expect, beforeEach } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { MidiMapping } from "../../src/midi/MidiMapping";
import type { MidiBindingDefinition } from "../../src/core/model/types";

describe("MidiMapping — assign, replace, clear, forward + reverse (C2 §7)", () => {
    let device: Device;
    let mapping: MidiMapping;
    let ctrl: Control;

    beforeEach(() => {
        device = new Device("Test");
        ctrl = new Control("knob", "Cutoff", { x: 0, y: 0 });
        device.addControl(ctrl);
        mapping = new MidiMapping(device);
    });

    it("assigns a normal mapping and routes it forward", () => {
        mapping.setMapping(ctrl.id, 1, 20);
        expect(mapping.getControlIdForMessage(1, 20)).toBe(ctrl.id);
        expect(mapping.getControlIdForMessage(1, 21)).toBeUndefined();
        expect(mapping.getControlIdForMessage(2, 20)).toBeUndefined();
    });

    it("setMapping without scaling produces exactly the legacy `{channel, cc}` shape", () => {
        mapping.setMapping(ctrl.id, 1, 20);
        expect(ctrl.midiBindingDefinition).toEqual({ channel: 1, cc: 20 });
        expect(Object.keys(ctrl.midiBindingDefinition ?? {}).sort()).toEqual(["cc", "channel"]);
    });

    it("replacing a mapping updates channel/cc and drops the old route", () => {
        mapping.setMapping(ctrl.id, 1, 20);
        mapping.setMapping(ctrl.id, 2, 30);
        expect(mapping.getControlIdForMessage(1, 20)).toBeUndefined();
        expect(mapping.getControlIdForMessage(2, 30)).toBe(ctrl.id);
        expect(ctrl.midiBindingDefinition).toEqual({ channel: 2, cc: 30 });
    });

    it("clearMapping removes the mapping entirely", () => {
        mapping.setMapping(ctrl.id, 1, 20);
        mapping.clearMapping(ctrl.id);
        expect(ctrl.midiBindingDefinition).toBeUndefined();
        expect(mapping.getControlIdForMessage(1, 20)).toBeUndefined();
        expect(mapping.getMappingForControl(ctrl.id)).toBeUndefined();
    });

    it("getMappingForControl returns the current definition (no copy engine)", () => {
        mapping.setMapping(ctrl.id, 1, 20);
        expect(mapping.getMappingForControl(ctrl.id)).toEqual({ channel: 1, cc: 20 });
        expect(mapping.getMappingForControl(ctrl.id)).toBe(ctrl.midiBindingDefinition);
    });

    it("unknown control: setMapping/clearMapping are no-ops, getMappingForControl is undefined", () => {
        mapping.setMapping("nope", 1, 20);
        expect(mapping.getControlIdForMessage(1, 20)).toBeUndefined();
        mapping.clearMapping("nope"); // must not throw
        expect(mapping.getMappingForControl("nope")).toBeUndefined();
        expect(mapping.getMappingForControl(ctrl.id)).toBeUndefined();
    });

    it("archived controls are excluded from forward and reverse lookups", () => {
        mapping.setMapping(ctrl.id, 1, 20);
        expect(mapping.getControlIdForMessage(1, 20)).toBe(ctrl.id);

        ctrl.softDelete();
        mapping.updateDevice(device);
        expect(mapping.getControlIdForMessage(1, 20)).toBeUndefined();
        expect(mapping.getMappingForControl(ctrl.id)).toBeUndefined();
        // the stored mapping still exists on the control, it is just not usable
        expect(ctrl.midiBindingDefinition).toEqual({ channel: 1, cc: 20 });
    });

    it("updateDevice rebuilds the map for a different device", () => {
        const other = new Device("Other");
        const otherCtrl = new Control("knob", "Reso", { x: 0, y: 0 });
        other.addControl(otherCtrl);
        otherCtrl.midiBindingDefinition = { channel: 1, cc: 10 };

        mapping.setMapping(ctrl.id, 1, 10);
        expect(mapping.getControlIdForMessage(1, 10)).toBe(ctrl.id);

        mapping.updateDevice(other);
        expect(mapping.getControlIdForMessage(1, 10)).toBe(otherCtrl.id);
        expect(mapping.getMappingForControl(otherCtrl.id)).toEqual({ channel: 1, cc: 10 });
        expect(mapping.getMappingForControl(ctrl.id)).toBeUndefined();
    });

    it("existing scaling fields survive setMapping (channel/cc replaced only)", () => {
        ctrl.midiBindingDefinition = { channel: 1, cc: 20, min: 0.2, max: 0.9, flip: true, exponent: 2 };
        mapping.setMapping(ctrl.id, 2, 30);
        expect(ctrl.midiBindingDefinition).toEqual({
            channel: 2, cc: 30, min: 0.2, max: 0.9, flip: true, exponent: 2,
        });
        expect(mapping.getControlIdForMessage(2, 30)).toBe(ctrl.id);
        expect(mapping.getControlIdForMessage(1, 20)).toBeUndefined();
    });

    it("partial scaling fields are preserved byte-identically — no defaults injected", () => {
        ctrl.midiBindingDefinition = { channel: 1, cc: 20, exponent: 0 } satisfies MidiBindingDefinition;
        mapping.setMapping(ctrl.id, 3, 45);
        // exponent stays 0: setMapping never sanitizes (that is apply-time concern, Step 4)
        expect(ctrl.midiBindingDefinition).toEqual({ channel: 3, cc: 45, exponent: 0 });
    });

    it("legacy {channel, cc} mappings keep working and stay structurally unchanged", () => {
        ctrl.midiBindingDefinition = { channel: 0, cc: 14 };
        mapping.updateDevice(device);
        expect(mapping.getControlIdForMessage(0, 14)).toBe(ctrl.id);

        mapping.setMapping(ctrl.id, 4, 60);
        expect(ctrl.midiBindingDefinition).toEqual({ channel: 4, cc: 60 });
        expect(Object.keys(ctrl.midiBindingDefinition ?? {}).sort()).toEqual(["cc", "channel"]);
    });

    it("forward and reverse lookups are consistent", () => {
        const c2 = new Control("switch", "Bypass", { x: 0, y: 0 });
        device.addControl(c2);
        mapping.setMapping(ctrl.id, 1, 20);
        mapping.setMapping(c2.id, 2, 30);

        for (const control of [ctrl, c2]) {
            const definition = mapping.getMappingForControl(control.id);
            expect(definition).toBeDefined();
            expect(mapping.getControlIdForMessage(definition!.channel!, definition!.cc!)).toBe(control.id);
        }
        expect(mapping.getMappingForControl(ctrl.id)).toEqual({ channel: 1, cc: 20 });
        expect(mapping.getMappingForControl(c2.id)).toEqual({ channel: 2, cc: 30 });
    });

    it("an incompletely mapped control (missing channel/cc) is not suitable in either direction", () => {
        ctrl.midiBindingDefinition = { cc: 20 };
        mapping.updateDevice(device);
        expect(mapping.getControlIdForMessage(1, 20)).toBeUndefined();
        expect(mapping.getMappingForControl(ctrl.id)).toBeUndefined();
    });
});