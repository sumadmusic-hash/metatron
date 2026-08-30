import type { ChainSnapshot } from "../../nexus/ChainTypes";
import type { NexusValueMapping } from "../../nexus/NexusValueMapping";

/**
 * INSTRUMENT PRESET v0.1 — pure, serializable exchange model.
 *
 * Phase A: data model + serialization + validation only. There is NO import
 * flow here (no idMap, no clone chain, no BindingManager, no NexusAdapter).
 * This module must stay fully Nexus-free at runtime: all cross-module types
 * (`ChainSnapshot`, `NexusValueMapping`) are imported type-only and erased.
 *
 * Binding semantics (verbindliche Spec):
 *   - `sourceEntityIndex` is EXACTLY the index of the device inside
 *     `chain.snapshot.devices`. The index is the logical identity — never
 *     look up devices by name, type or any other heuristic.
 *   - `controlValues` are normalized numbers in 0..1 (switches: 0/1).
 *   - `deviceId` / `presetId` / `controlId` are Metatron-local ids only and
 *     must never be interpreted as Audiotool/Nexus entity ids.
 */

/** Accepted envelope format version. */
export const INSTRUMENT_PRESET_VERSION = "0.1";

/** One logical Metatron control → chain field binding. */
export interface InstrumentPresetBinding {
    controlId: string;
    /** Logical identity: index of the device inside `chain.snapshot.devices`. */
    sourceEntityIndex: number;
    /** Logical Nexus field path, e.g. "filter.cutoffFrequencyHz". */
    fieldPath: string;
    /** Reuses the existing NexusValueMapping model (no duplicate structure). */
    valueMapping: NexusValueMapping;
}

/** Serializable, Nexus-free exchange format of a complete Metatron instrument. */
export interface InstrumentPreset {
    version: "0.1";
    name: string;
    metatron: {
        deviceId: string;
        presetId: string;
        /** controlId → normalized value in 0..1 (switches stored as 0/1). */
        controlValues: Record<string, number>;
    };
    chain: {
        snapshot: ChainSnapshot;
    };
    bindings: InstrumentPresetBinding[];
}

/** Thrown by `parseInstrumentPreset` on malformed JSON or invalid content. */
export class InstrumentPresetError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InstrumentPresetError";
    }
}

