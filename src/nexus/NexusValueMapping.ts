import { getSchemaLocationDetails } from "@audiotool/nexus/document";

/**
 * Generic value mapping between the normalized Metatron control range
 * (0.0 … 1.0) and the real Nexus parameter space.
 *
 * THE ONLY SUPPORTED TRANSFORMATION IS A PROVEN LINEAR MAP over the field's
 * schema-declared range (guaranteed by the @audiotool/nexus API via
 * `getSchemaLocationDetails(location).primitive.range`). No name-based /
 * heuristic logarithmic scaling is applied — the API does not expose a scale
 * kind, so v0.1 deliberately does not invent one (§6).
 *
 * Guaranteed API metadata (v0.0.17, verified against the dist source):
 *   number  → `primitive: { type:"number", scalarType, default, range:{min,max} }`
 *   boolean → `primitive: { type:"boolean", scalarType:Bool, default }`
 *   string  → `primitive: { type:"string", maxByteLength }` (no numeric mapping)
 * There is NO `step` and NO enum value list in the API. Integer scalar types
 * are rounded; enum-like dropdown nodes are mapped numerically over their
 * integer range (§7 limitation, documented).
 */

export type NexusValueMappingKind = "linear" | "boolean" | "unsupported";

export interface NexusValueMapping {
    kind: NexusValueMappingKind;
    /** Linear: the Nexus parameter range. */
    min?: number;
    max?: number;
    /** Linear: true when the field is an integral scalar type (round on write). */
    isInteger?: boolean;
    /** Primitive type label, purely for diagnostics. */
    typeLabel?: string;
}

/** @bufbuild/protobuf ScalarType numeric values (INT* = integral). */
const INTEGER_SCALAR_TYPES = new Set([3, 4, 5, 6, 7, 13, 15, 16, 17, 18]);

const clamp = (v: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, v));

/** Derives the value mapping from a real Nexus field object (schema-backed).
 *  Never throws; returns `unsupported` when the schema is unavailable. */
export function createNexusValueMapping(field: any): NexusValueMapping {
    try {
        const details = getSchemaLocationDetails(field?.location) as any;
        if (!details || details.type !== "primitive") {
            return { kind: "unsupported", typeLabel: "non-primitive" };
        }
        const p = (details as any).primitive;
        if (!p) return { kind: "unsupported", typeLabel: "no-primitive" };

        if (p.type === "boolean") return { kind: "boolean", typeLabel: "boolean" };

        if (p.type === "number") {
            const range: { min: number; max: number } | undefined = p.range;
            const min = range?.min ?? 0;
            const max = range?.max ?? 0;
            const isInteger = INTEGER_SCALAR_TYPES.has(p.scalarType);
            if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
                return { kind: "unsupported", min, max, isInteger, typeLabel: "number" };
            }
            return { kind: "linear", min, max, isInteger, typeLabel: "number" };
        }

        return { kind: "unsupported", typeLabel: p.type ?? "other" };
    } catch (e) {
        return { kind: "unsupported", typeLabel: "schema-unavailable" };
    }
}

/** Pure schema-derived mapping for offline export: derives the value mapping
 *  from the FIELD SCHETMA ONLY (no live field object, no DOM, no Nexus
 *  connection). Returned by `createSnapshot` as `range` + `scalarType` +
 *  `primitiveType` (chain-discovery/describeParameter).
 *  Never throws; mirrors `createNexusValueMapping`'s semantics exactly:
 *  - primitiveType "boolean" → boolean
 *  - primitiveType "number"  → linear over range, rounded when integral
 *  - anything else / missing range → unsupported (the exporter must refuse).
 *  No heuristic non-linear scaling is invented (§6, §7). */
export function createNexusValueMappingFromSchema(
    range: { min?: number; max?: number } | undefined,
    scalarType: number | undefined,
    primitiveType: string | undefined
): NexusValueMapping {
    if (primitiveType === "boolean") return { kind: "boolean", typeLabel: "boolean" };

    if (primitiveType === "number") {
        const min = range?.min;
        const max = range?.max;
        const isInteger = INTEGER_SCALAR_TYPES.has(scalarType ?? -1);
        if (
            typeof min === "number" && Number.isFinite(min) &&
            typeof max === "number" && Number.isFinite(max) &&
            min <= max
        ) {
            return { kind: "linear", min, max, isInteger, typeLabel: "number" };
        }
        return { kind: "unsupported", min, max, isInteger, typeLabel: "number" };
    }

    return { kind: "unsupported", typeLabel: primitiveType ?? "unknown" };
}

/** WRITE: normalized 0..1 → Nexus parameter value.
 *  - linear: min + n * (max - min), clamped into the Nexus range,
 *    rounded to an integer for integral fields.
 *  - boolean: true when n >= 0.5.
 *  - unsupported: undefined (the caller must refuse the write). */
export function mapNormalizedToNexus(
    mapping: NexusValueMapping,
    normalized: number
): number | boolean | undefined {
    const n = clamp(Number(normalized) || 0, 0, 1);
    switch (mapping.kind) {
        case "boolean":
            return n >= 0.5;
        case "linear": {
            const min = mapping.min ?? 0;
            const max = mapping.max ?? 0;
            if (max <= min) return min; // degenerate range
            const raw = min + n * (max - min);
            const out = mapping.isInteger ? Math.round(raw) : raw;
            return clamp(out, min, max);
        }
        default:
            return undefined;
    }
}

/** READ: Nexus parameter value → normalized 0..1.
 *  - boolean: 0/1.
 *  - linear: (raw - min) / (max - min), clamped to 0..1.
 *  - unsupported/degenerate/non-finite: 0. */
export function mapNexusToNormalized(
    mapping: NexusValueMapping,
    raw: any
): number {
    switch (mapping.kind) {
        case "boolean":
            return raw ? 1 : 0;
        case "linear": {
            const min = mapping.min ?? 0;
            const max = mapping.max ?? 0;
            const r = Number(raw);
            if (!Number.isFinite(r)) return 0;
            if (max <= min) return 0;
            return clamp((r - min) / (max - min), 0, 1);
        }
        default:
            return 0;
    }
}