import { Device } from "../core/model/Device";

/**
 * Serialized Device shape as produced by {@link Device.serialize} and consumed
 * by {@link Device.deserialize}. This is what the Storage layer persists under
 * the LocalStorage key — in-memory Device instances never touch the store
 * directly.
 */
export interface DeviceData {
    id: string;
    name: string;
    schemaVersion: number;
    controls: unknown[];
    groups: unknown[];
    presets: unknown[];
}

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

    /**
     * Persist a device (serialized) into the stored device map, then write the
     * map back to LocalStorage.
     *
     * @throws {StorageError} when LocalStorage cannot be written
     */
    public static saveDevice(device: Device): void {
        const devices = this.loadAllDevices();
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
        const devices = this.loadAllDevices();
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
        const devices = this.loadAllDevices();
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
        const devices = this.loadAllDevices();
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
     * @throws {StorageError} when the stored payload cannot be parsed
     */
    private static loadAllDevices(): Map<string, DeviceData> {
        const data = localStorage.getItem(this.STORAGE_KEY);
        if (!data) {
            return new Map();
        }

        let parsed: Record<string, DeviceData>;
        try {
            parsed = JSON.parse(data) as Record<string, DeviceData>;
        } catch (e) {
            throw new StorageError("Failed to parse devices from local storage", { cause: e });
        }

        return new Map(Object.entries(parsed));
    }
}
