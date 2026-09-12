// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { EditorUI } from "../../src/ui/editor/EditorUI";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { BindingManager } from "../../src/core/BindingManager";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { MidiMapping } from "../../src/midi/MidiMapping";

function addKnob(device: Device, name: string, x: number, y: number): Control {
    const c = new Control("knob", name, { x, y });
    device.addControl(c);
    return c;
}

function mount(device: Device): HTMLElement {
    const library = new DeviceLibrary();
    library.currentDevice = device;
    const ui = new EditorUI(
        library,
        new NexusAdapter(),
        new BindingManager(device),
        new MidiAccess(),
        new MidiMapping(device),
        vi.fn()
    );
    const host = document.createElement("div");
    document.body.appendChild(host);
    ui.render(host);
    return host;
}

beforeEach(() => {
    document.body.innerHTML = "";
});

describe("M20.8 — EDIT-mode control toolbar is two rows with Delete far right", () => {
    it("renders the toolbar as exactly two visual rows", () => {
        const device = new Device("T1");
        addKnob(device, "A", 100, 100);
        const host = mount(device);
        const tools = host.querySelector(".control-tools") as HTMLElement;
        expect(tools).not.toBeNull();
        const rows = tools.querySelectorAll(".control-tools-row");
        expect(rows.length).toBe(2);
    });

    it("keeps all existing toolbar functions present", () => {
        const device = new Device("T1");
        addKnob(device, "A", 100, 100);
        const host = mount(device);
        const tools = host.querySelector(".control-tools") as HTMLElement;
        const [row1, row2] = tools.querySelectorAll(".control-tools-row");

        // Row 1: normal edit/settings options
        expect(row1.querySelector(".tool-btn")).not.toBeNull(); // Learn/Forget family
        expect([...row1.querySelectorAll(".tool-btn")].map((b) => b.textContent)).toEqual(
            expect.arrayContaining(["Learn", "Forget", "MIDI"])
        );
        expect(row1.querySelector(".group-membership")).not.toBeNull();

        // Row 2: color options + Delete
        expect(row2.querySelector("input.color-swatch")).not.toBeNull();
        expect(row2.querySelector(".color-hex-label")).not.toBeNull();
        expect([...row2.querySelectorAll(".tool-btn")].map((b) => b.textContent)).toEqual(
            expect.arrayContaining(["Copy", "Paste"])
        );
    });

    it("task M20.8 — color function still works from row 2", () => {
        const device = new Device("T1");
        const a = addKnob(device, "A", 100, 100);
        const host = mount(device);
        const el = host.querySelector(`[data-ctl-id="${a.id}"]`) as HTMLElement;
        const swatch = el.querySelector(".color-swatch") as HTMLInputElement;
        swatch.value = "#ff00aa";
        swatch.dispatchEvent(new Event("input", { bubbles: true }));
        const visualArea = el.querySelector(".control-visual-area") as HTMLElement;
        expect(visualArea.style.background).toBe("#ff00aa");
        expect((el.querySelector(".color-hex-label") as HTMLElement).textContent).toBe("#ff00aa");
    });

    it("places the Delete/X action as the LAST element of the second row only", () => {
        const device = new Device("T1");
        addKnob(device, "A", 100, 100);
        const host = mount(device);
        const tools = host.querySelector(".control-tools") as HTMLElement;
        const [row1, row2] = tools.querySelectorAll(".control-tools-row");

        const del = tools.querySelector<HTMLElement>(".control-delete-btn")!;
        expect(del).not.toBeNull();
        expect(del.textContent).toBe("✕");
        expect(del.title).toBe("Archive control");
        // Delete lives at the END of row 2 — never in row 1, never mid-row.
        expect(row1.querySelector(".control-delete-btn")).toBeNull();
        expect(row2.lastElementChild).toBe(del);
        expect(del.parentElement).toBe(row2);
    });

    it("right-pins the Delete button via margin-left: auto", () => {
        const css = readFileSync(resolve("src/ui/styles.css"), "utf8");
        const delRule = css.match(/\.control-tools \.control-delete-btn\s*\{[^}]*\}/);
        expect(delRule).toBeTruthy();
        expect(delRule?.[0]).toMatch(/margin-left:\s*auto/);
    });

    it("task M20.8 — Delete still works when clicked", () => {
        const device = new Device("T1");
        const a = addKnob(device, "A", 100, 100);
        const host = mount(device);
        const el = host.querySelector(`[data-ctl-id="${a.id}"]`) as HTMLElement;
        // Select the control so deleteSelected() targets it
        el.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 300, clientY: 300, button: 0, bubbles: true }));
        document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));

        const del = el.querySelector<HTMLElement>(".control-tools .control-delete-btn");
        expect(del).not.toBeNull();
        del!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        // soft-delete/archive: still in the map but archived (and no longer rendered)
        expect(device.controls.get(a.id)!.archived).toBe(true);
        expect(host.querySelector(`[data-ctl-id="${a.id}"]`)).toBeNull();
    });
});