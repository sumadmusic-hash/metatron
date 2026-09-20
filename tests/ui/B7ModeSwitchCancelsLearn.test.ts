// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { BindingManager } from "../../src/core/BindingManager";
import { AppUI } from "../../src/ui/AppUI";

/**
 * B7 — offene Lernvorgänge müssen den Mode-Wechsel überleben:
 * 1. Die Learn-Bar der anderen View darf nicht anleuchten.
 * 2. Die Lern-Promise hängt nicht bis zum Timeout.
 * 3. Die reRender()-Methode darf auf abgehängten Subtrees nichts anstoßen.
 */

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

function mount(): { root: HTMLElement; app: AppUI } {
    const device = new Device("B7Test");
    device.addControl(new Control("knob", "c", { x: 0, y: 0 }, "c1"));
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    const root = document.createElement("div");
    document.body.appendChild(root);
    const app = new AppUI(root, lib, new NexusAdapter(), new MidiAccess(), new BindingManager(device));
    app.render();
    return { root, app };
}

describe("B7 — Mode switch cancels pending learns and respects detached subtrees", () => {
    it("clicking #mode-toggle-btn cancels a running surface MIDI learn (IDLE after click)", () => {
        const { app } = mount();
        const surface: any = (app as any).surfaceUI;

        // Start a MIDI learn on the surface — puts it in LEARNING state
        surface.midiLearn.startLearn(undefined, { timeoutMs: 10_000 }).catch(() => {});
        expect(surface.midiLearn.currentState).toBe("LEARNING");

        // Click the mode pill
        const pill = document.querySelector<HTMLElement>("#mode-toggle-btn")!;
        pill.click();

        // The learn must have been cancelled
        expect(surface.midiLearn.currentState).toBe("IDLE");
    });

    it("clicking #mode-toggle-btn cancels a running editor MIDI learn", () => {
        const { app } = mount();
        const editor: any = (app as any).editorUI;

        // Simulate the real startMidiLearn state: midiLearningId is set BEFORE
        // the await; the learn is live on the editor's MidiLearn instance.
        editor.midiLearningId = "c1";
        editor.midiLearn.startLearn(undefined, { timeoutMs: 10_000 }).catch(() => {});
        expect(editor.midiLearningId).toBe("c1");
        expect(editor.midiLearn.currentState).toBe("LEARNING");

        const pill = document.querySelector<HTMLElement>("#mode-toggle-btn")!;
        pill.click();

        expect(editor.midiLearningId).toBeNull();
        expect(editor.midiLearn.currentState).toBe("IDLE");
    });

    it("reRender on a detached SurfaceUI mountParent is a no-op (no throw, container stays detached)", () => {
        const { app } = mount();
        const surface: any = (app as any).surfaceUI;
        const root = (app as any).root as HTMLElement;

        // AppUI defaults to EDIT mode — render the USE surface explicitly so
        // mountParent is set and the container is live inside root.
        surface.render(root);
        const container = surface.container;
        expect(document.contains(container)).toBe(true);

        // Detach root (simulates mode switch destroying the old subtree)
        root.remove();
        expect(document.contains(container)).toBe(false);

        // reRender must not throw and must NOT re-attach the container
        expect(() => surface.reRender()).not.toThrow();
        expect(document.contains(container)).toBe(false);
    });

    describe("B8 — knob drag cleanup releases the gesture takeover", () => {
        function mountSurfaceWithTakeover(): { surface: any; root: HTMLElement; takeover: ReturnType<typeof vi.fn> } {
            const { app } = mount();
            const surface: any = (app as any).surfaceUI;
            const root = (app as any).root as HTMLElement;
            const takeover = vi.fn();
            surface.onGestureTakeover = takeover as any;
            surface.render(root);
            return { surface, root, takeover };
        }

        function dragStart(surface: any): HTMLElement {
            const body = surface.container.querySelector<HTMLElement>(".knob-body")!;
            body.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientY: 100, bubbles: true }));
            return body;
        }

        it("reRender releases a takeover mid-drag (pointerup never fires on the rebuilt DOM)", () => {
            const { surface, takeover } = mountSurfaceWithTakeover();
            dragStart(surface);

            // Drag is live — modulation for the control is suspended.
            expect(takeover).toHaveBeenCalledWith("c1", true);

            // A rebuild mid-gesture (external Nexus change, MIDI learn, …)
            // destroys the knob node with its listeners.
            surface.reRender();

            // The takeover must NOT stay stuck.
            expect(takeover).toHaveBeenCalledWith("c1", false);
            expect(surface.gestureControlId).toBeNull();
        });

        it("lostpointercapture releases the takeover (pointerup/cancel never fire)", () => {
            const { surface, takeover } = mountSurfaceWithTakeover();
            const body = dragStart(surface);
            expect(takeover).toHaveBeenCalledWith("c1", true);

            // Browser reclaims/forced capture release: neither pointerup nor
            // pointercancel is guaranteed here.
            body.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: 1, bubbles: true }));

            expect(takeover).toHaveBeenCalledWith("c1", false);
            expect(surface.gestureControlId).toBeNull();

            // A subsequent move must no longer change the control value — the
            // dead gesture is inert, not live-but-stuck.
            const control = surface.deviceLibrary.currentDevice.getControl("c1");
            const before = control.value;
            body.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientY: 60, bubbles: true }));
            expect(control.value).toBe(before);
        });
    });
});

