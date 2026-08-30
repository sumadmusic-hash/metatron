import { describe, it, expect } from "vitest";
import {
    DEFAULT_MAX_DEPTH,
    chainToString,
    describeParameter,
    extractAudioConnections,
    isAutomatable,
    normalizeCable,
    normalizeEntity,
    normalizeEntityId,
    traverseChain,
} from "./discovery";
import type { AudioConnection } from "./types";

// ———————————————————————————————————————————————————————————————————————
// entity normalization (§8)
// ———————————————————————————————————————————————————————————————————————

describe("entity normalization", () => {
    it("lower-cases the entity id", () => {
        expect(normalizeEntityId("ABC-123-DEF")).toBe("abc-123-def");
    });

    it("keeps display name and entity type", () => {
        const node = normalizeEntity({ id: "ABC", entityType: "pulverisateur", displayName: "MY SYNTH" });
        expect(node).toEqual({ id: "abc", entityType: "pulverisateur", displayName: "MY SYNTH" });
    });

    it("falls back to entityType when displayName is empty", () => {
        const node = normalizeEntity({ id: "abc", entityType: "autofilter", displayName: "" });
        expect(node?.displayName).toBe("autofilter");
    });

    it("returns undefined for an empty entity", () => {
        expect(normalizeEntity({ id: "", entityType: "" })).toBeUndefined();
    });
});

// ———————————————————————————————————————————————————————————————————————
// connection extraction (§11)
// ———————————————————————————————————————————————————————————————————————

describe("connection extraction", () => {
    it("extracts a simple cable pair", () => {
        const conns = extractAudioConnections([
            {
                id: "cable-1",
                fromEntityId: "SYNTH",
                toEntityId: "FX1",
                fromSocketPath: "/pulverisateur/audioOutput",
                toSocketPath: "/autofilter/audioInput",
            },
        ]);
        expect(conns).toHaveLength(1);
        expect(conns[0].from.entityId).toBe("synth");
        expect(conns[0].to.entityId).toBe("fx1");
        expect(conns[0].from.socketField).toBe("audioOutput");
        expect(conns[0].to.socketField).toBe("audioInput");
    });

    it("drops cables without a from or to side", () => {
        expect(normalizeCable({ id: "x", fromEntityId: "", toEntityId: "y" })).toBeUndefined();
        expect(normalizeCable({ id: "x", fromEntityId: "y", toEntityId: "" })).toBeUndefined();
        expect(normalizeCable({ id: "", fromEntityId: "a", toEntityId: "b" })).toBeUndefined();
    });
});

// ———————————————————————————————————————————————————————————————————————
// graph traversal (§12)
// ———————————————————————————————————————————————————————————————————————

function cable(id: string, from: string, to: string): AudioConnection {
    return {
        id,
        from: { entityId: from, socketField: "audioOutput", socketPath: "x.audioOutput" },
        to: { entityId: to, socketField: "audioInput", socketPath: "y.audioInput" },
    };
}

describe("graph traversal", () => {
    it("finds a simple chain", () => {
        const result = traverseChain(
            [cable("c1", "synth", "fx1"), cable("c2", "fx1", "fx2"), cable("c3", "fx2", "fx3")],
            "synth",
            { nameOf: (id) => id.toUpperCase() },
        );
        expect(result.order).toEqual(["synth", "fx1", "fx2", "fx3"]);
        expect(result.chain.map((m) => m.node.displayName)).toEqual(["SYNTH", "FX1", "FX2", "FX3"]);
        expect(result.usedConnections.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    });

    it("handles multiple entities and stops at terminal branches", () => {
        // synth -> fx1, fx2 (fan-out); fx1 -> fx2 (redundant edge)
        const result = traverseChain(
            [cable("c1", "synth", "fx1"), cable("c2", "synth", "fx2"), cable("c3", "fx1", "fx2")],
            "synth",
        );
        expect(result.order).toContain("synth");
        expect(result.order).toContain("fx1");
        expect(result.order).toContain("fx2");
        expect(result.visitedCount).toBe(3);
    });

    it("duplicate protection: same entity never appears twice", () => {
        const result = traverseChain(
            [cable("c1", "synth", "fx1"), cable("c2", "fx1", "fx2"), cable("c3", "fx2", "fx1")],
            "synth",
        );
        const counts = result.order.reduce<Record<string, number>>((acc, id) => {
            acc[id] = (acc[id] ?? 0) + 1;
            return acc;
        }, {});
        for (const [key, value] of Object.entries(counts)) expect(value, `${key} duplicated`).toBe(1);
    });

    it("cycle protection: a loop does not loop forever", () => {
        const result = traverseChain(
            [cable("c1", "a", "b"), cable("c2", "b", "c"), cable("c3", "c", "a")],
            "a",
        );
        expect(result.order).toEqual(["a", "b", "c"]);
        expect(result.visitedCount).toBe(3);
    });

    it("max depth is honored and truncation is reported", () => {
        const chain = [cable("c1", "a", "b"), cable("c2", "b", "c"), cable("c3", "c", "d")];
        const result = traverseChain(chain, "a", { maxDepth: 2 });
        expect(result.order.length).toBeLessThanOrEqual(3);
        expect(result.truncated).toBe(true);
        expect(result.maxDepth).toBe(2);
    });

    it("default max depth is 32", () => {
        expect(DEFAULT_MAX_DEPTH).toBe(32);
    });

    it("root entity not in the graph still yields a single-node chain", () => {
        const result = traverseChain([cable("c1", "a", "b")], "missing-root");
        expect(result.order).toEqual(["missing-root"]);
    });

    it("is read-only: does not mutate its input", () => {
        const input = [cable("c1", "synth", "fx1")];
        const snapshot = JSON.stringify(input);
        traverseChain(input, "synth");
        expect(JSON.stringify(input)).toBe(snapshot);
    });
});

// ———————————————————————————————————————————————————————————————————————
// parameter description (§13 — schema-driven, no curve heuristics)
// ———————————————————————————————————————————————————————————————————————

describe("parameter description", () => {
    it("maps real schema details into ParameterInfo", () => {
        const info = describeParameter(
            "filter.cutoff_frequency_hz",
            15500,
            {
                targetTypes: ["AutomatableParameter"],
                immutable: false,
                primitive: { type: "number", scalarType: "FLOAT", default: 15500, range: { min: 18, max: 15500 } },
            },
        );
        expect(info.range).toEqual({ min: 18, max: 15500 });
        expect(info.scalarType).toBe("FLOAT");
        expect(info.mutable).toBe(true);
        expect(info.provenance).toBe("PROVEN BY REAL NEXUS");
    });

    it("detects automatable target types", () => {
        expect(isAutomatable(["AutomatableParameter"])).toBe(true);
        expect(isAutomatable(["AudioInput"])).toBe(false);
        expect(isAutomatable(undefined)).toBe(false);
    });
});

// ———————————————————————————————————————————————————————————————————————
// chain formatting
// ———————————————————————————————————————————————————————————————————————

describe("chain formatting", () => {
    it("prints a numbered chain", () => {
        const result = traverseChain([cable("c1", "synth", "fx1")], "synth", { nameOf: (id) => id });
        expect(chainToString(result.chain)).toBe("1. synth\n2. fx1");
    });
});