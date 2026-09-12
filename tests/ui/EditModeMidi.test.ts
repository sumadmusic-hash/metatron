// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { BindingManager } from "../../src/core/BindingManager";
import { AppUI } from "../../src/ui/AppUI";
import type { MidiBindingDefinition } from "../../src/core/model/types";

class FakeMidiAccess extends MidiAccess {
    public installedHandler: ((channel: number, cc: number, value: number) => void) | null = null;
    public override setMessageHandler(callback: (channel: number, cc: number, value: number) => void) {
        this.installedHandler = callback;
    }
    public trigger(channel: number, cc: number, value: number) {
        this.installedHandler?.(channel, cc, value);
    }
}

describe("EDIT mode MIDI handling", () => {
    it("incoming value update before Surface render does not throw and updates model", () => {
        const device = new Device("T1");
        const c = new Control("knob", "Cut", { x: 0, y: 0 }, "cut");
        c.midiBindingDefinition = { channel: 1, cc: 20 } as MidiBindingDefinition;
        device.addControl(c);

        const lib = new DeviceLibrary();
        lib.currentDevice = device;
        lib.saveCurrentDevice();

        const root = document.createElement("div");
        document.body.appendChild(root);
        const midi = new FakeMidiAccess();
        const app = new AppUI(root, lib, new NexusAdapter(), midi, new BindingManager(device));
        app.render();

        // App starts in EDIT mode by default.
        expect(() => {
            midi.trigger(1, 20, 64);
        }).not.toThrow();

        // Model value was updated and persisted
        expect(c.value).toBeCloseTo(64 / 127, 2);
    });

    it("after switching to USE mode, subsequent update updates the visible control normally", () => {
        const device = new Device("T2");
        const c = new Control("knob", "Cut", { x: 0, y: 0 }, "cut2");
        c.midiBindingDefinition = { channel: 1, cc: 20 } as MidiBindingDefinition;
        device.addControl(c);

        const lib = new DeviceLibrary();
        lib.currentDevice = device;
        lib.saveCurrentDevice();

        const root = document.createElement("div");
        document.body.appendChild(root);
        const midi = new FakeMidiAccess();
        const app = new AppUI(root, lib, new NexusAdapter(), midi, new BindingManager(device));
        app.render();

        // Switch to USE mode
        const modeToggle = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
            b.innerText === "USE",
        )!;
        modeToggle.click();

        midi.trigger(1, 20, 127);

        expect(c.value).toBe(1);
        const indicator = root.querySelector(`[data-ctl-id="${c.id}"] .knob-indicator`) as HTMLElement | null;
        expect(indicator).not.toBeNull();
        expect(indicator!.style.transform).toBe("rotate(135deg)");
    });
});
