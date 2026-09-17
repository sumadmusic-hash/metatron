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

// ── Pulverisateur cutoff 18..15500 (REAL measured UI curve, B73) ────────
// Gemessen via pacedSweep (echte Audiotool-Knob-Ablesung, 2026-09-17):
//   nexusNorm 0.0->Knob 0.000    0.5->0.900
//             0.1->0.670          0.6->0.915
//             0.2->0.770          0.7->0.950
//             0.3->0.820          0.8->0.980
//             0.4->0.880          0.9->0.995
// Aufzeichnung: {ui: Knob, nexus: nexusNorm}. Endpunkt (1,1) via Sanitize.
const PULV_MEASURED_UI: ParameterUICurve = {
    source: "measured",
    measuredAt: "2026-09-17T00:00:00.000Z",
    points: [
        { ui: 0,     nexus: 0 },
        { ui: 0.67,  nexus: 0.1 },
        { ui: 0.77,  nexus: 0.2 },
        { ui: 0.82,  nexus: 0.3 },
        { ui: 0.88,  nexus: 0.4 },
        { ui: 0.9,   nexus: 0.5 },
        { ui: 0.915, nexus: 0.6 },
        { ui: 0.95,  nexus: 0.7 },
        { ui: 0.98,  nexus: 0.8 },
        { ui: 0.995, nexus: 0.9 },
        { ui: 1,     nexus: 1 },
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
        expect(uiToNexusNorm(PULV_MEASURED_UI, 0)).toBeCloseTo(0, 6);
        expect(uiToNexusNorm(PULV_MEASURED_UI, 1)).toBeCloseTo(1, 6);
        expect(nexusNormToUi(PULV_MEASURED_UI, 0)).toBeCloseTo(0, 6);
        expect(nexusNormToUi(PULV_MEASURED_UI, 1)).toBeCloseTo(1, 6);
    });

    it("ui=0.5 → nexusNorm ≈ 0.0746 (not 0.5 — Audiotool knob at 50%)", () => {
        const nexus = uiToNexusNorm(PULV_MEASURED_UI, 0.5);
        expect(nexus).toBeCloseTo(0.07463, 3);
        expect(nexus).not.toBeCloseTo(0.5, 1); // NOT the old linear midpoint
    });

    it("roundtrip ui → nexus → ui within floating-point tolerance", () => {
        for (const ui of [0, 0.1, 0.25, 0.37, 0.5, 0.63, 0.75, 0.91, 1]) {
            const nexus = uiToNexusNorm(PULV_MEASURED_UI, ui);
            expect(nexusNormToUi(PULV_MEASURED_UI, nexus)).toBeCloseTo(ui, 9);
        }
    });

    it("roundtrip nexus → ui → nexus within floating-point tolerance", () => {
        for (const n of [0, 0.005, 0.033, 0.184, 0.5, 1]) {
            const ui = nexusNormToUi(PULV_MEASURED_UI, n);
            expect(uiToNexusNorm(PULV_MEASURED_UI, ui)).toBeCloseTo(n, 4);
        }
    });

    it("out-of-range values are clamped to endpoints", () => {
        expect(uiToNexusNorm(PULV_MEASURED_UI, -0.1)).toBe(0);
        expect(uiToNexusNorm(PULV_MEASURED_UI, 1.5)).toBe(1);
        expect(nexusNormToUi(PULV_MEASURED_UI, -0.1)).toBe(0);
        expect(nexusNormToUi(PULV_MEASURED_UI, 1.5)).toBe(1);
    });
});

// ── Write pipeline: ui → nexusNorm → raw ────────────────────────────────

describe("ParameterUICurve — write pipeline (ui → raw)", () => {
    it("Cutoff 50% → raw ≈ 1173 Hz (NOT 7759 Hz — the B68/B69 bug)", () => {
        const nexusNorm = uiToNexusNorm(PULV_MEASURED_UI, 0.5);
        const raw = mapNormalizedToNexus(LINEAR_CUTOFF, nexusNorm);
        // Gemessene Kurve: Knob 50% liegt im Segment nexus 0..0.1 / ui 0..0.67
        expect(raw).toBeCloseTo(1173, 0);
        expect(raw).not.toBeCloseTo(7759, -2); // NOT old linear midpoint
    });

    it("Cutoff 0% → raw = 18 Hz (min) and 100% → raw = 15500 Hz (max)", () => {
        expect(mapNormalizedToNexus(LINEAR_CUTOFF, uiToNexusNorm(PULV_MEASURED_UI, 0))).toBe(18);
        expect(mapNormalizedToNexus(LINEAR_CUTOFF, uiToNexusNorm(PULV_MEASURED_UI, 1))).toBe(15500);
    });

    it("without a curve: ui=0.5 → raw = 7759 Hz (linear identity — no regression)", () => {
        const nexusNorm = uiToNexusNorm(undefined, 0.5);
        const raw = mapNormalizedToNexus(LINEAR_CUTOFF, nexusNorm);
        expect(raw).toBeCloseTo(7759, 0);
    });
});

