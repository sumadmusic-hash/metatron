import { DeviceLibrary } from "../core/DeviceLibrary";
import { NexusAdapter } from "../nexus/NexusAdapter";
import { MidiAccess } from "../midi/MidiAccess";
import { MidiMapping } from "../midi/MidiMapping";
import { applyMidiScaling } from "../midi/MidiScaling";
import { BindingManager } from "../core/BindingManager";
import { DeviceHistory } from "../core/history/DeviceHistory";
import { AutomationRecorder } from "../automation/AutomationRecording";
import { writeAutomationRecording, readTempoBpm } from "../automation/AutomationWriter";
import { EditorUI } from "./editor/EditorUI";
import { SurfaceUI } from "./surface/SurfaceUI";
import { DeviceLibraryUI } from "./DeviceLibraryUI";
import { Toast } from "./Toast";
import { WRITE_REFUSED_CLASS, WRITE_REFUSED_TITLE } from "./writeRefusal";
import "./styles.css";

/**
 * M21.8 — pure take-summary helpers (unit-testable without a DOM). A track with
 * zero captured events is rendered as "<name> (0 events)"; otherwise the control
 * name (resolved from the current device, falling back to the control id) is
 * shown together with its event count implied by the row itself.
 */
export interface AutomationTakeRow {
    name: string;
    eventCount: number;
}

export function takeRowText(name: string, eventCount: number): string {
    return eventCount === 0 ? `${name} (0 events)` : name;
}

