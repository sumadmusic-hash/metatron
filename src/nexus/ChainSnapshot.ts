/**
 * SNAPSHOT CAPTURE — builds the serializable chain snapshot from a REAL
 * document (production). Read-only on the source: never calls
 * modify/create/update.
 *
 * Reuses the discovery layer (`ChainLive` / `ChainDiscovery`) for entity
 * listing, cable reading, parameter reading and traversal.
 *
 * Provenance: this module is the productive twin of `poc/chain-clone/snapshot.ts`.
 * The PoC module re-exports from here so PoC tests keep running against the
 * same single source of truth.
 */

import type { SyncedDocument } from "@audiotool/nexus";
import {
    listCablesLive,
    listEntitiesLive,
    discoverChainLive,
    walkFields,
} from "./ChainLive";
import { normalizeEntityId, extractAudioConnections } from "./ChainDiscovery";
import type { ChainSnapshot, ConnectionSnapshot, DeviceSnapshot, FieldSnapshot } from "./ChainTypes";

const LOG = "[METATRON CHAIN CLONE]";

/** True when a primitive detail is a numeric/boolean automatable parameter. */
function isCopyableParameter(details: any): boolean {
    if (!details || details.type !== "primitive") return false;
    if (!(details.targetTypes ?? []).includes("AutomatableParameter")) return false;
    const kind = details.primitive?.type;
    return kind === "number" || kind === "boolean";
}

/** Collect the automatable number/boolean fields of one entity (schema-driven). */
export function captureFields(fields: any): FieldSnapshot[] {
    const out: FieldSnapshot[] = [];
    walkFields(fields, "", (hit) => {
        if (!isCopyableParameter(hit.details)) return;
        const primitive = hit.details.primitive;
        const f: FieldSnapshot = {
            path: hit.fieldPath,
            value: hit.field.value,
            primitiveType: primitive?.type,
            scalarType: typeof primitive?.scalarType === "number" ? primitive.scalarType : undefined,
            range: primitive?.range,
            defaultValue: "default" in primitive ? (primitive.default as number | boolean) : undefined,
            mutable: hit.details.immutable !== true,
        };
        out.push(f);
    });
    return out;
}

/** Build a chain snapshot from a live project, starting at `rootId`. */
export function createSnapshot(doc: SyncedDocument, rootId: string, maxDepth = 32): ChainSnapshot {
    const entities = listEntitiesLive(doc);
    const byId = new Map(entities.map((e) => [e.id, e]));
    const { result } = discoverChainLive(doc, rootId, maxDepth);

    const order = result.order;
    if (order.length === 0) {
        console.warn(`${LOG} snapshot: no chain members discovered for root=${rootId}`);
    }

    const deviceSet = new Set(order.map(normalizeEntityId));

    const devices: DeviceSnapshot[] = order.map((id) => {
        const listed = byId.get(id);
        const entity = (doc.queryEntities as any).getEntity(id) ?? listed;
        const fields = entity?.fields ?? {};
        const displayName = typeof fields.displayName === "object" && "value" in fields.displayName
            ? String((fields.displayName as any).value ?? "")
            : undefined;
        return {
            sourceEntityId: id,
            entityType: entity?.entityType ?? listed?.entityType ?? "",
            displayName: displayName || undefined,
            schemaTargetType: listed?.schemaTypeKey ?? listed?.entityType,
            fields: captureFields(fields),
        };
    });

    const allCables = extractAudioConnections(listCablesLive(doc));
    const connectionsSnapshot: ConnectionSnapshot[] = [];
    for (const cable of allCables) {
        const from = normalizeEntityId(cable.from.entityId);
        const to = normalizeEntityId(cable.to.entityId);
        if (!deviceSet.has(from) || !deviceSet.has(to)) continue;
        connectionsSnapshot.push({
            fromEntityId: from,
            fromSocket: cable.from.socketField,
            fromSocketPath: cable.from.socketPath,
            toEntityId: to,
            toSocket: cable.to.socketField,
            toSocketPath: cable.to.socketPath,
        });
    }

    const hasIncoming = new Set(connectionsSnapshot.map((c) => normalizeEntityId(c.toEntityId)));
    const rootCandidates = order.filter((id) => !hasIncoming.has(id));

    const snapshot: ChainSnapshot = {
        version: 1,
        devices,
        connections: connectionsSnapshot,
        rootCandidates,
    };
    console.log(
        `${LOG} snapshot: devices=${devices.length} connections=${connectionsSnapshot.length} rootCandidates=${rootCandidates.length}`,
    );
    return snapshot;
}

/** JSON round-trip helpers (serialization test coverage). */
export function serializeSnapshot(snapshot: ChainSnapshot): string {
    return JSON.stringify(snapshot);
}

export function parseSnapshot(json: string): ChainSnapshot {
    const parsed = JSON.parse(json) as ChainSnapshot;
    if (parsed.version !== 1) throw new Error(`unsupported snapshot version: ${parsed.version}`);
    return parsed;
}

/** Read-only source check: returns the current map of a source snapshot device. */
export function snapshotDeviceById(snapshot: ChainSnapshot, id: string): DeviceSnapshot | undefined {
    return snapshot.devices.find((d) => normalizeEntityId(d.sourceEntityId) === normalizeEntityId(id));
}