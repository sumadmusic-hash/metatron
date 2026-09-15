// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ModulationRunner } from "../../../src/modulation/ModulationRunner";
import { Device } from "../../../src/core/model/Device";
import { Control } from "../../../src/core/model/Control";
import { BindingManager } from "../../../src/core/BindingManager";
import { NexusAdapter } from "../../../src/nexus/NexusAdapter";
import { createDefaultMatrix } from "../../../src/core/modulation/ModulationTypes";

/* ------------------------------------------------------------------ *
 *  Mocks: recorder, bindingManager, nexusAdapter, surfaceUI
 * ------------------------------------------------------------------ */

function mockRecorder(state: "IDLE" | "ARMED" | "RECORDING" | "STOPPED" = "IDLE") {
    return {
        currentState: state,
        capture: vi.fn(),
    };
}

function mockSurfaceUI() {
    return { applyModDisplay: vi.fn() };
}

function mockAdapter() {
    return {
        beginSuppressEcho: vi.fn(),
        updateBoundControl: vi.fn().mockResolvedValue(true),
    } as unknown as NexusAdapter;
}

function mockBindingManager() {
    return { getActiveBinding: vi.fn().mockReturnValue({}) } as unknown as BindingManager;
}

/* ------------------------------------------------------------------ *
 *  Device with one enabled source + one enabled slot → viable matrix
 * ------------------------------------------------------------------ */

function makeModDevice(controlId = "cutoff"): Device {
    const device = new Device("Runner");
    const control = new Control("knob", "Cutoff", { x: 0, y: 0 }, controlId);
    control.value = 0.5;
    device.addControl(control);

    const matrix = createDefaultMatrix();
    // Enable source 1 (sine LFO, 1 Hz)
    matrix.sources[0].enabled = true;
    // Enable slot 1 → destination = our control
    matrix.slots[0].enabled = true;
    matrix.slots[0].destControlId = controlId;
    matrix.slots[0].amount = 1;
    matrix.slots[0].sourceId = matrix.sources[0].id;
    device.modulation = matrix;
    return device;
}

/* ------------------------------------------------------------------ *
 *  Helpers
 * ------------------------------------------------------------------ */

