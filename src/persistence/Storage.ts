import { Device } from "../core/model/Device";
import type { DeviceData } from "../core/model/types";

/**
 * Error thrown by Storage operations when the underlying LocalStorage read,
 * write, or parse fails (quota exceeded, corrupted payload, disabled storage,
 * …). The original cause is preserved for diagnostics; callers are expected
 * to handle this error explicitly — the Storage layer never swallows failures
 * silently.
 */
export class StorageError extends Error {
    public constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "StorageError";
    }
}

export class Storage {
    private static readonly STORAGE_KEY = "metatron_devices";

    /** Separate best-effort note of the MOST-RECENTLY-USED device id (I18,
     *  §13). main.ts restores this device on app start, NOT the oldest one —
     *  `listDevices()` returns insertion order, which is unrelated to use. */
    private static readonly LAST_ACTIVE_KEY = "metatron_last_device_id";

    /** R4 — In-Memory-Spiegel der Device-Map. Storage ist in dieser
     *  Single-Window-App der einzige Schreiber für `metatron_devices`; jeder
     *  eigene Schreibbewegung aktualisiert den Spiegel im selben Schritt, also
     *  ist er konsistent zur persistierten Fassung. Der Lese-Pfad der
     *  Wertespur (bis zu 10×/s über den 100-ms-Debounce) spart damit den
     *  kompletten getItem+JSON.parse-Stringifizieren-Zyklus pro Save. */
    private static devices: Map<string, DeviceData> | null = null;
    /** R4 — einmalige Recovery-Warnung pro Sitzung (kein Toast-/Log-Spam bei
     *  jedem weiteren Lesen der korrupten Map). */
    private static recoveryWarned = false;

    /** R4 — Hook für Tests/Entwicklung: verwirft den Map-Spiegel und die
     *  einmalige Recovery-Warnung, sodass der nächste Lesevorgang frisch aus
     *  LocalStorage geht. Im App-Lauf nicht nötig — nur bei manuell
     *  verändertem LocalStorage von außen. */
    public static resetCache(): void {
        Storage.devices = null;
        Storage.recoveryWarned = false;
    }

    /**
     * Persist the most-recently-used device id. The note is separate from the
     * device map so a corrupt map cannot hide it (and the note is best-effort:
     * DeviceLibrary logs and continues when the write fails).
     *
     * @throws {StorageError} when LocalStorage cannot be written
     */
    public static saveLastActiveDeviceId(id: string): void {
        try {
            localStorage.setItem(this.LAST_ACTIVE_KEY, id);
        } catch (e) {
            throw new StorageError("Failed to save last active device id", { cause: e });
        }
    }

    /** Read the most-recently-used device id note, if any. */
    public static getLastActiveDeviceId(): string | undefined {
        const id = localStorage.getItem(this.LAST_ACTIVE_KEY);
        return id || undefined;
    }

    /**
     * Clear the most-recently-used device note (called when the referenced
     * device is deleted).
     *
     * @throws {StorageError} when LocalStorage cannot be written
     */
    public static clearLastActiveDeviceId(): void {
        try {
            localStorage.removeItem(this.LAST_ACTIVE_KEY);
        } catch (e) {
            throw new StorageError("Failed to clear last active device id", { cause: e });
        }
    }

