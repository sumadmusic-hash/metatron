/**
 * FIELD-PATH RESOLVER — canonical production implementation.
 *
 * Resolves a human readable field path (`"."` object segments + `"[i]"`
 * array segments, e.g. `"filter.cutoffFrequencyHz"` or `"bands.[0].thresholdDb"`)
 * against an entity's `fields` container. Read-only.
 *
 * This is the SINGLE canonical resolver semantic: `NexusAdapter` (Step 4
 * consolidation) and the import path both navigate through here so no second,
 * subtly different resolver exists.
 *
 * Provenance: this module is the productive twin of `resolveFieldByPath` in
 * `poc/chain-clone/clone.ts`. `InstrumentPresetImport` historically imported it
 * from the PoC; production now resolves through this module directly.
 */
export function resolveFieldByPath(fields: any, path: string): any | undefined {
    const segments = path.split(".").filter((s) => s.length > 0);
    let cur: any = fields;
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const arrayHit = /^\[(\d+)\]$/.exec(seg);
        if (arrayHit) {
            const idx = Number(arrayHit[1]);
            const arr = cur?.array ?? cur;
            cur = Array.isArray(arr) ? arr[idx] : undefined;
            if (cur === undefined) return undefined;
            // NexusObject array items keep their child fields in a `fields`
            // container (`bands.array[0].fields.thresholdDb`), so the path
            // `bands.[0].thresholdDb` must descend into it like any object.
            const hasMore = segments[i + 1] !== undefined;
            const nextIsIndex = hasMore && /^\[\d+\]$/.test(segments[i + 1]);
            if (hasMore && !nextIsIndex && cur && typeof cur === "object" && "fields" in cur && cur.fields && !("value" in cur)) {
                cur = cur.fields;
            }
            continue;
        }
        const next = cur?.[seg];
        if (next === undefined) return undefined;
        cur = next;
        // Descend into object containers for intermediate segments only.
        if (i < segments.length - 1 && cur && typeof cur === "object" && "fields" in cur && cur.fields && !("value" in cur)) {
            cur = cur.fields;
        }
    }
    return cur;
}