import { describe, it, expect } from "vitest";
import {
    linearToAutomation,
    automationToLinear,
    registerTaper,
    unregisterTaper,
    getTaper,
    taperKey,
} from "../../src/nexus/CurveRegistry";
import type { TaperDef } from "../../src/nexus/CurveRegistry";

// B68 — Cutoff 18..15500, Playback-Gleichung raw ≈ min·(max/min)^v.
const CUTOFF: TaperDef = {
    kind: "log",
    min: 18,
    max: 15500,
    source: "measured",
    measuredAt: "2026-09-17T00:00:00.000Z",
};

describe("CurveRegistry — pure taper math (B68)", () => {
    it("linearToAutomation(log, 0.5) lands at the log midpoint, not 0.5", () => {
        // v = ln(1 + 0.5·(ratio−1)) / ln(ratio), ratio = 15500/18 ≈ 861.11
        expect(linearToAutomation(CUTOFF, 0.5)).toBeCloseTo(0.8976, 3);
        // … und der Playback-Wert desselben Samples wäre min·(max/min)^v ≈ 7759 Hz
        // statt der lineare Mittelpunkts-Fehlklassifikation (≈528 Hz bei 0.5).
        const v = linearToAutomation(CUTOFF, 0.5);
        expect(18 * Math.pow(15500 / 18, v)).toBeCloseTo(7759, 0);
    });

    it("automationToLinear is the exact inverse (roundtrip ≤ 1e-9)", () => {
        for (const n of [0, 0.1, 0.25, 0.37, 0.5, 0.63, 0.75, 0.91, 1]) {
            expect(automationToLinear(CUTOFF, linearToAutomation(CUTOFF, n))).toBeCloseTo(n, 9);
        }
    });

    it("no taper → identity (current behavior is preserved when the registry is empty)", () => {
        expect(linearToAutomation(undefined, 0.5)).toBe(0.5);
        expect(automationToLinear(undefined, 0.42)).toBe(0.42);
    });

    it("degenerate log tapers (min ≤ 0 or max ≤ min) → identity, no NaN", () => {
        const badMin: TaperDef = { kind: "log", min: 0, max: 15500, source: "measured", measuredAt: "" };
        const badRange: TaperDef = { kind: "log", min: 100, max: 100, source: "measured", measuredAt: "" };
        const badSwap: TaperDef = { kind: "log", min: 15500, max: 18, source: "measured", measuredAt: "" };
        for (const t of [badMin, badRange, badSwap]) {
            expect(Number.isNaN(linearToAutomation(t, 0.5))).toBe(false);
            expect(Number.isNaN(automationToLinear(t, 0.5))).toBe(false);
            expect(linearToAutomation(t, 0.5)).toBe(0.5);
            expect(automationToLinear(t, 0.5)).toBe(0.5);
        }
    });

    it("registerTaper/getTaper/unregisterTaper roundtrip", () => {
        const key = "test:taper";
        registerTaper(key, CUTOFF);
        expect(getTaper(key)).toEqual(CUTOFF);
        unregisterTaper(key);
        expect(getTaper(key)).toBeUndefined();
    });
});

describe("CurveRegistry — canonical taperKey (B66/B68)", () => {
    it("strips a trailing fieldPath suffix from the targetName and slugs the head", () => {
        expect(taperKey("pulverisateur / filter.cutoffFrequencyHz", "filter.cutoffFrequencyHz")).toBe(
            "pulverisateur:filter.cutoffFrequencyHz"
        );
    });

    it("falls back to the fieldPath when no targetName exists", () => {
        expect(taperKey(undefined, "filter.cutoffFrequencyHz")).toBe("filter-cutofffrequencyhz:filter.cutoffFrequencyHz");
    });

    it("keeps the raw targetName when it does not end with the fieldPath", () => {
        expect(taperKey("pulverisateur", "filter.cutoffFrequencyHz")).toBe("pulverisateur:filter.cutoffFrequencyHz");
    });
});