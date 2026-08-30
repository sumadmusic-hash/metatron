// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { BindingManager } from "../../src/core/BindingManager";
import { AppUI } from "../../src/ui/AppUI";

function addKnob(device: Device, name: string, x: number, y: number): Control {
    const c = new Control("knob", name, { x, y });
    device.addControl(c);
    return c;
}

function mountApp(device: Device): { app: AppUI; lib: DeviceLibrary; root: HTMLElement; device: Device } {
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    lib.saveCurrentDevice();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const app = new AppUI(root, lib, new NexusAdapter(), new MidiAccess(), new BindingManager(device));
    app.render();
    return { app, lib, root, device };
}

/** Pointer gesture helpers (mirror tests/ui/EditorDrag.test.ts). */
function pd(el: HTMLElement, x: number, y: number, id = 1) {
    el.dispatchEvent(new PointerEvent("pointerdown", { pointerId: id, clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }));
}
function pm(x: number, y: number, id = 1) {
    document.dispatchEvent(new PointerEvent("pointermove", { pointerId: id, clientX: x, clientY: y, bubbles: true, cancelable: true }));
}
function pu(id = 1) {
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: id, bubbles: true, cancelable: true }));
}

/** One completed control-drag gesture (moves "A" to x+40,y+60). */
function dragKnob(root: HTMLElement, id: string) {
    const el = root.querySelector<HTMLElement>(`[data-ctl-id="${id}"]`)!;
    pd(el, 400, 300);
    pm(440, 360);
    pu();
}

function undoBtn(root: HTMLElement): HTMLButtonElement {
    return root.querySelector<HTMLButtonElement>("#history-undo")!;
}
function redoBtn(root: HTMLElement): HTMLButtonElement {
    return root.querySelector<HTMLButtonElement>("#history-redo")!;
}

function metaKey(key: string, shift = false) {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey: shift, metaKey: true, bubbles: true, cancelable: true }));
}
function ctrlKey(key: string) {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true }));
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

describe("AppUI — history toolbar (C1)", () => {

    it("renders Undo/Redo buttons, both disabled while the history is empty", () => {
        const device = new Device("T");
        addKnob(device, "A", 100, 100);
        const { root } = mountApp(device);

        const undo = undoBtn(root);
        const redo = redoBtn(root);
        expect(undo).toBeTruthy();
        expect(redo).toBeTruthy();
        expect(undo.disabled).toBe(true);
        expect(redo.disabled).toBe(true);
    });

    it("one drag records EXACTLY ONE action and the toolbar buttons toggle enable state", () => {
        const device = new Device("T");
        const a = addKnob(device, "A", 100, 100);
        const { root } = mountApp(device);

        dragKnob(root, a.id);
        expect(a.position).toEqual({ x: 140, y: 160 });
        // One gesture = one action: undo enabled, redo still disabled.
        // Action count is not directly exposed, but canUndo flips while canRedo stays off.
        expect(undoBtn(root).disabled).toBe(false);
        expect(redoBtn(root).disabled).toBe(true);

        undoBtn(root).click();
        const undoAfter1 = undoBtn(root);
        const redoAfter1 = redoBtn(root);
        expect(a.position).toEqual({ x: 100, y: 100 });
        expect(undoAfter1.disabled).toBe(true);
        expect(redoAfter1.disabled).toBe(false);

        redoBtn(root).click();
        expect(a.position).toEqual({ x: 140, y: 160 });
        expect(undoBtn(root).disabled).toBe(false);
        expect(redoBtn(root).disabled).toBe(true);
    });

    it("keyboard: Cmd/Ctrl+Z undoes, Shift+Cmd/Ctrl+Z and Ctrl+Y redo", () => {
        const device = new Device("T");
        const a = addKnob(device, "A", 100, 100);
        const { root } = mountApp(device);
        dragKnob(root, a.id);
        expect(a.position).toEqual({ x: 140, y: 160 });

        metaKey("z");
        expect(a.position).toEqual({ x: 100, y: 100 });

        metaKey("z", true); // Shift+Cmd+Z → redo
        expect(a.position).toEqual({ x: 140, y: 160 });

        metaKey("z"); // undo again
        expect(a.position).toEqual({ x: 100, y: 100 });

        ctrlKey("y"); // Ctrl+Y → redo
        expect(a.position).toEqual({ x: 140, y: 160 });

        ctrlKey("z"); // Ctrl+Z → undo
        expect(a.position).toEqual({ x: 100, y: 100 });
    });

    it("keyboard shortcuts are ignored while an INPUT has focus (native text undo kept)", () => {
        const device = new Device("T");
        const a = addKnob(device, "A", 100, 100);
        const { root } = mountApp(device);
        dragKnob(root, a.id);
        expect(a.position).toEqual({ x: 140, y: 160 });

        const input = root.querySelector<HTMLInputElement>('input[placeholder*="Project URL"]')!;
        input.focus();
        expect(document.activeElement).toBe(input);

        metaKey("z");
        expect(a.position).toEqual({ x: 140, y: 160 });
        expect(undoBtn(root).disabled).toBe(false);
    });

    it("Escape aborts a drag: start state restored, NO history action recorded", () => {
        const device = new Device("T");
        const a = addKnob(device, "A", 100, 100);
        const { root } = mountApp(device);

        const el = root.querySelector<HTMLElement>(`[data-ctl-id="${a.id}"]`)!;
        pd(el, 400, 300);
        pm(440, 360);
        expect(a.position).toEqual({ x: 140, y: 160 });
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

        expect(a.position).toEqual({ x: 100, y: 100 });
        expect(undoBtn(root).disabled).toBe(true);
        expect(redoBtn(root).disabled).toBe(true);
    });

    it("value-only changes (Nexus/MIDI route) never create history actions", () => {
        const device = new Device("T");
        const a = addKnob(device, "A", 100, 100);
        const { lib, root } = mountApp(device);

        a.value = 0.7;
        lib.saveCurrentDevice();
        a.value = 1.0;
        lib.saveCurrentDevice();

        expect(undoBtn(root).disabled).toBe(true);
        expect(redoBtn(root).disabled).toBe(true);
        expect(a.value).toBe(1.0);
    });
});