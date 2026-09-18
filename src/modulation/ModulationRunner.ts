import { evaluateDestinations } from "../core/modulation/ModulationEngine";
import type { AutomationRecorder } from "../automation/AutomationRecording";
import type { BindingManager } from "../core/BindingManager";
import type { Device } from "../core/model/Device";
import type { NexusAdapter } from "../nexus/NexusAdapter";

/** Minimum wall-clock distance between two Nexus writes of THE SAME control
 *  (FIX 8 + F2 — per-control write-cap). ≈30 writes/s max per destination.
 *  The old global sink starved every destination after the first one per tick;
 *  the cap is now scoped per control so modulated takes never thin out. */
const WRITE_INTERVAL_MS = 33;

/** F2 — hard ceiling of ACTUAL Nexus writes per rAF tick. Beyond this the
 *  remaining (changed) destinations are deferred to the next tick via
 *  round-robin, so a wide matrix never fires a write-transaction explosion
 *  in a single frame while every destination still gets served fairly. */
const MAX_WRITES_PER_TICK = 4;

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
 *  - FIX 8 + F2 (Write-Cap): writes of each control are capped at
 *    WRITE_INTERVAL_MS (per-control, not global) and guarded by an in-flight
 *    set so a slow Nexus write never piles up. A tick may apply at most
 *    MAX_WRITES_PER_TICK destinations; surplus ones roll over via round-robin
 *    so the whole matrix — not just the first destination — gets written.
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
    /** F2 — last Nexus write per control (per-control write-cap instead of the
     *  old global single slot that starved all but the first destination). */
    private readonly lastWriteMsByControl = new Map<string, number>();
    /** F2 — round-robin cursor: which destination the next tick starts writing
     *  at, so no destination is systematically starved at the tick frontier. */
    private lastProcessedDestinationIndex = 0;
    private readonly inFlight = new Set<string>();
    private readonly activeDestinationIds = new Set<string>();
    private readonly gestureTakeover = new Map<string, boolean>();
    /** B42 — last displayed modulated value per control, so redundant
     *  applyModDisplay DOM writes are skipped when the value did not change. */
    private readonly lastModValue = new Map<string, number>();

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
        this.lastWriteMsByControl.clear();
        this.lastProcessedDestinationIndex = 0;
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
        this.lastModValue.clear();
        this.inFlight.clear();
        // F2 — state zurücksetzen bei Stop: die per-control Write-Caps und der
        // Round-Robin-Cursor dürfen einen späteren Neustart nicht beeinflussen.
        this.lastWriteMsByControl.clear();
        this.lastProcessedDestinationIndex = 0;
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
            this.lastModValue.clear(); // B42 — no stale deltas across re-activation
            this.gestureTakeover.clear(); // B43 — stale takeovers never survive matrix deactivation
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
                this.lastModValue.delete(id); // B42 — cleanup
            }
        }

        const entries = [...destinations.entries()];

        // Phase 1 — display + gesture-takeover capture for EVERY destination
        // (unchanged: the needle reflects the modulated value each frame, and
        // takeover captures the base value the listener actually hears).
        const writable: Array<[string, number]> = [];
        for (const [controlId, value] of entries) {
            const last = this.lastModValue.get(controlId);
            // B2 — Deduplizierung betrifft NUR DOM und activeDestinationIds:
            // bei konstantem Mod-Wert wird der Write weiterhin angeboten, auch
            // wenn er im frühesten Frame vom Cap/inFlight blockiert wurde.
            // Ein solcher Wert wird dauerhaft verschluckt, wenn die Schleife
            // writable.push ebenfalls überspringt (vgl. B2).
            if (last !== value) {
                this.lastModValue.set(controlId, value);
                this.activeDestinationIds.add(controlId);
                this.surfaceUI.applyModDisplay(controlId, value);
            }
            if (this.gestureTakeover.get(controlId)) {
                // Gesture-Takeover: capture base value (B11 — unchanged).
                if (this.recorder.currentState === "RECORDING") {
                    const control = device.getControl(controlId);
                    if (control && !control.archived) {
                        this.recorder.capture(controlId, baseValues[controlId] ?? value, control.type);
                    }
                }
                continue;
            }
            if (!this.bindingManager.getActiveBinding(controlId)) continue;
            writable.push([controlId, value]);
        }

        // Phase 2 — F2 round-robin writes, capped by MAX_WRITES_PER_TICK.
        // Started at the last tick's cursor so every destination is served
        // fairly; recorder capture is keyed to ACTUAL writes only (FIX S2).
        const total = writable.length;
        if (total === 0) return;
        let writesThisTick = 0;
        let idx = this.lastProcessedDestinationIndex % total;
        let processed = 0;
        while (processed < total && writesThisTick < MAX_WRITES_PER_TICK) {
            const [controlId, value] = writable[idx];
            processed++;
            const wrote = this.writeControl(controlId, value, baseValues[controlId] ?? 0);
            if (wrote) {
                writesThisTick++;
                if (this.recorder.currentState === "RECORDING") {
                    const control = device.getControl(controlId);
                    if (control && !control.archived) {
                        this.recorder.capture(controlId, value, control.type);
                    }
                }
            }
            idx = (idx + 1) % total;
        }
        this.lastProcessedDestinationIndex = idx;
    }

    /** Writes a modulated value to Nexus (F2 per-control write-cap +
     *  in-flight guard + delta-epsilon jitter gate). The echo of this write is
     *  suppressed via beginSuppressEcho (FIX 1). */
    /** Returns true iff the value was ACTUALLY written to Nexus (i.e. passed
     *  the per-control write-cap, the delta-epsilon gate Reports, the archive
     *  guard, the binding guard and the in-flight guard). Returns false when
     *  any of those gates blocked the write. FIX S2: recording may ONLY capture
     *  a value that was really applied — so tick() keys its recorder.capture()
     *  off this return value (captured == angewendet). */
    private writeControl(controlId: string, value: number, baseValue: number): boolean {
        if (this.inFlight.has(controlId)) return false;

        const device = this.getDevice();
        const control = device?.getControl(controlId);
        if (!control || control.archived) return false;
        if (!this.bindingManager.getActiveBinding(controlId)) return false;

        const now = performance.now();
        const lastWrite = this.lastWriteMsByControl.get(controlId) ?? 0;
        if (now - lastWrite < WRITE_INTERVAL_MS) return false;
        if (Math.abs(value - baseValue) < DELTA_EPSILON) return false;

        this.lastWriteMsByControl.set(controlId, now);
        this.inFlight.add(controlId);
        this.nexusAdapter.beginSuppressEcho(controlId, value);
        this.nexusAdapter.updateBoundControl(controlId, value).finally(() => {
            this.inFlight.delete(controlId);
        });
        return true;
    }
}
