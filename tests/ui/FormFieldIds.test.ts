// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { Group } from "../../src/core/model/Group";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { BindingManager } from "../../src/core/BindingManager";
import { AppUI } from "../../src/ui/AppUI";
import { createDefaultMatrix } from "../../src/core/modulation/ModulationTypes";

/**
 * Chrome DevTools autofill warning ("A form field element has neither an id
 * nor a name attribute") — regression: every form control created by the UI
 * must carry a stable, document-unique id so the warning disappears while the
 * bake-dialog ids (mod-bake-bars / mod-bake-grid) stay untouched.
 */

class SilentAdapter extends NexusAdapter {
    public override updateBoundControl(_id: string, _v: number): Promise<boolean> {
        return Promise.resolve(true);
    }
}

class SilentMidi extends MidiAccess {
    public override setMessageHandler(_cb: (channel: number, cc: number, value: number) => void) {}
}

function buildDevice(): Device {
    const device = new Device("FormIds");
    const c1 = new Control("knob", "Cutoff", { x: 0, y: 0 }, "c1");
    const c2 = new Control("knob", "Reso", { x: 0, y: 40 }, "c2");
    const group = new Group("Filter");
    device.addControl(c1);
    device.addControl(c2);
    device.addGroup(group);
    device.setControlGroup("c1", group.id);

    const matrix = createDefaultMatrix();
    matrix.sources[0].enabled = true;
    matrix.slots[0].enabled = true;
    matrix.slots[0].destControlId = "c1";
    matrix.slots[0].sourceId = matrix.sources[0].id;
    matrix.slots[1].enabled = true;
    matrix.slots[1].destControlId = "c2";
    matrix.slots[1].sourceId = matrix.sources[1].id;
    device.modulation = matrix;
    return device;
}

function mount(): { app: AppUI; root: HTMLElement; device: Device } {
    const device = buildDevice();
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    lib.saveCurrentDevice();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const app = new AppUI(root, lib, new SilentAdapter(), new SilentMidi(), new BindingManager(device));
    app.render();
    return { app, root, device };
}

function formFields(root: HTMLElement): HTMLElement[] {
    return [...root.querySelectorAll<HTMLElement>("input, select, textarea")];
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

describe("Form field id/name hygiene (autofill warning)", () => {
    it("EDIT mode: every form control carries a non-empty, document-unique id", () => {
        const { root, device } = mount();

        const fields = formFields(root);
        expect(fields.length).toBeGreaterThan(0);
        for (const field of fields) {
            expect(field.id.trim(), `input missing id: ${field.outerHTML}`).not.toBe("");
        }
        const ids = fields.map((f) => f.id);
        expect(new Set(ids).size).toBe(ids.length); // uniqueness

        const c1 = device.getControl("c1")!;
        const group = device.groups.values().next().value as Group;
        expect(root.querySelector("#project-url-input")).toBeTruthy();
        expect(root.querySelector("#preset-name-input")).toBeTruthy();
        expect(root.querySelector("#morph-amount-slider")).toBeTruthy();
        expect(root.querySelector("#instrument-name-input")).toBeTruthy();
        expect(root.querySelector(`#ctl-color-${c1.id}`)).toBeTruthy();
        expect(root.querySelector(`#ctl-group-${c1.id}`)).toBeTruthy();
        expect(root.querySelector(`#grp-color-${group.id}`)).toBeTruthy();
        expect(root.querySelector("#mod-src-enable-mod1")).toBeTruthy();
        expect(root.querySelector("#mod-slot-src-slot1")).toBeTruthy();
        expect(root.querySelector("#mod-slot-dest-slot1")).toBeTruthy();
    });

    it("USE mode: scaling editor fields are id'd and unique; ids stay stable across the toggle", () => {
        const { app, root, device } = mount();
        const midiMapping = (app as any).midiMapping;
        midiMapping.setMapping("c1", 1, 20); // forces the scaling editor to render

        const toggle = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.innerText === "USE");
        toggle?.click();

        const c1 = device.getControl("c1")!;
        expect(root.querySelector(`#scaling-min-${c1.id}`)).toBeTruthy();
        expect(root.querySelector(`#scaling-max-${c1.id}`)).toBeTruthy();
        expect(root.querySelector(`#scaling-exponent-${c1.id}`)).toBeTruthy();
        expect(root.querySelector(`#scaling-flip-${c1.id}`)).toBeTruthy();

        const fields = formFields(root);
        expect(fields.length).toBeGreaterThan(0);
        for (const field of fields) {
            expect(field.id.trim(), `input missing id: ${field.outerHTML}`).not.toBe("");
        }
        const ids = fields.map((f) => f.id);
        expect(new Set(ids).size).toBe(ids.length); // uniqueness

        // IDs are stable: toggling again recreates the SAME ids (no drift).
        const before = fields.map((f) => f.id).sort();
        toggle?.click(); // back to EDIT
        toggle?.click(); // back to USE
        const after = formFields(root).map((f) => f.id).sort();
        expect(before).toEqual(after);
    });

    it("bake-dialog ids/names remain unchanged (mod-bake-bars / mod-bake-grid)", () => {
        const { root } = mount();
        root.querySelector<HTMLButtonElement>(".mod-matrix-bake")?.click();

        const bars = root.querySelector<HTMLInputElement>("#mod-bake-bars");
        const grid = root.querySelector<HTMLSelectElement>("#mod-bake-grid");
        expect(bars).toBeTruthy();
        expect(grid).toBeTruthy();
        expect(bars?.name).toBe("bars");
        expect(grid?.name).toBe("grid");
        expect(bars?.type).toBe("number");
        expect(grid?.tagName).toBe("SELECT");
    });

    it("existing behavior preserved: url-input value survives the EDIT/USE re-render", () => {
        const { root } = mount();
        const url = root.querySelector<HTMLInputElement>("#project-url-input");
        expect(url).toBeTruthy();
        url!.value = "https://example.org/project";
        url!.dispatchEvent(new Event("input"));

        const toggle = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.innerText === "USE");
        toggle?.click();
        toggle?.click();

        const rebuilt = root.querySelector<HTMLInputElement>("#project-url-input");
        expect(rebuilt!.value).toBe("https://example.org/project");
    });
});