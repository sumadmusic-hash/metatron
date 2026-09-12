import type { Control } from "../core/model/Control";
import { shortenParameterName } from "./ParameterShortener";

/**
 * M4 — automatic control naming after a successful Audiotool Learn.
 *
 * Generated control name: the shortened last segment of the Audiotool
 * `fieldPath` (e.g. `filter.cutoffFrequency` → `Cutoff`). An empty/missing
 * `fieldPath` falls back to the entity display name or entity type key.
 *
 * Eligibility is governed by the `nameSource` introduced in M3:
 * - "manual" → NEVER overwritten (explicit user rename wins).
 * - "auto"   → automatic naming allowed (assigned name keeps the source "auto").
 * - undefined → legacy/new control without a manual marker; eligible for
 *   automatic Learn naming on the first pass.
 *
 * This module only assigns names; it never touches binding state, value
 * mappings, subscriptions or `audiotoolBindingDefinition`.
 */

/**
 * Reads the human-readable entity name from a live Nexus document.
 * Returns `undefined` when the entity or the field is missing/non-string.
 */
export function resolveEntityDisplayName(document: unknown, entityId: string): string | undefined {
    const doc = document as
        | { queryEntities?: { getEntity?: (id: string) => { fields?: any } } }
        | undefined;
    if (!doc?.queryEntities?.getEntity) return undefined;
    const entity = doc.queryEntities.getEntity(entityId);
    const value = entity?.fields?.displayName?.value;
    return typeof value === "string" ? value : undefined;
}

/**
 * Builds the generated control name from the last segment of `fieldPath`,
 * shortened for display (M4.4). An empty/whitespace-only path falls back to
 * the entity display name, then to `entityType`. No label translation is
 * attempted and the original `fieldPath` is never modified.
 */
export function buildLearnedControlName(
    entityDisplayName: string | undefined,
    entityType: string,
    fieldPath: string,
): string {
    const trimmed = fieldPath.trim();
    if (trimmed) {
        const segments = trimmed.split(".");
        const last = segments[segments.length - 1];
        if (last.trim()) return shortenParameterName(last);
    }
    return (entityDisplayName ?? "").trim() || entityType;
}

/**
 * Assigns the generated name to a control when automatic naming is permitted.
 * Only controls explicitly renamed by the user ("manual") are rejected.
 * Returns true when the name was applied (and nameSource becomes "auto").
 */
export function applyLearnedControlName(control: Control, name: string): boolean {
    if (control.nameSource === "manual") return false;
    control.name = name;
    control.nameSource = "auto";
    return true;
}