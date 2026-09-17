// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOfflineDocument } from "@audiotool/nexus/node";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { BindingManager } from "../../src/core/BindingManager";
import { AppUI } from "../../src/ui/AppUI";

class OfflineAdapter extends NexusAdapter {
    constructor(doc: any) {
        super();
        this.document = doc;
    }
    public override updateBoundControl(_controlId: string, _value: number): Promise<boolean> {
        return Promise.resolve(true);
    }
}

class CapturingMidi extends MidiAccess {
    public override setMessageHandler(_callback: (channel: number, cc: number, value: number) => void) {
        // no-op
    }
}

function buildDevice(): Device {
    const device = new Device("GRID");
    device.addControl(new Control("knob", "Gain", { x: 100, y: 100 }, "gain"));
    return device;
}

async function mount(): Promise<HTMLElement> {
    const doc: any = await createOfflineDocument({ validated: true });
    const lib = new DeviceLibrary();
    lib.currentDevice = buildDevice();
    lib.saveCurrentDevice();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const app = new AppUI(root, lib, new OfflineAdapter(doc), new CapturingMidi(), new BindingManager(lib.currentDevice!));
    app.render();
    return root;
}

function snapToggle(root: HTMLElement): HTMLButtonElement {
    return root.querySelector<HTMLButtonElement>(".builder-bar .snap-toggle")!;
}

function modeToggle(root: HTMLElement): HTMLButtonElement {
    return [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        b.id === "mode-toggle-btn",
    )!;
}

function canvas(root: HTMLElement): HTMLElement {
    return root.querySelector<HTMLElement>(".editor-canvas")!;
}

function isGridVisible(root: HTMLElement): boolean {
    return !canvas(root).classList.contains("editor-canvas--nogrid");
}

describe("Snap grid visibility: EDIT-only and tied to Snap state", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
        localStorage.clear();
    });

    it("1. EDIT + Snap ON shows the grid", async () => {
        const root = await mount();
        // Snap defaults to ON.
        expect(snapToggle(root).textContent).toBe("SNAP: ON");
        expect(canvas(root).classList.contains("editor-canvas")).toBe(true);
        expect(isGridVisible(root)).toBe(true);
    });

    it("2. EDIT + Snap OFF hides the grid", async () => {
        const root = await mount();
        snapToggle(root).click();
        expect(snapToggle(root).textContent).toBe("SNAP: OFF");
        expect(isGridVisible(root)).toBe(false);
        expect(canvas(root).classList.contains("editor-canvas--nogrid")).toBe(true);
    });

    it("3. USE hides the grid regardless of Snap state", async () => {
        const root = await mount();
        // Default Snap state is ON, yet USE must not show the grid (the bug).
        modeToggle(root).click();
        expect(modeToggle(root).classList.contains("mode-pill")).toBe(true);
        expect(isGridVisible(root)).toBe(false);
        expect(canvas(root).classList.contains("editor-canvas--nogrid")).toBe(true);
    });

    it("4. Switching EDIT -> USE hides the grid immediately", async () => {
        const root = await mount();
        expect(isGridVisible(root)).toBe(true);

        modeToggle(root).click();
        expect(isGridVisible(root)).toBe(false);
    });

    it("5a. Switching USE -> EDIT restores the grid when Snap is ON", async () => {
        const root = await mount();
        modeToggle(root).click(); // EDIT -> USE (grid hidden)
        expect(isGridVisible(root)).toBe(false);

        modeToggle(root).click(); // USE -> EDIT (Snap still ON)
        expect(isGridVisible(root)).toBe(true);
    });

    it("5b. Switching USE -> EDIT keeps the grid hidden when Snap is OFF", async () => {
        const root = await mount();
        snapToggle(root).click(); // Snap OFF
        expect(isGridVisible(root)).toBe(false);

        modeToggle(root).click(); // EDIT -> USE
        expect(isGridVisible(root)).toBe(false);

        modeToggle(root).click(); // USE -> EDIT (Snap still OFF)
        expect(snapToggle(root).textContent).toBe("SNAP: OFF");
        expect(isGridVisible(root)).toBe(false);
    });

    it("6. Snap behavior is unchanged: ON aligns to the grid, OFF allows free positioning", async () => {
        const root = await mount();
        const el = canvas(root).querySelector<HTMLElement>(".control-wrapper")!;
        const drag = (dx: number, dy: number) => {
            el.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 400, clientY: 300, button: 0, bubbles: true, cancelable: true }));
            document.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 400 + dx, clientY: 300 + dy, bubbles: true, cancelable: true }));
            document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true, cancelable: true }));
        };

        // Snap ON (default): 100 + 37 -> 140, 100 + 43 -> 140 (grid of 20).
        drag(37, 43);
        expect(alignedPosition(root)).toEqual({ x: 140, y: 140 });

        // Snap OFF: free positioning preserves raw offsets. The control was
        // already moved to (140,140) by the snap-ON drag above, so +37/+43
        // lands at (177,183) — NOT snapped to the 20px grid.
        snapToggle(root).click();
        const el2 = canvas(root).querySelector<HTMLElement>(".control-wrapper")!;
        el2.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 400, clientY: 300, button: 0, bubbles: true, cancelable: true }));
        document.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 437, clientY: 343, bubbles: true, cancelable: true }));
        document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true, cancelable: true }));
        expect(alignedPosition(root)).toEqual({ x: 177, y: 183 });
    });

    it("CSS ties grid visibility to the editor-canvas classes", async () => {
        const css = readFileSync(resolve("src/ui/styles.css"), "utf8");
        expect(css).toMatch(/\.editor-canvas\s*{[^}]*background-image:\s*radial-gradient/);
        expect(css).toMatch(/\.editor-canvas\.editor-canvas--nogrid\s*{[^}]*background-image:\s*none/);
    });
});

function alignedPosition(root: HTMLElement): { x: number; y: number } {
    const el = canvas(root).querySelector<HTMLElement>(".control-wrapper")!;
    return { x: parseInt(el.style.left, 10), y: parseInt(el.style.top, 10) };
}