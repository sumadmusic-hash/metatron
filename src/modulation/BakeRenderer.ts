import { Ticks } from "@audiotool/nexus/utils";
import type {
    AutomationRecording,
    AutomationRecordingTrack,
} from "../automation/AutomationRecording";
import type { Device } from "../core/model/Device";
import type { ModulationMatrixConfig } from "../core/modulation/ModulationTypes";
import { evaluateDestinations } from "../core/modulation/ModulationEngine";

export interface BakeOptions {
    bars: number;
    /** Project BPM used for the ticks → seconds conversion (M21.2 §7). */
    projectBpm: number;
    /** Timeline position (ticks) the written recording starts at. */
    startTick: number;
    /** Note grid the matrix is sampled on. */
    grid: "1/16" | "1/32";
}

/**
 * Bake the (edited) modulation matrix into a static automation recording.
 *
 * The matrix is sampled deterministically on the given note grid across the
 * requested number of bars: every step calls `evaluateDestinations` exactly
 * once, and every produced destination level is stored as a normalized
 * sample (`timeSeconds` relative to the recording start). Archived controls
 * are skipped entirely — they never appear in `baseValues` nor in the track
 * map. No Nexus reads, no playhead, no live values: this is a pure,
 * offline render (M21.2 bake path).
 */
export function renderMatrixToRecording(
    matrix: ModulationMatrixConfig,
    device: Device,
    options: BakeOptions
): AutomationRecording {
    const rawBars = options.bars > 0 ? options.bars : 1;
    const barTicks = Ticks.SemiBreve;
    const totalTicks = rawBars * barTicks;
    const stepTicks = options.grid === "1/16" ? barTicks / 16 : barTicks / 32;
    const steps = Math.ceil(totalTicks / stepTicks);
    const secondsPerWholeNote = 240 / options.projectBpm;
    const durationSeconds = (totalTicks / Ticks.SemiBreve) * secondsPerWholeNote;

    const baseValues: Record<string, number> = {};
    for (const [controlId, control] of device.controls) {
        if (control.archived) continue;
        baseValues[controlId] = control.value;
    }

    const macroValue = (controlId: string) => {
        const control = device.getControl(controlId);
        return control ? control.value : 0;
    };
    const macroActive = (controlId: string) => {
        const control = device.getControl(controlId);
        return !!control && !control.archived;
    };

    const trackMap = new Map<string, AutomationRecordingTrack>();
    for (let step = 0; step < steps; step++) {
        const timeSeconds = ((step * stepTicks) / Ticks.SemiBreve) * secondsPerWholeNote;
        const levels = evaluateDestinations(matrix, baseValues, timeSeconds, options.projectBpm, macroValue, macroActive);
        levels.forEach((normalizedValue, controlId) => {
            let track = trackMap.get(controlId);
            if (!track) {
                track = {
                    controlId,
                    controlType: device.getControl(controlId)?.type,
                    samples: [],
                };
                trackMap.set(controlId, track);
            }
            track.samples.push({ timeSeconds, normalizedValue });
        });
    }

    return {
        projectBpm: options.projectBpm,
        startTick: options.startTick,
        durationSeconds,
        tracks: [...trackMap.values()],
    };
}