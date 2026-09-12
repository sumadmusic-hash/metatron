import { DeviceLibrary } from "../core/DeviceLibrary";
import { DeviceHistory } from "../core/history/DeviceHistory";
import { patchesEqual } from "../core/history/HistoryAction";
import type { DeviceStatePatch } from "../core/history/HistoryAction";
import type { Device } from "../core/model/Device";
import { Toast } from "./Toast";
import { NexusAdapter } from "../nexus/NexusAdapter";
import { BindingManager } from "../core/BindingManager";
import { InstrumentPresetLibrary } from "../persistence/InstrumentPresetLibrary";
import {
    exportInstrumentToLibrary,
    importInstrumentFromLibrary,
} from "../integration/InstrumentPresetIntegration";
import {
    renderInstrumentExportOutcome,
    renderInstrumentImportOutcome,
} from "./instrument/InstrumentResultView";
import { applyMorphToDevice } from "../integration/PresetMorphIntegration";

/**
 * Device Library UI (spec §47, §48): New / Open / Save / Rename / Delete
 * devices. A NEW device always starts empty (§20 / §48 "New").
 */
export class DeviceLibraryUI {
    private deviceLibrary: DeviceLibrary;
    private onDeviceChanged: () => void;
    private onPresetLoad?: () => void;
    private container!: HTMLElement;
    private nexusAdapter?: NexusAdapter;
    private bindingManager?: BindingManager;
    private history?: DeviceHistory;
    private instrumentResultArea?: HTMLElement;
    private onControlValueChanged?: (controlId: string, value: number) => void;

    // Transient Morph A/B selection state (M12). Slot references and the
    // amount are deliberately NOT serialized: they are pure UI state and
    // reset when the active device changes.
    private morphA?: string;
    private morphB?: string;
    private morphAmount = 0.5;
    private activeMorphDeviceId?: string;

    constructor(
        deviceLibrary: DeviceLibrary,
        onDeviceChanged: () => void,
        onPresetLoad?: () => void,
        nexusAdapter?: NexusAdapter,
        bindingManager?: BindingManager,
        history?: DeviceHistory,
        onControlValueChanged?: (controlId: string, value: number) => void
    ) {
        this.deviceLibrary = deviceLibrary;
        this.onDeviceChanged = onDeviceChanged;
        this.onPresetLoad = onPresetLoad;
        this.nexusAdapter = nexusAdapter;
        this.bindingManager = bindingManager;
        this.history = history;
        this.onControlValueChanged = onControlValueChanged;
    }

    /** Structural snapshot of the given device (device-scope actions). The
     *  device is passed explicitly so an async caller can capture its context
     *  BEFORE `await`: the history must never infer the target afterwards. */
    private currentPatch(device: Device): DeviceStatePatch | null {
        if (!this.history) return null;
        return this.history.captureDeviceState(device);
    }

    /** Record ONE device-scope action for the given device, only when the
     *  snapshot actually changed and the device is still the active one (the
     *  history layer discards an action whose device switched mid-flight). */
    private recordDeviceAction(type: string, device: Device, before: DeviceStatePatch | null, after: DeviceStatePatch | null) {
        this.history?.recordDeviceAction(type, device, before, after);
    }

