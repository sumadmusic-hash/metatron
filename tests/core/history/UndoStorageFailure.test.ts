import { describe, it, expect, vi, beforeEach } from "vitest";
import { Device } from "../../../src/core/model/Device";
import { Control } from "../../../src/core/model/Control";
import { DeviceLibrary } from "../../../src/core/DeviceLibrary";
import { DeviceHistory } from "../../../src/core/history/DeviceHistory";
import { Storage } from "../../../src/persistence/Storage";

// Minimal localStorage shim so Storage can persist between calls in Node.
class FakeStorage implements Storage {
    private store = new Map<string, string>();
    get length(): number { return this.store.size; }
    clear(): void { this.store.clear(); }
    getItem(key: string): string | null { return this.store.get(key) ?? null; }
    key(index: number): string | null { return Array.from(this.store.keys())[index] ?? null; }
    removeItem(key: string): void { this.store.delete(key); }
    setItem(key: string, value: string): void { this.store.set(key, value); }
}

let storage: FakeStorage;

function makeLibrary(device: Device): DeviceLibrary {
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    return lib;
}

function addKnob(device: Device, name: string, x: number, y: number): Control {
    const c = new Control("knob", name, { x, y });
    device.addControl(c);
    return c;
}

/** Fail exactly the N-th localStorage write; let every other write through. */
function failNthWrite(nth: number) {
    const real = storage.setItem.bind(storage);
    let writes = 0;
    const spy = vi.spyOn(storage, "setItem").mockImplementation((k: string, v: string) => {
        writes++;
        if (writes === nth) throw new DOMException("quota exceeded", "QuotaExceededError");
        real(k, v);
    });
    return spy;
}

beforeEach(() => {
    storage = new FakeStorage();
    (globalThis as any).localStorage = storage;
});

describe("DeviceHistory — transactional apply() on StorageError (P2)", () => {

    it("device-scope undo leaves in-memory + persisted unchanged on failure and retries cleanly", () => {
        const device = new Device("D");
        const a = addKnob(device, "A", 100, 100);
        const lib = makeLibrary(device);
        const history = new DeviceHistory(lib);

        const before = history.captureDeviceState(device);
        a.position = { x: 200, y: 150 };
        const after = history.captureDeviceState(device);
        history.record({ type: "control.move", scope: "device", deviceId: device.id, before, after });
        expect(history.undoLength).toBe(1);

        // First attempt fails storage.
        const spy = failNthWrite(1);

        expect(() => {
            history.undo();
        }).not.toThrow();
        expect(history.undoLength).toBe(1);
        // In-memory state unchanged: the pre-undo move is still applied (no
        // partial restore was committed).
        expect(a.position).toEqual({ x: 200, y: 150 });
        // Persisted state unchanged: the device was never written.
        expect(Storage.getAllDevices().size).toBe(0);

        // Retry succeeds once storage is writable again.
        expect(history.undo()).toBe(true);
        expect(a.position).toEqual({ x: 100, y: 100 });
        expect(Storage.loadDevice(device.id)?.getControl(a.id)?.position).toEqual({ x: 100, y: 100 });

        spy.mockRestore();
    });

    it("library-scope undo rolls back live + persisted state on failure and retries cleanly", () => {
        const lib = new DeviceLibrary();
        const a = lib.createNewDevice("A");
        lib.saveCurrentDevice();
        const history = new DeviceHistory(lib);

        const before = history.captureLibraryState();
        const b = lib.createNewDevice("B");
        lib.saveCurrentDevice();
        const after = history.captureLibraryState();
        history.record({ type: "device.create", scope: "library", deviceId: null, before, after });
        expect(lib.listDevices().map((d) => d.name).sort()).toEqual(["A", "B"]);
        expect(lib.currentDevice?.id).toBe(b.id);
        // Fail on the SECOND write: the target device was already persisted
        // as deleted, so without a rollback the persisted map would lose "B".
        const spy = failNthWrite(2);

        expect(() => {
            history.undo();
        }).not.toThrow();
        expect(history.undoLength).toBe(1);
        // Rollback restored both layers: the persisted device list AND the
        // live active device are exactly as they were before the attempt.
        expect(lib.currentDevice?.id).toBe(b.id);
        expect(lib.listDevices().map((d) => d.name).sort()).toEqual(["A", "B"]);
        expect(Storage.getAllDevices().size).toBe(2);

        // Retry succeeds once storage is writable again.
        expect(history.undo()).toBe(true);
        expect(lib.listDevices().map((d) => d.name)).toEqual(["A"]);
        expect(lib.currentDevice?.id).toBe(a.id);

        spy.mockRestore();
    });
});