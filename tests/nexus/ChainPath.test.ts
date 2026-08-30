/**
 * PRODUCTION REGRESSION — field-path resolution over nested NexusObject
 * arrays (`bands.[i].field`), guarded against the canonical production
 * resolver `src/nexus/ChainPath.resolveFieldByPath`.
 *
 * The 36-path matrix mirrors the proven PoC fixture
 * (`poc/chain-clone/clone.test.ts`) so the array-path capability that was
 * previously only covered inside the PoC is now also owned by the production
 * suite. Negative cases (missing, out-of-range, non-object descent) must keep
 * returning `undefined` — resolution never throws, never guesses.
 */

import { describe, it, expect } from "vitest";
import { resolveFieldByPath } from "../../src/nexus/ChainPath";

const BAND_FIELDS = [
    "thresholdDb",
    "ratio",
    "kneeDb",
    "attackMs",
    "releaseMs",
    "makeupGainDb",
    "isCompressorActive",
    "isMuted",
    "isSoloed",
] as const;

function primitiveField(value: unknown): any {
    return { value, location: {} };
}

/** Item shape WITHOUT a `.fields` container (plain object of primitive fields). */
function bandItemFieldsFlat(valueBase: number): Record<string, any> {
    return {
        thresholdDb: primitiveField(valueBase - 40),
        ratio: primitiveField(valueBase * 0.1),
        kneeDb: primitiveField(valueBase - 40),
        attackMs: primitiveField(valueBase),
        releaseMs: primitiveField(valueBase * 10),
        makeupGainDb: primitiveField(valueBase),
        isCompressorActive: primitiveField(valueBase % 2 === 0),
        isMuted: primitiveField(valueBase % 3 === 0),
        isSoloed: primitiveField(valueBase % 5 === 0),
    };
}

/** Item shape WITH the real NexusObject `.fields` container
 *  (`bands.array[0].fields.thresholdDb`). */
function bandItemFieldsWrapped(valueBase: number): any {
    return { location: {}, fields: bandItemFieldsFlat(valueBase) };
}

function quantumFieldsFixture(itemFactory: (base: number) => any): any {
    return {
        gainDb: primitiveField(0),
        isActive: primitiveField(true),
        splitFrequencyHz: {
            location: {},
            array: [primitiveField(120), primitiveField(240), primitiveField(960)],
        },
        bands: {
            location: {},
            array: [itemFactory(0), itemFactory(1), itemFactory(2), itemFactory(3)],
        },
    };
}

const QUANTUM_BAND_PATHS = BAND_FIELDS.flatMap((field) =>
    Array.from({ length: 4 }, (_, i) => `bands.[${i}].${field}`),
);

describe("ChainPath.resolveFieldByPath — nested NexusObject-array leaves", () => {
    it("resolves plain top-level fields (gainDb, isActive)", () => {
        const fields = quantumFieldsFixture(bandItemFieldsFlat);
        expect(resolveFieldByPath(fields, "gainDb")?.value).toBe(0);
        expect(resolveFieldByPath(fields, "isActive")?.value).toBe(true);
    });

    it("resolves primitives inside arrays (splitFrequencyHz.[0] / .[2])", () => {
        const fields = quantumFieldsFixture(bandItemFieldsFlat);
        expect(resolveFieldByPath(fields, "splitFrequencyHz.[0]")?.value).toBe(120);
        expect(resolveFieldByPath(fields, "splitFrequencyHz.[2]")?.value).toBe(960);
    });

    it("resolves all 36 band leaves across 4 plain object-array items", () => {
        const fields = quantumFieldsFixture(bandItemFieldsFlat);
        expect(fields.bands.array).toHaveLength(4);
        const resolved = QUANTUM_BAND_PATHS.map((p) => [p, resolveFieldByPath(fields, p)] as const);
        const missing = resolved.filter(([, f]) => !f || !("value" in f));
        expect(missing.map(([p]) => p)).toEqual([]);
        for (const [p, field] of resolved) {
            expect(field?.location, p).toBeDefined();
            expect("value" in field!, p).toBe(true);
        }
    });

    it("resolves all 36 band leaves through the .fields container (real NexusObject items)", () => {
        const fields = quantumFieldsFixture(bandItemFieldsWrapped);
        const resolved = QUANTUM_BAND_PATHS.map((p) => [p, resolveFieldByPath(fields, p)] as const);
        const missing = resolved.filter(([, f]) => !f || !("value" in f));
        expect(missing.map(([p]) => p)).toEqual([]);
        expect(resolveFieldByPath(fields, "bands.[2].attackMs")?.value).toBe(2);
    });

    it("resolves nested object fields (filter.cutoffFrequencyHz)", () => {
        const fields = {
            filter: { location: {}, fields: { cutoffFrequencyHz: primitiveField(7421) } },
        };
        expect(resolveFieldByPath(fields, "filter.cutoffFrequencyHz")?.value).toBe(7421);
    });

    describe("negative cases resolve to undefined (never throw, never guess)", () => {
        const fields = quantumFieldsFixture(bandItemFieldsFlat);

        it("missing leaf inside an array item", () => {
            expect(resolveFieldByPath(fields, "bands.[0].nope")).toBeUndefined();
        });

        it("out-of-range array index", () => {
            expect(resolveFieldByPath(fields, "bands.[9].thresholdDb")).toBeUndefined();
        });

        it("missing intermediary object", () => {
            expect(resolveFieldByPath(fields, "filter.cutoffFrequencyHz")).toBeUndefined();
        });

        it("descending into a primitive leaf (non-object) is undefined", () => {
            expect(resolveFieldByPath(fields, "gainDb.deep")).toBeUndefined();
        });

        it("descending past an array item that is not an object container", () => {
            const scalarArray = { x: { location: {}, array: [0, 1] } };
            expect(resolveFieldByPath(scalarArray, "x.[0].nested")).toBeUndefined();
        });
    });
});