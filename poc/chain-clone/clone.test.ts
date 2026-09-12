/**
 * CHAIN CLONE POC — pure unit tests (§15).
 *
 * These test every planning/verification decision WITHOUT the real SDK, using
 * fixtures. The real-SDK offline clone is covered in `clone.offline.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { normalizeEntityId } from "../chain-discovery/discovery";
import type { ChainSnapshot, ConnectionSnapshot, DeviceSnapshot, FieldSnapshot } from "./types";
import { serializeSnapshot, parseSnapshot, snapshotDeviceById } from "./snapshot";
import {
    idMapUsesNoSourceIds,
    planConnections,
    planDevices,
    planDeviceLayout,
    planParameterField,
    socketSegmentsFromPath,
    translateConnection,
    verdictFromCounts,
    DEVICE_SPACING_X,
    CHAIN_SPACING_Y,
    PLACEMENT_ORIGIN_X,
    PLACEMENT_ORIGIN_Y,
} from "./planning";
import type { ResolveTargetSocket } from "./planning";
import { compareSnapshotWithTarget, valuesEqualFloat32, valueInRange, edgeKey } from "./verify";
import { buildCloneReport, resolveFieldByPath } from "./clone";

const S_A = "934d92a5aaaa";
const S_B = "934d92a5bbbb";
const S_C = "934d92a5cccc";
const S_D = "934d92a5dddd";
const T_A = "a83f19c20001";
const T_B = "a83f19c20002";
const T_C = "a83f19c20003";
const T_D = "a83f19c20004";

function deviceSnapshot(id: string, entityType: string, fields: FieldSnapshot[] = []): DeviceSnapshot {
    return { sourceEntityId: id, entityType, displayName: id, fields };
}

function fieldSnapshot(partial: Partial<FieldSnapshot> & { path: string; value: unknown }): FieldSnapshot {
    return { primitiveType: "number", scalarType: 2, mutable: true, ...partial };
}

function connectionSnapshot(fromId: string, toId: string, socketPath: string): ConnectionSnapshot {
    const field = socketPath.split(".").pop() ?? "audioOutput";
    return { fromEntityId: fromId, toEntityId: toId, fromSocket: field, fromSocketPath: socketPath, toSocket: field, toSocketPath: socketPath };
}

function idMapOf(entries: [string, string][]): Map<string, string> {
    return new Map(entries.map(([s, t]) => [normalizeEntityId(s), t]));
}

// ———————————————————————————————————————————————————————————————————————
// 1. snapshot serialization / 3. parameter snapshot (structure)
// ———————————————————————————————————————————————————————————————————————

describe("1/3. snapshot serialization + structure", () => {
    function makeSnapshot(): ChainSnapshot {
        return {
            version: 1,
            devices: [
                deviceSnapshot(S_A, "pulverisateur", [
                    fieldSnapshot({ path: "filter.cutoffFrequencyHz", value: 7421, range: { min: 18, max: 15500 }, scalarType: 2 }),
                    fieldSnapshot({ path: "isActive", value: true, primitiveType: "boolean", scalarType: 8 }),
                ]),
            ],
            connections: [connectionSnapshot(S_A, S_B, "pulverisateur.audioOutput")],
            rootCandidates: [S_A],
        };
    }

    it("serializes + round-trips through JSON losslessly", () => {
        const snapshot = makeSnapshot();
        const parsed = parseSnapshot(serializeSnapshot(snapshot));
        expect(parsed).toEqual(snapshot);
        expect(parsed.version).toBe(1);
    });

    it("rejects unknown snapshot versions", () => {
        expect(() => parseSnapshot('{"version":99}')).toThrow(/unsupported snapshot version/);
    });

    it("field snapshot keeps the raw value, real range and schema meta untouched", () => {
        const f = makeSnapshot().devices[0].fields.find((x) => x.path === "filter.cutoffFrequencyHz")!;
        expect(f.value).toBe(7421);
        expect(f.range).toEqual({ min: 18, max: 15500 });
        expect(f.scalarType).toBe(2);
        expect(f.primitiveType).toBe("number");
        expect(f.mutable).toBe(true);
    });

    it("snapshotDeviceById is case-insensitive and matches source ids", () => {
        const snapshot = makeSnapshot();
        expect(snapshotDeviceById(snapshot, S_A.toUpperCase())?.entityType).toBe("pulverisateur");
        expect(snapshotDeviceById(snapshot, "nope")).toBeUndefined();
    });
});

// ———————————————————————————————————————————————————————————————————————
// 2. entity id mapping / 6-8. connection mapping + topologies
// ———————————————————————————————————————————————————————————————————————

describe("2/6/7/8. id mapping + connection mapping (A→B, A→B→C, fan-out)", () => {
    it("maps source ids to distinct target ids and never reuses a source id", () => {
        const idMap = idMapOf([
            [S_A, T_A],
            [S_B, T_B],
            [S_C, T_C],
        ]);
        expect(idMap.get(S_A)).toBe(T_A);
        expect(idMap.get(S_B)).toBe(T_B);
        expect(idMapUsesNoSourceIds(idMap, [S_A, S_B, S_C])).toBe(true);
    });

    it("detects when a target id accidentally collides with a source id", () => {
        const idMap = idMapOf([
            [S_A, S_B], // BAD: target id is a source id
        ]);
        expect(idMapUsesNoSourceIds(idMap, [S_A, S_B])).toBe(false);
    });

    it("translates A→B into X→Y through the mapping", () => {
        const idMap = idMapOf([
            [S_A, T_A],
            [S_B, T_B],
        ]);
        const { fromTarget, toTarget } = translateConnection(S_A, S_B, idMap);
        expect(fromTarget).toBe(T_A);
        expect(toTarget).toBe(T_B);
    });

    function snap(connections: ConnectionSnapshot[], deviceOrder: string[]): ChainSnapshot {
        return {
            version: 1,
            devices: deviceOrder.map((id) => deviceSnapshot(id, "stompboxDelay")),
            connections,
            rootCandidates: [deviceOrder[0]],
        };
    }

    const stubSocket: ResolveTargetSocket = (_src, segments, kind) => {
        const field = segments.length ? segments[segments.length - 1] : "";
        if (!field) return { ok: false, reason: "no socket path" };
        return { ok: true, location: { stub: true, field, kind }, socketField: field };
    };

    it("plans exactly one cable for A→B", () => {
        const idMap = idMapOf([
            [S_A, T_A],
            [S_B, T_B],
        ]);
        const plans = planConnections(snap([connectionSnapshot(S_A, S_B, "stompboxDelay.audioOutput")], [S_A, S_B]), stubSocket, idMap);
        expect(plans).toHaveLength(1);
        expect(plans[0].action).toBe("create");
        expect(plans[0].fromSegments).toEqual(["audioOutput"]);
    });

    it("plans two cables for A→B→C", () => {
        const idMap = idMapOf([
            [S_A, T_A],
            [S_B, T_B],
            [S_C, T_C],
        ]);
        const plans = planConnections(
            snap([connectionSnapshot(S_A, S_B, "stompboxDelay.audioOutput"), connectionSnapshot(S_B, S_C, "stompboxDelay.audioOutput")], [S_A, S_B, S_C]),
            stubSocket,
            idMap,
        );
        expect(plans).toHaveLength(2);
        expect(plans.every((p) => p.action === "create")).toBe(true);
        // topology A→B→C, not A→B with stale ids
        expect(plans.map((p) => `${translateConnection(p.fromSourceDeviceId, p.toSourceDeviceId, idMap).fromTarget}>${translateConnection(p.fromSourceDeviceId, p.toSourceDeviceId, idMap).toTarget}`)).toEqual([`${T_A}>${T_B}`, `${T_B}>${T_C}`]);
    });

    it("supports fan-out A→B and A→C (two cables from the same source)", () => {
        const idMap = idMapOf([
            [S_A, T_A],
            [S_B, T_B],
            [S_C, T_C],
        ]);
        const plans = planConnections(
            snap([connectionSnapshot(S_A, S_B, "stompboxDelay.audioOutput"), connectionSnapshot(S_A, S_C, "stompboxDelay.audioOutput")], [S_A, S_B, S_C]),
            stubSocket,
            idMap,
        );
        expect(plans).toHaveLength(2);
        expect(plans.every((p) => p.action === "create")).toBe(true);
        const targets = plans.map((p) => translateConnection(p.fromSourceDeviceId, p.toSourceDeviceId, idMap));
        expect(targets.map((t) => t.fromTarget)).toEqual([T_A, T_A]);
        expect(new Set(targets.map((t) => t.toTarget))).toEqual(new Set([T_B, T_C]));
    });
});

// ———————————————————————————————————————————————————————————————————————
// 4. parameter restore planning
// ———————————————————————————————————————————————————————————————————————

describe("4. parameter restore planning (schema-driven)", () => {
    const floatField = fieldSnapshot({ path: "cutoff", value: 7421, range: { min: 18, max: 15500 } });

    it("passes a float within range straight through", () => {
        const plan = planParameterField(floatField, { primitiveType: "number", scalarType: 2, range: { min: 18, max: 15500 }, immutable: false });
        expect(plan.action).toBe("update");
        expect(plan.proposedValue).toBe(7421);
    });

    it("rounds values for integer scalar fields", () => {
        const plan = planParameterField(fieldSnapshot({ path: "glide", value: 2.6, range: { min: 0, max: 100 } }), {
            primitiveType: "number",
            scalarType: 5,
            range: { min: 0, max: 100 },
            immutable: false,
        });
        expect(plan.action).toBe("update");
        expect(plan.proposedValue).toBe(3);
    });

    it("clamps out-of-range values to the real range and reports rangeError", () => {
        const plan = planParameterField(fieldSnapshot({ path: "cutoff", value: 99999, range: { min: 18, max: 15500 } }), {
            primitiveType: "number",
            scalarType: 2,
            range: { min: 18, max: 15500 },
            immutable: false,
        });
        expect(plan.action).toBe("rangeError");
        expect(plan.proposedValue).toBe(15500);
    });

    it("keeps booleans boolean", () => {
        const plan = planParameterField(fieldSnapshot({ path: "active", value: true, primitiveType: "boolean", scalarType: 8 }), {
            primitiveType: "boolean",
            scalarType: 8,
            immutable: false,
        });
        expect(plan.action).toBe("update");
        expect(plan.proposedValue).toBe(true);
    });

    it("rejects immutable/read-only target fields", () => {
        const plan = planParameterField(floatField, { primitiveType: "number", scalarType: 2, range: { min: 18, max: 15500 }, immutable: true });
        expect(plan.action).toBe("skipImmutable");
    });

    it("reports missing target fields", () => {
        const plan = planParameterField(floatField, undefined);
        expect(plan.action).toBe("missingField");
    });

    it("rejects a string/*non-primitive target as not restorably primitive", () => {
        const plan = planParameterField(floatField, { primitiveType: "string", scalarType: 9 });
        expect(plan.action).toBe("skipNonPrimitive");
    });

    it("flags type mismatches instead of guessing", () => {
        const plan = planParameterField(fieldSnapshot({ path: "x", value: "not-a-number" }), {
            primitiveType: "number",
            scalarType: 2,
            range: { min: 0, max: 1 },
            immutable: false,
        });
        expect(plan.action).toBe("typeMismatch");
    });

    it("resolves socket path segments relative to the device (strips type prefix)", () => {
        expect(socketSegmentsFromPath("stompboxDelay.audioOutput", "stompboxDelay")).toEqual(["audioOutput"]);
        expect(socketSegmentsFromPath("minimixer.channelA.audioInput", "minimixer")).toEqual(["channelA", "audioInput"]);
        expect(socketSegmentsFromPath("audioOutput", "stompboxDelay")).toEqual(["audioOutput"]);
    });
});

// ———————————————————————————————————————————————————————————————————————
// 5/9/10/11. verification, missing/unsupported, topology comparison
// ———————————————————————————————————————————————————————————————————————

describe("5/9/10/11. verification, missing + unsupported entities", () => {
    it("verifies a fully matching target", () => {
        const snapshot: ChainSnapshot = {
            version: 1,
            devices: [
                deviceSnapshot(S_A, "pulverisateur", [fieldSnapshot({ path: "filter.cutoffFrequencyHz", value: 7421, range: { min: 18, max: 15500 } })]),
                deviceSnapshot(S_B, "stompboxCompressor", [fieldSnapshot({ path: "mix", value: 0.5, range: { min: 0, max: 1 } })]),
            ],
            connections: [connectionSnapshot(S_A, S_B, "pulverisateur.audioOutput")],
            rootCandidates: [S_A],
        };
        const idMap = idMapOf([
            [S_A, T_A],
            [S_B, T_B],
        ]);
        const digest = {
            entities: new Map([
                [T_A, { entityType: "pulverisateur", displayName: "a" }],
                [T_B, { entityType: "stompboxCompressor", displayName: "b" }],
            ]),
            parameters: new Map([
                [T_A, new Map([["filter.cutoffFrequencyHz", 7421]])],
                [T_B, new Map([["mix", 0.5]])],
            ]),
            edges: [edgeKey(T_A, T_B, "audioOutput")],
        };
        const result = compareSnapshotWithTarget(snapshot, digest, idMap, [T_A, T_B]);
        expect(result.ok).toBe(true);
        expect(result.devices.matched).toBe(true);
        expect(result.parameters.equal).toBe(true);
        expect(result.connections.equal).toBe(true);
        expect(result.topology.equal).toBe(true);
    });

    it("detects a missing target device and flags it", () => {
        const snapshot: ChainSnapshot = {
            version: 1,
            devices: [deviceSnapshot(S_A, "pulverisateur")],
            connections: [],
            rootCandidates: [S_A],
        };
        const result = compareSnapshotWithTarget(snapshot, buildTargetDigestStub(new Map(), new Map(), []), idMapOf([[S_A, T_A]]), [T_A]);
        expect(result.ok).toBe(false);
        expect(result.devices.matched).toBe(false);
        expect(result.diffs.join("\n")).toContain("missing");
    });

    it("detects parameter value differences with float32 tolerance", () => {
        const snapshot: ChainSnapshot = {
            version: 1,
            devices: [deviceSnapshot(S_A, "pulverisateur", [fieldSnapshot({ path: "mix", value: 0.5, range: { min: 0, max: 1 } })])],
            connections: [],
            rootCandidates: [S_A],
        };
        const digest = buildTargetDigestStub(
            new Map([[T_A, { entityType: "pulverisateur", displayName: "a" }]]),
            new Map([[T_A, new Map([["mix", 0.9]])]]),
            [],
        );
        const result = compareSnapshotWithTarget(snapshot, digest, idMapOf([[S_A, T_A]]), [T_A]);
        expect(result.ok).toBe(false);
        expect(result.parameters.equal).toBe(false);
    });

    it("detects a missing target connection", () => {
        const snapshot: ChainSnapshot = {
            version: 1,
            devices: [deviceSnapshot(S_A, "pulverisateur"), deviceSnapshot(S_B, "stompboxDelay")],
            connections: [connectionSnapshot(S_A, S_B, "pulverisateur.audioOutput")],
            rootCandidates: [S_A],
        };
        const digest = buildTargetDigestStub(
            new Map([
                [T_A, { entityType: "pulverisateur", displayName: "a" }],
                [T_B, { entityType: "stompboxDelay", displayName: "b" }],
            ]),
            new Map(),
            [],
        );
        const result = compareSnapshotWithTarget(snapshot, digest, idMapOf([[S_A, T_A], [S_B, T_B]]), [T_A, T_B]);
        expect(result.ok).toBe(false);
        expect(result.connections.equal).toBe(false);
    });

    it("classifies a normal device as create and an unknown type as unsupported", () => {
        const plans = planDevices(
            { version: 1, devices: [deviceSnapshot(S_A, "pulverisateur"), deviceSnapshot(S_B, "beatboxGRID")], connections: [], rootCandidates: [] },
            new Set(["pulverisateur"]),
        );
        expect(plans[0].action).toBe("create");
        expect(plans[1].action).toBe("unsupported");
    });

    it("flags a snapshot device with no entity type as missing", () => {
        const plans = planDevices(
            { version: 1, devices: [{ sourceEntityId: S_A, entityType: "", fields: [] }], connections: [], rootCandidates: [] },
            new Set(["anything"]),
        );
        expect(plans[0].action).toBe("missing");
    });

    it("skips connections whose device was not created (missing entity)", () => {
        const snapshot: ChainSnapshot = {
            version: 1,
            devices: [deviceSnapshot(S_A, "pulverisateur")],
            connections: [connectionSnapshot(S_A, S_B, "pulverisateur.audioOutput")],
            rootCandidates: [S_A],
        };
        const idMap = idMapOf([[S_A, T_A]]); // S_B not created
        const stubSocket: ResolveTargetSocket = () => ({ ok: true, location: 1 });
        const plans = planConnections(snapshot, stubSocket, idMap);
        expect(plans).toHaveLength(1);
        expect(plans[0].action).toBe("skipMissing");
    });

    it("skips connections whose socket can not be resolved", () => {
        const snapshot: ChainSnapshot = {
            version: 1,
            devices: [deviceSnapshot(S_A, "pulverisateur"), deviceSnapshot(S_B, "stompboxDelay")],
            connections: [connectionSnapshot(S_A, S_B, "pulverisateur.audioOutput")],
            rootCandidates: [S_A],
        };
        const idMap = idMapOf([
            [S_A, T_A],
            [S_B, T_B],
        ]);
        const failSocket: ResolveTargetSocket = (src, _segments, _kind) =>
            src === S_A ? { ok: false, reason: "not an AudioOutput" } : { ok: true, location: 1 };
        const plans = planConnections(snapshot, failSocket, idMap);
        expect(plans[0].action).toBe("skipSocket");
    });
});

function buildTargetDigestStub(entities: Map<string, { entityType: string; displayName: string }>, parameters: Map<string, Map<string, unknown>>, edges: string[]) {
    return { entities, parameters, edges };
}

// ———————————————————————————————————————————————————————————————————————
// M20.1 — topology is membership-based: order/multi-root must not produce DIFF
// ———————————————————————————————————————————————————————————————————————

describe("M20.1 — order-independent + multi-root topology", () => {
    it("passes when target traversal order differs from the snapshot device order", () => {
        const snapshot: ChainSnapshot = {
            version: 1,
            devices: [
                deviceSnapshot(S_A, "pulverisateur", [fieldSnapshot({ path: "mix", value: 0.5, range: { min: 0, max: 1 } })]),
                deviceSnapshot(S_B, "stompboxDelay", [fieldSnapshot({ path: "mix", value: 0.3, range: { min: 0, max: 1 } })]),
                deviceSnapshot(S_C, "stompboxCompressor", [fieldSnapshot({ path: "isActive", value: true, primitiveType: "boolean", scalarType: 8 })]),
            ],
            connections: [
                connectionSnapshot(S_A, S_B, "pulverisateur.audioOutput"),
                connectionSnapshot(S_B, S_C, "stompboxDelay.audioOutput"),
            ],
            rootCandidates: [S_A],
        };
        const idMap = idMapOf([
            [S_A, T_A],
            [S_B, T_B],
            [S_C, T_C],
        ]);
        const digest = {
            entities: new Map([
                [T_A, { entityType: "pulverisateur", displayName: "a" }],
                [T_B, { entityType: "stompboxDelay", displayName: "b" }],
                [T_C, { entityType: "stompboxCompressor", displayName: "c" }],
            ]),
            parameters: new Map<string, Map<string, unknown>>([
                [T_A, new Map([["mix", 0.5]])],
                [T_B, new Map([["mix", 0.3]])],
                [T_C, new Map([["isActive", true]])],
            ]),
            edges: [edgeKey(T_A, T_B, "audioOutput"), edgeKey(T_B, T_C, "audioOutput")],
        };
        // target visits the SAME devices in a DIFFERENT order
        const result = compareSnapshotWithTarget(snapshot, digest, idMap, [T_C, T_A, T_B]);
        expect(result.topology.sourceOrder).not.toEqual(result.topology.targetOrder);
        expect(result.topology.equal).toBe(true);
        expect(result.ok).toBe(true);
    });

    it("passes for a multi-root snapshot when every mapped device is visited (any order)", () => {
        const snapshot: ChainSnapshot = {
            version: 1,
            devices: [
                deviceSnapshot(S_A, "pulverisateur", [fieldSnapshot({ path: "mix", value: 0.5, range: { min: 0, max: 1 } })]),
                deviceSnapshot(S_B, "stompboxDelay", [fieldSnapshot({ path: "mix", value: 0.3, range: { min: 0, max: 1 } })]),
                deviceSnapshot(S_C, "heisenberg", [fieldSnapshot({ path: "mix", value: 0.7, range: { min: 0, max: 1 } })]),
                deviceSnapshot(S_D, "stompboxCompressor", [fieldSnapshot({ path: "isActive", value: true, primitiveType: "boolean", scalarType: 8 })]),
            ],
            connections: [
                connectionSnapshot(S_A, S_B, "pulverisateur.audioOutput"),
                connectionSnapshot(S_C, S_D, "heisenberg.audioOutput"),
            ],
            rootCandidates: [S_A, S_C],
        };
        const idMap = idMapOf([
            [S_A, T_A],
            [S_B, T_B],
            [S_C, T_C],
            [S_D, T_D],
        ]);
        const digest = {
            entities: new Map([
                [T_A, { entityType: "pulverisateur", displayName: "a" }],
                [T_B, { entityType: "stompboxDelay", displayName: "b" }],
                [T_C, { entityType: "heisenberg", displayName: "c" }],
                [T_D, { entityType: "stompboxCompressor", displayName: "d" }],
            ]),
            parameters: new Map<string, Map<string, unknown>>([
                [T_A, new Map([["mix", 0.5]])],
                [T_B, new Map([["mix", 0.3]])],
                [T_C, new Map([["mix", 0.7]])],
                [T_D, new Map([["isActive", true]])],
            ]),
            edges: [edgeKey(T_A, T_B, "audioOutput"), edgeKey(T_C, T_D, "audioOutput")],
        };
        // combined traversal of both roots in a different (interleaved) order
        const result = compareSnapshotWithTarget(snapshot, digest, idMap, [T_C, T_D, T_A, T_B]);
        expect(result.topology.equal).toBe(true);
        expect(result.ok).toBe(true);
    });

    it("fails when an expected device is missing from the target traversal", () => {
        const snapshot: ChainSnapshot = {
            version: 1,
            devices: [
                deviceSnapshot(S_A, "pulverisateur"),
                deviceSnapshot(S_B, "stompboxDelay"),
                deviceSnapshot(S_C, "stompboxCompressor"),
            ],
            connections: [
                connectionSnapshot(S_A, S_B, "pulverisateur.audioOutput"),
                connectionSnapshot(S_B, S_C, "stompboxDelay.audioOutput"),
            ],
            rootCandidates: [S_A],
        };
        const idMap = idMapOf([
            [S_A, T_A],
            [S_B, T_B],
            [S_C, T_C],
        ]);
        const digest = {
            entities: new Map([
                [T_A, { entityType: "pulverisateur", displayName: "a" }],
                [T_B, { entityType: "stompboxDelay", displayName: "b" }],
                [T_C, { entityType: "stompboxCompressor", displayName: "c" }],
            ]),
            parameters: new Map(),
            edges: [edgeKey(T_A, T_B, "audioOutput")],
        };
        // C exists but is never reached: traversal stops at B (missing cable)
        const result = compareSnapshotWithTarget(snapshot, digest, idMap, [T_A, T_B]);
        expect(result.topology.equal).toBe(false);
        expect(result.ok).toBe(false);
    });
});

// ———————————————————————————————————————————————————————————————————————
// M20.3 — automatic placement: lanes, spacing, shared devices, mixerChannel
// ———————————————————————————————————————————————————————————————————————

describe("M20.3 — auto-arrange layout (generated grid)", () => {
    function layoutSnapshot(devices: DeviceSnapshot[], connections: ConnectionSnapshot[], roots: string[]): ChainSnapshot {
        return {
            version: 1,
            devices,
            connections,
            rootCandidates: roots,
        };
    }

    it("places a single chain at increasing X, one lane Y, never (0,0)", () => {
        const positions = planDeviceLayout(
            layoutSnapshot(
                [deviceSnapshot(S_A, "pulverisateur"), deviceSnapshot(S_B, "stompboxDelay"), deviceSnapshot(S_C, "stompboxCompressor")],
                [
                    connectionSnapshot(S_A, S_B, "pulverisateur.audioOutput"),
                    connectionSnapshot(S_B, S_C, "stompboxDelay.audioOutput"),
                ],
                [S_A],
            ),
        );
        expect(positions.size).toBe(3);
        expect(positions.get(S_A)).toEqual({ x: PLACEMENT_ORIGIN_X, y: PLACEMENT_ORIGIN_Y });
        expect(positions.get(S_B)).toEqual({ x: PLACEMENT_ORIGIN_X + DEVICE_SPACING_X, y: PLACEMENT_ORIGIN_Y });
        expect(positions.get(S_C)).toEqual({ x: PLACEMENT_ORIGIN_X + 2 * DEVICE_SPACING_X, y: PLACEMENT_ORIGIN_Y });
        expect([...positions.values()].every((p) => p.x > 0 && p.y > 0)).toBe(true);
    });

    it("gives two independent chains different Y lanes", () => {
        const positions = planDeviceLayout(
            layoutSnapshot(
                [
                    deviceSnapshot(S_A, "pulverisateur"),
                    deviceSnapshot(S_B, "stompboxDelay"),
                    deviceSnapshot(S_C, "heisenberg"),
                    deviceSnapshot(S_D, "stompboxCompressor"),
                ],
                [
                    connectionSnapshot(S_A, S_B, "pulverisateur.audioOutput"),
                    connectionSnapshot(S_C, S_D, "heisenberg.audioOutput"),
                ],
                [S_A, S_C],
            ),
        );
        expect(positions.get(S_A)!.y).toBe(PLACEMENT_ORIGIN_Y);
        expect(positions.get(S_B)!.y).toBe(PLACEMENT_ORIGIN_Y);
        expect(positions.get(S_A)!.y).not.toBe(positions.get(S_C)!.y);
        expect(positions.get(S_C)!.y).toBe(PLACEMENT_ORIGIN_Y + CHAIN_SPACING_Y);
        expect(positions.get(S_D)!.y).toBe(PLACEMENT_ORIGIN_Y + CHAIN_SPACING_Y);
    });

    it("follows audio direction (X increases from root toward the sink)", () => {
        const positions = planDeviceLayout(
            layoutSnapshot(
                [deviceSnapshot(S_A, "pulverisateur"), deviceSnapshot(S_B, "stompboxDelay"), deviceSnapshot(S_C, "stompboxCompressor")],
                [
                    connectionSnapshot(S_A, S_B, "pulverisateur.audioOutput"),
                    connectionSnapshot(S_B, S_C, "stompboxDelay.audioOutput"),
                ],
                [S_A],
            ),
        );
        expect(positions.get(S_A)!.x).toBeLessThan(positions.get(S_B)!.x);
        expect(positions.get(S_B)!.x).toBeLessThan(positions.get(S_C)!.x);
    });

    it("assigns a single position to a device shared by two chains (no dupes)", () => {
        const positions = planDeviceLayout(
            layoutSnapshot(
                [
                    deviceSnapshot(S_A, "pulverisateur"),
                    deviceSnapshot(S_C, "heisenberg"),
                    deviceSnapshot(S_D, "stompboxCompressor"),
                ],
                [
                    connectionSnapshot(S_A, S_D, "pulverisateur.audioOutput"),
                    connectionSnapshot(S_C, S_D, "heisenberg.audioOutput"),
                ],
                [S_A, S_C],
            ),
        );
        // S_D is reachable from both roots but holds exactly one position
        expect(positions.size).toBe(3);
        const shared = [...positions.entries()].filter(([id]) => id === S_D);
        expect(shared).toHaveLength(1);
        expect(positions.get(S_A)!.y).not.toBe(positions.get(S_C)!.y);
    });

    it("never positions mixerChannel devices", () => {
        const mixId = S_D;
        const positions = planDeviceLayout(
            layoutSnapshot(
                [deviceSnapshot(S_A, "pulverisateur"), deviceSnapshot(mixId, "mixerChannel")],
                [connectionSnapshot(S_A, mixId, "pulverisateur.audioOutput")],
                [S_A],
            ),
        );
        expect(positions.has(mixId)).toBe(false);
        expect(positions.has(S_A)).toBe(true);
    });
});

// ———————————————————————————————————————————————————————————————————————
// M20.5 — conservative generic grid + dedicated leftover lane
// ———————————————————————————————————————————————————————————————————————

describe("M20.5 — conservative grid + leftover lane", () => {
    function layoutSnapshot(devices: DeviceSnapshot[], connections: ConnectionSnapshot[], roots: string[]): ChainSnapshot {
        return {
            version: 1,
            devices,
            connections,
            rootCandidates: roots,
        };
    }

    it("places consecutive devices of one chain exactly DEVICE_SPACING_X apart", () => {
        const positions = planDeviceLayout(
            layoutSnapshot(
                [deviceSnapshot(S_A, "pulverisateur"), deviceSnapshot(S_B, "stompboxDelay"), deviceSnapshot(S_C, "stompboxCompressor")],
                [
                    connectionSnapshot(S_A, S_B, "pulverisateur.audioOutput"),
                    connectionSnapshot(S_B, S_C, "stompboxDelay.audioOutput"),
                ],
                [S_A],
            ),
        );
        expect(positions.get(S_B)!.x - positions.get(S_A)!.x).toBe(DEVICE_SPACING_X);
        expect(positions.get(S_C)!.x - positions.get(S_B)!.x).toBe(DEVICE_SPACING_X);
        expect(positions.get(S_A)!.y).toBe(positions.get(S_B)!.y);
    });

    it("separates independent root chains by exactly CHAIN_SPACING_Y", () => {
        const positions = planDeviceLayout(
            layoutSnapshot(
                [
                    deviceSnapshot(S_A, "pulverisateur"),
                    deviceSnapshot(S_B, "stompboxDelay"),
                    deviceSnapshot(S_C, "heisenberg"),
                    deviceSnapshot(S_D, "heisenberg"),
                ],
                [
                    connectionSnapshot(S_A, S_B, "pulverisateur.audioOutput"),
                    connectionSnapshot(S_C, S_D, "heisenberg.audioOutput"),
                ],
                [S_A, S_C],
            ),
        );
        expect(positions.get(S_B)!.y - positions.get(S_A)!.y).toBe(0);
        expect(positions.get(S_C)!.y - positions.get(S_A)!.y).toBe(CHAIN_SPACING_Y);
        expect(positions.get(S_D)!.y - positions.get(S_C)!.y).toBe(0);
    });

    it("gives leftover devices their own new lane instead of reusing lane-1", () => {
        const positions = planDeviceLayout(
            layoutSnapshot(
                [
                    deviceSnapshot(S_A, "pulverisateur"),
                    deviceSnapshot(S_B, "stompboxDelay"),
                    deviceSnapshot(S_C, "heisenberg"),
                    deviceSnapshot(S_D, "stompboxCompressor"),
                ],
                [
                    connectionSnapshot(S_A, S_B, "pulverisateur.audioOutput"),
                    connectionSnapshot(S_C, S_D, "heisenberg.audioOutput"),
                ],
                [S_A],
            ),
        );
        // S_C / S_D are unreachable from the single root → leftovers
        expect(positions.get(S_A)!.y).toBe(PLACEMENT_ORIGIN_Y);
        expect(positions.get(S_B)!.y).toBe(PLACEMENT_ORIGIN_Y);
        expect(positions.get(S_C)!.y - positions.get(S_A)!.y).toBe(CHAIN_SPACING_Y);
        expect(positions.get(S_C)!.y).toBe(positions.get(S_D)!.y);
        // ...and still keep normal X flow within their own lane
        expect(positions.get(S_D)!.x - positions.get(S_C)!.x).toBe(DEVICE_SPACING_X);
    });

    it("uses conservative spacing clearly larger than the old point grid", () => {
        expect(DEVICE_SPACING_X).toBeGreaterThan(260);
        expect(CHAIN_SPACING_Y).toBeGreaterThan(220);
    });
});

// ———————————————————————————————————————————————————————————————————————
// 12. float32 tolerance
// ———————————————————————————————————————————————————————————————————————

describe("12. float32 tolerance", () => {
    it("treats float32 representation noise as equal", () => {
        expect(valuesEqualFloat32(528.2, 528.2000122070312)).toBe(true);
        expect(valuesEqualFloat32(0.1, 0.10000000149011612)).toBe(true);
        expect(valuesEqualFloat32(15500, 15500.002)).toBe(true);
    });

    it("distinguishes real differences", () => {
        expect(valuesEqualFloat32(1000, 7421)).toBe(false);
        expect(valuesEqualFloat32(0, 1)).toBe(false);
    });

    it("compares booleans by identity", () => {
        expect(valuesEqualFloat32(true, true)).toBe(true);
        expect(valuesEqualFloat32(true, false)).toBe(false);
    });

    it("validates range membership with float32 padding", () => {
        expect(valueInRange(15500, { min: 18, max: 15500 })).toBe(true);
        expect(valueInRange(15500.001, { min: 18, max: 15500 })).toBe(true);
        expect(valueInRange(15501, { min: 18, max: 15500 })).toBe(false);
    });
});

// ———————————————————————————————————————————————————————————————————————
// 13/15. read-only fields, rollback/partial-failure reporting
// ———————————————————————————————————————————————————————————————————————

describe("13/15. read-only skip + partial failure report", () => {
    function baseSnapshot(): ChainSnapshot {
        return {
            version: 1,
            devices: [
                deviceSnapshot(S_A, "pulverisateur", [
                    fieldSnapshot({ path: "filter.cutoffFrequencyHz", value: 7421, range: { min: 18, max: 15500 } }),
                    fieldSnapshot({ path: "locked", value: 1, range: { min: 0, max: 1 } }),
                    fieldSnapshot({ path: "mix", value: 0.5, range: { min: 0, max: 1 } }),
                ]),
                deviceSnapshot(S_B, "stompboxCompressor"),
            ],
            connections: [connectionSnapshot(S_A, S_B, "pulverisateur.audioOutput")],
            rootCandidates: [S_A],
        };
    }

    it("read-only (immutable) field yields a skip, never an update", () => {
        const p1 = planParameterField(fieldSnapshot({ path: "locked", value: 1 }), { primitiveType: "number", scalarType: 2, immutable: true });
        expect(p1.action).toBe("skipImmutable");
        expect(p1.proposedValue).toBeUndefined();
    });

    it("produces a PARTIAL report when some failures occur (partial failure reporting)", () => {
        const snapshot = baseSnapshot();
        const report = buildCloneReport({
            snapshot,
            failures: [
                { step: "device", sourceId: S_B, message: "create stompboxCompressor: No defaults found" },
                { step: "parameter", sourceId: S_A, path: "filter.cutoffFrequencyHz", message: "skipped (missingField): target field not found" },
            ],
            unsupportedTypes: ["stompboxCompressor"],
            nexusApiLimitations: ["test limitation"],
        });
        expect(report.sections.entityCreation.verdict).toBe("PARTIAL");
        expect(report.sections.parameterRestore.verdict).toBe("PARTIAL");
        expect(report.finalVerdict).toBe("CHAIN CLONE: PARTIAL");
        expect(report.unsupportedEntityTypes).toContain("stompboxCompressor");
    });

    it("produces FAIL when entity creation failed entirely", () => {
        const snapshot = baseSnapshot();
        const report = buildCloneReport({
            snapshot,
            failures: [
                { step: "device", sourceId: S_A, message: "create pulverisateur: rejected" },
                { step: "device", sourceId: S_B, message: "create stompboxCompressor: rejected" },
            ],
            unsupportedTypes: ["pulverisateur", "stompboxCompressor"],
            nexusApiLimitations: [],
        });
        expect(report.sections.entityCreation.verdict).toBe("FAIL");
        expect(report.finalVerdict).toBe("CHAIN CLONE: NOT POSSIBLE WITH CURRENT NEXUS API");
    });

    it("verdictFromCounts implements PASS/PARTIAL/FAIL", () => {
        expect(verdictFromCounts(3, 3, 0)).toBe("PASS");
        expect(verdictFromCounts(3, 2, 0)).toBe("PARTIAL");
        expect(verdictFromCounts(3, 0, 0)).toBe("FAIL");
        expect(verdictFromCounts(0, 0, 2)).toBe("PARTIAL");
    });
});

// ———————————————————————————————————————————————————————————————————————
// resolveFieldByPath — nested NexusObject-array leaves (bands.[i].field)
// ———————————————————————————————————————————————————————————————————————

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

function bandItemFields(valueBase: number): Record<string, any> {
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

function quantumFieldsFixture(): any {
    return {
        gainDb: primitiveField(0),
        isActive: primitiveField(true),
        splitFrequencyHz: {
            location: {},
            array: [primitiveField(120), primitiveField(240), primitiveField(960)],
        },
        bands: {
            location: {},
            array: [bandItemFields(0), bandItemFields(1), bandItemFields(2), bandItemFields(3)],
        },
    };
}

const QUANTUM_BAND_PATHS = BAND_FIELDS.flatMap((field) =>
    Array.from({ length: 4 }, (_, i) => `bands.[${i}].${field}`),
);

describe("resolveFieldByPath — nested NexusObject-array leaves", () => {
    it("A: resolves plain top-level fields (gainDb, isActive)", () => {
        const fields = quantumFieldsFixture();
        expect(resolveFieldByPath(fields, "gainDb")?.value).toBe(0);
        expect(resolveFieldByPath(fields, "isActive")?.value).toBe(true);
    });

    it("B: resolves primitives inside arrays (splitFrequencyHz.[0])", () => {
        const fields = quantumFieldsFixture();
        expect(resolveFieldByPath(fields, "splitFrequencyHz.[0]")?.value).toBe(120);
        expect(resolveFieldByPath(fields, "splitFrequencyHz.[2]")?.value).toBe(960);
    });

    it("C: resolves all 36 band leaves across 4 object-array items", () => {
        const fields = quantumFieldsFixture();
        expect(fields.bands.array).toHaveLength(4);
        const resolved = QUANTUM_BAND_PATHS.map((p) => [p, resolveFieldByPath(fields, p)] as const);
        const missing = resolved.filter(([, f]) => !f || !("value" in f));
        expect(missing.map(([p]) => p)).toEqual([]);
        for (const [p, field] of resolved) {
            expect(field?.location, p).toBeDefined();
            expect("value" in field!, p).toBe(true);
        }
    });

    it("resolves nested object fields (filter.cutoffFrequencyHz) and reports unknown leaves as undefined", () => {
        const fields = {
            filter: { location: {}, fields: { cutoffFrequencyHz: primitiveField(7421) } },
        };
        expect(resolveFieldByPath(fields, "filter.cutoffFrequencyHz")?.value).toBe(7421);
        expect(resolveFieldByPath(fields, "bands.[0].nope")).toBeUndefined();
        expect(resolveFieldByPath(fields, "bands.[9].thresholdDb")).toBeUndefined();
    });
});