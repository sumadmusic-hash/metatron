// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { BindingManager } from "../../src/core/BindingManager";
import { AppUI } from "../../src/ui/AppUI";
import type { MidiBindingDefinition } from "../../src/core/model/types";

const settle = (ms = 150) => new Promise<void>((r) => setTimeout(r, ms));

class FakeMidiAccess extends MidiAccess {
    public handler: ((channel: number, cc: number, value: number) => void) | null = null;
    public override setMessageHandler(callback: (channel: number, cc: number, value: number) => void) {
        this.handler = callback;
    }
    public trigger(channel: number, cc: number, value: number) {
        this.handler?.(channel, cc, value);
    }
}

function midiKnob(device: Device, id: string): Control {
    const c = new Control("knob", id, { x: 0, y: 0 }, id);
    c.midiBindingDefinition = { channel: 1, cc: 20 } as MidiBindingDefinition;
    device.addControl(c);
    return c;
}

function mount(device: Device) {
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    lib.saveCurrentDevice();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const midi = new FakeMidiAccess();
    const app = new AppUI(root, lib, new NexusAdapter(), midi, new BindingManager(device));
    app.render();
    return { root, lib, midi, app };
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

describe("AppUI — VALUE-path saves are bundled during fast gestures (P4)", () => {

    it("a rapid MIDI burst collapses into ONE trailing save; the live value updates instantly", async () => {
        const device = new Device("T");
        const control = midiKnob(device, "c");
        const { lib, midi } = mount(device);
        const saveSpy = vi.spyOn(lib, "saveCurrentDevice");

        midi.trigger(1, 20, 32);
        midi.trigger(1, 20, 64);
        midi.trigger(1, 20, 96);

        // The live value updates synchronously with each event.
        expect(control.value).toBeCloseTo(96 / 127, 5);
        // Not yet persisted while the gesture is still running.
        expect(saveSpy).not.toHaveBeenCalled();

        await settle(150);

        // Bundled: one trailing save, not one synchronous write per event.
        expect(saveSpy).toHaveBeenCalledTimes(1);
    });

    it("render() flushes a pending value save before rebuilding the DOM", () => {
        const device = new Device("T2");
        midiKnob(device, "c2");
        const { lib, midi, app } = mount(device);
        const saveSpy = vi.spyOn(lib, "saveCurrentDevice");

        midi.trigger(1, 20, 100);
        expect(saveSpy).not.toHaveBeenCalled();

        // Mode/device switch and other coarse actions rebuild through render()
        // and must NOT lose the trailing value save.
        app.render();
        expect(saveSpy).toHaveBeenCalledTimes(1);
    });
});