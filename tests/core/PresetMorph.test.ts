import { describe, it, expect } from "vitest";
import { Preset } from "../../src/core/model/Preset";
import { morphControlValues } from "../../src/core/model/PresetMorph";

function preset(name: string, deviceId: string, values: Record<string, number>): Preset {
    const p = new Preset(name, deviceId);
    p.controlValues = { ...values };
    return p;
}

const DEV = "dev_morph";

describe("morphControlValues (M9)", () => {

    it("1 — amount = 0 returns A values", () => {
        const a = preset("A", DEV, { k: 0.2, onlyA: 0.9 });
        const b = preset("B", DEV, { k: 0.8 });
        const out = morphControlValues(a, b, 0);
        expect(out.k).toBeCloseTo(0.2, 10);
        expect(out.onlyA).toBe(0.9);
    });

    it("2 — amount = 1 returns B values", () => {
        const a = preset("A", DEV, { k: 0.2 });
        const b = preset("B", DEV, { k: 0.8, onlyB: 0.4 });
        const out = morphControlValues(a, b, 1);
        expect(out.k).toBeCloseTo(0.8, 10);
        expect(out.onlyB).toBe(0.4);
    });

    it("3 — amount = 0.5 returns the midpoint", () => {
        const a = preset("A", DEV, { k: 0.2 });
        const b = preset("B", DEV, { k: 0.8 });
        const out = morphControlValues(a, b, 0.5);
        expect(out.k).toBeCloseTo(0.5, 10);
    });

    it("4 — amount is clamped below 0", () => {
        const a = preset("A", DEV, { k: 0.2 });
        const b = preset("B", DEV, { k: 0.8 });
        const out = morphControlValues(a, b, -1);
        expect(out.k).toBeCloseTo(0.2, 10);
    });

    it("5 — amount is clamped above 1", () => {
        const a = preset("A", DEV, { k: 0.2 });
        const b = preset("B", DEV, { k: 0.8 });
        const out = morphControlValues(a, b, 3);
        expect(out.k).toBeCloseTo(0.8, 10);
    });

    it("6 — controls in both presets are interpolated", () => {
        const a = preset("A", DEV, { k1: 0, k2: 0.25 });
        const b = preset("B", DEV, { k1: 1, k2: 0.75 });
        const out = morphControlValues(a, b, 0.25);
        expect(out.k1).toBeCloseTo(0.25, 10);
        expect(out.k2).toBeCloseTo(0.375, 10);
    });

    it("7 — A-only controls keep the A value", () => {
        const a = preset("A", DEV, { shared: 0.5, onlyA: 0.71 });
        const b = preset("B", DEV, { shared: 0.5 });
        const out = morphControlValues(a, b, 0.5);
        expect(out.onlyA).toBe(0.71);
    });

    it("8 — B-only controls keep the B value", () => {
        const a = preset("A", DEV, { shared: 0.5 });
        const b = preset("B", DEV, { shared: 0.5, onlyB: 0.33 });
        const out = morphControlValues(a, b, 0.5);
        expect(out.onlyB).toBe(0.33);
    });

    it("9 — switch controls quantize at the 0.5 boundary", () => {
        const a = preset("A", DEV, { sw: 0.2, above: 0.49, below: 0.5 });
        const b = preset("B", DEV, { sw: 0.8, above: 0.99, below: 0.0 });
        const types = { sw: "switch", above: "switch", below: "switch" };
        const out = morphControlValues(a, b, 0.5, types);
        expect(out.sw).toBe(1);        // 0.5 midpoint → >= 0.5 → 1
        expect(out.above).toBe(1);     // 0.74 → 1
        expect(out.below).toBe(0);     // 0.25 → 0
    });

    it("10 — normal controls remain continuous", () => {
        const a = preset("A", DEV, { knob: 0.2 });
        const b = preset("B", DEV, { knob: 0.8 });
        const out = morphControlValues(a, b, 0.25);
        expect(out.knob).toBeCloseTo(0.35, 10);
    });

    it("11 — empty presets produce an empty map", () => {
        const emptyA = preset("A", DEV, {});
        const emptyB = preset("B", DEV, {});
        expect(morphControlValues(emptyA, emptyB, 0.5)).toEqual({});
        expect(morphControlValues(emptyA, emptyB, 0.3)).toEqual({});
    });

    it("12 — inputs are not mutated", () => {
        const a = preset("A", DEV, { k: 0.2, sw: 0.2 });
        const b = preset("B", DEV, { k: 0.8, sw: 0.8 });
        const beforeA = JSON.stringify(a.controlValues);
        const beforeB = JSON.stringify(b.controlValues);

        morphControlValues(a, b, 0.5, { sw: "switch" });
        morphControlValues(a, b, 1.5, { sw: "switch" });
        morphControlValues(a, b, -0.5, { sw: "switch" });

        expect(JSON.stringify(a.controlValues)).toBe(beforeA);
        expect(JSON.stringify(b.controlValues)).toBe(beforeB);
        expect(a.name).toBe("A");
        expect(b.name).toBe("B");
    });

    it("13 — result is deterministic", () => {
        const a = preset("A", DEV, { k: 0.2, onlyA: 0.1 });
        const b = preset("B", DEV, { k: 0.8, onlyB: 0.9 });
        for (let i = 0; i < 5; i++) {
            expect(morphControlValues(a, b, 0.37)).toEqual(morphControlValues(a, b, 0.37));
        }
    });

    it("14 — no NaN/Infinity is produced", () => {
        const a = preset("A", DEV, { k: 0.2, onlyA: 0.5 });
        const b = preset("B", DEV, { k: 0.8, onlyB: 0.5 });
        for (const amount of [-5, 0, 0.5, 1, 9]) {
            const out = morphControlValues(a, b, amount);
            for (const v of Object.values(out)) {
                expect(Number.isFinite(v)).toBe(true);
            }
        }
    });
});