export interface InstrumentPresetValidation {
    valid: boolean;
    /** Human readable problems; empty when `valid === true`. */
    errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

const MAPPING_KINDS = new Set(["linear", "boolean", "unsupported"]);

/**
 * Pure validation. Never mutates `input`. Never clamps values — out-of-range
 * control values are rejected, not adjusted. No live Nexus lookups, no
 * heuristics, no automatic mapping reconstruction.
 *
 * Bound of this phase (§7): `controlId` can only be checked for envelope-internal
 * consistency (non-empty, no duplicate bindings). Whether a control actually
 * exists belongs to the external Metatron device state and is NOT part of the
 * envelope model.
 */
export function validateInstrumentPreset(input: unknown): InstrumentPresetValidation {
    const errors: string[] = [];

    if (!isRecord(input)) {
        return { valid: false, errors: ["envelope: expected an object"] };
    }

    // --- Envelope ---
    if (input.version !== INSTRUMENT_PRESET_VERSION) {
        errors.push(`version: expected "${INSTRUMENT_PRESET_VERSION}"`);
    }
    if (!isNonEmptyString(input.name)) {
        errors.push("name: expected a non-empty string");
    }

    // --- metatron ---
    const metatron = input.metatron;
    if (!isRecord(metatron)) {
        errors.push("metatron: expected an object");
    } else {
        if (!isNonEmptyString(metatron.deviceId)) {
            errors.push("metatron.deviceId: expected a non-empty string");
        }
        if (!isNonEmptyString(metatron.presetId)) {
            errors.push("metatron.presetId: expected a non-empty string");
        }
        const controlValues = metatron.controlValues;
        if (!isRecord(controlValues)) {
            errors.push("metatron.controlValues: expected an object");
        } else {
            for (const [id, value] of Object.entries(controlValues)) {
                if (!isFiniteNumber(value) || value < 0 || value > 1) {
                    errors.push(`metatron.controlValues["${id}"]: expected a number in 0..1`);
                }
            }
        }
    }

    // --- chain.snapshot.devices (needed for binding index/path checks) ---
    const chain = input.chain;
    const devices: unknown[] = [];
    if (!isRecord(chain) || !isRecord(chain.snapshot) || !Array.isArray(chain.snapshot.devices)) {
        errors.push("chain.snapshot.devices: expected an array");
    } else {
        devices.push(...chain.snapshot.devices);
    }

    // --- bindings ---
    const bindings = input.bindings;
    const seenControls = new Set<string>();
    if (!Array.isArray(bindings)) {
        errors.push("bindings: expected an array");
    } else {
        bindings.forEach((binding, i) => {
            const at = `bindings[${i}]`;
            if (!isRecord(binding)) {
                errors.push(`${at}: expected an object`);
                return;
            }

            if (!isNonEmptyString(binding.controlId)) {
                errors.push(`${at}.controlId: expected a non-empty string`);
            } else if (seenControls.has(binding.controlId)) {
                errors.push(`${at}: duplicate binding for control "${binding.controlId}"`);
            } else {
                seenControls.add(binding.controlId);
            }

            if (!isFiniteNumber(binding.sourceEntityIndex) || !Number.isInteger(binding.sourceEntityIndex)) {
                errors.push(`${at}.sourceEntityIndex: expected an integer`);
            } else {
                const index = binding.sourceEntityIndex;
                if (index < 0 || index >= devices.length) {
                    errors.push(`${at}.sourceEntityIndex: ${index} out of range (devices.length=${devices.length})`);
                } else {
                    const device = devices[index];
                    if (!isRecord(device) || !Array.isArray(device.fields)) {
                        errors.push(`${at}: snapshot.devices[${index}] has no fields array`);
                    } else if (!isNonEmptyString(binding.fieldPath)) {
                        errors.push(`${at}.fieldPath: expected a non-empty string`);
                    } else {
                        const fieldExists = (device.fields as unknown[]).some(
                            (field) => isRecord(field) && field.path === binding.fieldPath,
                        );
                        if (!fieldExists) {
                            errors.push(`bindings[${i}].fieldPath: "${binding.fieldPath}" not found on snapshot.devices[${index}]`);
                        }
                    }
                }
            }

            const mapping = binding.valueMapping;
            if (!isRecord(mapping) || !isNonEmptyString(mapping.kind) || !MAPPING_KINDS.has(mapping.kind)) {
                errors.push(`${at}.valueMapping: expected a valid NexusValueMapping (kind "linear" | "boolean" | "unsupported")`);
            } else if (mapping.kind === "linear") {
                if (!isFiniteNumber(mapping.min) || !isFiniteNumber(mapping.max)) {
                    errors.push(`${at}.valueMapping: linear mapping requires numeric min/max`);
                } else if (mapping.min > mapping.max) {
                    errors.push(`${at}.valueMapping: min must be <= max`);
                }
            }
        });
    }

    return { valid: errors.length === 0, errors };
}

/** Deterministic JSON serialization. Contains no class instances, no live objects. */
export function serializeInstrumentPreset(preset: InstrumentPreset): string {
    return JSON.stringify(preset);
}

/** JSON parse + validation. Rejects malformed JSON, unknown version, missing version. */
export function parseInstrumentPreset(json: string): InstrumentPreset {
    let raw: unknown;
    try {
        raw = JSON.parse(json);
    } catch (error) {
        throw new InstrumentPresetError("InstrumentPreset: invalid JSON");
    }
    const validation = validateInstrumentPreset(raw);
    if (!validation.valid) {
        throw new InstrumentPresetError(`InstrumentPreset: ${validation.errors.join("; ")}`);
    }
    return raw as InstrumentPreset;
}