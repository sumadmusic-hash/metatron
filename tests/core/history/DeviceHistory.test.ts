import { describe, it, expect, vi, beforeEach } from "vitest";
import { Device } from "../../../src/core/model/Device";
import { Control } from "../../../src/core/model/Control";
import { Group } from "../../../src/core/model/Group";
import { DeviceLibrary } from "../../../src/core/DeviceLibrary";
import { DeviceHistory, captureDeviceState, restoreDeviceState } from "../../../src/core/history/DeviceHistory";
import { HISTORY_LIMIT, patchesEqual } from "../../../src/core/history/HistoryAction";
import type { DeviceStatePatch } from "../../../src/core/history/HistoryAction";
import { Storage } from "../../../src/persistence/Storage";
import { BindingManager } from "../../../src/core/BindingManager";

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
    (globalThis as any).localStorage = new FakeStorage();
});

describe("DeviceHistory — capture/restore exactness (C1 scope)", () => {

    it("capture → mutate → restore gives the EXACT prior structural state", () => {
        const device = new Device("D");
        const a = addKnob(device, "Cutoff", 100, 100);
        const g = new Group("FILTER", { x: 50, y: 50 }, { width: 240, height: 180 });
        device.addGroup(g);
        device.setControlGroup(a.id, g.id);
        device.savePreset("Snap");

        const before = captureDeviceState(device);

        // A burst of mutations across all scopes.
        a.position = { x: 999, y: 999 };
        a.size = { width: 40, height: 40 };
        a.name = "Renamed";
        a.archived = true;
        a.visualDefinition = { color: "#ff0000" };
        device.setControlGroup(a.id, undefined);
        g.name = "MOVED";
        g.color = "#00ff00";
        g.position = { x: 1, y: 2 };
        g.size = { width: 3, height: 4 };
        const p = device.presets.values().next().value as any;
        p.name = "Nope";
        p.controlValues = {};
        device.deletePreset(p.id);
        device.name = "X";

        restoreDeviceState(device, before);

        expect(device.name).toBe("D");
        expect(device.controls.size).toBe(1);
        expect(device.groups.size).toBe(1);
        expect(device.presets.size).toBe(1);
        const restored = device.getControl(a.id)!;
        expect(restored.name).toBe("Cutoff");
        expect(restored.position).toEqual({ x: 100, y: 100 });
        expect(restored.size).toEqual({ width: 120, height: 120 });
        expect(restored.groupId).toBe(g.id);
        expect(restored.archived).toBe(false);
        expect(restored.visualDefinition).toEqual({});
        const restoredGroup = device.getGroup(g.id)!;
        expect(restoredGroup.name).toBe("FILTER");
        expect(restoredGroup.color).toBe("#333333");
        expect(restoredGroup.position).toEqual({ x: 50, y: 50 });
        expect(restoredGroup.size).toEqual({ width: 240, height: 180 });
        const restoredPreset = device.presets.values().next().value as any;
        expect(restoredPreset.name).toBe("Snap");
        expect(restoredPreset.controlValues[a.id]).toBe(0);
    });

    it("restore preserves OBJECT IDENTITY (live bindings/subscriptions stay valid)", () => {
        const device = new Device("D");
        const a = addKnob(device, "A", 100, 100);
        const before = captureDeviceState(device);
        a.position = { x: 500, y: 500 };
        restoreDeviceState(device, before);
        expect(device.getControl(a.id)).toBe(a);
    });

    it("preset load is exactly undoable (control values restored)", () => {
        const device = new Device("D");
        const a = addKnob(device, "A", 100, 100);
        a.value = 0.5;
        const preset = device.savePreset("Snap A");
        preset.controlValues[a.id] = 0.9;

        const before = captureDeviceState(device);
        a.value = 0.2;
        device.loadPreset(preset.id);
        expect(a.value).toBe(0.9);
        const after = captureDeviceState(device);
        expect(after.controls[a.id].value).toBe(0.9);

        restoreDeviceState(device, before);
        expect(a.value).toBe(0.5);
    });

    it("group move restore brings member controls back too", () => {
        const device = new Device("D");
        const g = new Group("G", { x: 100, y: 100 }, { width: 240, height: 180 });
        device.addGroup(g);
        const m = addKnob(device, "M", 120, 120);
        device.setControlGroup(m.id, g.id);
        const before = captureDeviceState(device);

        device.moveGroup(g.id, 40, 60);
        expect(m.position).toEqual({ x: 160, y: 180 });
        restoreDeviceState(device, before);
        expect(g.position).toEqual({ x: 100, y: 100 });
        expect(m.position).toEqual({ x: 120, y: 120 });
    });

    it("hard-deleted entries are reconstructed by restore", () => {
        const device = new Device("D");
        const a = addKnob(device, "A", 100, 100);
        const g = new Group("G", { x: 10, y: 10 }, { width: 100, height: 100 });
        device.addGroup(g);
        const before = captureDeviceState(device);

        device.removeControl(a.id, true);
        device.removeGroup(g.id);
        expect(device.controls.size).toBe(0);
        expect(device.groups.size).toBe(0);

        restoreDeviceState(device, before);
        expect(device.controls.size).toBe(1);
        expect(device.getControl(a.id)?.name).toBe("A");
        expect(device.getControl(a.id)?.position).toEqual({ x: 100, y: 100 });
        expect(device.groups.size).toBe(1);
    });
});

