import { evaluateDestinations } from "../core/modulation/ModulationEngine";
import type { AutomationRecorder } from "../automation/AutomationRecording";
import type { BindingManager } from "../core/BindingManager";
import type { Device } from "../core/model/Device";
import type { NexusAdapter } from "../nexus/NexusAdapter";

/** Minimum wall-clock distance between two Nexus writes of ANY control
 *  (FIX 8 — write-cap). ≈30 writes/s max across the whole matrix. */
const WRITE_INTERVAL_MS = 33;

/** Minimum absolute change of the modulated value vs. the control's base value
 *  before a control is written again. Below this, the modulation has no
 *  audible effect and the write is skipped (micro-jitter guard). */
const DELTA_EPSILON = 0.002;

/** Surface-side contract the runner drives for the amber modulation needle.
 *  Implemented by SurfaceUI.applyModDisplay. `null` = needle off. */
export interface ModulationSurfaceUI {
    applyModDisplay(controlId: string, modulated: number | null): void;
}

/**
 * Phase 2 — ModulationRunner owns the rAF loop that evaluates an enabled
 * modulation matrix into live controls:
 *
 *  - FIX 2 (Capture-Arbitration): while a destination is modulated, its
 *    recording capture happens HERE (only while the recorder is RECORDING),
 *    and a live user gesture (gestureTakeover) suspends its writes.
 *  - FIX 8 (Write-Cap): writes are capped at WRITE_INTERVAL_MS and guarded by
 *    an in-flight set so a slow Nexus write never piles up per control.
 *  - FIX 1 (Echo-Guard): every Nexus write is preceded by
 *    beginSuppressEcho, so the round-trip event is absorbed by the adapter.
 */
export class ModulationRunner {
    private readonly getDevice: () => Device | null;
    private readonly getBpm: () => number;
    private readonly nexusAdapter: NexusAdapter;
    private readonly bindingManager: BindingManager;
    private readonly recorder: AutomationRecorder;
    private readonly surfaceUI: ModulationSurfaceUI;

    private rafId: number | null = null;
    private startTimeSec = 0;
    private lastWriteMs = 0;
    private readonly inFlight = new Set<string>();
    private readonly activeDestinationIds = new Set<string>();
    private readonly gestureTakeover = new Map<string, boolean>();

    constructor(
        getDevice: () => Device | null,
        getBpm: () => number,
        nexusAdapter: NexusAdapter,
        bindingManager: BindingManager,
        recorder: AutomationRecorder,
        surfaceUI: ModulationSurfaceUI
    ) {
        this.getDevice = getDevice;
        this.getBpm = getBpm;
        this.nexusAdapter = nexusAdapter;
        this.bindingManager = bindingManager;
        this.recorder = recorder;
        this.surfaceUI = surfaceUI;
    }

    /** True while `controlId` is a live modulation destination. Drives the
     *  capture-arbitration guard in AppUI.applyValueToDevice. */
    public isModulated(controlId: string): boolean {
        return this.activeDestinationIds.has(controlId);
    }

    /** Marks a control as grabbed by a live user gesture (SurfaceUI knob
     *  drag). While set, the runner suspends the destination's writes AND its
     *  recording capture. */
    public setGestureTakeover(controlId: string, active: boolean): void {
        this.gestureTakeover.set(controlId, active);
    }

    public start(): void {
        if (this.rafId !== null) return;
        this.startTimeSec = performance.now() / 1000;
        this.lastWriteMs = 0;
        this.rafId = requestAnimationFrame(this.loop);
    }

    public stop(): void {
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        this.gestureTakeover.clear();
        this.activeDestinationIds.forEach((id) => this.surfaceUI.applyModDisplay(id, null));
        this.activeDestinationIds.clear();
        this.inFlight.clear();
    }

    private loop = (now: number): void => {
        this.tick(now);
        this.rafId = requestAnimationFrame(this.loop);
    };

    private tick(now: number): void {
        const device = this.getDevice();
        if (!device) return;
        const tSec = (now - this.startTimeSec) / 1000;

        const slots = device.modulation.slots;
        if (!slots.some((s) => s.enabled)) {
            // B38 — make sure the previously active mod displays go idle when
            // the last enabled slot is disabled mid-run; otherwise stale amber
            // arcs stay on the surface although the matrix is inactive.
            this.activeDestinationIds.forEach((id) => this.surfaceUI.applyModDisplay(id, null));
            this.activeDestinationIds.clear();
            return;
        }

        const baseValues: Record<string, number> = {};
        device.controls.forEach((control) => {
            if (!control.archived) baseValues[control.id] = control.value;
        });

        const macroValue = (controlId: string): number => {
            const control = device.getControl(controlId);
            return control ? control.value : 0;
        };
        const macroActive = (controlId: string): boolean => {
            const control = device.getControl(controlId);
            return !!control && !control.archived;
        };

        const destinations = evaluateDestinations(
            device.modulation,
            baseValues,
            tSec,
            this.getBpm(),
            macroValue,
            macroActive
        );

        for (const id of this.activeDestinationIds) {
            if (!destinations.has(id)) {
                this.surfaceUI.applyModDisplay(id, null);
                this.activeDestinationIds.delete(id);
            }
        }

        destinations.forEach((value, controlId) => {
            this.activeDestinationIds.add(controlId);
            this.surfaceUI.applyModDisplay(controlId, value);
            if (this.gestureTakeover.get(controlId)) {
                // Gesture-Takeover: capture base value (B11 — unchanged).
                if (this.recorder.currentState === "RECORDING") {
                    const control = device.getControl(controlId);
                    if (control && !control.archived) {
                        this.recorder.capture(controlId, baseValues[controlId] ?? value, control.type);
                    }
                }
                return;
            }
            if (!this.bindingManager.getActiveBinding(controlId)) return;
            const wrote = this.writeControl(controlId, value, baseValues[controlId] ?? 0);
            if (wrote && this.recorder.currentState === "RECORDING") {
                const control = device.getControl(controlId);
                if (control && !control.archived) {
                    this.recorder.capture(controlId, value, control.type);
                }
            }
        });
    }

    /** Writes a modulated value to Nexus (FIX 8 write-cap + in-flight guard +
     *  delta-epsilon jitter gate). The echo of this write is suppressed via
     *  beginSuppressEcho (FIX 1). */
    /** Returns true iff the value was ACTUALLY written to Nexus (i.e. passed
     *  the write-cap, the delta-epsilon gate Reports, the archive guard, the
     *  binding guard and the in-flight guard). Returns false when any of those
     *  gates blocked the write. FIX S2: recording may ONLY capture a value
     *  that was really applied — so tick() keys its recorder.capture() off this
     *  return value (captured == angewendet). */
    private writeControl(controlId: string, value: number, baseValue: number): boolean {
        if (this.inFlight.has(controlId)) return false;

        const device = this.getDevice();
        const control = device?.getControl(controlId);
        if (!control || control.archived) return false;
        if (!this.bindingManager.getActiveBinding(controlId)) return false;

        const now = performance.now();
        if (now - this.lastWriteMs < WRITE_INTERVAL_MS) return false;
        if (Math.abs(value - baseValue) < DELTA_EPSILON) return false;

        this.lastWriteMs = now;
        this.inFlight.add(controlId);
        this.nexusAdapter.beginSuppressEcho(controlId, value);
        this.nexusAdapter.updateBoundControl(controlId, value).finally(() => {
            this.inFlight.delete(controlId);
        });
        return true;
    }
}
