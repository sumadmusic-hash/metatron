import { DeviceLibrary } from "../../core/DeviceLibrary";
import { NexusAdapter } from "../../nexus/NexusAdapter";
import { MidiAccess } from "../../midi/MidiAccess";
import { MidiMapping } from "../../midi/MidiMapping";
import { BindingManager } from "../../core/BindingManager";
import { NexusLearn, LearnTimeoutError, LearnCancelledError } from "../../nexus/NexusLearn";
import { createNexusValueMapping, mapNexusToNormalized } from "../../nexus/NexusValueMapping";
import { MidiLearn, MidiLearnTimeoutError } from "../../midi/MidiLearn";
import { Toast } from "../Toast";
import { computeControlLayout, contrastTextColor } from "../geometry";

/**
 * USE-mode control surface. Controls are interactive here:
 * - knobs: vertical drag; switches: click to toggle
 * - per-control Nexus Learn (§23/§24) and MIDI Learn (§25-27) via a selection
 *   action bar (kept out of the normal layout to reduce visual clutter)
 * - external Nexus changes update the surface in place
 */
export class SurfaceUI {
    private deviceLibrary: DeviceLibrary;
    private nexusAdapter: NexusAdapter;
    private midiAccess: MidiAccess;
    private bindingManager: BindingManager;
    private midiMapping: MidiMapping;
    private onLocalChange: (controlId: string, value: number) => void;

private container!: HTMLElement;
    private nexusLearn: NexusLearn | null = null;
    private midiLearn: MidiLearn;
    private midiHandler: (channel: number, cc: number, value: number) => void;
    private selectedControlId: string | null = null;

    constructor(
        deviceLibrary: DeviceLibrary,
        nexusAdapter: NexusAdapter,
        midiAccess: MidiAccess,
        bindingManager: BindingManager,
        midiMapping: MidiMapping,
        onLocalChange: (controlId: string, value: number) => void,
        midiHandler: (channel: number, cc: number, value: number) => void
    ) {
        this.deviceLibrary = deviceLibrary;
        this.nexusAdapter = nexusAdapter;
        this.midiAccess = midiAccess;
        this.bindingManager = bindingManager;
        this.midiMapping = midiMapping;
        this.onLocalChange = onLocalChange;
        this.midiHandler = midiHandler;
        this.midiLearn = new MidiLearn(this.midiAccess);
    }

    public render(parent: HTMLElement) {
        this.container = document.createElement("div");
        this.container.className = "editor-canvas";

        // Deselect when clicking the empty canvas (mirrors EDIT-mode behavior)
        this.container.addEventListener("mousedown", (e) => {
            if (e.target === this.container) {
                this.setSelectedControl(null);
            }
        });

        const device = this.deviceLibrary.currentDevice;
        if (!device) {
            const empty = document.createElement("div");
            empty.style.cssText = "padding:20px;color:var(--text-secondary);";
            empty.innerText = "No device loaded. Open the Device Library to create/open one.";
            this.container.appendChild(empty);
        } else {
            // Groups are part of the finished performance surface: render them
            // FIRST so they sit behind their member Controls (§ Group layering).
            device.groups.forEach(group => this.renderGroup(group));
            device.controls.forEach(control => {
                if (!control.archived) {
                    this.renderControl(control);
                }
            });
        }

        // Learn status overlays live on the surface
        if (this.nexusLearnActive) {
            this.container.appendChild(this.buildNexusLearningBar());
        }
        if (this.midiLearnActive) {
            this.container.appendChild(this.buildMidiLearningBar());
        }

        parent.innerHTML = "";
        parent.appendChild(this.container);
    }

    /** Applies an external (Nexus) value to a control without looping it back. */
    public applyNexusValue(controlId: string, value: number) {
        const device = this.deviceLibrary.currentDevice;
        const control = device?.getControl(controlId);
        if (!control || control.archived) return;
        control.value = value;
        this.updateControlElement(controlId, value);
    }

