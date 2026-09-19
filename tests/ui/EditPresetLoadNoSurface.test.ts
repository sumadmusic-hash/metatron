// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { AppUI } from "../../src/ui/AppUI";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { BindingManager } from "../../src/core/BindingManager";

class SilentAdapter extends NexusAdapter {
    public override updateBoundControl(_controlId: string, _value: number): Promise<boolean> {
        return Promise.resolve(true);
    }
}

class SilentMidi extends MidiAccess {
    public override setMessageHandler(_cb: (channel: number, cc: number, value: number) => void) {}
}

function loadButton(root: HTMLElement): HTMLButtonElement {
    const btn = Array.from(root.querySelectorAll<HTMLButtonElement>(".preset-list-item button"))
        .find((b) => b.innerText === "Load");
    if (!btn) throw new Error("Load button not found");
    return btn;
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

describe("AppUI — preset load in EDIT before the USE surface exists", () => {
    it("loads control values and modulation, syncs the runner, then re-renders normally", () => {
        const device = new Device("Edit Preset");
        const cutoff = new Control("knob", "Cutoff", { x: 0, y: 0 }, "cutoff");
        cutoff.value = 0.23;
        device.addControl(cutoff);
        device.modulation.sources[0].waveform = "saw";
        device.modulation.sources[0].rateHz = 4;
        device.modulation.slots[0].enabled = true;
        device.modulation.slots[0].sourceId = "mod1";
        device.modulation.slots[0].destControlId = cutoff.id;
        device.modulation.slots[0].amount = 0.55;
        const preset = device.savePreset("Loaded From Edit");

        cutoff.value = 0.91;
        device.modulation.slots[0].enabled = false;
        device.modulation.slots[0].amount = -0.1;

        const lib = new DeviceLibrary();
        lib.currentDevice = device;
        lib.saveCurrentDevice();
        const root = document.createElement("div");
        document.body.appendChild(root);
        const app = new AppUI(root, lib, new SilentAdapter(), new SilentMidi(), new BindingManager(device));
        app.render();

        expect(root.querySelector(".control-wrapper.use-mode")).toBeNull();
        expect(() => loadButton(root).click()).not.toThrow();

        expect(cutoff.value).toBeCloseTo(0.23, 6);
        expect(device.modulation.sources[0].waveform).toBe("saw");
        expect(device.modulation.slots[0].enabled).toBe(true);
        expect(device.modulation.slots[0].amount).toBe(0.55);
        expect((app as unknown as { modRunnerState: boolean }).modRunnerState).toBe(true);

        expect(() => app.render()).not.toThrow();
        expect(root.querySelector("#preset-name-input")).toBeTruthy();
        expect(device.presets.has(preset.id)).toBe(true);
        app.destroy();
    });
});