export function summarizeTakeTracks(
    tracks: { controlId: string; samples: unknown[] }[],
    device: { getControl(id: string): { name: string } | undefined } | null | undefined
): AutomationTakeRow[] {
    return tracks.map((t) => {
        const control = device?.getControl(t.controlId);
        const name =
            control && typeof control.name === "string" && control.name.trim() !== ""
                ? control.name
                : t.controlId;
        return { name, eventCount: t.samples.length };
    });
}

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
    private connectionStatusEl?: HTMLSpanElement;
    private currentConnectionStatus?: { text: string; color: string };
    private recorder: AutomationRecorder;

    // M21.8 — pure UI-side state for the automation strip. `recordingStartPerf`
    // drives a cosmetic elapsed timer; none of it touches the recorder's clock.
    private recordingStartPerf = 0;
    private elapsedTimer?: ReturnType<typeof setInterval>;
    private elapsedEl?: HTMLSpanElement;
    private hasApplied = false;
    private refusedControlIds = new Set<string>();

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

        // M21.2: internal automation recording. The recorder is an ADDITIONAL
        // observer of the normal control-value path — the Audiotool write stays
        // untouched and the control value is never altered here.
        this.recorder = new AutomationRecorder(() => readTempoBpm(this.nexusAdapter.document));

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
            midiHandler,
            (controlId) => this.isWriteRefused(controlId)
        );

        this.editorUI = new EditorUI(
            this.deviceLibrary,
            this.nexusAdapter,
            this.bindingManager,
            this.midiAccess,
            this.midiMapping,
            midiHandler,
            this.history,
            (controlId) => this.isWriteRefused(controlId)
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
        // M21.2: record Metatron's own control movement (surface + MIDI). The
        // automation capture is a passive observer — the Nexus write below is
        // unchanged and this recorder never writes to Nexus itself.
        this.recorder.capture(control.id, value, control.type);
        // The Nexus write may be refused (disconnected/immutable/unbound/unsupported).
        // The local value stays — but the failure must be observable, not discarded.
        this.nexusAdapter.updateBoundControl(controlId, value).then(
            (ok) => {
                if (!ok) {
                    console.warn(`[METATRON NEXUS WRITE] control=${controlId} write refused — local value kept (${Number(value).toFixed(4)})`);
                    this.setWriteRefused(controlId, true);
                } else {
                    this.setWriteRefused(controlId, false);
                }
            },
            (e) => {
                console.error(`[METATRON NEXUS WRITE] control=${controlId} write error:`, e);
                this.setWriteRefused(controlId, true);
            },
        );
    }

    private isWriteRefused(controlId: string): boolean {
        return this.refusedControlIds.has(controlId);
    }

    private setWriteRefused(controlId: string, refused: boolean) {
        if (refused) this.refusedControlIds.add(controlId);
        else this.refusedControlIds.delete(controlId);
        const el = this.root.querySelector<HTMLElement>(`[data-ctl-id="${controlId}"]`);
        if (!el) return;
        el.classList.toggle(WRITE_REFUSED_CLASS, refused);
        if (refused) el.title = WRITE_REFUSED_TITLE;
        else el.removeAttribute("title");
    }

    /**
     * M21.2 §11 — minimal internal entry point: ARM / REC / STOP / WRITE.
     * M21.8 — ARMED/RECORDING visual states, live elapsed timer, take
     * overview, CLEAR, and a double-write guard (APPLIED + disabled).
     */
    private tickElapsed() {
        if (!this.elapsedEl) return;
        const seconds = (performance.now() - this.recordingStartPerf) / 1000;
        this.elapsedEl.innerText = `● ${seconds.toFixed(1)}s`;
    }

    private syncElapsedTimer() {
        const el = this.elapsedEl;
        this.stopElapsedTimer();
        if (!el) return;
        this.elapsedEl = el;
        this.tickElapsed();
        this.elapsedTimer = setInterval(() => this.tickElapsed(), 100);
    }

    private stopElapsedTimer() {
        if (this.elapsedTimer !== undefined) {
            clearInterval(this.elapsedTimer);
            this.elapsedTimer = undefined;
        }
        this.elapsedEl = undefined;
    }

    private buildAutomationStrip(): HTMLElement {
        const strip = document.createElement("div");
        strip.className = "automation-strip";

        const state = this.recorder.currentState;
        const mk = (label: string, title: string, enabled: boolean, cls: string, action: () => void) => {
            const btn = document.createElement("button");
            btn.className = "automation-btn" + (cls ? ` ${cls}` : "");
            btn.innerText = label;
            btn.title = title;
            btn.disabled = !enabled;
            btn.onclick = () => action();
            strip.appendChild(btn);
        };

        const takeReady =
            state === "STOPPED" &&
            this.recorder.recording.tracks.length > 0 &&
            this.nexusAdapter.document !== null;

        mk(
            "ARM",
            "Arm a new automation take",
            state === "IDLE" || state === "STOPPED",
            state === "ARMED" || state === "RECORDING" ? "armed" : "",
            () => {
                this.hasApplied = false;
                this.recorder.arm();
                this.render();
            }
        );
        mk("REC", "Start recording (requires ARM)", state === "ARMED", state === "RECORDING" ? "recording" : "", () => {
            this.recordingStartPerf = performance.now();
            this.recorder.record();
            this.render();
        });
        mk("STOP", "Stop and finalize the take", state === "RECORDING" || state === "ARMED", "", () => {
            this.stopElapsedTimer();
            this.recorder.stop();
            this.render();
        });
        mk(
            "APPLY TO AUDIOTOOL",
            "Apply this take to Audiotool (creates real automation)",
            takeReady && !this.hasApplied,
            "",
            () => void this.writeAutomation()
        );
        mk("CLEAR", "Discard this take locally — nothing is removed from Audiotool", state === "STOPPED", "clear", () => {
            this.stopElapsedTimer();
            this.recorder.reset();
            this.hasApplied = false;
            this.render();
        });

        const status = document.createElement("span");
        status.className = "automation-status";
        if (state === "ARMED") {
            status.innerText = "Armed — press REC to record";
        } else if (state === "RECORDING") {
            status.innerText = "RECORDING";
        } else if (state === "STOPPED") {
            status.innerText = this.hasApplied ? "APPLIED" : "";
        } else {
            status.innerText = "IDLE";
        }
        strip.appendChild(status);

        if (state === "RECORDING") {
            const elapsed = document.createElement("span");
            elapsed.className = "automation-elapsed";
            elapsed.innerText = "● 0.0s";
            strip.appendChild(elapsed);
            this.elapsedEl = elapsed;
        }

        // M21.5 — live sound feedback requires both windows to stay visible.
        // Shown only while a take is armed or recording; hidden otherwise.
        if (state === "ARMED" || state === "RECORDING") {
            const hint = document.createElement("span");
            hint.className = "automation-hint";
            hint.innerText =
                "Audiotool and Metatron must remain visible at the same time for live sound feedback.";
            strip.appendChild(hint);
        }

        // M21.8 — take overview after a take is finalized (control-name rows).
        if (state === "STOPPED") {
            const r = this.recorder.recording;
            const rows = summarizeTakeTracks(r.tracks, this.deviceLibrary.currentDevice);
            const take = document.createElement("div");
            take.className = "automation-take";
            const head = document.createElement("div");
            head.className = "automation-take-head";
            head.innerText = `Take: ${rows.length} Controls · ${r.durationSeconds.toFixed(1)}s`;
            take.appendChild(head);
            for (const row of rows) {
                const line = document.createElement("div");
                line.className = "automation-take-row";
                line.innerText = takeRowText(row.name, row.eventCount);
                line.title = row.name;
                take.appendChild(line);
            }
            strip.appendChild(take);
        }

        this.syncElapsedTimer();
        return strip;
    }

    private async writeAutomation() {
        const doc = this.nexusAdapter.document;
        if (!doc) {
            Toast.show("Connect to an Audiotool project first.", "error");
            return;
        }
        const recording = this.recorder.recording;
        if (recording.tracks.length === 0) {
            Toast.show("Nothing recorded yet.", "info");
            return;
        }
        console.log(
            `[METATRON AUTOMATION WRITE] start writing ${recording.tracks.length} track(s) at startTick=${recording.startTick} bpm=${recording.projectBpm}`
        );
        try {
            const result = await writeAutomationRecording(recording, doc, this.bindingManager);
            const ok = result.perTrack.filter((r) => r.ok).length;
            if (!result.ok) {
                Toast.show(`Automation write failed: ${result.error ?? "unknown"}`, "error");
                return;
            }
            // M21.8 — once at least one track was created on the document, guard
            // against a second apply of the same take. A new ARM resets it.
            this.hasApplied = result.createdTracks > 0;
            if (ok === result.perTrack.length) {
                Toast.show(`Automation written — ${ok} track(s) to Audiotool.`, "success");
            } else {
                const detail = result.perTrack
                    .filter((r) => !r.ok)
                    .map((r) => `${r.controlId}: ${r.reason}`)
                    .join(", ");
                Toast.show(`Written ${ok}/${result.perTrack.length} — skipped: ${detail}`, "error");
            }
            this.render();
        } catch (e) {
            console.error("[METATRON AUTOMATION WRITE] error:", e);
            Toast.show(`Automation write error: ${e instanceof Error ? e.message : String(e)}`, "error");
        }
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

    private applyStatusText(text: string, color: string) {
        this.currentConnectionStatus = { text, color };
        if (this.connectionStatusEl) {
            this.connectionStatusEl.innerText = text;
            this.connectionStatusEl.style.color = color;
        }
    }

    public render() {
        // M21.8 — the elapsed interval belongs to the previous DOM; tear it
        // down before every rebuild. buildAutomationStrip restarts it only
        // while RECORDING.
        this.stopElapsedTimer();
        this.root.innerHTML = "";

        // Toolbar
        const toolbar = document.createElement("div");
        toolbar.className = "toolbar";

        const toolbarLeft = document.createElement("div");
        toolbarLeft.className = "toolbar-left";

        const toolbarRight = document.createElement("div");
        toolbarRight.className = "toolbar-right";

        const titleWrap = document.createElement("div");
        titleWrap.className = "app-title";
        const logo = document.createElement("img");
        logo.src = "/metatron-logo-small.svg";
        logo.alt = "Metatron";
        logo.className = "app-logo";
        const title = document.createElement("h1");
        const deviceName = this.deviceLibrary.currentDevice?.name;
        title.innerText = `Metatron${deviceName ? ` | ${deviceName}` : ""}`;
        title.style.whiteSpace = "nowrap";
        if (deviceName) {
            title.title = deviceName;
            titleWrap.title = deviceName;
        }
        titleWrap.appendChild(logo);
        titleWrap.appendChild(title);
        toolbarLeft.appendChild(titleWrap);

const libraryBtn = document.createElement("button");
libraryBtn.className = "btn" + (this.sidebarCollapsed ? "" : " active");
libraryBtn.innerText = "Library";
libraryBtn.title = this.sidebarCollapsed ? "Show library" : "Hide library";
libraryBtn.onclick = () => {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    this.render();
};
toolbarLeft.appendChild(libraryBtn);

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
        connectionStatus.className = "connection-status";
        connectionStatus.style.fontSize = "12px";
        connectionStatus.style.color = this.currentConnectionStatus?.color ?? "var(--text-secondary)";
        connectionStatus.innerText = this.currentConnectionStatus?.text ?? this.connectionLabel();
        this.connectionStatusEl = connectionStatus;

        connectBtn.onclick = async () => {
            if (!urlInput.value) {
                Toast.show("Enter an Audiotool project URL first.", "error");
                return;
            }
            try {
                this.applyStatusText("Connecting...", "#ffeb3b");
                this.connectionUnsub?.();
                this.connectionUnsub = undefined;
                await this.nexusAdapter.openProject(urlInput.value, this.bindingManager);
                this.connectionUnsub = this.nexusAdapter.onDocumentConnectedChanged((connected) => {
                    if (!connected) {
                        this.applyStatusText("Sync lost — reconnect project", "#f44336");
                        console.warn("[METATRON LEARN] document.connected=false — Nexus events will NOT arrive (learn would time out)");
                    } else {
                        this.applyStatusText("Connected", "#4CAF50");
                    }
                });
                Toast.show("Project connected.", "success");
            } catch (e) {
                console.error("Connection error", e);
                this.applyStatusText("Error", "#f44336");
                Toast.show(`Connection failed: ${e instanceof Error ? e.message : String(e)}`, "error");
            }
        };

        connectionContainer.appendChild(urlInput);
        connectionContainer.appendChild(connectBtn);
        connectionContainer.appendChild(connectionStatus);
        
        toolbarLeft.appendChild(connectionContainer);

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
        toolbarLeft.appendChild(undoBtn);
        toolbarLeft.appendChild(redoBtn);

        const modeToggle = document.createElement("button");
        modeToggle.className = "btn primary";
        modeToggle.innerText = this.currentMode === "EDIT" ? "USE" : "EDIT";
        modeToggle.onclick = () => {
            this.currentMode = this.currentMode === "EDIT" ? "USE" : "EDIT";
            // USE mode favors maximum controller width, so start the library
            // collapsed there; EDIT restores normal library access.
            this.sidebarCollapsed = this.currentMode === "USE";
            this.render();
        };

        // Right cluster: the mode toggle is the sole rightmost header control.
        toolbarRight.appendChild(modeToggle);

        toolbar.appendChild(toolbarLeft);
        toolbar.appendChild(toolbarRight);

        this.root.appendChild(toolbar);

        // Secondary bar: automation strip lives in its own row below the main
        // header, freeing horizontal space in the 56px toolbar.
        const automationBar = document.createElement("div");
        automationBar.className = "automation-bar";
        automationBar.appendChild(this.buildAutomationStrip());
        this.root.appendChild(automationBar);

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