    private updateControlElement(controlId: string, value: number) {
        const el = this.container.querySelector(`[data-ctl-id="${controlId}"]`) as HTMLElement | null;
        if (!el) return;

        const knob = el.querySelector(".knob-indicator") as HTMLElement | null;
        if (knob) {
            const rotation = -135 + (value * 270);
            knob.style.transform = `rotate(${rotation}deg)`;
        }
        const sw = el.querySelector(".switch-body") as HTMLElement | null;
        if (sw) {
            sw.classList.toggle("on", value > 0.5);
        }
    }

    /**
     * USE-mode Group: a finished visual container that keeps its identity on
     * the performance surface (boundary, name, color) but carries NONE of the
     * editor affordances — no resize handle, no dashed selection border, no
     * color picker, no drag/rename. It is pure decoration and therefore never
     * intercepts pointer events intended for member Controls.
     */
    private renderGroup(group: any) {
        const el = document.createElement("div");
        el.className = "group-box use-group";
        el.dataset.grpId = group.id;
        el.style.left = `${group.position.x}px`;
        el.style.top = `${group.position.y}px`;
        el.style.width = `${group.size.width}px`;
        el.style.height = `${group.size.height}px`;

        // The group must never block knob drags / switch clicks / selection.
        // Set inline (not only via stylesheet) so it is guaranteed regardless
        // of CSS loading.
        el.style.pointerEvents = "none";

        const fill = document.createElement("div");
        fill.style.cssText = "position:absolute;inset:0;border-radius:inherit;pointer-events:none;";
        fill.style.background = this.hexToRgba(group.color, 0.12);
        el.appendChild(fill);

        const label = document.createElement("div");
        label.className = "group-label";
        label.style.background = group.color;
        label.style.color = contrastTextColor(group.color);
        label.innerText = group.name;
        el.appendChild(label);

        this.container.appendChild(el);
    }

    private hexToRgba(hex: string, alpha: number): string {
        const h = hex.replace("#", "");
        const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
        const n = parseInt(full, 16);
        if (Number.isNaN(n)) return `rgba(51,51,51,${alpha})`;
        return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
    }

    private renderControl(control: any) {
        const el = document.createElement("div");
        el.className = "control-wrapper use-mode" + (this.selectedControlId === control.id ? " selected" : "");
        el.dataset.ctlId = control.id;

        // Rectangular visual area holding the widget
        const visualArea = document.createElement("div");
        visualArea.className = "control-visual-area";
        if (control.visualDefinition?.color) {
            visualArea.style.background = control.visualDefinition.color;
        }

        if (control.type === "knob") {
            const body = document.createElement("div");
            body.className = "knob-body";

            const indicator = document.createElement("div");
            indicator.className = "knob-indicator";

            if (control.visualDefinition?.color) {
                indicator.style.background = control.visualDefinition.color;
                indicator.style.boxShadow = `0 0 8px ${control.visualDefinition.color}`;
            }

            const rotation = -135 + (control.value * 270);
            indicator.style.transform = `rotate(${rotation}deg)`;
            body.appendChild(indicator);
            visualArea.appendChild(body);

            this.attachKnobDrag(body, control);
        } else {
            const body = document.createElement("div");
            body.className = "switch-body" + (control.value > 0.5 ? " on" : "");
            const toggle = document.createElement("div");
            toggle.className = "switch-toggle";
            body.appendChild(toggle);
            visualArea.appendChild(body);
            this.attachSwitchClick(body, control);
        }
        el.appendChild(visualArea);

        // Label area: readable name + subtle binding status only
        const labelArea = document.createElement("div");
        labelArea.className = "control-label-area";

        const name = document.createElement("span");
        name.className = "control-name";
        name.innerText = control.name;
        name.title = control.name;
        labelArea.appendChild(name);

        const statusDot = document.createElement("span");
        statusDot.className = "status-dot";
        const state = control.activeBindingState ?? "UNCONFIGURED";
        statusDot.classList.add(
            state === "CONNECTED" ? "connected" : state === "DISCONNECTED" ? "disconnected" : "unconfigured"
        );
        const target = control.audiotoolBindingDefinition?.targetName;
        statusDot.title =
            state === "CONNECTED"
                ? `CONNECTED → ${target ?? "unknown target"}`
                : state === "DISCONNECTED"
                    ? "DISCONNECTED — select this control, then Learn to reconnect (§39)."
                    : "UNCONFIGURED — select this control to open Learn/MIDI actions.";
        labelArea.appendChild(statusDot);
        el.appendChild(labelArea);

        // Selection action bar: Learn/MIDI only appear for the selected control,
        // keeping the performance surface clean.
        const actions = document.createElement("div");
        actions.className = "use-actions";

        const learnBtn = document.createElement("button");
        learnBtn.className = "mini-btn";
        learnBtn.innerText = "Learn";
        learnBtn.title = "Learn this control from Audiotool (§23)";
        learnBtn.onclick = (e) => { e.stopPropagation(); this.startNexusLearn(control); };
        actions.appendChild(learnBtn);

        const midiBtn = document.createElement("button");
        midiBtn.className = "mini-btn";
        midiBtn.innerText = "MIDI";
        midiBtn.title = "MIDI-learn: move a hardware CC (§25)";
        midiBtn.onclick = (e) => { e.stopPropagation(); this.startMidiLearn(control); };
        actions.appendChild(midiBtn);

        el.appendChild(actions);

        // Clicking anywhere on the control selects it (no re-render needed;
        // the .selected class controls the action-bar visibility via CSS).
        el.addEventListener("mousedown", () => this.setSelectedControl(control.id));

        this.container.appendChild(el);
        this.applyControlLayout(el, control);
    }

