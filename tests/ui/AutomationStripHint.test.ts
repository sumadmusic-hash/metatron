// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { BindingManager } from "../../src/core/BindingManager";
import { AppUI } from "../../src/ui/AppUI";

/**
 * M21.5 — the automation strip shows a live-sound-feedback hint only while a
 * take is ARMED or RECORDING, and never otherwise. The strip buttons keep
 * their exact existing behavior — nothing in the recording engine changed.
 */

const HINT = "Audiotool and Metatron must remain visible at the same time for live sound feedback.";

class NoopMidi extends MidiAccess {
    public override setMessageHandler(_callback: (channel: number, cc: number, value: number) => void) {}
}

class PassingAdapter extends NexusAdapter {
    public override updateBoundControl(_controlId: string, _value: number): Promise<boolean> {
        return Promise.resolve(true);
    }
}

function mount(): { root: HTMLElement } {
    const device = new Device("T");
    device.addControl(new Control("knob", "k", { x: 0, y: 0 }, "k1"));
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    lib.saveCurrentDevice();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const app = new AppUI(root, lib, new PassingAdapter(), new NoopMidi(), new BindingManager(device));
    app.render();
    return { root };
}

function button(root: HTMLElement, label: string): HTMLButtonElement | undefined {
    return [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.innerText === label);
}

function hint(root: HTMLElement): HTMLElement | null {
    return root.querySelector(".automation-hint");
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

describe("M21.5 — automation strip live-feedback hint visibility", () => {
    it("1. IDLE: no hint is shown, strip buttons still present", () => {
        const { root } = mount();
        expect(hint(root)).toBeNull();
        for (const label of ["ARM", "REC", "STOP", "APPLY TO AUDIOTOOL"]) {
            expect(button(root, label)).toBeDefined();
        }
    });

    it("2. ARM -> hint appears with the exact wording", () => {
        const { root } = mount();
        button(root, "ARM")!.click();
        expect(hint(root)).not.toBeNull();
        expect(hint(root)!.innerText).toBe(HINT);
    });

    it("3. RECORDING -> hint stays visible", () => {
        const { root } = mount();
        button(root, "ARM")!.click();
        button(root, "REC")!.click();
        expect(hint(root)).not.toBeNull();
        expect(hint(root)!.innerText).toBe(HINT);
    });

    it("4. STOP -> hint disappears again (STOPPED)", () => {
        const { root } = mount();
        button(root, "ARM")!.click();
        button(root, "REC")!.click();
        button(root, "STOP")!.click();
        expect(hint(root)).toBeNull();
    });

    it("6. ARM/REC/STOP/APPLY buttons remain present and functional through the state flow", () => {
        const { root } = mount();
        // IDLE: only ARM is enabled (REC requires ARM, STOP/APPLY require a take).
        expect(button(root, "ARM")!.disabled).toBe(false);
        expect(button(root, "REC")!.disabled).toBe(true);
        expect(button(root, "STOP")!.disabled).toBe(true);
        expect(button(root, "APPLY TO AUDIOTOOL")!.disabled).toBe(true);

        button(root, "ARM")!.click();
        expect(button(root, "REC")!.disabled).toBe(false);
        expect(button(root, "REC")!.click).toBeDefined();

        button(root, "REC")!.click();
        expect(button(root, "STOP")!.disabled).toBe(false);

        button(root, "STOP")!.click();
        expect(button(root, "ARM")!.disabled).toBe(false);
        expect(button(root, "REC")!.disabled).toBe(true);
    });
});