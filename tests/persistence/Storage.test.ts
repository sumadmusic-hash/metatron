// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Storage } from "../../src/persistence/Storage";

/** R4 — alle Backup-Keys der corrupt-Recovery im aktuellen Storage-Inhalt. */
function corruptBackupKeys(): string[] {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("metatron_devices_corrupt_")) keys.push(k);
    }
    return keys;
}

/**
 * FIX 8 — top-level storage validation: the persisted device map must be a
 * plain JSON object. null, arrays, and primitive JSON values are corruption.
 * R4 — corruption is no longer a permanent deadlock: it warns once, backs the
 * original up under `metatron_devices_corrupt_<timestamp>` and continues with
 * an empty map.
 */

describe("Storage — getAllDevices top-level shape", () => {
    beforeEach(() => {
        Storage.resetCache();
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

    it("recovers a null payload: empty map + Backup-Key", () => {
        localStorage.setItem("metatron_devices", "null");
        expect(Storage.getAllDevices().size).toBe(0);
        expect(corruptBackupKeys().length > 0).toBe(true);
    });

    it("recovers an array payload: empty map + Backup-Key", () => {
        localStorage.setItem("metatron_devices", "[1, 2, 3]");
        expect(Storage.getAllDevices().size).toBe(0);
        expect(corruptBackupKeys().length > 0).toBe(true);
    });

    it("recovers primitive JSON values (42, string, true): empty map + Backup-Key", () => {
        localStorage.setItem("metatron_devices", "42");
        expect(Storage.getAllDevices().size).toBe(0);
        localStorage.setItem("metatron_devices", '"str"');
        expect(Storage.getAllDevices().size).toBe(0);
        localStorage.setItem("metatron_devices", "true");
        expect(Storage.getAllDevices().size).toBe(0);
        expect(corruptBackupKeys().length > 0).toBe(true);
    });

    it("does not throw StorageError for an absent key", () => {
        expect(Storage.getAllDevices().size).toBe(0);
    });
});

/**
 * R4 — Performance (Cache: ≤1 getItem auf die Map bei vielen Saves), Recovery
 * (korrupte Map blockiert den Save nicht mehr dauerhaft) und Null-Sicherheit.
 */
describe("R4 — cached writes + corrupt-map recovery", () => {
    beforeEach(() => {
        // Quota-Spys aus früheren Describes auf den happy-dom-Proxy lassen
        // sich nicht immer per afterEach restaurieren — hier hart zurücksetzen.
        vi.restoreAllMocks();
        Storage.resetCache();
        localStorage.clear();
    });

    it("R4 — 20 saveDevice-Aufrufe lösen höchstens EINEN getItem auf die Map aus", () => {
        const device = new Device("Cached");
        const getItemSpy = vi.spyOn(localStorage, "getItem");
        for (let i = 0; i < 20; i++) {
            Storage.saveDevice(device);
        }
        const mapReads = getItemSpy.mock.calls.filter(([key]) => key === "metatron_devices").length;
        expect(mapReads).toBeLessThanOrEqual(1);
    });

    it("R4 — korrupte Map: der nächste saveDevice gelingt und der Backup-Key existiert", () => {
        const device = new Device("Rescue");
        localStorage.setItem("metatron_devices", "{definitiv kein JSON!!!");

        expect(() => Storage.saveDevice(device)).not.toThrow();
        expect(corruptBackupKeys().length).toBe(1);
        // Map wurde frisch neu geschrieben und enthält das Device.
        expect(Storage.getAllDevices().get(device.id)).toBeTruthy();
    });

    it("R4 — listDevices übersteht null-/defekte Einträge (data?.name ?? id)", () => {
        localStorage.setItem("metatron_devices", JSON.stringify({ "dev-1": null, "dev-2": { name: "Gut" } }));
        const list = Storage.listDevices();
        expect(list).toEqual([
            { id: "dev-1", name: "dev-1" },
            { id: "dev-2", name: "Gut" },
        ]);
    });
});