describe("DeviceHistory — stack semantics (record/undo/redo)", () => {

    function freshHistory(): { lib: DeviceLibrary; history: DeviceHistory; device: Device } {
        const device = new Device("D");
        addKnob(device, "A", 100, 100);
        const lib = makeLibrary(device);
        return { lib, history: new DeviceHistory(lib), device };
    }

    it("empty undo/redo are side-effect-free and return false", () => {
        const { history, device } = freshHistory();
        const before = captureDeviceState(device);
        const onChange = vi.fn();
        history.onChange = onChange;

        expect(history.undo()).toBe(false);
        expect(history.redo()).toBe(false);
        expect(onChange).not.toHaveBeenCalled();
        expect(captureDeviceState(device)).toEqual(before);
    });

    it("undo restores exactly, redo reproduces exactly (position move)", () => {
        const { history, device } = freshHistory();
        const a = device.getControl(device.controls.keys().next().value)!;
        const before = history.captureDeviceState(device);
        a.position = { x: 200, y: 150 };
        const after = history.captureDeviceState(device);
        history.record({ type: "control.move", scope: "device", deviceId: device.id, before, after });

        expect(history.canUndo).toBe(true);
        expect(history.canRedo).toBe(false);
        expect(history.undo()).toBe(true);
        expect(a.position).toEqual({ x: 100, y: 100 });
        expect(history.canRedo).toBe(true);
        expect(history.redo()).toBe(true);
        expect(a.position).toEqual({ x: 200, y: 150 });
    });

    it("multiple actions undo/redo in LIFO order", () => {
        const { history, device } = freshHistory();
        const a = device.getControl(device.controls.keys().next().value)!;
        const b = addKnob(device, "B", 200, 200);

        const rec = (id: string, label: string, dx: number, dy: number) => {
            const before = history.captureDeviceState(device);
            device.getControl(id)!.position = { x: device.getControl(id)!.position.x + dx, y: device.getControl(id)!.position.y + dy };
            const after = history.captureDeviceState(device);
            history.record({ type: label, scope: "device", deviceId: device.id, before, after });
        };
        rec(a.id, "control.move", 50, 0); // A → 150,100
        rec(b.id, "control.move", 0, 80); // B → 200,280

        history.undo();
        expect(b.position).toEqual({ x: 200, y: 200 }); // B undone first
        expect(a.position).toEqual({ x: 150, y: 100 });
        history.undo();
        expect(a.position).toEqual({ x: 100, y: 100 }); // then A
        history.redo();
        expect(a.position).toEqual({ x: 150, y: 100 });
        expect(b.position).toEqual({ x: 200, y: 200 });
        history.redo();
        expect(b.position).toEqual({ x: 200, y: 280 });
    });

    it("a new action after undo clears the redo stack", () => {
        const { history, device } = freshHistory();
        const a = device.getControl(device.controls.keys().next().value)!;
        const before = history.captureDeviceState(device);
        a.position = { x: 400, y: 400 };
        const after = history.captureDeviceState(device);
        history.record({ type: "control.move", scope: "device", deviceId: device.id, before, after });

        expect(history.undo()).toBe(true);
        expect(history.canRedo).toBe(true);

        const b = addKnob(device, "C", 0, 0);
        const bBefore = history.captureDeviceState(device);
        b.name = "C2";
        const bAfter = history.captureDeviceState(device);
        history.record({ type: "control.rename", scope: "device", deviceId: device.id, before: bBefore, after: bAfter });

        expect(history.canRedo).toBe(false);
        expect(history.redo()).toBe(false);
    });

    it(`enforces the ${HISTORY_LIMIT}-action cap (oldest evicted)`, () => {
        const { history, device } = freshHistory();
        const a = device.getControl(device.controls.keys().next().value)!;
        for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
            const before = history.captureDeviceState(device);
            a.position = { x: i, y: i };
            const after = history.captureDeviceState(device);
            history.record({ type: "control.move", scope: "device", deviceId: device.id, before, after });
        }
        expect(history.undoLength).toBe(HISTORY_LIMIT);

        // Undo everything undoable: the first 5 recorded actions were evicted.
        // After undoing the oldest surviving action (i=5), its "before" state
        // is restored — which was captured BEFORE position moved to {5,5}, i.e.
        // {4,4}.
        let undone = 0;
        while (history.undo()) undone++;
        expect(undone).toBe(HISTORY_LIMIT);
        expect(history.canUndo).toBe(false);
        expect(a.position.x).toBe(4);
    });

    it("undo/redo persists through the existing saveCurrentDevice path", () => {
        const { lib, history, device } = freshHistory();
        const a = device.getControl(device.controls.keys().next().value)!;
        const before = history.captureDeviceState(device);
        a.position = { x: 320, y: 320 };
        const after = history.captureDeviceState(device);
        history.record({ type: "control.move", scope: "device", deviceId: device.id, before, after });
        lib.saveCurrentDevice();

        history.undo();
        const reloaded = Storage.loadDevice(device.id)!;
        expect(reloaded.getControl(a.id)?.position).toEqual({ x: 100, y: 100 });

        history.redo();
        const reloaded2 = Storage.loadDevice(device.id)!;
        expect(reloaded2.getControl(a.id)?.position).toEqual({ x: 320, y: 320 });
    });

    it("never applies a device action to a DIFFERENT active device", () => {
        const { history, device } = freshHistory();
        const a = device.getControl(device.controls.keys().next().value)!;
        const before = history.captureDeviceState(device);
        a.position = { x: 300, y: 300 };
        const after = history.captureDeviceState(device);
        history.record({ type: "control.move", scope: "device", deviceId: device.id, before, after });

        // Switch the active device BEFORE undoing.
        const other = new Device("Other");
        history["library"].currentDevice = other;

        expect(history.undo()).toBe(false);
        expect(history.canUndo).toBe(true); // action kept
        expect(other.controls.size).toBe(0);
        expect(a.position).toEqual({ x: 300, y: 300 });
    });
});

