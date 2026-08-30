import { Device } from "../core/model/Device";

export class MidiMapping {
    private device: Device;
    
    // Quick lookup: "channel:cc" -> controlId
    private ccMap: Map<string, string> = new Map();

    constructor(device: Device) {
        this.device = device;
        this.buildMap();
    }

    public updateDevice(device: Device) {
        this.device = device;
        this.buildMap();
    }

    private buildMap() {
        this.ccMap.clear();
        this.device.controls.forEach(control => {
            if (!control.archived && control.midiBindingDefinition) {
                const { channel, cc } = control.midiBindingDefinition;
                if (channel !== undefined && cc !== undefined) {
                    this.ccMap.set(`${channel}:${cc}`, control.id);
                }
            }
        });
    }

    public getControlIdForMessage(channel: number, cc: number): string | undefined {
        return this.ccMap.get(`${channel}:${cc}`);
    }

    public setMapping(controlId: string, channel: number, cc: number) {
        const control = this.device.getControl(controlId);
        if (control) {
            control.midiBindingDefinition = { channel, cc };
            this.buildMap();
        }
    }

    public clearMapping(controlId: string) {
        const control = this.device.getControl(controlId);
        if (control) {
            control.midiBindingDefinition = undefined;
            this.buildMap();
        }
    }
}
