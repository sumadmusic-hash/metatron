// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { BindingManager } from "../../src/core/BindingManager";
import { AppUI } from "../../src/ui/AppUI";
import { createDefaultMatrix } from "../../src/core/modulation/ModulationTypes";

/**
 * B55 — the runner must only run when the matrix can actually produce
 * destinations. It is NOT enough for a slot to be enabled: a slot whose
 * sourceId dangles (no matching ModSource in sources[]) evaluates to an empty
 * destination map every frame (ModulationEngine.evaluateDestinations skips
 * those slots) — an idle rAF loop. matrixRunnable() requires an enabled slot
 * routing an EXISTING source.
 */

class CapturingMidi extends MidiAccess {
    public override setMessageHandler(_cb: (channel: number, cc: number, value: number) => void) {}
}

class SilentAdapter extends NexusAdapter {
    public override updateBoundControl(_id: string, _v: number): Promise<boolean> {
        return Promise.resolve(true);
    }
}

function makeDevice(): { device: Device; ctrl: Control } {
    const device = new Device("B55");
    const ctrl = new Control("knob", "k", { x: 0, y: 0 }, "k1");
    ctrl.value = 0.5;
    device.addControl(ctrl);
    device.modulation = createDefaultMatrix();
    return { device, ctrl };
}

function mount(device: Device): { app: AppUI } {
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    lib.saveCurrentDevice();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const adapter = new SilentAdapter();
    const bm = new BindingManager(device);
    const app = new AppUI(root, lib, adapter, new CapturingMidi(), bm);
    app.render();
    return { app };
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

describe("B55 — runner start-guard requires an enabled slot routing an EXISTING source", () => {
    it("matrixRunnable → false with NO enabled slot (default matrix)", () => {
        const { app } = mount(makeDevice().device);
        expect((app as any).matrixRunnable((app as any).deviceLibrary.currentDevice)).toBe(false);
    });

    it("matrixRunnable → false when the enabled slot has a DANGLING sourceId", () => {
        const { device, ctrl } = makeDevice();
        device.modulation.slots[0].enabled = true;
        device.modulation.slots[0].destControlId = ctrl.id;
        device.modulation.slots[0].sourceId = "ghost-source";
        const { app } = mount(device);
        expect((app as any).matrixRunnable(device)).toBe(false);
    });

    it("matrixRunnable → true when an enabled slot routes an existing source", () => {
        const { device, ctrl } = makeDevice();
        device.modulation.slots[0].enabled = true;
        device.modulation.slots[0].destControlId = ctrl.id;
        device.modulation.slots[0].sourceId = device.modulation.sources[0].id;
        const { app } = mount(device);
        expect((app as any).matrixRunnable(device)).toBe(true);
    });

    it("render stops an idle slot-only runner and starts it once the source resolves", () => {
        const { device, ctrl } = makeDevice();
        device.modulation.slots[0].enabled = true;
        device.modulation.slots[0].destControlId = ctrl.id;
        device.modulation.slots[0].sourceId = "ghost-source";
        const { app } = mount(device);

        const runner = (app as any).modRunner;
        const stopSpy = vi.spyOn(runner, "stop");
        const startSpy = vi.spyOn(runner, "start");

        app.render();
        expect(stopSpy).toHaveBeenCalled();
        expect(startSpy).not.toHaveBeenCalled();

        device.modulation.slots[0].sourceId = device.modulation.sources[0].id;
        app.render();
        expect(startSpy).toHaveBeenCalled();
        vi.restoreAllMocks();
    });
});