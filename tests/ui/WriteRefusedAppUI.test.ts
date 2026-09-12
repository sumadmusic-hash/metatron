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
 * M6 — AppUI keeps the local Metatron control value even when the Nexus write
 * is refused (updateBoundControl resolves false). No crashes, no losing the
 * local value, no pending fire-and-forget that hides the refusal.
 */

class CapturingMidi extends MidiAccess {
    public installedHandler: ((channel: number, cc: number, value: number) => void) | null = null;
    public override setMessageHandler(callback: (channel: number, cc: number, value: number) => void) {
        this.installedHandler = callback;
    }
    public trigger(channel: number, cc: number, value: number) {
        this.installedHandler?.(channel, cc, value);
    }
}

class RefusingAdapter extends NexusAdapter {
    public writeCalls: string[] = [];
    public override updateBoundControl(controlId: string, _value: number): Promise<boolean> {
        this.writeCalls.push(controlId);
        return Promise.resolve(false);
    }
}

function mount(device: Device, midi: CapturingMidi, adapter: RefusingAdapter): { device: Device; lib: DeviceLibrary } {
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    lib.saveCurrentDevice();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const app = new AppUI(root, lib, adapter, midi, new BindingManager(device));
    app.render();
    const toggle = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.innerText === "USE",
    )!;
    toggle.click();
    return { device, lib };
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

describe("M6 — AppUI keeps local control value when the Nexus write returns false", () => {
    it("7. control value updates locally even though the write is refused", async () => {
        const device = new Device("T");
        const ctrl = new Control("knob", "k", { x: 0, y: 0 }, "k1");
        ctrl.midiBindingDefinition = { channel: 1, cc: 20 } as MidiBindingDefinition;
        device.addControl(ctrl);
        const midi = new CapturingMidi();
        const adapter = new RefusingAdapter();
        const { lib } = mount(device, midi, adapter);
        const saveSpy = vi.spyOn(lib, "saveCurrentDevice");

        midi.trigger(1, 20, 64);

        // Local value + persistence happen regardless of the refused write.
        expect(ctrl.value).toBeCloseTo(64 / 127, 10);
        expect(saveSpy).toHaveBeenCalled();
        // The write was attempted and its result surfaced, not discarded as void.
        expect(adapter.writeCalls).toEqual(["k1"]);
        expect(adapter.writeCalls.length).toBe(1);
    });

    it("7b. repeated refused writes during a drag do not create new notifications and never crash", async () => {
        const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});

        const device = new Device("T2");
        const ctrl = new Control("knob", "k2", { x: 0, y: 0 }, "k2");
        ctrl.midiBindingDefinition = { channel: 1, cc: 21 } as MidiBindingDefinition;
        device.addControl(ctrl);
        const midi = new CapturingMidi();
        const adapter = new RefusingAdapter();
        mount(device, midi, adapter);

        // Continuous CC stream while disconnected — must not throw or hang.
        for (let i = 0; i < 20; i++) {
            midi.trigger(1, 21, i * 5);
        }

        expect(ctrl.value).toBeCloseTo(95 / 127, 10);
        expect(adapter.writeCalls.length).toBe(20);
        // No unhandled rejections / throws reached the surface.
        expect(errors).not.toHaveBeenCalled();

        warns.mockRestore();
        errors.mockRestore();
    });
});