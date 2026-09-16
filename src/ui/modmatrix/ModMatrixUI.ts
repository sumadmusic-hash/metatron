import type { Device } from "../../core/model/Device";
import type { Control } from "../../core/model/Control";
import type { ModSource, ModSlot, Waveform } from "../../core/modulation/ModulationTypes";
import type { DeviceHistory } from "../../core/history/DeviceHistory";
import type { BindingManager } from "../../core/BindingManager";
import type { NexusAdapter } from "../../nexus/NexusAdapter";
import { renderMatrixToRecording } from "../../modulation/BakeRenderer";
import { writeAutomationRecording, readTempoBpm } from "../../automation/AutomationWriter";
import { Toast } from "../Toast";

export interface ModMatrixUIDeps {
    deviceLibrary: { currentDevice?: Device; saveCurrentDevice(): void };
    bindingManager: BindingManager;
    nexusAdapter: NexusAdapter;
    history: DeviceHistory;
}

export function sourceLabel(src: ModSource, _index: number): string {
    const typeTag = src.type === "lfo" ? "LFO" : src.type === "macro" ? "MACRO" : "RND";
    return `${src.id} · ${typeTag}`;
}

export class ModMatrixUI {
    private readonly deviceLibrary: { currentDevice?: Device; saveCurrentDevice(): void };
    private readonly history: DeviceHistory;
    private readonly bindingManager: BindingManager;
    private readonly nexusAdapter: NexusAdapter;

    private container?: HTMLElement;
    private drawerOpen = false;

    constructor({ deviceLibrary, history, bindingManager, nexusAdapter }: ModMatrixUIDeps) {
        this.deviceLibrary = deviceLibrary;
        this.history = history;
        this.bindingManager = bindingManager;
        this.nexusAdapter = nexusAdapter;
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
        bakeBtn.title = "Bake the matrix into static automation";
        bakeBtn.onclick = () => this.toggleBakeDialog();
        header.appendChild(bakeBtn);

        this.container.appendChild(header);

        if (this.bakeDialogOpen) {
            this.container.appendChild(this.renderBakeDialog());
        }

        const rack = document.createElement("div");
        rack.className = "mod-source-rack";
        rack.appendChild(this.sectionTitle("Sources"));
        device.modulation.sources.forEach((src, index) => {
            rack.appendChild(this.renderSourceRow(src, index));
        });
        this.container.appendChild(rack);

        const matrix = document.createElement("div");
        matrix.className = "mod-slot-matrix";
        matrix.appendChild(this.sectionTitle("Routing"));
        device.modulation.slots.forEach((slot, index) => {
            matrix.appendChild(this.renderSlotRow(slot, index, device));
        });
        this.container.appendChild(matrix);
    }

    private bakeDialogOpen = false;

    private toggleBakeDialog(): void {
        this.bakeDialogOpen = !this.bakeDialogOpen;
        if (this.container) {
            this.render();
        }
    }

    private renderBakeDialog(): DocumentFragment {
        const backdrop = document.createElement("div");
        backdrop.className = "mod-bake-backdrop";
        backdrop.title = "Click outside to close";
        backdrop.onclick = () => this.toggleBakeDialog();

        const dialog = document.createElement("div");
        dialog.className = "mod-bake-dialog";

        const row = document.createElement("div");
        row.className = "mod-bake-row";

        const barsLabel = document.createElement("label");
        barsLabel.className = "mod-bake-label";
        barsLabel.innerText = "Bars";
        barsLabel.htmlFor = "mod-bake-bars";
        const bars = document.createElement("input");
        bars.id = "mod-bake-bars";
        bars.name = "bars";
        bars.className = "mod-bake-bars";
        bars.type = "number";
        bars.min = "1";
        bars.step = "1";
        bars.value = "4";
        barsLabel.appendChild(bars);
        row.appendChild(barsLabel);

        const gridLabel = document.createElement("label");
        gridLabel.className = "mod-bake-label";
        gridLabel.innerText = "Grid";
        gridLabel.htmlFor = "mod-bake-grid";
        const grid = document.createElement("select");
        grid.id = "mod-bake-grid";
        grid.name = "grid";
        grid.className = "mod-bake-grid";
        (["1/16", "1/32"] as const).forEach((g) => {
            const opt = document.createElement("option");
            opt.value = g;
            opt.innerText = g;
            grid.appendChild(opt);
        });
        gridLabel.appendChild(grid);
        row.appendChild(gridLabel);

        dialog.appendChild(row);

        const actions = document.createElement("div");
        actions.className = "mod-bake-actions";

        const closeBtn = document.createElement("button");
        closeBtn.className = "btn mod-bake-close";
        closeBtn.innerText = "Cancel";
        closeBtn.onclick = () => this.toggleBakeDialog();
        actions.appendChild(closeBtn);

        const renderBtn = document.createElement("button");
        renderBtn.className = "btn mod-bake-render";
        renderBtn.innerText = "Render";
        renderBtn.onclick = () => {
            const rawBars = Number(bars.value);
            const normalizedGrid = grid.value as "1/16" | "1/32";
            void this.onBakeRequested(Number.isFinite(rawBars) && rawBars > 0 ? rawBars : 1, normalizedGrid);
        };
        actions.appendChild(renderBtn);

        dialog.appendChild(actions);

        const frag = document.createDocumentFragment();
        frag.appendChild(backdrop);
        frag.appendChild(dialog);
        return frag;
    }

