import { describe, it, expect } from "vitest";
import { buildUnionAudit } from "./audit";
import type { AudioConnection } from "../../src/nexus/ChainDiscovery";
import type { ChainSnapshot } from "../../src/nexus/ChainTypes";

function cable(id: string, from: string, to: string): AudioConnection {
    return {
        id,
        from: { entityId: from, socketField: "audioOutput", socketPath: "x.audioOutput" },
        to: { entityId: to, socketField: "audioInput", socketPath: "y.audioInput" },
    };
}

function entity(id: string, entityType: string, displayName?: string) {
    return { id, entityType, displayName };
}

function snapshotOf(idMap: Record<string, string>, rootId: string): ChainSnapshot {
    const devices = Object.entries(idMap).map(([sourceEntityId, entityType]) => ({
        sourceEntityId,
        entityType,
        displayName: sourceEntityId,
        fields: [],
    }));
    return { version: 1, devices, connections: [], rootCandidates: [rootId] };
}

const set = (ids: string[]) => new Set<string>(ids.map((x) => x.toLowerCase()));

describe("buildUnionAudit (pure audit layer)", () => {
    it("Case A — mid-chain binding: NEW union and OLD root snapshot agree", () => {
        const cables = [cable("c1", "Synth", "Delay"), cable("c2", "Delay", "Chorus"), cable("c3", "Chorus", "Mixer")];
        const oldSnapshot = snapshotOf(
            { synth: "autofilter", delay: "stompboxDelay", chorus: "stompboxChorus", mixer: "mixerChannel" },
            "synth",
        );
        const audit = buildUnionAudit({
            cables,
            boundEntityIds: ["Delay"],
            entities: [
                entity("Synth", "autofilter"),
                entity("Delay", "stompboxDelay"),
                entity("Chorus", "stompboxChorus"),
                entity("Mixer", "mixerChannel"),
            ],
            audioDeviceIds: ["Synth", "Delay", "Chorus", "Mixer"],
            oldRootId: "Synth",
            oldSnapshot,
        });

        expect(audit.normalizedBound).toEqual(["delay"]);
        expect(new Set(audit.unionDeviceIds)).toEqual(set(["Synth", "Delay", "Chorus", "Mixer"]));
        expect(audit.unionConnections).toBe(3);
        expect(new Set(audit.unionRootCandidates)).toEqual(set(["Synth"]));
        expect(new Set(audit.boundInsideUnion)).toEqual(set(["Delay"]));
        expect(audit.boundOutsideUnion).toEqual([]);
        expect(audit.boundOmittedByOld).toEqual([]);
        expect(new Set(audit.both)).toEqual(set(["Synth", "Delay", "Chorus", "Mixer"]));
        expect(audit.onlyOld).toEqual([]);
        expect(audit.onlyNew).toEqual([]);
        expect(audit.devices["delay"]).toMatchObject({ hasAudioSocket: true, hasInputSocket: true, hasOutputSocket: true });
        expect(audit.devices["synth"]).toMatchObject({ hasAudioSocket: true, hasInputSocket: false, hasOutputSocket: true });
        expect(audit.devices["mixer"]).toMatchObject({ hasAudioSocket: true, hasInputSocket: true, hasOutputSocket: false });
    });

    it("Multi-chain — bound device out of the OLD snapshot is captured by NEW and reported as omitted-by-OLD", () => {
        const cables = [
            cable("a1", "SynthA", "DelayA"),
            cable("a2", "DelayA", "MixerA"),
            cable("b1", "SynthB", "ChorusB"),
            cable("b2", "ChorusB", "MixerB"),
        ];
        const oldSnapshot = snapshotOf({ synthA: "autofilter", delayA: "stompboxDelay", mixerA: "mixerChannel" }, "synthA");
        const audit = buildUnionAudit({
            cables,
            boundEntityIds: ["DelayA", "ChorusB"],
            entities: [
                entity("SynthA", "autofilter"),
                entity("DelayA", "stompboxDelay"),
                entity("MixerA", "mixerChannel"),
                entity("SynthB", "pulverisateur"),
                entity("ChorusB", "stompboxChorus"),
                entity("MixerB", "mixerChannel"),
            ],
            audioDeviceIds: ["SynthA", "DelayA", "MixerA", "SynthB", "ChorusB", "MixerB"],
            oldRootId: "SynthA",
            oldSnapshot,
        });

        expect(new Set(audit.unionDeviceIds)).toEqual(set(["SynthA", "DelayA", "MixerA", "SynthB", "ChorusB", "MixerB"]));
        expect(new Set(audit.boundInsideUnion)).toEqual(set(["DelayA", "ChorusB"]));
        expect(audit.boundOutsideUnion).toEqual([]);
        expect(new Set(audit.boundOmittedByOld)).toEqual(set(["ChorusB"]));
        expect(new Set(audit.both)).toEqual(set(["SynthA", "DelayA", "MixerA"]));
        expect(audit.onlyOld).toEqual([]);
        expect(new Set(audit.onlyNew)).toEqual(set(["SynthB", "ChorusB", "MixerB"]));
    });

    it("Case D — shared mixer: NEW excludes a sibling input feeding the same sink", () => {
        const cables = [
            cable("a1", "SynthA", "Mixer"),
            cable("b1", "SynthB", "Mixer"),
            cable("r1", "Reverb", "Mixer"),
        ];
        const oldSnapshot = snapshotOf({ synthA: "pulsar", mixer: "mixerChannel" }, "synthA");
        const audit = buildUnionAudit({
            cables,
            boundEntityIds: ["SynthA", "Reverb"],
            entities: [entity("SynthA", "pulsar"), entity("SynthB", "pulsar"), entity("Reverb", "space"), entity("Mixer", "mixerChannel")],
            audioDeviceIds: ["SynthA", "SynthB", "Reverb", "Mixer"],
            oldRootId: "SynthA",
            oldSnapshot,
        });

        expect(new Set(audit.unionDeviceIds)).toEqual(set(["SynthA", "Reverb", "Mixer"]));
        expect(audit.devices["synthb"]).toBeUndefined();
        expect(audit.unionConnections).toBe(2);
    });

    it("Case E — unconnected bound device is captured by NEW, OLD falls back to the same device", () => {
        const oldSnapshot = snapshotOf({ deviceA: "audioDevice" }, "deviceA");
        const audit = buildUnionAudit({
            cables: [],
            boundEntityIds: ["Device A"],
            entities: [entity("Device A", "audioDevice", "A")],
            audioDeviceIds: ["Device A"],
            oldRootId: "Device A",
            oldSnapshot,
        });
        expect(audit.unionDeviceIds).toEqual(["device a"]);
        expect(audit.unionConnections).toBe(0);
        expect(new Set(audit.unionRootCandidates)).toEqual(set(["Device A"]));
        expect(audit.boundOutsideUnion).toEqual([]);
        expect(audit.old.rootId).toBe("device a");
    });

    it("keeps raw bound ids but normalizes for the union", () => {
        const cables = [cable("c1", "S", "D")];
        const oldSnapshot = snapshotOf({ s: "pulsar", d: "stompboxDelay" }, "s");
        const audit = buildUnionAudit({
            cables,
            boundEntityIds: ["D", "d", "D"],
            entities: [entity("S", "pulsar"), entity("D", "stompboxDelay")],
            audioDeviceIds: ["S", "D"],
            oldRootId: "S",
            oldSnapshot,
        });
        expect(audit.boundIds).toEqual(["D", "d", "D"]);
        expect(new Set(audit.unionDeviceIds)).toEqual(set(["S", "D"]));
    });
});