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
 *  Device with one source (always active) + one enabled slot → viable matrix
 * ------------------------------------------------------------------ */

function makeModDevice(controlId = "cutoff"): Device {
    const device = new Device("Runner");
    const control = new Control("knob", "Cutoff", { x: 0, y: 0 }, controlId);
    control.value = 0.5;
    device.addControl(control);

    const matrix = createDefaultMatrix();
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

    it("RECORDING captures ONLY values writeControl actually applies (S2 regression)", () => {
        const device = new Device("Runner");
        const c1 = new Control("knob", "Cutoff", { x: 0, y: 0 }, "c1");
        c1.value = 0.5;
        const c2 = new Control("knob", "Reso", { x: 0, y: 1 }, "c2");
        c2.value = 0.5;
        device.addControl(c1);
        device.addControl(c2);

        const matrix = createDefaultMatrix();
        matrix.slots[0].enabled = true;
        matrix.slots[0].destControlId = "c1";
        matrix.slots[0].amount = 1;
        matrix.slots[0].sourceId = matrix.sources[0].id;
        matrix.slots[1].enabled = true;
        matrix.slots[1].destControlId = "c2";
        matrix.slots[1].amount = 1;
        matrix.slots[1].sourceId = matrix.sources[0].id;
        device.modulation = matrix;

        const { runner, recorder, adapter } = makeRunner(device, "RECORDING");

        runner.start();
        (runner as any).tick(performance.now());

        // First write passes → captured. Second write is blocked by
        // WRITE_INTERVAL_MS → MUST NOT be captured (recorded == applied, FIX S2).
        expect(adapter.updateBoundControl).toHaveBeenCalledTimes(1);
        expect(recorder.capture).toHaveBeenCalledTimes(1);
    });

    it("removes a destination whose slot was disabled from activeDestinationIds mid-run (needle off)", () => {
        const device = new Device("Runner");
        const c1 = new Control("knob", "Cutoff", { x: 0, y: 0 }, "c1");
        c1.value = 0.5;
        const c2 = new Control("knob", "Reso", { x: 0, y: 1 }, "c2");
        c2.value = 0.5;
        device.addControl(c1);
        device.addControl(c2);

        const matrix = createDefaultMatrix();
        matrix.slots[0].enabled = true;
        matrix.slots[0].destControlId = "c1";
        matrix.slots[0].amount = 1;
        matrix.slots[0].sourceId = matrix.sources[0].id;
        matrix.slots[1].enabled = true;
        matrix.slots[1].destControlId = "c2";
        matrix.slots[1].amount = 1;
        matrix.slots[1].sourceId = matrix.sources[0].id;
        device.modulation = matrix;

        const { runner, recorder, adapter, surface } = makeRunner(device, "IDLE");

        runner.start();

        (runner as any).tick(performance.now());
        expect(runner.isModulated("c1")).toBe(true);
        expect(runner.isModulated("c2")).toBe(true);

        matrix.slots[1].enabled = false;
        (runner as any).tick(performance.now());

        expect(runner.isModulated("c1")).toBe(true);
        expect(runner.isModulated("c2")).toBe(false);
        expect(surface.applyModDisplay).toHaveBeenCalledWith("c2", null);
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

        // The modulated knob carries the amber ring state; an unmodulated
        // second control must NOT — the glow ring stays cyan for it.
        device.addControl(new Control("knob", "Reso", { x: 0, y: 0 }, "reso"));

        // Render to create the knob DOM
        const root = document.createElement("div");
        document.body.appendChild(root);
        surface.render(root);

        const cutoffBody = root.querySelector<HTMLElement>(".knob-body.modulated");
        expect(cutoffBody).toBeTruthy();
        (root.querySelectorAll(".knob-body") as unknown as HTMLElement[]).forEach((b) => {
            const name = b.closest("[data-ctl-id]")?.getAttribute("data-ctl-id");
            expect(b.classList.contains("modulated")).toBe(name === "cutoff");
        });

        const modRing = root.querySelector<HTMLElement>(".knob-mod-ring");
        expect(modRing).toBeTruthy();
        expect(modRing!.classList.contains("idle")).toBe(true);

        // applyModDisplay with a value → idle removed, amber arc end set
        surface.applyModDisplay("cutoff", 0.7);
        expect(modRing!.classList.contains("idle")).toBe(false);
        expect(modRing!.style.getPropertyValue("--knob-mod-start")).toContain("deg");
        expect(modRing!.style.getPropertyValue("--knob-mod-end")).toBe("54deg");

        // applyModDisplay with null → idle added
        surface.applyModDisplay("cutoff", null);
        expect(modRing!.classList.contains("idle")).toBe(true);
    });
});
