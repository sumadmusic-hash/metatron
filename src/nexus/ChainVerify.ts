/**
 * VERIFICATION — reads the TARGET back and compares it with the source
 * snapshot (production). Pure comparison functions are separated from the live
 * target digest so both unit tests and the offline suite can exercise them.
 *
 * Provenance: this module is the productive twin of `poc/chain-clone/verify.ts`.
 * The PoC module re-exports from here so PoC tests keep running against the
 * same single source of truth.
 */

import type { SyncedDocument } from "@audiotool/nexus";
import { listEntitiesLive, listCablesLive, listParametersLive, discoverChainLive } from "./ChainLive";
import { extractAudioConnections, normalizeEntityId } from "./ChainDiscovery";
import type { ChainSnapshot, VerificationResult } from "./ChainTypes";

// re-exported for the live runner (target topology reads the real target doc)
export { discoverChainLive };

/** float32-safe equality: relative tolerance, absolute floor 0.01. */
export function valuesEqualFloat32(a: unknown, b: unknown): boolean {
    if (typeof a === "number" && typeof b === "number") {
        const diff = Math.abs(a - b);
        const scale = Math.max(Math.abs(a), Math.abs(b), 1);
        return diff <= Math.max(0.01, scale * 1e-5);
    }
    return a === b;
}

/** Check a value against a numeric range with float32 padding. */
export function valueInRange(value: unknown, range?: { min: number; max: number }): boolean {
    if (typeof value !== "number" || !range) return true;
    const pad = Math.max(0.01, Math.abs(range.max) * 1e-5, Math.abs(range.min) * 1e-5);
    return value >= range.min - pad && value <= range.max + pad;
}

/** Edge key for exact set comparison of connections. */
export function edgeKey(from: string, to: string, socket?: string): string {
    return `${normalizeEntityId(from)}>${normalizeEntityId(to)}${socket ? `:${socket}` : ""}`;
}

/** Target-side read-back of devices, params and cables. */
export interface TargetDigest {
    entities: Map<string, { entityType: string; displayName: string }>;
    /** entity id → path → value (automatable, schema-driven read). */
    parameters: Map<string, Map<string, unknown>>;
    /** endpoint pairs (normalized ids + socket). */
    edges: string[];
}

export function buildTargetDigest(doc: SyncedDocument): TargetDigest {
    const entities = new Map<string, { entityType: string; displayName: string }>();
    for (const e of listEntitiesLive(doc)) {
        entities.set(e.id, { entityType: e.entityType, displayName: e.displayName });
    }
    const parameters = new Map<string, Map<string, unknown>>();
    for (const id of entities.keys()) {
        const byPath = new Map<string, unknown>();
        for (const p of listParametersLive(doc, id)) {
            byPath.set(p.fieldPath, p.value);
        }
        parameters.set(id, byPath);
    }
    const cables = listCablesLive(doc);
    const edges = extractAudioConnections(cables).map((c) =>
        edgeKey(c.from.entityId, c.to.entityId, c.from.socketField),
    );
    return { entities, parameters, edges };
}

/**
 * Compare the source snapshot with the target digest through the clone mapping.
 * Structural topology must be identical; entity ids will of course differ.
 */
export function compareSnapshotWithTarget(
    snapshot: ChainSnapshot,
    digest: TargetDigest,
    idMap: Map<string, string>,
    targetOrder?: string[],
): VerificationResult {
    const diffs: string[] = [];

    // — devices —
    let deviceMatched = 0;
    let deviceTypeMismatch = 0;
    for (const device of snapshot.devices) {
        const targetId = idMap.get(normalizeEntityId(device.sourceEntityId));
        if (!targetId) {
            diffs.push(`device ${device.sourceEntityId} not in idMap (clone skipped)`);
            continue;
        }
        const targetInfo = digest.entities.get(targetId);
        if (!targetInfo) {
            diffs.push(`target entity ${targetId} (source ${device.sourceEntityId}) missing`);
        } else if (targetInfo.entityType !== device.entityType) {
            deviceTypeMismatch++;
            diffs.push(`type mismatch for ${targetId}: ${targetInfo.entityType} != ${device.entityType}`);
        } else {
            deviceMatched++;
        }
    }
    const deviceMatch = deviceMatched === snapshot.devices.length && deviceTypeMismatch === 0;

    // — parameters —
    let paramExpected = 0;
    let paramActual = 0;
    let paramMatched = 0;
    for (const device of snapshot.devices) {
        const targetId = idMap.get(normalizeEntityId(device.sourceEntityId));
        if (!targetId) continue;
        const targetParams = digest.parameters.get(targetId) ?? new Map();
        for (const field of device.fields) {
            paramExpected++;
            const current = targetParams.get(field.path);
            if (current === undefined) {
                diffs.push(`target param ${targetId}.${field.path} missing`);
                continue;
            }
            paramActual++;
            if (valuesEqualFloat32(field.value, current)) {
                paramMatched++;
            } else {
                diffs.push(`param ${targetId}.${field.path}: source=${String(field.value)} target=${String(current)}`);
            }
            if (!valueInRange(current, field.range)) {
                diffs.push(`param ${targetId}.${field.path}: ${String(current)} outside range ${JSON.stringify(field.range)}`);
            }
        }
    }
    const paramEqual = paramExpected > 0 && paramMatched === paramExpected && paramActual === paramExpected;

    // — connections (edge set equality through the mapping) —
    let connExpected = 0;
    let connMatched = 0;
    const expectedEdges = new Set<string>();
    for (const conn of snapshot.connections) {
        const fromTarget = idMap.get(normalizeEntityId(conn.fromEntityId));
        const toTarget = idMap.get(normalizeEntityId(conn.toEntityId));
        if (!fromTarget || !toTarget) {
            diffs.push(`connection could not be mapped: ${conn.fromEntityId}→${conn.toEntityId}`);
            continue;
        }
        connExpected++;
        expectedEdges.add(edgeKey(fromTarget, toTarget, conn.fromSocket));
    }
    for (const edge of expectedEdges) {
        if (digest.edges.includes(edge)) connMatched++;
        else diffs.push(`missing target edge ${edge}`);
    }
    const connectionEqual = connExpected > 0 && connMatched === connExpected;

    // — topology (traversal order through the mapping) —
    const sourceOrder = snapshot.devices.map((d) => normalizeEntityId(d.sourceEntityId));
    const mappedSourceOrder = sourceOrder
        .map((id) => idMap.get(id))
        .filter((id): id is string => Boolean(id));
    const topologyEqual =
        mappedSourceOrder.length > 0 &&
        (targetOrder ?? []).length === mappedSourceOrder.length &&
        mappedSourceOrder.every((id, i) => (targetOrder ?? [])[i] === id);

    const sectionsOk = deviceMatch && paramEqual && connectionEqual && topologyEqual;
    return {
        devices: { expected: snapshot.devices.length, actual: deviceMatched, matched: deviceMatch },
        parameters: { expected: paramExpected, actual: paramActual, matched: paramMatched, equal: paramEqual },
        connections: { expected: connExpected, actual: digest.edges.length, matched: connMatched, equal: connectionEqual },
        topology: { sourceOrder: mappedSourceOrder, targetOrder: targetOrder ?? [], equal: topologyEqual },
        diffs,
        ok: sectionsOk,
    };
}