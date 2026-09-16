import { describe, it, expect } from "vitest";
import {
    evaluateDestinations,
    evaluateSource,
    hash01,
    safeBpm,
} from "../../../src/core/modulation/ModulationEngine";
import { createDefaultMatrix } from "../../../src/core/modulation/ModulationTypes";
import type { ModSource } from "../../../src/core/modulation/ModulationTypes";

function source(partial: Partial<ModSource> & { id: string }): ModSource {
    return {
        id: partial.id,
        type: "lfo",
        waveform: "sine",
        rateHz: 1,
        bpmSync: false,
        bpmOfSync: 120,
        noteDivision: 4,
        phase: 0,
        drift: 0.5,
        sourceId: "",
        smoothMs: 200,
        ...partial,
    };
}

const alwaysActive = (): boolean => true;

describe("ModulationEngine — hash01/safeBpm", () => {
    it("hash01 is deterministic and unit-range", () => {
        const a = hash01("mod1:0");
        const b = hash01("mod1:0");
        expect(a).toBe(b);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThan(1);
        expect(hash01("mod1:1")).not.toBe(a);
    });

    it("safeBpm clamps into the 30..1000 playback range", () => {
        expect(safeBpm(0)).toBe(30);
        expect(safeBpm(2000)).toBe(1000);
        expect(safeBpm(120)).toBe(120);
    });
});

describe("ModulationEngine — LFO waveforms", () => {
    it("sine peaks +1 at phase 0.25 and −1 at phase 0.75 (1 Hz)", () => {
        const s = source({ id: "sine", waveform: "sine", rateHz: 1 });
        expect(evaluateSource(s, 0.25, 120, () => 0, alwaysActive)).toBe(1);
        expect(evaluateSource(s, 0.75, 120, () => 0, alwaysActive)).toBe(-1);
    });

    it("triangle starts at its peak (+1 at phase 0, −1 at phase 0.5)", () => {
        const s = source({ id: "tri", waveform: "triangle", rateHz: 1 });
        expect(evaluateSource(s, 0, 120, () => 0, alwaysActive)).toBe(1);
        expect(evaluateSource(s, 0.5, 120, () => 0, alwaysActive)).toBe(-1);
    });

    it("saw ramps linearly (+0.5 at phase 0.75)", () => {
        const s = source({ id: "saw", waveform: "saw", rateHz: 1 });
        expect(evaluateSource(s, 0.75, 120, () => 0, alwaysActive)).toBe(0.5);
    });

    it("square is +1 before half phase, −1 after", () => {
        const s = source({ id: "sq", waveform: "square", rateHz: 1 });
        expect(evaluateSource(s, 0.49, 120, () => 0, alwaysActive)).toBe(1);
        expect(evaluateSource(s, 0.51, 120, () => 0, alwaysActive)).toBe(-1);
    });
});

describe("ModulationEngine — tempo sync", () => {
    it("bpmSync noteDivision 4 at 120 BPM yields a 0.5 s period", () => {
        const s = source({ id: "sync", bpmSync: true, bpmOfSync: 120, noteDivision: 4, waveform: "sine" });
        // Quarter of the 0.5 s period lands exactly on the sine peak.
        expect(evaluateSource(s, 0.125, 120, () => 0, alwaysActive)).toBe(1);
    });

    it("bpmSync noteDivision 16 at 120 BPM yields a 0.125 s period", () => {
        const s = source({ id: "sync16", bpmSync: true, bpmOfSync: 120, noteDivision: 16, waveform: "sine" });
        expect(evaluateSource(s, 0.03125, 120, () => 0, alwaysActive)).toBe(1);
        // A full period later the waveform is back at its zero crossing.
        expect(evaluateSource(s, 0.125, 120, () => 0, alwaysActive)).toBe(0);
    });

    it("tempo-synced source WITHOUT bpmOfSync follows the transport BPM (B5)", () => {
        const s = source({ id: "follow", bpmSync: true, bpmOfSync: undefined, noteDivision: 4, waveform: "sine" });
        expect(evaluateSource(s, 0.25, 120, () => 0, alwaysActive)).not.toBe(
            evaluateSource(s, 0.25, 60, () => 0, alwaysActive),
        );
    });

    it("tempo-synced source WITH a fixed bpmOfSync ignores the transport BPM (B5)", () => {
        const s = source({ id: "fixed", bpmSync: true, bpmOfSync: 120, noteDivision: 4, waveform: "sine" });
        expect(evaluateSource(s, 0.25, 60, () => 0, alwaysActive)).toBe(
            evaluateSource(s, 0.25, 120, () => 0, alwaysActive),
        );
    });
});

describe("ModulationEngine — sampleHold / smoothRandom", () => {
    it("sampleHold holds one deterministic value per period and differs across seeds", () => {
        const a = source({ id: "shA", waveform: "sampleHold", sourceId: "seedA", rateHz: 1 });
        const b = source({ id: "shB", waveform: "sampleHold", sourceId: "seedB", rateHz: 1 });
        expect(evaluateSource(a, 1.0, 120, () => 0, alwaysActive)).toBe(evaluateSource(a, 1.9, 120, () => 0, alwaysActive));
        expect(evaluateSource(a, 1.0, 120, () => 0, alwaysActive)).not.toBe(evaluateSource(a, 2.0, 120, () => 0, alwaysActive));
        expect(evaluateSource(a, 1.0, 120, () => 0, alwaysActive)).not.toBe(evaluateSource(b, 1.0, 120, () => 0, alwaysActive));
    });

    it("smoothRandom interpolates deterministically and differs across seeds", () => {
        const a = source({ id: "smA", waveform: "smoothRandom", sourceId: "seedC", rateHz: 1 });
        const b = source({ id: "smB", waveform: "smoothRandom", sourceId: "seedD", rateHz: 1 });
        // Determinism: the same instant yields the same output.
        expect(evaluateSource(a, 0.25, 120, () => 0, alwaysActive)).toBe(evaluateSource(a, 0.25, 120, () => 0, alwaysActive));
        // Linear interpolation: half-way through the period differs from the hold point.
        expect(evaluateSource(a, 0.5, 120, () => 0, alwaysActive)).not.toBe(evaluateSource(a, 0.0, 120, () => 0, alwaysActive));
        expect(evaluateSource(a, 0.25, 120, () => 0, alwaysActive)).not.toBe(evaluateSource(b, 0.25, 120, () => 0, alwaysActive));
    });
});

