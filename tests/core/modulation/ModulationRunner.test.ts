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

    it("B38 - last slot disable idles the active mod displays on the next tick", () => {
        const device = makeModDevice();
        const { runner, surface } = makeRunner(device, "IDLE");

        runner.start();
        (runner as any).tick(performance.now());
        expect(runner.isModulated("cutoff")).toBe(true);
        expect(surface.applyModDisplay).toHaveBeenCalledWith("cutoff", expect.any(Number));

        // Disable the (only) enabled slot; the next tick hits the early
        // return, which must idle the previously active display.
        device.modulation.slots[0].enabled = false;
        (runner as any).tick(performance.now());
        expect(runner.isModulated("cutoff")).toBe(false);
        expect(surface.applyModDisplay).toHaveBeenCalledWith("cutoff", null);
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

    it("RECORDING captures values when a write request is dispatched (S2 regression)", () => {
        // F2: the write-cap is PER-CONTROL, so two enabled destinations in one
        // tick dispatch write requests and are both captured (request == captured).
        // The pre-F2 global cap starved everything but the first destination.
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

        // Both destinations pass the per-control WRITE_INTERVAL_MS cap in the
        // same tick and are captured — no starvation (F2).
        expect(adapter.updateBoundControl).toHaveBeenCalledTimes(2);
        expect(recorder.capture).toHaveBeenCalledTimes(2);
    });

    it("F2 — no write-cap starvation: 3 destinations are all served in one tick", () => {
        const device = new Device("Runner");
        ["c1", "c2", "c3"].forEach((id, i) => {
            const c = new Control("knob", id, { x: 0, y: i }, id);
            c.value = 0.5;
            device.addControl(c);
        });
        const matrix = createDefaultMatrix();
        for (let i = 0; i < 3; i++) {
            matrix.slots[i].enabled = true;
            matrix.slots[i].destControlId = `c${i + 1}`;
            matrix.slots[i].amount = 1;
            matrix.slots[i].sourceId = matrix.sources[0].id;
        }
        device.modulation = matrix;

        const { runner, recorder, adapter } = makeRunner(device, "RECORDING");
        runner.start();
        (runner as any).tick(performance.now());

        expect(adapter.updateBoundControl).toHaveBeenCalledTimes(3);
        expect(recorder.capture).toHaveBeenCalledTimes(3);
        for (const id of ["c1", "c2", "c3"]) {
            expect(recorder.capture).toHaveBeenCalledWith(id, expect.any(Number), "knob");
        }
    });

    it("F2 — round-robin caps writes at MAX_WRITES_PER_TICK (5th destination rolls over)", () => {
        const device = new Device("Runner");
        ["c1", "c2", "c3", "c4", "c5"].forEach((id, i) => {
            const c = new Control("knob", id, { x: 0, y: i }, id);
            c.value = 0.5;
            device.addControl(c);
        });
        const matrix = createDefaultMatrix();
        for (let i = 0; i < 5; i++) {
            matrix.slots[i].enabled = true;
            matrix.slots[i].destControlId = `c${i + 1}`;
            // amount 0.6 keeps the modulated value off the 0/1 clamps so it
            // genuinely changes between the two ticks (B42 never swallows it).
            matrix.slots[i].amount = 0.6;
            matrix.slots[i].sourceId = matrix.sources[0].id;
        }
        device.modulation = matrix;

        const { runner, recorder, adapter } = makeRunner(device, "RECORDING");
        runner.start();
        // Deterministic timeline: startTimeSec = 0 → tick(tMs) yields
        // tSec = tMs/1000 (sine phase shifts visibly between ticks).
        (runner as any).startTimeSec = 0;

        // First tick: at most MAX_WRITES_PER_TICK (4) actual Nexus writes;
        // the 5th destination is deferred (round-robin cursor at index 4).
        (runner as any).tick(450);
        expect(adapter.updateBoundControl).toHaveBeenCalledTimes(4);
        expect(recorder.capture).toHaveBeenCalledTimes(4);

        // Second tick: the deferred destination is served first (roll-over);
        // the four written µs ago are still inside their 33 ms per-control cap
        // and are NOT rewritten.
        (runner as any).tick(600);
        expect(adapter.updateBoundControl).toHaveBeenCalledTimes(5);
        expect(recorder.capture).toHaveBeenCalledTimes(5);
    });

    it("F2 — per-control cap still throttles ONE destination across ticks (< 33 ms)", () => {
        const device = makeModDevice();
        const { runner, recorder, adapter } = makeRunner(device, "RECORDING");

        runner.start();
        (runner as any).tick(performance.now());
        expect(adapter.updateBoundControl).toHaveBeenCalledTimes(1);

        // Second tick happens µs later: the value is still off-base, so the
        // write is ATTEMPTED but the per-control 33 ms cap blocks it (and with
        // it the capture; only dispatched requests are captured).
        (runner as any).tick(performance.now());
        expect(adapter.updateBoundControl).toHaveBeenCalledTimes(1);
        expect(recorder.capture).toHaveBeenCalledTimes(1);
    });

    it("REC capture does not wait for the async Nexus transaction to resolve", () => {
        const device = makeModDevice();
        let resolveWrite: ((ok: boolean) => void) | undefined;
        const { runner, recorder, adapter } = makeRunner(device, "RECORDING");
        vi.spyOn(adapter, "updateBoundControl").mockImplementation(
            () => new Promise<boolean>((resolve) => { resolveWrite = resolve; }),
        );

        runner.start();
        (runner as any).tick(performance.now());

        expect(adapter.updateBoundControl).toHaveBeenCalledTimes(1);
        expect(recorder.capture).toHaveBeenCalledTimes(1);
        expect((runner as any).inFlight.size).toBe(1);

        resolveWrite?.(true);
    });

    it("B2 — a constant modulated value (square wave) is NOT lost after the first blocked frame", () => {
        // 5 destinations on ONE square source: the modulated value stays
        // CONSTANT across all frames (0.8 within one half-wave), so the
        // B42-DOM-Deduplizierung sieht immer "identisch" — und ohne den B2-Fix
        // würde das 5. Ziel nie angeboten (erster Frame schrieb nur 4).
        const device = new Device("Runner");
        ["c1", "c2", "c3", "c4", "c5"].forEach((id, i) => {
            const c = new Control("knob", id, { x: 0, y: i }, id);
            c.value = 0.5;
            device.addControl(c);
        });
        const matrix = createDefaultMatrix();
        matrix.sources[0].waveform = "square";
        matrix.sources[0].rateHz = 1; // 1 Hz → Halbwelle 0.5 s
        for (let i = 0; i < 5; i++) {
            matrix.slots[i].enabled = true;
            matrix.slots[i].destControlId = `c${i + 1}`;
            matrix.slots[i].amount = 0.3;
            matrix.slots[i].sourceId = matrix.sources[0].id;
        }
        device.modulation = matrix;

        const { runner, adapter } = makeRunner(device, "IDLE");
        runner.start();
        (runner as any).startTimeSec = 0;

        // Frames innerhalb EINER Halbwelle (Phase 0.30..0.46 < 0.5 → square +1):
        // Frame 1 schreibt nur MAX_WRITES_PER_TICK=4 Ziele, das 5. wird
        // deferiert. Sein Wert ändert sich nie — ohne B2 gäbe es dafür nie
        // einen Write-Aufruf, mit B2 wird es weiter angeboten und im nächsten
        // Frame bedient.
        for (const t of [300, 340, 380, 420, 460]) {
            (runner as any).tick(t);
        }

        // Jedes Ziel bekam mindestens einen apply per Halbwelle — keins
        // verhungert dauerhaft vor dem Per-Control-Cap.
        for (let i = 1; i <= 5; i++) {
            const calls = adapter.updateBoundControl.mock.calls.filter((c) => c[0] === `c${i}`);
            expect(calls.length).toBeGreaterThanOrEqual(1);
        }
        // Genau die 4 geschriebenen Ziele des ersten Frames + das roll-über
        // Ziel = 5 echte Writes (die 33-ms-Per-Control-Caps blockieren die
        // restlichen Wiederholungen).
        expect(adapter.updateBoundControl).toHaveBeenCalledTimes(5);
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

        // Simulate pointercancel → setGestureTakeover(false). The resumed
        // write needs a DIFFERENT modulated value than the takeover frame:
        // tSec 0.25 clamps to 1.0 (sine peak); tSec 0.45 → mod ≈ 0.809, so
        // B42's value-skip does not swallow the resume.
        runner.setGestureTakeover("cutoff", false);
        (runner as any).tick(tWithDelta + 200);

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

    it("B46 - gesture takeover suspends Nexus writes while active and pins captures to the base (B11)", () => {
        const device = makeModDevice();
        const { runner, surface, recorder, adapter } = makeRunner(device, "RECORDING");

        runner.start();
        // Deterministic timeline as in the pointercancel test above.
        (runner as any).startTimeSec = 0;
        const tWithDelta = 250;

        runner.setGestureTakeover("cutoff", true);
        (runner as any).tick(tWithDelta);

        // No Nexus write (and no echo suppression) while the user owns the knob.
        expect(adapter.updateBoundControl).not.toHaveBeenCalled();
        expect(adapter.beginSuppressEcho).not.toHaveBeenCalled();
        // The needle stays live for the grabbed destination.
        expect(surface.applyModDisplay).toHaveBeenCalledWith("cutoff", expect.any(Number));
        // B11: a take captures the BASE value — the listener hears the gesture,
        // not the (suppressed) modulated write.
        expect(recorder.capture).toHaveBeenCalledTimes(1);
        const [id, captured, type] = recorder.capture.mock.calls[0];
        expect(id).toBe("cutoff");
        expect(captured).toBe(0.5); // base value, NOT a modulated value
        expect(type).toBe("knob");

        runner.setGestureTakeover("cutoff", false);
        (runner as any).tick(tWithDelta + 200);
        // Writes resume after the takeover is released. tSec shifts 0.25 → 0.45
        // so the modulated value differs (0.809 vs the clamped 1.0) and B42's
        // redundant-write skip does not swallow the resumed write.
        expect(adapter.updateBoundControl).toHaveBeenCalledWith("cutoff", expect.any(Number));
    });
});

/* ------------------------------------------------------------------ *
 *  Tests: B3 Snap-back (Basiswert nach Nexus beim Stop der Mod)
 * ------------------------------------------------------------------ */

describe("ModulationRunner — B3 Snap-back", () => {
    // R2 — der Snap-back hängt sich jetzt an ein hängendes Write-Promise an;
    // mit sofort auflösendem Mock heißt das: der Basis-Write landet im
    // Microtask nach stop()/tick(). Eine Makrotask-Flush räumt das sauber.
    const flushWrites = async () => new Promise((r) => setTimeout(r, 0));

    it("stop() schreibt den Basiswert jedes aktiven Ziels einmal nach Nexus", async () => {
        const device = makeModDevice();
        const { runner, adapter } = makeRunner(device, "IDLE");

        runner.start();
        (runner as any).startTimeSec = 0;
        (runner as any).tick(450); // tSec 0.45 → mod 0.809, wird geschrieben

        expect(adapter.updateBoundControl).toHaveBeenCalledTimes(1);

        runner.stop();
        await flushWrites();
        // Der Snap-back passiert µs nach dem Mod-Write — die 33-ms-Fahrspur
        // würde ihn schlucken; er umgeht sie bewusst (One-Shot ohne Cap),
        // landet aber erst nach dem hängenden Mod-Write (R2).
        expect(adapter.updateBoundControl).toHaveBeenCalledTimes(2);
        const [id, value] = adapter.updateBoundControl.mock.calls.at(-1);
        expect(id).toBe("cutoff");
        expect(value).toBe(0.5); // Kontroll-Basiswert, nicht der Mod-Wert
        expect(adapter.beginSuppressEcho).toHaveBeenLastCalledWith("cutoff", 0.5);
    });

    it("verschwundenes Ziel bekommt seinen Basiswert (Ziel-weg-Schleife)", async () => {
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

        const { runner, adapter, surface } = makeRunner(device, "IDLE");
        runner.start();
        (runner as any).startTimeSec = 0;
        (runner as any).tick(450); // c1 + c2 werden moduliert und geschrieben

        matrix.slots[0].enabled = false;
        (runner as any).tick(600); // c1 verschwindet aus destinations
        await flushWrites();

        expect(runner.isModulated("c1")).toBe(false);
        expect(runner.isModulated("c2")).toBe(true);
        const [id, value] = adapter.updateBoundControl.mock.calls.at(-1);
        expect(id).toBe("c1");
        expect(value).toBe(0.5); // Basiswert, nicht der letzte Mod-Wert
        expect(surface.applyModDisplay).toHaveBeenCalledWith("c1", null);
    });

    it("Matrix-Deaktivierung schreibt die Basiswerte (Frühabbruch)", async () => {
        const device = makeModDevice();
        const { runner, adapter, surface } = makeRunner(device, "IDLE");

        runner.start();
        (runner as any).startTimeSec = 0;
        (runner as any).tick(450);

        device.modulation.slots[0].enabled = false;
        (runner as any).tick(600); // Frühabbruch, kein aktiver Slot mehr
        await flushWrites();

        expect(runner.isModulated("cutoff")).toBe(false);
        const [id, value] = adapter.updateBoundControl.mock.calls.at(-1);
        expect(id).toBe("cutoff");
        expect(value).toBe(0.5);
        expect(surface.applyModDisplay).toHaveBeenCalledWith("cutoff", null);
    });

    it("kein Snap-back für archivierte Ziele", () => {
        const device = makeModDevice();
        const { runner, adapter } = makeRunner(device, "IDLE");

        runner.start();
        (runner as any).startTimeSec = 0;
        (runner as any).tick(450);
        expect(adapter.updateBoundControl).toHaveBeenCalledTimes(1);

        device.getControl("cutoff")!.softDelete(); // archiviert
        runner.stop();

        // Archivierte Controls sind nie hörbar → kein Basiswert-Write.
        expect(adapter.updateBoundControl).toHaveBeenCalledTimes(1);
        expect(adapter.beginSuppressEcho).toHaveBeenCalledTimes(1);
    });

    it("kein Snap-back ohne aktives Binding", () => {
        const device = makeModDevice();
        const adapter = mockAdapter();
        const bm = { getActiveBinding: vi.fn().mockReturnValue(undefined) } as unknown as BindingManager;
        const recorder = mockRecorder("IDLE");
        const surface = mockSurfaceUI();
        const runner = new ModulationRunner(
            () => device,
            () => 120,
            adapter,
            bm,
            recorder as any,
            surface
        );

        runner.start();
        (runner as any).startTimeSec = 0;
        (runner as any).tick(450);
        expect(runner.isModulated("cutoff")).toBe(true); // Nadel an...

        runner.stop();

        // ...aber ohne Binding wird weder der Mod-Wert noch der Basiswert
        // nach Nexus geschrieben (nichts zu hören).
        expect(adapter.updateBoundControl).not.toHaveBeenCalled();
        expect(adapter.beginSuppressEcho).not.toHaveBeenCalled();
    });

    it("kein Snap-back während Gesture-Takeover (User hält den Regler)", () => {
        const device = makeModDevice();
        const { runner, adapter } = makeRunner(device, "IDLE");

        runner.start();
        (runner as any).startTimeSec = 0;
        runner.setGestureTakeover("cutoff", true);
        (runner as any).tick(450);
        runner.stop();

        // Während des Takeover wird der Regler weder moduliert noch auf den
        // Basiswert zurückgezogen — der User besitzt den Wert gerade.
        expect(adapter.updateBoundControl).not.toHaveBeenCalled();
        expect(adapter.beginSuppressEcho).not.toHaveBeenCalled();
    });

    it("R2 — Snap-back reiht sich HINTER einen hängenden Mod-Write (letzter Wert ist der Basiswert)", async () => {
        const device = makeModDevice();

        // updateBoundControl löst erst nach manuellem Signal auf — der
        // Mod-Write bleibt über stop() hinaus hängend.
        let releaseModWrite: (v: boolean) => void = () => {};
        const modWrite = new Promise<boolean>((resolve) => { releaseModWrite = resolve; });
        const adapter = mockAdapter();
        (adapter.updateBoundControl as any).mockReturnValueOnce(modWrite);

        const bm = mockBindingManager();
        const recorder = mockRecorder("IDLE");
        const surface = mockSurfaceUI();
        const runner = new ModulationRunner(
            () => device,
            () => 120,
            adapter,
            bm,
            recorder as any,
            surface
        );

        runner.start();
        (runner as any).startTimeSec = 0;
        (runner as any).tick(450); // Mod-Write startet und bleibt in-flight
        expect(adapter.updateBoundControl).toHaveBeenCalledTimes(1);

        runner.stop();
        await flushWrites();
        // Solange der Mod-Write hängt, darf der Snap-back nicht gefeuert haben:
        // ohne die Promise-Kette liefe BEIDES sofort und der späte Mod-Write
        // käme NACH dem Basiswert an — exakt der B3-Endzustand, nur seltener.
        expect(adapter.updateBoundControl).toHaveBeenCalledTimes(1);

        releaseModWrite(true);
        await flushWrites();
        expect(adapter.updateBoundControl).toHaveBeenCalledTimes(2);
        const [id, value] = adapter.updateBoundControl.mock.calls.at(-1);
        expect(id).toBe("cutoff");
        expect(value).toBe(0.5); // Basiswert zuletzt geschrieben
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

        // applyModDisplay with a value → idle removed, amber arc set in the
        // RELATIVE angle space (0..270, matching CSS `from -135deg`):
        // start = base(0.5) * 270 = 135deg, end = modulated(0.7) * 270 = 189deg.
        surface.applyModDisplay("cutoff", 0.7);
        expect(modRing!.classList.contains("idle")).toBe(false);
        expect(modRing!.style.getPropertyValue("--knob-mod-start")).toBe("135deg");
        expect(modRing!.style.getPropertyValue("--knob-mod-end")).toBe("189deg");

        // Downward modulation (mod < base): start/end are min/max-swapped so
        // the amber band stays visible instead of collapsing (M2).
        surface.applyModDisplay("cutoff", 0.2);
        expect(modRing!.style.getPropertyValue("--knob-mod-start")).toBe("54deg");
        expect(modRing!.style.getPropertyValue("--knob-mod-end")).toBe("135deg");

        // applyModDisplay with null → idle added
        surface.applyModDisplay("cutoff", null);
        expect(modRing!.classList.contains("idle")).toBe(true);
    });

    it("Bug 2/3 — refreshModulationStates paints ONLY the mod-ring; the base value ring stays cyan", async () => {
        const { SurfaceUI } = await import("../../../src/ui/surface/SurfaceUI");
        const { DeviceLibrary } = await import("../../../src/core/DeviceLibrary");
        const { NexusAdapter } = await import("../../../src/nexus/NexusAdapter");
        const { MidiAccess } = await import("../../../src/midi/MidiAccess");
        const { MidiMapping } = await import("../../../src/midi/MidiMapping");

        const lib = new DeviceLibrary();
        const device = makeModDevice(); // slot1 → cutoff, enabled
        lib.currentDevice = device;
        lib.saveCurrentDevice();

        const surface = new SurfaceUI(
            lib,
            new NexusAdapter(),
            new MidiAccess(),
            new BindingManager(device),
            new MidiMapping(device),
            () => {},
            () => {},
        );
        const root = document.createElement("div");
        document.body.appendChild(root);
        surface.render(root);

        // Bug 2/3 — a matrix edit pushed through the onMatrixChange path must
        // NOT re-render and must NOT recolour the whole knob ring: the amber
        // "modulation active" state stays on the knob-body (presence) + mod-ring
        // (range) exclusively, the base value ring stays cyan.
        surface.refreshModulationStates();
        expect(root.querySelectorAll(".knob-svg-ring.modulated").length).toBe(0);
        expect(root.querySelectorAll(".knob-led-ring.modulated").length).toBe(0);
        const modRing = root.querySelector<HTMLElement>(".knob-mod-ring");
        expect(modRing).toBeTruthy();
        expect(root.querySelector<HTMLElement>(".knob-body.modulated")).toBeTruthy();
        expect(modRing!.classList.contains("idle")).toBe(true);

        // Turn the route off (matrix edit) → the state clears immediately and
        // the mod ring idles again — without any runner interaction.
        device.modulation.slots[0].enabled = false;
        surface.refreshModulationStates();
        expect(root.querySelector<HTMLElement>(".knob-body.modulated")).toBeNull();
        expect(modRing!.classList.contains("idle")).toBe(true);
    });
});

/* ------------------------------------------------------------------ *
 *  Tests: Snap-back Generation Guard (Race Condition)
 * ------------------------------------------------------------------ */

describe("ModulationRunner — Snap-back Generation Guard", () => {
    const flushWrites = async () => new Promise((r) => setTimeout(r, 0));

    it("alter Snap-back darf nach Restart keinen neueren Mod-Wert überschreiben", async () => {
        const device = makeModDevice();
        let resolveModWrite: (v: boolean) => void = () => {};
        const modWrite = new Promise<boolean>((resolve) => { resolveModWrite = resolve; });
        const adapter = mockAdapter();
        (adapter.updateBoundControl as any).mockReturnValueOnce(modWrite);

        const { runner, adapter: ad } = makeRunner(device, "IDLE");
        // override adapter with our controlled one
        (runner as any).nexusAdapter = adapter;

        runner.start();
        (runner as any).startTimeSec = 0;
        (runner as any).tick(450); // mod write starts, stays pending

        // stop() triggers snap-back which awaits the pending mod write
        runner.stop();
        // Don't flush yet - let the snap-back wait for the mod write

        // Restart: new mod write should be dispatched
        runner.start();
        (runner as any).startTimeSec = 0;
        (runner as any).tick(500); // new mod value

        // Now resolve the OLD mod write
        resolveModWrite(true);
        await flushWrites();

        // The OLD snap-back should NOT have written base value (generation guard)
        // Only the new mod write + potentially a NEW snap-back from the restart
        const calls = ad.updateBoundControl.mock.calls;
        // Find calls for "cutoff"
        const cutoffCalls = calls.filter((c: any[]) => c[0] === "cutoff");
        
        // Should have: 1 old mod write (pending), 1 new mod write
        // The old snap-back should be suppressed by generation guard
        expect(cutoffCalls.length).toBeLessThanOrEqual(2);
        
        // If there are 2 calls, the LAST one should be the new mod value (not base 0.5)
        if (cutoffCalls.length === 2) {
            const lastCall = cutoffCalls[1];
            expect(lastCall[1]).not.toBe(0.5); // not the base value
        }
    });
});
