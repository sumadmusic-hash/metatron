import { describe, it, expect, beforeEach } from 'vitest';
import { DeviceLibrary } from '../../src/core/DeviceLibrary';
import { Control } from '../../src/core/model/Control';

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