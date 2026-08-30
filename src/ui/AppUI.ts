import { DeviceLibrary } from "../core/DeviceLibrary";
import { NexusAdapter } from "../nexus/NexusAdapter";
import { MidiAccess } from "../midi/MidiAccess";
import { MidiMapping } from "../midi/MidiMapping";
import { BindingManager } from "../core/BindingManager";
import { EditorUI } from "./editor/EditorUI";
import { SurfaceUI } from "./surface/SurfaceUI";
import { DeviceLibraryUI } from "./DeviceLibraryUI";
import { Toast } from "./Toast";
import "./styles.css";

export class AppUI {
    private root: HTMLElement;
    private deviceLibrary: DeviceLibrary;
    private nexusAdapter: NexusAdapter;
    private midiAccess: MidiAccess;
    private bindingManager: BindingManager;

    private currentMode: "EDIT" | "USE" = "EDIT";
    private libraryOpen = true;

    private editorUI: EditorUI;
    private surfaceUI: SurfaceUI;
    private libraryUI: DeviceLibraryUI;
    private midiMapping: MidiMapping;
    private connectionUnsub?: () => void;

    constructor(
        root: HTMLElement, 
        deviceLibrary: DeviceLibrary, 
        nexusAdapter: NexusAdapter, 
        midiAccess: MidiAccess,
        bindingManager: BindingManager | null
    ) {
        this.root = root;
        this.deviceLibrary = deviceLibrary;
        this.nexusAdapter = nexusAdapter;
        this.midiAccess = midiAccess;
        this.bindingManager = bindingManager ?? new BindingManager(this.deviceLibrary.currentDevice ?? this.deviceLibrary.createNewDevice("My Device"));

        const device = this.deviceLibrary.currentDevice;
        if (device) {
            this.bindingManager.setDevice(device);
        }
        this.midiMapping = new MidiMapping(device ?? this.deviceLibrary.createNewDevice("My Device"));

        // Nexus → UI: remote parameter changes update the matching control in place
        this.nexusAdapter.onNexusValueChanged = (controlId, newValue) => {
            const control = this.deviceLibrary.currentDevice?.getControl(controlId);
            if (!control) return;
            control.value = newValue;
            this.deviceLibrary.saveCurrentDevice();
            this.surfaceUI.applyNexusValue(controlId, newValue);
        };

        // MIDI → UI: incoming CC drives bound controls (§28-32)
        const midiHandler = (_channel: number, _cc: number, _value: number) => {
            const controlId = this.midiMapping.getControlIdForMessage(_channel, _cc);
            if (!controlId) return;
            const control = this.deviceLibrary.currentDevice?.getControl(controlId);
            if (!control) return;
            const normalized = Math.min(1, Math.max(0, _value / 127));
            this.applyValueToDevice(controlId, normalized);
        };
        this.midiAccess.setMessageHandler(midiHandler);

        this.surfaceUI = new SurfaceUI(
            this.deviceLibrary,
            this.nexusAdapter,
            this.midiAccess,
            this.bindingManager,
            this.midiMapping,
            (controlId, value) => this.applyValueToDevice(controlId, value),
            midiHandler
        );

        this.editorUI = new EditorUI(
            this.deviceLibrary,
            this.nexusAdapter,
            this.bindingManager,
            this.midiAccess,
            this.midiMapping,
            midiHandler
        );
        this.libraryUI = new DeviceLibraryUI(
            this.deviceLibrary,
            () => this.onDeviceChanged(),
            () => this.onPresetLoad(),
            this.nexusAdapter,
            this.bindingManager
        );
    }

    private applyValueToDevice(controlId: string, value: number) {
        const control = this.deviceLibrary.currentDevice?.getControl(controlId);
        if (!control) return;
        control.value = value;
        this.deviceLibrary.saveCurrentDevice();
        this.surfaceUI.applyNexusValue(controlId, value);
        void this.nexusAdapter.updateBoundControl(controlId, value);
    }

    /**
     * Preset load semantics: values are already restored onto the controls by
     * Device.loadPreset. Push to Nexus ONLY for CONNECTED controls; DISCONNECTED
     * controls must NOT write — their restored value stays stored for later
     * manual reconnection.
     */
    private onPresetLoad() {
        const device = this.deviceLibrary.currentDevice;
        if (!device) return;
        device.controls.forEach((c) => {
            if (!c.archived && c.activeBindingState === "CONNECTED") {
                void this.nexusAdapter.updateBoundControl(c.id, c.value);
            }
        });
    }

    private onDeviceChanged() {
        const device = this.deviceLibrary.currentDevice;
        if (device) {
            this.bindingManager.setDevice(device);
            this.midiMapping.updateDevice(device);
        }
        this.render();
    }

