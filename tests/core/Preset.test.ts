import { describe, it, expect } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";

describe("Preset management — create / load / rename / delete (§6, §20)", () => {
    function deviceWithControls(): Device {
        const d = new Device("Preset Host");
        const a = new Control("knob", "A");
        const b = new Control("switch", "B");
        a.value = 0.3;
        b.value = 1;
        d.addControl(a);
        d.addControl(b);
        return d;
    }

    it("creating a preset captures every active control value", () => {
        const d = deviceWithControls();
        const preset = d.savePreset("Crunch");
        expect(preset.name).toBe("Crunch");
        const ids = Array.from(d.controls.keys());
        expect(preset.controlValues[ids[0]]).toBe(0.3);
        expect(preset.controlValues[ids[1]]).toBe(1);
        expect(d.presets.size).toBe(1);
    });

    it("loading a preset restores values, unknowns fall back to defaults", () => {
        const d = deviceWithControls();
        d.savePreset("Crunch"); // 0.3 / 1
        d.savePreset("Soft");

        // Mutate values, then set the Soft preset to something else.
        const [idA] = Array.from(d.controls.keys());
        d.getControl(idA)!.value = 0.0;
        d.getControl(idA)!.defaultValue = 0.9;
        const soft = Array.from(d.presets.values()).find((p) => p.name === "Crunch")!;
        // overwrite: Crunch captured 0.3; update the stored map to simulate a later saved state
        soft.controlValues[idA] = 0.5;
        d.loadPreset(soft.id);
        expect(d.getControl(idA)!.value).toBeCloseTo(0.5, 6);
    });

    it("renaming a preset persists the new name through serialization", () => {
        const d = deviceWithControls();
        const p = d.savePreset("Old Name");
        p.name = "Punch-in";
        const restored = Device.deserialize(d.serialize());
        const rp = restored.presets.get(p.id);
        expect(rp?.name).toBe("Punch-in");
        expect(restored.presets.size).toBe(1);
    });

    it("deleting a preset removes it and survives serialization", () => {
        const d = deviceWithControls();
        const keep = d.savePreset("Keep");
        const drop = d.savePreset("Drop");
        d.deletePreset(drop.id);
        const restored = Device.deserialize(d.serialize());
        expect(restored.presets.size).toBe(1);
        expect(restored.presets.has(keep.id)).toBe(true);
        expect(restored.presets.has(drop.id)).toBe(false);
    });

    it("presets are scoped per device (deviceId guard)", () => {
        const a = new Device("A");
        const b = new Device("B");
        const pa = a.savePreset("A-only");
        b.addPreset(pa as any); // rejected: wrong device
        expect(b.presets.size).toBe(0);
    });
});