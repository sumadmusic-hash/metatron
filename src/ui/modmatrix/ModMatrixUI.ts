import type { Device } from "../../core/model/Device";
import type { Control } from "../../core/model/Control";
import type { ModSource, ModSlot, Waveform } from "../../core/modulation/ModulationTypes";
import type { DeviceHistory } from "../../core/history/DeviceHistory";
import type { BindingManager } from "../../core/BindingManager";
import type { NexusAdapter } from "../../nexus/NexusAdapter";
import { renderMatrixToRecording, MAX_BAKE_BARS } from "../../modulation/BakeRenderer";
import { writeAutomationRecording, readTempoBpm } from "../../automation/AutomationWriter";
import { Toast } from "../Toast";

const MATRIX_SAVE_DEBOUNCE_MS = 100;

export interface ModMatrixUIDeps {
    deviceLibrary: {
        currentDevice?: Device;
        saveCurrentDevice(): void;
        /** Bug 3 — persist einer BELIEBIGEN Device-Instanz (die, der eine
         *  pendingMatrixSave gehört), nicht nur currentDevice. */
        saveDevice(device: Device): void;
    };
    bindingManager: BindingManager;
    nexusAdapter: NexusAdapter;
    history: DeviceHistory;
    /** Fired after every matrix edit (route on/off, dest, source, amount,
     *  LFO/rate) so owner UIs can sync derived state WITHOUT re-rendering.
     *  AppUI uses it to push the new modulated state onto the SurfaceUI. */
    onMatrixChange?: () => void;
}

/** Per-waveform mini icon, mirrored from the design reference (SVG zum
 *  LFO-Bereich): a small labelled vector glyph inside the Wave field. The
 *  paths are pairwise distinct so a rendered waveform is immediately
 *  identifiable — never a shared static squiggle. */
const WAVEFORM_PATHS: Record<Waveform, string> = {
    sine: "M0 5 Q2 1 4 5 T8 5 T12 5 T16 5",
    triangle: "M1 7 L8 1 L15 7",
    saw: "M1 7 L6 3 L6 7",
    square: "M0 7 L0 2 L8 2 L8 7 L16 7",
    sampleHold: "M0 2 H6 V7 H10 V3 H16 V8",
    smoothRandom: "M0 6 L4 3 L8 7 L12 2 L16 6",
};

export function sourceLabel(src: ModSource, _index: number): string {
    const typeTag = src.type === "lfo" ? "LFO" : src.type === "macro" ? "MACRO" : "RND";
    const num = src.id.replace("mod", "");
    return `${typeTag} ${num}`;
}

/** Height source for row sync. In the browser offsetHeight is authoritative;
 *  happy-dom has no layout engine (always 0), so the explicit CSS height/
 *  minHeight serve as the fallback so behaviour stays testable. */
function rowHeight(el: HTMLElement): number {
    return el.offsetHeight || parseFloat(el.style.height) || parseFloat(el.style.minHeight) || 0;
}

/** Visually propagate a slider's cyan fill range through CSS custom
 *  properties. Presentation only — never touches the slider's value,
 *  its bounds, or its event logic. */
function setSliderFill(el: HTMLElement, startPct: number, endPct: number): void {
    el.style.setProperty("--mod-fill-start", `${startPct}%`);
    el.style.setProperty("--mod-fill-end", `${endPct}%`);
}

/** Escape a string for use as a CSS identifier in selectors. */
function escapeCssId(id: string): string {
    return CSS.escape(id);
}

export class ModMatrixUI {
    private readonly deviceLibrary: {
        currentDevice?: Device;
        saveCurrentDevice(): void;
        saveDevice(device: Device): void;
    };
    private readonly history: DeviceHistory;
    private readonly bindingManager: BindingManager;
    private readonly nexusAdapter: NexusAdapter;
    private readonly onMatrixChange?: () => void;

    private container?: HTMLElement;
    private drawerOpen = false;
    private rowObserver?: ResizeObserver;
    /** Live slider gesture (rate/depth): the first `input` snapshots the
     *  state, `change` (release/blur) records EXACTLY ONE undo step — writes
     *  happen in real time without flooding the undo history. */
    private liveGesture?: { device: Device; before: ReturnType<DeviceHistory["captureDeviceState"]> };
    private matrixSaveTimer?: ReturnType<typeof setTimeout>;
    private pendingMatrixSaveDevice?: Device;

