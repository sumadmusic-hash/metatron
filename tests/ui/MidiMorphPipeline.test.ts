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

/**
 * MIDI → Preset-Morph: a fixed, per-device morphMidi binding drives the EXISTING
 * morph regulator. Morph is not a control: no virtual control, no automation
 * track. The handler branch reuses applyMidiScaling + setMorphAmountFromMidi.
 */

class FakeMidiAccess extends MidiAccess {
    public installedHandler: ((channel: number, cc: number, value: number) => void) | null = null;

    public override setMessageHandler(callback: (channel: number, cc: number, value: number) => void) {
        this.installedHandler = callback;
    }

    public trigger(channel: number, cc: number, value: number) {
        this.installedHandler?.(channel, cc, value);
    }
}

/** Device with two presets so a morph application visibly re-values controls. */
function morphDevice(channel = 1, cc = 40, scaling?: Omit<MidiBindingDefinition, "channel" | "cc">): Device {
    const device = new Device("MorphMidi");
    const cutoff = new Control("knob", "Cutoff", { x: 0, y: 0 }, "cutoff");
    const res = new Control("knob", "Resonance", { x: 0, y: 0 }, "res");
    device.addControl(cutoff);
    device.addControl(res);

    cutoff.value = 0.2;
    res.value = 0.9;
    device.savePreset("P-A");
    cutoff.value = 0.8;
    res.value = 0.1;
    device.savePreset("P-B");
    cutoff.value = 0.3;
    res.value = 0.7;

    device.morphMidi = { channel, cc, ...scaling };
    return device;
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
    const toggle = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.innerText === "USE",
    );
    toggle?.click();
    return { root, app, midi, lib };
}

function percent(root: HTMLElement): string {
    const el = root.querySelector<HTMLElement>(".preset-morph-percent");
    expect(el).toBeTruthy();
    return el!.innerText;
}

/** Replaces the public morph entry so tests observe the handler branch in isolation. */
function stubMorph(app: unknown, fn: ReturnType<typeof vi.fn>) {
    (app as any).libraryUI.setMorphAmountFromMidi = fn;
}

function presetRow(root: HTMLElement, name: string): HTMLElement {
    const found = [...root.querySelectorAll<HTMLElement>(".preset-list-item")].find(
        (r) => r.querySelector("span")?.innerText === name,
    );
    expect(found).toBeTruthy();
    return found!;
}

function slotBtn(root: HTMLElement, presetName: string, slot: "A" | "B") {
    const btn = [...presetRow(root, presetName).querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.innerText === slot,
    );
    expect(btn).toBeTruthy();
    return btn!;
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

describe("MIDI → Preset-Morph (fixed per-device CC binding)", () => {
    it("1. channel/cc match feeds setMorphAmountFromMidi with the applyMidiScaling result", () => {
        const device = morphDevice(1, 40);
        const { app, midi } = mount(device);
        const fn = vi.fn();
        stubMorph(app, fn);

        midi.trigger(1, 40, 64);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith(64 / 127);
        midi.trigger(1, 40, 0);
        expect(fn).toHaveBeenCalledWith(0);
        midi.trigger(1, 40, 127);
        expect(fn).toHaveBeenCalledWith(1);

        midi.trigger(1, 41, 100); // unrelated cc → no morph
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it("1b. morph scaling fields flow through the exact applyMidiScaling path", () => {
        const device = morphDevice(1, 40, { min: 0.2, max: 0.9 });
        const { app, midi } = mount(device);
        const fn = vi.fn();
        stubMorph(app, fn);

        midi.trigger(1, 40, 0);
        expect(fn).toHaveBeenCalledWith(0.2);
        midi.trigger(1, 40, 127);
        expect(fn).toHaveBeenCalledWith(expect.closeTo(0.9, 10));
    });

    it("2+3. MIDI 0 → Morph 0 and MIDI 127 → Morph 1 (readout + applied values)", () => {
        const device = morphDevice(1, 40);
        const { root, midi } = mount(device);
        slotBtn(root, "P-A", "A").click();
        slotBtn(root, "P-B", "B").click();

        midi.trigger(1, 40, 0);
        expect(percent(root)).toBe("0%");
        expect(device.controls.get("cutoff")!.value).toBeCloseTo(0.2, 10);
        expect(device.controls.get("res")!.value).toBeCloseTo(0.9, 10);

        midi.trigger(1, 40, 127);
        expect(percent(root)).toBe("100%");
        expect(device.controls.get("cutoff")!.value).toBeCloseTo(0.8, 10);
        expect(device.controls.get("res")!.value).toBeCloseTo(0.1, 10);
    });

    it("4. without morphMidi the existing control MIDI path is unchanged and no morph occurs", () => {
        const device = new Device("Plain");
        const ctrl = new Control("knob", "Cutoff", { x: 0, y: 0 }, "cutoff");
        ctrl.midiBindingDefinition = { channel: 1, cc: 20 };
        device.addControl(ctrl);
        const { root, app, midi } = mount(device);
        const fn = vi.fn();
        stubMorph(app, fn);

        midi.trigger(1, 20, 64);
        expect(ctrl.value).toBeCloseTo(64 / 127, 10);
        expect(percent(root)).toBe("50%");
        expect(fn).not.toHaveBeenCalled();
    });

    it("5. on a CC collision the bound control wins over morph", () => {
        const device = new Device("Collide");
        const ctrl = new Control("knob", "Cutoff", { x: 0, y: 0 }, "cutoff");
        ctrl.midiBindingDefinition = { channel: 1, cc: 40 };
        device.addControl(ctrl);
        device.morphMidi = { channel: 1, cc: 40 };
        const { root, app, midi } = mount(device);
        const fn = vi.fn();
        stubMorph(app, fn);

        midi.trigger(1, 40, 127);
        expect(ctrl.value).toBe(1); // control path applied
        expect(fn).not.toHaveBeenCalled(); // morph NOT used
        expect(percent(root)).toBe("50%");
    });

    it("6. the morph binding is read from the ACTIVE device on every event", () => {
        const devA = morphDevice(1, 41);
        const devB = morphDevice(1, 42);
        const lib = new DeviceLibrary();
        lib.currentDevice = devA;
        lib.saveCurrentDevice();
        const root = document.createElement("div");
        document.body.appendChild(root);
        const midi = new FakeMidiAccess();
        const app = new AppUI(root, lib, new NexusAdapter(), midi, new BindingManager(devA));
        app.render();
        const fn = vi.fn();
        stubMorph(app, fn);

        midi.trigger(1, 41, 100); // A's mapping is active
        expect(fn).toHaveBeenCalledTimes(1);
        midi.trigger(1, 42, 100); // B's mapping is inactive while A is active
        expect(fn).toHaveBeenCalledTimes(1);

        lib.currentDevice = devB; // device switch → next event uses B's config
        midi.trigger(1, 42, 100);
        expect(fn).toHaveBeenCalledTimes(2);
        midi.trigger(1, 41, 100);
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it("7. device without morphMidi produces no morph behavior", () => {
        const device = new Device("NoMorph");
        device.addControl(new Control("knob", "Cutoff", { x: 0, y: 0 }, "cutoff"));
        const { root, app, midi } = mount(device);
        const fn = vi.fn();
        stubMorph(app, fn);

        midi.trigger(1, 40, 127);
        expect(fn).not.toHaveBeenCalled();
        expect(percent(root)).toBe("50%");
    });
});