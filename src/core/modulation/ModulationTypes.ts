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

/** Kind of a modulation source. LFO waveforms oscillate; sampleHold and
 *  smoothRandom produce stepped/hold noise; macro follows a bound control;
 *  random is pure seed-based noise. */
export type ModulatorType = "lfo" | "sampleHold" | "smoothRandom" | "macro" | "random";

export type Waveform = "sine" | "triangle" | "saw" | "square";

/** Persistent source definition. */
export interface ModSource {
    id: string;
    type: ModulatorType;
    waveform: Waveform;
    /** LFO frequency in Hz (used when `bpmSync` is false). */
    rateHz: number;
    /** Tempo-synced LFO: period derived from BPM instead of `rateHz`. */
    bpmSync: boolean;
    /** BPM reference for tempo-synced LFOs. */
    bpmOfSync: number;
    /** Musical note division for tempo-synced LFOs (quarter notes default). */
    noteDivision: number;
    /** Phase offset in [0, 1). */
    phase: number;
    /** Random depth (noise sources scale their output by this). */
    drift: number;
    /** Whether the source is currently part of the live engine evaluation. */
    disabled: boolean;
    /** Reference key: macro control id for "macro", seed namespace for noise. */
    sourceId: string;
    /** Hold/noise sample rate in Hz (how often a new random value is drawn). */
    sampleRate: number;
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
}

export interface ModulationMatrixConfig {
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
            bpmOfSync: 120,
            noteDivision: 4,
            phase: 0,
            drift: 0,
            disabled: true,
            sourceId: "",
            sampleRate: 0.1,
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
        });
    }

    return { sources, slots };
}

/** Deep (one-level) clone so patches and stored matrices never alias live
 *  Device state. */
export function cloneModulationMatrix(matrix: ModulationMatrixConfig): ModulationMatrixConfig {
    return {
        sources: matrix.sources.map((s) => ({ ...s })),
        slots: matrix.slots.map((s) => ({ ...s })),
    };
}