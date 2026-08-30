import { DeviceLibrary } from "./core/DeviceLibrary";
import { NexusAdapter } from "./nexus/NexusAdapter";
import { MidiAccess } from "./midi/MidiAccess";
import { BindingManager } from "./core/BindingManager";
import { AppUI } from "./ui/AppUI";

async function bootstrap() {
    console.log("Starting Metatron...");

    // 1. Initialize Core Models
    const deviceLibrary = new DeviceLibrary();
    
    // Restore largest-recently-used device if any exist; do NOT auto-create a
    // placeholder — a brand-new device must come from the UI (§20/§48).
    const savedDevices = deviceLibrary.listDevices();
    if (savedDevices.length > 0) {
        deviceLibrary.loadDevice(savedDevices[0].id);
        console.log(`Loaded device: ${deviceLibrary.currentDevice?.name}`);
    } else {
        console.log("No saved devices — awaiting creation via Device Library UI.");
    }

    // 2. Initialize Nexus Adapter
    const nexusAdapter = new NexusAdapter();
    // Set VITE_AUDIOTOOL_CLIENT_ID in your environment for a real client;
    // this dev fallback only works if it matches a registered application.
    const CLIENT_ID = import.meta.env.VITE_AUDIOTOOL_CLIENT_ID || "e498c930-864a-4ef0-8d57-b8a176bee096";
    
    try {
        const isAuthenticated = await nexusAdapter.authenticate(CLIENT_ID);
        console.log(`Nexus Authenticated: ${isAuthenticated}`);
    } catch (e) {
        console.error("Nexus Authentication Failed", e);
    }
    
    // 3. Initialize MIDI
    const midiAccess = new MidiAccess();
    const hasMidi = await midiAccess.initialize();
    console.log(`MIDI Initialized: ${hasMidi}`);

    // 4. Initialize Binding Manager (created per current device; null-safe in AppUI)
    const bindingManager: BindingManager | null = deviceLibrary.currentDevice ? new BindingManager(deviceLibrary.currentDevice) : null;

    // 5. Mount UI
    const rootElement = document.getElementById("app");
    if (rootElement) {
        const appUI = new AppUI(
            rootElement, 
            deviceLibrary, 
            nexusAdapter, 
            midiAccess,
            bindingManager
        );
        appUI.render();
    }
}

bootstrap().catch(console.error);