    /** Bake the current matrix into automation and surface an outcome toast.
     *  The dialogs' bars/grid inputs feed this; the recording is rendered
     *  offline (no playhead) and written through the standard writer. */
    private async onBakeRequested(bars: number, grid: "1/16" | "1/32"): Promise<void> {
        const device = this.deviceLibrary.currentDevice;
        if (!device) {
            Toast.show("No device loaded — cannot bake.", "error");
            return;
        }
        if (!this.nexusAdapter.document) {
            Toast.show("No open document — cannot bake.", "error");
            return;
        }

        const recording = renderMatrixToRecording(device.modulation, device, {
            bars,
            projectBpm: readTempoBpm(this.nexusAdapter.document) ?? 120,
            startTick: 0,
            grid,
        });

        if (recording.tracks.length === 0) {
            Toast.show("No modulated destinations with active bindings.", "info");
            return;
        }

        const result = await writeAutomationRecording(recording, this.nexusAdapter.document, this.bindingManager);

        const failed = result.perTrack.filter((track) => !track.ok);
        if (result.ok && failed.length === 0) {
            Toast.show(
                `Baked ${recording.tracks.length} track(s) into automation (${recording.durationSeconds.toFixed(1)}s).`,
                "success"
            );
        } else if (failed.length === recording.tracks.length) {
            const reasons = failed.map((track) => `"${track.reason}"`).join(", ");
            Toast.show(`Bake failed for all tracks — ${reasons}`, "error");
        } else {
            const reasons = failed.map((track) => `"${track.reason}"`).join(", ");
            Toast.show(`Bake partially failed — ${failed.length}/${recording.tracks.length} track(s): ${reasons}`, "warning");
        }

        this.bakeDialogOpen = false;
        this.render();
    }

    /** Control-option labels for the macro-source and slot-dest dropdowns. Only
     *  when several controls share the same display name (the default right
     *  after creation) the duplicates get a stable "name (n)" suffix in
     *  creation order; unique names stay untouched. */
    private buildOptionLabels(controls: Map<string, Control>): (control: Control) => string {
        const occurrences = new Map<string, number>();
        for (const [, control] of controls) {
            const key = control.name || control.id;
            occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
        }
        const position = new Map<string, number>();
        return (control: Control) => {
            const key = control.name || control.id;
            if ((occurrences.get(key) ?? 0) <= 1) return key;
            const n = (position.get(key) ?? 0) + 1;
            position.set(key, n);
            return `${key} (${n})`;
        };
    }