// ── Read pipeline: raw → nexusNorm → ui ─────────────────────────────────

describe("ParameterUICurve — read pipeline (raw → ui)", () => {
    it("reale Audiotool-Positionen: 1556Hz→0.67 Knob, 7759Hz→0.90 Knob, 10855Hz→0.95 Knob", () => {
        // raw→nexus→ui für die drei gemessenen Punkte (Read-Richtung)
        const knobAt = (raw: number) => nexusNormToUi(PULV_MEASURED_UI, mapNexusToNormalized(LINEAR_CUTOFF, raw));
        expect(knobAt(1556)).toBeCloseTo(0.67, 2); // nexus 0.1 (gemessen)
        expect(knobAt(7759)).toBeCloseTo(0.9, 2);  // nexus 0.5 (gemessen)
        expect(knobAt(10855)).toBeCloseTo(0.95, 2); // nexus 0.7 (gemessen)
    });

    it("read pipeline: raw=1173 Hz → ui ≈ 0.5 (gemessene Kurve)", () => {
        const nexusNorm = mapNexusToNormalized(LINEAR_CUTOFF, 1173);
        const ui = nexusNormToUi(PULV_MEASURED_UI, nexusNorm);
        expect(ui).toBeCloseTo(0.5, 3);
    });

    it("raw=18 → ui=0 and raw=15500 → ui=1", () => {
        expect(nexusNormToUi(PULV_MEASURED_UI, mapNexusToNormalized(LINEAR_CUTOFF, 18))).toBeCloseTo(0, 6);
        expect(nexusNormToUi(PULV_MEASURED_UI, mapNexusToNormalized(LINEAR_CUTOFF, 15500))).toBeCloseTo(1, 6);
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
        const nexusNorm = uiToNexusNorm(PULV_MEASURED_UI, uiStore);
        const raw = mapNormalizedToNexus(LINEAR_CUTOFF, nexusNorm);
        const readNexus = mapNexusToNormalized(LINEAR_CUTOFF, raw);
        const uiRead = nexusNormToUi(PULV_MEASURED_UI, readNexus);
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
        registerParameterUICurve(key, PULV_MEASURED_UI);
        expect(getParameterUICurve(key)?.points.length).toBe(11);
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
    it("gemessene B73-Fixture ist streng monoton steigend (Verifikation §9)", () => {
        for (let i = 1; i < PULV_MEASURED_UI.points.length; i++) {
            expect(PULV_MEASURED_UI.points[i].ui).toBeGreaterThan(PULV_MEASURED_UI.points[i - 1].ui);
            expect(PULV_MEASURED_UI.points[i].nexus).toBeGreaterThan(PULV_MEASURED_UI.points[i - 1].nexus);
        }
        expect(PULV_MEASURED_UI.points[0]).toEqual({ ui: 0, nexus: 0 });
        expect(PULV_MEASURED_UI.points[PULV_MEASURED_UI.points.length - 1]).toEqual({ ui: 1, nexus: 1 });
    });
    it("Metatron UI 50% must NOT map to 7759 Hz; it must map to the raw value that makes Audiotool's knob show 50%", () => {
        const key = "pulverisateur:filter.cutoffFrequencyHz";
        registerParameterUICurve(key, PULV_MEASURED_UI);
        try {
            // Full pipeline test:
            // 1) Metatron UI 0.5 → uiToNexusNorm → nexusNorm
            const nexusNorm = uiToNexusNorm(PULV_MEASURED_UI, 0.5);
            // 2) nexusNorm → mapNormalizedToNexus → raw Hz
            const raw = mapNormalizedToNexus(LINEAR_CUTOFF, nexusNorm);
            // The old (broken) value was 7759 — this must NOT happen.
            expect(raw).not.toBeCloseTo(7759, 0);
            // The correct value (from the REAL measured curve at ui=0.5) ≈ 1173 Hz.
            expect(raw).toBeCloseTo(1173, 0);

            // 3) Read back: raw → mapNexusToNormalized → nexusNormToUi ≈ 0.5
            const readNexus = mapNexusToNormalized(LINEAR_CUTOFF, raw);
            const readUi = nexusNormToUi(PULV_MEASURED_UI, readNexus);
            expect(readUi).toBeCloseTo(0.5, 3);
        } finally {
            unregisterParameterUICurve(key);
        }
    });
});
