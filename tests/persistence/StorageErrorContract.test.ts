// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Storage, StorageError } from "../../src/persistence/Storage";

/**
 * B11 — saveDevice's ENTIRE path honors its StorageError contract: a raw
 * SecurityError from the map read, a serialization failure, and an actual
 * write failure must all surface as StorageError (never as a raw exception
 * the debounced value-path save cannot handle).
 *
 * In einer EIGENEN Datei: vi.spyOn auf den happy-dom-localStorage-Proxy lässt
 * sich nicht zuverlässig restaurieren (leakt in nachfolgende Tests derselben
 * Datei). Vitest isoliert Testdateien pro Modul-Instanz.
 */
describe("Storage — saveDevice error contract", () => {
    beforeEach(() => {
        Storage.resetCache();
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