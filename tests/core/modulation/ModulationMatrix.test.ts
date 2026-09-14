import { describe, it, expect } from "vitest";
import {
    ModulationConfigError,
    parseModulationMatrix,
    serializeModulationMatrix,
} from "../../../src/core/modulation/ModulationMatrix";
import {
    MAX_MOD_SLOTS,
    MAX_MOD_SOURCES,
    createDefaultMatrix,
} from "../../../src/core/modulation/ModulationTypes";
import { Device } from "../../../src/core/model/Device";

describe("ModulationMatrix — defaults (FIX 4 fallback)", () => {
    it("parse(undefined) → default matrix with 10 sources and 20 slots, everything disabled", () => {
        const matrix = parseModulationMatrix(undefined);
        expect(matrix.sources).toHaveLength(MAX_MOD_SOURCES);
        expect(matrix.slots).toHaveLength(MAX_MOD_SLOTS);
        for (const s of matrix.sources) {
            expect(s.enabled).toBe(false);
            expect(s.type).toBe("lfo");
            expect(s.waveform).toBe("sine");
        }
        for (const slot of matrix.slots) {
            expect(slot.enabled).toBe(false);
            expect(slot.amount).toBe(0);
        }
    });

    it("parse of non-object payloads (null / number / string) → defaults", () => {
        expect(parseModulationMatrix(null).sources).toHaveLength(MAX_MOD_SOURCES);
        expect(parseModulationMatrix(42).sources).toHaveLength(MAX_MOD_SOURCES);
        expect(parseModulationMatrix("x").sources).toHaveLength(MAX_MOD_SOURCES);
    });
});

describe("ModulationMatrix — sanitize chain", () => {
    function oneSourceOneSlot(overrides: Record<string, unknown>): ReturnType<typeof parseModulationMatrix> {
        return parseModulationMatrix({
            sources: [{ id: "mod1", ...overrides }],
            slots: [{ id: "slot1" }],
        });
    }

    it("rateHz null / \"x\" / NaN sanitize to 1", () => {
        expect(oneSourceOneSlot({ rateHz: null }).sources[0].rateHz).toBe(1);
        expect(oneSourceOneSlot({ rateHz: "x" }).sources[0].rateHz).toBe(1);
        expect(oneSourceOneSlot({ rateHz: Number.NaN }).sources[0].rateHz).toBe(1);
    });

    it("rateHz above range clamps to the 20 Hz cap", () => {
        expect(oneSourceOneSlot({ rateHz: 999 }).sources[0].rateHz).toBe(20);
    });

    it("slot amount \"2\" clamps to 1 and −3 clamps to −1", () => {
        const high = parseModulationMatrix({ sources: [], slots: [{ id: "slot1", amount: "2" }] });
        const low = parseModulationMatrix({ sources: [], slots: [{ id: "slot1", amount: -3 }] });
        expect(high.slots[0].amount).toBe(1);
        expect(low.slots[0].amount).toBe(-1);
    });

    it("phase below range clamps to 0", () => {
        expect(oneSourceOneSlot({ phase: -0.5 }).sources[0].phase).toBe(0);
    });

    it("unknown waveform sanitizes to \"sine\"", () => {
        expect(oneSourceOneSlot({ waveform: "foo" }).sources[0].waveform).toBe("sine");
    });

    it("noteDivision rounds and never drops below 1 (default 4)", () => {
        expect(oneSourceOneSlot({ noteDivision: 2.7 }).sources[0].noteDivision).toBe(3);
        expect(oneSourceOneSlot({ noteDivision: 0.2 }).sources[0].noteDivision).toBe(1);
        expect(oneSourceOneSlot({ noteDivision: undefined }).sources[0].noteDivision).toBe(4);
    });

    it("drift clamps into [0,1] (default 0.5); smoothMs into [0,10000] (default 200)", () => {
        expect(oneSourceOneSlot({ drift: -2 }).sources[0].drift).toBe(0);
        expect(oneSourceOneSlot({ drift: 7 }).sources[0].drift).toBe(1);
        expect(oneSourceOneSlot({ drift: undefined }).sources[0].drift).toBe(0.5);
        expect(oneSourceOneSlot({ smoothMs: 20000 }).sources[0].smoothMs).toBe(10000);
        expect(oneSourceOneSlot({ smoothMs: -1 }).sources[0].smoothMs).toBe(0);
        expect(oneSourceOneSlot({ smoothMs: undefined }).sources[0].smoothMs).toBe(200);
    });
});

describe("ModulationMatrix — structural caps", () => {
    it("15 sources → ModulationConfigError", () => {
        const sources = Array.from({ length: 15 }, (_, i) => ({ id: `mod${i + 1}` }));
        expect(() => parseModulationMatrix({ sources, slots: [] })).toThrow(ModulationConfigError);
    });

    it("25 slots → ModulationConfigError", () => {
        const slots = Array.from({ length: 25 }, (_, i) => ({ id: `slot${i + 1}` }));
        expect(() => parseModulationMatrix({ sources: [], slots })).toThrow(ModulationConfigError);
    });
});

describe("ModulationMatrix — roundtrip and Device integration", () => {
    it("serialize → parse roundtrip preserves the matrix exactly", () => {
        const matrix = createDefaultMatrix();
        matrix.slots[0] = { ...matrix.slots[0], enabled: true, sourceId: "mod1", destControlId: "knob1", amount: 0.6 };
        matrix.sources[0] = { ...matrix.sources[0], waveform: "saw", rateHz: 4, phase: 0.25, enabled: true };

        const parsed = parseModulationMatrix(serializeModulationMatrix(matrix));
        expect(parsed).toEqual(matrix);
    });

    it("Device without a modulation field deserializes to defaults without throwing", () => {
        const device = Device.deserialize({
            id: "dev1",
            name: "legacy",
            schemaVersion: 1,
            controls: [],
            groups: [],
            presets: [],
        });
        expect(device.modulation).toEqual(createDefaultMatrix());
    });

    it("Device with a structurally invalid matrix falls back to defaults without throwing", () => {
        const device = Device.deserialize({
            id: "dev2",
            name: "corrupt",
            schemaVersion: 1,
            controls: [],
            groups: [],
            presets: [],
            modulation: {
                sources: Array.from({ length: 15 }, (_, i) => ({ id: `mod${i + 1}` })),
                slots: [],
            },
        });
        expect(device.modulation).toEqual(createDefaultMatrix());
    });

    it("Device serialize carries the matrix and stores a clone, not an alias", () => {
        const device = new Device("d");
        device.modulation.slots[0] = { ...device.modulation.slots[0], enabled: true, amount: 0.3 };
        const data = device.serialize();

        const restored = Device.deserialize(data);
        expect(restored.modulation).toEqual(device.modulation);

        restored.modulation.slots[0].amount = 0.9;
        expect(device.modulation.slots[0].amount).toBe(0.3);
    });
});

describe("ModulationMatrix — default fill (R1)", () => {
    it("partial payloads keep both arrays full via default fill", () => {
        const matrix = parseModulationMatrix({
            sources: [{ id: "mod1", rateHz: 5 }],
            slots: [{ id: "slot1", amount: 0.4 }],
        });
        expect(matrix.sources).toHaveLength(MAX_MOD_SOURCES);
        expect(matrix.slots).toHaveLength(MAX_MOD_SLOTS);
        expect(matrix.sources[0].rateHz).toBe(5);
        expect(matrix.sources[1]).toEqual(createDefaultMatrix().sources[1]);
        expect(matrix.slots[0].amount).toBe(0.4);
        expect(matrix.slots[1]).toEqual(createDefaultMatrix().slots[1]);
    });
});