    private renderSourceRow(src: ModSource, index: number): HTMLElement {
        const device = this.deviceLibrary.currentDevice;
        const row = document.createElement("div");
        row.className = "mod-source-row" + (src.enabled ? " on" : " off");
        row.dataset.sourceId = src.id;

        const label = document.createElement("span");
        label.className = "mod-source-label";
        label.innerText = sourceLabel(src, index);
        row.appendChild(label);

        if (src.type === "lfo") {
            const wave = document.createElement("select");
            wave.className = "mod-source-waveform";
            wave.id = `mod-src-wave-${src.id}`;
            (["sine", "triangle", "saw", "square", "sampleHold", "smoothRandom"] as const).forEach((w) => {
                const opt = document.createElement("option");
                opt.value = w;
                opt.innerText = w;
                opt.selected = src.waveform === w;
                wave.appendChild(opt);
            });
            wave.onchange = () => this.editSource(src, () => { src.waveform = wave.value as Waveform; });
            row.appendChild(this.field("Wave", wave));

            row.appendChild(this.renderModeToggle(src));
            row.appendChild(this.renderFrequencyField(src));

            const phase = document.createElement("input");
            phase.type = "number";
            phase.id = `mod-src-phase-${src.id}`;
            phase.className = "mod-source-phase";
            phase.min = "0";
            phase.max = "1";
            phase.step = "0.01";
            phase.value = String(src.phase);
            phase.onchange = () => this.editSource(src, () => { src.phase = Number(phase.value); });
            row.appendChild(this.field("Phase", phase));
        }

        if (src.type === "macro") {
            const select = document.createElement("select");
            select.className = "mod-source-macro";
            select.id = `mod-src-macro-${src.id}`;
            const options = (device?.controls ?? new Map<string, Control>());
            const noneOpt = document.createElement("option");
            noneOpt.value = "";
            noneOpt.innerText = "— none —";
            const hasRef = src.sourceId !== "" && options.has(src.sourceId);
            noneOpt.selected = !hasRef;
            select.appendChild(noneOpt);
            const labelFor = this.buildOptionLabels(options);
            for (const [, control] of options) {
                const opt = document.createElement("option");
                opt.value = control.id;
                opt.innerText = labelFor(control);
                opt.selected = src.sourceId === control.id;
                select.appendChild(opt);
            }
            select.value = hasRef ? src.sourceId : "";
            select.onchange = () => this.editSource(src, () => { src.sourceId = select.value; });
            row.appendChild(this.field("Source", select));
        }

        if (src.type === "random") {
            const smooth = document.createElement("input");
            smooth.type = "number";
            smooth.id = `mod-src-smooth-${src.id}`;
            smooth.className = "mod-source-smooth";
            smooth.min = "0";
            smooth.max = "10000";
            smooth.step = "10";
            smooth.value = String(src.smoothMs);
            smooth.onchange = () => this.editSource(src, () => { src.smoothMs = Number(smooth.value); });
            row.appendChild(this.field("Smooth", smooth));

            const drift = document.createElement("input");
            drift.type = "number";
            drift.id = `mod-src-drift-${src.id}`;
            drift.className = "mod-source-drift";
            drift.min = "0";
            drift.max = "1";
            drift.step = "0.01";
            drift.value = String(src.drift);
            drift.onchange = () => this.editSource(src, () => { src.drift = Number(drift.value); });
            row.appendChild(this.field("Drift", drift));
        }

        const enable = document.createElement("input");
        enable.type = "checkbox";
        enable.id = `mod-src-enable-${src.id}`;
        enable.className = "mod-source-enable";
        enable.checked = src.enabled;
        enable.onchange = () => {
            this.editSource(src, () => { src.enabled = enable.checked; });
            row.classList.toggle("on", enable.checked);
            row.classList.toggle("off", !enable.checked);
        };
        row.appendChild(this.field("Enable", enable, "check"));

        return row;
    }

