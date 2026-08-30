import { generateId } from "./types";

export class Preset {
    public readonly id: string;
    public name: string;
    public readonly deviceId: string;
    
    // Map of Control ID -> Value
    public controlValues: Record<string, number> = {};

    constructor(name: string, deviceId: string, id?: string) {
        this.id = id ?? generateId("pst");
        this.name = name;
        this.deviceId = deviceId;
    }

    public serialize(): object {
        return {
            id: this.id,
            name: this.name,
            deviceId: this.deviceId,
            controlValues: this.controlValues
        };
    }

    public static deserialize(data: any): Preset {
        const p = new Preset(data.name, data.deviceId, data.id);
        p.controlValues = data.controlValues || {};
        return p;
    }
}