    /** Sync the rendered element to the Control's stored geometry. */
    private applyControlLayout(el: HTMLElement, control: any) {
        el.style.left = `${control.position.x}px`;
        el.style.top = `${control.position.y}px`;
        el.style.width = `${control.size.width}px`;
        el.style.height = `${control.size.height}px`;

        const layout = computeControlLayout(control.size, control.type);
        const widget = el.querySelector<HTMLElement>(".knob-body, .switch-body");
        if (!widget) return;

        widget.style.width = `${layout.widgetWidth}px`;
        widget.style.height = `${layout.widgetHeight}px`;

        if (control.type === "knob") {
            widget.style.borderRadius = "50%";
            const indicator = el.querySelector<HTMLElement>(".knob-indicator");
            if (indicator) {
                indicator.style.top = `${layout.widgetWidth * 0.08}px`;
                indicator.style.transformOrigin = `50% ${layout.widgetWidth / 2}px`;
            }
        } else {
            widget.style.borderRadius = `${layout.widgetWidth / 2}px`;
            const toggle = el.querySelector<HTMLElement>(".switch-toggle");
            if (toggle) {
                const toggleSize = Math.max(14, layout.widgetWidth - 4);
                toggle.style.width = `${toggleSize}px`;
                toggle.style.height = `${toggleSize}px`;
                toggle.style.left = `${(layout.widgetWidth - toggleSize) / 2}px`;
                const travel = Math.max(0, layout.widgetHeight - toggleSize - 2);
                widget.style.setProperty("--toggle-travel", `${travel}px`);
            }
        }
    }

    /** Toggle selection on the surface without rebuilding the DOM. */
    private setSelectedControl(id: string | null) {
        if (this.selectedControlId === id) return;
        this.selectedControlId = id;
        this.container.querySelectorAll(".control-wrapper.selected").forEach((n) => n.classList.remove("selected"));
        if (id) {
            this.container.querySelector(`[data-ctl-id="${id}"]`)?.classList.add("selected");
        }
    }

