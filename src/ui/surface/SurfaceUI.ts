import { DeviceLibrary } from "../../core/DeviceLibrary";
import { NexusAdapter } from "../../nexus/NexusAdapter";
import { MidiAccess } from "../../midi/MidiAccess";
import { MidiMapping } from "../../midi/MidiMapping";
import { BindingManager } from "../../core/BindingManager";
import { NexusLearnFlow } from "../../nexus/NexusLearnFlow";
import { MidiLearn, MidiLearnTimeoutError } from "../../midi/MidiLearn";
import { Toast } from "../Toast";
import { computeControlLayout } from "../geometry";
import { isModulated } from "../../core/modulation/ModulationMatrix";
import { WRITE_REFUSED_CLASS, WRITE_REFUSED_TITLE } from "../writeRefusal";
import type { MidiBindingDefinition } from "../../core/model/types";

/** F10 — vector knob ring geometry: the arc is drawn on a circular SVG path
 *  (r42, viewBox 100). Total path length C = 2πr; the visible arc is 270° of
 *  the circle (= 0.75·C). dashoffset = ARC_END·(1 − value) → value/1 fills
 *  the base value's arc (replaces the sub-pixel-aliased conic-gradient band). */
const KNOB_RADIUS = 42;
const KNOB_ARC_END = 0.75 * 2 * Math.PI * KNOB_RADIUS;

