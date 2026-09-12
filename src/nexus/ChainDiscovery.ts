/**
 * CHAIN DISCOVERY ALGORITHM — pure, framework-free, unit-testable (production).
 *
 * No `@audiotool/nexus` import in this module on purpose: every function here
 * works on plain mockable data, which is what the "PROVEN BY OFFLINE TEST"
 * value comes from. The live layer (`ChainLive`) feeds REAL Nexus data into
 * these same functions.
 *
 * Provenance: this module is the productive twin of
 * `poc/chain-discovery/discovery.ts` + `poc/chain-discovery/types.ts`. The PoC
 * modules re-export from here so PoC tests keep running against the same
 * single source of truth.
 */

/** Default maximum traversal depth (section 12 — MAX_DEPTH). */
export const DEFAULT_MAX_DEPTH = 32;

/** Where a value / node description comes from — used by reports & logs. */
export type Provenance =
    | "PROVEN BY REAL NEXUS"
    | "PROVEN BY OFFLINE TEST"
    | "ASSUMED"
    | "NOT AVAILABLE"
    | "ENVIRONMENTAL BLOCK";

/** A normalized, display-ready audio / note device node. */
export interface AudioDeviceNode {
    /** Normalized (lower-case) Nexus entity id. */
    id: string;
    /** Nexus entity type key, e.g. "pulverisateur". */
    entityType: string;
    /** `displayName` field value, falls back to the entity type key. */
    displayName: string;
}

/** One side of an audio connection. */
export interface ConnectionEndpoint {
    /** Entity id of the owning device. */
    entityId: string;
    /** Human readable socket field, e.g. "audioOutput". */
    socketField: string;
    /** Full human readable socket location, e.g. "pulverisateur.audioOutput". */
    socketPath: string;
}

/** One normalized audio connection between two devices. */
export interface AudioConnection {
    id: string;
    from: ConnectionEndpoint;
    to: ConnectionEndpoint;
}

/** One chain member in traversal position. */
export interface ChainMember {
    position: number;
    node: AudioDeviceNode;
}

/** Result of a read-only chain traversal. */
export interface ChainResult {
    rootId: string;
    order: string[];
    chain: ChainMember[];
    usedConnections: AudioConnection[];
    maxDepth: number;
    truncated: boolean;
    visitedCount: number;
}

/** One automatable parameter with schema + provenance info. */
export interface ParameterInfo {
    fieldPath: string;
    value: unknown;
    scalarType?: string;
    range?: { min: number; max: number };
    defaultValue?: number | boolean;
    mutable: boolean;
    targetTypes: string[];
    provenance: Provenance;
}

/** Prefix that marks a normal (non-socket) path segment. */
export function parseSocketPath(path: string): { socketField: string } {
    const segments = path.split(/[./]/).filter((s) => s.length > 0);
    const socketField = segments.length > 0 ? segments[segments.length - 1] : "";
    return { socketField };
}

/** Normalize an entity id (uuids compare lower-case). */
export function normalizeEntityId(id: string | undefined | null): string {
    return (id ?? "").trim().toLowerCase();
}

/**
 * Normalize a raw entity into a display-ready node.
 * Falls back to the entity type key when `displayName` is missing.
 */
export function normalizeEntity(raw: {
    id?: string;
    entityType?: string;
    displayName?: string;
}): AudioDeviceNode | undefined {
    const id = normalizeEntityId(raw.id);
    const entityType = (raw.entityType ?? "").trim();
    if (!id && !entityType) return undefined;
    return { id, entityType, displayName: (raw.displayName ?? "").trim() || entityType };
}

/**
 * Turn one raw cable into a normalized `AudioConnection`.
 * Returns undefined for cables that don't carry both endpoints.
 */
export function normalizeCable(raw: {
    id?: string;
    fromEntityId?: string;
    toEntityId?: string;
    fromSocketPath?: string;
    toSocketPath?: string;
}): AudioConnection | undefined {
    const fromEntityId = normalizeEntityId(raw.fromEntityId);
    const toEntityId = normalizeEntityId(raw.toEntityId);
    if (!raw.id || !fromEntityId || !toEntityId) return undefined;
    const from: ConnectionEndpoint = {
        entityId: fromEntityId,
        socketField: parseSocketPath(raw.fromSocketPath ?? "").socketField,
        socketPath: (raw.fromSocketPath ?? "").trim(),
    };
    const to: ConnectionEndpoint = {
        entityId: toEntityId,
        socketField: parseSocketPath(raw.toSocketPath ?? "").socketField,
        socketPath: (raw.toSocketPath ?? "").trim(),
    };
    return { id: raw.id.trim(), from, to };
}

