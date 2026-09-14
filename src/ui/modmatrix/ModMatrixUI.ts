import type { Device } from "../../core/model/Device";
import type { Control } from "../../core/model/Control";
import type { ModSource, ModSlot, Waveform } from "../../core/modulation/ModulationTypes";
import type { DeviceHistory } from "../../core/history/DeviceHistory";
import type { BindingManager } from "../../core/BindingManager";
import type { NexusAdapter } from "../../nexus/NexusAdapter";

export interface ModMatrixUIDeps {
    deviceLibrary: { currentDevice?: Device; saveCurrentDevice(): void };
    bindingManager: BindingManager;
    nexusAdapter: NexusAdapter;
    history: DeviceHistory;
    onBakeRequested: () => void;
}

export function sourceLabel(src: ModSource, _index: number): string {
    const typeTag = src.type === "lfo" ? "LFO" : src.type === "macro" ? "MACRO" : "RND";
    return `${src.id} · ${typeTag}`;
}

export class ModMatrixUI {
    private readonly deviceLibrary: { currentDevice?: Device; saveCurrentDevice(): void };
    private readonly history: DeviceHistory;
    private readonly onBakeRequested: () => void;

    private container?: HTMLElement;
    private drawerOpen = false;

    // The bake/engine DI (`bindingManager`, `nexusAdapter`) is reserved for
    // Phase 3 (BakeRenderer). Phase 2b only edits the persistent matrix shape,
    // so those deps are consumed here as underscore-prefixed bindings to keep
    // the constructor signature stable while satisfying `noUnusedParameters`.
    constructor({ deviceLibrary, history, onBakeRequested, bindingManager: _bindingManager, nexusAdapter: _nexusAdapter }: ModMatrixUIDeps) {
        this.deviceLibrary = deviceLibrary;
        this.history = history;
        this.onBakeRequested = onBakeRequested;
    }

    public getContainer(): HTMLElement {
        if (!this.container) {
            this.container = document.createElement("div");
            this.container.className = "mod-matrix-drawer";
        }
        this.render();
        this.container.classList.toggle("open", this.drawerOpen);
        return this.container;
    }

    public toggleDrawer(): void {
        this.drawerOpen = !this.drawerOpen;
        if (this.container) {
            this.container.classList.toggle("open", this.drawerOpen);
        }
    }

    public render(): void {
        const device = this.deviceLibrary.currentDevice;
        if (!device || !this.container) {
            return;
        }

        this.container.innerHTML = "";
        this.container.classList.toggle("open", this.drawerOpen);

        const header = document.createElement("div");
        header.className = "mod-matrix-header";

        const title = document.createElement("span");
        title.className = "mod-matrix-title";
        title.innerText = "Modulation Matrix";
        header.appendChild(title);

        const bakeBtn = document.createElement("button");
        bakeBtn.className = "btn mod-matrix-bake";
        bakeBtn.innerText = "Bake";
        bakeBtn.title = "Bake the matrix into static control values (Phase 3)";
        bakeBtn.onclick = () => this.onBakeRequested();
        header.appendChild(bakeBtn);

        this.container.appendChild(header);

        const rack = document.createElement("div");
        rack.className = "mod-source-rack";
        device.modulation.sources.forEach((src, index) => {
            rack.appendChild(this.renderSourceRow(src, index));
        });
        this.container.appendChild(rack);

        const matrix = document.createElement("div");
        matrix.className = "mod-slot-matrix";
        device.modulation.slots.forEach((slot, index) => {
            matrix.appendChild(this.renderSlotRow(slot, index, device));
        });
        this.container.appendChild(matrix);
    }

