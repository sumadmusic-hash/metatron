// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fitTransfer, probeField } from "../../src/nexus/ValueCurveProbe";

/**
 * Phase 5 Schritt 1 — pure Fit-Mathematik + probeField gegen Fake-Document.
 * Keine Registry, kein Mapping-Delta in diesem Commit (§6).
 *
 * probeField selbst nutzt DAS ECHTE getSchemaLocationDetails (SDK-Import);
 * für den Fake-Field-Unit-Test wird nur createNexusValueMapping auf ein
 * lineares Mapping gestellt — mapNormalizedToNexus bleibt real.
 */

vi.mock("../../src/nexus/NexusValueMapping", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/nexus/NexusValueMapping")>();
    return {
        ...actual,
        createNexusValueMapping: vi.fn((field: any) => {
            if (field?.location?.entityType === "pulverisator") {
                return { kind: "linear", min: 20, max: 20000, isInteger: false, typeLabel: "number" };
            }
            return { kind: "unsupported", typeLabel: "schema-unavailable" };
        }),
    };
});

function expSamples(y0: number, y1: number, steps = 10): { samples; schemaMin; schemaMax } {
    const schemaMin = 0;
    const schemaMax = 1;
    const ratio = y1 / y0;
    return {
        samples: Array.from({ length: steps + 1 }, (_, i) => {
            const n = i / steps;
            return { n, raw: n, displayed: y0 * Math.pow(ratio, n) };
        }),
        schemaMin,
        schemaMax,
    };
}

function powerSamples(k: number, steps = 10): { samples; schemaMin; schemaMax } {
    const schemaMin = 0;
    const schemaMax = 1;
    return {
        samples: Array.from({ length: steps + 1 }, (_, i) => {
            const n = i / steps;
            return { n, raw: n, displayed: Math.pow(n, k) };
        }),
        schemaMin,
        schemaMax,
    };
}

function fakePulvField() {
    return {
        location: { kind: "field", entityType: "pulverisator", pathParts: ["filter", "cutoffHz"] },
        value: 20,
    };
}

function fakeDoc() {
    return {
        modify: async (fn: (t: any) => void) => {
            fn({ update: (f: any, v: number) => { f.value = v; } });
        },
    } as any;
}

describe("ValueCurveProbe — fitTransfer (Phase 5 Schritt 1)", () => {
    it("synthetic exp (y = 20 * 1000^r) → winner exp, residualNeper < 1e-6", () => {
        const { samples, schemaMin, schemaMax } = expSamples(20, 20000);
        const { fits, winner } = fitTransfer(samples, schemaMin, schemaMax);
        expect(fits.some((f) => f.kind === "exp")).toBe(true);
        expect(winner?.kind).toBe("exp");
        expect(winner!.residualNeper).toBeLessThan(1e-6);
    });

    it("synthetic power (d = r^2) → winner power, exponent ≈ 2 (±0.05)", () => {
        const { samples, schemaMin, schemaMax } = powerSamples(2);
        const { fits, winner } = fitTransfer(samples, schemaMin, schemaMax);
        expect(fits.some((f) => f.kind === "power")).toBe(true);
        expect(winner?.kind).toBe("power");
        expect(winner!.exponent).toBeCloseTo(2, 2);
        expect(Math.abs(winner!.exponent! - 2)).toBeLessThan(0.05);
    });

    it("bipolar (displayed crosses 0) → exp AND power rejected, winner null, piecewise in fits", () => {
        const schemaMin = 0;
        const schemaMax = 1;
        const samples = Array.from({ length: 11 }, (_, i) => {
            const n = i / 10;
            return { n, raw: n, displayed: n * 2 - 1 }; // crosses 0 at n = 0.5
        });
        const { fits, winner } = fitTransfer(samples, schemaMin, schemaMax);
        expect(fits.some((f) => f.kind === "exp")).toBe(false);
        expect(fits.some((f) => f.kind === "power")).toBe(false);
        expect(fits.some((f) => f.kind === "piecewise")).toBe(true);
        expect(winner).toBeNull();
    });

    it("no displayed values → fits empty, winner null", () => {
        const schemaMin = 0;
        const schemaMax = 1;
        const samples = Array.from({ length: 11 }, (_, i) => ({ n: i / 10, raw: i / 10, displayed: null as number | null }));
        const { fits, winner } = fitTransfer(samples, schemaMin, schemaMax);
        expect(fits).toHaveLength(0);
        expect(winner).toBeNull();
    });

    it("probeField with Fake-Document (modify writes field.value) + readDisplayed stub → 11 samples, rawLinear, identityTransfer true", async () => {
        const field = fakePulvField();
        const readRaw = () => field.value;

        const report = await probeField(fakeDoc(), field, "pulverisator:filter.cutoffHz", readRaw, 10);
        expect(report.samples).toHaveLength(11);
        expect(report.schemaMin).toBe(20);
        expect(report.schemaMax).toBe(20000);
        expect(report.rawLinear).toBe(true);
        expect(report.identityTransfer).toBe(true); // displayed === raw → physical identity
        expect(report.fits).toHaveLength(0);
        expect(report.winner).toBeNull();
        expect(report.samples[10].raw).toBeCloseTo(20000, 5);
        expect(report.samples[0].raw).toBeCloseTo(20, 5);
    });

    it("probeField identityTransfer=false when the display disagrees with the raw write", async () => {
        const field = fakePulvField();
        const readHalf = () => field.value * 0.5; // display lags raw → NOT identity

        const report = await probeField(fakeDoc(), field, "pulverisator:filter.cutoffHz", readHalf, 10);
        expect(report.samples).toHaveLength(11);
        expect(report.identityTransfer).toBe(false);
    });
});

beforeEach(() => {
    document.body.innerHTML = "";
});