function makeRunner(device: Device | null, recorderState: "IDLE" | "RECORDING" | "STOPPED" = "IDLE") {
    const getDevice = () => device;
    const getBpm = () => 120;
    const adapter = mockAdapter();
    const bm = mockBindingManager();
    const recorder = mockRecorder(recorderState);
    const surface = mockSurfaceUI();
    const runner = new ModulationRunner(getDevice, getBpm, adapter, bm, recorder as any, surface);
    return { runner, adapter, bm, recorder, surface };
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

/* ------------------------------------------------------------------ *
 *  Tests: Runner-Lifecycle
 * ------------------------------------------------------------------ */

describe("ModulationRunner — Lifecycle", () => {
    it("isModulated returns false before start", () => {
        const { runner } = makeRunner(makeModDevice());
        expect(runner.isModulated("cutoff")).toBe(false);
    });

    it("start() is idempotent (calling twice does not double-start rAF)", () => {
        const { runner } = makeRunner(makeModDevice());
        runner.start();
        const id1 = (runner as any).rafId;
        runner.start(); // second call is a no-op
        expect((runner as any).rafId).toBe(id1);
    });

    it("stop() clears gestureTakeover map", () => {
        const { runner } = makeRunner(makeModDevice());
        runner.setGestureTakeover("cutoff", true);
        runner.stop();
        expect((runner as any).gestureTakeover.has("cutoff")).toBe(false);
    });

    it("stop() is idempotent (calling on already-stopped runner does not throw)", () => {
        const { runner } = makeRunner(makeModDevice());
        expect(() => runner.stop()).not.toThrow();
    });

    it("stop() clears activeDestinationIds and calls applyModDisplay(null) for each", () => {
        const { runner, surface } = makeRunner(makeModDevice());
        // Simulate: start + one tick sets the destination active
        runner.start();
        (runner as any).tick(performance.now());
        expect(runner.isModulated("cutoff")).toBe(true);

        runner.stop();
        expect(runner.isModulated("cutoff")).toBe(false);
        expect(surface.applyModDisplay).toHaveBeenCalledWith("cutoff", null);
    });
});

/* ------------------------------------------------------------------ *
 *  Tests: Capture-Arbitration
 * ------------------------------------------------------------------ */

describe("ModulationRunner — Capture-Arbitration", () => {
    it("runner captures modulated value when recorder is RECORDING", () => {
        const device = makeModDevice();
        const { runner, recorder, surface } = makeRunner(device, "RECORDING");

        runner.start();
        (runner as any).tick(performance.now());

        expect(recorder.capture).toHaveBeenCalled();
        const [id, value] = recorder.capture.mock.calls[0];
        expect(id).toBe("cutoff");
        expect(typeof value).toBe("number");
    });

    it("runner does NOT capture when recorder is IDLE", () => {
        const device = makeModDevice();
        const { runner, recorder } = makeRunner(device, "IDLE");

        runner.start();
        (runner as any).tick(performance.now());

        expect(recorder.capture).not.toHaveBeenCalled();
    });

    it("archived controls are NEVER captured, even while RECORDING (archived ≠ hörbar, FIX 9)", () => {
        const device = makeModDevice();
        const control = device.getControl("cutoff")!;
        control.softDelete(); // archive → archived = true
        const { runner, recorder } = makeRunner(device, "RECORDING");

        runner.start();
        (runner as any).tick(performance.now());

        // FIX 9 guard: archived destination = not audible → never captured.
        expect(recorder.capture).not.toHaveBeenCalled();
    });

    it("runner captures the BASE value during gesture-takeover when RECORDING (B11)", () => {
        const device = makeModDevice();
        const { runner, recorder } = makeRunner(device, "RECORDING");
        runner.setGestureTakeover("cutoff", true);

        runner.start();
        (runner as any).tick(performance.now());

        // B11: during takeover, activeDestinationIds is set FIRST (control is
        // still "modulated"), but the audible value is the gesture base value
        // — exactly that is captured, so a take never thins out.
        expect(runner.isModulated("cutoff")).toBe(true);
        expect(recorder.capture).toHaveBeenCalledTimes(1);
        const [id, captured, type] = recorder.capture.mock.calls[0];
        expect(id).toBe("cutoff");
        expect(captured).toBe(0.5); // base value 0.5, NOT the modulated value
        expect(type).toBe("knob");
    });
});

/* ------------------------------------------------------------------ *
 *  Tests: Takeover-Klemmfalle (pointercancel)
 * ------------------------------------------------------------------ */

describe("ModulationRunner — Takeover-Klemmfalle", () => {
    it("while takeover is active the runner writes nothing; after release it resumes (pointercancel-safe)", () => {
        const device = makeModDevice();
        const { runner, surface, adapter } = makeRunner(device);

        runner.start();
        // Deterministic timeline: forcar tSec = now/1000 (instead of the
        // boot-clock), so 250ms → sine phase 0.25 → modulated value ~1.0.
        (runner as any).startTimeSec = 0;
        const tWithDelta = 250;

        runner.setGestureTakeover("cutoff", true);
        (runner as any).tick(tWithDelta);

        // Display is still driven during takeover (B11 keeps the needle live)...
        expect(surface.applyModDisplay).toHaveBeenCalledWith("cutoff", expect.any(Number));
        // ...but no Nexus write may happen while the user owns the knob.
        expect(adapter.updateBoundControl).not.toHaveBeenCalled();
        expect(adapter.beginSuppressEcho).not.toHaveBeenCalled();

        // Simulate pointercancel → setGestureTakeover(false)
        runner.setGestureTakeover("cutoff", false);
        (runner as any).tick(tWithDelta + 40);

        // Writes resume once the takeover is released.
        expect(adapter.updateBoundControl).toHaveBeenCalledWith("cutoff", expect.any(Number));
        expect(adapter.beginSuppressEcho).toHaveBeenCalledWith("cutoff", expect.any(Number));
    });

    it("a zero-phase tick whose modulated value equals the base is NOT written (delta-epsilon gate)", () => {
        const device = makeModDevice();
        const { runner, surface, adapter } = makeRunner(device);

        runner.start();
        // tSec = 0 → sine(0) = 0 → modulated == base 0.5 → below DELTA_EPSILON.
        // Setting startTimeSec = 0 makes tick(0) deterministic.
        (runner as any).startTimeSec = 0;
        (runner as any).tick(0);

        expect(surface.applyModDisplay).toHaveBeenCalledWith("cutoff", expect.any(Number));
        expect(adapter.updateBoundControl).not.toHaveBeenCalled();
    });
});

/* ------------------------------------------------------------------ *
 *  Tests: applyModDisplay idle-Toggle
 * ------------------------------------------------------------------ */

describe("SurfaceUI.applyModDisplay — idle-Toggle", () => {
    it("SurfaceUI.applyModDisplay adds .idle on null", async () => {
        const { SurfaceUI } = await import("../../../src/ui/surface/SurfaceUI");
        const { DeviceLibrary } = await import("../../../src/core/DeviceLibrary");
        const { NexusAdapter } = await import("../../../src/nexus/NexusAdapter");
        const { MidiAccess } = await import("../../../src/midi/MidiAccess");
        const { MidiMapping } = await import("../../../src/midi/MidiMapping");

        const lib = new DeviceLibrary();
        const device = makeModDevice();
        lib.currentDevice = device;
        lib.saveCurrentDevice();

        const adapter = new NexusAdapter();
        const bm = new BindingManager(device);
        const surface = new SurfaceUI(
            lib,
            adapter,
            new MidiAccess(),
            bm,
            new MidiMapping(device),
            () => {},
            () => {},
        );

        // Render to create the knob DOM
        const root = document.createElement("div");
        document.body.appendChild(root);
        surface.render(root);

        const modPos = root.querySelector<HTMLElement>(".knob-mod-position");
        expect(modPos).toBeTruthy();
        expect(modPos!.classList.contains("idle")).toBe(true);

        // applyModDisplay with a value → idle removed, transform set
        surface.applyModDisplay("cutoff", 0.7);
        expect(modPos!.classList.contains("idle")).toBe(false);
        expect(modPos!.style.transform).toContain("rotate");

        // applyModDisplay with null → idle added
        surface.applyModDisplay("cutoff", null);
        expect(modPos!.classList.contains("idle")).toBe(true);
    });
});
