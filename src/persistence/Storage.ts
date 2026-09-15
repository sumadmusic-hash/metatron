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
     * @throws {StorageError} when LocalStorage cannot be written
     */
    public static saveDevice(device: Device): void {
        const devices = this.getAllDevices();
        devices.set(device.id, device.serialize());

        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(Object.fromEntries(devices)));
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
            result.push({ id, name: data.name });
        });

        return result;
    }

    /**
     * Read and parse the full device map from LocalStorage. An absent key is
     * not an error — it yields an empty map. A corrupted payload is.
     *
     * Exposed so the history layer can snapshot the persisted map for a
     * best-effort rollback after a failed library-scope restore.
     *
     * @throws {StorageError} when the stored payload cannot be parsed
     */
    public static getAllDevices(): Map<string, DeviceData> {
        const data = localStorage.getItem(this.STORAGE_KEY);
        if (!data) {
            return new Map();
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(data);
        } catch (e) {
            throw new StorageError("Failed to parse devices from local storage", { cause: e });
        }

        // Top-level shape guard (FIX 8): null, arrays, and primitive JSON
        // values are NOT a device map — treat them as corruption instead of
        // silently iterating garbage with Object.entries().
        const record = parsed as Record<string, DeviceData> | null;
        if (typeof record !== "object" || record === null || Array.isArray(record)) {
            throw new StorageError("Stored device map is not a valid JSON object");
        }

        return new Map(Object.entries(record));
    }
}