    public render(parent: HTMLElement) {
        this.container = parent;

        const panel = document.createElement("div");
        panel.className = "device-sidebar";

        const title = document.createElement("h3");
        title.innerText = "DEVICE LIBRARY";
        panel.appendChild(title);

        const newBtn = document.createElement("button");
        newBtn.className = "btn primary small";
        newBtn.innerText = "+ New Device";
        newBtn.style.width = "100%";
        newBtn.style.marginBottom = "12px";
        newBtn.onclick = () => this.createNewDevice();
        panel.appendChild(newBtn);

        const list = this.deviceLibrary.listDevices();
        if (list.length === 0) {
            const empty = document.createElement("div");
            empty.style.cssText = "color:var(--text-secondary);font-size:12px;padding:8px 4px;";
            empty.innerText = "No devices yet. Create one to start building your control surface.";
            panel.appendChild(empty);
        } else {
            list.forEach((d) => panel.appendChild(this.deviceItem(d)));
        }

        // Actions for the active device
        if (this.deviceLibrary.currentDevice) {
            const actions = document.createElement("div");
            actions.style.cssText = "display:flex;gap:6px;margin-top:14px;";

            const rename = document.createElement("button");
            rename.className = "btn small";
            rename.innerText = "Rename";
            rename.style.flex = "1";
            rename.onclick = () => this.beginRename(rename);

            const save = document.createElement("button");
            save.className = "btn small";
            save.innerText = "Save";
            save.style.flex = "1";
            save.onclick = () => {
                this.deviceLibrary.saveCurrentDevice();
                Toast.show("Device saved.", "success");
                this.onDeviceChanged(); // refresh active highlight
            };
            actions.appendChild(save);
            actions.appendChild(rename);
            panel.appendChild(actions);
        }

        // Presets section for the active device (§6 Presets, §20 "Save Load/Delete")
        this.renderPresets(panel);

        // Instrument presets — export/import of the full chain+device state (P1/P2/P3)
        this.renderInstrumentPresets(panel);

        // Clear pending confirm bar when re-rendering
        this.clearConfirm();

        parent.innerHTML = "";
        parent.appendChild(panel);
    }

