import { DeviceLibrary } from "../core/DeviceLibrary";
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
    private instrumentResultArea?: HTMLElement;

    constructor(
        deviceLibrary: DeviceLibrary,
        onDeviceChanged: () => void,
        onPresetLoad?: () => void,
        nexusAdapter?: NexusAdapter,
        bindingManager?: BindingManager
    ) {
        this.deviceLibrary = deviceLibrary;
        this.onDeviceChanged = onDeviceChanged;
        this.onPresetLoad = onPresetLoad;
        this.nexusAdapter = nexusAdapter;
        this.bindingManager = bindingManager;
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
            device.savePreset(name);
            this.deviceLibrary.saveCurrentDevice();
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
                            preset.name = name;
                            this.deviceLibrary.saveCurrentDevice();
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
                    device.loadPreset(preset.id);
                    this.deviceLibrary.saveCurrentDevice();
                    // Push restored values to Nexus ONLY for controls connected
                    // to the current project; DISCONNECTED controls stay local.
                    this.onPresetLoad?.();
                    Toast.show(`Preset "${preset.name}" loaded.`, "info");
                    this.onDeviceChanged(); // re-render surface so values appear
                };

                const delBtn = document.createElement("button");
                delBtn.className = "mini-btn";
                delBtn.innerText = "✕";
                delBtn.title = "Delete preset";
                delBtn.onclick = (e) => {
                    e.stopPropagation();
                    device.deletePreset(preset.id);
                    this.deviceLibrary.saveCurrentDevice();
                    Toast.show(`Preset "${preset.name}" deleted.`, "info");
                    this.render(this.container);
                };

                row.appendChild(label);
                row.appendChild(renameBtn);
                row.appendChild(loadBtn);
                row.appendChild(delBtn);
                panel.appendChild(row);
            });
        }
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
        const outcome = await importInstrumentFromLibrary(libraryId, doc, this.bindingManager);
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
        this.deviceLibrary.createNewDevice(count === 0 ? "My Device" : `My Device ${count + 1}`);
        this.deviceLibrary.saveCurrentDevice();
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
            if (name) {
                this.deviceLibrary.renameCurrentDevice(name);
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
            const wasActive = this.isActiveDevice(device.id);
            this.deviceLibrary.deleteDevice(device.id);
            if (wasActive) {
                const remaining = this.deviceLibrary.listDevices();
                if (remaining.length > 0) {
                    this.deviceLibrary.loadDevice(remaining[0].id);
                }
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