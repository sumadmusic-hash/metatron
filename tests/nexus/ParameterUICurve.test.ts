import { describe, it, expect } from "vitest";
import {
    uiToNexusNorm,
    nexusNormToUi,
    registerParameterUICurve,
    getParameterUICurve,
    unregisterParameterUICurve,
} from "../../src/nexus/ParameterUICurve";
import type { ParameterUICurve, UICurvePoint } from "../../src/nexus/ParameterUICurve";
import {
    createNexusValueMapping,
    mapNormalizedToNexus,
    mapNexusToNormalized,
} from "../../src/nexus/NexusValueMapping";

// ── Pulverisateur cutoff 18..15500 (log UI curve, 5 control points) ─────
const PULV_LOG_UI: ParameterUICurve = {
    source: "measured",
    measuredAt: "2026-09-17T00:00:00.000Z",
    points: [
        // Derived from log model: ui = ln(raw/18)/ln(15500/18)
        // (ui, nexus-norm) pairs: nexusNorm = (raw − 18) / 15482
        { ui: 0,    nexus: 0 },        // raw=18  → nexusNorm=0
        { ui: 0.25, nexus: 0.00513 },  // raw≈97.5
        { ui: 0.50, nexus: 0.03293 },  // raw≈528
        { ui: 0.75, nexus: 0.1835 },   // raw≈2860
        { ui: 1,    nexus: 1 },        // raw=15500 → nexusNorm=1
    ],
};

const CUTOFF_MAPPING = createNexusValueMapping({ location: {} });
// Manually set linear 18..15500 mapping for the test (offline doc has different range).
const LINEAR_CUTOFF = {
    kind: "linear" as const,
    min: 18,
    max: 15500,
    isInteger: false,
};

// ── Pure conversion tests ───────────────────────────────────────────────

describe("ParameterUICurve — pure conversion", () => {
    it("identity when no curve exists", () => {
        expect(uiToNexusNorm(undefined, 0.5)).toBe(0.5);
        expect(nexusNormToUi(undefined, 0.5)).toBe(0.5);
    });

    it("endpoints 0→0 and 1→1 (always enforced)", () => {
        expect(uiToNexusNorm(PULV_LOG_UI, 0)).toBeCloseTo(0, 6);
        expect(uiToNexusNorm(PULV_LOG_UI, 1)).toBeCloseTo(1, 6);
        expect(nexusNormToUi(PULV_LOG_UI, 0)).toBeCloseTo(0, 6);
        expect(nexusNormToUi(PULV_LOG_UI, 1)).toBeCloseTo(1, 6);
    });

    it("ui=0.5 → nexusNorm ≈ 0.0329 (not 0.5 — Audiotool knob at 50%)", () => {
        const nexus = uiToNexusNorm(PULV_LOG_UI, 0.5);
        expect(nexus).toBeCloseTo(0.03293, 3);
        expect(nexus).not.toBeCloseTo(0.5, 1); // NOT the old linear midpoint
    });

    it("roundtrip ui → nexus → ui within floating-point tolerance", () => {
        for (const ui of [0, 0.1, 0.25, 0.37, 0.5, 0.63, 0.75, 0.91, 1]) {
            const nexus = uiToNexusNorm(PULV_LOG_UI, ui);
            expect(nexusNormToUi(PULV_LOG_UI, nexus)).toBeCloseTo(ui, 9);
        }
    });

    it("roundtrip nexus → ui → nexus within floating-point tolerance", () => {
        for (const n of [0, 0.005, 0.033, 0.184, 0.5, 1]) {
            const ui = nexusNormToUi(PULV_LOG_UI, n);
            expect(uiToNexusNorm(PULV_LOG_UI, ui)).toBeCloseTo(n, 4);
        }
    });

    it("out-of-range values are clamped to endpoints", () => {
        expect(uiToNexusNorm(PULV_LOG_UI, -0.1)).toBe(0);
        expect(uiToNexusNorm(PULV_LOG_UI, 1.5)).toBe(1);
        expect(nexusNormToUi(PULV_LOG_UI, -0.1)).toBe(0);
        expect(nexusNormToUi(PULV_LOG_UI, 1.5)).toBe(1);
    });
});

// ── Write pipeline: ui → nexusNorm → raw ────────────────────────────────

describe("ParameterUICurve — write pipeline (ui → raw)", () => {
    it("Cutoff 50% → raw ≈ 528 Hz (NOT 7759 Hz — the B68/B69 bug)", () => {
        const nexusNorm = uiToNexusNorm(PULV_LOG_UI, 0.5);
        const raw = mapNormalizedToNexus(LINEAR_CUTOFF, nexusNorm);
        // Log model: 18 * (15500/18)^0.5 ≈ 528 Hz
        expect(raw).toBeCloseTo(528, 0);
        expect(raw).not.toBeCloseTo(7759, -2); // NOT old linear midpoint
    });

    it("Cutoff 0% → raw = 18 Hz (min) and 100% → raw = 15500 Hz (max)", () => {
        expect(mapNormalizedToNexus(LINEAR_CUTOFF, uiToNexusNorm(PULV_LOG_UI, 0))).toBe(18);
        expect(mapNormalizedToNexus(LINEAR_CUTOFF, uiToNexusNorm(PULV_LOG_UI, 1))).toBe(15500);
    });

    it("without a curve: ui=0.5 → raw = 7759 Hz (linear identity — no regression)", () => {
        const nexusNorm = uiToNexusNorm(undefined, 0.5);
        const raw = mapNormalizedToNexus(LINEAR_CUTOFF, nexusNorm);
        expect(raw).toBeCloseTo(7759, 0);
    });
});