    private attachKnobDrag(body: HTMLElement, control: any) {
        let dragging = false;
        let startY = 0;
        let startValue = 0;

        body.style.cursor = "ns-resize";
        body.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            dragging = true;
            startY = e.clientY;
            startValue = control.value;
            body.setPointerCapture(e.pointerId);
        });
        body.addEventListener("pointermove", (e) => {
            if (!dragging) return;
            const delta = (startY - e.clientY) / 200;
            const value = Math.min(1, Math.max(0, startValue + delta));
            this.onLocalChange(control.id, value);
            this.updateControlElement(control.id, value);
        });
        body.addEventListener("pointerup", () => { dragging = false; });
    }

    private attachSwitchClick(body: HTMLElement, control: any) {
        body.style.cursor = "pointer";
        body.addEventListener("click", () => {
            const next = control.value > 0.5 ? 0 : 1;
            this.onLocalChange(control.id, next);
            this.updateControlElement(control.id, next);
        });
    }

    // ---- MIDI Learn (§25-27) ----
    private get midiLearnActive(): boolean {
        return this.midiLearn.isActive();
    }

    private async startMidiLearn(control: any) {
        if (this.midiLearn.isActive()) { this.midiLearn.cancelLearn(); this.reRender(); return; }

        this.reRender();

        try {
            const result = await this.midiLearn.startLearn(this.midiHandler, { timeoutMs: 60000 });
            this.midiMapping.setMapping(control.id, result.channel, result.cc);
            this.deviceLibrary.saveCurrentDevice();
            Toast.show(`Control "${control.name}" now reads CC ${result.cc} (ch ${result.channel}).`, "success");
        } catch (e) {
            if (e instanceof MidiLearnTimeoutError) {
                Toast.show("MIDI Learn timed out (60s). No CC was captured.", "error");
            } else {
                Toast.show("MIDI Learn cancelled.", "info");
            }
        }
        this.reRender();
    }

    // ---- Nexus Learn (§23/§24) ----
    private nexusLearnControlId: string | null = null;
    private get nexusLearnActive(): boolean {
        return this.nexusLearnControlId !== null;
    }

    private async startNexusLearn(control: any) {
        if (!this.nexusAdapter.document) {
            Toast.show("Connect to an Audiotool project first (§23).", "error");
            return;
        }
        if (this.nexusLearnControlId !== null) { this.cancelNexusLearn(); return; }

        this.nexusLearn = new NexusLearn(this.nexusAdapter.document);
        this.nexusLearnControlId = control.id;
        this.reRender();

        try {
            const result = await this.nexusLearn.startLearn({ timeoutMs: 60000 });
            if (this.nexusLearnControlId !== control.id) {
                // User switched target mid-learning; drop this result.
                this.nexusLearn = null;
                this.reRender();
                return;
            }
            this.nexusLearn = null;
            this.nexusLearnControlId = null;
            this.bindingManager.applyLearnResult(control.id, result);
            this.nexusAdapter.subscribeBoundControl(control.id);
            this.deviceLibrary.saveCurrentDevice();
            console.log(`[METATRON LEARN SUCCESS] controlId=${control.id} entityId=${result.entityId} fieldName=${result.fieldPath} value=${result.value}`);
            Toast.show(`Learned → ${result.targetName}`, "success");

            // Reflect the learned value immediately (normalized 0..1).
            const mapping = result.valueMapping ?? createNexusValueMapping(result.field);
            this.onLocalChange(control.id, mapNexusToNormalized(mapping, result.value));
        } catch (e) {
            this.nexusLearn = null;
            this.nexusLearnControlId = null;
            if (e instanceof LearnTimeoutError) {
                Toast.show("Learn timed out (60s). No change was captured.", "error");
            } else if (e instanceof LearnCancelledError) {
                Toast.show("Learn cancelled. No binding was created.", "info");
            } else {
                Toast.show(`Learn failed: ${e instanceof Error ? e.message : String(e)}`, "error");
            }
        }
        this.reRender();
    }

    private cancelNexusLearn() {
        this.nexusLearn?.cancelLearn();
        this.nexusLearn = null;
        this.nexusLearnControlId = null;
        this.reRender();
    }

    private buildNexusLearningBar(): HTMLElement {
        const bar = document.createElement("div");
        bar.className = "learn-bar";
        bar.style.background = "rgba(255,235,59,0.9)";
        bar.innerText = "LEARN ACTIVE — Do not play the Audiotool timeline. Move exactly one Audiotool parameter. The first detected change will be assigned. (click here to cancel)";
        bar.style.cursor = "pointer";
        bar.onclick = () => this.cancelNexusLearn();
        return bar;
    }

    private buildMidiLearningBar(): HTMLElement {
        const bar = document.createElement("div");
        bar.className = "learn-bar";
        bar.style.background = "rgba(0,229,255,0.9)";
        bar.innerText = "MIDI LEARNING — move a knob/slider on your hardware… (click to cancel)";
        bar.style.cursor = "pointer";
        bar.onclick = () => { this.midiLearn.cancelLearn(); this.reRender(); };
        return bar;
    }

    private reRender() {
        this.render(this.container.parentElement!);
    }
}