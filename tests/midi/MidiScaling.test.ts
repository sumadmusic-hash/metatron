import { describe, it, expect } from "vitest";
import { applyMidiScaling, sanitizeMidiScaling } from "../../src/midi/MidiScaling";
import type { MidiBindingDefinition } from "../../src/core/model/types";

const IDENTITY = 64 / 127;

describe("applyMidiScaling — exact C2 §6 semantics", () => {
    it("legacy definition without scaling fields = identity (clamp(raw/127, 0, 1))", () => {
        expect(applyMidiScaling(64, { channel: 1, cc: 20 })).toBeCloseTo(IDENTITY, 10);
        expect(applyMidiScaling(64, {})).toBeCloseTo(IDENTITY, 10);
        expect(applyMidiScaling(64)).toBeCloseTo(IDENTITY, 10);
        expect(applyMidiScaling(64, undefined)).toBeCloseTo(IDENTITY, 10);
    });

    it("raw 0 → 0", () => {
        expect(applyMidiScaling(0)).toBe(0);
    });

    it("raw 127 → 1", () => {
        expect(applyMidiScaling(127)).toBe(1);
    });

    it("min/max bound the output range", () => {
        const def: MidiBindingDefinition = { min: 0.25, max: 0.75 };
        expect(applyMidiScaling(0, def)).toBe(0.25);
        expect(applyMidiScaling(127, def)).toBe(0.75);
        expect(applyMidiScaling(64, def)).toBeCloseTo(0.25 + 0.5 * IDENTITY, 10);
    });

    it("flip mirrors the raw position before the curve", () => {
        const def: MidiBindingDefinition = { flip: true };
        expect(applyMidiScaling(0, def)).toBe(1);
        expect(applyMidiScaling(127, def)).toBe(0);
        expect(applyMidiScaling(64, def)).toBeCloseTo(1 - IDENTITY, 10);
    });

    it("exponent 0.5 applies a square-root curve", () => {
        const def: MidiBindingDefinition = { exponent: 0.5 };
        expect(applyMidiScaling(64, def)).toBeCloseTo(Math.sqrt(IDENTITY), 5);
    });

    it("exponent 2 applies a squared curve", () => {
        const def: MidiBindingDefinition = { exponent: 2 };
        expect(applyMidiScaling(64, def)).toBeCloseTo(IDENTITY * IDENTITY, 5);
    });

    it("full chain order is flip (before curve) → exponent → min/max", () => {
        const def: MidiBindingDefinition = { min: 0.2, max: 0.8, flip: true, exponent: 2 };
        expect(applyMidiScaling(0, def)).toBeCloseTo(0.8, 10);
        expect(applyMidiScaling(127, def)).toBeCloseTo(0.2, 10);
        expect(applyMidiScaling(64, def)).toBeCloseTo(0.2 + 0.6 * Math.pow(63 / 127, 2), 10);
    });

    it("min === max yields a constant output (valid, not a fallback)", () => {
        const def: MidiBindingDefinition = { min: 0.4, max: 0.4 };
        expect(applyMidiScaling(0, def)).toBe(0.4);
        expect(applyMidiScaling(64, def)).toBe(0.4);
        expect(applyMidiScaling(127, def)).toBe(0.4);
    });

    it("min > max falls back to the default 0..1 range", () => {
        const def: MidiBindingDefinition = { min: 0.8, max: 0.2 };
        expect(applyMidiScaling(0, def)).toBe(0);
        expect(applyMidiScaling(64, def)).toBeCloseTo(IDENTITY, 10);
        expect(applyMidiScaling(127, def)).toBe(1);
    });

    it("min/max outside 0..1 are clamped; cross-over collapses to defaults", () => {
        const clamped: MidiBindingDefinition = { min: -0.5, max: 1.5 };
        expect(applyMidiScaling(64, clamped)).toBeCloseTo(IDENTITY, 10);

        const oneSided: MidiBindingDefinition = { min: -2, max: 0.5 };
        expect(applyMidiScaling(0, oneSided)).toBe(0);
        expect(applyMidiScaling(127, oneSided)).toBe(0.5);

        const crossed: MidiBindingDefinition = { min: 2, max: -1 };
        expect(applyMidiScaling(64, crossed)).toBeCloseTo(IDENTITY, 10);
    });

    it("exponent 0 falls back to 1", () => {
        expect(applyMidiScaling(64, { exponent: 0 })).toBeCloseTo(IDENTITY, 10);
    });

    it("negative exponent falls back to 1", () => {
        expect(applyMidiScaling(64, { exponent: -2 })).toBeCloseTo(IDENTITY, 10);
    });

    it("NaN exponent falls back to 1", () => {
        expect(applyMidiScaling(64, { exponent: NaN })).toBeCloseTo(IDENTITY, 10);
    });

    it("Infinity exponent falls back to 1", () => {
        expect(applyMidiScaling(64, { exponent: Infinity })).toBeCloseTo(IDENTITY, 10);
    });

    it("-Infinity exponent falls back to 1", () => {
        expect(applyMidiScaling(64, { exponent: -Infinity })).toBeCloseTo(IDENTITY, 10);
    });

    it("raw values outside 0..127 are clamped", () => {
        expect(applyMidiScaling(-10)).toBe(0);
        expect(applyMidiScaling(200)).toBe(1);
    });

    it("raw ±Infinity maps to raw 0 (legacy → 0; min/max → min bound)", () => {
        expect(applyMidiScaling(Infinity)).toBe(0);
        expect(applyMidiScaling(-Infinity)).toBe(0);
        expect(applyMidiScaling(Infinity, { min: 0.25, max: 0.75 })).toBe(0.25);
        expect(applyMidiScaling(-Infinity, { min: 0.25, max: 0.75 })).toBe(0.25);
        // flip mirrors the zeroed raw BEFORE the curve → upper bound
        expect(applyMidiScaling(Infinity, { min: 0.25, max: 0.75, flip: true })).toBe(0.75);
    });

    it("infinite min/max collapse to the legacy identity at apply time", () => {
        expect(applyMidiScaling(64, { min: Infinity })).toBeCloseTo(IDENTITY, 10);
        expect(applyMidiScaling(64, { max: -Infinity })).toBeCloseTo(IDENTITY, 10);
        expect(applyMidiScaling(64, { min: Infinity, max: -Infinity })).toBeCloseTo(IDENTITY, 10);
    });

    it("the result is always a finite number within 0..1", () => {
        const raws = [-50, -1, 0, 1, 42, 64, 127, 128, 200, NaN, Infinity, -Infinity];
        const defs: (MidiBindingDefinition | undefined)[] = [
            undefined,
            { flip: true },
            { exponent: 0.5 },
            { exponent: 2 },
            { min: 0.25, max: 0.75 },
            { min: 0.8, max: 0.2 },
            { min: -0.5, max: 1.5 },
            { min: 0.3, max: 0.3 },
        ];
        for (const def of defs) {
            for (const raw of raws) {
                const result = applyMidiScaling(raw, def);
                expect(Number.isFinite(result)).toBe(true);
                expect(result >= 0 && result <= 1).toBe(true);
            }
        }
    });

    it("repeated calls with the same input are deterministic", () => {
        const def: MidiBindingDefinition = { min: 0.1, max: 0.9, flip: true, exponent: 1.7 };
        const a = applyMidiScaling(96, def);
        const b = applyMidiScaling(96, def);
        expect(a).toBe(b);
        expect(a).toBeCloseTo(0.1 + 0.8 * Math.pow(1 - 96 / 127, 1.7), 10);
    });
});

