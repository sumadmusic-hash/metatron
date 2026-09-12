import { DeviceLibrary } from "../core/DeviceLibrary";
import { NexusAdapter } from "../nexus/NexusAdapter";
import { MidiAccess } from "../midi/MidiAccess";
import { MidiMapping } from "../midi/MidiMapping";
import { applyMidiScaling } from "../midi/MidiScaling";
import { BindingManager } from "../core/BindingManager";
import { DeviceHistory } from "../core/history/DeviceHistory";
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
    private sidebarCollapsed = this.currentMode !== "EDIT";

    private history: DeviceHistory;
    private undoBtn?: HTMLButtonElement;
    private redoBtn?: HTMLButtonElement;

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

        // Session-scoped undo/redo (C1). Transient by design — no persistence.
        this.history = new DeviceHistory(this.deviceLibrary);
        this.history.onChange = () => this.syncHistoryButtons();

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
            const normalized = applyMidiScaling(_value, control.midiBindingDefinition);
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
            midiHandler,
            this.history
        );
        this.libraryUI = new DeviceLibraryUI(
            this.deviceLibrary,
            () => this.onDeviceChanged(),
            () => this.onPresetLoad(),
            this.nexusAdapter,
            this.bindingManager,
            this.history,
            // Morph (M14) updates live control widgets in place — the same
            // mechanism every normal local/Nexus value change uses. No full
            // AppUI.render() for each slider input.
            (controlId, value) => this.surfaceUI.applyNexusValue(controlId, value)
        );

        window.addEventListener("keydown", this.handleKeydown);
    }

    /**
     * Keyboard undo/redo: Cmd/Ctrl+Z (undo), Shift+Cmd/Ctrl+Z and Ctrl+Y
     * (redo). Text editing keeps its native undo: the shortcuts are ignored
     * while an INPUT/TEXTAREA/contenteditable element has focus.
     */
    private handleKeydown = (e: KeyboardEvent) => {
        const mod = e.metaKey || e.ctrlKey;
        if (!mod) return;
        const active = document.activeElement;
        if (
            active &&
            (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || (active as HTMLElement).isContentEditable)
        ) {
            return;
        }
        const key = e.key.toLowerCase();
        if (key === "z") {
            e.preventDefault();
            this.performUndoRedo(e.shiftKey ? "redo" : "undo");
        } else if (key === "y") {
            e.preventDefault();
            this.performUndoRedo("redo");
        }
    };

    private performUndoRedo(action: "undo" | "redo") {
        const ok = action === "undo" ? this.history.undo() : this.history.redo();
        if (ok) this.onDeviceChanged();
        this.syncHistoryButtons();
    }

    /** Refresh the undo/redo button enable state without a full re-render.
     *  The buttons reflect only actions that could ACTUALLY run on the current
     *  device (a device-scope action for another device is never suggested as
     *  executable here). */
    private syncHistoryButtons() {
        if (this.undoBtn) this.undoBtn.disabled = !this.history.canUndoOnCurrentDevice;
        if (this.redoBtn) this.redoBtn.disabled = !this.history.canRedoOnCurrentDevice;
    }

    private applyValueToDevice(controlId: string, value: number) {
        const control = this.deviceLibrary.currentDevice?.getControl(controlId);
        if (!control) return;
        control.value = value;
        this.deviceLibrary.saveCurrentDevice();
        this.surfaceUI.applyNexusValue(controlId, value);
        // The Nexus write may be refused (disconnected/immutable/unbound/unsupported).
        // The local value stays — but the failure must be observable, not discarded.
        this.nexusAdapter.updateBoundControl(controlId, value).then(
            (ok) => {
                if (!ok) {
                    console.warn(`[METATRON NEXUS WRITE] control=${controlId} write refused — local value kept (${Number(value).toFixed(4)})`);
                }
            },
            (e) => {
                console.error(`[METATRON NEXUS WRITE] control=${controlId} write error:`, e);
            },
        );
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
                this.nexusAdapter.updateBoundControl(c.id, c.value).then(
                    (ok) => {
                        if (!ok) {
                            console.warn(`[METATRON NEXUS WRITE] preset push refused control=${c.id} — stored value kept locally`);
                        }
                    },
                    (e) => {
                        console.error(`[METATRON NEXUS WRITE] preset push control=${c.id} error:`, e);
                    },
                );
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

        const titleWrap = document.createElement("div");
        titleWrap.className = "app-title";
        const logo = document.createElement("img");
        logo.src = "/metatron-logo-small.svg";
        logo.alt = "Metatron";
        logo.className = "app-logo";
        const title = document.createElement("h1");
        title.innerText = `Metatron${this.deviceLibrary.currentDevice ? ` | ${this.deviceLibrary.currentDevice.name}` : ""}`;
        title.style.whiteSpace = "nowrap";
        titleWrap.appendChild(logo);
        titleWrap.appendChild(title);
        toolbar.appendChild(titleWrap);

const libraryBtn = document.createElement("button");
libraryBtn.className = "btn" + (this.sidebarCollapsed ? "" : " active");
libraryBtn.innerText = this.currentMode === "EDIT" ? "Device Library" : "Library";
libraryBtn.title = this.sidebarCollapsed ? "Show library" : "Hide library";
libraryBtn.onclick = () => {
    this.sidebarCollapsed = !this.sidebarCollapsed;
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

        const undoBtn = document.createElement("button");
        undoBtn.id = "history-undo";
        undoBtn.className = "btn";
        undoBtn.innerText = "Undo";
        undoBtn.title = "Undo last action (Cmd/Ctrl+Z)";
        undoBtn.onclick = () => this.performUndoRedo("undo");
        this.undoBtn = undoBtn;

        const redoBtn = document.createElement("button");
        redoBtn.id = "history-redo";
        redoBtn.className = "btn";
        redoBtn.innerText = "Redo";
        redoBtn.title = "Redo last undone action (Shift+Cmd/Ctrl+Z)";
        redoBtn.onclick = () => this.performUndoRedo("redo");
        this.redoBtn = redoBtn;

        this.syncHistoryButtons();
        toolbar.appendChild(undoBtn);
        toolbar.appendChild(redoBtn);

        const modeToggle = document.createElement("button");
        modeToggle.className = "btn primary";
        modeToggle.innerText = this.currentMode === "EDIT" ? "Switch to USE Mode" : "Switch to EDIT Mode";
        modeToggle.onclick = () => {
            this.currentMode = this.currentMode === "EDIT" ? "USE" : "EDIT";
            // USE mode favors maximum controller width, so start the library
            // collapsed there; EDIT restores normal library access.
            this.sidebarCollapsed = this.currentMode === "USE";
            this.render();
        };
        toolbar.appendChild(modeToggle);

        this.root.appendChild(toolbar);

        // Main Content Area
        const contentRow = document.createElement("div");
        contentRow.className = "content-row";

        // Left sidebar pane: an always-present edge toggle plus the collapsible
        // Device Library column. Collapsing only changes the library column's
        // width (content stays mounted), so the controller surface reclaims the
        // freed horizontal space via flex:1.
        const sidebarPane = document.createElement("div");
        sidebarPane.className = "sidebar-pane" + (this.sidebarCollapsed ? " collapsed" : "");

        const sidebarToggle = document.createElement("button");
        sidebarToggle.className = "sidebar-toggle";
        sidebarToggle.textContent = this.sidebarCollapsed ? "›" : "‹";
        sidebarToggle.title = this.sidebarCollapsed ? "Show library" : "Hide library";
        sidebarToggle.onclick = () => {
            this.sidebarCollapsed = !this.sidebarCollapsed;
            this.render();
        };
        sidebarPane.appendChild(sidebarToggle);

        const sidebar = document.createElement("aside");
        sidebar.className = "device-sidebar-wrap";
        this.libraryUI.render(sidebar);
        sidebarPane.appendChild(sidebar);
        contentRow.appendChild(sidebarPane);

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