    private renderPresets(panel: HTMLElement) {
        const device = this.deviceLibrary.currentDevice;
        if (!device) return;

        // Morph A/B slots are device-scoped transient UI state: reset when the
        // active device changes. Presets and controls are never touched.
        if (device.id !== this.activeMorphDeviceId) {
            this.morphA = undefined;
            this.morphB = undefined;
            this.morphAmount = 0.5;
            this.activeMorphDeviceId = device.id;
        }

        const h3 = document.createElement("h3");
        h3.style.marginTop = "20px";
        h3.innerText = "PRESETS";
        panel.appendChild(h3);

        const saveRow = document.createElement("div");
        saveRow.style.display = "flex";
        saveRow.style.gap = "6px";

        const input = document.createElement("input");
        input.className = "text-input";
        input.placeholder = "Preset name";
        input.style.flex = "1";
        input.style.padding = "5px 8px";
        input.style.fontSize = "12px";

        const saveBtn = document.createElement("button");
        saveBtn.className = "btn small";
        saveBtn.innerText = "Save";
        saveBtn.onclick = () => {
            const name = input.value.trim();
            if (!name) {
                Toast.show("Enter a preset name.", "error");
                return;
            }
            const before = this.currentPatch(device);
            device.savePreset(name);
            this.deviceLibrary.saveCurrentDevice();
            const after = this.currentPatch(device);
            this.recordDeviceAction("preset.save", device, before, after);
            Toast.show(`Preset "${name}" saved.`, "success");
            this.render(this.container);
        };
        saveRow.appendChild(input);
        saveRow.appendChild(saveBtn);
        panel.appendChild(saveRow);

        if (device.presets.size === 0) {
            const empty = document.createElement("div");
            empty.style.cssText = "color:var(--text-secondary);font-size:12px;padding:8px 4px;";
            empty.innerText = "No presets yet.";
            panel.appendChild(empty);
        } else {
            device.presets.forEach(preset => {
                const row = document.createElement("div");
                row.className = "preset-list-item";

                const label = document.createElement("span");
                label.innerText = preset.name;
                label.style.flex = "1";
                label.style.overflow = "hidden";
                label.style.textOverflow = "ellipsis";
                label.style.whiteSpace = "nowrap";

                const renameBtn = document.createElement("button");
                renameBtn.className = "mini-btn";
                renameBtn.innerText = "✎";
                renameBtn.title = "Rename preset";
                renameBtn.onclick = (e) => {
                    e.stopPropagation();
                    const input = document.createElement("input");
                    input.className = "text-input";
                    input.value = preset.name;
                    input.style.flex = "1";
                    input.style.padding = "1px 6px";
                    input.style.fontSize = "12px";
                    label.replaceWith(input);
                    const finish = () => {
                        const name = input.value.trim();
                        if (name && name !== preset.name) {
                            const before = this.currentPatch(device);
                            preset.name = name;
                            this.deviceLibrary.saveCurrentDevice();
                            const after = this.currentPatch(device);
                            this.recordDeviceAction("preset.rename", device, before, after);
                            Toast.show("Preset renamed.", "success");
                        }
                        this.render(this.container);
                    };
                    input.addEventListener("blur", finish);
                    input.addEventListener("keydown", (ke) => {
                        if (ke.key === "Enter") input.blur();
                        else if (ke.key === "Escape") { input.value = preset.name; input.blur(); }
                    });
                    input.focus();
                    input.select();
                };

                const loadBtn = document.createElement("button");
                loadBtn.className = "mini-btn";
                loadBtn.innerText = "Load";
                loadBtn.title = "Apply this preset to the device (§20)";
                loadBtn.onclick = (e) => {
                    e.stopPropagation();
                    const before = this.currentPatch(device);
                    device.loadPreset(preset.id);
                    this.deviceLibrary.saveCurrentDevice();
                    const after = this.currentPatch(device);
                    this.recordDeviceAction("preset.load", device, before, after);
                    // Push restored values to Nexus ONLY for controls connected
                    // to the current project; DISCONNECTED controls stay local.
                    this.onPresetLoad?.();
                    Toast.show(`Preset "${preset.name}" loaded.`, "info");
                    this.onDeviceChanged(); // re-render surface so values appear
                };

                // Morph slot assignment (M12): picking A/B stores ONLY the preset
                // id in the transient slot. It must NOT load the preset, change
                // control values, or touch Nexus.
                const morphABtn = document.createElement("button");
                morphABtn.className = "mini-btn" + (this.morphA === preset.id ? " active" : "");
                morphABtn.innerText = "A";
                morphABtn.title = this.morphA === preset.id
                    ? `Morph A: "${preset.name}" — click to unassign`
                    : "Assign this preset to Morph A";
                morphABtn.onclick = (e) => {
                    e.stopPropagation();
                    if (this.morphA === preset.id) {
                        this.morphA = undefined;
                    } else {
                        this.morphA = preset.id;
                    }
                    this.render(this.container);
                };

                const morphBBtn = document.createElement("button");
                morphBBtn.className = "mini-btn" + (this.morphB === preset.id ? " active" : "");
                morphBBtn.innerText = "B";
                morphBBtn.title = this.morphB === preset.id
                    ? `Morph B: "${preset.name}" — click to unassign`
                    : "Assign this preset to Morph B";
                morphBBtn.onclick = (e) => {
                    e.stopPropagation();
                    if (this.morphB === preset.id) {
                        this.morphB = undefined;
                    } else {
                        this.morphB = preset.id;
                    }
                    this.render(this.container);
                };

                const delBtn = document.createElement("button");
                delBtn.className = "mini-btn";
                delBtn.innerText = "✕";
                delBtn.title = "Delete preset";
                delBtn.onclick = (e) => {
                    e.stopPropagation();
                    // A deleted preset can no longer be a Morph slot (M12).
                    if (this.morphA === preset.id) this.morphA = undefined;
                    if (this.morphB === preset.id) this.morphB = undefined;
                    const before = this.currentPatch(device);
                    device.deletePreset(preset.id);
                    this.deviceLibrary.saveCurrentDevice();
                    const after = this.currentPatch(device);
                    this.recordDeviceAction("preset.delete", device, before, after);
                    Toast.show(`Preset "${preset.name}" deleted.`, "info");
                    this.render(this.container);
                };

                row.appendChild(label);
                row.appendChild(morphABtn);
                row.appendChild(morphBBtn);
                row.appendChild(renameBtn);
                row.appendChild(loadBtn);
                row.appendChild(delBtn);
                panel.appendChild(row);
            });
        }

        // Morph A/B status (M12): shows the current transient slot assignments.
        // Never assumes any preset is "currently loaded" — these are reference
        // slots only. The amount slider (M13) below is UI state only.
        const morphBlock = document.createElement("div");
        morphBlock.className = "preset-morph";
        morphBlock.style.cssText = "margin-top:12px;padding:8px;border:1px solid var(--border-color);border-radius:6px;background:rgba(255,255,255,0.03);";
        const morphTitle = document.createElement("div");
        morphTitle.className = "preset-morph-title";
        morphTitle.innerText = "MORPH";
        morphTitle.style.cssText = "font-weight:700;letter-spacing:1px;font-size:11px;color:var(--text-secondary);margin-bottom:6px;";
        morphBlock.appendChild(morphTitle);
        const status = document.createElement("div");
        status.className = "preset-morph-status";
        const slotName = (id?: string) => (id ? device.presets.get(id)?.name ?? "—" : "—");
        status.innerText = `A: ${slotName(this.morphA)}    B: ${slotName(this.morphB)}`;
        status.style.cssText = "font-size:12px;color:var(--text-primary);white-space:pre;overflow:hidden;text-overflow:ellipsis;";
        morphBlock.appendChild(status);

        // Morph amount slider (M13/M14) — moves update morphAmount and the
        // percent readout in place, then apply the interpolated values ONLY
        // when both slots are filled:
        //   slider input → read Preset A → read Preset B
        //   → applyMorphToDevice (pure M9 engine + M10 integration)
        //   → visible control widgets updated in place
        //   → CONNECTED controls pushed through NexusAdapter.updateBoundControl
        // With a missing slot: only the amount/percent update — no Morph
        // calculation, no control writes, no Nexus traffic.
        const applyMorph = () => {
            // Clear slots whose preset no longer exists; never applies a stale ref.
            if (this.morphA !== undefined && !device.presets.has(this.morphA)) this.morphA = undefined;
            if (this.morphB !== undefined && !device.presets.has(this.morphB)) this.morphB = undefined;
            status.innerText = `A: ${slotName(this.morphA)}    B: ${slotName(this.morphB)}`;
            const presetA = this.morphA === undefined ? undefined : device.presets.get(this.morphA);
            const presetB = this.morphB === undefined ? undefined : device.presets.get(this.morphB);
            if (!presetA || !presetB) return;

            const result = applyMorphToDevice(device, presetA, presetB, this.morphAmount, {
                updateBoundControl: (id, value) => {
                    if (!this.nexusAdapter) return Promise.resolve(true);
                    return this.nexusAdapter.updateBoundControl(id, value);
                },
            });
            // Reflect the new control.values on the live surface widgets in place
            // (the same mechanism normal local value changes use). No full render.
            Object.keys(result).forEach((id) => {
                this.onControlValueChanged?.(id, result[id]);
            });
            // Persist the RESULTING control.value state only (morph slots and the
            // amount stay transient and are never serialized).
            this.deviceLibrary.saveCurrentDevice();
        };

        const percent = document.createElement("div");
        percent.className = "preset-morph-percent";
        percent.innerText = `${Math.round(this.morphAmount * 100)}%`;
        percent.style.cssText = "text-align:center;font-size:12px;color:var(--accent-color);font-weight:700;margin:8px 0 2px;";
        morphBlock.appendChild(percent);

        const sliderRow = document.createElement("div");
        sliderRow.className = "preset-morph-slider-row";
        sliderRow.style.cssText = "display:flex;align-items:center;gap:6px;";
        const aLabel = document.createElement("span");
        aLabel.className = "preset-morph-endcap";
        aLabel.innerText = "A";
        aLabel.style.cssText = "font-size:11px;color:var(--text-secondary);font-weight:700;";
        const bLabel = document.createElement("span");
        bLabel.className = "preset-morph-endcap";
        bLabel.innerText = "B";
        bLabel.style.cssText = "font-size:11px;color:var(--text-secondary);font-weight:700;";
        const slider = document.createElement("input");
        slider.className = "preset-morph-slider";
        slider.type = "range";
        slider.min = "0";
        slider.max = "1";
        slider.step = "0.01";
        slider.value = String(this.morphAmount);
        slider.style.flex = "1";
        slider.style.accentColor = "var(--accent-color)";
        slider.oninput = () => {
            const raw = parseFloat(slider.value);
            const clamped = Math.min(1, Math.max(0, Number.isFinite(raw) ? raw : 0.5));
            this.morphAmount = clamped;
            slider.value = String(clamped);
            percent.innerText = `${Math.round(clamped * 100)}%`;
            applyMorph();
            morphBlock.title = `Transient Morph state (not saved) — amount: ${clamped.toFixed(2)} — applied to controls when A and B are set`;
        };
        sliderRow.appendChild(aLabel);
        sliderRow.appendChild(slider);
        sliderRow.appendChild(bLabel);
        morphBlock.appendChild(sliderRow);

        morphBlock.title = `Transient Morph state (not saved) — amount: ${this.morphAmount.toFixed(2)} — no morph applied yet`;
        panel.appendChild(morphBlock);
    }

