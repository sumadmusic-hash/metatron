/**
 * PHASE B — INSTRUMENT EXPORT: SOURCE → `InstrumentPreset v0.1`.
 *
 * Pure builder layer. There is NO target here: nothing is created, imported,
 * bound or mutated (no cloneChainFromSnapshot, no createEntity/createCable,
 * no BindingManager.setBinding, no NexusAdapter, no UI, no Storage).
 * READS from a live SOURCE document are supplied by the caller as the already
 * built `ChainSnapshot` + the Metatron `Device`/`Preset` + binding info.
 *
 * Export semantics (verbindliche Spec):
 *   - `sourceEntityIndex` is EXACTLY the index of the device inside
 *     `snapshot.devices` (the snapshot's DFS order), derived by matching the
 *     caller-provided project-specific `sourceEntityId` with the snapshot
 *     device ids. Both sides are normalized like the snapshot layer does
 *     (`normalizeEntityId`). The index is the ONLY identity that travels into
 *     the preset — a source entity id is a project-specific Audiotool id and
 *     is NEVER copied into the envelope.
 *   - `fieldPath` is taken verbatim from a `FieldSnapshot` that actually
 *     exists on the referenced snapshot device. No heuristics, no guessing.
 *   - `valueMapping` is derived from the FIELD SCHEMA ONLY via the pure
 *     `createNexusValueMappingFromSchema` (no live field, no DOM).
 *     Unsupported fields are an honest error, never a fake linear mapping.
 *   - Duplicate bindings for one control are an error — never silently merged
 *     or overwritten.
 *   - Every control keeps its normalized `controlValues` entry if it is a
 *     valid 0..1 number; invalid values are an error (no clamping).
 *
 * Result pattern: `{ ok: true, preset, warnings } | { ok: false, errors }`.
 * A missing value for a BOUND control is only a warning (the binding travels,
 * the value does not) — the chain/device structure is still fully usable.
 */
import type { Device } from "../model/Device";
import type { Preset } from "../model/Preset";
import { createNexusValueMappingFromSchema } from "../../nexus/NexusValueMapping";
import { normalizeEntityId } from "../../nexus/ChainDiscovery";
import type { ChainSnapshot, FieldSnapshot } from "../../nexus/ChainTypes";
import {
    INSTRUMENT_PRESET_VERSION,
    validateInstrumentPreset,
} from "./InstrumentPreset";
import type { InstrumentPreset, InstrumentPresetBinding } from "./InstrumentPreset";

/** Project-specific binding info READS (Phase B). The transient mapping
 *  (control → active device field) is the responsibility of the caller. */
export interface InstrumentPresetBindingSource {
    controlId: string;
    /** Project-specific document entity id of a device inside `snapshot`.
     *  Used ONLY to derive `sourceEntityIndex`; never stored in the envelope. */
    sourceEntityId: string;
    /** Human readable Nexus field path on that device, e.g. "filter.cutoffFrequencyHz". */
    fieldPath: string;
}

export interface InstrumentPresetExportInput {
    /** The Metatron instrument device being exported. */
    device: Device;
    /** The Metatron state snapshot to export (its controlValues). */
    preset: Preset;
    /** Real SOURCE chain, produced by `createSnapshot` (reused, not reimplemented). */
    snapshot: ChainSnapshot;
    /** Which device fields the (active) controls are bound to. */
    bindings: InstrumentPresetBindingSource[];
}

export type InstrumentPresetExportResult =
    | { ok: true; preset: InstrumentPreset; warnings: string[] }
    | { ok: false; errors: string[] };

const isFiniteNumber = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);

/** Schema-only value mapping for one captured field (no live Nexus). */
function mappingForField(field: FieldSnapshot): ReturnType<typeof createNexusValueMappingFromSchema> {
    return createNexusValueMappingFromSchema(
        field.range,
        typeof field.scalarType === "number" ? field.scalarType : undefined,
        field.primitiveType,
    );
}

