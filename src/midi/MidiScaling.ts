import type { MidiBindingDefinition } from "../core/model/types";

/**
 * METATRON MIDI SCALING (C2, §6) — the single normalization engine for hard‑
 * ware CC values into the control's 0..1 value range.
 *
 * This is the ONLY place that turns a raw MIDI CC value into a normalized
 * control value. It is a pure function: no state, no side effects, no I/O.
 * `raw` is never assumed to be in range; every input is reduced to a
 * deterministic 0..1 output.
 */

/** A fully sanitized scaling definition — every field is a concrete value. */
export interface SanitizedMidiScaling {
    min: number;
    max: number;
    flip: boolean;
    exponent: number;
}

/**
 * Normalize a (possibly partial / malformed) MidiBindingDefinition into its
 * concrete scaling parameters. Rules (§6):
 *  - `min`/`max` are clamped to 0..1; non-finite values fall back to the
 *    defaults (0 / 1).
 *  - if `min > max` after sanitizing, both fall back to the defaults 0..1.
 *  - `min === max` is kept (constant output) — not a fallback case.
 *  - `flip` defaults to `false`.
 *  - `exponent` defaults to 1; `exponent <= 0`, NaN or ±Infinity → 1.
 * A definition with no scaling fields sanitizes to the identity defaults,
 * which makes `applyMidiScaling` reproduce the legacy `clamp(raw/127, 0, 1)`.
 */
export function sanitizeMidiScaling(definition?: MidiBindingDefinition): SanitizedMidiScaling {
    const minSource = definition?.min;
    const maxSource = definition?.max;

    let min = 0;
    if (isFiniteNumber(minSource)) {
        min = clamp(minSource, 0, 1);
    }
    let max = 1;
    if (isFiniteNumber(maxSource)) {
        max = clamp(maxSource, 0, 1);
    }
    if (min > max) {
        min = 0;
        max = 1;
    }

    const exponentSource = definition?.exponent;
    const exponent =
        isFiniteNumber(exponentSource) && exponentSource > 0 ? exponentSource : 1;

    const flip = definition?.flip === true;

    return { min, max, flip, exponent };
}

/**
 * Scale a raw MIDI CC value (0..127) into the control's normalized 0..1 range.
 *
 * Applied in exactly this order (§6):
 *   1. `t = raw / 127`            (raw clamped to 0..127 first)
 *   2. `t = flip ? 1 - t : t`     (mirror BEFORE the curve)
 *   3. `v = t^exponent`           (power curve; exponent > 0)
 *   4. `out = min + (max - min)*v`
 *   5. `clamp(out, 0, 1)`
 *
 * The output is always within 0..1. Non-finite `raw` yields 0.
 */
export function applyMidiScaling(raw: number, definition?: MidiBindingDefinition): number {
    const rawClamped = Number.isFinite(raw) ? clamp(raw, 0, 127) : 0;

    const t = rawClamped / 127;
    const { min, max, flip, exponent } = sanitizeMidiScaling(definition);

    const mirrored = flip ? 1 - t : t;
    const curved = Math.pow(mirrored, exponent);
    const scaled = min + (max - min) * curved;

    return clamp(scaled, 0, 1);
}

function clamp(value: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, value));
}

/** Type guard: a finite number (rejects undefined, NaN, ±Infinity). */
function isFiniteNumber(value: number | undefined): value is number {
    return typeof value === "number" && Number.isFinite(value);
}