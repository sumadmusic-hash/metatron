import { Device } from "../core/model/Device";

export class Storage {
    private static readonly STORAGE_KEY = "metatron_devices";

    public static saveDevice(device: Device) {
        const devices = this.loadAllDevices();
        devices.set(device.id, device.serialize());
        
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(Object.fromEntries(devices)));
        } catch (e) {
            console.error("Failed to save device to local storage:", e);
        }
    }

    public static loadDevice(id: string): Device | undefined {
        const devices = this.loadAllDevices();
        const data = devices.get(id);
        if (data) {
            return Device.deserialize(data);
        }
        return undefined;
    }

    public static deleteDevice(id: string) {
        const devices = this.loadAllDevices();
        if (devices.has(id)) {
            devices.delete(id);
            try {
                localStorage.setItem(this.STORAGE_KEY, JSON.stringify(Object.fromEntries(devices)));
            } catch (e) {
                console.error("Failed to update local storage after deletion:", e);
            }
        }
    }

    public static listDevices(): { id: string, name: string }[] {
        const devices = this.loadAllDevices();
        const result: { id: string, name: string }[] = [];
        
        devices.forEach((data, id) => {
            result.push({ id, name: data.name });
        });
        
        return result;
    }

    private static loadAllDevices(): Map<string, any> {
        try {
            const data = localStorage.getItem(this.STORAGE_KEY);
            if (data) {
                const parsed = JSON.parse(data);
                return new Map(Object.entries(parsed));
            }
        } catch (e) {
            console.error("Failed to parse devices from local storage:", e);
        }
        return new Map();
    }
}
