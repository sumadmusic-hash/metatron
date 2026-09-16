import { describe, it, expect } from "vitest";
import { Ticks } from "@audiotool/nexus/utils";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { createDefaultMatrix } from "../../src/core/modulation/ModulationTypes";
import { renderMatrixToRecording } from "../../src/modulation/BakeRenderer";

/**
 * Phase 3 — BakeRenderer: the matrix is rasterized deterministically on the
 * given note grid (no playhead, no live values). Verified against the IST
 * shapes: flat ModSource top-level fields, `evaluateDestinations` return map,
 * Device.controls Map, and the @audiotool/nexus `Ticks` API.
 */

function makeDevice(): Device {
    const device = new Device("Bake");
    const ctl1 = new Control("knob", "Cutoff", { x: 0, y: 0 }, "ctl1");
    device.addControl(ctl1);
    ctl1.value = 0.5;

    const src = device.modulation.sources[0];
    src.waveform = "sine";
    src.rateHz = 2;

    const slot = device.modulation.slots[0];
    slot.enabled = true;
    slot.sourceId = src.id;
    slot.destControlId = ctl1.id;
    slot.amount = 0.5;

    return device;
}

function defaultOptions() {
    return { bars: 4, startTick: 0, projectBpm: 120, grid: "1/16" as const };
}

describe("renderMatrixToRecording", () => {
    it("renders 4 bars of 1/16 grid into one track with the expected sample count", () => {
        const device = makeDevice();
        const recording = renderMatrixToRecording(device.modulation, device, defaultOptions());

        expect(recording.projectBpm).toBe(120);
        expect(recording.startTick).toBe(0);
        expect(recording.tracks).toHaveLength(1);
        expect(recording.tracks[0].controlId).toBe(device.getControl("ctl1")?.id ?? "");

        const expectedSteps = 4 * 16;
        expect(recording.tracks[0].samples.length).toBeCloseTo(expectedSteps, 0);

        expect(recording.tracks[0].samples[0].timeSeconds).toBe(0);
        for (const sample of recording.tracks[0].samples) {
            expect(sample.normalizedValue).toBeGreaterThanOrEqual(0);
            expect(sample.normalizedValue).toBeLessThanOrEqual(1);
        }
    });

    it("skips archived controls entirely", () => {
        const device = makeDevice();
        device.getControl("ctl1")?.softDelete();

        const recording = renderMatrixToRecording(device.modulation, device, defaultOptions());

        expect(recording.tracks).toHaveLength(0);
    });

    it("computes an 8s duration for 4 bars at 120 BPM", () => {
        const device = makeDevice();
        const recording = renderMatrixToRecording(device.modulation, device, defaultOptions());

        expect(recording.durationSeconds).toBeCloseTo(8, 1);
    });

    it("uses the supplied projectBpm for duration (125 BPM → 7.68s for 4 bars)", () => {
        const device = new Device("Test");
        const matrix = createDefaultMatrix();
        const recording = renderMatrixToRecording(
            matrix,
            device,
            { bars: 4, startTick: 0, projectBpm: 125, grid: "1/16" }
        );
        // 4 bars at 125 BPM = 4 * (240/125) seconds = 7.68s
        expect(recording.durationSeconds).toBeCloseTo(7.68, 2);
    });

    /** Macro source bound to an (unarchived) control: the control VALUE must
     *  steer the macro. Regresses the inverted `control.archived` check that
     *  once made active macros silent. */
    function macroDevice(ctrlValue: number, archived: boolean): Device {
        const device = new Device("Macro");
        const ctl = new Control("knob", "ModSource", { x: 0, y: 0 }, "mctl");
        device.addControl(ctl);
        ctl.value = ctrlValue;
        if (archived) ctl.softDelete();

        const dest = new Control("knob", "ModDest", { x: 0, y: 0 }, "mdest");
        device.addControl(dest);

        const macro = device.modulation.sources[1];
        macro.type = "macro";
        macro.sourceId = ctl.id;

        const slot = device.modulation.slots[0];
        slot.enabled = true;
        slot.sourceId = macro.id;
        slot.destControlId = dest.id;
        slot.amount = 0.5;

        return device;
    }

    it("macro source driven by an active control delivers the control value", () => {
        const device = macroDevice(1, false);
        const recording = renderMatrixToRecording(device.modulation, device, defaultOptions());

        expect(recording.tracks).toHaveLength(1);
        expect(recording.tracks[0].controlId).toBe(device.getControl("mdest")?.id ?? "");
        for (const sample of recording.tracks[0].samples) {
            // macro value 1 → source = 2*1−1 = 1 → dest = base 0 + 0.5 * 1 = 0.5
            expect(sample.normalizedValue).toBeCloseTo(0.5, 5);
        }
    });

    it("macro source bound to an archived control is dormant and yields 0", () => {
        const device = macroDevice(1, true);
        const recording = renderMatrixToRecording(device.modulation, device, defaultOptions());

        expect(recording.tracks).toHaveLength(1);
        for (const sample of recording.tracks[0].samples) {
            expect(sample.normalizedValue).toBeCloseTo(0, 5);
        }
    });
});