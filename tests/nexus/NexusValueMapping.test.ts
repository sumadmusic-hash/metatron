import { describe, it, expect } from "vitest";
import {
    createNexusValueMapping,
    mapNormalizedToNexus,
    mapNexusToNormalized,
} from "../../src/nexus/NexusValueMapping";

/**
 * Generic Nexus Value Mapping — pure unit coverage over schema-derived ranges.
 */
describe("NexusValueMapping — linear write/read + boundary safety", () => {
    const cutoff: any = {
        kind: "linear",
        min: 18,
        max: 15500,
        isInteger: false,
        typeLabel: "number",
    };
    const midpoint = 18 + 0.5 * (15500 - 18); // 7759

    it("write: 0.0 -> 18, 0.5 -> midpoint, 1.0 -> 15500", () => {
        expect(mapNormalizedToNexus(cutoff, 0.0)).toBe(18);
        expect(mapNormalizedToNexus(cutoff, 0.5)).toBe(midpoint);
        expect(mapNormalizedToNexus(cutoff, 1.0)).toBe(15500);
    });

    it("read: 18 -> 0.0, midpoint -> 0.5, 15500 -> 1.0", () => {
        expect(mapNexusToNormalized(cutoff, 18)).toBe(0);
        expect(mapNexusToNormalized(cutoff, midpoint)).toBe(0.5);
        expect(mapNexusToNormalized(cutoff, 15500)).toBe(1);
    });

    it("boundary safety: out-of-range normalized clamps into [0,1] first", () => {
        expect(mapNormalizedToNexus(cutoff, -0.5)).toBe(18);
        expect(mapNormalizedToNexus(cutoff, 1.5)).toBe(15500);
    });

    it("boundary safety: write never escapes the Nexus range", () => {
        for (const n of [-2, -0.001, 0, 0.0001, 0.5, 0.9999, 1, 1.5, 99]) {
            const out = mapNormalizedToNexus(cutoff, n) as number;
            expect(out).toBeGreaterThanOrEqual(18);
            expect(out).toBeLessThanOrEqual(15500);
        }
    });

    it("negative range (panning -1..+1): 0.5 -> 0, 1 -> 1, read -1 -> 0", () => {
        const pan: any = { kind: "linear", min: -1, max: 1, isInteger: false };
        expect(mapNormalizedToNexus(pan, 0.5)).toBe(0);
        expect(mapNormalizedToNexus(pan, 1)).toBe(1);
        expect(mapNormalizedToNexus(pan, 0)).toBe(-1);
        expect(mapNexusToNormalized(pan, -1)).toBe(0);
        expect(mapNexusToNormalized(pan, 0)).toBe(0.5);
        expect(mapNexusToNormalized(pan, 1)).toBe(1);
    });

    it("identity range [0,1] maps 1:1", () => {
        const id: any = { kind: "linear", min: 0, max: 1, isInteger: false };
        expect(mapNormalizedToNexus(id, 0.25)).toBe(0.25);
        expect(mapNexusToNormalized(id, 0.55)).toBe(0.55);
    });

    it("integer/step-like (modeIndex [1,2]): rounds and stays in range", () => {
        const mode: any = { kind: "linear", min: 1, max: 2, isInteger: true };
        expect(mapNormalizedToNexus(mode, 0)).toBe(1);
        expect(mapNormalizedToNexus(mode, 0.37)).toBe(1); // 1.37 -> round 1
        expect(mapNormalizedToNexus(mode, 0.75)).toBe(2); // 1.75 -> round 2
        expect(mapNormalizedToNexus(mode, 1)).toBe(2);
        expect(mapNexusToNormalized(mode, 1)).toBe(0);
        expect(mapNexusToNormalized(mode, 2)).toBe(1);
    });

    it("boolean primitive: write binary, read 0/1", () => {
        const b: any = { kind: "boolean", typeLabel: "boolean" };
        expect(mapNormalizedToNexus(b, 0)).toBe(false);
        expect(mapNormalizedToNexus(b, 0.3)).toBe(false);
        expect(mapNormalizedToNexus(b, 0.5)).toBe(true);
        expect(mapNormalizedToNexus(b, 1)).toBe(true);
        expect(mapNexusToNormalized(b, true)).toBe(1);
        expect(mapNexusToNormalized(b, false)).toBe(0);
        expect(mapNexusToNormalized(b, 1)).toBe(1);
        expect(mapNexusToNormalized(b, 0)).toBe(0);
    });

    it("degenerate range (min===max) writes the constant, reads 0", () => {
        const d: any = { kind: "linear", min: 5, max: 5, isInteger: false };
        expect(mapNormalizedToNexus(d, 0)).toBe(5);
        expect(mapNormalizedToNexus(d, 1)).toBe(5);
        expect(mapNexusToNormalized(d, 5)).toBe(0);
    });

    it("unsupported mapping refuses writes (undefined)", () => {
        const u: any = { kind: "unsupported", typeLabel: "schema-unavailable" };
        expect(mapNormalizedToNexus(u, 1)).toBeUndefined();
        expect(mapNexusToNormalized(u, 123)).toBe(0);
    });

    it("createNexusValueMapping tolerates non-schema objects", () => {
        const m = createNexusValueMapping({ location: "garbage" });
        expect(m.kind).toBe("unsupported");
        expect(mapNormalizedToNexus(m, 0.5)).toBeUndefined();
    });
});