    /**
     * Instrument presets (P1 export / P2 import / P3 result display).
     * SOURCE (export) = the connected project, read-only; TARGET (import) =
     * the connected project, mutated ONLY via the import engine after explicit
     * user confirmation. No root/entity id input, no name search.
     */
    private renderInstrumentPresets(panel: HTMLElement) {
        const device = this.deviceLibrary.currentDevice;
        if (!device) return;

        const h3 = document.createElement("h3");
        h3.style.marginTop = "20px";
        h3.innerText = "INSTRUMENT PRESETS";
        panel.appendChild(h3);

        const exportRow = document.createElement("div");
        exportRow.style.display = "flex";
        exportRow.style.gap = "6px";

        const input = document.createElement("input");
        input.className = "text-input";
        input.placeholder = "Instrument preset name";
        input.value = device.name;
        input.style.flex = "1";
        input.style.padding = "5px 8px";
        input.style.fontSize = "12px";
        input.title = "Name stored as the envelope name (v0.1)";

        const exportBtn = document.createElement("button");
        exportBtn.className = "btn small";
        exportBtn.innerText = "Export";
        exportBtn.title = "Capture the connected project chain + this device's bound controls (SOURCE is read-only)";
        exportBtn.onclick = () => void this.runInstrumentExport(input.value.trim() || device.name);
        exportRow.appendChild(input);
        exportRow.appendChild(exportBtn);
        panel.appendChild(exportRow);

        const emptyHint = "Connected project = SOURCE for export, TARGET for import. Connect first.";
        const hint = document.createElement("div");
        hint.style.cssText = "color:var(--text-secondary);font-size:11px;padding:6px 2px;";
        hint.innerText = emptyHint;
        panel.appendChild(hint);

        const list = InstrumentPresetLibrary.list();
        if (list.length === 0) {
            const empty = document.createElement("div");
            empty.style.cssText = "color:var(--text-secondary);font-size:12px;padding:8px 4px;";
            empty.innerText = "No instrument presets yet.";
            panel.appendChild(empty);
        } else {
            list.sort((a, b) => b.createdAt - a.createdAt).forEach((entry) => {
                const row = document.createElement("div");
                row.className = "preset-list-item";

                const label = document.createElement("span");
                label.innerText = `${entry.name} (${entry.deviceId})`;
                label.style.flex = "1";
                label.style.overflow = "hidden";
                label.style.textOverflow = "ellipsis";
                label.style.whiteSpace = "nowrap";
                label.title = `${entry.name} · device ${entry.deviceId} · created ${new Date(entry.createdAt).toLocaleString()}`;

                const importBtn = document.createElement("button");
                importBtn.className = "mini-btn";
                importBtn.innerText = "Import";
                importBtn.title = "Import into the connected TARGET project (creates devices/cables — confirmed first)";
                importBtn.onclick = (e) => {
                    e.stopPropagation();
                    this.confirmInstrumentImport(entry);
                };

                const delBtn = document.createElement("button");
                delBtn.className = "mini-btn";
                delBtn.innerText = "✕";
                delBtn.title = "Delete this instrument preset from the library";
                delBtn.onclick = (e) => {
                    e.stopPropagation();
                    const deleted = InstrumentPresetLibrary.delete(entry.id);
                    Toast.show(
                        deleted
                            ? `Instrument preset "${entry.name}" deleted.`
                            : `Could not delete instrument preset "${entry.name}" from local storage.`,
                        deleted ? "info" : "error",
                    );
                    this.render(this.container);
                };

                row.appendChild(label);
                row.appendChild(importBtn);
                row.appendChild(delBtn);
                panel.appendChild(row);
            });
        }

        const resultArea = document.createElement("div");
        panel.appendChild(resultArea);
        this.instrumentResultArea = resultArea;
    }

