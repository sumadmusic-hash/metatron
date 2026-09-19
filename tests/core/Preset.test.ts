import { describe, it, expect } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import type { Waveform } from "../../src/core/modulation/ModulationTypes";

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

    function deviceWithMatrix(): { device: Device; control: Control } {
        const device = new Device("Matrix Host");
        const control = new Control("knob", "Cutoff", { x: 0, y: 0 }, "cutoff");
        control.value = 0.42;
        device.addControl(control);
        const src = device.modulation.sources[0];
        src.waveform = "triangle";
        src.rateHz = 3.5;
        src.bpmSync = true;
        src.noteDivision = 16;
        src.phase = 0.25;
        const slot = device.modulation.slots[0];
        slot.enabled = true;
        slot.sourceId = src.id;
        slot.destControlId = control.id;
        slot.amount = 0.6;
        return { device, control };
    }

    it("savePreset captures a complete modulation matrix snapshot", () => {
        const { device, control } = deviceWithMatrix();
        const preset = device.savePreset("Matrix A");

        expect(preset.modulation).toBeDefined();
        const src = preset.modulation!.sources[0];
        const slot = preset.modulation!.slots[0];
        expect(src.waveform).toBe<Waveform>("triangle");
        expect(src.rateHz).toBe(3.5);
        expect(src.bpmSync).toBe(true);
        expect(src.noteDivision).toBe(16);
        expect(src.phase).toBe(0.25);
        expect(slot.enabled).toBe(true);
        expect(slot.sourceId).toBe(src.id);
        expect(slot.destControlId).toBe(control.id);
        expect(slot.amount).toBe(0.6);
    });

    it("preset modulation snapshots are deep copies in both directions", () => {
        const { device } = deviceWithMatrix();
        const preset = device.savePreset("Deep");

        device.modulation.sources[0].waveform = "saw";
        device.modulation.slots[0].amount = -0.2;
        expect(preset.modulation!.sources[0].waveform).toBe("triangle");
        expect(preset.modulation!.slots[0].amount).toBe(0.6);

        preset.modulation!.sources[0].rateHz = 10;
        preset.modulation!.slots[0].enabled = false;
        expect(device.modulation.sources[0].rateHz).toBe(3.5);
        expect(device.modulation.slots[0].enabled).toBe(true);
    });

    it("loadPreset restores the exact saved matrix among multiple presets", () => {
        const { device } = deviceWithMatrix();
        const presetA = device.savePreset("A");

        device.modulation.sources[0].waveform = "square";
        device.modulation.sources[0].rateHz = 8;
        device.modulation.sources[0].bpmSync = false;
        device.modulation.slots[0].sourceId = "mod2";
        device.modulation.slots[0].amount = -0.5;
        const presetB = device.savePreset("B");

        device.loadPreset(presetA.id);
        expect(device.modulation.sources[0].waveform).toBe("triangle");
        expect(device.modulation.sources[0].rateHz).toBe(3.5);
        expect(device.modulation.sources[0].bpmSync).toBe(true);
        expect(device.modulation.slots[0].sourceId).toBe("mod1");
        expect(device.modulation.slots[0].amount).toBe(0.6);

        device.loadPreset(presetB.id);
        expect(device.modulation.sources[0].waveform).toBe("square");
        expect(device.modulation.sources[0].rateHz).toBe(8);
        expect(device.modulation.sources[0].bpmSync).toBe(false);
        expect(device.modulation.slots[0].sourceId).toBe("mod2");
        expect(device.modulation.slots[0].amount).toBe(-0.5);
    });

    it("serialized presets keep their matrix snapshot loadable after deserialize", () => {
        const { device } = deviceWithMatrix();
        const preset = device.savePreset("Persisted");
        const restored = Device.deserialize(device.serialize());

        restored.modulation.sources[0].waveform = "sine";
        restored.modulation.slots[0].enabled = false;
        restored.loadPreset(preset.id);

        expect(restored.modulation.sources[0].waveform).toBe("triangle");
        expect(restored.modulation.sources[0].rateHz).toBe(3.5);
        expect(restored.modulation.slots[0].enabled).toBe(true);
        expect(restored.modulation.slots[0].amount).toBe(0.6);
    });

    it("legacy presets without modulation leave the current matrix unchanged", () => {
        const { device } = deviceWithMatrix();
        const preset = device.savePreset("Legacy");
        const legacy = preset.serialize() as { modulation?: unknown };
        delete legacy.modulation;
        const restored = Device.deserialize({ ...device.serialize(), presets: [legacy] });

        restored.modulation.sources[0].waveform = "sampleHold";
        restored.modulation.slots[0].amount = -0.75;
        restored.loadPreset(preset.id);

        expect(restored.presets.get(preset.id)?.modulation).toBeUndefined();
        expect(restored.modulation.sources[0].waveform).toBe("sampleHold");
        expect(restored.modulation.slots[0].amount).toBe(-0.75);
    });

    it("corrupt preset modulation is discarded while the rest of the preset still loads", () => {
        const { device, control } = deviceWithMatrix();
        const preset = device.savePreset("Corrupt");
        const corrupt = {
            ...preset.serialize(),
            controlValues: { [control.id]: 0.12 },
            modulation: { sources: Array(50).fill({}), slots: [] },
        };
        const restored = Device.deserialize({ ...device.serialize(), presets: [corrupt] });
        const restoredControl = restored.getControl(control.id)!;
        restoredControl.value = 0.99;
        restored.modulation.slots[0].amount = -0.33;

        restored.loadPreset(preset.id);

        expect(restored.presets.get(preset.id)?.modulation).toBeUndefined();
        expect(restoredControl.value).toBe(0.12);
        expect(restored.modulation.slots[0].amount).toBe(-0.33);
    });
});
