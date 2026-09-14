// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { BindingManager } from "../../src/core/BindingManager";
import { AppUI } from "../../src/ui/AppUI";
import { EditorUI } from "../../src/ui/editor/EditorUI";

/**
 * P3.3 — global listeners were never removed: EditorUI registered a document
 * keydown listener in its constructor, AppUI registered window keydown +
 * beforeunload, and none of that was ever torn down. Every remount (device
 * switch, HMR, tests) silently stacked duplicate handlers. `destroy()` now
 * removes exactly the listeners each instance registered.
 */

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

describe("P3.3 — global listeners are removed on destroy()", () => {
    /** Record every (type, handler) registered on `obj`, and mirror removals
     *  so a symmetric teardown leaves the registry empty. */
    function trackGlobalListeners(obj: any) {
        const registered: Array<[string, any]> = [];
        const add = vi.spyOn(obj, "addEventListener").mockImplementation((type: string, handler: any) => {
            registered.push([type, handler]);
        });
        const remove = vi.spyOn(obj, "removeEventListener").mockImplementation((type: string, handler: any) => {
            const i = registered.findIndex(([t, h]) => t === type && h === handler);
            if (i >= 0) registered.splice(i, 1);
        });
        return { registered, add, remove };
    }

    it("EditorUI.destroy removes its document keydown listener (idempotent)", () => {
        // Spy BEFORE constructing so the constructor's registration is tracked.
        const { registered } = trackGlobalListeners(document);

        const lib = new DeviceLibrary();
        lib.currentDevice = new Device("D");
        const ui = new EditorUI(lib);

        expect(registered.length).toBeGreaterThan(0); // constructor registered keydown

        ui.destroy();
        expect(registered).toHaveLength(0);

        // A second destroy is a safe no-op (no double-removal, no throw).
        expect(() => ui.destroy()).not.toThrow();
        expect(registered).toHaveLength(0);

        vi.restoreAllMocks();
    });

    it("AppUI.destroy removes every window+document listener its construction added", () => {
        const device = new Device("D");
        device.addControl(new Control("knob", "k", { x: 0, y: 0 }, "k1"));
        const lib = new DeviceLibrary();
        lib.currentDevice = device;
        const root = document.createElement("div");
        document.body.appendChild(root);

        const windowTrack = trackGlobalListeners(window);
        const documentTrack = trackGlobalListeners(document);

        const app = new AppUI(root, lib, new NexusAdapter(), new MidiAccess(), new BindingManager(device));
        app.render();

        // Construction must have registered the window (+ nested EditorUI doc) listeners.
        const windowTypes = windowTrack.registered.map(([t]) => t);
        expect(windowTypes).toContain("keydown");
        expect(windowTypes).toContain("beforeunload");
        expect(documentTrack.registered.length).toBeGreaterThan(0);

        app.destroy();

        expect(windowTrack.registered).toHaveLength(0);
        expect(documentTrack.registered).toHaveLength(0);

        // The root is cleared by the teardown — no resurrected DOM.
        expect(root.innerHTML).toBe("");
        expect(() => app.destroy()).not.toThrow();

        vi.restoreAllMocks();
    });
});