    private async runInstrumentExport(name: string) {
        this.instrumentResultArea?.lastElementChild?.remove();
        const device = this.deviceLibrary.currentDevice;
        if (!device) {
            Toast.show("No active device to export.", "error");
            return;
        }
        if (!this.nexusAdapter?.document) {
            Toast.show("Connect to an Audiotool project first — the connected project is the SOURCE.", "error");
            return;
        }
        if (!this.bindingManager) {
            Toast.show("No binding manager available.", "error");
            return;
        }
        const outcome = await exportInstrumentToLibrary(this.nexusAdapter.document, device, this.bindingManager, name);
        if (outcome.ok) {
            Toast.show(`Instrument preset "${name}" exported (${outcome.entry!.id}).`, "success");
            this.render(this.container);
            this.instrumentResultArea?.appendChild(renderInstrumentExportOutcome(outcome));
        } else {
            Toast.show("Instrument preset export failed.", "error");
            this.instrumentResultArea?.appendChild(renderInstrumentExportOutcome(outcome));
        }
    }

    /** Confirmation before mutating the connected project (P2 gate). */
    private confirmInstrumentImport(entry: { id: string; name: string }) {
        this.render(this.container); // clear pending bars
        const bar = document.createElement("div");
        bar.className = "confirm-bar danger";
        bar.style.top = "100px";
        bar.style.left = "50%";
        bar.style.transform = "translateX(-50%)";

        const label = document.createElement("span");
        label.innerText = `Import "${entry.name}" into the connected project? This creates devices and cables there.`;
        bar.appendChild(label);

        const yes = document.createElement("button");
        yes.className = "btn small";
        yes.innerText = "Import";
        yes.style.marginLeft = "8px";
        yes.onclick = () => {
            bar.remove();
            void this.runInstrumentImport(entry.id);
        };
        bar.appendChild(yes);

        const no = document.createElement("button");
        no.className = "btn small";
        no.innerText = "Cancel";
        no.onclick = () => bar.remove();
        bar.appendChild(no);

        document.body.appendChild(bar);
    }

