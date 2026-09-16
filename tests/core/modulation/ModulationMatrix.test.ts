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
import { evaluateDestinations } from "../../../src/core/modulation/ModulationEngine";
import { Device } from "../../../src/core/model/Device";

describe("ModulationMatrix — defaults (FIX 4 fallback)", () => {
    it("parse(undefined) → default matrix with 10 sources and 20 slots, all slots disabled", () => {
        const matrix = parseModulationMatrix(undefined);
        expect(matrix.sources).toHaveLength(MAX_MOD_SOURCES);
        expect(matrix.slots).toHaveLength(MAX_MOD_SLOTS);
        for (const s of matrix.sources) {
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

    it("parse always yields schema version 1, even for version-less payloads (B7)", () => {
        expect(parseModulationMatrix(undefined).version).toBe(1);
        expect(
            parseModulationMatrix({ sources: [{ id: "mod1" }], slots: [{ id: "slot1" }] }).version,
        ).toBe(1);
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
        matrix.sources[0] = { ...matrix.sources[0], waveform: "saw", rateHz: 4, phase: 0.25 };

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

describe("ModulationMatrix — duplicate ids (B8)", () => {
    it("parse deterministically dedups duplicate source and slot ids", () => {
        const payload = {
            sources: [{ id: "mod3" }, { id: "mod3" }],
            slots: [{ id: "slot5" }, { id: "slot5" }],
        };
        const parsed = parseModulationMatrix(payload);
        const parsedAgain = parseModulationMatrix(payload);
        for (const cfg of [parsed, parsedAgain]) {
            const srcIds = cfg.sources.map((s) => s.id);
            const slotIds = cfg.slots.map((s) => s.id);
            expect(new Set(srcIds).size).toBe(srcIds.length);
            expect(new Set(slotIds).size).toBe(slotIds.length);
            // First occurrence keeps "mod3"/"slot5"; the duplicate is renamed deterministically.
            expect(cfg.sources[0].id).toBe("mod3");
            expect(cfg.sources[1].id).toBe("mod2");
            expect(cfg.slots[0].id).toBe("slot5");
            expect(cfg.slots[1].id).toBe("slot2");
        }
        // No RNG: two parses produce byte-identical id assignments.
        expect(parsed.sources.map((s) => s.id)).toEqual(parsedAgain.sources.map((s) => s.id));
    });

    it("a slot pointing at an id freed by the rename is skipped by evaluateDestinations", () => {
        // The second "mod3" collides and is renamed; the default "mod2" that it
        // overwrote is then held by NO source, so a slot referencing it dangles.
        const parsed = parseModulationMatrix({
            sources: [
                { id: "srcA", enabled: true, waveform: "square", rateHz: 1 },
                { id: "mod3", enabled: true, waveform: "square", rateHz: 1 },
                { id: "mod3" },
            ],
            slots: [
                { id: "slot5", enabled: true, sourceId: "mod3", destControlId: "x", amount: 1 },
                { id: "slot5", enabled: true, sourceId: "mod2", destControlId: "y", amount: 1 },
            ],
        });
        expect(new Set(parsed.sources.map((s) => s.id)).size).toBe(parsed.sources.length);
        const result = evaluateDestinations(parsed, { x: 0, y: 0 }, 0, 120, () => 0, () => true);
        // "mod3" deterministically binds the retained duplicate source.
        expect(result.get("x")).toBe(1);
        // "mod2" no longer exists as a source id → destination absent from the map.
        expect(result.has("y")).toBe(false);
    });

    it("Source A + duplicate Source B: A keeps the id, the slot stays on A, B is never chosen", () => {
        // Spec scenario — duplicated source ids are not reconstructible, so:
        // the FIRST source with the id keeps it, later duplicates are renamed,
        // and existing slot references stay on the FIRST source. No wholesale
        // rerouting of slots onto the renamed second source.
        const parsed = parseModulationMatrix({
            sources: [
                { id: "mod1", enabled: true, waveform: "square", rateHz: 1 },
                { id: "mod1", enabled: true, waveform: "saw", rateHz: 7 },
            ],
            slots: [
                { id: "slot1", enabled: true, sourceId: "mod1", destControlId: "x", amount: 1 },
            ],
        });

        const srcIds = parsed.sources.map((s) => s.id);
        expect(new Set(srcIds).size).toBe(srcIds.length);
        // First source keeps the original id.
        expect(parsed.sources[0].id).toBe("mod1");
        // The second duplicate is renamed to a fresh unique id.
        expect(parsed.sources[1].id).not.toBe("mod1");

        const slotAsFirst = parsed.slots[0];
        // The existing slot reference still points at "mod1" — the first source.
        expect(slotAsFirst.sourceId).toBe("mod1");

        // A slot bound to the renamed second source would keep working, but it
        // is NOT silently re-pointed at the first source.
        const secondId = parsed.sources[1].id;
        const renamed = parseModulationMatrix({
            sources: [
                { id: "mod1", enabled: true, waveform: "square", rateHz: 1 },
                { id: "mod1", enabled: true, waveform: "saw", rateHz: 7 },
            ],
            slots: [
                { id: "slot2", enabled: true, sourceId: secondId, destControlId: "y", amount: 1 },
            ],
        });

        const result = evaluateDestinations(
            parsed,
            { x: 0, y: 0 },
            0,
            120,
            () => 0,
            () => true,
        );
        // The slot on "mod1" binds the retained FIRST source (square → phase 0 → +1).
        expect(result.get("x")).toBe(1);
        const secondResult = evaluateDestinations(
            renamed,
            { y: 0 },
            0,
            120,
            () => 0,
            () => true,
        );
        // Re-referencing the renamed source still binds the SECOND source (saw
        // → phase 0 → −1, clamped to 0). If a slot were silently rebent onto the
        // FIRST source instead, it would read +1 — so 0 proves the binding.
        expect(secondResult.get("y")).toBe(0);
    });
});