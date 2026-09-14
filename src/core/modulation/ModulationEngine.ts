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

/** Apply one bipolar destination value scaled by the slot amount onto the
 *  current control base, clamped into the control range [0, 1]. */
function nextLevel(destination: number, amount: number, base: number): number {
    const deltaValue = clamp(destination, -1, 1) * clamp(amount, -1, 1);
    return clamp(base + deltaValue, 0, 1);
}

/** Evaluate a single source into a bipolar value in [-1, 1].
 *
 *  FIX 7: a "macro" source whose bound control is archived/deleted is dormant
 *  — `macroActive` returns false and the source yields 0, even when a stale
 *  `macroValue` would otherwise steer it. */
export function evaluateSource(
    src: ModSource,
    tSec: number,
    bpm: number,
    macroValue: number,
    macroActive: (id: string) => boolean,
): number {
    const normalPhase = (src.phase ?? 0) % 1;

    if (src.type === "macro") {
        const active = macroActive(src.sourceId);
        const value = macroValue * 2 - 1;
        return active ? clamp(value, -1, 1) : 0;
    }

    if (src.type === "random") {
        const timeKey = `${Math.floor(tSec / Math.max(src.sampleRate ?? 0.1, 0.001))}`;
        const sequence = hash01(`${src.sourceId}:${timeKey}`) * 2 - 1;
        return clamp(sequence * (src.drift ?? 0), -1, 1);
    }

    const period = lfoPeriodSec(src, bpm);
    const phase = (normalPhase + tSec / period) % 1;

    if (src.type === "sampleHold" || src.type === "smoothRandom") {
        const timeKey = `${Math.floor(tSec / period)}`;
        const r = hash01(`${src.sourceId}:${timeKey}`);
        if (src.type === "sampleHold") {
            return clamp(r * 2 - 1, -1, 1);
        }
        return clamp((r * 2 - 1) * (src.drift ?? 0), -1, 1);
    }

    return clamp(wave(phase, src.waveform ?? "sine"), -1, 1);
}

/** Evaluate every enabled slot of the matrix on top of the given control base
 *  values. Returns a map of destination control id → clamped level in [0, 1].
 *
 *  Skip rules (deterministic): disabled slots, slots with a dangling sourceId,
 *  and slots whose destControlId is not present in `baseValues` are ignored —
 *  their destination simply never appears in the result map. Multiple enabled
 *  slots targeting the same control accumulate (each applied on the result of
 *  the previous one, always clamped). */
export function evaluateDestinations(
    matrix: ModulationMatrixConfig,
    baseValues: Record<string, number>,
    tSec: number,
    bpm: number,
    macroValue: number,
    macroActive: (id: string) => boolean,
): Map<string, number> {
    const result = new Map<string, number>();
    for (const slot of matrix.slots) {
        if (!slot.enabled) continue;
        const src = matrix.sources.find((s) => s.id === slot.sourceId);
        if (!src) continue;
        if (!baseValues || !(slot.destControlId in baseValues)) continue;
        const value = evaluateSource(src, tSec, bpm, macroValue, macroActive);
        const base = baseValues[slot.destControlId] ?? 0;
        const prev = result.get(slot.destControlId);
        result.set(
            slot.destControlId,
            prev === undefined ? nextLevel(value, slot.amount, base) : nextLevel(value, slot.amount, prev),
        );
    }
    return result;
}