    private renderSlotRow(slot: ModSlot, _index: number, device: Device): HTMLElement {
        const row = document.createElement("div");
        row.className = "mod-slot-row" + (slot.enabled ? " on" : " off");
        row.dataset.slotId = slot.id;

        const srcCap = document.createElement("span");
        srcCap.className = "mod-route-cap mod-route-cap--src";
        srcCap.innerText = "Source";
        row.appendChild(srcCap);

        const srcSelect = document.createElement("select");
        srcSelect.className = "mod-slot-source";
        srcSelect.id = `mod-slot-src-${slot.id}`;
        device.modulation.sources.forEach((src, i) => {
            const opt = document.createElement("option");
            opt.value = src.id;
            opt.innerText = sourceLabel(src, i);
            opt.selected = slot.sourceId === src.id;
            srcSelect.appendChild(opt);
        });
        srcSelect.onchange = () => this.editSlot(slot, () => { slot.sourceId = srcSelect.value; });
        row.appendChild(srcSelect);

        const arrow = document.createElement("span");
        arrow.className = "mod-route-arrow";
        arrow.innerText = "→";
        arrow.setAttribute("aria-hidden", "true");
        row.appendChild(arrow);

        const destCap = document.createElement("span");
        destCap.className = "mod-route-cap mod-route-cap--dest";
        destCap.innerText = "Dest";
        row.appendChild(destCap);

        const destSelect = document.createElement("select");
        destSelect.className = "mod-slot-dest";
        destSelect.id = `mod-slot-dest-${slot.id}`;
        const noneOpt = document.createElement("option");
        noneOpt.value = "";
        noneOpt.innerText = "— none —";
        const hasDest = slot.destControlId !== "" && device.controls.has(slot.destControlId);
        noneOpt.selected = !hasDest;
        destSelect.appendChild(noneOpt);
        const destLabel = this.buildOptionLabels(device.controls);
        for (const [, control] of device.controls) {
            const opt = document.createElement("option");
            opt.value = control.id;
            opt.innerText = destLabel(control);
            opt.selected = slot.destControlId === control.id;
            destSelect.appendChild(opt);
        }
        destSelect.value = hasDest ? slot.destControlId : "";
        destSelect.onchange = () => this.editSlot(slot, () => { slot.destControlId = destSelect.value; });
        row.appendChild(destSelect);

        const amtCap = document.createElement("span");
        amtCap.className = "mod-route-cap mod-route-cap--amt";
        amtCap.innerText = "Amount";
        row.appendChild(amtCap);

        row.appendChild(this.renderAmountControl(slot));

        const enable = document.createElement("input");
        enable.type = "checkbox";
        enable.id = `mod-slot-enable-${slot.id}`;
        enable.className = "mod-slot-enable";
        enable.checked = slot.enabled;
        enable.onchange = () => {
            this.editSlot(slot, () => { slot.enabled = enable.checked; });
            row.classList.toggle("on", enable.checked);
            row.classList.toggle("off", !enable.checked);
        };

        const onGroup = document.createElement("span");
        onGroup.className = "mod-route-on";
        const onCap = document.createElement("span");
        onCap.className = "mod-route-cap mod-route-cap--on";
        onCap.innerText = "On";
        onGroup.appendChild(onCap);
        onGroup.appendChild(enable);
        row.appendChild(onGroup);

        return row;
    }

    /** Bipolar amount control in percent (-100% … +100%); the data model keeps
     *  `amount ∈ [-1, +1]` — the UI translates for display and back on write. */
    private renderAmountControl(slot: ModSlot): HTMLElement {
        const wrap = document.createElement("div");
        wrap.className = "mod-amount";

        const slider = document.createElement("input");
        slider.type = "range";
        slider.id = `mod-slot-amount-slider-${slot.id}`;
        slider.className = "mod-slot-amount-slider";
        slider.min = "-100";
        slider.max = "100";
        slider.step = "1";
        slider.value = String(Math.round(slot.amount * 100));
        slider.addEventListener("input", () => {
            num.value = String(Number(slider.value));
        });
        slider.addEventListener("change", () => {
            const v = Number(slider.value);
            num.value = String(v);
            this.editSlot(slot, () => { slot.amount = v / 100; });
        });
        wrap.appendChild(slider);

        const num = document.createElement("input");
        num.type = "number";
        num.id = `mod-slot-amount-${slot.id}`;
        num.className = "mod-slot-amount";
        num.min = "-100";
        num.max = "100";
        num.step = "1";
        num.value = String(Math.round(slot.amount * 100));
        num.onchange = () => {
            const raw = Number(num.value);
            const clamped = Number.isFinite(raw) ? Math.max(-100, Math.min(100, raw)) : 0;
            num.value = String(clamped);
            slider.value = String(clamped);
            this.editSlot(slot, () => { slot.amount = clamped / 100; });
        };
        wrap.appendChild(num);

        const unit = document.createElement("span");
        unit.className = "mod-route-cap";
        unit.innerText = "%";
        wrap.appendChild(unit);

        return wrap;
    }

    /** Caption + control column using Metatron's caption language (small,
     *  uppercase, letter-spaced label stacked above the control). */
    private field(caption: string, control: HTMLElement, mod = ""): HTMLElement {
        const wrap = document.createElement("div");
        wrap.className = "mod-field" + mod.split(/\s+/).filter(Boolean).map((m) => ` mod-field--${m}`).join("");
        const label = document.createElement("label");
        label.className = "mod-field-caption";
        label.innerText = caption;
        if (control.id) {
            label.htmlFor = control.id;
        }
        wrap.appendChild(label);
        wrap.appendChild(control);
        return wrap;
    }

