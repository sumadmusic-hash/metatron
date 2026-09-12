/**
 * METATRON CHAIN-UNION AUDIT — pure comparison layer (STEP M19.2, AUDIT-ONLY).
 *
 * Compares, on IDENTICAL live-read data:
 *
 *   OLD  selectSourceRoot() → createSnapshot(root)         (root-based export)
 *   NEW  Metatron bindings → chainUnionFromBindings()      (binding-based union)
 *
 * AUDIT-ONLY guarantees: never mutates, never persists, never writes to Nexus,
 * never changes production export semantics. Production export is NOT touched;
 * the current root-based export stays the source of truth until a separate
 * release step replaces it.
 *
 * Pure module (no Nexus runtime import) so the comparison logic is
 * unit-testable offline.
 */

import { chainUnionFromBindings, normalizeEntityId } from "../../src/nexus/ChainDiscovery";
import type { AudioConnection } from "../../src/nexus/ChainDiscovery";
import type { ChainSnapshot } from "../../src/nexus/ChainTypes";

/** Minimal live entity info needed to resolve ids back to readable labels. */
export interface LiveEntityInfo {
    id: string;
    entityType?: string;
    displayName?: string;
}

/** Resolved info for one selected device (both OLD and NEW sets). */
export interface DeviceInfo {
    normalizedId: string;
    entityType?: string;
    displayName?: string;
    hasAudioSocket: boolean;
    hasInputSocket: boolean;
    hasOutputSocket: boolean;
}

/** The OLD root-based selection, captured read-only. */
export interface OldSelection {
    rootId?: string;
    deviceIds: string[];
    connectionCount: number;
}

/** Full OLD-vs-NEW comparison of one audit run. */
export interface UnionAudit {
    boundIds: string[];
    normalizedBound: string[];
    unionDeviceIds: string[];
    unionConnections: number;
    unionRootCandidates: string[];
    unionTruncated: boolean;
    old: OldSelection;
    devices: Record<string, DeviceInfo>;
    both: string[];
    onlyOld: string[];
    onlyNew: string[];
    boundInsideUnion: string[];
    boundOutsideUnion: string[];
    boundOmittedByOld: string[];
}

/** All inputs are read-only live observations — this function mutates nothing. */
export function buildUnionAudit(params: {
    cables: AudioConnection[];
    boundEntityIds: string[];
    entities: LiveEntityInfo[];
    audioDeviceIds: string[];
    oldRootId: string | undefined;
    oldSnapshot: ChainSnapshot;
}): UnionAudit {
    const normalizedBound = params.boundEntityIds.map(normalizeEntityId).filter((id) => id.length > 0);

    // ── NEW: binding-based union (no root selection involved) ─────────────
    const union = chainUnionFromBindings(params.cables, normalizedBound);
    const unionSet = new Set(union.devices);

    // ── OLD: existing root-based snapshot (caller already produced it) ────
    const oldSet = new Set(params.oldSnapshot.devices.map((d) => normalizeEntityId(d.sourceEntityId)));

    // ── socket direction derivation (deterministic from the same cables) ──
    const hasOutput = new Set<string>();
    const hasInput = new Set<string>();
    for (const c of params.cables) {
        const from = normalizeEntityId(c.from.entityId);
        const to = normalizeEntityId(c.to.entityId);
        if (from) hasOutput.add(from);
        if (to) hasInput.add(to);
    }

    const audioSet = new Set(params.audioDeviceIds.map(normalizeEntityId));
    const entityById = new Map(params.entities.map((e) => [normalizeEntityId(e.id), e]));

    const devices: Record<string, DeviceInfo> = {};
    for (const id of [...union.devices, ...oldSet]) {
        if (devices[id]) continue;
        const live = entityById.get(id);
        devices[id] = {
            normalizedId: id,
            entityType: live?.entityType,
            displayName: live?.displayName,
            hasAudioSocket: audioSet.has(id),
            hasInputSocket: hasInput.has(id),
            hasOutputSocket: hasOutput.has(id),
        };
    }

    const both = union.devices.filter((id) => oldSet.has(id));
    const onlyOld = [...oldSet].filter((id) => !unionSet.has(id));
    const onlyNew = union.devices.filter((id) => !oldSet.has(id));
    const boundInsideUnion = normalizedBound.filter((id) => unionSet.has(id));
    const boundOutsideUnion = normalizedBound.filter((id) => !unionSet.has(id));
    const boundOmittedByOld = normalizedBound.filter((id) => !oldSet.has(id));

    return {
        boundIds: params.boundEntityIds,
        normalizedBound,
        unionDeviceIds: union.devices,
        unionConnections: union.connections.length,
        unionRootCandidates: union.rootCandidates,
        unionTruncated: union.truncated,
        old: {
            rootId: params.oldRootId ? normalizeEntityId(params.oldRootId) : undefined,
            deviceIds: [...oldSet],
            connectionCount: params.oldSnapshot.connections.length,
        },
        devices,
        both,
        onlyOld,
        onlyNew,
        boundInsideUnion,
        boundOutsideUnion,
        boundOmittedByOld,
    };
}