/** Normalize a batch of raw cables, dropping invalid entries. */
export function extractAudioConnections(rawCables: unknown[]): AudioConnection[] {
    const result: AudioConnection[] = [];
    for (const raw of rawCables) {
        const normalized = normalizeCable(raw as { id?: string; fromEntityId?: string; toEntityId?: string; fromSocketPath?: string; toSocketPath?: string });
        if (normalized) result.push(normalized);
    }
    return result;
}

interface EdgeRef {
    connection: AudioConnection;
    toEntityId: string;
}

/**
 * Read-only depth-first traversal.
 *
 * Guards:
 * - visited set prevents re-visiting any entity (duplicate protection);
 * - revisited edges are skipped (cycle protection);
 * - traversal stops at `maxDepth` (default 32);
 * - never mutates input (works on a fresh adjacency copy).
 */
export function traverseChain(
    connections: AudioConnection[],
    rootId: string,
    options?: { maxDepth?: number; nameOf?: (entityId: string) => string },
): ChainResult {
    const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
    const nameOf = options?.nameOf ?? ((id: string) => id);

    // Build adjacency: from entity id -> outgoing cables (in stable order).
    const adjacency = new Map<string, EdgeRef[]>();
    for (const conn of connections) {
        const from = normalizeEntityId(conn.from.entityId);
        const to = normalizeEntityId(conn.to.entityId);
        if (!from || !to) continue;
        const list = adjacency.get(from) ?? [];
        list.push({ connection: conn, toEntityId: to });
        adjacency.set(from, list);
    }

    const visited = new Set<string>();
    const order: string[] = [];
    const usedConnections: AudioConnection[] = [];
    let truncated = false;

    const root = normalizeEntityId(rootId);
    const stack: Array<{ entityId: string; depth: number }> = [{ entityId: root, depth: 0 }];

    while (stack.length > 0) {
        const { entityId, depth } = stack.pop()!;
        if (visited.has(entityId)) continue;
        visited.add(entityId);
        order.push(entityId);

        if (depth >= maxDepth) {
            truncated = true;
            continue;
        }

        const edges = adjacency.get(entityId) ?? [];
        // Reverse so the first cable is popped first (stable DFS order).
        for (let i = edges.length - 1; i >= 0; i--) {
            const edge = edges[i];
            const to = edge.toEntityId;
            if (visited.has(to)) continue;
            usedConnections.push(edge.connection);
            stack.push({ entityId: to, depth: depth + 1 });
        }
    }

    const chain: ChainMember[] = order.map((id, index) => ({
        position: index,
        node: normalizeEntity({ id, entityType: "", displayName: nameOf(id) }) ?? { id, entityType: "", displayName: id },
    }));

    return {
        rootId: root,
        order,
        chain,
        usedConnections,
        maxDepth,
        truncated,
        visitedCount: visited.size,
    };
}

/** Human readable chain, e.g. "1. Pulverisateur". */
export function chainToString(chain: ChainMember[]): string {
    return chain.map((m) => `${m.position + 1}. ${m.node.displayName || m.node.entityType || m.node.id}`).join("\n");
}

/**
 * Describe one parameter field from schema-derived data.
 * `details` mirrors the shape of `getSchemaLocationDetails(field.location)`
 * so the live layer can pass real Nexus data straight in.
 */
export function describeParameter(
    fieldPath: string,
    value: unknown,
    details: {
        targetTypes?: string[];
        immutable?: boolean;
        primitive?: {
            type?: string;
            scalarType?: string | number;
            default?: number | boolean;
            range?: { min: number; max: number };
        };
    },
    provenance: Provenance = "PROVEN BY REAL NEXUS",
): ParameterInfo {
    const primitive = details.primitive;
    const scalarKey = typeof primitive?.scalarType === "string" ? primitive.scalarType : String(primitive?.scalarType ?? "");
    return {
        fieldPath,
        value,
        scalarType: scalarKey || undefined,
        range: primitive?.range,
        defaultValue: primitive?.default,
        mutable: details.immutable !== true,
        targetTypes: details.targetTypes ?? [],
        provenance,
    };
}

/** True when a field is an automatable parameter per its schema target types. */
export function isAutomatable(targetTypes: string[] | undefined): boolean {
    return (targetTypes ?? []).includes("AutomatableParameter");
}

/** Result of a binding-based chain union (M19). */
export interface ChainUnionResult {
    /** Normalized selected device ids (bound seeds + reachable audio members), in discovery order. */
    devices: string[];
    /** Cables whose endpoints are both in the union (deduped, input order). */
    connections: AudioConnection[];
    /** Root candidates: selected devices with no incoming cable within the selected subgraph. */
    rootCandidates: string[];
    /** Depth limit that bounded every traversal. */
    maxDepth: number;
    /** True when any traversal hit the depth limit. */
    truncated: boolean;
}

