import { describe, it, expect, beforeEach } from "vitest";
import { Device } from "../../../src/core/model/Device";
import { Control } from "../../../src/core/model/Control";
import { DeviceLibrary } from "../../../src/core/DeviceLibrary";
import {
    DeviceHistory,
    captureDeviceState,
    restoreDeviceState,
} from "../../../src/core/history/DeviceHistory";
import { patchesEqual } from "../../../src/core/history/HistoryAction";

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

function addKnob(device: Device, name: string, x: number, y: number): Control {
    const c = new Control("knob", name, { x, y });
    device.addControl(c);
    return c;
}

beforeEach(() => {
    (globalThis as any).localStorage = new FakeStorage();
});

describe("DeviceHistory — modulation in the device scope (FIX 3)", () => {

    it("undo restores the exact prior matrix, redo reproduces the target matrix", () => {
        const lib = new DeviceLibrary();
        const device = lib.createNewDevice("D");
        const knob = addKnob(device, "Cut", 0, 0);
        const history = new DeviceHistory(lib);

        device.modulation.slots[0].enabled = true;
        device.modulation.slots[0].sourceId = "mod2";
        device.modulation.slots[0].destControlId = knob.id;
        device.modulation.slots[0].amount = 0.4;
        const before = history.captureDeviceState(device);

        device.modulation.slots[0].amount = 0.9;
        const after = history.captureDeviceState(device);

        history.record({ type: "test.mod", scope: "device", deviceId: device.id, before, after });

        device.modulation.slots[0].enabled = false;
        expect(history.undo()).toBe(true);
        expect(device.modulation.slots[0].enabled).toBe(true);
        expect(device.modulation.slots[0].amount).toBe(0.4);
        expect(device.modulation.slots[0].sourceId).toBe("mod2");
        expect(device.modulation.slots[0].destControlId).toBe(knob.id);

        expect(history.redo()).toBe(true);
        expect(device.modulation.slots[0].amount).toBe(0.9);
        expect(device.modulation.slots[0].enabled).toBe(true);
    });
});

describe("DeviceHistory — modulation in the library scope (FIX 3)", () => {

    it("library-scope undo/redo transports the exact matrix", () => {
        const lib = new DeviceLibrary();
        lib.createNewDevice("Mod");
        lib.saveCurrentDevice();
        const device = lib.currentDevice!;
        const knob = addKnob(device, "Cut", 0, 0);
        const history = new DeviceHistory(lib);

        device.modulation.slots[1].enabled = true;
        device.modulation.slots[1].sourceId = "mod3";
        device.modulation.slots[1].destControlId = knob.id;
        device.modulation.slots[1].amount = 0.25;
        const before = history.captureLibraryState();

        device.modulation.slots[1].amount = 0.75;
        const after = history.captureLibraryState();
        history.record({ type: "test.library.mod", scope: "library", deviceId: null, before, after });

        device.modulation.slots[1].amount = 0.95;
        expect(history.undo()).toBe(true);
        expect(lib.currentDevice?.modulation.slots[1].amount).toBe(0.25);
        expect(lib.currentDevice?.modulation.slots[1].enabled).toBe(true);
        expect(lib.currentDevice?.modulation.slots[1].sourceId).toBe("mod3");
        expect(lib.currentDevice?.modulation.slots[1].destControlId).toBe(knob.id);

        expect(history.redo()).toBe(true);
        expect(lib.currentDevice?.modulation.slots[1].amount).toBe(0.75);
    });
});

describe("DeviceHistory — capture/restore carries the matrix (FIX 3)", () => {

    it("captureDeviceState embeds the matrix as a clone, not an alias", () => {
        const device = new Device("D");
        const knob = addKnob(device, "Cut", 0, 0);
        device.modulation.slots[2].enabled = true;
        device.modulation.slots[2].sourceId = "mod1";
        device.modulation.slots[2].destControlId = knob.id;
        device.modulation.slots[2].amount = 0.33;

        const patch = captureDeviceState(device);
        expect(patch.modulation).toBeDefined();
        expect(patch.modulation.slots[2].enabled).toBe(true);
        expect(patch.modulation.slots[2].amount).toBe(0.33);
        expect(patch.modulation.sources).toHaveLength(10);
        expect(patch.modulation.slots).toHaveLength(20);

        patch.modulation.slots[2].amount = 0.99;
        expect(device.modulation.slots[2].amount).toBe(0.33);
    });

    it("restoreDeviceState applies the captured matrix onto a live device", () => {
        const device = new Device("D");
        const knob = addKnob(device, "Cut", 0, 0);
        device.modulation.slots[2].enabled = true;
        device.modulation.slots[2].sourceId = "mod1";
        device.modulation.slots[2].destControlId = knob.id;
        device.modulation.slots[2].amount = 0.33;
        const patch = captureDeviceState(device);

        const other = new Device("Other");
        expect(other.modulation.slots[2].amount).toBe(0);
        restoreDeviceState(other, patch);
        expect(other.modulation.slots[2].enabled).toBe(true);
        expect(other.modulation.slots[2].amount).toBe(0.33);
        expect(other.modulation.slots[2].destControlId).toBe(knob.id);
    });

    it("patchesEqual detects a modulation-only difference", () => {
        const device = new Device("D");
        addKnob(device, "Cut", 0, 0);

        const a = captureDeviceState(device);
        expect(patchesEqual(a, a)).toBe(true);

        device.modulation.slots[0].enabled = true;
        const b = captureDeviceState(device);
        expect(patchesEqual(a, b)).toBe(false);

        const c = captureDeviceState(device);
        expect(patchesEqual(b, c)).toBe(true);
    });
});