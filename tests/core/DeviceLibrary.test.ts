import { describe, it, expect, beforeEach } from 'vitest';
import { DeviceLibrary, resolveStartupDeviceId } from '../../src/core/DeviceLibrary';
import { Control } from '../../src/core/model/Control';
import { Storage } from '../../src/persistence/Storage';

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

describe('DeviceLibrary — Phase B library CRUD (§47/§48)', () => {
    let library: DeviceLibrary;

    beforeEach(() => {
        (globalThis as any).localStorage = new FakeStorage();
        Storage.resetCache();
        library = new DeviceLibrary();
    });

    it('new devices start empty — no automatic placeholder device (§20)', () => {
        expect(library.hasDevices()).toBe(false);
        expect(library.listDevices().length).toBe(0);

        const device = library.createNewDevice('Empty');
        expect(device.controls.size).toBe(0);
        expect(device.groups.size).toBe(0);
    });

    it('can rename the current device and persist the new name', () => {
        library.createNewDevice('First');
        library.saveCurrentDevice();
        library.renameCurrentDevice('Renamed');
        expect(library.listDevices()[0].name).toBe('Renamed');
    });

    it('can save, then load a device back with all controls intact', () => {
        const device = library.createNewDevice('Persist Me');
        device.addControl(new Control('knob', 'Cutoff'));
        library.saveCurrentDevice();

        const id = device.id;
        const restored = library.loadDevice(id);
        expect(restored?.name).toBe('Persist Me');
        expect(restored?.controls.size).toBe(1);
    });

    it('can switch between multiple devices', () => {
        const a = library.createNewDevice('A');
        library.saveCurrentDevice();
        const b = library.createNewDevice('B');
        library.saveCurrentDevice();
        expect(library.currentDevice?.name).toBe('B');

        library.loadDevice(a.id);
        expect(library.currentDevice?.name).toBe('A');
    });

    it('deleting the active device clears current and falls back to a remaining device', () => {
        const a = library.createNewDevice('A');
        library.saveCurrentDevice();
        const b = library.createNewDevice('B');
        library.saveCurrentDevice();

        // Switch to A, then delete it
        library.loadDevice(a.id);
        library.deleteDevice(a.id);
        expect(library.currentDevice).toBeUndefined();
        expect(library.listDevices().map(d => d.name)).toEqual(['B']);
        expect(library.hasDevices()).toBe(true);
    });

    it('deleting the last device leaves an empty library', () => {
        const a = library.createNewDevice('Only');
        library.saveCurrentDevice();
        library.deleteDevice(a.id);
        expect(library.hasDevices()).toBe(false);
        expect(library.currentDevice).toBeUndefined();
    });
});

describe('most-recently-used device note (I18 §13) — app-start restore', () => {
    beforeEach(() => {
        (globalThis as any).localStorage = new FakeStorage();
        Storage.resetCache();
    });

    it('resolveStartupDeviceId prefers the last-active note over insertion order', () => {
        expect(resolveStartupDeviceId(["dev-1", "dev-2", "dev-3"], "dev-2")).toBe("dev-2");
        expect(resolveStartupDeviceId(["dev-1", "dev-2", "dev-3"], undefined)).toBe("dev-1");
        expect(resolveStartupDeviceId(["dev-1", "dev-2"], "ghost-device")).toBe("dev-1");
        expect(resolveStartupDeviceId([], "dev-1")).toBeUndefined();
        expect(resolveStartupDeviceId([], undefined)).toBeUndefined();
    });

    it('creation/load track the last-active note; deletion clears a stale note', () => {
        const library = new DeviceLibrary();
        const a = library.createNewDevice('A');
        library.saveCurrentDevice();
        const b = library.createNewDevice('B');
        library.saveCurrentDevice();

        expect(Storage.getLastActiveDeviceId()).toBe(b.id);

        library.loadDevice(a.id);
        expect(Storage.getLastActiveDeviceId()).toBe(a.id);

        library.deleteDevice(a.id);
        expect(Storage.getLastActiveDeviceId()).toBeUndefined();
    });

    it('startup resolution restores the most-recently-used device — never the oldest', () => {
        const library = new DeviceLibrary();
        const first = library.createNewDevice('Oldest');
        library.saveCurrentDevice();
        library.createNewDevice('Newest');
        library.saveCurrentDevice();
        // The user last worked on the SECOND-created device.
        library.loadDevice('does-not-exist'); // no-op, note unchanged
        const newest = library.listDevices()[1];

        const startupId = resolveStartupDeviceId(
            library.listDevices().map((d) => d.id),
            Storage.getLastActiveDeviceId(),
        );
        library.loadDevice(startupId!);
        expect(library.currentDevice?.name).toBe(newest.name);
    });

    it('a stale note (deleted device) falls back to the first saved device', () => {
        const library = new DeviceLibrary();
        const kept = library.createNewDevice('Kept');
        library.saveCurrentDevice();
        const doomed = library.createNewDevice('Doomed');
        library.saveCurrentDevice();
        library.loadDevice(doomed.id);
        library.deleteDevice(doomed.id);

        const startupId = resolveStartupDeviceId(
            library.listDevices().map((d) => d.id),
            Storage.getLastActiveDeviceId(),
        );
        // Note was cleared on delete → fallback is the first (only) device.
        expect(Storage.getLastActiveDeviceId()).toBeUndefined();
        expect(startupId).toBe(kept.id);
    });
});