import {
    MAX_MOD_SLOTS,
    MAX_MOD_SOURCES,
    cloneModulationMatrix,
    createDefaultMatrix,
} from "./ModulationTypes";
import type {
    ModSlot,
    ModSource,
    ModulationMatrixConfig,
} from "./ModulationTypes";

/**
 * METATRON MODULATION — persistence layer (FIX 4 "Don't-Trust-Persistence").
 *
 * The matrix is stored inside the serialized Device payload, i.e. it arrives
 * from LocalStorage on every load. That payload is arbitrary JSON that may be
 * old, hand-edited, or corrupt, so the parse path is HIGH-DEFENSIVE:
 * `parseModulationMatrix` sanitizes every field and never throws for malformed
 * field VALUES. It throws `ModulationConfigError` ONLY for structurally invalid
 * configs (too many sources / too many slots), which the model's deserialize
 * path catches and falls back to the default matrix for.
 */

/** Thrown when a persisted modulation configuration is structurally invalid
 *  (source/slot counts beyond the hard caps). Callers decide the fallback. */
export class ModulationConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ModulationConfigError";
    }
}

function clamp(v: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, v));
}

/** Finite-or-default number helper. `null` and `""` coerce to 0 via Number(),
 *  so they are treated as absent and get the fallback. */
function finiteNum(value: unknown, fallback: number): number {
    if (value === null || value === undefined || value === "") return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return n;
}

/** LFO rate: absent/garbage → 1 Hz, out-of-range values clamped to [0.01, 20]. */
function sanitizeRate(value: unknown): number {
    return clamp(finiteNum(value, 1), 0.01, 20);
}

/** Bipolar amount: absent/garbage → 0, values clamped to [-1, 1]. */
function sanitizeAmount(value: unknown): number {
    return clamp(finiteNum(value, 0), -1, 1);
}

/** Phase: absent/garbage → 0, values clamped to [0, 1]. */
function clampPhase(value: unknown): number {
    return clamp(finiteNum(value, 0), 0, 1);
}

function sanitizeSource(source: unknown, index: number): ModSource {
    const record = (typeof source === "object" && source !== null ? source : {}) as Record<string, unknown>;
    const id = typeof record.id === "string" && record.id.length > 0 ? record.id : `mod${index + 1}`;
    const type: ModSource["type"] =
        record.type === "macro" || record.type === "random" ? record.type : "lfo";
    const waveform: ModSource["waveform"] =
        record.waveform === "sine" ||
        record.waveform === "triangle" ||
        record.waveform === "saw" ||
        record.waveform === "square" ||
        record.waveform === "sampleHold" ||
        record.waveform === "smoothRandom"
            ? record.waveform
            : "sine";
    return {
        id,
        type,
        waveform,
        rateHz: sanitizeRate(record.rateHz),
        bpmSync: record.bpmSync === true,
        bpmOfSync:
            typeof record.bpmOfSync === "number" && Number.isFinite(record.bpmOfSync) && record.bpmOfSync > 0
                ? record.bpmOfSync
                : undefined,
        noteDivision: Math.max(1, Math.round(finiteNum(record.noteDivision, 4))),
        phase: clampPhase(record.phase),
        drift: clamp(finiteNum(record.drift, 0.5), 0, 1),
        enabled: record.enabled === true,
        sourceId: typeof record.sourceId === "string" ? record.sourceId : "",
        smoothMs: Math.min(10000, Math.max(0, finiteNum(record.smoothMs, 200))),
    };
}

function sanitizeSlot(slot: unknown, index: number): ModSlot {
    const record = (typeof slot === "object" && slot !== null ? slot : {}) as Record<string, unknown>;
    const id = typeof record.id === "string" && record.id.length > 0 ? record.id : `slot${index + 1}`;
    return {
        id,
        enabled: record.enabled === true,
        sourceId: typeof record.sourceId === "string" ? record.sourceId : "",
        destControlId: typeof record.destControlId === "string" ? record.destControlId : "",
        amount: sanitizeAmount(record.amount),
        mode: "add",
    };
}

/** Parse a persisted matrix: sanitize every field, never throw for malformed
 *  field values. Falls back to the default matrix for absent payloads and
 *  throws `ModulationConfigError` only when the structural caps are exceeded.
 *  The resulting arrays are ALWAYS full (10 sources / 20 slots): indices not
 *  covered by the payload keep their default entries (default fill). */
export function parseModulationMatrix(value: unknown): ModulationMatrixConfig {
    const config = (typeof value === "object" && value !== null ? value : null) as
        | Record<string, unknown>
        | null;
    const sources = config && Array.isArray(config.sources) ? (config.sources as unknown[]) : undefined;
    const slots = config && Array.isArray(config.slots) ? (config.slots as unknown[]) : undefined;
    if (!sources && !slots) {
        return createDefaultMatrix();
    }
    if (sources && sources.length > MAX_MOD_SOURCES) {
        throw new ModulationConfigError(
            `modulation matrix: too many sources (${sources.length} > ${MAX_MOD_SOURCES})`,
        );
    }
    if (slots && slots.length > MAX_MOD_SLOTS) {
        throw new ModulationConfigError(
            `modulation matrix: too many slots (${slots.length} > ${MAX_MOD_SLOTS})`,
        );
    }
    const matrix = createDefaultMatrix();
    if (sources) {
        sources.forEach((s, i) => { matrix.sources[i] = sanitizeSource(s, i); });
    }
    if (slots) {
        slots.forEach((s, i) => { matrix.slots[i] = sanitizeSlot(s, i); });
    }
    const seenSources = new Set<string>();
    for (let i = 0; i < matrix.sources.length; i++) {
        const s = matrix.sources[i];
        if (seenSources.has(s.id)) {
            let candidate = `mod${i + 1}`;
            let k = 0;
            while (seenSources.has(candidate)) candidate = `mod${i + 1}#${++k}`;
            s.id = candidate;
        }
        seenSources.add(s.id);
    }
    const seenSlots = new Set<string>();
    for (let i = 0; i < matrix.slots.length; i++) {
        const s = matrix.slots[i];
        if (seenSlots.has(s.id)) {
            let candidate = `slot${i + 1}`;
            let k = 0;
            while (seenSlots.has(candidate)) candidate = `slot${i + 1}#${++k}`;
            s.id = candidate;
        }
        seenSlots.add(s.id);
    }
    return matrix;
}

/** Serialize the current matrix into the Device payload shape. Returns a
 *  clone so the stored JSON can never alias the live Device matrix. */
export function serializeModulationMatrix(matrix: ModulationMatrixConfig): unknown {
    return cloneModulationMatrix(matrix);
}