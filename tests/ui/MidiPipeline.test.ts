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

/** Captures the handler AppUI installs so tests can drive the MIDI pipeline. */
class FakeMidiAccess extends MidiAccess {
    public installedHandler: ((channel: number, cc: number, value: number) => void) | null = null;

    public override setMessageHandler(callback: (channel: number, cc: number, value: number) => void) {
        this.installedHandler = callback;
    }

    public trigger(channel: number, cc: number, value: number) {
        this.installedHandler?.(channel, cc, value);
    }
}

function addKnob(device: Device, id: string, def?: MidiBindingDefinition): Control {
    const c = new Control("knob", id, { x: 0, y: 0 }, id);
    c.midiBindingDefinition = def;
    device.addControl(c);
    return c;
}

function mount(device: Device): { device: Device; midi: FakeMidiAccess; lib: DeviceLibrary } {
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    lib.saveCurrentDevice();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const midi = new FakeMidiAccess();
    const app = new AppUI(root, lib, new NexusAdapter(), midi, new BindingManager(device));
    app.render();
    // applyValueToDevice writes into the surface DOM — mount the USE surface first.
    const toggle = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.innerText === "USE",
    )!;
    toggle.click();
    return { device, midi, lib };
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

describe("Midi→AppUI pipeline — single normalization point via applyMidiScaling (C2 §6)", () => {
    it("legacy {channel, cc} mapping keeps the exact raw/127 behavior", () => {
        const device = new Device("T");
        const ctrl = addKnob(device, "clegacy", { channel: 1, cc: 20 });
        const { midi } = mount(device);

        midi.trigger(1, 20, 64);
        expect(ctrl.value).toBeCloseTo(64 / 127, 10);
        midi.trigger(1, 20, 0);
        expect(ctrl.value).toBe(0);
        midi.trigger(1, 20, 127);
        expect(ctrl.value).toBe(1);
    });

    it("min/max scaling is applied at the MIDI entry point", () => {
        const device = new Device("T");
        const ctrl = addKnob(device, "cscale", { channel: 1, cc: 21, min: 0.2, max: 0.9 });
        const { midi } = mount(device);

        midi.trigger(1, 21, 0);
        expect(ctrl.value).toBeCloseTo(0.2, 10);
        midi.trigger(1, 21, 127);
        expect(ctrl.value).toBeCloseTo(0.9, 10);
    });

    it("flip + exponent are actually effective via applyMidiScaling", () => {
        const device = new Device("T");
        const ctrl = addKnob(device, "cfx", { channel: 1, cc: 22, flip: true, exponent: 2 });
        const { midi } = mount(device);

        midi.trigger(1, 22, 64);
        expect(ctrl.value).toBeCloseTo(Math.pow(1 - 64 / 127, 2), 10);
        midi.trigger(1, 22, 0);
        expect(ctrl.value).toBeCloseTo(1, 10);
    });

    it("result lands on the correct Control.value and the saveCurrentDevice path stays active", () => {
        const device = new Device("T");
        const target = addKnob(device, "a", { channel: 1, cc: 23 });
        addKnob(device, "b", { channel: 1, cc: 24 });
        const { midi, lib } = mount(device);
        const saveSpy = vi.spyOn(lib, "saveCurrentDevice");

        midi.trigger(1, 24, 64);
        expect(target.value).toBe(0); // sibling untouched
        expect(device.getControl("b")!.value).toBeCloseTo(64 / 127, 10);
        expect(saveSpy).toHaveBeenCalled();
    });

    it("an unknown MIDI mapping mutates nothing and does not throw", () => {
        const device = new Device("T");
        const ctrl = addKnob(device, "only", { channel: 1, cc: 25 });
        const { midi } = mount(device);

        midi.trigger(2, 99, 127);
        expect(ctrl.value).toBe(0);
        midi.trigger(1, 25, 127);
        expect(ctrl.value).toBe(1);
    });

    it("archived controls stay excluded from the MIDI pipeline", () => {
        const device = new Device("T");
        const archived = addKnob(device, "gone", { channel: 3, cc: 30 });
        archived.softDelete();
        const live = addKnob(device, "live", { channel: 3, cc: 31 });
        const { midi } = mount(device);

        midi.trigger(3, 30, 100);
        expect(archived.value).toBe(0);
        midi.trigger(3, 31, 64);
        expect(live.value).toBeCloseTo(64 / 127, 10);
    });
});