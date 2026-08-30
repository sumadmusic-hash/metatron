import type {
    ControlType,
    MidiBindingDefinition,
    NexusBindingDefinition,
    Position,
    Size,
    VisualDefinition,
} from "../model/types";

/**
 * METATRON HISTORY — action model for the transitive, session-scoped undo/redo
 * layer (C1). The memento is a deterministic BEFORE/AFTER structural snapshot
 * of the affected Metatron state. It is plain in-memory data — it is NEVER
 * persisted, never routed through `Storage`, and never serialized to JSON as
 * a round-trip mechanism. `undo()` applies the `before` state through the
 * model itself, `redo()` applies the `after` state.
 */

/**
 * Hard cap on undoable actions per session. New actions evict the oldest so
 * memory stays bounded and behavior stays deterministic.
 */
export const HISTORY_LIMIT = 100;

// ── Structural patches (plain data, mirrors each model's serialized shape) ──

export interface ControlStatePatch {
    id: string;
    type: ControlType;
    name: string;
    position: Position;
    size: Size;
    groupId?: string;
    /** Live value — captured so PRESET LOAD (which changes control values)
     *  can be restored exactly. Value-only interactions are never actions. */
    value: number;
    defaultValue: number;
    visualDefinition: VisualDefinition;
    audiotoolBindingDefinition?: NexusBindingDefinition;
    midiBindingDefinition?: MidiBindingDefinition;
    archived: boolean;
    layoutVersion?: number;
}

export interface GroupStatePatch {
    id: string;
    name: string;
    color: string;
    position: Position;
    size: Size;
}

export interface PresetStatePatch {
    id: string;
    name: string;
    deviceId: string;
    controlValues: Record<string, number>;
}

export interface DeviceStatePatch {
    /** Captured for device rename undo. */
    name: string;
    controls: Record<string, ControlStatePatch>;
    groups: Record<string, GroupStatePatch>;
    presets: Record<string, PresetStatePatch>;
}

export interface LibraryStatePatch {
    devices: Record<string, DeviceStatePatch>;
    activeDeviceId: string | null;
}

export type HistoryScope = "device" | "library";

export interface HistoryAction {
    /** Human-readable label (e.g. "control.move", "preset.save", "device.create"). */
    type: string;
    /** "device": apply on the live Device in place (identity preserved).
     *  "library": restore the whole device list + active device. */
    scope: HistoryScope;
    /** Device the patch applies to; null for library-scope actions. */
    deviceId: string | null;
    before: DeviceStatePatch | LibraryStatePatch;
    after: DeviceStatePatch | LibraryStatePatch;
}

/**
 * Structural equality for patch data. Used ONLY to decide whether an action
 * actually changed the model (drag below threshold, unchanged renames, failed
 * imports, …). Deliberately not `JSON.stringify` — no serialization anywhere
 * in the history path.
 */
export function patchesEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!patchesEqual(a[i], b[i])) return false;
        }
        return true;
    }
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
        const bRecord = b as Record<string, unknown>;
        if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
        if (!patchesEqual((a as Record<string, unknown>)[key], bRecord[key])) return false;
    }
    return true;
}