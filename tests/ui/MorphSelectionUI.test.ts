// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { DeviceLibraryUI } from "../../src/ui/DeviceLibraryUI";

/**
 * M12 — Morph A/B selection is pure transient UI state:
 *  * A/B slot clicks store ONLY the preset id — never load, never change
 *    control values, never touch Nexus, never trigger a full app render.
 *  * Slots are device-scoped: cleared when the active device changes.
 *  * Deleting an assigned preset clears its slot.
 *  * Nothing morph-related is (de)serialized.
 */

function makeDevice(name = "T"): Device {
    const device = new Device(name);
    device.addControl(new Control("knob", "Cutoff", { x: 0, y: 0 }, "cutoff"));
    return device;
}

function saveTwoPresets(device: Device): { crunchId: string; cleanId: string } {
    const ctrl = device.controls.get("cutoff")!;
    ctrl.value = 0.3;
    const crunch = device.savePreset("Crunch");
    ctrl.value = 0.8;
    const clean = device.savePreset("Clean");
    return { crunchId: crunch.id, cleanId: clean.id };
}

function mount(device: Device) {
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    lib.saveCurrentDevice();
    const onDeviceChanged = vi.fn();
    const onPresetLoad = vi.fn();
    const ui = new DeviceLibraryUI(lib, onDeviceChanged, onPresetLoad);
    const root = document.createElement("div");
    document.body.appendChild(root);
    ui.render(root);
    return { lib, ui, root, onDeviceChanged, onPresetLoad, device };
}

function row(root: HTMLElement, name: string): HTMLElement {
    const found = [...root.querySelectorAll<HTMLElement>(".preset-list-item")].find(
        (r) => r.querySelector("span")?.innerText === name,
    );
    expect(found).toBeTruthy();
    return found!;
}

function slotBtn(root: HTMLElement, presetName: string, slot: "A" | "B") {
    const btn = [...row(root, presetName).querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.innerText === slot,
    );
    expect(btn).toBeTruthy();
    return btn!;
}

function delBtn(root: HTMLElement, presetName: string) {
    const btn = [...row(root, presetName).querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.innerText === "✕",
    );
    expect(btn).toBeTruthy();
    return btn!;
}

