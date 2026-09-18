// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Storage, StorageError } from "../../src/persistence/Storage";

/**
 * FIX 8 — top-level storage validation: the persisted device map must be a
 * plain JSON object. null, arrays, and primitive JSON values are corruption
 * and must surface as StorageError instead of a TypeError / silent garbage
 * iteration.
 */

describe("Storage — getAllDevices top-level shape", () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it("returns an empty map when no payload is stored", () => {
        expect(Storage.getAllDevices().size).toBe(0);
    });

    it("accepts a valid JSON object map", () => {
        const device = new Device("Valid");
        localStorage.setItem("metatron_devices", JSON.stringify(Object.fromEntries([
            [device.id, device.serialize()],
        ])));

        const devices = Storage.getAllDevices();
        expect(devices.size).toBe(1);
        expect(Storage.loadDevice(device.id)?.name).toBe("Valid");
    });

    it("rejects a null payload with StorageError", () => {
        localStorage.setItem("metatron_devices", "null");
        expect(() => Storage.getAllDevices()).toThrow(StorageError);
    });

    it("rejects an array payload with StorageError", () => {
        localStorage.setItem("metatron_devices", "[1, 2, 3]");
        expect(() => Storage.getAllDevices()).toThrow(StorageError);
    });

    it("rejects primitive JSON values with StorageError", () => {
        localStorage.setItem("metatron_devices", "42");
        expect(() => Storage.getAllDevices()).toThrow(StorageError);
        localStorage.setItem("metatron_devices", '"str"');
        expect(() => Storage.getAllDevices()).toThrow(StorageError);
        localStorage.setItem("metatron_devices", "true");
        expect(() => Storage.getAllDevices()).toThrow(StorageError);
    });

    it("does not throw StorageError for an absent key", () => {
        expect(Storage.getAllDevices().size).toBe(0);
    });
});

/**
 * B11 — saveDevice's ENTIRE path honors its StorageError contract: a raw
 * SecurityError from the map read, a serialization failure, and an actual
 * write failure must all surface as StorageError (never as a raw exception
 * the debounced value-path save cannot handle).
 */
describe("Storage — saveDevice error contract", () => {
    beforeEach(() => {
        localStorage.clear();
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("wraps a failing localStorage write as StorageError", () => {
        const device = new Device("Full");
        vi.spyOn(localStorage, "setItem").mockImplementation(() => {
            throw new DOMException("quota", "QuotaExceededError");
        });
        expect(() => Storage.saveDevice(device)).toThrow(StorageError);
    });

    it("wraps a serialization failure as StorageError instead of leaking a raw error", () => {
        const device = new Device("Broken");
        device.serialize = () => {
            throw new TypeError("cannot serialize malformed control");
        };
        expect(() => Storage.saveDevice(device)).toThrow(StorageError);
    });

    it("wraps a denied map read (SecurityError on localStorage access) as StorageError", () => {
        const device = new Device("Denied");
        vi.spyOn(localStorage, "getItem").mockImplementation(() => {
            throw new DOMException("The operation is insecure", "SecurityError");
        });
        expect(() => Storage.saveDevice(device)).toThrow(StorageError);
    });
});