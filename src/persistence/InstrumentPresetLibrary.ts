import { generateId } from "../core/model/types";
import { serializeInstrumentPreset } from "../core/instrument/InstrumentPreset";
import type { InstrumentPreset } from "../core/instrument/InstrumentPreset";

/**
 * INSTRUMENT PRESET LIBRARY — global local library of `InstrumentPreset v0.1`
 * envelopes (integration decision D1). Pure local persistence under its own
 * localStorage key; `src/persistence/Storage.ts` (device library) is untouched.
 *
 * Entries hold the serialized envelope as JSON text plus the minimal LOCAL
 * metadata needed to list entries without parsing (`id`, `name`, `deviceId`,
 * `createdAt`). The `InstrumentPreset v0.1` contract itself is never changed:
 * the envelope is validated by `parseInstrumentPreset` at read time.
 */

export const INSTRUMENT_PRESET_LIBRARY_KEY = "metatron_instrument_presets";

export interface InstrumentPresetLibraryEntry {
    /** Library-local id (never part of the envelope). */
    id: string;
    name: string;
    deviceId: string;
    createdAt: number;
    /** Serialized `InstrumentPreset v0.1` envelope (JSON). */
    presetJson: string;
}

export interface InstrumentPresetLibraryInfo {
    id: string;
    name: string;
    deviceId: string;
    createdAt: number;
}

function isEntry(value: unknown): value is InstrumentPresetLibraryEntry {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const e = value as Record<string, unknown>;
    return (
        typeof e.id === "string" &&
        typeof e.name === "string" &&
        typeof e.deviceId === "string" &&
        typeof e.createdAt === "number" &&
        typeof e.presetJson === "string"
    );
}

/** Result of a `save` attempt: `ok: true` only when the envelope was actually
 *  written to local storage. A storage failure is NEVER reported as success. */
export type InstrumentPresetSaveResult =
    | { ok: true; entry: InstrumentPresetLibraryEntry }
    | { ok: false; errors: string[] };

export class InstrumentPresetLibrary {
    public static readonly KEY = INSTRUMENT_PRESET_LIBRARY_KEY;

    /** Persist a new v0.1 envelope. A `localStorage.setItem` failure is
     *  returned as `ok: false` — never faked as a successful save. */
    public static save(preset: InstrumentPreset): InstrumentPresetSaveResult {
        const entry: InstrumentPresetLibraryEntry = {
            id: generateId("ipst"),
            name: preset.name,
            deviceId: preset.metatron.deviceId,
            createdAt: Date.now(),
            presetJson: serializeInstrumentPreset(preset),
        };
        const entries = this.loadAll();
        entries.push(entry);
        try {
            localStorage.setItem(this.KEY, JSON.stringify(entries));
        } catch (e) {
            return {
                ok: false,
                errors: [
                    `Failed to persist instrument preset to local storage: ${e instanceof Error ? e.message : String(e)}`,
                ],
            };
        }
        return { ok: true, entry };
    }

    /** Minimal metadata for every stored instrument preset (no parsing). */
    public static list(): InstrumentPresetLibraryInfo[] {
        return this.loadAll().map((e) => ({
            id: e.id,
            name: e.name,
            deviceId: e.deviceId,
            createdAt: e.createdAt,
        }));
    }

    /** Raw entry (serialized envelope) for one id. */
    public static get(id: string): InstrumentPresetLibraryEntry | undefined {
        return this.loadAll().find((e) => e.id === id);
    }

    public static delete(id: string): boolean {
        const entries = this.loadAll();
        if (!entries.some((e) => e.id === id)) return false;
        try {
            localStorage.setItem(this.KEY, JSON.stringify(entries.filter((e) => e.id !== id)));
        } catch {
            return false;
        }
        return true;
    }

    private static loadAll(): InstrumentPresetLibraryEntry[] {
        try {
            const data = localStorage.getItem(this.KEY);
            if (!data) return [];
            const parsed = JSON.parse(data);
            if (!Array.isArray(parsed)) {
                console.error("Failed to parse instrument presets from local storage: expected an array");
                return [];
            }
            return parsed.filter(isEntry);
        } catch (e) {
            console.error("Failed to parse instrument presets from local storage:", e);
            return [];
        }
    }
}