    private async runInstrumentImport(libraryId: string) {
        this.instrumentResultArea?.lastElementChild?.remove();
        const doc = this.nexusAdapter?.document;
        if (!doc) {
            Toast.show("Connect to the TARGET project first — import clones into the connected project.", "error");
            return;
        }
        if (!this.bindingManager) {
            Toast.show("No binding manager available.", "error");
            return;
        }
        // Device-scope undo: the import writes binding definitions onto Metatron
        // controls (external target-project changes and ActiveBindings are out
        // of scope for undo). Only recorded when the device state changed.
        // The target device is pinned BEFORE the await: `recordDeviceAction`
        // (history layer) discards the action if the user switched devices in
        // the meantime — the state of device X is never tagged as device Y.
        const device = this.deviceLibrary.currentDevice;
        if (!device) return;
        const before = this.currentPatch(device);
        const outcome = await importInstrumentFromLibrary(libraryId, doc, this.bindingManager);
        // M23.3.1: persist the imported device state and re-render the surface
        // so the imported Control.value becomes visible — the exact
        // save/refresh pattern used by preset.load. Exactly ONE history action
        // remains: recordDeviceAction is called once, nothing else records.
        this.deviceLibrary.saveCurrentDevice();
        const after = this.currentPatch(device);
        this.recordDeviceAction("instrument.import", device, before, after);
        // Re-render FIRST so the result box lands in the fresh result area
        // (AppUI.render rebuilds the sidebar, including the report container).
        this.onDeviceChanged();
        this.instrumentResultArea?.appendChild(renderInstrumentImportOutcome(outcome));
        if (outcome.ok) {
            Toast.show("Instrument preset imported — chain restored and verified.", "success");
        } else if (outcome.import) {
            Toast.show("Instrument preset import FAILED — no success, see report.", "error");
        } else {
            Toast.show(outcome.errors?.[0] ?? "Instrument preset import failed.", "error");
        }
    }