    private renderSourceRow(src: ModSource, index: number): HTMLElement {
        const device = this.deviceLibrary.currentDevice;
        const row = document.createElement("div");
        row.className = "mod-source-row";
        row.dataset.sourceId = src.id;

        const label = document.createElement("span");
        label.className = "mod-source-label";
        label.innerText = sourceLabel(src, index);
        row.appendChild(label);

        if (src.type === "lfo") {
            const wave = document.createElement("select");
            wave.className = "mod-source-waveform";
            (["sine", "triangle", "saw", "square", "sampleHold", "smoothRandom"] as const).forEach((w) => {
                const opt = document.createElement("option");
                opt.value = w;
                opt.innerText = w;
                opt.selected = src.waveform === w;
                wave.appendChild(opt);
            });
            wave.onchange = () => this.editSource(src, () => { src.waveform = wave.value as Waveform; });
            row.appendChild(wave);

            const rate = document.createElement("input");
            rate.type = "number";
            rate.className = "mod-source-rate";
            rate.min = "0";
            rate.step = "0.1";
            rate.value = String(src.rateHz);
            rate.onchange = () => this.editSource(src, () => { src.rateHz = Number(rate.value); });
            row.appendChild(rate);

            const sync = document.createElement("input");
            sync.type = "checkbox";
            sync.className = "mod-source-bpm-sync";
            sync.checked = src.bpmSync;
            sync.onchange = () => this.editSource(src, () => { src.bpmSync = sync.checked; });
            row.appendChild(sync);

            const division = document.createElement("input");
            division.type = "number";
            division.className = "mod-source-division";
            division.min = "1";
            division.step = "1";
            division.value = String(src.noteDivision);
            division.onchange = () => this.editSource(src, () => { src.noteDivision = Number(division.value); });
            row.appendChild(division);

            const phase = document.createElement("input");
            phase.type = "number";
            phase.className = "mod-source-phase";
            phase.min = "0";
            phase.max = "1";
            phase.step = "0.01";
            phase.value = String(src.phase);
            phase.onchange = () => this.editSource(src, () => { src.phase = Number(phase.value); });
            row.appendChild(phase);
        }

        if (src.type === "macro") {
            const select = document.createElement("select");
            select.className = "mod-source-macro";
            const options = (device?.controls ?? new Map<string, Control>());
            for (const [, control] of options) {
                const opt = document.createElement("option");
                opt.value = control.id;
                opt.innerText = control.name || control.id;
                opt.selected = src.sourceId === control.id;
                select.appendChild(opt);
            }
            select.onchange = () => this.editSource(src, () => { src.sourceId = select.value; });
            row.appendChild(select);
        }

        if (src.type === "random") {
            const smooth = document.createElement("input");
            smooth.type = "number";
            smooth.className = "mod-source-smooth";
            smooth.min = "0";
            smooth.max = "10000";
            smooth.step = "10";
            smooth.value = String(src.smoothMs);
            smooth.onchange = () => this.editSource(src, () => { src.smoothMs = Number(smooth.value); });
            row.appendChild(smooth);

            const drift = document.createElement("input");
            drift.type = "number";
            drift.className = "mod-source-drift";
            drift.min = "0";
            drift.max = "1";
            drift.step = "0.01";
            drift.value = String(src.drift);
            drift.onchange = () => this.editSource(src, () => { src.drift = Number(drift.value); });
            row.appendChild(drift);
        }

        const enable = document.createElement("input");
        enable.type = "checkbox";
        enable.className = "mod-source-enable";
        enable.checked = src.enabled;
        enable.onchange = () => this.editSource(src, () => { src.enabled = enable.checked; });
        row.appendChild(enable);

        return row;
    }

    private renderSlotRow(slot: ModSlot, _index: number, device: Device): HTMLElement {
        const row = document.createElement("div");
        row.className = "mod-slot-row";
        row.dataset.slotId = slot.id;

        const srcSelect = document.createElement("select");
        srcSelect.className = "mod-slot-source";
        device.modulation.sources.forEach((src, i) => {
            const opt = document.createElement("option");
            opt.value = src.id;
            opt.innerText = sourceLabel(src, i);
            opt.selected = slot.sourceId === src.id;
            srcSelect.appendChild(opt);
        });
        srcSelect.onchange = () => this.editSlot(slot, () => { slot.sourceId = srcSelect.value; });
        row.appendChild(srcSelect);

        const destSelect = document.createElement("select");
        destSelect.className = "mod-slot-dest";
        for (const [, control] of device.controls) {
            const opt = document.createElement("option");
            opt.value = control.id;
            opt.innerText = control.name || control.id;
            opt.selected = slot.destControlId === control.id;
            destSelect.appendChild(opt);
        }
        destSelect.onchange = () => this.editSlot(slot, () => { slot.destControlId = destSelect.value; });
        row.appendChild(destSelect);

        const amount = document.createElement("input");
        amount.type = "number";
        amount.className = "mod-slot-amount";
        amount.min = "-1";
        amount.max = "1";
        amount.step = "0.01";
        amount.value = String(slot.amount);
        amount.onchange = () => this.editSlot(slot, () => { slot.amount = Number(amount.value); });
        row.appendChild(amount);

        const enable = document.createElement("input");
        enable.type = "checkbox";
        enable.className = "mod-slot-enable";
        enable.checked = slot.enabled;
        enable.onchange = () => this.editSlot(slot, () => { slot.enabled = enable.checked; });
        row.appendChild(enable);

        return row;
    }

    /** Apply a single source mutation as ONE undoable device-scope action. */
    private editSource(_src: ModSource, mutate: () => void): void {
        const device = this.deviceLibrary.currentDevice;
        if (!device) return;
        const before = this.history.captureDeviceState(device);
        mutate();
        const after = this.history.captureDeviceState(device);
        this.history.recordDeviceAction("matrix.edit", device, before, after);
        this.persist(device);
    }

    /** Apply a single slot mutation as ONE undoable device-scope action. */
    private editSlot(_slot: ModSlot, mutate: () => void): void {
        const device = this.deviceLibrary.currentDevice;
        if (!device) return;
        const before = this.history.captureDeviceState(device);
        mutate();
        const after = this.history.captureDeviceState(device);
        this.history.recordDeviceAction("matrix.edit", device, before, after);
        this.persist(device);
    }

    private persist(device: Device): void {
        const activeId = this.deviceLibrary.currentDevice?.id;
        if (activeId !== device.id) return;
        this.deviceLibrary.saveCurrentDevice();
    }
}