/**
 * CHAIN UNION FROM BINDINGS (M19) — pure, framework-free, unit-testable.
 *
 * Given the normalized audio-cable set and the entity ids of Metatron-bound
 * devices, select the complete audio-chain union those controls need:
 *
 *   - for every bound device: traverse UPSTREAM through incoming audio cables
 *     to the devices that feed it, and DOWNSTREAM through outgoing audio cables
 *     to the devices it feeds;
 *   - a device with no incoming cable ends the upstream walk (root candidate);
 *   - a device with no outgoing cable is a SINK — downstream expansion stops
 *     there and never re-enters the sink's other feeders (shared mixers only
 *     contribute their connected subgraph, not every sibling input);
 *   - bound devices are always included, even with zero cables;
 *   - memberships are UNION-ed across all bound entities (no duplicates);
 *   - cables are returned only when BOTH endpoints are selected;
 *   - root candidates derive from the SELECTED subgraph, never from the
 *     original project's global roots.
 *
 * Purity guarantee: never mutates `cables` or `boundEntityIds`; builds fresh
 * adjacency maps (the incoming map is DERIVED from the same cable data — no
 * Nexus access); repeated calls with equal inputs return equal results.
 * Cycle-safe via a visited set; bounded by `maxDepth` (default = the same
 * limit used by `traverseChain`).
 */
export function chainUnionFromBindings(
    cables: AudioConnection[],
    boundEntityIds: string[],
    maxDepth: number = DEFAULT_MAX_DEPTH,
): ChainUnionResult {
    const outgoing = new Map<string, AudioConnection[]>();
    const incoming = new Map<string, AudioConnection[]>();
    const appendEdge = (map: Map<string, AudioConnection[]>, key: string, edge: AudioConnection) => {
        const list = map.get(key);
        if (list) list.push(edge);
        else map.set(key, [edge]);
    };

    for (const cable of cables) {
        const from = normalizeEntityId(cable.from.entityId);
        const to = normalizeEntityId(cable.to.entityId);
        if (!from || !to) continue;
        appendEdge(outgoing, from, cable);
        appendEdge(incoming, to, cable);
    }

    // Global membership: every discovered device is part of the union once.
    const discovered = new Set<string>();
    const devices: string[] = [];
    let truncated = false;

    /**
     * Direction-parameterized walk. `adjacency` + `next` select the direction:
     *   - downstream: outgoing map, next = cable.to.entityId
     *   - upstream:   incoming map, next = cable.from.entityId
     * A node with no edges in that direction naturally terminates the walk
     * (root for upstream, sink for downstream). Visited set → cycle safety.
     */
    const traverse = (start: string, adjacency: Map<string, AudioConnection[]>, next: (c: AudioConnection) => string) => {
        const queued = new Set<string>([start]);
        const queue: Array<{ id: string; depth: number }> = [{ id: start, depth: 0 }];
        while (queue.length > 0) {
            const { id, depth } = queue.shift()!;
            if (!discovered.has(id)) {
                discovered.add(id);
                devices.push(id);
            }
            if (depth >= maxDepth) {
                truncated = true;
                continue;
            }
            const edges = adjacency.get(id) ?? [];
            for (const edge of edges) {
                const nextId = normalizeEntityId(next(edge));
                if (!nextId || discovered.has(nextId) || queued.has(nextId)) continue;
                queued.add(nextId);
                queue.push({ id: nextId, depth: depth + 1 });
            }
        }
    };

    for (const boundRaw of boundEntityIds) {
        const bound = normalizeEntityId(boundRaw);
        if (!bound) continue;
        traverse(bound, incoming, (c) => c.from.entityId); // upstream → roots
        traverse(bound, outgoing, (c) => c.to.entityId);   // downstream → sinks
    }

    // Only cables whose endpoints are both selected; dedupe by cable id.
    const seenCables = new Set<string>();
    const connections: AudioConnection[] = [];
    for (const cable of cables) {
        const from = normalizeEntityId(cable.from.entityId);
        const to = normalizeEntityId(cable.to.entityId);
        if (!discovered.has(from) || !discovered.has(to)) continue;
        if (seenCables.has(cable.id)) continue;
        seenCables.add(cable.id);
        connections.push(cable);
    }

    const hasIncoming = new Set(connections.map((c) => normalizeEntityId(c.to.entityId)));
    const rootCandidates = devices.filter((id) => !hasIncoming.has(id));

    return { devices, connections, rootCandidates, maxDepth, truncated };
}