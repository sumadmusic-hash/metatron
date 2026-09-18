/**
 * METATRON MODULATION — modulation matrix type model (Phase 1).
 *
 * The matrix is the persistent shape of a Device's modulation configuration:
 * a fixed catalog of SOURCES + a fixed catalog of SLOTS. It is plain data —
 * created via `createDefaultMatrix`, cloned via `cloneModulationMatrix`, and
 * never touches the engine or the UI.
 */

/** Hard cap on modulation sources per device (deterministic upper bound). */
export const MAX_MOD_SOURCES = 10;

/** Hard cap on modulation slots per device (deterministic upper bound). */
export const MAX_MOD_SLOTS = 20;

/** Kind of a modulation source. LFO oscillates through its `waveform`
 *  (including the noise-like sampleHold/smoothRandom shapes), macro follows a
 *  bound control, random is pure seed-based noise. */
export type ModulatorType = "lfo" | "macro" | "random";

/** Waveform shapes. sampleHold holds one deterministic value per LFO period;
 *  smoothRandom linearly interpolates between consecutive held values. */
export type Waveform = "sine" | "triangle" | "saw" | "square" | "sampleHold" | "smoothRandom";

/** Persistent source definition. */
export interface ModSource {
    id: string;
    type: ModulatorType;
    waveform: Waveform;
    /** LFO frequency in Hz (used when `bpmSync` is false). */
    rateHz: number;
    /** Tempo-synced LFO: period derived from BPM instead of `rateHz`. */
    bpmSync: boolean;
    /** Optional fixed BPM reference for tempo-synced LFOs.
     *  undefined = follow the live transport BPM (readTempoBpm). */
    bpmOfSync?: number;
    /** Musical note division for tempo-synced LFOs (quarter notes default). */
    noteDivision: number;
    /** Phase offset in [0, 1). */
    phase: number;
    /** Random depth (noise sources scale their output by this). */
    drift: number;
    /** Macro control id for "macro" sources. Random sources deriven their
     *  seed namespace from their OWN id (FIX B4), NOT from this field. */
    sourceId: string;
    /** Random-source smoothing window in milliseconds ([0, 10000], default 200). */
    smoothMs: number;
}

/** Persistent slot definition: routes one source into one control. */
export interface ModSlot {
    id: string;
    enabled: boolean;
    /** Source id this slot reads from. */
    sourceId: string;
    /** Destination control id this slot writes to. */
    destControlId: string;
    /** Modulation depth — bipolar, clamped to [-1, 1]. */
    amount: number;
    /** How the slot applies its output onto the destination ("add" only). */
    mode: "add";
}

export interface ModulationMatrixConfig {
    /** Schema version of the matrix payload (currently 1). */
    version: 1;
    sources: ModSource[];
    slots: ModSlot[];
}

/** Factory for the inert default matrix: every source and every slot is
 *  switched off, so a freshly created Device modulates nothing. */
export function createDefaultMatrix(): ModulationMatrixConfig {
    const sources: ModSource[] = [];
    for (let i = 1; i <= MAX_MOD_SOURCES; i++) {
        sources.push({
            id: `mod${i}`,
            type: "lfo",
            waveform: "sine",
            rateHz: 1,
            bpmSync: false,
            noteDivision: 4,
            phase: 0,
            drift: 0.5,
            sourceId: "",
            smoothMs: 200,
        });
    }

    const slots: ModSlot[] = [];
    for (let i = 1; i <= MAX_MOD_SLOTS; i++) {
        slots.push({
            id: `slot${i}`,
            enabled: false,
            sourceId: `mod${((i - 1) % MAX_MOD_SOURCES) + 1}`,
            destControlId: "",
            amount: 0,
            mode: "add",
        });
    }

    return { version: 1, sources, slots };
}

/** Deep (one-level) clone so patches and stored matrices never alias live
 *  Device state. */
export function cloneModulationMatrix(matrix: ModulationMatrixConfig): ModulationMatrixConfig {
    return {
        version: matrix.version,
        sources: matrix.sources.map((s) => ({ ...s })),
        slots: matrix.slots.map((s) => ({ ...s })),
    };
}