describe("DeviceHistory — library scope (device create/delete/rename)", () => {

    it("device.create is undone by removing the device and restoring the previous active", () => {
        const lib = new DeviceLibrary();
        const first = lib.createNewDevice("First");
        lib.saveCurrentDevice();
        expect(lib.listDevices().length).toBe(1);
        const history = new DeviceHistory(lib);

        const before = history.captureLibraryState();
        lib.createNewDevice("Second");
        lib.saveCurrentDevice();
        const after = history.captureLibraryState();
        history.record({ type: "device.create", scope: "library", deviceId: null, before, after });

        expect(lib.listDevices().length).toBe(2);
        expect(lib.currentDevice?.name).toBe("Second");

        expect(history.undo()).toBe(true);
        expect(lib.listDevices().map((d) => d.name)).toEqual(["First"]);
        expect(lib.currentDevice?.id).toBe(first.id);

        expect(history.redo()).toBe(true);
        const names = lib.listDevices().map((d) => d.name);
        expect(names).toEqual(["First", "Second"]);
        expect(lib.currentDevice?.name).toBe("Second");
    });

    it("device.delete is undone by restoring the removed device and re-activating it", () => {
        const lib = new DeviceLibrary();
        const a = lib.createNewDevice("A");
        lib.saveCurrentDevice();
        const b = lib.createNewDevice("B");
        lib.saveCurrentDevice();
        lib.loadDevice(a.id);
        expect(lib.currentDevice?.name).toBe("A");

        const history = new DeviceHistory(lib);
        const before = history.captureLibraryState();
        lib.deleteDevice(a.id);
        lib.loadDevice(b.id);
        const after = history.captureLibraryState();
        history.record({ type: "device.delete", scope: "library", deviceId: null, before, after });
        expect(lib.listDevices().map((d) => d.name)).toEqual(["B"]);

        expect(history.undo()).toBe(true);
        expect(lib.listDevices().map((d) => d.name).sort()).toEqual(["A", "B"]);
        expect(lib.currentDevice?.id).toBe(a.id);

        expect(history.redo()).toBe(true);
        expect(lib.listDevices().map((d) => d.name)).toEqual(["B"]);
        expect(lib.currentDevice?.id).toBe(b.id);
    });

    it("deleting the LAST device is fully undone", () => {
        const lib = new DeviceLibrary();
        lib.createNewDevice("Only");
        lib.saveCurrentDevice();
        const history = new DeviceHistory(lib);

        const before = history.captureLibraryState();
        const id = lib.currentDevice!.id;
        lib.deleteDevice(id);
        const after = history.captureLibraryState();
        history.record({ type: "device.delete", scope: "library", deviceId: null, before, after });
        expect(lib.hasDevices()).toBe(false);
        expect(lib.currentDevice).toBeUndefined();

        expect(history.undo()).toBe(true);
        expect(lib.listDevices().map((d) => d.name)).toEqual(["Only"]);
        expect(lib.currentDevice?.name).toBe("Only");
    });
});

