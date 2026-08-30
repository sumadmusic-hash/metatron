export class MidiAccess {
    private midiAccess: MIDIAccess | null = null;
    private onMessageCallback?: (channel: number, cc: number, value: number) => void;

    public async initialize(): Promise<boolean> {
        if (!navigator.requestMIDIAccess) {
            console.warn("Web MIDI API not supported in this browser.");
            return false;
        }

        try {
            this.midiAccess = await navigator.requestMIDIAccess();
            
            // Listen to all currently connected inputs
            for (const input of this.midiAccess.inputs.values()) {
                input.onmidimessage = this.handleMidiMessage.bind(this);
            }

            // Handle devices being plugged in/out
            this.midiAccess.onstatechange = (event) => {
                const port = event.port;
                if (port && port.type === "input" && port.state === "connected") {
                    const input = port as MIDIInput;
                    input.onmidimessage = this.handleMidiMessage.bind(this);
                }
            };

            return true;
        } catch (e) {
            console.error("Failed to acquire MIDI access", e);
            return false;
        }
    }

    public setMessageHandler(callback: (channel: number, cc: number, value: number) => void) {
        this.onMessageCallback = callback;
    }

    private handleMidiMessage(event: MIDIMessageEvent) {
        if (!event.data || event.data.length < 3) return;

        const statusByte = event.data[0];
        const data1 = event.data[1];
        const data2 = event.data[2];

        // 0xB0 to 0xBF are Control Change messages (channels 1-16)
        if (statusByte >= 0xB0 && statusByte <= 0xBF) {
            const channel = (statusByte & 0x0F) + 1; // 1-16
            const cc = data1;
            const value = data2;

            if (this.onMessageCallback) {
                this.onMessageCallback(channel, cc, value);
            }
        }
    }
}