    private sectionTitle(text: string): HTMLElement {
        const title = document.createElement("div");
        title.className = "mod-section-title";
        title.innerText = text;
        return title;
    }

    /** FREE | SYNC segment toggle — replaces the old bare SYNC checkbox.
     *  Toggling only flips bpmSync; rateHz/noteDivision are kept as-is and no
     *  BPM<->Hz conversion happens (existing data semantics preserved). */
    private renderModeToggle(src: ModSource): HTMLElement {
        const seg = document.createElement("div");
        seg.className = "mod-seg";
        seg.id = `mod-src-sync-${src.id}`;

        const freeBtn = document.createElement("button");
        freeBtn.type = "button";
        freeBtn.className = "mod-seg-btn" + (src.bpmSync ? "" : " active");
        freeBtn.innerText = "Free";
        freeBtn.onclick = () => this.setBpmSync(src, false);
        seg.appendChild(freeBtn);

        const syncBtn = document.createElement("button");
        syncBtn.type = "button";
        syncBtn.className = "mod-seg-btn" + (src.bpmSync ? " active" : "");
        syncBtn.innerText = "Sync";
        syncBtn.onclick = () => this.setBpmSync(src, true);
        seg.appendChild(syncBtn);

        return this.field("Mode", seg);
    }

    private setBpmSync(src: ModSource, sync: boolean): void {
        if (src.bpmSync === sync) return;
        this.editSource(src, () => { src.bpmSync = sync; });
        if (this.container) {
            this.render();
        }
    }

    /** FREQUENCY field: FREE shows the Hz readout plus compact tuning slider,
     *  SYNC shows the musical note division select (1/1 … 1/32, translated
     *  to/from the numeric noteDivision). */
    private renderFrequencyField(src: ModSource): HTMLElement {
        if (src.bpmSync) {
            const division = document.createElement("select");
            division.id = `mod-src-div-${src.id}`;
            division.className = "mod-source-division";
            const divisions = [1, 2, 4, 8, 16, 32];
            for (const d of divisions) {
                const opt = document.createElement("option");
                opt.value = String(d);
                opt.innerText = `1/${d}`;
                opt.selected = src.noteDivision === d;
                division.appendChild(opt);
            }
            if (!divisions.includes(src.noteDivision)) {
                const opt = document.createElement("option");
                opt.value = String(src.noteDivision);
                opt.innerText = `1/${src.noteDivision}`;
                opt.selected = true;
                division.appendChild(opt);
            }
            division.onchange = () => this.editSource(src, () => { src.noteDivision = Number(division.value); });
            return this.field("Freq", division);
        }

        const rate = document.createElement("input");
        rate.type = "number";
        rate.id = `mod-src-rate-${src.id}`;
        rate.className = "mod-source-rate";
        rate.min = "0.01";
        rate.max = "20";
        rate.step = "0.1";
        rate.value = String(src.rateHz);
        rate.onchange = () => {
            const raw = Number(rate.value);
            const clamped = Number.isFinite(raw) ? Math.min(20, Math.max(0.01, raw)) : 0.01;
            rate.value = String(clamped);
            slider.value = String(clamped);
            this.editSource(src, () => { src.rateHz = clamped; });
        };

        const slider = document.createElement("input");
        slider.type = "range";
        slider.id = `mod-src-rate-slider-${src.id}`;
        slider.className = "mod-source-rate-slider";
        // Tuning band mirrors the engine's effective free-LFO range (0.01–20 Hz).
        slider.min = "0.01";
        slider.max = "20";
        slider.step = "0.01";
        slider.value = String(src.rateHz);
        slider.addEventListener("input", () => {
            rate.value = String(Number(slider.value));
        });
        slider.addEventListener("change", () => {
            const v = Number(slider.value);
            rate.value = String(v);
            this.editSource(src, () => { src.rateHz = v; });
        });

        const wrap = document.createElement("div");
        wrap.className = "mod-rate";
        wrap.appendChild(rate);
        const unit = document.createElement("span");
        unit.className = "mod-rate-unit";
        unit.innerText = "Hz";
        wrap.appendChild(unit);
        wrap.appendChild(slider);
        return this.field("Freq", wrap);
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