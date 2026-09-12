// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { BindingManager } from "../../src/core/BindingManager";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { AppUI } from "../../src/ui/AppUI";

/**
 * M14 — the Morph slider is connected to the M9/M10 engine:
 *   slider input → Preset A + Preset B → applyMorphToDevice
 *     → control.value updated → visible widget updated in place
 *     → CONNECTED controls written via NexusAdapter.updateBoundControl
 *   Missing slot / deleted preset → amount only, NO morph, NO writes.
 *   Load preset behavior and M12/M13 behavior stay untouched.
 */

class CapturingAdapter extends NexusAdapter {
    public calls: { id: string; value: number }[] = [];
    public override updateBoundControl(controlId: string, value: number): Promise<boolean> {
        this.calls.push({ id: controlId, value });
        return Promise.resolve(true);
    }
}

function makeMorphDevice() {
    const device = new Device("Morph");
    const cutoff = new Control("knob", "Cutoff", { x: 0, y: 0 }, "cutoff");
    const res = new Control("knob", "Resonance", { x: 0, y: 0 }, "res");
    device.addControl(cutoff);
    device.addControl(res);
    cutoff.activeBindingState = "CONNECTED";
    res.activeBindingState = "DISCONNECTED";

    cutoff.value = 0.2;
    res.value = 0.9;
    device.savePreset("P-A");

    cutoff.value = 0.8;
    res.value = 0.1;
    device.savePreset("P-B");

    cutoff.value = 0.5;
    res.value = 0.5;
    return device;
}

function mount(device: Device) {
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    lib.saveCurrentDevice();
    const adapter = new CapturingAdapter();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const app = new AppUI(root, lib, adapter, new MidiAccess(), new BindingManager(device));
    app.render();
    // USE mode renders the live surface widgets (knob indicator).
    const toggle = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.innerText.includes("Switch to USE Mode"),
    );
    toggle!.click();
    return { lib, adapter, device, root, app };
}

function slider(root: HTMLElement): HTMLInputElement {
    const el = root.querySelector<HTMLInputElement>(".preset-morph-slider");
    expect(el).toBeTruthy();
    return el!;
}