describe("ModulationEngine — evaluateDestinations", () => {
    function multiSlotMatrix(amounts: number[]): ReturnType<typeof createDefaultMatrix> {
        const matrix = createDefaultMatrix();
        matrix.sources[0].waveform = "square";
        matrix.sources[1].waveform = "square";
        matrix.slots[0] = { ...matrix.slots[0], enabled: true, sourceId: "mod1", destControlId: "cut", amount: amounts[0] };
        matrix.slots[1] = { ...matrix.slots[1], enabled: true, sourceId: "mod2", destControlId: "cut", amount: amounts[1] };
        return matrix;
    }

    it("accumulates multiple slots and clamps at the top (0.2 base → 1.0)", () => {
        // Two +0.5 slots on a +1 source: 0.2 + 0.5 + 0.5 would exceed 1 → clamped.
        const matrix = multiSlotMatrix([0.5, 0.5]);
        const result = evaluateDestinations(matrix, { cut: 0.2 }, 0, 120, () => 0, alwaysActive);
        expect(result.get("cut")).toBe(1);
    });

    it("clamps at the bottom (0.2 base with two −1 slots → 0.0)", () => {
        const matrix = multiSlotMatrix([-1, -1]);
        const result = evaluateDestinations(matrix, { cut: 0.2 }, 0, 120, () => 0, alwaysActive);
        expect(result.get("cut")).toBe(0);
    });

    it("skips disabled slots, dangling sourceIds, and missing destinations", () => {
        const matrix = createDefaultMatrix();
        matrix.sources[0].waveform = "square";
        matrix.slots[0] = { ...matrix.slots[0], enabled: true, sourceId: "mod1", destControlId: "cut", amount: 0.5 };
        matrix.slots[1] = { ...matrix.slots[1], enabled: true, sourceId: "ghost", destControlId: "other", amount: 0.5 };
        matrix.slots[2] = { ...matrix.slots[2], enabled: true, sourceId: "mod1", destControlId: "missing", amount: 0.5 };
        matrix.slots[3] = { ...matrix.slots[3], enabled: false, sourceId: "mod1", destControlId: "cut", amount: 0.5 };
        const result = evaluateDestinations(matrix, { cut: 0.2, other: 0.5 }, 0, 120, () => 0, alwaysActive);
        expect(result.has("cut")).toBe(true);
        expect(result.has("other")).toBe(false); // dangling sourceId
        expect(result.has("missing")).toBe(false); // not in baseValues
        expect(result.get("cut")).toBe(0.7); // disabled slot3 contributed nothing
    });
});

describe("ModulationEngine — macro sources (FIX 7)", () => {
    const macro = source({ id: "m", type: "macro", sourceId: "controller" });

    it("a macro source whose control is archived/deleted yields 0", () => {
        expect(evaluateSource(macro, 0, 120, () => 1, () => false)).toBe(0);
    });

    it("a macro source without a bound control yields 0 (FIX 7)", () => {
        const orphan = source({ id: "orphan", type: "macro" });
        expect(evaluateSource(orphan, 0, 120, () => 1, alwaysActive)).toBe(0);
    });

    it("an active macro source maps macroValue [0,1] into a bipolar level", () => {
        expect(evaluateSource(macro, 0, 120, () => 1, alwaysActive)).toBe(1);
        expect(evaluateSource(macro, 0, 120, () => 0, alwaysActive)).toBe(-1);
    });

    it("an inactive macro leaves the destination at its base value", () => {
        const matrix = createDefaultMatrix();
        matrix.sources[0] = macro;
        matrix.slots[0] = { ...matrix.slots[0], enabled: true, sourceId: "m", destControlId: "cut", amount: 0.8 };
        const result = evaluateDestinations(matrix, { cut: 0.2 }, 0, 120, () => 1, () => false);
        expect(result.get("cut")).toBe(0.2);
    });

    it("two macro sources resolve their own control values via the callback (B6)", () => {
        const matrix = createDefaultMatrix();
        matrix.sources[0] = { ...matrix.sources[0], type: "macro", sourceId: "ctlA" };
        matrix.sources[1] = { ...matrix.sources[1], type: "macro", sourceId: "ctlB" };
        matrix.slots[0] = { ...matrix.slots[0], enabled: true, sourceId: "mod1", destControlId: "x", amount: 1 };
        matrix.slots[1] = { ...matrix.slots[1], enabled: true, sourceId: "mod2", destControlId: "y", amount: 1 };
        const macroValue = (id: string): number => (id === "ctlA" ? 1 : 0);
        const result = evaluateDestinations(matrix, { x: 0, y: 0 }, 0, 120, macroValue, alwaysActive);
        expect(result.get("x")).toBe(1); // ctlA=1 → +1 * amount 1 on base 0
        expect(result.get("y")).toBe(0); // ctlB=0 → −1 * amount 1 → clamp01 base − 1 = 0
    });
});