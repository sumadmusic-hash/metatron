// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fitTransfer, probeField, makeDisplayReader, parseFrequencyText } from "../../src/nexus/ValueCurveProbe";

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

/** Fake-Doc, das jede update-Write protokolliert (für Restore- / Abbruch-Tests). */
function loggingDoc() {
    const writes: number[] = [];
    const doc: any = {
        writes,
        modify: async (fn: (t: any) => void) => {
            await fn({ update: (f: any, v: number) => { f.value = v; writes.push(v); } });
        },
    };
    return doc;
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

    it("B64 f32-quantized raw is still rawLinear (report tolerance scales with magnitude)", async () => {
        const schemaMin = 18;
        const schemaMax = 15500;
        const span = schemaMax - schemaMin;
        const samples = Array.from({ length: 11 }, (_, i) => ({
            n: i / 10,
            // Nexus stores raw as float32 → values like 1566.199951171875 instead of 1566.2
            raw: Math.fround(schemaMin + (i / 10) * span),
            displayed: null as number | null,
        }));
        const check = (eps: (v: number) => number) =>
            samples.every((s) => Math.abs(s.raw - (schemaMin + s.n * span)) <= eps(schemaMax));
        // Skalen-relative Toleranz (B64): f32-Rauschen ist hier erlaubt.
        expect(check((v) => Math.max(1e-5, v * 1.2e-7))).toBe(true);
        // Absolute 1e-6 (alt): schlägt bei f32-Rohdaten an der 15-kHz-Skala fehl.
        expect(check(() => 1e-6)).toBe(false);
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

    it("B56 restore: fake-doc write log ends with the INITIAL value (probe does not leave the parameter at its last sample)", async () => {
        const field = fakePulvField();
        field.value = 4321; // initial raw value before the probe
        const doc = loggingDoc();

        await probeField(doc, field, "pulverisator:filter.cutoffHz", null, 10);

        expect(doc.writes).toHaveLength(12); // 11 samples + 1 restore
        expect(doc.writes[doc.writes.length - 1]).toBe(4321);
        expect(field.value).toBe(4321);
    });

    it("B56 hooks: onBeforeWrite called exactly steps+1 times with the normalized probe value", async () => {
        const field = fakePulvField();
        const calls: number[] = [];

        await probeField(fakeDoc(), field, "pulverisator:filter.cutoffHz", null, 4, {
            onBeforeWrite: (n) => calls.push(n),
        });

        expect(calls).toHaveLength(5); // 4 + 1
        expect(calls[0]).toBe(0);
        expect(calls[4]).toBe(1);
    });

    it("B56 abort path: a throwing modify still restores the initial value", async () => {
        const field = fakePulvField();
        field.value = 777;
        const writes: number[] = [];
        const doc: any = {
            writes,
            modify: async (fn: (t: any) => void) => {
                writes.push(field.value);
                await fn({ update: (f: any, v: number) => { f.value = v; writes.push(v); } });
                if (writes.filter((_w, i) => i % 2 === 1).length >= 5) {
                    throw new Error("5th probe write failed");
                }
            },
        };

        await expect(
            probeField(doc, field, "pulverisator:filter.cutoffHz", null, 10),
        ).rejects.toThrow("5th probe write failed");
        expect(field.value).toBe(777); // restored despite abort
        const finalWrite = writes.length >= 2 ? writes[writes.length - 1] : null;
        expect(finalWrite).toBe(777);
    });

    it("B57 parseFrequencyText: kHz scaling, Hz passthrough, non-numeric → null", () => {
        expect(parseFrequencyText("1,2 kHz")).toBe(1200);
        expect(parseFrequencyText("840 Hz")).toBe(840);
        expect(parseFrequencyText("—")).toBeNull();
        expect(parseFrequencyText("")).toBeNull();
    });

    it("B57 makeDisplayReader with transform returns the kHz-scaled value", () => {
        const root = document.createElement("div");
        const el = document.createElement("span");
        el.textContent = "1,2 kHz";
        root.appendChild(el);
        const reader = makeDisplayReader(root, "span", parseFrequencyText);
        expect(reader()).toBe(1200);

        const naive = makeDisplayReader(root, "span");
        expect(naive()).toBe(1.2); // default parse reads the naked number
    });

    it("B59 restore failure: probe resolves, report.restoreError set, samples complete", async () => {
        const field = fakePulvField();
        field.value = 100;
        let writeCount = 0;
        const doc: any = {
            modify: async (fn: (t: any) => void) => {
                writeCount++;
                // steps=4 → 5 probe writes; the 6th is the mandatory restore.
                if (writeCount === 6) throw new Error("restore disconnected");
                await fn({ update: (f: any, v: number) => { f.value = v; } });
            },
        };

        const report = await probeField(doc, field, "pulverisator:filter.cutoffHz", null, 4);
        expect(report.samples).toHaveLength(5); // measurement completed
        expect(report.restoreError).toBe("restore disconnected");
        expect(report.fits).toBeDefined();
    });

    it("B59 abort + restore failure: probe rejects with the ORIGINAL message, not the restore message", async () => {
        const field = fakePulvField();
        field.value = 100;
        let writeCount = 0;
        const doc: any = {
            modify: async (fn: (t: any) => void) => {
                writeCount++;
                // After the 5th probe write, both the probe modify AND the
                // restore modify throw — the original must win.
                throw new Error("original probe failure");
            },
        };

        await expect(
            probeField(doc, field, "pulverisator:filter.cutoffHz", null, 10),
        ).rejects.toThrow("original probe failure");
        expect(writeCount).toBeGreaterThan(0);
    });
});

beforeEach(() => {
    document.body.innerHTML = "";
});