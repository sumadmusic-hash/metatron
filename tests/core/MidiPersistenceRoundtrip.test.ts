// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { Storage } from "../../src/persistence/Storage";
import { applyMidiScaling } from "../../src/midi/MidiScaling";

describe("C2 persistence roundtrip — real Storage save→load path (F-1)", () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it("channel/cc/min/max/flip/exponent survive serialize→save→load→deserialize", () => {
        const device = new Device("Scaling");
        const control = new Control("knob", "Cutoff", { x: 0, y: 0 });
        control.midiBindingDefinition = { channel: 1, cc: 20, min: 0.2, max: 0.9, flip: true, exponent: 2 };
        device.addControl(control);

        Storage.saveDevice(device);
        const loaded = Storage.loadDevice(device.id);

        expect(loaded).toBeDefined();
        const roundtripped = loaded!.getControl(control.id);
        expect(roundtripped?.midiBindingDefinition).toEqual({
            channel: 1, cc: 20, min: 0.2, max: 0.9, flip: true, exponent: 2,
        });

        // the persisted scaling is actually effective after reloading
        const t = 64 / 127;
        expect(applyMidiScaling(64, roundtripped?.midiBindingDefinition)).toBeCloseTo(0.2 + 0.7 * Math.pow(1 - t, 2), 10);
    });

    it("legacy {channel, cc} survives roundtrip without gaining any scaling keys", () => {
        const device = new Device("Legacy");
        const control = new Control("knob", "Reso", { x: 0, y: 0 });
        control.midiBindingDefinition = { channel: 1, cc: 20 };
        device.addControl(control);

        Storage.saveDevice(device);
        const loaded = Storage.loadDevice(device.id);

        const definition = loaded!.getControl(control.id)!.midiBindingDefinition!;
        expect(definition).toEqual({ channel: 1, cc: 20 });
        expect(Object.keys(definition).sort()).toEqual(["cc", "channel"]);
        expect(applyMidiScaling(64, definition)).toBeCloseTo(64 / 127, 10);
    });
});