// ── Read pipeline: raw → nexusNorm → ui ─────────────────────────────────

describe("ParameterUICurve — read pipeline (raw → ui)", () => {
    it("raw=528 Hz → ui ≈ 0.5 (Audiotool shows 50% knob)", () => {
        const nexusNorm = mapNexusToNormalized(LINEAR_CUTOFF, 528);
        const ui = nexusNormToUi(PULV_LOG_UI, nexusNorm);
        expect(ui).toBeCloseTo(0.5, 3);
    });

    it("raw=18 → ui=0 and raw=15500 → ui=1", () => {
        expect(nexusNormToUi(PULV_LOG_UI, mapNexusToNormalized(LINEAR_CUTOFF, 18))).toBeCloseTo(0, 6);
        expect(nexusNormToUi(PULV_LOG_UI, mapNexusToNormalized(LINEAR_CUTOFF, 15500))).toBeCloseTo(1, 6);
    });

    it("without a curve: raw=7759 → ui=0.5 (linear identity — no regression)", () => {
        const nexusNorm = mapNexusToNormalized(LINEAR_CUTOFF, 7759);
        expect(nexusNormToUi(undefined, nexusNorm)).toBeCloseTo(0.5, 4);
    });
});

// ── Preset roundtrip: store 0.7 → write → raw → read back → ~0.7 ──────

describe("ParameterUICurve — preset roundtrip through full pipeline", () => {
    it("ui=0.7 → write pipeline → raw → read pipeline → ≈0.7", () => {
        const uiStore = 0.7;
        const nexusNorm = uiToNexusNorm(PULV_LOG_UI, uiStore);
        const raw = mapNormalizedToNexus(LINEAR_CUTOFF, nexusNorm);
        const readNexus = mapNexusToNormalized(LINEAR_CUTOFF, raw);
        const uiRead = nexusNormToUi(PULV_LOG_UI, readNexus);
        expect(uiRead).toBeCloseTo(uiStore, 6);
    });

    it("presets without a curve: 0.5 → 0.5 (identity — no regression)", () => {
        const nexusNorm = uiToNexusNorm(undefined, 0.5);
        const raw = mapNormalizedToNexus(LINEAR_CUTOFF, nexusNorm);
        const readNexus = mapNexusToNormalized(LINEAR_CUTOFF, raw);
        const uiRead = nexusNormToUi(undefined, readNexus);
        expect(uiRead).toBeCloseTo(0.5, 6);
    });
});

// ── Registry ────────────────────────────────────────────────────────────

describe("ParameterUICurve — registry", () => {
    it("register, get, unregister roundtrip", () => {
        const key = "pulverisateur:filter.cutoffFrequencyHz";
        registerParameterUICurve(key, PULV_LOG_UI);
        expect(getParameterUICurve(key)?.points.length).toBe(5);
        unregisterParameterUICurve(key);
        expect(getParameterUICurve(key)).toBeUndefined();
    });

    it("sanitize enforces endpoints even when missing", () => {
        const key = "test:no-endpoints";
        registerParameterUICurve(key, {
            source: "measured",
            measuredAt: "",
            points: [{ ui: 0.25, nexus: 0.1 }, { ui: 0.75, nexus: 0.9 }],
        });
        const c = getParameterUICurve(key)!;
        expect(c.points[0]).toEqual({ ui: 0, nexus: 0 });
        expect(c.points[c.points.length - 1]).toEqual({ ui: 1, nexus: 1 });
        unregisterParameterUICurve(key);
    });

    it("non-monotonic nexus values → rejected (identity fallback)", () => {
        const key = "test:non-monotonic";
        registerParameterUICurve(key, {
            source: "measured",
            measuredAt: "",
            points: [
                { ui: 0, nexus: 0 },
                { ui: 0.5, nexus: 0.8 },
                { ui: 1, nexus: 0.3 }, // non-monotonic!
            ],
        });
        // Rejected → undefined stored.
        expect(getParameterUICurve(key)).toBeUndefined();
    });
});

// ── Regression: concrete bug for Pulverisateur cutoff ───────────────────

describe("ParameterUICurve — regression test for Pulverisateur Cutoff", () => {
    it("Metatron UI 50% must NOT map to 7759 Hz; it must map to the raw value that makes Audiotool's knob show 50%", () => {
        const key = "pulverisateur:filter.cutoffFrequencyHz";
        registerParameterUICurve(key, PULV_LOG_UI);
        try {
            // Full pipeline test:
            // 1) Metatron UI 0.5 → uiToNexusNorm → nexusNorm
            const nexusNorm = uiToNexusNorm(PULV_LOG_UI, 0.5);
            // 2) nexusNorm → mapNormalizedToNexus → raw Hz
            const raw = mapNormalizedToNexus(LINEAR_CUTOFF, nexusNorm);
            // The old (broken) value was 7759 — this must NOT happen.
            expect(raw).not.toBeCloseTo(7759, 0);
            // The correct value (from log model at ui=0.5) ≈ 528 Hz.
            expect(raw).toBeCloseTo(528, 0);

            // 3) Read back: raw → mapNexusToNormalized → nexusNormToUi ≈ 0.5
            const readNexus = mapNexusToNormalized(LINEAR_CUTOFF, raw);
            const readUi = nexusNormToUi(PULV_LOG_UI, readNexus);
            expect(readUi).toBeCloseTo(0.5, 3);
        } finally {
            unregisterParameterUICurve(key);
        }
    });
});
