import type { SyncedDocument } from "@audiotool/nexus";
import { Preset } from "../core/model/Preset";
import type { Device } from "../core/model/Device";
import type { BindingManager } from "../core/BindingManager";
import { parseInstrumentPreset } from "../core/instrument/InstrumentPreset";
import type { InstrumentPreset } from "../core/instrument/InstrumentPreset";
import {
    exportInstrumentPreset,
    type InstrumentPresetBindingSource,
} from "../core/instrument/InstrumentPresetExport";
import type { InstrumentPresetExportResult } from "../core/instrument/InstrumentPresetExport";
import {
    importInstrumentPreset,
    type InstrumentImportResult,
} from "../core/instrument/InstrumentPresetImport";
import { createSnapshot } from "../nexus/ChainSnapshot";
import type { ChainSnapshot } from "../nexus/ChainTypes";
import { listAudioDevicesLive, listCablesLive } from "../nexus/ChainLive";
import type { RawCable } from "../nexus/ChainLive";
import { normalizeEntityId } from "../nexus/ChainDiscovery";
import type { AudioDeviceNode } from "../nexus/ChainDiscovery";
import {
    InstrumentPresetLibrary,
    type InstrumentPresetLibraryEntry,
} from "../persistence/InstrumentPresetLibrary";

/**
 * INSTRUMENT PRESET INTEGRATION — thin production orchestration (P1/P2).
 *
 * Wires the PROVEN engines (`exportInstrumentPreset`, `importInstrumentPreset`,
 * `createSnapshot`, `serializeInstrumentPreset`, `parseInstrumentPreset`) into
 * the connected Audiotool project (the single production document) and the
 * local `InstrumentPresetLibrary` persistence (D1).
 *
 * Mutation boundaries (unchanged):
 *   - EXPORT reads the SOURCE document only (no modify/create/update).
 *   - IMPORT mutates ONLY the TARGET document + the transient BindingManager,
 *     through the existing `importInstrumentPreset` engine.
 *
 * No source ids travel into the envelope; no name/displayName search; no
 * user-entered entity ids; no `targetRootEntityId`.
 */

export interface InstrumentExportOutcome {
    ok: boolean;
    entry?: InstrumentPresetLibraryEntry;
    preset?: InstrumentPreset;
    warnings?: string[];
    errors?: string[];
}

export interface InstrumentImportOutcome {
    ok: boolean;
    /** Present when the import engine ran (a result object, ok or not). */
    import?: InstrumentImportResult;
    /** Pre-engine failures (missing entry / invalid envelope / no target). */
    errors?: string[];
}

/** Pure, deterministic root selection: the first audio device (document query
 *  order) with no incoming audio cable. Falls back to the first audio device
 *  for closed chains where every device has an input. Never searches names,
 *  never guesses ids. */
export function selectRootId(devices: AudioDeviceNode[], cables: RawCable[]): string | undefined {
    if (devices.length === 0) return undefined;
    const deviceIds = new Set(devices.map((d) => normalizeEntityId(d.id)));
    const hasInput = new Set<string>();
    for (const cable of cables) {
        const to = normalizeEntityId(cable.toEntityId);
        if (to && deviceIds.has(to)) hasInput.add(to);
    }
    const root = devices.find((d) => !hasInput.has(normalizeEntityId(d.id)));
    return root ? root.id : devices[0].id;
}

/** Deterministic SOURCE root for the current connected project (read-only). */
export function selectSourceRoot(doc: SyncedDocument): string | undefined {
    return selectRootId(listAudioDevicesLive(doc), listCablesLive(doc));
}

/** Build the export input from the CURRENT device state and the transient
 *  active project bindings. Only CONNECTED controls with an ActiveBinding are
 *  exported: an unbound control has no target field mapping and is honestly
 *  excluded. The transient `Preset` is never saved to the device. */
export function buildInstrumentExportInput(
    device: Device,
    name: string,
    snapshot: ChainSnapshot,
    bindingManager: BindingManager,
): InstrumentPresetExportResult {
    const preset = new Preset(name, device.id);
    const bindings: InstrumentPresetBindingSource[] = [];

    device.controls.forEach((control) => {
        if (control.archived) return;
        const active = bindingManager.getActiveBinding(control.id);
        if (!active) return;
        const fieldPath = active.fieldPath ?? active.fieldName;
        if (!fieldPath) return;
        preset.controlValues[control.id] = control.value;
        bindings.push({ controlId: control.id, sourceEntityId: active.entityId, fieldPath });
    });

    if (bindings.length === 0) {
        return {
            ok: false,
            errors: [
                "InstrumentPreset export: no bound control — connect to a project and Learn/reconnect at least one control first.",
            ],
        };
    }

    return exportInstrumentPreset({ device, preset, snapshot, bindings });
}

/** P1 — EXPORT: connected project (SOURCE, read-only) + current device/bindings
 *  → `exportInstrumentPreset` → `serializeInstrumentPreset` → local library. */
export async function exportInstrumentToLibrary(
    doc: SyncedDocument,
    device: Device,
    bindingManager: BindingManager,
    name: string,
): Promise<InstrumentExportOutcome> {
    if (!doc) {
        return { ok: false, errors: ["InstrumentPreset export: no SOURCE document — connect to an Audiotool project first."] };
    }
    const rootId = selectSourceRoot(doc);
    if (!rootId) {
        return { ok: false, errors: ["InstrumentPreset export: no audio chain found on the connected project."] };
    }
    const snapshot = createSnapshot(doc, rootId);
    const result = buildInstrumentExportInput(device, name, snapshot, bindingManager);
    if (!result.ok) return { ok: false, errors: result.errors };
    const entry = InstrumentPresetLibrary.save(result.preset);
    return { ok: true, entry, preset: result.preset, warnings: result.warnings };
}

/** P2 (pre-import) — parse + validate a stored envelope (controlled failure
 *  when the library entry is missing or the envelope is invalid). */
export function loadAndParseInstrumentPreset(
    libraryId: string,
): { ok: true; preset: InstrumentPreset; entry: InstrumentPresetLibraryEntry } | { ok: false; errors: string[] } {
    const entry = InstrumentPresetLibrary.get(libraryId);
    if (!entry) {
        return { ok: false, errors: [`InstrumentPreset import: no library entry "${libraryId}".`] };
    }
    try {
        return { ok: true, preset: parseInstrumentPreset(entry.presetJson), entry };
    } catch (e) {
        return {
            ok: false,
            errors: [
                `InstrumentPreset import: envelope invalid — ${e instanceof Error ? e.message : String(e)}`,
            ],
        };
    }
}

/** P2 — IMPORT: library entry → `parseInstrumentPreset` → TARGET = connected
 *  project (`targetDoc`) with the current `BindingManager` → `importInstrumentPreset`. */
export async function importInstrumentFromLibrary(
    libraryId: string,
    targetDoc: SyncedDocument,
    bindingManager: BindingManager,
): Promise<InstrumentImportOutcome> {
    if (!targetDoc) {
        return { ok: false, errors: ["InstrumentPreset import: no TARGET document — connect to the project to import into first."] };
    }
    const loaded = loadAndParseInstrumentPreset(libraryId);
    if (!loaded.ok) return { ok: false, errors: loaded.errors };
    const result = await importInstrumentPreset(loaded.preset, targetDoc, bindingManager);
    if (!result.ok) {
        return { ok: false, import: result, errors: result.failures };
    }
    return { ok: true, import: result };
}