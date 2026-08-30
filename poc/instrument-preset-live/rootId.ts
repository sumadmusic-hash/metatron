/**
 * LIVE/UI — pure TARGET-root derivation.
 *
 * Maps the SOURCE root device id (phase 1+2 discovery root) through the
 * Phase-C source→target `idMap` to the TARGET root device id. Pure and
 * data-driven: no name, displayName or ordering heuristics. Returns
 * `undefined` when the SOURCE root or the mapping is absent — the caller must
 * NOT fabricate a root in that case.
 */

import { normalizeEntityId } from "../chain-discovery/discovery";

export type SourceToTargetIdMap = Record<string, string> | ReadonlyMap<string, string>;

/** TARGET root = idMap[normalizeEntityId(sourceRoot)]; undefined when unknown. */
export function resolveTargetRootId(
    sourceRoot: string | undefined,
    idMap: SourceToTargetIdMap,
): string | undefined {
    if (!sourceRoot) return undefined;
    const key = normalizeEntityId(sourceRoot);
    if (idMap instanceof Map) return idMap.get(key);
    const record = idMap as Record<string, string>;
    return record[key] ?? undefined;
}