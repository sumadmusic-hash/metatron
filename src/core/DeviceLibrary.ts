import { Device } from "./model/Device";
import { Storage } from "../persistence/Storage";
import { BindingManager } from "./BindingManager";

/** Pick the device to restore on app start (I18 §13): the most-recently-used
 *  note when it still exists, else the first saved device (insertion order) —
 *  `listDevices()` is creation-order, NOT recency. Returns undefined when no
 *  device exists. Pure and exported for direct testing; main.ts is the caller. */
export function resolveStartupDeviceId(
    savedDeviceIds: string[],
    lastActiveDeviceId: string | undefined,
): string | undefined {
    if (savedDeviceIds.length === 0) return undefined;
    if (lastActiveDeviceId !== undefined && savedDeviceIds.includes(lastActiveDeviceId)) {
        return lastActiveDeviceId;
    }
    return savedDeviceIds[0];
}

export class DeviceLibrary {
    // Keeps a reference to the currently active device in memory
    public currentDevice?: Device;
    public bindingManager?: BindingManager;

    public createNewDevice(name: string = "New Device"): Device {
        this.currentDevice = new Device(name);
        this.markLastActive(this.currentDevice.id);
        return this.currentDevice;
    }

    public loadDevice(id: string): Device | undefined {
        const device = Storage.loadDevice(id);
        if (device) {
            this.currentDevice = device;
            this.markLastActive(id);
        }
        return device;
    }

    public saveCurrentDevice() {
        if (this.currentDevice) {
            Storage.saveDevice(this.currentDevice);
        }
    }

    /** Persist an EXACT device instance — not the current one. Used by the
     *  trailing value/matrix save queues: after a device switch, a pending
     *  save captured BEFORE the switch must persist THAT device, never the new
     *  currentDevice (otherwise the old device's change is lost or written
     *  onto the new one). Deliberately does NOT touch the last-active note. */
    public saveDevice(device: Device) {
        Storage.saveDevice(device);
    }

    /** Public, observable last-active note (Bug: library undo/redo must keep
     *  `metatron_last_device_id` consistent with the device actually activated
     *  by the history layer, e.g. after undo of a device delete). */
    public markLastActiveDevice(id: string) {
        this.markLastActive(id);
    }

    public clearLastActiveDevice() {
        this.clearLastActive();
    }

    public listDevices(): { id: string, name: string }[] {
        return Storage.listDevices();
    }
    
    public renameCurrentDevice(newName: string) {
        if (this.currentDevice) {
            this.currentDevice.name = newName;
            this.saveCurrentDevice();
        }
    }

    public deleteDevice(id: string) {
        // Atomic: only update currentDevice AFTER storage delete succeeds.
        // If storage fails, currentDevice remains valid and the error propagates.
        Storage.deleteDevice(id);
        if (this.currentDevice?.id === id) {
            this.currentDevice = undefined;
        }
        // The deleted device can never be the restore target again.
        if (Storage.getLastActiveDeviceId() === id) {
            this.clearLastActive();
        }
    }

    public hasDevices(): boolean {
        return Storage.listDevices().length > 0;
    }

    /** Best-effort "most recently used" note (I18 §13). A failure to write the
     *  note must never break the device-switch itself — log and continue. */
    private markLastActive(id: string) {
        try {
            Storage.saveLastActiveDeviceId(id);
        } catch (e) {
            console.warn("Last-active-device note could not be persisted.", e);
        }
    }

    private clearLastActive() {
        try {
            Storage.clearLastActiveDeviceId();
        } catch (e) {
            console.warn("Last-active-device note could not be cleared.", e);
        }
    }
}