    private connectionLabel(): string {
        if (!this.nexusAdapter.document) return "Disconnected";
        return this.nexusAdapter.isDocumentConnected() ? "Connected" : "Disconnected (no sync)";
    }

    public render() {
        this.root.innerHTML = "";

        // Toolbar
        const toolbar = document.createElement("div");
        toolbar.className = "toolbar";

        const title = document.createElement("h1");
        title.innerText = `Metatron${this.deviceLibrary.currentDevice ? ` | ${this.deviceLibrary.currentDevice.name}` : ""}`;
        title.style.marginRight = "20px";
        title.style.whiteSpace = "nowrap";
        toolbar.appendChild(title);

        const libraryBtn = document.createElement("button");
        libraryBtn.className = "btn" + (this.libraryOpen ? " active" : "");
        libraryBtn.innerText = "Device Library";
        libraryBtn.onclick = () => {
            this.libraryOpen = !this.libraryOpen;
            this.render();
        };
        toolbar.appendChild(libraryBtn);

        // Project Connection UI
        const connectionContainer = document.createElement("div");
        connectionContainer.style.display = "flex";
        connectionContainer.style.alignItems = "center";
        connectionContainer.style.gap = "10px";
        connectionContainer.style.flex = "1";

        const urlInput = document.createElement("input");
        urlInput.type = "text";
        urlInput.placeholder = "Audiotool Project URL...";
        urlInput.style.flex = "1";
        urlInput.style.maxWidth = "400px";
        urlInput.style.padding = "8px 12px";
        urlInput.style.backgroundColor = "rgba(0,0,0,0.2)";
        urlInput.style.color = "white";
        urlInput.style.border = "1px solid var(--border-color)";
        urlInput.style.borderRadius = "6px";
        urlInput.style.outline = "none";
        
        const connectBtn = document.createElement("button");
        connectBtn.className = "btn";
        connectBtn.innerText = "Connect";
        
        const connectionStatus = document.createElement("span");
        connectionStatus.style.fontSize = "12px";
        connectionStatus.style.color = "var(--text-secondary)";
        connectionStatus.innerText = this.connectionLabel();

        const applyStatusText = (text: string, color: string) => {
            connectionStatus.innerText = text;
            connectionStatus.style.color = color;
        };

        connectBtn.onclick = async () => {
            if (!urlInput.value) {
                Toast.show("Enter an Audiotool project URL first.", "error");
                return;
            }
            try {
                applyStatusText("Connecting...", "#ffeb3b");
                this.connectionUnsub?.();
                this.connectionUnsub = undefined;
                await this.nexusAdapter.openProject(urlInput.value, this.bindingManager);
                this.connectionUnsub = this.nexusAdapter.onDocumentConnectedChanged((connected) => {
                    if (!connected) {
                        applyStatusText("Sync lost — reconnect project", "#f44336");
                        console.warn("[METATRON LEARN] document.connected=false — Nexus events will NOT arrive (learn would time out)");
                    } else {
                        applyStatusText("Connected", "#4CAF50");
                    }
                });
                Toast.show("Project connected.", "success");
            } catch (e) {
                console.error("Connection error", e);
                applyStatusText("Error", "#f44336");
                Toast.show(`Connection failed: ${e instanceof Error ? e.message : String(e)}`, "error");
            }
        };

        connectionContainer.appendChild(urlInput);
        connectionContainer.appendChild(connectBtn);
        connectionContainer.appendChild(connectionStatus);
        
        toolbar.appendChild(connectionContainer);

        const modeToggle = document.createElement("button");
        modeToggle.className = "btn primary";
        modeToggle.innerText = this.currentMode === "EDIT" ? "Switch to USE Mode" : "Switch to EDIT Mode";
        modeToggle.onclick = () => {
            this.currentMode = this.currentMode === "EDIT" ? "USE" : "EDIT";
            this.render();
        };
        toolbar.appendChild(modeToggle);

        this.root.appendChild(toolbar);

        // Main Content Area
        const contentRow = document.createElement("div");
        contentRow.className = "content-row";

        if (this.libraryOpen) {
            const sidebar = document.createElement("aside");
            sidebar.className = "device-sidebar-wrap";
            this.libraryUI.render(sidebar);
            contentRow.appendChild(sidebar);
        }

        const contentArea = document.createElement("div");
        contentArea.className = "content-area";
        
        if (this.currentMode === "EDIT") {
            this.editorUI.render(contentArea);
        } else {
            this.surfaceUI.render(contentArea);
        }

        contentRow.appendChild(contentArea);
        this.root.appendChild(contentRow);
    }
}