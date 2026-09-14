import { DeviceLibrary, resolveStartupDeviceId } from "./core/DeviceLibrary";
import { Storage } from "./persistence/Storage";
import { NexusAdapter } from "./nexus/NexusAdapter";
import { MidiAccess } from "./midi/MidiAccess";
import { BindingManager } from "./core/BindingManager";
import { AppUI } from "./ui/AppUI";
import { Toast } from "./ui/Toast";

async function bootstrap() {
    console.log("Starting Metatron...");

    // 1. Initialize Core Models
    const deviceLibrary = new DeviceLibrary();
    
    // Restore the MOST-RECENTLY-USED device if any exist; do NOT auto-create a
    // placeholder — a brand-new device must come from the UI (§20/§48).
    // `listDevices()` returns insertion order — without the last-active note
    // (I18 §13, tracked by DeviceLibrary) a reload would open the OLDEST device.
    try {
        const savedDevices = deviceLibrary.listDevices();
        const startupId = resolveStartupDeviceId(
            savedDevices.map((d) => d.id),
            Storage.getLastActiveDeviceId(),
        );
        if (savedDevices.length > 0 && startupId) {
            deviceLibrary.loadDevice(startupId);
            console.log(`Loaded device: ${deviceLibrary.currentDevice?.name}`);
        } else {
            console.log("No saved devices — awaiting creation via Device Library UI.");
        }
    } catch (e) {
        console.error("Failed to restore saved devices", e);
        Toast.show("Speicherfehler: Geräte konnten nicht geladen werden. Starte mit leerem Zustand.", "error");
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