    private deviceItem(device: { id: string; name: string }): HTMLElement {
        const row = document.createElement("div");
        row.className = "device-list-item" + (this.deviceLibrary.currentDevice?.id === device.id ? " active" : "");

        const name = document.createElement("span");
        name.innerText = device.name;
        name.style.flex = "1";
        name.style.overflow = "hidden";
        name.style.textOverflow = "ellipsis";
        name.style.whiteSpace = "nowrap";

        const del = document.createElement("button");
        del.className = "tool-btn";
        del.innerText = "✕";
        del.title = "Delete device";
        del.onclick = (e) => {
            e.stopPropagation();
            this.confirmDelete(device);
        };

        row.appendChild(name);
        row.appendChild(del);
        row.onclick = () => this.openDevice(device.id);
        return row;
    }

    private isActiveDevice(id: string): boolean {
        return this.deviceLibrary.currentDevice?.id === id;
    }

    private createNewDevice() {
        const count = this.deviceLibrary.listDevices().length;
        const before = this.history?.captureLibraryState();
        this.deviceLibrary.createNewDevice(count === 0 ? "My Device" : `My Device ${count + 1}`);
        this.deviceLibrary.saveCurrentDevice();
        const after = this.history?.captureLibraryState();
        if (this.history && before && after && !patchesEqual(before, after)) {
            this.history.record({ type: "device.create", scope: "library", deviceId: null, before, after });
        }
        Toast.show("New empty device created (§20).", "success");
        this.onDeviceChanged();
    }

    private openDevice(id: string) {
        // Save current before switching so nothing is lost
        if (this.deviceLibrary.currentDevice) {
            this.deviceLibrary.saveCurrentDevice();
        }
        const loaded = this.deviceLibrary.loadDevice(id);
        if (loaded) {
            Toast.show(`Opened "${loaded.name}".`, "info");
            this.onDeviceChanged();
        } else {
            Toast.show("Failed to open device.", "error");
        }
    }

    private beginRename(anchor: HTMLElement) {
        const device = this.deviceLibrary.currentDevice;
        if (!device) return;
        const input = document.createElement("input");
        input.className = "text-input";
        input.value = device.name;
        input.style.flex = "1";
        input.style.padding = "3px 8px";
        anchor.replaceWith(input);

        const finish = () => {
            const name = input.value.trim();
            if (name && name !== device.name) {
                const before = this.currentPatch(device);
                this.deviceLibrary.renameCurrentDevice(name);
                const after = this.currentPatch(device);
                this.recordDeviceAction("device.rename", device, before, after);
                Toast.show("Device renamed.", "success");
            }
            this.onDeviceChanged();
        };
        input.addEventListener("blur", finish);
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") input.blur();
            else if (e.key === "Escape") { input.value = device.name; input.blur(); }
        });
        input.focus();
        input.select();
    }

    private confirmDelete(device: { id: string; name: string }) {
        this.render(this.container); // clears pending bar
        const bar = document.createElement("div");
        bar.className = "confirm-bar danger";
        bar.style.top = "60px";
        bar.style.left = "50%";
        bar.style.transform = "translateX(-50%)";

        const label = document.createElement("span");
        label.innerText = `Delete device "${device.name}"? This cannot be undone.`;
        bar.appendChild(label);

        const yes = document.createElement("button");
        yes.className = "btn small";
        yes.innerText = "Delete";
        yes.style.marginLeft = "8px";
        yes.onclick = () => {
            const before = this.history?.captureLibraryState();
            const wasActive = this.isActiveDevice(device.id);
            this.deviceLibrary.deleteDevice(device.id);
            if (wasActive) {
                const remaining = this.deviceLibrary.listDevices();
                if (remaining.length > 0) {
                    this.deviceLibrary.loadDevice(remaining[0].id);
                }
            }
            const after = this.history?.captureLibraryState();
            if (this.history && before && after && !patchesEqual(before, after)) {
                this.history.record({ type: "device.delete", scope: "library", deviceId: null, before, after });
            }
            Toast.show(`Device "${device.name}" deleted.`, "info");
            this.onDeviceChanged();
        };
        bar.appendChild(yes);

        const no = document.createElement("button");
        no.className = "btn small";
        no.innerText = "Cancel";
        no.onclick = () => { bar.remove(); this.onDeviceChanged(); };
        bar.appendChild(no);

        document.body.appendChild(bar);
    }

    private clearConfirm() {
        document.querySelectorAll(".confirm-bar").forEach((n) => n.remove());
    }
}