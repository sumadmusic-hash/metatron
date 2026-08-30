/**
 * LIVE NEXUS LAYER — READ-ONLY (production).
 *
 * This module is the ONLY place that touches the real `@audiotool/nexus`
 * document API. Every function here reads; none writes.
 *
 * READ-ONLY GUARANTEE: this file never calls `document.modify`,
 * `createTransaction`, `create`, `update`, `remove`, `clone`, or the preset
 * APIs. It only uses:
 *   - `document.queryEntities` / `document.queryEntitiesWithoutLock`
 *   - `entity.fields` (reads)
 *   - `getSchemaLocationDetails(location)` (schema metadata)
 *   - `schemaLocationToSchemaPath(location)` (human readable paths)
 *
 * Provenance: this module is the productive twin of
 * `poc/chain-discovery/live.ts`. The PoC module re-exports from here so PoC
 * tests keep running against the same single source of truth.
 */

import { getSchemaLocationDetails, schemaLocationToSchemaPath } from "@audiotool/nexus/document";
import type { SyncedDocument } from "@audiotool/nexus";
import {
    describeParameter,
    extractAudioConnections,
    isAutomatable,
    normalizeEntity,
    traverseChain,
} from "./ChainDiscovery";
import type { AudioConnection, AudioDeviceNode, ChainResult, ParameterInfo, Provenance } from "./ChainDiscovery";

const LOG = "[METATRON CHAIN DISCOVERY]";

/** A discovered entity plus its schema target types. */
export interface DiscoveredEntity extends AudioDeviceNode {
    targetTypes: string[];
    schemaTypeKey: string;
    mutable: boolean;
}

/** Raw cable shape as expected by `extractAudioConnections`. */
export interface RawCable {
    id: string;
    fromEntityId: string;
    toEntityId: string;
    fromSocketPath: string;
    toSocketPath: string;
}

