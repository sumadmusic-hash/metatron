/**
 * CLONE PLANNING — pure, Nexus-free decision layer (production).
 *
 * Every function here works on plain data: it classifies devices, decides how
 * parameter values must be mapped into the TARGET field schema (round, clamp,
 * skip immutable), and resolves socket paths. The live engine feeds REAL schema
 * info into these functions (via small adapter callbacks); the unit tests feed
 * fixtures. No name guessing anywhere: all decisions are schema-derived.
 *
 * Provenance: this module is the productive twin of `poc/chain-clone/planning.ts`.
 * The PoC module re-exports from here so PoC tests keep running against the
 * same single source of truth.
 */

import { normalizeEntityId } from "./ChainDiscovery";
import type {
    ChainSnapshot,
    ClonePlan,
    ConnectionPlan,
    DevicePlan,
    FieldSnapshot,
    ParameterPlan,
    Verdict,
} from "./ChainTypes";

export interface TargetFieldMeta {
    primitiveType?: string;
    scalarType?: number;
    range?: { min: number; max: number };
    immutable?: boolean;
}

export type TargetSocketKind = "AudioOutput" | "AudioInput";

export type ResolveTargetFieldMeta = (sourceDeviceId: string, path: string) => TargetFieldMeta | undefined;

export type ResolveTargetSocket = (
    sourceDeviceId: string,
    segments: string[],
    kind: TargetSocketKind,
) => { ok: true; location?: unknown; socketField?: string } | { ok: false; reason: string };

const SCALAR_INTEGERS = new Set([3, 4, 5, 6, 7, 13, 15, 16, 17, 18]);

function isIntegerScalar(scalarType: number | undefined): boolean {
    return scalarType !== undefined && SCALAR_INTEGERS.has(scalarType);
}

/**
 * Decide how one snapshot field maps into the target field.
 * Pure: `meta` is the TARGET field's real schema info.
 */
export function planParameterField(field: FieldSnapshot, meta: TargetFieldMeta | undefined): ParameterPlan {
    const base: ParameterPlan = {
        sourceDeviceId: "",
        path: field.path,
        sourceValue: field.value,
        action: "update",
    };

    if (meta === undefined || meta.primitiveType === undefined) {
        return { ...base, action: "missingField", reason: "target field not found in schema" };
    }
    if (meta.immutable) {
        return { ...base, action: "skipImmutable", reason: "target field is immutable (read-only)" };
    }
    if (meta.primitiveType !== "number" && meta.primitiveType !== "boolean") {
        return { ...base, action: "skipNonPrimitive", reason: `target primitive is ${meta.primitiveType}` };
    }
    if (meta.primitiveType === "boolean") {
        return { ...base, proposedValue: typeof field.value === "boolean" ? field.value : Boolean(field.value) };
    }
    if (typeof field.value !== "number") {
        return { ...base, action: "typeMismatch", reason: `source value ${String(field.value)} is not a number` };
    }

    // numeric target: integer fields are rounded, floats pass through; when the
    // value falls outside the REAL target range it is clamped and reported so.
    let value = field.value;
    if (isIntegerScalar(meta.scalarType)) value = Math.round(value);
    const range = meta.range;
    if (range !== undefined && range.min <= range.max) {
        if (value < range.min || value > range.max) {
            const clamped = Math.min(Math.max(value, range.min), range.max);
            return { ...base, action: "rangeError", reason: "clamped to target range", proposedValue: clamped, range };
        }
    }
    return { ...base, proposedValue: value };
}

/** Plan every parameter of every device. */
export function planParameters(
    snapshot: ChainSnapshot,
    resolveTargetMeta: ResolveTargetFieldMeta,
): ParameterPlan[] {
    const out: ParameterPlan[] = [];
    for (const device of snapshot.devices) {
        for (const field of device.fields) {
            const plan = planParameterField(field, resolveTargetMeta(device.sourceEntityId, field.path));
            out.push({ ...plan, sourceDeviceId: device.sourceEntityId });
        }
    }
    return out;
}

/** Split a socket path into the relative field segments of the owning device. */
export function socketSegmentsFromPath(socketPath: string | undefined, entityType: string): string[] {
    if (!socketPath) return [];
    const segments = socketPath.split(/[./]/).filter((s) => s.length > 0);
    if (segments.length > 0 && segments[0] === entityType) segments.shift();
    return segments;
}

