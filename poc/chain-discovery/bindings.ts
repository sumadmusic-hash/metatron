/**
 * METATRON BINDINGS (read-only) — section 15.
 *
 * Reads Metatron's persisted devices from `localStorage` (the same store the
 * real app uses via `src/persistence/Storage.ts`) WITHOUT touching any of the
 * productive Metatron classes. Only the raw serialized JSON is inspected.
 *
 * Honesty notes:
 * - A persisted `audiotoolBindingDefinition.targetName` proves a binding
 *   DEFINITION exists (deterministic local-storage fact → OFFLINE PROVEN).
 * - The `CONNECTED` state lives in Metatron's in-memory `activeBinding` and is
 *   NOT serialized → the live connectivity state is NOT AVAILABLE here.
 */

import type { MetatronBinding, Provenance } from "./types";

const STORAGE_KEY = "metatron_devices";

interface StoredControl {
    id: string;
    name?: string;
    audiotoolBindingDefinition?: { targetName?: string };
}

interface StoredDevice {
    id: string;
    name?: string;
    controls?: StoredControl[];
}

/** Read the persisted devices JSON without using Metatron classes. */
export function readPersistedDevices(storage: Storage = window.localStorage): StoredDevice[] {
    try {
        const raw = storage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
            return Object.values(parsed as Record<string, StoredDevice>);
        }
    } catch (e) {
        console.warn("[METATRON CHAIN DISCOVERY] failed to read persisted devices:", e);
    }
    return [];
}

/** Capture all persisted Metatron bindings (read-only). */
export function persistBindingsRead(storage?: Storage): MetatronBinding[] {
    const provenance: Provenance = "PROVEN BY OFFLINE TEST";
    const out: MetatronBinding[] = [];
    for (const device of readPersistedDevices(storage)) {
        for (const control of device.controls ?? []) {
            const def = control.audiotoolBindingDefinition;
            const state = def ? "DISCONNECTED" : "UNCONFIGURED";
            out.push({
                deviceName: device.name ?? device.id,
                controlLabel: control.name ?? control.id,
                targetName: def?.targetName,
                state,
                provenance,
            });
        }
    }
    return out;
}