/** Human readable path helper. Returns "" when Nexus can't render one. */
function humanPath(location: any): string {
    if (!location) return "";
    try {
        const p = schemaLocationToSchemaPath(location);
        return typeof p === "string" ? p.replace(/^\//, "") : "";
    } catch {
        try {
            return String(location.toString?.() ?? "").replace(/^\//, "");
        } catch {
            return "";
        }
    }
}

function listAllEntities(doc: SyncedDocument): any[] {
    try {
        return (doc.queryEntities as any).get();
    } catch {
        try {
            return (doc as any).queryEntitiesWithoutLock?.ofTypes ? (doc as any).queryEntitiesWithoutLock.get() : [];
        } catch {
            return [];
        }
    }
}

/** Read every entity of the connected project (read only). */
export function listEntitiesLive(doc: SyncedDocument): DiscoveredEntity[] {
    const out: DiscoveredEntity[] = [];
    for (const entity of listAllEntities(doc)) {
        const fields = entity.fields ?? {};
        const details = safeDetails(entity.location);
        const schemaTypeKey = details?.type === "entity" ? (details as any).typeKey : "";
        const targetTypes: string[] = details?.type === "entity" ? (details as any).targetTypes ?? [] : [];
        const displayName = typeof fields.displayName === "object" && "value" in fields.displayName
            ? String((fields.displayName as any).value ?? "")
            : "";
        const node = normalizeEntity({ id: entity.id, entityType: entity.entityType, displayName });
        if (!node) continue;
        out.push({ ...node, targetTypes, schemaTypeKey, mutable: (details as any)?.immutable !== true });
    }
    return out;
}

/** Read every entity that exposes at least one audio/notes socket. */
export function listAudioDevicesLive(doc: SyncedDocument): DiscoveredEntity[] {
    return listEntitiesLive(doc).filter((e) => {
        const entity = (doc.queryEntities as any).getEntity(e.id);
        return entity ? hasAudioSocket(entity) : false;
    });
}

/** True when the entity carries an AudioInput/AudioOutput/NotesInput socket field. */
export function hasAudioSocket(entity: any): boolean {
    const SOCKET_TARGETS = ["AudioInput", "AudioOutput", "NotesInput"];
    let found = false;
    function visit(obj: any, seen = new Set<string>()): boolean {
        if (!obj || typeof obj !== "object" || found) return found;
        for (const fieldRaw of Object.values(obj)) {
            if (!fieldRaw || typeof fieldRaw !== "object") continue;
            const field: any = fieldRaw;
            if (field.location) {
                const sig = `${field.location.entityId ?? ""}:${(field.location.fieldIndex ?? []).join(",")}`;
                if (seen.has(sig)) continue;
                seen.add(sig);
                const details = safeDetails(field.location);
                const targets: string[] = details?.targetTypes ?? [];
                if (SOCKET_TARGETS.some((t) => targets.includes(t))) {
                    found = true;
                    return found;
                }
            }
            if (field.fields) visit(field.fields, seen);
            if (field.array && Array.isArray(field.array)) field.array.forEach((item: any) => visit({ item }, seen));
        }
        return found;
    }
    visit(entity.fields);
    return found;
}

/** Read every DesktopAudioCable of the project (read only). */
export function listCablesLive(doc: SyncedDocument): RawCable[] {
    const out: RawCable[] = [];
    let cables: any[] = [];
    try {
        cables = listAllEntities(doc); // fallback: filter below
    } catch {
        // no-op
    }
    if ((doc.queryEntities as any).ofTypes) {
        try {
            cables = (doc.queryEntities as any).ofTypes("desktopAudioCable").get();
        } catch {
            cables = [];
        }
    }
    for (const cable of cables) {
        if (cable.entityType !== "desktopAudioCable") continue;
        const fields = cable.fields ?? {};
        const fromSocket = fields.fromSocket?.value;
        const toSocket = fields.toSocket?.value;
        if (!fromSocket?.entityId || !toSocket?.entityId) continue;
        out.push({
            id: String(cable.id ?? ""),
            fromEntityId: fromSocket.entityId,
            toEntityId: toSocket.entityId,
            fromSocketPath: humanPath(fromSocket),
            toSocketPath: humanPath(toSocket),
        });
    }
    return out;
}

/**
 * Read-only chain discovery over the REAL document.
 * Returns the normalized connections AND the traversal result.
 */
export function discoverChainLive(
    doc: SyncedDocument,
    rootId: string,
    maxDepth?: number,
): { connections: AudioConnection[]; result: ChainResult } {
    const connections = extractAudioConnections(listCablesLive(doc));
    const byId = new Map<string, DiscoveredEntity>(listEntitiesLive(doc).map((e) => [e.id, e]));
    const nameOf = (id: string) => byId.get(id)?.displayName || byId.get(id)?.entityType || id;
    const result = traverseChain(connections, rootId, { maxDepth, nameOf });
    console.log(`${LOG} chain traversal: depth=${maxDepth ?? "default"} visited=${result.visitedCount} truncated=${result.truncated}`);
    return { connections, result };
}

/** A primitive field + its schema details, shared by parameter discovery. */
export interface FieldHit {
    fieldPath: string;
    field: any;
    details: any;
}

export function walkFields(root: any, basePath: string, collect: (hit: FieldHit) => void, seen = new Set<string>()): void {
    if (!root || typeof root !== "object") return;
    for (const [name, fieldRaw] of Object.entries(root)) {
        if (!fieldRaw || typeof fieldRaw !== "object") continue;
        const field: any = fieldRaw;
        const path = basePath ? `${basePath}.${name}` : name;
        if ("location" in field) {
            const sig = `${field.location.entityId ?? ""}:${(field.location.fieldIndex ?? []).join(",")}`;
            if (seen.has(sig)) continue;
            seen.add(sig);
        }
        if ("value" in field && "location" in field) {
            if (name === "id") continue;
            const details = safeDetails(field.location);
            collect({ fieldPath: path, field, details });
        } else if ("fields" in field) {
            walkFields(field.fields, path, collect, seen);
        } else if ("array" in field) {
            (field.array as any[]).forEach((item, i) => walkFields({ [`[${i}]`]: item }, path, collect, seen));
        }
    }
}

function safeDetails(location: any) {
    try {
        return getSchemaLocationDetails(location);
    } catch {
        return null;
    }
}

export { safeDetails };

/** Read the automatable parameters of one entity (read only, schema real). */
export function listParametersLive(doc: SyncedDocument, entityId: string): ParameterInfo[] {
    const entity = (doc.queryEntities as any).getEntity(entityId);
    if (!entity) return [];
    const out: ParameterInfo[] = [];
    walkFields(entity.fields, "", (hit) => {
        if (!isAutomatable(hit.details?.targetTypes)) return;
        const valueType = hit.field.value;
        out.push(
            describeParameter(hit.fieldPath, valueType, hit.details ?? {}, "PROVEN BY REAL NEXUS"),
        );
    });
    return out;
}

/** Read current values of all automatable parameters of an entity. */
export function listCurrentValuesLive(doc: SyncedDocument, entityId: string): ParameterInfo[] {
    return listParametersLive(doc, entityId);
}

/** Child helper: is `details` (a FieldHit details) automatable? Re-exported for tests. */
export function detailsAreAutomatable(details: any): boolean {
    return isAutomatable(details?.targetTypes);
}

/** Empty-result guard: what to print when Nexus provides no data. */
export function notAvailable(label: string): { label: string; provenance: Provenance } {
    return { label, provenance: "NOT AVAILABLE" };
}