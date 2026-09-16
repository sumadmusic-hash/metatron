import type { ModulationMatrixConfig } from "./ModulationTypes";
import type { ModSource, Waveform } from "./ModulationTypes";

/**
 * METATRON MODULATION — pure, deterministic evaluation engine (Phase 1).
 *
 * The engine is a pure function of its arguments: no DOM, no AudioContext, no
 * Clock, no Date, no global state. The same matrix + the same time base always
 * produce the same result, so the modulation layer is unit-testable and
 * reproducible. The UI/runner builds the inputs and renders the output Map —
 * the engine never touches the host.
 */

function clamp(v: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, v));
}

/** Clamp into the control level range [0, 1]. */
function clamp01(v: number): number {
    return clamp(v, 0, 1);
}

/** Deterministic FNV-1a hash folded into [0, 1) for the given string seed. */
export function hash01(seed: string): number {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967296;
}

/** BPM clamped into a deterministic playback range (guard against corrupted
 *  transport values). */
export function safeBpm(bpm: number): number {
    return clamp(bpm, 30, 1000);
}

/** LFO period in seconds. Tempo-synced sources derive their period from the
 *  source's declared BPM reference (falling back to the transport BPM) and the
 *  musical note division; free sources use `1 / rateHz`. */
function lfoPeriodSec(src: ModSource, transportBpm: number): number {
    return src.bpmSync
        ? (60 / safeBpm(src.bpmOfSync ?? transportBpm)) * (4 / Math.max(1, src.noteDivision ?? 1))
        : 1 / clamp(src.rateHz ?? 1, 0.01, 20);
}

/** Waveform sample for the normalised phase in [0, 1), returning a bipolar
 *  value in [-1, 1]. */
function wave(phase: number, waveform: Waveform): number {
    if (waveform === "triangle") return 4 * Math.abs(phase - 0.5) - 1;
    if (waveform === "saw") return phase * 2 - 1;
    if (waveform === "square") return phase < 0.5 ? 1 : -1;
    return Math.sin(phase * Math.PI * 2);
}

/** Evaluate a single source into a bipolar value in [-1, 1].
 *
 *  FIX 7: a "macro" source whose bound control is archived/deleted is dormant
 *  — missing `sourceId` or `macroActive` returning false yields 0, even when a
 *  stale `macroValue` would otherwise steer it. */
export function evaluateSource(
    src: ModSource,
    tSec: number,
    bpm: number,
    macroValue: (controlId: string) => number,
    macroActive: (id: string) => boolean,
): number {
    if (src.type === "macro") {
        if (!src.sourceId || !macroActive(src.sourceId)) return 0;
        return clamp(macroValue(src.sourceId) * 2 - 1, -1, 1);
    }

    if (src.type === "random") {
        const stepSec = Math.max(0.001, (src.smoothMs ?? 200) / 1000);
        const timeKey = `${Math.floor(tSec / stepSec)}`;
        const sequence = hash01(`${src.sourceId}:${timeKey}`) * 2 - 1;
        return clamp(sequence * clamp(src.drift ?? 0.5, 0, 1), -1, 1);
    }

    const period = lfoPeriodSec(src, bpm);

    if (src.waveform === "sampleHold") {
        const idx = Math.floor(tSec / period);
        return hash01(`${src.sourceId}:${idx}`) * 2 - 1;
    }

    if (src.waveform === "smoothRandom") {
        const idx = Math.floor(tSec / period);
        const frac = tSec / period - idx;
        const a = hash01(`${src.sourceId}:${idx}`) * 2 - 1;
        const b = hash01(`${src.sourceId}:${idx + 1}`) * 2 - 1;
        return a + (b - a) * frac;
    }

    const phase = ((src.phase ?? 0) % 1 + tSec / period) % 1;
    return clamp(wave(phase, src.waveform ?? "sine"), -1, 1);
}

/** Evaluate the matrix against the given control base values. Returns a map
 *  of destination control id → clamped level in [0, 1].
 *
 *  Skip rules (deterministic): disabled slots, slots with a dangling sourceId,
 *  and slots whose destControlId is not present in `baseValues` are ignored —
 *  their destination simply never appears in the result map. Multiple enabled
 *  slots targeting the same control add their deltas FIRST, then the total is
 *  clamped onto the base once (sum-then-clamp). */
export function evaluateDestinations(
    matrix: ModulationMatrixConfig,
    baseValues: Record<string, number>,
    tSec: number,
    bpm: number,
    macroValue: (controlId: string) => number,
    macroActive: (id: string) => boolean,
): Map<string, number> {
    const sourceOut = new Map<string, number>();
    for (const src of matrix.sources) {
        sourceOut.set(src.id, evaluateSource(src, tSec, bpm, macroValue, macroActive));
    }

    const sums = new Map<string, number>();
    for (const slot of matrix.slots) {
        if (!slot.enabled || !slot.sourceId || !slot.destControlId) continue;
        const out = sourceOut.get(slot.sourceId);
        if (out === undefined) continue;
        sums.set(slot.destControlId, (sums.get(slot.destControlId) ?? 0) + out * slot.amount);
    }

    const result = new Map<string, number>();
    sums.forEach((delta, controlId) => {
        if (!baseValues || !(controlId in baseValues)) return;
        result.set(controlId, clamp01((baseValues[controlId] ?? 0) + delta));
    });
    return result;
}