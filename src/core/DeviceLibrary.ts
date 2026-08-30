import { Device } from "./model/Device";
import { Storage } from "../persistence/Storage";

export class DeviceLibrary {
    // Keeps a reference to the currently active device in memory
    public currentDevice?: Device;

    public createNewDevice(name: string = "New Device"): Device {
        this.currentDevice = new Device(name);
        return this.currentDevice;
    }

    public loadDevice(id: string): Device | undefined {
        const device = Storage.loadDevice(id);
        if (device) {
            this.currentDevice = device;
        }
        return device;
    }

    public saveCurrentDevice() {
        if (this.currentDevice) {
            Storage.saveDevice(this.currentDevice);
        }
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
        if (this.currentDevice?.id === id) {
            this.currentDevice = undefined;
        }
        Storage.deleteDevice(id);
    }

    public hasDevices(): boolean {
        return Storage.listDevices().length > 0;
    }
}
