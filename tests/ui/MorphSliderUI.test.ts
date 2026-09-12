// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { DeviceLibraryUI } from "../../src/ui/DeviceLibraryUI";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";

/**
 * M13 — Morph amount slider is UI state ONLY:
 *  * a range input bound to the transient morphAmount (0..1, step 0.01),
 *  * moves update morphAmount + the percent readout — clamped to 0..1,
 *  * NO morph calculation, NO control.value writes, NO Nexus traffic,
 *  * NO preset loading,
 *  * M12 A/B assignment behavior is untouched.
 */

function makeDevice(name = "T"): Device {
    const device = new Device(name);
    device.addControl(new Control("knob", "Cutoff", { x: 0, y: 0 }, "cutoff"));
    return device;
}

function saveTwoPresets(device: Device): Device {
    const ctrl = device.controls.get("cutoff")!;
    ctrl.value = 0.3;
    device.savePreset("Crunch");
    ctrl.value = 0.8;
    device.savePreset("Clean");
    return device;
}

function mount(device: Device) {
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    lib.saveCurrentDevice();
    const onDeviceChanged = vi.fn();
    const onPresetLoad = vi.fn();
    const adapter = new NexusAdapter();
    const updateSpy = vi.spyOn(adapter, "updateBoundControl").mockResolvedValue(true);
    const ui = new DeviceLibraryUI(lib, onDeviceChanged, onPresetLoad, adapter);
    const root = document.createElement("div");
    document.body.appendChild(root);
    ui.render(root);
    return {
        lib,
        ui,
        root,
        onDeviceChanged,
        onPresetLoad,
        adapter,
        updateSpy,
        device,
    };
}

function slider(root: HTMLElement): HTMLInputElement {
    const el = root.querySelector<HTMLInputElement>(".preset-morph-slider");
    expect(el).toBeTruthy();
    return el!;
}

function percent(root: HTMLElement): string {
    const el = root.querySelector<HTMLElement>(".preset-morph-percent");
    expect(el).toBeTruthy();
    return el!.innerText;
}

function move(slider: HTMLInputElement, value: string) {
    slider.value = value;
    slider.dispatchEvent(new Event("input", { bubbles: true }));
}

function status(root: HTMLElement): string {
    const el = root.querySelector<HTMLElement>(".preset-morph-status");
    expect(el).toBeTruthy();
    return el!.innerText;
}

function slotBtn(root: HTMLElement, presetName: string, slot: "A" | "B") {
    const row = [...root.querySelectorAll<HTMLElement>(".preset-list-item")].find(
        (r) => r.querySelector("span")?.innerText === presetName,
    );
    expect(row).toBeTruthy();
    const btn = [...row!.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.innerText === slot,
    );
    expect(btn).toBeTruthy();
    return btn!;
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

describe("M13 — Morph amount slider UI state", () => {
    it("1. slider exists", () => {
        const device = saveTwoPresets(makeDevice());
        const { root } = mount(device);
        expect(slider(root).type).toBe("range");
    });

    it("2. initial value reflects morphAmount = 0.5", () => {
        const device = saveTwoPresets(makeDevice());
        const { root } = mount(device);
        expect(slider(root).value).toBe("0.5");
        expect(percent(root)).toBe("50%");
    });

    it("3. slider has min=0", () => {
        const device = saveTwoPresets(makeDevice());
        const { root } = mount(device);
        expect(slider(root).min).toBe("0");
    });

    it("4. slider has max=1", () => {
        const device = saveTwoPresets(makeDevice());
        const { root } = mount(device);
        expect(slider(root).max).toBe("1");
    });

    it("5. slider has step=0.01", () => {
        const device = saveTwoPresets(makeDevice());
        const { root } = mount(device);
        expect(slider(root).step).toBe("0.01");
    });

    it("6. moving the slider updates morphAmount", () => {
        const device = saveTwoPresets(makeDevice());
        const { root } = mount(device);
        const s = slider(root);
        move(s, "0.75");
        expect(percent(root)).toBe("75%");
        expect(s.value).toBe("0.75");
    });

    it("7. percentage display updates", () => {
        const device = saveTwoPresets(makeDevice());
        const { root } = mount(device);
        const s = slider(root);
        move(s, "0.12");
        expect(percent(root)).toBe("12%");
        move(s, "1");
        expect(percent(root)).toBe("100%");
    });

    it("8. values below 0 are clamped to 0", () => {
        const device = saveTwoPresets(makeDevice());
        const { root } = mount(device);
        const s = slider(root);
        move(s, "-0.5");
        expect(percent(root)).toBe("0%");
        expect(s.value).toBe("0");
    });

    it("9. values above 1 are clamped to 1", () => {
        const device = saveTwoPresets(makeDevice());
        const { root } = mount(device);
        const s = slider(root);
        move(s, "1.5");
        expect(percent(root)).toBe("100%");
        expect(s.value).toBe("1");
    });

    it("10. moving the slider with no A/B assigned does not modify control values", () => {
        const device = saveTwoPresets(makeDevice());
        const { root, device: dev } = mount(device);
        const ctrl = dev.controls.get("cutoff")!;
        ctrl.value = 0.42;
        const s = slider(root);
        move(s, "0.9");
        expect(ctrl.value).toBe(0.42);
    });

    it("11. moving the slider with A/B assigned applies the morph values once wired (M14)", () => {
        const device = saveTwoPresets(makeDevice());
        const { root, device: dev } = mount(device);
        slotBtn(root, "Crunch", "A").click();
        slotBtn(root, "Clean", "B").click();
        const ctrl = dev.controls.get("cutoff")!;
        ctrl.value = 0.42;
        const s = slider(root);
        move(s, "0.9");
        // A=0.3, B=0.8, t=0.9 → 0.3 + 0.9*0.5 = 0.75 (M14: engine connected).
        expect(ctrl.value).toBeCloseTo(0.75, 10);
    });

    it("12. moving the slider does not call loadPreset", () => {
        const device = saveTwoPresets(makeDevice());
        const { root, onPresetLoad, device: dev } = mount(device);
        const s = slider(root);
        move(s, "0.3");
        expect(onPresetLoad).not.toHaveBeenCalled();
        expect(dev.presets.size).toBe(2);
    });

    it("13. moving the slider does not call updateBoundControl", () => {
        const device = saveTwoPresets(makeDevice());
        const { root, updateSpy } = mount(device);
        slotBtn(root, "Crunch", "A").click();
        slotBtn(root, "Clean", "B").click();
        const s = slider(root);
        move(s, "0.3");
        move(s, "0.7");
        expect(updateSpy).not.toHaveBeenCalled();
    });

    it("14. existing A/B assignment behavior remains unchanged", () => {
        const device = saveTwoPresets(makeDevice());
        const { root, onPresetLoad, device: dev } = mount(device);
        slotBtn(root, "Crunch", "A").click();
        slotBtn(root, "Clean", "B").click();
        expect(status(root)).toContain("A: Crunch");
        expect(status(root)).toContain("B: Clean");
        expect(onPresetLoad).not.toHaveBeenCalled();
        expect(dev.presets.size).toBe(2);
        const ctrl = dev.controls.get("cutoff")!;
        expect(ctrl.value).toBe(0.8);
    });
});