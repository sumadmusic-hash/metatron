import { describe, it, expect } from "vitest";
import { chainUnionFromBindings, DEFAULT_MAX_DEPTH } from "../../src/nexus/ChainDiscovery";
import type { AudioConnection } from "../../src/nexus/ChainDiscovery";

function cable(id: string, from: string, to: string): AudioConnection {
    return {
        id,
        from: { entityId: from, socketField: "audioOutput", socketPath: "x.audioOutput" },
        to: { entityId: to, socketField: "audioInput", socketPath: "y.audioInput" },
    };
}

function set(ids: string[]): Set<string> {
    return new Set(ids.map((x) => x.toLowerCase()));
}

describe("chainUnionFromBindings", () => {
    it("Case A — full chain from a mid-chain binding", () => {
        const cables = [
            cable("c1", "Synth", "Delay"),
            cable("c2", "Delay", "Chorus"),
            cable("c3", "Chorus", "Mixer"),
        ];
        const r = chainUnionFromBindings(cables, ["Delay"]);
        expect(new Set(r.devices)).toEqual(set(["Synth", "Delay", "Chorus", "Mixer"]));
        expect(r.connections.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
        expect(new Set(r.rootCandidates)).toEqual(set(["Synth"]));
    });

    it("Case B — two independent chains, union without duplicates", () => {
        const cables = [
            cable("a1", "SynthA", "DelayA"),
            cable("a2", "DelayA", "MixerA"),
            cable("b1", "SynthB", "ChorusB"),
            cable("b2", "ChorusB", "MixerB"),
        ];
        const r = chainUnionFromBindings(cables, ["DelayA", "ChorusB"]);
        expect(new Set(r.devices)).toEqual(set(["SynthA", "DelayA", "MixerA", "SynthB", "ChorusB", "MixerB"]));
        expect(r.connections.map((c) => c.id)).toEqual(["a1", "a2", "b1", "b2"]);
        expect(new Set(r.rootCandidates)).toEqual(set(["SynthA", "SynthB"]));
    });

    it("Case C — multiple bindings in the same chain yield one copy", () => {
        const cables = [
            cable("c1", "Synth", "Delay"),
            cable("c2", "Delay", "Chorus"),
            cable("c3", "Chorus", "Mixer"),
        ];
        const r = chainUnionFromBindings(cables, ["Synth", "Delay"]);
        expect(new Set(r.devices)).toEqual(set(["Synth", "Delay", "Chorus", "Mixer"]));
        expect(r.connections.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
        expect(new Set(r.rootCandidates)).toEqual(set(["Synth"]));
    });

    it("Case D — shared mixer sink: never pulls sibling inputs through the sink", () => {
        const cables = [
            cable("a1", "SynthA", "Mixer"),
            cable("b1", "SynthB", "Mixer"),
            cable("r1", "Reverb", "Mixer"),
        ];
        const r = chainUnionFromBindings(cables, ["SynthA", "Reverb"]);
        expect(new Set(r.devices)).toEqual(set(["SynthA", "Reverb", "Mixer"]));
        expect(new Set(r.devices).has("synthb")).toBe(false);
        expect(r.connections.map((c) => c.id)).toEqual(["a1", "r1"]);
        expect(new Set(r.rootCandidates)).toEqual(set(["SynthA", "Reverb"]));
    });

    it("Case E — unconnected bound device forms a single-node chain", () => {
        const r = chainUnionFromBindings([], ["Device A"]);
        expect(r.devices).toEqual(["device a"]);
        expect(r.connections).toEqual([]);
        expect(r.rootCandidates).toEqual(["device a"]);
        expect(r.truncated).toBe(false);
        expect(r.maxDepth).toBe(DEFAULT_MAX_DEPTH);
    });

    it("branching — all outgoing branches are followed from the seed", () => {
        const cables = [
            cable("c1", "S", "E"),
            cable("c2", "S", "F"),
            cable("c3", "E", "M"),
            cable("c4", "F", "M"),
        ];
        const r = chainUnionFromBindings(cables, ["S"]);
        expect(new Set(r.devices)).toEqual(set(["S", "E", "F", "M"]));
        expect(r.connections.map((c) => c.id)).toEqual(["c1", "c2", "c3", "c4"]);
        expect(new Set(r.rootCandidates)).toEqual(set(["S"]));
    });

    it("branching — a mid-branch seed does not absorb sibling branches via the shared sink", () => {
        const cables = [
            cable("c1", "S", "E"),
            cable("c2", "S", "F"),
            cable("c3", "E", "M"),
            cable("c4", "F", "M"),
        ];
        const r = chainUnionFromBindings(cables, ["E"]);
        expect(new Set(r.devices)).toEqual(set(["S", "E", "M"]));
        expect(new Set(r.devices).has("f")).toBe(false);
        expect(r.connections.map((c) => c.id)).toEqual(["c1", "c3"]);
        expect(new Set(r.rootCandidates)).toEqual(set(["S"]));
    });

    it("merging — a bound sink-instrument pulls every upstream feeder", () => {
        const cables = [
            cable("c1", "A", "M"),
            cable("c2", "B", "M"),
        ];
        const r = chainUnionFromBindings(cables, ["M"]);
        expect(new Set(r.devices)).toEqual(set(["A", "B", "M"]));
        expect(r.connections.map((c) => c.id)).toEqual(["c1", "c2"]);
        expect(new Set(r.rootCandidates)).toEqual(set(["A", "B"]));
    });

    it("duplicate bound ids are deduplicated", () => {
        const cables = [
            cable("c1", "Synth", "Delay"),
            cable("c2", "Delay", "Chorus"),
            cable("c3", "Chorus", "Mixer"),
        ];
        const r = chainUnionFromBindings(cables, ["Delay", "Delay", "delay"]);
        expect(new Set(r.devices)).toEqual(set(["Synth", "Delay", "Chorus", "Mixer"]));
        expect(r.connections.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    });

    it("cycles terminate safely and do not duplicate members", () => {
        const cables = [
            cable("c1", "A", "B"),
            cable("c2", "B", "A"),
        ];
        const r = chainUnionFromBindings(cables, ["A"]);
        expect(new Set(r.devices)).toEqual(set(["A", "B"]));
        expect(r.connections.map((c) => c.id)).toEqual(["c1", "c2"]);
        expect(r.rootCandidates).toEqual([]);
    });

    it("a self loop terminates and keeps the loop cable", () => {
        const r = chainUnionFromBindings([cable("c1", "A", "A")], ["A"]);
        expect(r.devices).toEqual(["a"]);
        expect(r.connections.map((c) => c.id)).toEqual(["c1"]);
        expect(r.rootCandidates).toEqual([]);
    });

    it("depth limit stops expansion and reports truncation", () => {
        const cables = [
            cable("c1", "S", "E1"),
            cable("c2", "E1", "E2"),
            cable("c3", "E2", "E3"),
            cable("c4", "E3", "M"),
        ];
        const r = chainUnionFromBindings(cables, ["E2"], 1);
        expect(new Set(r.devices)).toEqual(set(["E1", "E2", "E3"]));
        expect(new Set(r.devices).has("s")).toBe(false);
        expect(new Set(r.devices).has("m")).toBe(false);
        expect(r.truncated).toBe(true);
        expect(r.connections.map((c) => c.id)).toEqual(["c2", "c3"]);
        expect(new Set(r.rootCandidates)).toEqual(set(["E1"]));

        const full = chainUnionFromBindings(cables, ["E2"]);
        expect(new Set(full.devices)).toEqual(set(["S", "E1", "E2", "E3", "M"]));
        expect(full.truncated).toBe(false);
    });

    it("empty binding list yields an empty selection", () => {
        const r = chainUnionFromBindings([cable("c1", "S", "D")], []);
        expect(r.devices).toEqual([]);
        expect(r.connections).toEqual([]);
        expect(r.rootCandidates).toEqual([]);
        expect(r.truncated).toBe(false);
    });

    it("duplicate cables are collected once and both-endpoint filtering applies", () => {
        const cables = [
            cable("c1", "S", "D"),
            cable("c1", "S", "D"),
            cable("c2", "D", "M"),
        ];
        const r = chainUnionFromBindings(cables, ["D"]);
        expect(new Set(r.devices)).toEqual(set(["S", "D", "M"]));
        expect(r.connections.map((c) => c.id)).toEqual(["c1", "c2"]);
        expect(new Set(r.rootCandidates)).toEqual(set(["S"]));
    });

    it("normalizes entity ids on bound ids and output", () => {
        const cables = [
            cable("c1", "SynTh", "DELAY"),
            cable("c2", "Delay", "Chorus-2"),
        ];
        const r = chainUnionFromBindings(cables, ["dElaY"]);
        expect(r.devices).toEqual(["delay", "synth", "chorus-2"]);
        expect(r.connections.map((c) => c.id)).toEqual(["c1", "c2"]);
        expect(r.rootCandidates).toEqual(["synth"]);
    });

    it("is pure: inputs are not mutated and repeated calls are identical", () => {
        const cables = [
            cable("c1", "Synth", "Delay"),
            cable("c2", "Delay", "Chorus"),
            cable("c3", "Chorus", "Mixer"),
        ];
        const cableRefs = [...cables];
        const bound = ["Delay", "Synth"];

        const first = chainUnionFromBindings(cables, bound);
        const second = chainUnionFromBindings(cables, bound);

        expect(cables).toStrictEqual(cableRefs);
        expect(cables[0].from.entityId).toBe("Synth");
        expect(bound).toEqual(["Delay", "Synth"]);
        expect(first).toEqual(second);
        expect(first.devices).toEqual(second.devices);
        expect(first.connections.map((c) => c.id)).toEqual(second.connections.map((c) => c.id));
        expect(first.rootCandidates).toEqual(second.rootCandidates);
    });
});