describe("DeviceHistory — remaining C1 semantic guarantees", () => {

    it("device.rename restores the previous name through undo", () => {
        const device = new Device("Old");
        const lib = makeLibrary(device);
        const history = new DeviceHistory(lib);
        const before = history.captureDeviceState(device);
        lib.renameCurrentDevice("New Name");
        const after = history.captureDeviceState(device);
        history.record({ type: "device.rename", scope: "device", deviceId: device.id, before, after });

        history.undo();
        expect(device.name).toBe("Old");
        expect(lib.listDevices()[0].name).toBe("Old");
        history.redo();
        expect(device.name).toBe("New Name");
    });

    it("session-scoped: nothing is persisted by the history itself (no storage key)", () => {
        const device = new Device("D");
        const lib = makeLibrary(device);
        addKnob(device, "A", 100, 100);
        const history = new DeviceHistory(lib);
        const a = device.getControl(device.controls.keys().next().value)!;
        const before = history.captureDeviceState(device);
        a.position = { x: 1, y: 2 };
        const after = history.captureDeviceState(device);
        history.record({ type: "control.move", scope: "device", deviceId: device.id, before, after });

        const keys = Object.keys((globalThis as any).localStorage as Record<string, unknown>);
        expect(keys).not.toContain("metatron_history");
    });

    it("patchesEqual detects structural change deterministically", () => {
        const a = { name: "X", controls: { c1: { value: 1, pos: { x: 1 } } } };
        const b = { name: "X", controls: { c1: { value: 1, pos: { x: 1 } } } };
        const c = { name: "X", controls: { c1: { value: 2, pos: { x: 1 } } } };
        expect(patchesEqual(a, b)).toBe(true);
        expect(patchesEqual(a, c)).toBe(false);
        expect(patchesEqual(null, {})).toBe(false);
    });

    it("does not expose history actions for transient value flows (learn/binding are never recorded)", () => {
        const device = new Device("D");
        const a = addKnob(device, "A", 100, 100);
        const lib = makeLibrary(device);
        const history = new DeviceHistory(lib);

        // Value-only changes (Nexus/MIDI route) must not create actions.
        a.value = 0.7;
        a.value = 1.0;
        // ActiveBindings are transient — never recorded.
        const bm = new BindingManager(device);
        bm.setBinding(a.id, "entity-1", "cutoff", "Cutoff", {}, "filter.cutoff");
        bm.setBinding(a.id, "entity-1", "cutoff", "Cutoff", {}, "filter.cutoff");

        expect(history.undoLength).toBe(0);
        expect(history.canUndo).toBe(false);
        expect(history.undo()).toBe(false);
        const patch: DeviceStatePatch = history.captureDeviceState(device);
        expect(patch.controls[a.id].value).toBe(1.0);
    });
});