    constructor({ deviceLibrary, history, bindingManager, nexusAdapter, onMatrixChange }: ModMatrixUIDeps) {
        this.deviceLibrary = deviceLibrary;
        this.history = history;
        this.bindingManager = bindingManager;
        this.nexusAdapter = nexusAdapter;
        this.onMatrixChange = onMatrixChange;
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

    /** Structural device changes (create/delete/rename/archive) must refresh
     *  the option lists even while the drawer stays open. */
    public refresh(): void {
        if (this.container && this.deviceLibrary.currentDevice) {
            this.render();
        }
    }

    public render(): void {
        const device = this.deviceLibrary.currentDevice;
        if (!device || !this.container) {
            return;
        }

        this.flushMatrixSave();
        // Commit any pending live gesture BEFORE rebuilding the DOM,
        // so the gesture's undo snapshot is not lost.
        this.commitLiveEdit();
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

        this.bindActiveTracking();
        this.observeRowHeights();
        if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(() => this.syncLayout());
        } else {
            this.syncLayout();
        }
    }

    /** Sync slot (routing) row heights to their index-paired source rows, and
     *  mirror the active bidirectional link back onto the source column. */
    public syncLayout(): void {
        this.syncRowHeights();
        this.highlightCrossColumn();
    }

    /** Read every source row height, then (in a second pass) apply the same
     *  height to the matching routing row. Batched read->write order avoids
     *  layout thrashing. */
    public syncRowHeights(): void {
        const rack = this.container?.querySelector(".mod-source-rack");
        const matrix = this.container?.querySelector(".mod-slot-matrix");
        if (!rack || !matrix) return;
        const heights = Array.from(rack.querySelectorAll<HTMLElement>(".mod-source-row"))
            .filter((r) => rowHeight(r) > 0)
            .map((r) => rowHeight(r));
        Array.from(matrix.querySelectorAll<HTMLElement>(".mod-slot-row")).forEach((slot, i) => {
            if (heights[i]) {
                slot.style.minHeight = `${heights[i]}px`;
            }
        });
    }

    /** Persistent cross-column marking: ONLY an ENABLED routing row (.on)
     *  surfaces its source on the left via .source-linked. Hover/focus state
     *  is intentionally excluded: .source-linked is the persisted matrix
     *  truth, not a transient routing-selection marker. */
    public highlightCrossColumn(): void {
        const rack = this.container?.querySelector(".mod-source-rack");
        const matrix = this.container?.querySelector(".mod-slot-matrix");
        const device = this.deviceLibrary.currentDevice;
        if (!rack || !matrix || !device) return;
        rack.querySelectorAll<HTMLElement>(".mod-source-row.source-linked").forEach((r) => {
            r.classList.remove("source-linked");
        });
        matrix.querySelectorAll<HTMLElement>(".mod-slot-row.on").forEach((slotRow) => {
            const srcId = device.modulation.slots.find((s) => s.id === slotRow.dataset.slotId)?.sourceId;
            if (!srcId) return;
            rack.querySelector<HTMLElement>(`.mod-source-row[data-source-id="${escapeCssId(srcId)}"]`)?.classList.add("source-linked");
        });
    }

    /** Transient hover/focus tracking on slot rows (delegated, rebuilt each
     *  render). It updates only `data-active`; .source-linked is reserved for
     *  enabled matrix routes. relatedTarget guards avoid clearing/re-setting
     *  the row state while moving between children of the same route row. */
    private bindActiveTracking(): void {
        const matrix = this.container?.querySelector(".mod-slot-matrix");
        if (!matrix) return;
        const rowOf = (t: EventTarget | null): HTMLElement | null =>
            t instanceof Element ? t.closest<HTMLElement>(".mod-slot-row") : null;
        const relatedRowOf = (e: Event): HTMLElement | null =>
            rowOf((e as MouseEvent | FocusEvent).relatedTarget);
        matrix.addEventListener("pointerover", (e) => {
            const row = rowOf(e.target);
            if (!row || relatedRowOf(e) === row) return;
            row.dataset.active = "true";
        });
        matrix.addEventListener("pointerout", (e) => {
            const row = rowOf(e.target);
            if (!row || relatedRowOf(e) === row) return;
            delete row.dataset.active;
        });
        matrix.addEventListener("focusin", (e) => {
            const row = rowOf(e.target);
            if (!row || relatedRowOf(e) === row) return;
            row.dataset.active = "true";
        });
        matrix.addEventListener("focusout", (e) => {
            const row = rowOf(e.target);
            if (!row || relatedRowOf(e) === row) return;
            delete row.dataset.active;
        });
    }