describe("Bug 7 — AppUI.render() bricht eine aktive EDIT-Drag- und eine USE-Knob-Geste ohne COMMIT/PERSIST ab", () => {
    function pd(el: HTMLElement, x: number, y: number, id = 1) {
        el.dispatchEvent(new PointerEvent("pointerdown", { pointerId: id, clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }));
    }
    function pm(x: number, y: number, id = 1) {
        document.dispatchEvent(new PointerEvent("pointermove", { pointerId: id, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    }

    it("EDIT: ein laufender Drag wird beim Rebuild verworfen — kein Commit, kein Persist, Folgemoves inert", () => {
        const { app } = mount();
        const editor: any = (app as any).editorUI;
        const root = (app as any).root as HTMLElement;
        const lib: DeviceLibrary = (app as any).deviceLibrary;
        const el = root.querySelector<HTMLElement>(`[data-ctl-id="c1"]`)!;

        pd(el, 400, 300);
        pm(440, 360); // → Drag aktiv, Modell live verschoben
        const control = lib.currentDevice!.getControl("c1")!;
        const dragged = { ...control.position };
        expect(dragged).not.toEqual({ x: 0, y: 0 });
        expect((app as any).history.undoLength).toBe(0);

        // Mode-/Device-initiiertes Re-Render: die alte Gesten-Instanz (und ihre
        // Document-Listener/Capture) muss sterben, OHNE commit/persist zu ziehen.
        app.render();

        expect(editor.drag).toBeNull();
        expect((app as any).history.undoLength).toBe(0); // kein history.record()
        expect(lib.currentDevice!.getControl("c1")!.position).toEqual(dragged); // Modell unangetastet
        // Listeners sind entfernt: eine weitere Bewegung ändert NICHTS mehr.
        pm(600, 500);
        expect(lib.currentDevice!.getControl("c1")!.position).toEqual(dragged);
    });

    it("USE: der Knob-Takeover einer laufenden Geste wird beim Rebuild freigegeben, Folgemoves inert", () => {
        const { app } = mount();
        const surface: any = (app as any).surfaceUI;
        const root = (app as any).root as HTMLElement;
        const lib: DeviceLibrary = (app as any).deviceLibrary;
        const takeover = vi.fn();
        surface.onGestureTakeover = takeover as any;
        surface.render(root);

        const body = surface.container.querySelector<HTMLElement>(".knob-body")!;
        pd(body, 100, 100);
        expect(takeover).toHaveBeenCalledWith("c1", true);
        expect(surface.gestureControlId).toBe("c1");
        const control = lib.currentDevice!.getControl("c1")!;
        const before = control.value;

        // Ein Rebuild (Mode-/View-Wechsel) muss das Takeover freigeben …
        app.render();

        expect(takeover).toHaveBeenCalledWith("c1", false);
        expect(surface.gestureControlId).toBeNull();
        expect(control.value).toBe(before); // kein Snap-back, kein Persist
    });
});