describe("sanitizeMidiScaling — concrete, deterministic parameters", () => {
    it("undefined / empty definitions sanitize to the identity defaults", () => {
        expect(sanitizeMidiScaling(undefined)).toEqual({ min: 0, max: 1, flip: false, exponent: 1 });
        expect(sanitizeMidiScaling({})).toEqual({ min: 0, max: 1, flip: false, exponent: 1 });
    });

    it("min > max collapses to the default 0..1 range", () => {
        expect(sanitizeMidiScaling({ min: 0.9, max: 0.1 })).toEqual({ min: 0, max: 1, flip: false, exponent: 1 });
    });

    it("min === max is preserved (constant output case)", () => {
        const s = sanitizeMidiScaling({ min: 0.5, max: 0.5 });
        expect(s.min).toBe(0.5);
        expect(s.max).toBe(0.5);
    });

    it("non-finite min/max fall back to the defaults", () => {
        const s = sanitizeMidiScaling({ min: NaN, max: NaN });
        expect(s.min).toBe(0);
        expect(s.max).toBe(1);
    });

    it("±Infinity min falls back to the default 0", () => {
        expect(sanitizeMidiScaling({ min: Infinity })).toEqual({ min: 0, max: 1, flip: false, exponent: 1 });
        expect(sanitizeMidiScaling({ min: -Infinity })).toEqual({ min: 0, max: 1, flip: false, exponent: 1 });
    });

    it("±Infinity max falls back to the default 1", () => {
        expect(sanitizeMidiScaling({ max: Infinity })).toEqual({ min: 0, max: 1, flip: false, exponent: 1 });
        expect(sanitizeMidiScaling({ max: -Infinity })).toEqual({ min: 0, max: 1, flip: false, exponent: 1 });
    });

    it("both bounds infinite (either direction) collapse to the default 0..1 range", () => {
        expect(sanitizeMidiScaling({ min: Infinity, max: -Infinity })).toEqual({ min: 0, max: 1, flip: false, exponent: 1 });
        expect(sanitizeMidiScaling({ min: -Infinity, max: Infinity })).toEqual({ min: 0, max: 1, flip: false, exponent: 1 });
    });

    it("non-positive / non-finite exponents fall back to 1", () => {
        for (const exponent of [0, -3, NaN, Infinity, -Infinity]) {
            expect(sanitizeMidiScaling({ exponent }).exponent).toBe(1);
        }
    });

    it("flip defaults to false and is kept when true", () => {
        expect(sanitizeMidiScaling({}).flip).toBe(false);
        expect(sanitizeMidiScaling({ flip: true }).flip).toBe(true);
    });
});