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

describe("C1 follow-up FIX A — color-picker cancel never leaks a stale gesture baseline", () => {

    it("a canceled control color gesture cannot poison the next gesture's undo baseline", () => {
        const device = new Device("T");
        const a = addKnob(device, "A", 100, 100);
        const { root } = mountApp(device);

        const swatch = root.querySelector<HTMLInputElement>(`[data-ctl-id="${a.id}"] .color-swatch`)!;
        expect(swatch.value).toBe("#333333"); // default

        // Gesture 1: user scrubs the picker, then dismisses it WITHOUT a
        // committed `change` (cancel path). Color is live-updated, nothing recorded.
        swatch.value = "#ff0000";
        swatch.dispatchEvent(new Event("input", { bubbles: true }));
        expect(a.visualDefinition.color).toBe("#ff0000");
        swatch.dispatchEvent(new Event("blur", { bubbles: true }));
        expect(undoBtn(root).disabled).toBe(true); // no action yet

        // Gesture 2: a real commit starting from the CURRENT color (#ff0000).
        // Without the fix, the abandoned gesture-1 baseline (#333333) would
        // be reused, so undo would jump back further than it should.
        swatch.value = "#00ff00";
        swatch.dispatchEvent(new Event("input", { bubbles: true }));
        swatch.dispatchEvent(new Event("change", { bubbles: true }));
        expect(a.visualDefinition.color).toBe("#00ff00");
        expect(undoBtn(root).disabled).toBe(false); // exactly ONE action

        // Undo must restore gesture-2's own baseline — never the stale #333333.
        undoBtn(root).click();
        expect(a.visualDefinition.color).toBe("#ff0000");
    });

    it("a canceled GROUP color gesture also clears its baseline", () => {
        const device = new Device("T");
        const g = new Group("G", { x: 100, y: 100 }, { width: 240, height: 180 });
        device.addGroup(g);
        const { root } = mountApp(device);

        const picker = root.querySelector<HTMLInputElement>(`[data-grp-id="${g.id}"] .group-color-input`)!;
        picker.value = "#ff0000";
        picker.dispatchEvent(new Event("input", { bubbles: true }));
        expect(g.color).toBe("#ff0000");
        picker.dispatchEvent(new Event("blur", { bubbles: true }));

        picker.value = "#00ff00";
        picker.dispatchEvent(new Event("input", { bubbles: true }));
        picker.dispatchEvent(new Event("change", { bubbles: true }));
        expect(g.color).toBe("#00ff00");
        expect(undoBtn(root).disabled).toBe(false);

        undoBtn(root).click();
        expect(g.color).toBe("#ff0000");
    });

    it("a full color picker sweep remains a SINGLE history action (coalescing intact)", () => {
        const device = new Device("T");
        const a = addKnob(device, "A", 100, 100);
        const { root } = mountApp(device);

        const swatch = root.querySelector<HTMLInputElement>(`[data-ctl-id="${a.id}"] .color-swatch`)!;

        swatch.value = "#aaaaaa";
        swatch.dispatchEvent(new Event("input", { bubbles: true }));
        swatch.value = "#bbbbbb";
        swatch.dispatchEvent(new Event("input", { bubbles: true }));
        swatch.value = "#cccccc";
        swatch.dispatchEvent(new Event("input", { bubbles: true }));
        swatch.dispatchEvent(new Event("change", { bubbles: true }));
        swatch.dispatchEvent(new Event("blur", { bubbles: true })); // blur after commit is a no-op

        expect(undoBtn(root).disabled).toBe(false); // exactly ONE action
        undoBtn(root).click();
        expect(a.visualDefinition).toEqual({}); // pre-gesture state restored exactly
        redoBtn(root).click();
        expect(a.visualDefinition.color).toBe("#cccccc");
    });
});

describe("C1 follow-up FIX C — toolbar reflects per-device undo executability", () => {

    it("undo/redo buttons never suggest an action that is only executable on another device", () => {
        const lib = new DeviceLibrary();
        const a = lib.createNewDevice("A");
        const a1 = addKnob(a, "A1", 100, 100);
        lib.saveCurrentDevice();
        const b = lib.createNewDevice("B");
        addKnob(b, "B1", 200, 200);
        lib.saveCurrentDevice();
        lib.loadDevice(a.id); // open A fresh from storage

        const root = document.createElement("div");
        document.body.appendChild(root);
        const app = new AppUI(root, lib, new NexusAdapter(), new MidiAccess(), new BindingManager(lib.currentDevice!));
        app.render();

        const aLive = lib.currentDevice!;
        const a1Live = aLive.getControl(a1.id)!;
        dragKnob(root, a1Live.id); // one device-scope action on A
        expect(a1Live.position).toEqual({ x: 140, y: 160 });
        expect(undoBtn(root).disabled).toBe(false);
        expect(redoBtn(root).disabled).toBe(true);

        // Switch to B: the top action targets A → NOT executable here.
        lib.loadDevice(b.id);
        app.render();
        expect(undoBtn(root).disabled).toBe(true);
        expect(redoBtn(root).disabled).toBe(true);

        // Back on A → the same undo becomes available again and really runs.
        lib.loadDevice(a.id);
        app.render();
        expect(undoBtn(root).disabled).toBe(false);
        undoBtn(root).click();
        expect(lib.currentDevice!.getControl(a1.id)!.position).toEqual({ x: 100, y: 100 });
    });
});