/** Plan the cables: for each source connection produce a `create` or skip. */
export function planConnections(
    snapshot: ChainSnapshot,
    resolveSocket: ResolveTargetSocket,
    idMap: Map<string, string>,
): ConnectionPlan[] {
    const entityTypeById = new Map(snapshot.devices.map((d) => [normalizeEntityId(d.sourceEntityId), d.entityType]));
    const out: ConnectionPlan[] = [];
    for (const conn of snapshot.connections) {
        const fromId = normalizeEntityId(conn.fromEntityId);
        const toId = normalizeEntityId(conn.toEntityId);
        const fromSegments = socketSegmentsFromPath(conn.fromSocketPath, entityTypeById.get(fromId) ?? "");
        const toSegments = socketSegmentsFromPath(conn.toSocketPath, entityTypeById.get(toId) ?? "");
        const base: ConnectionPlan = {
            fromSourceDeviceId: fromId,
            toSourceDeviceId: toId,
            fromSocketPath: conn.fromSocketPath,
            toSocketPath: conn.toSocketPath,
            fromSegments,
            toSegments,
            action: "create",
        };
        const fromTarget = idMap.get(fromId);
        const toTarget = idMap.get(toId);
        if (!fromTarget || !toTarget) {
            out.push({ ...base, action: "skipMissing", reason: "device not created on target" });
            continue;
        }
        const fromResolver = resolveSocket(fromId, fromSegments, "AudioOutput");
        if (!fromResolver.ok) {
            out.push({ ...base, action: "skipSocket", reason: fromResolver.reason });
            continue;
        }
        const toResolver = resolveSocket(toId, toSegments, "AudioInput");
        if (!toResolver.ok) {
            out.push({ ...base, action: "skipSocket", reason: toResolver.reason });
            continue;
        }
        out.push(base);
    }
    return out;
}

/** Classify device creation: "create" when the type is known-creatable, else "unsupported". */
export function planDevices(snapshot: ChainSnapshot, creatableTypes: ReadonlySet<string>): DevicePlan[] {
    return snapshot.devices.map((d) => {
        const base: DevicePlan = {
            sourceId: d.sourceEntityId,
            entityType: d.entityType,
            displayName: d.displayName,
            action: "create",
        };
        if (!d.entityType) return { ...base, action: "missing", reason: "no entity type in snapshot" };
        if (!creatableTypes.has(d.entityType)) {
            return { ...base, action: "unsupported", reason: "not in creatable capacity set" };
        }
        return base;
    });
}

/** Build the full plan. `creatableTypes` is the runtime-computed capacity set. */
export function planClone(
    snapshot: ChainSnapshot,
    opts: {
        creatableTypes: ReadonlySet<string>;
        idMap?: Map<string, string>;
        resolveTargetMeta: ResolveTargetFieldMeta;
        resolveTargetSocket: ResolveTargetSocket;
    },
): ClonePlan {
    const idMap = opts.idMap ?? new Map<string, string>();
    return {
        devices: planDevices(snapshot, opts.creatableTypes),
        parameters: planParameters(snapshot, opts.resolveTargetMeta),
        connections: planConnections(snapshot, opts.resolveTargetSocket, idMap),
    };
}

/** Verdict from tried/ok counts. */
export function verdictFromCounts(tried: number, ok: number, skipped: number): Verdict {
    if (tried === 0) {
        return skipped > 0 ? "PARTIAL" : "FAIL";
    }
    if (ok === tried) return "PASS";
    if (ok === 0) return "FAIL";
    return "PARTIAL";
}

/** Pure id-map helper: translate connection endpoints through the mapping. */
export function translateConnection(
    fromEntityId: string,
    toEntityId: string,
    idMap: Map<string, string>,
): { fromTarget?: string; toTarget?: string } {
    return {
        fromTarget: idMap.get(normalizeEntityId(fromEntityId)),
        toTarget: idMap.get(normalizeEntityId(toEntityId)),
    };
}

/** True when the map never reuses a source id as a target id. */
export function idMapUsesNoSourceIds(idMap: Map<string, string>, sourceIds: Iterable<string>): boolean {
    const targets = new Set(idMap.values());
    for (const sourceId of sourceIds) {
        if (targets.has(normalizeEntityId(sourceId))) return false;
    }
    return true;
}