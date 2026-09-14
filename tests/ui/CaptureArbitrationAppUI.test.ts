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
 * FIX 2 — Capture-Arbitration at the AppUI boundary:
 *   applyValueToDevice must NOT re-capture a destination the modulation
 *   runner is currently modulating (the runner owns that capture). For a
 *   non-modulated control the plain capture path stays intact.
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
    const device = new Device("CapArb");
    const ctrl = new Control("knob", "k", { x: 0, y: 0 }, "k1");
    ctrl.value = 0.5;
    device.addControl(ctrl);

    const matrix = createDefaultMatrix();
    matrix.sources[0].enabled = true;
    matrix.slots[0].enabled = true;
    matrix.slots[0].destControlId = "k1";
    matrix.slots[0].sourceId = matrix.sources[0].id;
    matrix.slots[0].amount = 0.5;
    device.modulation = matrix;
    return { device, ctrl };
}

function mount(device: Device): { app: AppUI; recorder: { capture: ReturnType<typeof vi.fn> } } {
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    lib.saveCurrentDevice();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const adapter = new SilentAdapter();
    const bm = new BindingManager(device);
    const app = new AppUI(root, lib, adapter, new CapturingMidi(), bm);
    app.render();
    // USE mode so the surface widgets exist (runner lifecycle parity).
    const toggle = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.innerText === "USE",
    );
    toggle?.click();

    const recorder = (app as any).recorder as { capture: ReturnType<typeof vi.fn> };
    recorder.capture = vi.fn(recorder.capture as any);
    return { app, recorder };
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

describe("Capture-Arbitration — AppUI.applyValueToDevice (FIX 2)", () => {
    it("modulated control: gesture update does NOT call recorder.capture", async () => {
        const { device, ctrl } = makeDevice();
        const { app, recorder } = mount(device);
        // Force the runner to claim the destination without running the rAF loop.
        const runner = (app as any).modRunner;
        vi.spyOn(runner, "isModulated").mockReturnValue(true);

        (app as any).applyValueToDevice(ctrl.id, 0.8);

        expect(ctrl.value).toBe(0.8);
        expect(recorder.capture).not.toHaveBeenCalled();
        vi.restoreAllMocks();
    });

    it("non-modulated control: gesture update still calls recorder.capture", () => {
        const { device, ctrl } = makeDevice();
        const { app, recorder } = mount(device);
        const runner = (app as any).modRunner;
        vi.spyOn(runner, "isModulated").mockReturnValue(false);

        (app as any).applyValueToDevice(ctrl.id, 0.3);

        expect(ctrl.value).toBe(0.3);
        expect(recorder.capture).toHaveBeenCalledWith(ctrl.id, 0.3, ctrl.type);
        vi.restoreAllMocks();
    });
});