function status(root: HTMLElement): string {
    const el = root.querySelector<HTMLElement>(".preset-morph-status");
    expect(el).toBeTruthy();
    return el!.innerText;
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

describe("M12 — Morph A/B selection UI state", () => {
    it("1. A can be assigned a preset ID", () => {
        const device = makeDevice();
        saveTwoPresets(device);
        const { root } = mount(device);

        slotBtn(root, "Crunch", "A").click();

        expect(status(root)).toContain("A: Crunch");
        expect(status(root)).toContain("B: —");
        expect(slotBtn(root, "Crunch", "A").className).toContain("active");
    });

    it("2. B can be assigned a preset ID", () => {
        const device = makeDevice();
        saveTwoPresets(device);
        const { root } = mount(device);

        slotBtn(root, "Clean", "B").click();

        expect(status(root)).toContain("A: —");
        expect(status(root)).toContain("B: Clean");
        expect(slotBtn(root, "Clean", "B").className).toContain("active");
    });

    it("3. A and B can reference different presets", () => {
        const device = makeDevice();
        saveTwoPresets(device);
        const { root } = mount(device);

        slotBtn(root, "Crunch", "A").click();
        slotBtn(root, "Clean", "B").click();

        expect(status(root)).toContain("A: Crunch");
        expect(status(root)).toContain("B: Clean");
    });

    it("4. assigning a new A replaces the previous A", () => {
        const device = makeDevice();
        saveTwoPresets(device);
        const { root } = mount(device);

        slotBtn(root, "Crunch", "A").click();
        slotBtn(root, "Clean", "A").click();

        expect(status(root)).toContain("A: Clean");
        expect(status(root)).not.toContain("A: Crunch");
        expect(slotBtn(root, "Crunch", "A").className).not.toContain("active");
        expect(slotBtn(root, "Clean", "A").className).toContain("active");
    });

    it("5. assigning a new B replaces the previous B", () => {
        const device = makeDevice();
        saveTwoPresets(device);
        const { root } = mount(device);

        slotBtn(root, "Clean", "B").click();
        slotBtn(root, "Crunch", "B").click();

        expect(status(root)).toContain("B: Crunch");
        expect(status(root)).not.toContain("B: Clean");
    });

    it("6. A/B selection does NOT call loadPreset (no onPresetLoad, no preset count change)", () => {
        const device = makeDevice();
        saveTwoPresets(device);
        const { root, onPresetLoad, device: dev } = mount(device);
        const before = dev.presets.size;

        slotBtn(root, "Crunch", "A").click();
        slotBtn(root, "Crunch", "B").click();

        expect(onPresetLoad).not.toHaveBeenCalled();
        expect(dev.presets.size).toBe(before);
    });

    it("7. A/B selection does NOT change control values", () => {
        const device = makeDevice();
        saveTwoPresets(device);
        const ctrl = device.controls.get("cutoff")!;
        ctrl.value = 0.55;
        const { root } = mount(device);

        slotBtn(root, "Crunch", "A").click();
        slotBtn(root, "Clean", "B").click();

        expect(ctrl.value).toBe(0.55);
    });

    it("8. A/B state resets when the active device changes", () => {
        const device = makeDevice("First");
        saveTwoPresets(device);
        const second = makeDevice("Second");
        second.controls.get("cutoff")!.value = 0.2;
        const s2Crunch = second.savePreset("Dirty");

        const { lib, ui, root } = mount(device);
        slotBtn(root, "Crunch", "A").click();
        slotBtn(root, "Clean", "B").click();
        expect(status(root)).toContain("A: Crunch");

        lib.currentDevice = second;
        ui.render(root);

        expect(status(root)).toContain("A: —");
        expect(status(root)).toContain("B: —");
        expect(s2Crunch).toBeTruthy();
    });

    it("9. deleting the A preset clears A", () => {
        const device = makeDevice();
        saveTwoPresets(device);
        const { root } = mount(device);

        slotBtn(root, "Crunch", "A").click();
        expect(status(root)).toContain("A: Crunch");

        delBtn(root, "Crunch").click();

        expect([...row(root, "Clean").querySelectorAll("span")].length).toBeGreaterThan(0);
        expect(status(root)).toContain("A: —");
    });

    it("10. deleting the B preset clears B", () => {
        const device = makeDevice();
        saveTwoPresets(device);
        const { root } = mount(device);

        slotBtn(root, "Clean", "B").click();
        expect(status(root)).toContain("B: Clean");

        delBtn(root, "Clean").click();

        expect(status(root)).toContain("B: —");
    });

    it("11. morph state is not serialized", () => {
        const device = makeDevice();
        saveTwoPresets(device);
        const { root } = mount(device);

        slotBtn(root, "Crunch", "A").click();
        slotBtn(root, "Clean", "B").click();

        const json = JSON.stringify(device.serialize());
        expect(json).not.toContain("morph");
        (device.serialize() as Record<string, unknown>);
        // Persisted preset objects stay {:id, :name, :deviceId, :controlValues}
        [...device.presets.values()].forEach((p) => {
            const keys = Object.keys(p.serialize()).sort();
            expect(keys).toEqual(["controlValues", "deviceId", "id", "name"]);
        });
    });

    it("12. existing preset load behavior remains unchanged", () => {
        const device = makeDevice();
        saveTwoPresets(device);
        const ctrl = device.controls.get("cutoff")!;
        ctrl.value = 0.5;
        const { root, onPresetLoad, onDeviceChanged } = mount(device);

        slotBtn(root, "Crunch", "A").click();
        expect(onPresetLoad).not.toHaveBeenCalled();

        const loadClean = [...row(root, "Clean").querySelectorAll<HTMLButtonElement>("button")].find(
            (b) => b.innerText === "Load",
        )!;
        loadClean.click();

        expect(ctrl.value).toBe(0.8);
        expect(onPresetLoad).toHaveBeenCalledTimes(1);
        expect(onDeviceChanged).toHaveBeenCalled();
        expect(device.presets.size).toBe(2);
    });
});