import { DeviceLibrary } from "../core/DeviceLibrary";
import { Toast } from "./Toast";

/**
 * Device Library UI (spec §47, §48): New / Open / Save / Rename / Delete
 * devices. A NEW device always starts empty (§20 / §48 "New").
 */
export class DeviceLibraryUI {
    private deviceLibrary: DeviceLibrary;
    private onDeviceChanged: () => void;
    private onPresetLoad?: () => void;
    private container!: HTMLElement;

    constructor(
        deviceLibrary: DeviceLibrary,
        onDeviceChanged: () => void,
        onPresetLoad?: () => void
    ) {
        this.deviceLibrary = deviceLibrary;
        this.onDeviceChanged = onDeviceChanged;
        this.onPresetLoad = onPresetLoad;
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