export { KNOB_RADIUS, KNOB_ARC_END };

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
    /** B7 — der zuletzt gemountete Elter (render-Kontrakt), NICHT der fragil
     *  nachgeführte container.parentElement — ein abgehängter Container hätte
     *  null und reRender() würde blind auf ein toten Knoten rendern. */
    private mountParent: HTMLElement | null = null;
    /** B8 — laufender Knob-Drag (ControlId). reRender() zerstört den Knoten
     *  samt Listenern mitten in der Geste, dann kämen pointerup/pointercancel
     *  nie mehr an und das Modulations-Takeover bliebe dauerhaft hängen. */
    private gestureControlId: string | null = null;
    private nexusLearnFlow: NexusLearnFlow | null = null;
    private midiLearn: MidiLearn;
    private midiHandler: (channel: number, cc: number, value: number) => void;
    private selectedControlId: string | null = null;
    private isWriteRefused?: (controlId: string) => boolean;
    private onGestureTakeover?: (controlId: string, active: boolean) => void;

    /** Phase 2 — rendered element cache (FIX 10): every control's live DOM
     *  refs, rebuilt on each render, so per-tick value updates never query the
     *  container again. */
    private ctlElements = new Map<string, { svgValue: SVGCircleElement | null; pos: HTMLElement | null; sw: HTMLElement | null; modRing: HTMLElement | null }>();

    constructor(
        deviceLibrary: DeviceLibrary,
        nexusAdapter: NexusAdapter,
        midiAccess: MidiAccess,
        bindingManager: BindingManager,
        midiMapping: MidiMapping,
        onLocalChange: (controlId: string, value: number) => void,
        midiHandler: (channel: number, cc: number, value: number) => void,
        isWriteRefused?: (controlId: string) => boolean,
        onGestureTakeover?: (controlId: string, active: boolean) => void
    ) {
        this.deviceLibrary = deviceLibrary;
        this.nexusAdapter = nexusAdapter;
        this.midiAccess = midiAccess;
        this.bindingManager = bindingManager;
        this.midiMapping = midiMapping;
        this.onLocalChange = onLocalChange;
        this.midiHandler = midiHandler;
        this.isWriteRefused = isWriteRefused;
        this.onGestureTakeover = onGestureTakeover;
        this.midiLearn = new MidiLearn(this.midiAccess);
        // Nexus Learn: the same shared flow EditorUI uses (P3.2) — one copy of
        // the learn steps. The flow reads the live document via getter.
        this.nexusLearnFlow = new NexusLearnFlow({
            getDocument: () => this.nexusAdapter.document,
            subscribeBoundControl: (controlId) => this.nexusAdapter.subscribeBoundControl(controlId),
            applyLearnResult: (controlId, result) => this.bindingManager.applyLearnResult(controlId, result),
            saveCurrentDevice: () => this.deviceLibrary.saveCurrentDevice(),
            reflectValue: (controlId, normalized) => this.onLocalChange(controlId, normalized),
            onStateChanged: () => this.reRender(),
        });
    }

    public render(parent: HTMLElement) {
        // Phase 2 (FIX 10) — start each render with a clean element cache: the
        // container is rebuilt below, so stale refs to the previous DOM must
        // not survive (renderControl repopulates it during this render).
        this.ctlElements.clear();
        this.container = document.createElement("div");
        // The USE surface is a performance UI, not the EDIT layout canvas: it
        // must never show the snap grid, regardless of the EDIT-side Snap state.
        this.container.className = "editor-canvas editor-canvas--nogrid";

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

        // B7 — Mount-Parent explizit merken; reRender() prüft gegen genau
        // diesen Knoten (nicht gegen container.parentElement).
        this.mountParent = parent;
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
        const refs = this.ctlElements.get(controlId);
        if (!refs) return;
        if (refs.svgValue) {
            // F10 — vector arc: dashoffset = ARC_END·(1−v) → the visible arc
            // is exactly `value * 270°` (round caps, no sub-pixel aliasing).
            refs.svgValue.setAttribute("stroke-dashoffset", String((1 - value) * KNOB_ARC_END));
        }
        if (refs.modRing) {
            refs.modRing.dataset.baseValue = String(value);
            const modRel = this.modLiveEnd.get(controlId);
            if (modRel !== undefined && !refs.modRing.classList.contains("idle")) {
                const baseRel = value * 270;
                refs.modRing.style.setProperty("--knob-mod-start", `${Math.min(baseRel, modRel)}deg`);
                refs.modRing.style.setProperty("--knob-mod-end", `${Math.max(baseRel, modRel)}deg`);
            }
        }
        if (refs.pos) {
            refs.pos.style.transform = `rotate(${-135 + (value * 270)}deg)`;
        }
        if (refs.sw) {
            refs.sw.classList.toggle("on", value > 0.5);
        }
    }

    /** Phase 2 — last live relative mod-angle (modulated * 270) per control
     *  (for base updates). Kept in the same relative space as the CSS stops. */
    private modLiveEnd = new Map<string, number>();

    /** Phase 2 — Mod-Anzeige: zeichnet den Amber-Modulationsbogen auf dem
     *  Ring von der Basis (control.value) bis zum modulierten Wert. Ohne
     *  control.value anzutasten (Base bleibt Base). null = Bogen aus.
     *  Die Stop-Winkel sind relativ zum CSS-Start `from -135deg` (Raum
     *  0..270, identisch zu --knob-arc-end) — kein zweiter -135°-Offset. */
    public applyModDisplay(controlId: string, modulated: number | null): void {
        const refs = this.ctlElements.get(controlId);
        if (!refs?.modRing) return;
        if (modulated === null) {
            refs.modRing.classList.add("idle");
            this.modLiveEnd.delete(controlId);
            this.setModulatedClasses(refs.modRing, false);
            return;
        }
        refs.modRing.classList.remove("idle");
        const base = Number(refs.modRing.dataset.baseValue ?? 0);
        // RELATIVE Winkel (0..270): das CSS startet bereits via `from -135deg`
        // am Ringanfang — derselbe Raum wie --knob-arc-end.
        const baseRel = base * 270;
        const modRel = modulated * 270;
        this.modLiveEnd.set(controlId, modRel);
        refs.modRing.style.setProperty("--knob-mod-start", `${Math.min(baseRel, modRel)}deg`);
        refs.modRing.style.setProperty("--knob-mod-end", `${Math.max(baseRel, modRel)}deg`);
        this.setModulatedClasses(refs.modRing, true);
    }

    /** Koppelt die Amber-Zustandsklassen (Wrapper + Knob-Body) an die live
     *  Mod-Anzeige, statt sie nur beim Render zu setzen. */
    private setModulatedClasses(modRing: HTMLElement, on: boolean): void {
        const wrapper = modRing.closest(".control-wrapper");
        if (wrapper) wrapper.classList.toggle("modulated", on);
        if (modRing.parentElement) modRing.parentElement.classList.toggle("modulated", on);
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

        // Group Header — mirrors the EDIT renderer so the group name lives
        // INSIDE the Group Box and stays visible in USE mode. No floating
        // label above the box, no delete button on the performance surface.
        const groupHeader = document.createElement("div");
        groupHeader.className = "group-header";
        const groupNameSpan = document.createElement("span");
        groupNameSpan.className = "group-name";
        groupNameSpan.textContent = group.name;
        // The name is ALWAYS light in USE mode: the Metatron surface is dark,
        // so a contrast-derived color (e.g. near-black for light groups) would
        // be unreadable. The group color never overrides the name color.
        groupNameSpan.style.color = "#fff";
        groupHeader.appendChild(groupNameSpan);
        el.appendChild(groupHeader);

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

        if (this.isWriteRefused?.(control.id)) {
            el.classList.add(WRITE_REFUSED_CLASS);
            el.title = WRITE_REFUSED_TITLE;
        }

        // Rectangular visual area holding the widget
        const visualArea = document.createElement("div");
        visualArea.className = "control-visual-area";
        if (control.visualDefinition?.color) {
            visualArea.style.background = control.visualDefinition.color;
        }

        if (control.type === "knob") {
            const device = this.deviceLibrary.currentDevice;
            const modulated = !!device && isModulated(device.modulation, control.id);
            if (modulated) el.classList.add("modulated");
            const body = document.createElement("div");
            body.className = "knob-body" + (modulated ? " modulated" : "");

            const socket = document.createElement("div");
            socket.className = "knob-socket";
            body.appendChild(socket);

            // F10 — vector indicator arc: SVG circles with stroke-dashoffset
            // instead of the old conic-gradient + radial-mask band (which
            // aliased at 1x zoom). Arc start −135° via CSS rotate on the svg.
            const svgNS = "http://www.w3.org/2000/svg";
            const svg = document.createElementNS(svgNS, "svg");
            svg.setAttribute("viewBox", "0 0 100 100");
            svg.classList.add("knob-svg-ring");

            const track = document.createElementNS(svgNS, "circle");
            track.classList.add("knob-svg-track");
            track.setAttribute("cx", "50");
            track.setAttribute("cy", "50");
            track.setAttribute("r", String(KNOB_RADIUS));
            const circumference = 2 * Math.PI * KNOB_RADIUS;
            // G2 — Track endet bei 270° wie der Wertbogen (EDIT-Maske hat
            // ebenfalls `transparent 270deg`): kein Vollkreis durch die Lücke.
            track.setAttribute("stroke-dasharray", `${KNOB_ARC_END} ${circumference}`);

            const valueArc = document.createElementNS(svgNS, "circle");
            valueArc.classList.add("knob-svg-value");
            valueArc.setAttribute("cx", "50");
            valueArc.setAttribute("cy", "50");
            valueArc.setAttribute("r", String(KNOB_RADIUS));
            valueArc.setAttribute("stroke-dasharray", `${KNOB_ARC_END} ${circumference}`);
            valueArc.setAttribute("stroke-dashoffset", String((1 - control.value) * KNOB_ARC_END));

            svg.append(track, valueArc);
            body.appendChild(svg);

            // Phase 2 — dynamic amber arc: base value → modulated value on the
            // ring band. Toggled by applyModDisplay; `.idle` hides it.
            const modRing = document.createElement("div");
            modRing.className = "knob-mod-ring idle";
            modRing.dataset.baseValue = String(control.value);
            body.appendChild(modRing);

            const cap = document.createElement("div");
            cap.className = "knob-cap";
            const rib = document.createElement("div");
            rib.className = "knob-rib";
            const top = document.createElement("div");
            top.className = "knob-top";
            cap.append(rib, top);
            body.appendChild(cap);

            const position = document.createElement("div");
            position.className = "knob-position";
            position.style.transform = `rotate(${-135 + (control.value * 270)}deg)`;
            body.appendChild(position);

            visualArea.appendChild(body);

            this.attachKnobDrag(body, control);
        } else {
            const body = document.createElement("div");
            body.className = "switch-body" + (control.value > 0.5 ? " on" : "");
            const track = document.createElement("div");
            track.className = "switch-track";
            body.appendChild(track);
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
                    ? "DISCONNECTED — select this control, then Learn to reconnect."
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
        learnBtn.title = "Learn this control from Audiotool";
        learnBtn.onclick = (e) => { e.stopPropagation(); this.startNexusLearn(control); };
        actions.appendChild(learnBtn);

        const midiBtn = document.createElement("button");
        midiBtn.className = "mini-btn";
        midiBtn.innerText = "MIDI";
        midiBtn.title = "MIDI-learn: move a hardware CC";
        midiBtn.onclick = (e) => { e.stopPropagation(); this.startMidiLearn(control); };
        actions.appendChild(midiBtn);

        // ── C2 Step 5: MIDI mapping readout, Unmap + scaling editor (§7) ──
        // The UI only reads/edits the stored definition; all value math stays
        // exclusively in applyMidiScaling. State comes straight from the
        // selected Control / getMappingForControl — no extra map, no store.
        const mapping = this.midiMapping.getMappingForControl(control.id);

        const midiBar = document.createElement("div");
        midiBar.className = "use-midi-map";
        midiBar.style.cssText = "display:flex;align-items:center;gap:6px;";

        const readout = document.createElement("span");
        readout.className = "use-midi-readout";
        readout.style.fontSize = "10px";
        if (mapping) {
            readout.innerText = `Ch ${mapping.channel} / CC ${mapping.cc}`;
            readout.title = `MIDI mapping${this.scalingSummary(mapping)}`;
            readout.style.color = "var(--text-primary)";
        } else {
            readout.innerText = "Unmapped";
            readout.title = "No MIDI mapping — move a hardware CC to learn";
            readout.style.color = "var(--text-secondary)";
        }
        midiBar.appendChild(readout);

        if (mapping) {
            const unmapBtn = document.createElement("button");
            unmapBtn.className = "mini-btn";
            unmapBtn.innerText = "Unmap";
            unmapBtn.title = "Remove the MIDI mapping (channel/CC + scaling) for this control.";
            unmapBtn.onclick = (e) => {
                e.stopPropagation();
                this.midiMapping.clearMapping(control.id);
                this.deviceLibrary.saveCurrentDevice();
                this.reRender();
            };
            midiBar.appendChild(unmapBtn);
        }
        actions.appendChild(midiBar);

        // F-5: the scaling editor only appears for a COMPLETE, valid mapping
        // (channel AND cc present) — an incomplete definition like `{min: 0.5}`
        // still reads "Unmapped" and offers no scaling controls.
        if (mapping) {
            actions.appendChild(this.buildScalingEditor(control, mapping));
        }

        el.appendChild(actions);

        // Clicking anywhere on the control selects it (no re-render needed;
        // the .selected class controls the action-bar visibility via CSS).
        el.addEventListener("mousedown", () => this.setSelectedControl(control.id));

        this.container.appendChild(el);
        this.applyControlLayout(el, control);

        // Phase 2 (FIX 10) — cache this control's live element refs once, so
        // the 60Hz tick and per-event updates never query the container again.
        this.ctlElements.set(control.id, {
            svgValue: el.querySelector(".knob-svg-value"),
            pos: el.querySelector(".knob-position"),
            sw: el.querySelector(".switch-body"),
            modRing: el.querySelector(".knob-mod-ring"),
        });
    }

    /** Compact scaling summary for the readout tooltip (display only). */
    private scalingSummary(definition: MidiBindingDefinition): string {
        const parts: string[] = [];
        if (definition.min !== undefined) parts.push(`min ${definition.min}`);
        if (definition.max !== undefined) parts.push(`max ${definition.max}`);
        if (definition.flip === true) parts.push("flip");
        if (definition.exponent !== undefined) parts.push(`exp ${definition.exponent}`);
        return parts.length ? ` · ${parts.join(" · ")}` : "";
    }

    /**
     * C2 §9 scaling editor — edits ONLY the stored MidiBindingDefinition.
     * min/max are clamped into 0..1, exponent must stay > 0; invalid input is
     * reverted and never persisted. The authoritative math stays solely in
     * applyMidiScaling — this UI never computes MIDI values itself.
     */
    private buildScalingEditor(control: any, definition: MidiBindingDefinition): HTMLElement {
        const editor = document.createElement("div");
        editor.className = "use-midi-scaling";
        editor.style.cssText =
            "display:flex;align-items:center;gap:6px;margin-left:6px;padding-left:6px;" +
            "border-left:1px solid var(--border-color);flex-wrap:wrap;";

        const commit = () => {
            this.deviceLibrary.saveCurrentDevice();
            this.reRender();
        };
        const apply = (patch: Partial<MidiBindingDefinition>) => {
            control.midiBindingDefinition = { ...definition, ...patch };
            commit();
        };

        const numberField = (label: string, field: "min" | "max" | "exponent") => {
            const wrap = document.createElement("label");
            wrap.className = "use-scaling-field";
            wrap.style.cssText =
                "display:inline-flex;align-items:center;gap:3px;font-size:10px;" +
                "color:var(--text-secondary);";
            wrap.innerText = label;

            const input = document.createElement("input");
            input.type = "number";
            input.id = `scaling-${field}-${control.id}`;
            input.name = `scaling_${field}`;
            input.step = "any";
            input.dataset.scaling = field;
            input.value = definition[field] !== undefined ? String(definition[field]) : "";
            input.title = field === "exponent" ? "exponent (> 0)" : `${field} (0..1)`;
            input.style.cssText =
                "width:44px;font-size:10px;padding:2px 4px;background:rgba(0,0,0,0.2);" +
                "color:#fff;border:1px solid var(--border-color);border-radius:4px;outline:none;";
            input.onclick = (e) => e.stopPropagation();
            input.onchange = () => {
                const entered = String(input.value).trim();
                const parsed = entered === "" ? NaN : Number(entered);
                if (Number.isNaN(parsed)) { this.reRender(); return; } // revert + reset the visible field
                if (field === "exponent") {
                    if (parsed <= 0) { this.reRender(); return; } // revert + reset the visible field
                    apply({ exponent: parsed });
                } else if (field === "min") {
                    apply({ min: Math.min(1, Math.max(0, parsed)) });
                } else {
                    apply({ max: Math.min(1, Math.max(0, parsed)) });
                }
            };
            wrap.appendChild(input);
            return wrap;
        };

        editor.appendChild(numberField("min", "min"));
        editor.appendChild(numberField("max", "max"));

        const flipWrap = document.createElement("label");
        flipWrap.className = "use-scaling-field";
        flipWrap.style.cssText =
            "display:inline-flex;align-items:center;gap:3px;font-size:10px;" +
            "color:var(--text-secondary);";
        flipWrap.innerText = "flip";
        const flipInput = document.createElement("input");
        flipInput.type = "checkbox";
        flipInput.id = `scaling-flip-${control.id}`;
        flipInput.dataset.scaling = "flip";
        flipInput.checked = definition.flip === true;
        flipInput.onclick = (e) => e.stopPropagation();
        flipInput.onchange = () => apply({ flip: flipInput.checked });
        flipWrap.appendChild(flipInput);
        editor.appendChild(flipWrap);

        editor.appendChild(numberField("exp", "exponent"));

        return editor;
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
            const pos = el.querySelector<HTMLElement>(".knob-position");
            if (pos) {
                pos.style.inset = "0";
                pos.style.transformOrigin = "50% 50%";
            }
        } else {
            widget.style.borderRadius = "6px";
            const toggle = el.querySelector<HTMLElement>(".switch-toggle");
            if (toggle) {
                const travel = Math.max(8, Math.round(layout.widgetHeight * 0.66));
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
            this.gestureControlId = control.id;
            body.setPointerCapture(e.pointerId);
            // Phase 2 — the user's hand owns this control while the drag is
            // live: the runner suspends its modulation writes/captures.
            this.onGestureTakeover?.(control.id, true);
        });
        body.addEventListener("pointermove", (e) => {
            if (!dragging) return;
            const delta = (startY - e.clientY) / 200;
            const value = Math.min(1, Math.max(0, startValue + delta));
            this.onLocalChange(control.id, value);
            this.updateControlElement(control.id, value);
        });
        const endGesture = () => {
            if (!dragging) return;
            dragging = false;
            this.gestureControlId = null;
            // Phase 2 — a cancelled pointer must not leave a stuck takeover:
            // pointerup AND pointercancel both release it.
            this.onGestureTakeover?.(control.id, false);
        };
        body.addEventListener("pointerup", endGesture);
        body.addEventListener("pointercancel", endGesture);
        // B8 — the pointer-capture-loss path neither pointerup nor
        // pointercancel covers (element removed mid-gesture, browser forcing a
        // reclaim, window blur): the gesture can no longer continue, so the
        // takeover is released here too instead of being stuck.
        body.addEventListener("lostpointercapture", endGesture);
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
            const mapped = this.midiMapping.setMapping(control.id, result.channel, result.cc);
            if (mapped.collision) {
                const displaced = this.deviceLibrary.currentDevice?.getControl(mapped.displacedControlId);
                Toast.show(
                    `Warnung: CC ${result.cc} (ch ${result.channel}) war bereits an "${displaced?.name ?? mapped.displacedControlId}" vergeben — die Zuordnung wurde dort entfernt.`,
                    "warning",
                );
            }
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

    // ---- Nexus Learn (§23/§24) — shared flow, see NexusLearnFlow (P3.2) ----
    private get nexusLearnActive(): boolean {
        return this.nexusLearnFlow?.isActive ?? false;
    }

    private async startNexusLearn(control: any) {
        if (!this.nexusLearnFlow) return;
        await this.nexusLearnFlow.learn(control);
    }

    private cancelNexusLearn() {
        this.nexusLearnFlow?.cancel();
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
        // B8 — jeder Rebuild mitten in einem Knob-Drag beendet die Geste:
        // deren Knoten (samt pointer-Listenern) wird gleich ersetzt, ein
        // pointerup/pointercancel/lostpointercapture käme nie mehr an — das
        // Modulations-Takeover bliebe hängen. Immer erst freigeben (auch bei
        // abgehängtem Subtree), dann evtl. neu rendern.
        if (this.gestureControlId !== null) {
            this.onGestureTakeover?.(this.gestureControlId, false);
            this.gestureControlId = null;
        }
        // B7 — NUR rendern, solange die Fläche im live-Dokument hängt. Nach
        // Mode-/Device-Wechsel wurde der alte mountParent vom AppUI-Rebuild
        // verworfen (document.contains=false); ein blindes Re-Render würde auf
        // den abgehängten Subtree zugreifen und Legende/Oberfläche verfälschen.
        if (!this.mountParent || !document.contains(this.mountParent)) return;
        this.render(this.mountParent);
    }

    /** B7 — laufende Lernvorgänge (MIDI + Nexus) abbrechen und Overlays
     *  räumen (Mode-/View-Wechsel): weder die Learn-Bar noch die prüfende
     *  Promise sollen eine andere Ansicht anleuchten oder hängenbleiben.
     *  NexusLearnFlow.cancel() re-rendert selbst; die MIDI-Seite räumt vorher
     *  ihre Lern-Bar. */
    public cancelPendingLearns(): void {
        if (this.midiLearn.isActive()) {
            this.midiLearn.cancelLearn(); // fail() → reject + reset (Handler-Identität bleibt)
            this.reRender();
        }
        this.nexusLearnFlow?.cancel();
    }
}