export function exportInstrumentPreset(input: InstrumentPresetExportInput): InstrumentPresetExportResult {
    const warnings: string[] = [];
    const errors: string[] = [];

    if (!input || !input.device || !input.preset || !input.snapshot || !Array.isArray(input.bindings)) {
        return { ok: false, errors: ["export: device, preset, snapshot and bindings are required"] };
    }

    const { device, preset, snapshot, bindings } = input;

    // --- control values: validate every stored value, no clamping ---
    const controlValues: Record<string, number> = {};
    for (const [controlId, value] of Object.entries(preset.controlValues)) {
        if (!isFiniteNumber(value) || value < 0 || value > 1) {
            errors.push(`metatron.controlValues["${controlId}"]: expected a number in 0..1 (got ${String(value)})`);
            continue;
        }
        controlValues[controlId] = value;
    }

    // --- bindings: controlId exists → device index → field → pure mapping ---
    const snapshotById = new Map(
        snapshot.devices.map((snapDevice) => [normalizeEntityId(snapDevice.sourceEntityId), snapDevice]),
    );
    const deviceControlIds = new Set(device.controls.keys());
    const seenControls = new Set<string>();
    const exportedBindings: InstrumentPresetBinding[] = [];

    for (const binding of bindings) {
        const at = `bindings[${exportedBindings.length}]`;
        if (!binding || typeof binding.controlId !== "string" || binding.controlId.length === 0) {
            errors.push(`${at}: controlId: expected a non-empty string`);
            continue;
        }
        if (seenControls.has(binding.controlId)) {
            errors.push(`${at}: duplicate binding for control "${binding.controlId}" (no silent merge)`);
            continue;
        }
        seenControls.add(binding.controlId);

        if (!deviceControlIds.has(binding.controlId)) {
            errors.push(`${at}: control "${binding.controlId}" does not exist on device "${device.id}"`);
            continue;
        }
        if (!Object.prototype.hasOwnProperty.call(preset.controlValues, binding.controlId)) {
            warnings.push(`control "${binding.controlId}": no value in preset.controlValues — binding exported without a stored value`);
        }

        if (typeof binding.sourceEntityId !== "string" || binding.sourceEntityId.length === 0) {
            errors.push(`${at}: sourceEntityId: expected a non-empty string`);
            continue;
        }
        const snapDevice = snapshotById.get(normalizeEntityId(binding.sourceEntityId));
        if (!snapDevice) {
            errors.push(`${at}: source entity "${binding.sourceEntityId}" not found in snapshot.devices`);
            continue;
        }
        const sourceEntityIndex = snapshot.devices.indexOf(snapDevice);

        if (typeof binding.fieldPath !== "string" || binding.fieldPath.length === 0) {
            errors.push(`${at}.fieldPath: expected a non-empty string`);
            continue;
        }
        const field = snapDevice.fields.find((f) => f.path === binding.fieldPath);
        if (!field) {
            errors.push(`${at}.fieldPath: "${binding.fieldPath}" not found on snapshot.devices[${sourceEntityIndex}] (${snapDevice.entityType})`);
            continue;
        }

        const valueMapping = mappingForField(field);
        if (valueMapping.kind === "unsupported") {
            errors.push(`${at}.fieldPath: "${binding.fieldPath}" has no supported numeric mapping (${field.primitiveType ?? "unknown"}) — refusing a fake linear mapping`);
            continue;
        }

        exportedBindings.push({ controlId: binding.controlId, sourceEntityIndex, fieldPath: binding.fieldPath, valueMapping });
    }

    if (errors.length > 0) {
        return { ok: false, errors };
    }

    const result: InstrumentPreset = {
        version: INSTRUMENT_PRESET_VERSION,
        name: preset.name,
        metatron: {
            deviceId: device.id,
            presetId: preset.id,
            controlValues,
        },
        chain: { snapshot },
        bindings: exportedBindings,
    };

    // Safety belt: the produced envelope must pass the Phase-A validator.
    const validation = validateInstrumentPreset(result);
    if (!validation.valid) {
        return { ok: false, errors: validation.errors };
    }

    return { ok: true, preset: result, warnings };
}