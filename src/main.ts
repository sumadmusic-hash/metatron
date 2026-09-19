import { DeviceLibrary, resolveStartupDeviceId } from "./core/DeviceLibrary";
import { Storage } from "./persistence/Storage";
import { NexusAdapter } from "./nexus/NexusAdapter";
import { MidiAccess } from "./midi/MidiAccess";
import { BindingManager } from "./core/BindingManager";
import { AppUI } from "./ui/AppUI";
import { Toast } from "./ui/Toast";
import { installBuiltinUICurves, getParameterUICurve, BUILTIN_UI_CURVES } from "./nexus/ParameterUICurve";
import { installBuiltinTapers, getTaper, BUILTIN_TAPERS } from "./nexus/CurveRegistry";

/** B6 — nicht blockierende Auth nach dem ersten Render: der OAuth-Handshake
 *  wird nie AWAITED bevor die Oberfläche steht (kein impliziter login()-Timer
 *  mehr, authenticate() ist passiv) und ein Fehler kippt den Boot nicht. R1 —
 *  nach Abschluss stößt der onAuthComplete-Callback ein Re-Render an, damit
 *  der Sign-in-Button verschwindet und das User-Badge (B72) erscheint. */
async function launchAuth(nexusAdapter: NexusAdapter, onAuthComplete?: () => void): Promise<void> {
    // Set VITE_AUDIOTOOL_CLIENT_ID in your environment for a real client;
    // this dev fallback only works if it matches a registered application.
    const CLIENT_ID = import.meta.env.VITE_AUDIOTOOL_CLIENT_ID || "e498c930-864a-4ef0-8d57-b8a176bee096";
    try {
        const isAuthenticated = await nexusAdapter.authenticate(CLIENT_ID);
        console.log(`Nexus Authenticated: ${isAuthenticated}`);
    } catch (e) {
        console.error("Nexus Authentication Failed", e);
    } finally {
        onAuthComplete?.();
    }
}

/** B6 — MIDI-Init hinter dem Render, Fehler abgefangen statt Boot-Optimist. */
async function launchMidi(midiAccess: MidiAccess): Promise<void> {
    try {
        const hasMidi = await midiAccess.initialize();
        console.log(`MIDI Initialized: ${hasMidi}`);
    } catch (e) {
        console.error("MIDI Initialization Failed", e);
    }
}

async function bootstrap() {
    console.log("Starting Metatron...");

    // 0. Install documented BUILT-IN UI curves (B73). Runs on every boot, so
    //    a page reload no longer wipes the measured knob↔nexus mapping.
    installBuiltinUICurves();
    console.log("[METATRON CURVE] Built-in UI curves installed:",
        BUILTIN_UI_CURVES.map(({ key }) => {
            const c = getParameterUICurve(key);
            return `${key} (${c?.points.length ?? 0}pts)`;
        }));

    // 0b. Install documented BUILT-IN Automation Tapers (B68). Runs on every
    //     boot so the measured Pulverisateur cutoff taper survives reload.
    installBuiltinTapers();
    console.log("[METATRON TAPER] Built-in tapers installed:",
        BUILTIN_TAPERS.map(({ key }) => {
            const t = getTaper(key);
            return `${key} (${t?.kind ?? "none"} ${t?.min ?? ""}..${t?.max ?? ""})`;
        }));

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

    // 2. Infrastruktur synchron konstruieren (nur Factory-Aufrufe, kein I/O).
    const nexusAdapter = new NexusAdapter();
    const midiAccess = new MidiAccess();

    // 3. Binding Manager (created per current device; null-safe in AppUI)
    const bindingManager: BindingManager | null = deviceLibrary.currentDevice ? new BindingManager(deviceLibrary.currentDevice) : null;

    // 4. Mount UI FIRST (B6): die Oberfläche muss sofort da sein; Auth und
    //    MIDI laufen danach fire-and-forget, ohne das erste Render zu warten
    //    oder die Seite via implizitem Login weiterzureißen.
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

        // 5b. Re-Render nach Auth-Abschluss (R1): Sign-in-Button raus, User-Badge rein.
        void launchAuth(nexusAdapter, () => appUI.render());
    }

    // 5. Nicht-blockierender Start: Auth + MIDI NACH dem Render, je
    //    Fehler-toleriert. (B6 — kein `await` vor dem Render.)
    void launchMidi(midiAccess);
}

bootstrap().catch(console.error);