    /**
     * Persist a device (serialized) into the stored device map, then write the
     * map back to LocalStorage.
     *
     * The ENTIRE path — reading the existing map, serializing the device, and
     * the LocalStorage write — is covered by the @throws contract, so a caller
     * (e.g. the debounced value-path save) can always rely on StorageError
     * instead of a raw SecurityError / serialization TypeError leaking out.
     *
     * @throws {StorageError} when LocalStorage cannot be written
     */
    public static saveDevice(device: Device): void {
        try {
            const devices = this.getAllDevices();
            devices.set(device.id, device.serialize());
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(Object.fromEntries(devices)));
            this.devices = devices;
        } catch (e) {
            throw new StorageError("Failed to save device to local storage", { cause: e });
        }
    }
    /**
     * Load a single device by id and rehydrate it into a Device instance.
     *
     * @returns the deserialized Device, or undefined when the id is unknown
     * @throws {StorageError} when the stored payload cannot be parsed
     */
    public static loadDevice(id: string): Device | undefined {
        const devices = this.getAllDevices();
        const data = devices.get(id);
        if (data) {
            return Device.deserialize(data);
        }
        return undefined;
    }

    /**
     * Remove a device from the stored device map (no-op when the id is
     * unknown), then write the map back to LocalStorage.
     *
     * @throws {StorageError} when LocalStorage cannot be written
     */
    public static deleteDevice(id: string): void {
        const devices = this.getAllDevices();
        if (devices.has(id)) {
            devices.delete(id);
            try {
                localStorage.setItem(this.STORAGE_KEY, JSON.stringify(Object.fromEntries(devices)));
                this.devices = devices;
            } catch (e) {
                throw new StorageError("Failed to update local storage after deletion", { cause: e });
            }
        }
    }

    /**
     * List all stored devices as lightweight { id, name } summaries.
     *
     * @returns one entry per stored device, insertion order of the map
     * @throws {StorageError} when the stored payload cannot be parsed
     */
    public static listDevices(): { id: string, name: string }[] {
        const devices = this.getAllDevices();
        const result: { id: string, name: string }[] = [];

        devices.forEach((data, id) => {
            // R4 — gegen null-/defekte Einträge absichern (korrupte Map nach
            // externer Manipulation): Name nur, wenn vorhanden, sonst die ID.
            result.push({ id, name: data?.name ?? id });
        });

        return result;
    }

    /**
     * Read the device map from LocalStorage — capped to ONE read per session
     * in the normal flow: the in-memory mirror (R4-cache) serves every later
     * call, so the debounced value-path save never re-parses the whole map.
     * The RESULT is always a fresh copy: callers (history snapshots) may
     * mutate it without corrupting the cache; saveDevice/deleteDevice replace
     * the cache with their own copy only AFTER the write succeeded, so a
     * failed write leaves the mirror exactly as persistent state.
     * An absent key is not an error — it yields an empty map. A corrupted
     * payload is NOT a hard error anymore (R4): one-time warning + backup
     * under `metatron_devices_corrupt_<timestamp>` + continue with an empty
     * map, ending the "nothing saves anymore" deadlock.
     *
     * Exposed so the history layer can snapshot the persisted map for a
     * best-effort rollback after a failed library-scope restore.
     *
     * @throws {StorageError} when LocalStorage is denied or — only as a last
     *         resort — the corrupt-map backup itself cannot be written
     */
    public static getAllDevices(): Map<string, DeviceData> {
        if (this.devices) return new Map(this.devices);

        const data = localStorage.getItem(this.STORAGE_KEY);
        if (!data) {
            this.devices = new Map();
            return new Map(this.devices);
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(data);
        } catch (e) {
            return this.recoverCorruptMap(data, e);
        }

        // Top-level shape guard (FIX 8): null, arrays, and primitive JSON
        // values are NOT a device map — treat them as corruption instead of
        // silently iterating garbage with Object.entries().
        const record = parsed as Record<string, DeviceData> | null;
        if (typeof record !== "object" || record === null || Array.isArray(record)) {
            return this.recoverCorruptMap(data, new Error("Stored device map is not a valid JSON object"));
        }

        this.devices = new Map(Object.entries(record));
        return new Map(this.devices);
    }

    /** R4 — dokumentierte Recovery für eine korrupte Device-Map: einmalig
     *  warnen, das Original unter `metatron_devices_corrupt_<timestamp>`
     *  sichern und mit leerer Map weiterarbeiten. Nur wenn selbst das Backup
     *  an LocalStorage scheitert, bleibt es ein StorageError. */
    private static recoverCorruptMap(data: string, cause: unknown): Map<string, DeviceData> {
        if (!this.recoveryWarned) {
            this.recoveryWarned = true;
            console.warn(
                "[METATRON STORAGE] Device-Map korrupt — Original unter `metatron_devices_corrupt_<timestamp>` gesichert, weiter mit leerer Map.",
                cause
            );
            try {
                localStorage.setItem(`metatron_devices_corrupt_${Date.now()}`, data);
            } catch (e) {
                throw new StorageError("Failed to back up corrupt device map", { cause: e });
            }
        }
        this.devices = new Map();
        return new Map(this.devices);
    }
}
