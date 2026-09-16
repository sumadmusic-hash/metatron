import { describe, it, expect } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { Preset } from "../../src/core/model/Preset";
import { applyMorphToDevice } from "../../src/integration/PresetMorphIntegration";
import { AutomationRecorder } from "../../src/automation/AutomationRecording";

/**
 * Morph recording semantics:
 *   applyMorphToDevice applies interpolated values locally; every control whose
 *   value ACTUALLY changed is reported through `onControlChanged`, which the
 *   caller feeds into the existing AutomationRecorder.
 *
 * Constrained to the recorder contract only — no AppUI DOM required.
 */

function preset(name: string, deviceId: string, values: Record<string, number>): Preset {
    const p = new Preset(name, deviceId);
    p.controlValues = { ...values };
    return p;
}

function makeDevice() {
    const d = new Device("Morph Host");
    const cutoff = new Control("knob", "Cutoff", { x: 0, y: 0 }, "cutoff");
    const res = new Control("knob", "Resonance", { x: 0, y: 0 }, "res");
    const constant = new Control("knob", "Constant", { x: 0, y: 0 }, "constant");
    const dead = new Control("switch", "Dead", { x: 0, y: 0 }, "dead");
    cutoff.value = 0.3;
    res.value = 0.7;
    constant.value = 0.5;
    dead.value = 0.2;
    dead.archived = true;
    d.addControl(cutoff);
    d.addControl(res);
    d.addControl(constant);
    d.addControl(dead);
    return { d, cutoff, res, constant, dead };
}

function presetsFor(device: Device, pa: Record<string, number>, pb: Record<string, number>) {
    return { pa: preset("A", device.id, pa), pb: preset("B", device.id, pb) };
}

/** Apply a morph whose reported changes are routed into `recorder.capture`,
 *  mirroring the AppUI wiring used at runtime. */
function morphIntoRecorder(
    device: Device,
    pa: Pick<Preset, "controlValues">,
    pb: Pick<Preset, "controlValues">,
    amount: number,
    recorder: AutomationRecorder,
) {
    applyMorphToDevice(device, pa, pb, amount, undefined, (control, value) => {
        recorder.capture(control.id, value, control.type);
    });
}

describe("Morph → AutomationRecorder (capture hook)", () => {
    it("1. changed controls are captured as NORMAL automation tracks during RECORDING", () => {
        const { d } = makeDevice();
        const { pa, pb } = presetsFor(d, { cutoff: 0.2, res: 0.9 }, { cutoff: 0.8, res: 0.1 });

        let clockMs = 0;
        const recorder = new AutomationRecorder(() => 120, () => clockMs);
        recorder.arm();
        recorder.record(0);
        morphIntoRecorder(d, pa, pb, 0.5, recorder);
        recorder.stop();

        const tracks = recorder.recording.tracks;
        expect(tracks.map((t) => t.controlId).sort()).toEqual(["cutoff", "res"]);

        const cutoffTrack = tracks.find((t) => t.controlId === "cutoff")!;
        const resTrack = tracks.find((t) => t.controlId === "res")!;
        expect(cutoffTrack.controlType).toBe("knob");
        expect(cutoffTrack.samples[0].normalizedValue).toBeCloseTo(0.5, 10);
        expect(resTrack.controlType).toBe("knob");
        expect(resTrack.samples[0].normalizedValue).toBeCloseTo(0.5, 10);
    });

    it("2. morph WITHOUT recording produces no samples and no tracks", () => {
        const { d } = makeDevice();
        const { pa, pb } = presetsFor(d, { cutoff: 0.2, res: 0.9 }, { cutoff: 0.8, res: 0.1 });

        const recorder = new AutomationRecorder(() => 120, () => 0);
        morphIntoRecorder(d, pa, pb, 0.5, recorder);

        expect(recorder.recording.tracks.length).toBe(0);
    });

    it("3. a control whose value does NOT change is never reported — no sample", () => {
        const { d, constant } = makeDevice();
        // A and B agree with the control's CURRENT value → morph leaves it untouched.
        const { pa, pb } = presetsFor(d, { constant: 0.5 }, { constant: 0.5 });

        const reported: string[] = [];
        applyMorphToDevice(d, pa, pb, 0.5, undefined, (control) => {
            reported.push(control.id);
        });

        expect(reported).toEqual([]);
        expect(constant.value).toBe(0.5);
    });

    it("4. archived controls keep the previous skip behavior — never reported", () => {
        const { d, dead } = makeDevice();
        const { pa, pb } = presetsFor(d, { dead: 0.2, cutoff: 0.2 }, { dead: 0.8, cutoff: 0.8 });

        const reported: string[] = [];
        applyMorphToDevice(d, pa, pb, 0.5, undefined, (control) => {
            reported.push(control.id);
        });

        expect(reported).toEqual(["cutoff"]);
        expect(dead.value).toBe(0.2);
    });
});