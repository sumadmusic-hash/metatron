// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
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
});