function statusText(root: HTMLElement): string {
    const el = root.querySelector<HTMLElement>(".preset-morph-status");
    expect(el).toBeTruthy();
    return el!.innerText;
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

function actBtn(root: HTMLElement, presetName: string, label: string) {
    const btn = [...presetRow(root, presetName).querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.innerText === label,
    );
    expect(btn).toBeTruthy();
    return btn!;
}

function move(s: HTMLInputElement, value: string) {
    s.value = value;
    s.dispatchEvent(new Event("input", { bubbles: true }));
}

function knobValue(root: HTMLElement, controlId: string): string {
    const el = root.querySelector<HTMLElement>(`[data-ctl-id="${controlId}"] .knob-indicator`);
    expect(el).toBeTruthy();
    return el!.style.transform;
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

describe("M14 — Morph slider connected to the Morph engine", () => {
    it("1. both A/B selected + slider 0 → current controls equal A", () => {
        const device = makeMorphDevice();
        const { root, device: dev } = mount(device);
        slotBtn(root, "P-A", "A").click();
        slotBtn(root, "P-B", "B").click();
        move(slider(root), "0");

        expect(dev.controls.get("cutoff")!.value).toBeCloseTo(0.2, 10);
        expect(dev.controls.get("res")!.value).toBeCloseTo(0.9, 10);
    });

    it("2. both A/B selected + slider 0.5 → controls equal the midpoint", () => {
        const device = makeMorphDevice();
        const { root, device: dev } = mount(device);
        slotBtn(root, "P-A", "A").click();
        slotBtn(root, "P-B", "B").click();
        move(slider(root), "0.5");

        expect(dev.controls.get("cutoff")!.value).toBeCloseTo(0.5, 10);
        expect(dev.controls.get("res")!.value).toBeCloseTo(0.5, 10);
    });

    it("3. both A/B selected + slider 1 → current controls equal B", () => {
        const device = makeMorphDevice();
        const { root, device: dev } = mount(device);
        slotBtn(root, "P-A", "A").click();
        slotBtn(root, "P-B", "B").click();
        move(slider(root), "1");

        expect(dev.controls.get("cutoff")!.value).toBeCloseTo(0.8, 10);
        expect(dev.controls.get("res")!.value).toBeCloseTo(0.1, 10);
    });

    it("4. slider movement updates the visible control widget", () => {
        const device = makeMorphDevice();
        const { root } = mount(device);
        slotBtn(root, "P-A", "A").click();
        slotBtn(root, "P-B", "B").click();

        // knob rotation = -135 + value*270
        expect(knobValue(root, "cutoff")).toBe("rotate(0deg)"); // live value 0.5 before morph
        move(slider(root), "0");
        expect(knobValue(root, "cutoff")).toBe("rotate(-81deg)");
        move(slider(root), "1");
        expect(knobValue(root, "cutoff")).toBe("rotate(81deg)");
    });

    it("5. connected controls invoke updateBoundControl", () => {
        const device = makeMorphDevice();
        const { root, adapter } = mount(device);
        slotBtn(root, "P-A", "A").click();
        slotBtn(root, "P-B", "B").click();
        move(slider(root), "0.3");

        expect(adapter.calls.some((c) => c.id === "cutoff")).toBe(true);
        const call = adapter.calls.find((c) => c.id === "cutoff")!;
        expect(call!.value).toBeCloseTo(0.38, 10);
    });

    it("6. disconnected controls remain local (no Nexus write, local value updated)", () => {
        const device = makeMorphDevice();
        const { root, adapter, device: dev } = mount(device);
        slotBtn(root, "P-A", "A").click();
        slotBtn(root, "P-B", "B").click();
        move(slider(root), "0.3");

        expect(adapter.calls.some((c) => c.id === "res")).toBe(false);
        expect(dev.controls.get("res")!.value).toBeCloseTo(0.66, 10);
    });

    it("7. missing A → no Morph application", () => {
        const device = makeMorphDevice();
        const { root, adapter, device: dev } = mount(device);
        slotBtn(root, "P-B", "B").click();
        move(slider(root), "0.7");

        expect(statusText(root)).toContain("A: —");
        expect(dev.controls.get("cutoff")!.value).toBe(0.5);
        expect(dev.controls.get("res")!.value).toBe(0.5);
        expect(adapter.calls.length).toBe(0);
    });

    it("8. missing B → no Morph application", () => {
        const device = makeMorphDevice();
        const { root, adapter, device: dev } = mount(device);
        slotBtn(root, "P-A", "A").click();
        move(slider(root), "0.7");

        expect(statusText(root)).toContain("B: —");
        expect(dev.controls.get("cutoff")!.value).toBe(0.5);
        expect(adapter.calls.length).toBe(0);
    });

    it("9. deleted A/B preset clears the slot and prevents Morph", () => {
        const device = makeMorphDevice();
        const { root, adapter, device: dev } = mount(device);
        slotBtn(root, "P-A", "A").click();
        expect(statusText(root)).toContain("A: P-A");
        actBtn(root, "P-A", "✕").click();

        expect(statusText(root)).toContain("A: —");
        expect(dev.presets.has(device.presets.get("P-A")!)).toBe(false);
        move(slider(root), "0.7");
        expect(dev.controls.get("cutoff")!.value).toBe(0.5);
        expect(adapter.calls.length).toBe(0);
    });

    it("10. Morph does not call loadPreset", () => {
        const device = makeMorphDevice();
        const spy = vi.spyOn(device, "loadPreset");
        const { root } = mount(device);
        slotBtn(root, "P-A", "A").click();
        slotBtn(root, "P-B", "B").click();
        move(slider(root), "0.3");
        move(slider(root), "0.8");

        expect(spy).not.toHaveBeenCalled();
    });

    it("11. Morph does not alter control names", () => {
        const device = makeMorphDevice();
        const namesBefore = [...device.controls.values()].map((c) => c.name);
        const { root } = mount(device);
        slotBtn(root, "P-A", "A").click();
        slotBtn(root, "P-B", "B").click();
        move(slider(root), "0.5");

        expect([...device.controls.values()].map((c) => c.name)).toEqual(namesBefore);
    });

    it("12. Morph does not alter bindings", () => {
        const device = makeMorphDevice();
        const stateBefore = [...device.controls.values()].map((c) => c.activeBindingState);
        const defsBefore = [...device.controls.values()].map((c) => c.audiotoolBindingDefinition);
        const { root } = mount(device);
        slotBtn(root, "P-A", "A").click();
        slotBtn(root, "P-B", "B").click();
        move(slider(root), "0.5");

        expect([...device.controls.values()].map((c) => c.activeBindingState)).toEqual(stateBefore);
        expect([...device.controls.values()].map((c) => c.audiotoolBindingDefinition)).toEqual(defsBefore);
    });

    it("13. Morph state is not serialized", () => {
        const device = makeMorphDevice();
        const { root } = mount(device);
        slotBtn(root, "P-A", "A").click();
        slotBtn(root, "P-B", "B").click();
        move(slider(root), "0.5");

        expect(JSON.stringify(device.serialize())).not.toContain("morph");
    });

    it("14. existing preset Load still works — and Load → A/B → Morph regression", () => {
        const device = makeMorphDevice();
        const spy = vi.spyOn(device, "loadPreset");
        const { root, adapter, device: dev } = mount(device);

        // Normal preset load still behaves exactly as before
        actBtn(root, "P-B", "Load").click();
        expect(spy).toHaveBeenCalledTimes(1);
        expect(dev.controls.get("cutoff")!.value).toBeCloseTo(0.8, 10);
        expect(dev.controls.get("res")!.value).toBeCloseTo(0.1, 10);
        expect(adapter.calls.filter((c) => c.id === "cutoff").length).toBeGreaterThanOrEqual(1);

        // Load followed by A/B + Morph still works — no stale preset objects
        slotBtn(root, "P-A", "A").click();
        slotBtn(root, "P-B", "B").click();
        move(slider(root), "0.5");

        expect(dev.controls.get("cutoff")!.value).toBeCloseTo(0.5, 10);
        expect(dev.controls.get("res")!.value).toBeCloseTo(0.5, 10);
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it("15. multiple slider input events produce the expected final values", () => {
        const device = makeMorphDevice();
        const { root, adapter, device: dev } = mount(device);
        slotBtn(root, "P-A", "A").click();
        slotBtn(root, "P-B", "B").click();
        const s = slider(root);

        move(s, "0");
        move(s, "0.25");
        move(s, "0.75");
        move(s, "1");

        expect(dev.controls.get("cutoff")!.value).toBeCloseTo(0.8, 10);
        expect(dev.controls.get("res")!.value).toBeCloseTo(0.1, 10);
        const last = adapter.calls.filter((c) => c.id === "cutoff").at(-1)!;
        expect(last.value).toBeCloseTo(0.8, 10);
    });
});