    /** Re-sync source/slot row pairing whenever source content resizes
     *  (window resize, zoom, font scaling). Re-armed on each render because
     *  render() rebuilds the rack element. */
    private observeRowHeights(): void {
        const rack = this.container?.querySelector(".mod-source-rack");
        if (!rack) return;
        this.rowObserver?.disconnect();
        if (typeof ResizeObserver === "undefined") return;
        this.rowObserver = new ResizeObserver(() => this.syncRowHeights());
        this.rowObserver.observe(rack);
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
        const bars = document.createElement("input");
        bars.id = "mod-bake-bars";
        bars.name = "bars";
        bars.className = "mod-bake-bars";
        bars.type = "number";
        bars.min = "1";
        bars.max = String(MAX_BAKE_BARS);
        bars.step = "1";
        bars.value = "4";
        barsLabel.appendChild(bars);
        row.appendChild(barsLabel);

        const gridLabel = document.createElement("label");
        gridLabel.className = "mod-bake-label";
        gridLabel.innerText = "Grid";
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

        const note = document.createElement("div");
        note.className = "mod-bake-note";
        note.innerText = "Start: Projektanfang (Tick 0) — Nexus expose-t keine Playhead-Position.";
        dialog.appendChild(note);

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
            const parsed = Number(bars.value);
            const finite = Number.isFinite(parsed);
            const rawBars = finite ? parsed : 1;
            const clamped = Math.min(Math.max(Math.floor(rawBars), 1), MAX_BAKE_BARS);
            if (finite && clamped !== rawBars) {
                Toast.show(`Bake capped to ${MAX_BAKE_BARS} bars.`, "warning");
            }
            const normalizedGrid = grid.value as "1/16" | "1/32";
            void this.onBakeRequested(clamped, normalizedGrid);
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
        } else if (!result.ok) {
            // Transaction failed completely — show the actual error
            Toast.show(`Bake transaction failed: ${result.error ?? "unknown error"}`, "error");
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
        // B30 — "on" only when an ENABLED slot routes THIS source; otherwise
        // the row is "off" instead of carrying the on-state unconditionally.
        const referenced = (device?.modulation.slots ?? [])
            .some((s) => s.enabled && s.sourceId === src.id);
        row.className = "mod-source-row" + (referenced ? " on" : " off");
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
            // §2 — the Wave field has NO visible caption anymore: the dynamic
            // waveform glyph is the only lead-in (keep the glyph + select).
            const glyph = this.waveformGlyph(src.waveform);
            wave.onchange = () => {
                const newWave = wave.value as Waveform;
                this.editSource(src, () => { src.waveform = newWave; });
                // Live-update the glyph path without full re-render
                const path = glyph.querySelector("path");
                if (path) path.setAttribute("d", WAVEFORM_PATHS[newWave]);
            };
            const waveField = this.field(null, wave, "wave");
            waveField.insertBefore(glyph, wave);
            row.appendChild(waveField);

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
            // §2 — the Phase caption is replaced by the φ symbol (visible only;
            // the 0..1 phase value + processing are unchanged).
            row.appendChild(this.field("φ", phase));
        }

        if (src.type === "macro") {
            const select = document.createElement("select");
            select.className = "mod-source-macro";
            select.id = `mod-src-macro-${src.id}`;
            const all = device?.controls ?? new Map<string, Control>();
            // FIX B36: archived controls are not selectable as macro sources; a
            // source still referencing one keeps the disabled, labelled option.
            const options = new Map<string, Control>();
            for (const [id, control] of all) {
                if (!control.archived || id === src.sourceId) options.set(id, control);
            }
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
                opt.innerText = control.archived ? `${labelFor(control)} (deleted)` : labelFor(control);
                opt.selected = src.sourceId === control.id;
                if (control.archived) opt.disabled = true;
                select.appendChild(opt);
            }
            select.value = hasRef ? src.sourceId : "";
            select.onchange = () => this.editSource(src, () => { src.sourceId = select.value; });
            row.appendChild(this.field("SRC", select));
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

