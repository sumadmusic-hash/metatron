import { describe, it, expect, vi, beforeEach } from "vitest";
import { Device } from "../../../src/core/model/Device";
import { Control } from "../../../src/core/model/Control";
import { DeviceLibrary } from "../../../src/core/DeviceLibrary";
import { DeviceHistory } from "../../../src/core/history/DeviceHistory";

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

beforeEach(() => {
    storage = new FakeStorage();
    (globalThis as any).localStorage = storage;
});

describe("DeviceHistory — StorageError in apply() (undo keeps the action)", () => {

    it("device-scope undo returns false and keeps the action when persistence fails", () => {
        const device = new Device("D");
        const a = addKnob(device, "A", 100, 100);
        const lib = makeLibrary(device);
        const history = new DeviceHistory(lib);

        const before = history.captureDeviceState(device);
        a.position = { x: 200, y: 150 };
        const after = history.captureDeviceState(device);
        history.record({ type: "control.move", scope: "device", deviceId: device.id, before, after });
        expect(history.undoLength).toBe(1);

        const spy = vi.spyOn(storage, "setItem").mockImplementation(() => {
            throw new DOMException("quota exceeded", "QuotaExceededError");
        });

        let result: boolean;
        expect(() => {
            result = history.undo();
        }).not.toThrow();
        // A failed undo keeps the action so the UI can retry — and the failure
        // is never surfaced as an exception (apply() returns false).
        expect(result).toBe(false);
        expect(history.undoLength).toBe(1);

        spy.mockRestore();
    });

    it("library-scope undo returns false without throwing when restore persistence fails", () => {
        const lib = new DeviceLibrary();
        lib.createNewDevice("A");
        lib.saveCurrentDevice();
        const history = new DeviceHistory(lib);

        const before = history.captureLibraryState();
        lib.createNewDevice("B");
        lib.saveCurrentDevice();
        const after = history.captureLibraryState();
        history.record({ type: "device.create", scope: "library", deviceId: null, before, after });
        expect(history.undoLength).toBe(1);

        const spy = vi.spyOn(storage, "setItem").mockImplementation(() => {
            throw new DOMException("quota exceeded", "QuotaExceededError");
        });

        let result: boolean;
        expect(() => {
            result = history.undo();
        }).not.toThrow();
        expect(result).toBe(false);
        expect(history.undoLength).toBe(1);

        spy.mockRestore();
    });
});