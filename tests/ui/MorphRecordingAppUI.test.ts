// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { BindingManager } from "../../src/core/BindingManager";
import { AppUI } from "../../src/ui/AppUI";

/**
 * Morph → AutomationRecorder wiring at the AppUI boundary:
 *   DeviceLibraryUI.applyMorph reports every actually-changed control through
 *   the injected callback; AppUI forwards it to recorder.capture — EXCEPT for
 *   controls the ModulationRunner is currently modulating (the runner owns the
 *   capture of those destinations, same guard as applyValueToDevice).
 */

class CapturingMidi extends MidiAccess {
    public override setMessageHandler(_cb: (channel: number, cc: number, value: number) => void) {}
}

class SilentAdapter extends NexusAdapter {
    public override updateBoundControl(_id: string, _v: number): Promise<boolean> {
        return Promise.resolve(true);
    }
}

function makeDevice(): { device: Device } {
    const device = new Device("MorphRec");
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

    // Live values DISTINCT from the morph result at 0.5 → both controls change.
    cutoff.value = 0.3;
    res.value = 0.7;
    return { device };
}

function mount(device: Device) {
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    lib.saveCurrentDevice();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const app = new AppUI(root, lib, new SilentAdapter(), new CapturingMidi(), new BindingManager(device));
    app.render();
    const toggle = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.id === "mode-toggle-btn",
    );
    toggle?.click();

    const recorder = (app as any).recorder as { capture: ReturnType<typeof vi.fn> };
    recorder.capture = vi.fn(recorder.capture as any);
    return { root, app, recorder };
}

function slider(root: HTMLElement): HTMLInputElement {
    const el = root.querySelector<HTMLInputElement>(".preset-morph-slider");
    expect(el).toBeTruthy();
    return el!;
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

function move(s: HTMLInputElement, value: string) {
    s.value = value;
    s.dispatchEvent(new Event("input", { bubbles: true }));
}

function selectSlotsAndMorph(root: HTMLElement, value: string) {
    slotBtn(root, "P-A", "A").click();
    slotBtn(root, "P-B", "B").click();
    move(slider(root), value);
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

describe("Morph → AutomationRecorder at the AppUI boundary", () => {
    it("modulated control: morph produces NO additional capture for it (runner owns it)", () => {
        const { device } = makeDevice();
        const { root, recorder, app } = mount(device);
        vi.spyOn((app as any).modRunner, "isModulated").mockImplementation((id: string) => id === "cutoff");

        selectSlotsAndMorph(root, "0.5");

        // cutoff is modulated → never re-captured by Morph (0.5 would have been the value).
        expect(recorder.capture).not.toHaveBeenCalledWith("cutoff", 0.5, "knob");
        // res changed (0.7 → 0.5) and is not modulated → captured with applied local value.
        expect(recorder.capture).toHaveBeenCalledWith("res", 0.5, "knob");
        expect(device.controls.get("cutoff")!.value).toBeCloseTo(0.5, 10);
        vi.restoreAllMocks();
    });

    it("non-modulated changed controls are captured with the applied local value", () => {
        const { device } = makeDevice();
        const { root, recorder, app } = mount(device);
        vi.spyOn((app as any).modRunner, "isModulated").mockReturnValue(false);

        selectSlotsAndMorph(root, "0.5");

        expect(recorder.capture).toHaveBeenCalledWith("cutoff", 0.5, "knob");
        expect(recorder.capture).toHaveBeenCalledWith("res", 0.5, "knob");
        vi.restoreAllMocks();
    });

    it("moving the slider with A/B unset reports nothing", () => {
        const { root, recorder } = mount(makeDevice().device);
        move(slider(root), "0.4");

        expect(recorder.capture).not.toHaveBeenCalled();
    });
});