        return row;
    }

    private renderSlotRow(slot: ModSlot, _index: number, device: Device): HTMLElement {
        const row = document.createElement("div");
        row.className = "mod-slot-row" + (slot.enabled ? " on" : " off");
        row.dataset.slotId = slot.id;

        const srcCap = document.createElement("span");
        srcCap.className = "mod-route-cap mod-route-cap--src";
        srcCap.innerText = "SRC";
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
        // FIX B36: deleted (archived) controls are no longer selectable
        // destinations. A slot that still points at one keeps its option
        // (disabled + labelled) so the stale reference stays visible instead of
        // silently collapsing to "— none —".
        const destOptions = new Map<string, Control>();
        for (const [id, control] of device.controls) {
            if (!control.archived || id === slot.destControlId) destOptions.set(id, control);
        }
        const destLabel = this.buildOptionLabels(destOptions);
        for (const [, control] of destOptions) {
            const opt = document.createElement("option");
            opt.value = control.id;
            opt.innerText = control.archived ? `${destLabel(control)} (deleted)` : destLabel(control);
            opt.selected = slot.destControlId === control.id;
            if (control.archived) opt.disabled = true;
            destSelect.appendChild(opt);
        }
        destSelect.value = hasDest ? slot.destControlId : "";
        destSelect.onchange = () => this.editSlot(slot, () => { slot.destControlId = destSelect.value; });
        row.appendChild(destSelect);

        const amtCap = document.createElement("span");
        amtCap.className = "mod-route-cap mod-route-cap--amt";
        amtCap.innerText = "Amt";
        row.appendChild(amtCap);

        row.appendChild(this.renderAmountControl(slot));

        const enable = document.createElement("input");
        enable.type = "checkbox";
        enable.id = `mod-slot-enable-${slot.id}`;
        enable.className = "mod-slot-enable";
        enable.checked = slot.enabled;
        enable.onchange = () => {
            // Row class first-class inside the mutation: syncActiveMarking()
            // (called by editSlot) must read the UPDATED .on/.off state for
            // its cross-column highlightAllActiveColumns.
            this.editSlot(slot, () => {
                slot.enabled = enable.checked;
                row.classList.toggle("on", enable.checked);
                row.classList.toggle("off", !enable.checked);
            });
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
     *  `amount ∈ [-1, +1]` — the UI translates for display and back on write.
     *  §6 — the read-only text entry is gone; the signed badge mirrors the
     *  slider directly, the fader owns the whole gesture. */
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
        const updateAmountFill = (): void => {
            const v = Number(slider.value);
            const pos = ((v - Number(slider.min)) / (Number(slider.max) - Number(slider.min))) * 100;
            setSliderFill(slider, Math.min(50, pos), Math.max(50, pos));
        };
        updateAmountFill();
        // Live gesture: write slot.amount on EVERY input (the runner reads
        // device.modulation live → the modulation depth reacts in real time).
        // The undo history is committed exactly once on gesture end (release).
        let amountGestureFlushed = false;
        const commitAmount = (): void => {
            amountGestureFlushed = false;
            const v = Number(slider.value);
            updateAmountFill();
            renderBadge();
            const device = this.deviceLibrary.currentDevice;
            if (device) this.liveEdit(device, () => { slot.amount = v / 100; });
        };
        const finishAmountGesture = (): void => {
            this.flushMatrixSave();
            this.commitLiveEdit();
            amountGestureFlushed = true;
        };
        slider.addEventListener("input", commitAmount);
        slider.addEventListener("change", () => {
            if (!amountGestureFlushed) commitAmount();
            finishAmountGesture();
        });
        slider.addEventListener("pointerup", finishAmountGesture);
        slider.addEventListener("pointercancel", finishAmountGesture);
        wrap.appendChild(slider);

        // C7 — signed readout ("−23 %" / "+23 %") as a pure-presentation badge,
        // fed straight from the slider's live value.
        const badge = document.createElement("span");
        badge.className = "mod-slot-amount-signed";
        badge.setAttribute("aria-hidden", "true");
        const renderBadge = (): void => {
            const v = Number(slider.value);
            badge.innerText = (Number.isFinite(v) && v > 0 ? "+" : "") + String(Math.round(v));
        };
        renderBadge();
        wrap.appendChild(badge);

        const unit = document.createElement("span");
        unit.className = "mod-route-cap";
        unit.innerText = "%";
        wrap.appendChild(unit);

        return wrap;
    }

    /** Caption + control column using Metatron's caption language (small,
     *  uppercase, letter-spaced label stacked above the control). Pass
     *  `caption = null` for caption-less fields (§2: the LFO Wave/Mode fields
     *  render only their dynamic glyph/segment — no visible caption). */
    private field(caption: string | null, control: HTMLElement, mod = ""): HTMLElement {
        const label = document.createElement("label");
        label.className = "mod-field" + mod.split(/\s+/).filter(Boolean).map((m) => ` mod-field--${m}`).join("");
        if (caption !== null) {
            const cap = document.createElement("span");
            cap.className = "mod-field-caption";
            cap.innerText = caption;
            label.appendChild(cap);
        }
        label.appendChild(control);
        return label;
    }

    /** Bug 1 — trues, dynamisches Waveform-Icon: eines von sechs eindeutigen
     *  Inline-SVG-Pfaden, ausgewählt anhand von src.waveform. Reiner
     *  Presenter — die Waveform-Auswahl und Persistenz bleiben unangetastet. */
    private waveformGlyph(waveform: Waveform): SVGSVGElement {
        const ns = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(ns, "svg");
        svg.classList.add("mod-wave-glyph");
        svg.setAttribute("viewBox", "0 0 16 10");
        svg.setAttribute("width", "16");
        svg.setAttribute("height", "10");
        svg.setAttribute("aria-hidden", "true");
        const path = document.createElementNS(ns, "path");
        path.setAttribute("d", WAVEFORM_PATHS[waveform]);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", "currentColor");
        path.setAttribute("stroke-width", "1.2");
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
        svg.appendChild(path);
        return svg;
    }

    private sectionTitle(text: string): HTMLElement {
        const title = document.createElement("div");
        title.className = "mod-section-title";
        title.innerText = text;
        return title;
    }

    /** FREE | SYNC segment toggle — replaces the old bare SYNC checkbox.
     *  Toggling only flips bpmSync; rateHz/noteDivision are kept as-is and no
     *  BPM<->Hz conversion happens (existing data semantics preserved).
     *  §2 — the field carries NO visible "Mode" caption anymore. */
    private renderModeToggle(src: ModSource): HTMLElement {
        const seg = document.createElement("div");
        seg.className = "mod-seg";
        seg.id = `mod-src-sync-${src.id}`;

        const freeBtn = document.createElement("button");
        freeBtn.type = "button";
        freeBtn.className = "mod-seg-btn" + (src.bpmSync ? "" : " active");
        freeBtn.setAttribute("aria-pressed", String(!src.bpmSync));
        freeBtn.innerText = "Free";
        freeBtn.onclick = () => this.setBpmSync(src, false);
        seg.appendChild(freeBtn);

        const syncBtn = document.createElement("button");
        syncBtn.type = "button";
        syncBtn.className = "mod-seg-btn" + (src.bpmSync ? " active" : "");
        syncBtn.setAttribute("aria-pressed", String(src.bpmSync));
        syncBtn.innerText = "Sync";
        syncBtn.onclick = () => this.setBpmSync(src, true);
        seg.appendChild(syncBtn);

        return this.field(null, seg);
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
            return this.field("Freq", division, "grow");
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
            updateFreqFill();
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
        const updateFreqFill = (): void => {
            const pct = ((Number(slider.value) - 0.01) / (20 - 0.01)) * 100;
            setSliderFill(slider, 0, pct);
        };
        updateFreqFill();
        // Live gesture for the FREE rate: write src.rateHz on every input so
        // the LFO speed reacts in real time; ONE undo step on release.
        let rateGestureFlushed = false;
        const commitRate = (): void => {
            rateGestureFlushed = false;
            const v = Number(slider.value);
            rate.value = String(v);
            updateFreqFill();
            const device = this.deviceLibrary.currentDevice;
            if (device) this.liveEdit(device, () => { src.rateHz = v; });
        };
        const finishRateGesture = (): void => {
            this.flushMatrixSave();
            this.commitLiveEdit();
            rateGestureFlushed = true;
        };
        slider.addEventListener("input", commitRate);
        slider.addEventListener("change", () => {
            if (!rateGestureFlushed) commitRate();
            finishRateGesture();
        });
        slider.addEventListener("pointerup", finishRateGesture);
        slider.addEventListener("pointercancel", finishRateGesture);

        const wrap = document.createElement("div");
        wrap.className = "mod-rate";
        wrap.appendChild(rate);
        const unit = document.createElement("span");
        unit.className = "mod-rate-unit";
        unit.innerText = "Hz";
        wrap.appendChild(unit);
        wrap.appendChild(slider);
        return this.field("Freq", wrap, "grow");
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
        this.onMatrixChange?.();
        this.syncActiveMarking();
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
        this.onMatrixChange?.();
        this.syncActiveMarking();
    }

    /**
     * Live slider write (rate/depth): mutates on EVERY `input` so the engine
     * hears the change in real time (the runner reads device.modulation live
     * each frame). Persistence is queued/debounced because localStorage is
     * synchronous and serializes the whole device. No onMatrixChange here —
     * rate/depth never alter WHICH destination is modulated, and the surface's
     * live arc is driven by the runner itself. The undo snapshot stays deferred
     * to a single commitLiveEdit() on gesture end.
     */
    private liveEdit(device: Device, mutate: () => void): void {
        if (!this.liveGesture) {
            this.liveGesture = { device, before: this.history.captureDeviceState(device) };
        }
        mutate();
        this.scheduleMatrixSave(device);
    }

    /** End of a slider gesture: ONE history action for the whole drag. */
    private commitLiveEdit(): void {
        const g = this.liveGesture;
        if (!g) return;
        this.liveGesture = undefined;
        const after = this.history.captureDeviceState(g.device);
        this.history.recordDeviceAction("matrix.edit", g.device, g.before, after);
    }

    private scheduleMatrixSave(device: Device): void {
        if (this.pendingMatrixSaveDevice && this.pendingMatrixSaveDevice.id !== device.id) {
            this.flushMatrixSave();
        }
        this.pendingMatrixSaveDevice = device;
        if (this.matrixSaveTimer !== undefined) {
            clearTimeout(this.matrixSaveTimer);
        }
        this.matrixSaveTimer = setTimeout(() => this.flushMatrixSave(), MATRIX_SAVE_DEBOUNCE_MS);
    }

    public flushMatrixSave(): void {
        if (this.matrixSaveTimer !== undefined) {
            clearTimeout(this.matrixSaveTimer);
            this.matrixSaveTimer = undefined;
        }
        const pending = this.pendingMatrixSaveDevice;
        if (!pending) return;
        this.pendingMatrixSaveDevice = undefined;
        this.persist(pending);
    }

    /**
     * Bug 5 — active-source marking must follow a routing edit IMMEDIATELY,
     * without a full re-render (which would steal focus from the edited
     * control): recompute each source row's on/off + the cross-column
     * highlight from the CURRENT matrix state.
     */
    private syncActiveMarking(): void {
        const device = this.deviceLibrary.currentDevice;
        if (!device || !this.container) return;
        device.modulation.sources.forEach((src) => {
            const row = this.container?.querySelector<HTMLElement>(`.mod-source-row[data-source-id="${escapeCssId(src.id)}"]`);
            if (!row) return;
            const referenced = device.modulation.slots.some((s) => s.enabled && s.sourceId === src.id);
            row.classList.toggle("on", referenced);
            row.classList.toggle("off", !referenced);
        });
        this.highlightCrossColumn();
    }

    /** Bug 3 — persistiert wird IMMER das zugewiesene device, nie currentDevice.
     *  Der alte Guard (activeId !== device.id → return) verwarf genau den
     *  gemerkten pendingMatrixSaveDevice, sobald zwischen schedule und flush
     *  currentDevice umgeschaltet war — die Matrix-Edits des VORHERIGEN Geräts
     *  gingen verloren. saveDevice() (ohne Last-Active-Fußabdruck) trifft den
     *  richtigen Storage-Slot. */
    private persist(device: Device): void {
        this.deviceLibrary.saveDevice(device);
    }
}
