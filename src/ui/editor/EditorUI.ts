import { DeviceLibrary } from "../../core/DeviceLibrary";
import { Toast } from "../Toast";
import { Control } from "../../core/model/Control";
import { Group } from "../../core/model/Group";
import { NexusAdapter } from "../../nexus/NexusAdapter";
import { BindingManager } from "../../core/BindingManager";
import { MidiAccess } from "../../midi/MidiAccess";
import { MidiMapping } from "../../midi/MidiMapping";
import { NexusLearn, LearnTimeoutError, LearnCancelledError } from "../../nexus/NexusLearn";
import { createNexusValueMapping, mapNexusToNormalized } from "../../nexus/NexusValueMapping";
import { MidiLearn, MidiLearnTimeoutError } from "../../midi/MidiLearn";
import { computeControlLayout, CONTROL_MIN_SIZE, contrastTextColor } from "../geometry";
import { DeviceHistory } from "../../core/history/DeviceHistory";
import { patchesEqual } from "../../core/history/HistoryAction";
import type { DeviceStatePatch } from "../../core/history/HistoryAction";

const SNAP = 20;
const DRAG_THRESHOLD = 4;

/**
 * The single active drag gesture. At most ONE drag exists at any time: a new
 * gesture always terminates a previous one before starting. Selection and drag
 * are separate concerns — a drag only "activates" once the pointer crosses
 * DRAG_THRESHOLD, so a plain click only selects.
 */
interface DragInfo {
    type: "control-move" | "control-resize" | "group-move" | "group-resize";
    target: any;
    el: HTMLElement;
    pointerId: number;
    startPointerX: number;
    startPointerY: number;
    initialX: number;
    initialY: number;
    initialWidth: number;
    initialHeight: number;
    /** true once the pointer moved past the click/drag threshold. */
    active: boolean;
    /** true once a real drag started and the pointer is captured. Deferred
     * until activation so a mere pointerdown never retargets click/dblclick
     * (which would break double-click rename on labels). */
    captured: boolean;
    /** true once the model was modified during this gesture. */
    moved: boolean;

    /** Structural snapshot captured at gesture start; restored on Escape and
     *  compared against the end-state to commit exactly ONE history action. */
    before?: DeviceStatePatch;
    /** true when the gesture was aborted (Escape): the start state was
     *  restored and NO history action may be committed. */
    aborted?: boolean;
}

/**
 * EDIT mode (spec §18): construct the Device surface visually.
 *
 * Capabilities: create/select/move/resize/rename/delete controls, rectangular
 * control background colors, create/select/move/resize/rename/color groups,
 * group membership, and a snap toggle.
 */
export class EditorUI {
    private deviceLibrary: DeviceLibrary;
    private container!: HTMLElement;
    private snapEnabled: boolean = true;

    private selectedControlId: string | null = null;
    private selectedGroupId: string | null = null;

    /** Exactly one active drag gesture or null (see DragInfo). */
    private drag: DragInfo | null = null;

    // Optional live-binding plumbing for editor-side Learn/reconnect (§23/§24).
    private nexusAdapter?: NexusAdapter;
    private bindingManager?: BindingManager;
    private midiAccess?: MidiAccess;
    private midiMapping?: MidiMapping;
    private nexusLearn: NexusLearn | null = null;
    private nexusLearningId: string | null = null;
    private midiLearn: MidiLearn | null = null;
    private midiLearningId: string | null = null;
    private midiHandler?: (channel: number, cc: number, value: number) => void;

    // Session-scoped undo/redo (C1). Transient by design — never persisted.
    private history?: DeviceHistory;

    // Color-picker gesture coalescing: one sweep of the picker = ONE history
    // action (before captured on first input, action committed on change).
    private colorGestureKey: string | null = null;
    private colorGestureBefore: DeviceStatePatch | null = null;

    constructor(deviceLibrary: DeviceLibrary, nexusAdapter?: NexusAdapter, bindingManager?: BindingManager, midiAccess?: MidiAccess, midiMapping?: MidiMapping, midiHandler?: (channel: number, cc: number, value: number) => void, history?: DeviceHistory) {
        this.deviceLibrary = deviceLibrary;
        this.nexusAdapter = nexusAdapter;
        this.bindingManager = bindingManager;
        this.midiAccess = midiAccess;
        this.midiMapping = midiMapping;
        this.midiHandler = midiHandler;
        this.history = history;
        this.midiLearn = midiAccess ? new MidiLearn(midiAccess) : null;
    }

    public render(parent: HTMLElement) {
        this.container = document.createElement("div");
        this.container.className = this.snapEnabled ? "editor-canvas" : "editor-canvas editor-canvas--nogrid";

        // Overflow area big enough to contain the whole surface
        this.container.style.cssText += ";height:100%;width:100%;position:relative;overflow:auto;";

        const inner = document.createElement("div");
        inner.className = "editor-canvas-inner";
        inner.style.minWidth = "1600px";
        inner.style.minHeight = "1200px";

        // Deselect when clicking empty canvas space
        inner.addEventListener("mousedown", (e) => {
            if (e.target === inner) {
                this.selectedControlId = null;
                this.selectedGroupId = null;
                this.syncSelection();
            }
        });

        const device = this.deviceLibrary.currentDevice;
        if (device) {
            // Groups render underneath controls
            device.groups.forEach(group => this.renderGroup(group, inner));
            device.controls.forEach(control => {
                if (!control.archived) this.renderControl(control, inner);
            });

            // Toolbar (floating, non-blocking)
            inner.appendChild(this.buildToolbar());

            // Empty state hint
            if (device.getActiveControlCount() === 0 && device.groups.size === 0) {
                const hint = document.createElement("div");
                hint.style.cssText =
                    "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);" +
                    "color:var(--text-secondary);text-align:center;font-size:14px;pointer-events:none;";
                hint.innerHTML = "EMPTY DEVICE<br/>Add Knobs, Switches and Groups to build your control surface.";
                inner.appendChild(hint);
            }
        }

        this.container.appendChild(inner);
        parent.innerHTML = "";
        parent.appendChild(this.container);

        if (this.nexusLearningId !== null || this.midiLearningId !== null) {
            this.container.appendChild(this.buildLearningBar());
        }
    }

    private buildLearningBar(): HTMLElement {
        const bar = document.createElement("div");
        bar.className = "learn-bar";
        if (this.nexusLearningId !== null && this.midiLearningId === null) {
            bar.style.background = "rgba(255,235,59,0.9)";
            bar.innerText = "LEARN ACTIVE — Do not play the Audiotool timeline. Move exactly one Audiotool parameter. The first detected change will be assigned. (click to cancel)";
        } else if (this.midiLearningId !== null) {
            bar.style.background = "rgba(0,229,255,0.9)";
            bar.innerText = "MIDI LEARNING — move a knob/slider on your hardware… (click to cancel)";
        } else {
            bar.innerText = "LEARNING — adjust a parameter in Audiotool… (click to cancel)";
        }
        bar.style.cursor = "pointer";
        bar.onclick = () => {
            if (this.nexusLearningId !== null) { this.nexusLearn?.cancelLearn(); this.nexusLearningId = null; }
            if (this.midiLearningId !== null) { this.midiLearn?.cancelLearn(); this.midiLearningId = null; }
            this.render(this.container.parentElement!);
        };
        return bar;
    }

    private buildToolbar(): HTMLElement {
        const bar = document.createElement("div");
        bar.className = "editor-toolbar";

        bar.appendChild(this.button("+ Knob", () => this.addControl("knob")));
        bar.appendChild(this.button("+ Switch", () => this.addControl("switch")));
        bar.appendChild(this.button("+ Group", () => this.addGroup()));
        bar.appendChild(this.button(`Snap: ${this.snapEnabled ? "ON" : "OFF"}`, () => {
            this.snapEnabled = !this.snapEnabled;
            this.render(this.container.parentElement!);
        }, this.snapEnabled ? "active" : undefined));
        bar.appendChild(this.button("Delete Selected", () => this.deleteSelected()));

        return bar;
    }

    private button(label: string, onClick: () => void, className?: string): HTMLButtonElement {
        const btn = document.createElement("button");
        btn.className = className ? `btn small ${className}` : "btn small";
        btn.innerText = label;
        btn.onclick = () => onClick();
        return btn;
    }

    // ---------- creation ----------

    private addControl(type: "knob" | "switch") {
        const device = this.deviceLibrary.currentDevice;
        if (!device) return;

        const count = device.getActiveControlCount();
        if (count >= device.MAX_ACTIVE_CONTROLS) {
            Toast.show(`Control limit reached: max ${device.MAX_ACTIVE_CONTROLS} active controls (AC03).`, "error");
            return;
        }

        const before = this.history?.captureDeviceState(device);

        // Starting placement only — the canvas is a free layout editor (§9/§10).
        // A soft diagonal stagger avoids a rigid grid; the user repositions
        // controls freely afterwards using drag + grid snapping.
        const col = count % 4;
        const row = Math.floor(count / 4);
        const x = this.snapPos(80 + col * 160 + row * 20);
        const y = this.snapPos(100 + row * 160 + col * 20);
        const c = new Control(type, type === "knob" ? "Knob" : "Switch", { x, y });
        device.addControl(c);
        this.deviceLibrary.saveCurrentDevice();

        const after = this.history?.captureDeviceState(device);
        if (this.history && before && after && !patchesEqual(before, after)) {
            this.history.record({ type: "control.add", scope: "device", deviceId: device.id, before, after });
        }

        this.selectedControlId = c.id;
        this.selectedGroupId = null;
        this.render(this.container.parentElement!);
    }

    private addGroup() {
        const device = this.deviceLibrary.currentDevice;
        if (!device) return;

        const before = this.history?.captureDeviceState(device);

        const count = device.groups.size;
        const group = new Group(
            "Group",
            { x: this.snap(120 + count * 30), y: this.snap(120 + count * 30) },
            { width: 240, height: 180 }
        );
        device.addGroup(group);
        this.deviceLibrary.saveCurrentDevice();

        const after = this.history?.captureDeviceState(device);
        if (this.history && before && after && !patchesEqual(before, after)) {
            this.history.record({ type: "group.add", scope: "device", deviceId: device.id, before, after });
        }

        this.selectedGroupId = group.id;
        this.selectedControlId = null;
        this.render(this.container.parentElement!);
    }

    private deleteSelected() {
        const device = this.deviceLibrary.currentDevice;
        if (!device) return;

        if (this.selectedControlId) {
            const before = this.history?.captureDeviceState(device);
            device.removeControl(this.selectedControlId); // soft delete/archive
            Toast.show("Control archived (soft-delete): preset references stay valid (§44).", "info");
            const after = this.history?.captureDeviceState(device);
            if (this.history && before && after && !patchesEqual(before, after)) {
                this.history.record({ type: "control.archive", scope: "device", deviceId: device.id, before, after });
            }
            this.selectedControlId = null;
            this.deviceLibrary.saveCurrentDevice();
            this.render(this.container.parentElement!);
        } else if (this.selectedGroupId) {
            const id = this.selectedGroupId;
            const memberCount = device.getGroupControls(id).length;
            if (memberCount > 0) {
                Toast.show(
                    `Group contains ${memberCount} control(s). Removing it leaves them ungrouped (no controls are deleted).`,
                    "info"
                );
            }
            const before = this.history?.captureDeviceState(device);
            device.removeGroup(id);
            const after = this.history?.captureDeviceState(device);
            if (this.history && before && after && !patchesEqual(before, after)) {
                this.history.record({ type: "group.delete", scope: "device", deviceId: device.id, before, after });
            }
            this.selectedGroupId = null;
            this.deviceLibrary.saveCurrentDevice();
            this.render(this.container.parentElement!);
        }
    }

    // ---------- rendering ----------

    private renderControl(control: any, parent: HTMLElement) {
        const el = document.createElement("div");
        el.className = "control-wrapper edit-mode" + (this.selectedControlId === control.id ? " selected" : "");
        el.dataset.ctlId = control.id;

        // Rectangular visual area: the configurable color surface (§13). The
        // widget lives inside this area, keeping it visually intentional.
        const visualArea = document.createElement("div");
        visualArea.className = "control-visual-area";
        if (control.visualDefinition?.color) {
            visualArea.style.background = control.visualDefinition.color;
        }
        el.appendChild(visualArea);

        // Physical knob / switch (the knob stays geometrically square)
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
        } else {
            const body = document.createElement("div");
            body.className = "switch-body" + (control.value > 0.5 ? " on" : "");
            const toggle = document.createElement("div");
            toggle.className = "switch-toggle";
            body.appendChild(toggle);
            visualArea.appendChild(body);
        }

        // Label area: name (double-click renames) + binding-status badge
        const labelArea = document.createElement("div");
        labelArea.className = "control-label-area";

        const name = document.createElement("span");
        name.className = "control-name";
        name.innerText = control.name;
        name.title = control.name;
        name.style.cursor = "text";
        name.addEventListener("dblclick", (e) => {
            e.stopPropagation();
            this.beginRename(name, control);
        });
        labelArea.appendChild(name);

        const badge = document.createElement("span");
        badge.className = "status-dot";
        const state = control.activeBindingState ?? "UNCONFIGURED";
        badge.classList.add(
            state === "CONNECTED" ? "connected" : state === "DISCONNECTED" ? "disconnected" : "unconfigured"
        );
        const target = control.audiotoolBindingDefinition?.targetName;
        badge.title =
            state === "CONNECTED"
                ? `CONNECTED → ${target ?? "unknown target"}`
                : state === "DISCONNECTED"
                    ? "DISCONNECTED — active binding is for another project. Select+Learn to reconnect (§39)."
                    : "UNCONFIGURED — no Audiotool binding.";
        labelArea.appendChild(badge);
        el.appendChild(labelArea);

        // Editing tools — a coherent bar shown below the control when selected.
        const tools = document.createElement("div");
        tools.className = "control-tools";

        const colorInput = document.createElement("input");
        colorInput.type = "color";
        colorInput.className = "color-swatch";
        colorInput.value = control.visualDefinition?.color || "#333333";
        colorInput.title = "Visual area color (§13)";
        colorInput.addEventListener("input", (e) => {
            const value = (e.target as HTMLInputElement).value;
            // Coalesce one color-picker sweep into a single history action:
            // `before` is captured on the FIRST input of the gesture, committed
            // on `change` (picker commit). Model + DOM update live as before.
            const key = `ctl:${control.id}`;
            if (this.colorGestureKey !== key || this.colorGestureBefore === null) {
                this.colorGestureKey = key;
                const device = this.deviceLibrary.currentDevice;
                this.colorGestureBefore = this.history && device ? this.history.captureDeviceState(device) : null;
            }
            control.visualDefinition = control.visualDefinition || {};
            control.visualDefinition.color = value;
            visualArea.style.background = control.visualDefinition.color;
            this.deviceLibrary.saveCurrentDevice();
        });
        colorInput.addEventListener("change", () => {
            const device = this.deviceLibrary.currentDevice;
            const key = `ctl:${control.id}`;
            if (this.history && device && this.colorGestureKey === key && this.colorGestureBefore) {
                const after = this.history.captureDeviceState(device);
                if (!patchesEqual(this.colorGestureBefore, after)) {
                    this.history.record({ type: "control.color", scope: "device", deviceId: device.id, before: this.colorGestureBefore, after });
                }
            }
            this.colorGestureKey = null;
            this.colorGestureBefore = null;
        });
        tools.appendChild(colorInput);

        const del = document.createElement("button");
        del.className = "tool-btn";
        del.innerText = "✕";
        del.title = "Archive control";
        del.onclick = (e) => { e.stopPropagation(); this.deleteSelected(); };
        tools.appendChild(del);

        if (this.bindingManager && this.nexusAdapter) {
            const learnBtn = document.createElement("button");
            learnBtn.className = "tool-btn";
            learnBtn.innerText = "Learn";
            learnBtn.title = "Learn this control from Audiotool for the CURRENT project (§23/§24)";
            learnBtn.onclick = (e) => { e.stopPropagation(); void this.startNexusLearn(control); };
            tools.appendChild(learnBtn);

            const forget = document.createElement("button");
            forget.className = "tool-btn";
            forget.innerText = "Forget";
            forget.title = "Remove the active project binding (control becomes UNCONFIGURED)";
            forget.onclick = (e) => {
                e.stopPropagation();
                this.bindingManager!.clearBinding(control.id);
                this.nexusAdapter!.unsubscribeFromParameter(control.id);
                this.deviceLibrary.saveCurrentDevice();
                Toast.show(`Binding removed from "${control.name}".`, "info");
                this.render(this.container.parentElement!);
            };
            tools.appendChild(forget);
        }

        if (this.midiAccess && this.midiMapping) {
            const midiBtn = document.createElement("button");
            midiBtn.className = "tool-btn";
            midiBtn.innerText = "MIDI";
            midiBtn.title = "MIDI-learn a hardware CC for this control (§25-27)";
            midiBtn.onclick = (e) => { e.stopPropagation(); void this.startMidiLearn(control); };
            tools.appendChild(midiBtn);
        }

        const membership = document.createElement("select");
        membership.className = "group-membership";
        membership.title = "Group membership";
        const noGroup = document.createElement("option");
        noGroup.value = "";
        noGroup.innerText = "— no group —";
        membership.appendChild(noGroup);
        this.deviceLibrary.currentDevice!.groups.forEach((g: any) => {
            const opt = document.createElement("option");
            opt.value = g.id;
            opt.innerText = g.name;
            if (g.id === control.groupId) opt.selected = true;
            membership.appendChild(opt);
        });
        membership.onchange = () => {
            const device = this.deviceLibrary.currentDevice!;
            const before = this.history?.captureDeviceState(device);
            device.setControlGroup(control.id, membership.value || undefined);
            const after = this.history?.captureDeviceState(device);
            if (this.history && before && after && !patchesEqual(before, after)) {
                this.history.record({ type: "control.membership", scope: "device", deviceId: device.id, before, after });
            }
            this.deviceLibrary.saveCurrentDevice();
            this.render(this.container.parentElement!);
        };
        tools.appendChild(membership);
        el.appendChild(tools);

        // Resize handle
        const resizeH = document.createElement("div");
        resizeH.className = "resize-handle";
        el.appendChild(resizeH);

        // Selection on click (dragging within the tools bar must not move the control)
        el.addEventListener("pointerdown", (e: PointerEvent) => {
            if (e.button !== 0) return;
            const t = e.target as HTMLElement;
            // Never move the Control when pressing editor tools or the resize handle.
            if (t.classList.contains("resize-handle")) return;
            if (t.closest(".control-tools")) return;
            this.selectedControlId = control.id;
            this.selectedGroupId = null;
            this.syncSelection();
            this.beginDrag(
                "control-move", control, el,
                { x: control.position.x, y: control.position.y, width: control.size.width, height: control.size.height },
                e.pointerId, e.clientX, e.clientY
            );
        });

        resizeH.addEventListener("pointerdown", (e: PointerEvent) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            this.selectedControlId = control.id;
            this.selectedGroupId = null;
            this.syncSelection();
            this.beginDrag(
                "control-resize", control, el,
                { x: control.position.x, y: control.position.y, width: control.size.width, height: control.size.height },
                e.pointerId, e.clientX, e.clientY
            );
        });

        parent.appendChild(el);

        // Apply the full geometry (position + dimensions + square widget)
        this.applyControlLayout(el, control);
    }

    /**
     * Sync the rendered element to the Control's stored geometry. During a live
     * resize this keeps the knob square and re-centers it in the visual area.
     */
    private applyControlLayout(el: HTMLElement, control: any) {
        el.style.left = `${control.position.x}px`;
        el.style.top = `${control.position.y}px`;
        el.style.width = `${control.size.width}px`;
        el.style.height = `${control.size.height}px`;

        const layout = computeControlLayout(control.size, control.type);

        // Flip the toolbar below when the control sits near the canvas top
        // so it does not clip or overlap groups above.
        const tools = el.querySelector<HTMLElement>(".control-tools");
        if (tools) {
            const flipBelow = control.position.y < 42;
            tools.style.top = flipBelow ? "auto" : "-36px";
            tools.style.bottom = flipBelow ? "-36px" : "auto";
        }

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

    private renderGroup(group: any, parent: HTMLElement) {
        const el = document.createElement("div");
        el.className = "group-box" + (this.selectedGroupId === group.id ? " selected" : "");
        el.dataset.grpId = group.id;
        el.style.left = `${group.position.x}px`;
        el.style.top = `${group.position.y}px`;
        el.style.width = `${group.size.width}px`;
        el.style.height = `${group.size.height}px`;

        const fill = document.createElement("div");
        fill.style.cssText = "position:absolute;inset:0;border-radius:inherit;pointer-events:none;";
        fill.style.background = this.hexToRgba(group.color, 0.12);
        el.appendChild(fill);

        const label = document.createElement("div");
        label.className = "group-label";
        label.style.background = group.color;
        label.style.color = contrastTextColor(group.color);
        label.innerText = group.name;
        label.style.cursor = "text";
        label.addEventListener("dblclick", (e) => {
            e.stopPropagation();
            this.beginRename(label, group);
        });
        el.appendChild(label);

        // Group color picker (§15)
        const colorInput = document.createElement("input");
        colorInput.type = "color";
        colorInput.className = "group-color-input";
        colorInput.value = group.color;
        colorInput.addEventListener("input", (e) => {
            const value = (e.target as HTMLInputElement).value;
            const key = `grp:${group.id}`;
            if (this.colorGestureKey !== key || this.colorGestureBefore === null) {
                this.colorGestureKey = key;
                const device = this.deviceLibrary.currentDevice;
                this.colorGestureBefore = this.history && device ? this.history.captureDeviceState(device) : null;
            }
            group.color = value;
            label.style.background = group.color;
            label.style.color = contrastTextColor(group.color);
            fill.style.background = this.hexToRgba(group.color, 0.12);
            this.deviceLibrary.saveCurrentDevice();
        });
        colorInput.addEventListener("change", () => {
            const device = this.deviceLibrary.currentDevice;
            const key = `grp:${group.id}`;
            if (this.history && device && this.colorGestureKey === key && this.colorGestureBefore) {
                const after = this.history.captureDeviceState(device);
                if (!patchesEqual(this.colorGestureBefore, after)) {
                    this.history.record({ type: "group.color", scope: "device", deviceId: device.id, before: this.colorGestureBefore, after });
                }
            }
            this.colorGestureKey = null;
            this.colorGestureBefore = null;
        });
        el.appendChild(colorInput);

        // Resize handle
        const resizeH = document.createElement("div");
        resizeH.className = "resize-handle";
        el.appendChild(resizeH);

        el.addEventListener("pointerdown", (e: PointerEvent) => {
            if (e.button !== 0) return;
            const t = e.target as HTMLElement;
            if (t.classList.contains("resize-handle")) return;

            this.selectedGroupId = group.id;
            this.selectedControlId = null;
            this.syncSelection();

            // The name label is the RENAME area and never starts a drag.
            if (t.tagName === "INPUT") return; // color picker never drags
            if (t.closest(".group-label")) return;

            this.beginDrag(
                "group-move", group, el,
                { x: group.position.x, y: group.position.y, width: group.size.width, height: group.size.height },
                e.pointerId, e.clientX, e.clientY
            );
        });

        resizeH.addEventListener("pointerdown", (e: PointerEvent) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            this.selectedGroupId = group.id;
            this.selectedControlId = null;
            this.syncSelection();
            this.beginDrag(
                "group-resize", group, el,
                { x: group.position.x, y: group.position.y, width: group.size.width, height: group.size.height },
                e.pointerId, e.clientX, e.clientY
            );
        });

        parent.appendChild(el);
    }

    // ---------- drag ----------

    /**
     * Starts (or restarts) the single drag gesture. Any previously active
     * drag is terminated first, so two drags can never overlap. A drag only
     * applies model changes once the pointer moves further than
     * DRAG_THRESHOLD (selection vs. drag separation).
     */
    private beginDrag(
        type: DragInfo["type"],
        target: any,
        el: HTMLElement,
        initial: { x: number; y: number; width: number; height: number },
        pointerId: number,
        clientX: number,
        clientY: number
    ) {
        // Safety: never stack a second drag on an unfinished one.
        if (this.drag) {
            this.endDrag();
        }

        this.drag = {
            type,
            target,
            el,
            pointerId,
            startPointerX: clientX,
            startPointerY: clientY,
            initialX: initial.x,
            initialY: initial.y,
            initialWidth: initial.width,
            initialHeight: initial.height,
            active: false,
            captured: false,
            moved: false,
            // The pre-gesture structural state. Exactly ONE history action is
            // committed at the end of the gesture; Escape restores this state
            // and commits nothing.
            before: this.history && this.deviceLibrary.currentDevice
                ? this.history.captureDeviceState(this.deviceLibrary.currentDevice)
                : undefined,
            aborted: false,
        };

        // Pointer capture is deliberately NOT taken here: capturing on
        // pointerdown would retarget the compatibility click/dblclick events
        // to this element, so double-clicking a Group/Control name label would
        // never reach the label and rename would silently break. Capture is
        // taken lazily in handlePointerMove once a real drag starts.
        document.addEventListener("keydown", this.handleDragKeydown);
        document.addEventListener("pointermove", this.handlePointerMove);
        document.addEventListener("pointerup", this.handlePointerEnd);
        document.addEventListener("pointercancel", this.handlePointerEnd);
    }

    private handlePointerMove = (e: PointerEvent) => {
        const drag = this.drag;
        if (!drag || drag.pointerId !== e.pointerId) return;

        const dx = e.clientX - drag.startPointerX;
        const dy = e.clientY - drag.startPointerY;

        // Click without relevant movement must not start a drag.
        if (!drag.active) {
            if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
            drag.active = true;
            this.capturePointer(drag);
        }

        this.applyDrag(drag, dx, dy);
    };

    /**
     * Escape aborts a started drag: the model is restored to the pre-gesture
     * structural state, persisted, and NO history action is committed. A
     * sub-threshold gesture (nothing changed yet) just ends the gesture.
     */
    private handleDragKeydown = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        const drag = this.drag;
        if (!drag) return;
        const device = this.deviceLibrary.currentDevice;
        if (drag.moved && drag.before && device) {
            if (this.history) this.history.restoreDeviceState(device, drag.before);
            this.deviceLibrary.saveCurrentDevice();
        }
        drag.aborted = true;
        this.endDrag();
        this.render(this.container.parentElement!);
    };

    /** Takes pointer capture for an actually-started drag, if supported. */
    private capturePointer(drag: DragInfo) {
        try {
            drag.el.setPointerCapture(drag.pointerId);
            drag.captured = true;
        } catch {
            // Environments without pointer capture still track the gesture
            // through the document-level listeners.
        }
    }

    private handlePointerEnd = (e: PointerEvent) => {
        if (!this.drag || this.drag.pointerId !== e.pointerId) return;
        // pointerup and pointercancel both end the gesture cleanly.
        this.endDrag();
    };

    /** Applies the current pointer delta to the model + DOM (with snap). */
    private applyDrag(drag: DragInfo, dx: number, dy: number) {
        const { type, target, el, initialX, initialY, initialWidth, initialHeight } = drag;
        drag.moved = true;

        if (type === "control-move") {
            target.position.x = this.snapPos(initialX + dx);
            target.position.y = this.snapPos(initialY + dy);
            this.applyControlLayout(el, target);
        } else if (type === "control-resize") {
            // Snap first, then enforce the minimum size so the grid never
            // shrinks a Control below CONTROL_MIN_SIZE.
            target.size.width = Math.max(CONTROL_MIN_SIZE.width, this.snapPos(initialWidth + dx));
            target.size.height = Math.max(CONTROL_MIN_SIZE.height, this.snapPos(initialHeight + dy));
            this.applyControlLayout(el, target);
        } else if (type === "group-move") {
            const device = this.deviceLibrary.currentDevice!;
            const gx = this.snapPos(initialX + dx);
            const gy = this.snapPos(initialY + dy);
            device.moveGroup(target.id, gx - target.position.x, gy - target.position.y);
            el.style.left = `${target.position.x}px`;
            el.style.top = `${target.position.y}px`;
            // Member Controls move the same delta in the model; keep the DOM
            // elements in sync so the surface and the stored geometry match.
            device.getGroupControls(target.id).forEach(member => {
                const memberEl = this.container.querySelector(`[data-ctl-id="${member.id}"]`) as HTMLElement | null;
                if (memberEl) this.applyControlLayout(memberEl, member);
            });
        } else { // group-resize
            const device = this.deviceLibrary.currentDevice!;
            const w = Math.max(60, this.snapPos(initialWidth + dx));
            const h = Math.max(60, this.snapPos(initialHeight + dy));
            device.resizeGroup(target.id, w, h);
            el.style.width = `${target.size.width}px`;
            el.style.height = `${target.size.height}px`;
        }
    }

    /** Terminates the active gesture: commit, persist, release, clear.
     * Safe to call with no active drag; guaranteed to leave dragState IDLE. */
    private endDrag() {
        const drag = this.drag;
        if (!drag) return;

        // Commit exactly ONE history action for a fully completed gesture
        // (started + moved + not aborted). The state is snapshotted around the
        // gesture; identical start/end (grid-snapped no-op) commits nothing.
        if (drag.moved && !drag.aborted && drag.before && this.history) {
            const device = this.deviceLibrary.currentDevice;
            if (device) {
                const after = this.history.captureDeviceState(device);
                if (!patchesEqual(drag.before, after)) {
                    this.history.record({ type: drag.type, scope: "device", deviceId: device.id, before: drag.before, after });
                }
            }
        }

        if (drag.moved) {
            // The final position is now the model's source of truth and is
            // persisted so an immediate re-render / reload keeps it (§10).
            this.deviceLibrary.saveCurrentDevice();
        }

        if (drag.captured) {
            try {
                drag.el.releasePointerCapture(drag.pointerId);
            } catch {
                // no-op
            }
        }

        document.removeEventListener("keydown", this.handleDragKeydown);
        document.removeEventListener("pointermove", this.handlePointerMove);
        document.removeEventListener("pointerup", this.handlePointerEnd);
        document.removeEventListener("pointercancel", this.handlePointerEnd);

        this.drag = null;
    }

    private syncSelection() {
        this.container.querySelectorAll(".control-wrapper.selected").forEach((n) => n.classList.remove("selected"));
        this.container.querySelectorAll(".group-box.selected").forEach((n) => n.classList.remove("selected"));
        if (this.selectedControlId) {
            this.container.querySelector(`[data-ctl-id="${this.selectedControlId}"]`)?.classList.add("selected");
        }
        if (this.selectedGroupId) {
            this.container.querySelector(`[data-grp-id="${this.selectedGroupId}"]`)?.classList.add("selected");
        }
    }

    private beginRename(label: HTMLElement, target: any) {
        const input = document.createElement("input");
        input.type = "text";
        input.value = target.name;
        input.style.cssText = "width:120px;max-width:100%;box-sizing:border-box;background:#111;color:#fff;border:1px solid var(--accent-color);outline:none;font-size:11px;text-align:center;";
        const save = () => {
            const name = input.value.trim();
            if (name && name !== target.name) {
                const device = this.deviceLibrary.currentDevice!;
                const before = this.history?.captureDeviceState(device);
                target.name = name;
                const after = this.history?.captureDeviceState(device);
                if (this.history && before && after && !patchesEqual(before, after)) {
                    const isGroupRename = target instanceof Group;
                    this.history.record({
                        type: isGroupRename ? "group.rename" : "control.rename",
                        scope: "device",
                        deviceId: device.id,
                        before,
                        after,
                    });
                }
                this.deviceLibrary.saveCurrentDevice();
            }
            label.innerText = target.name;
        };
        input.addEventListener("blur", save);
        input.addEventListener("keydown", (ke) => {
            if (ke.key === "Enter") input.blur();
            else if (ke.key === "Escape") { input.value = target.name; input.blur(); }
        });
        label.innerText = "";
        label.appendChild(input);
        input.focus();
        input.select();
    }

    // ---------- editor-side Learn / reconnect (§23-27, §39) ----------

    private async startNexusLearn(control: any) {
        if (!this.nexusAdapter || !this.bindingManager) return;
        if (!this.nexusAdapter.document) {
            Toast.show("Connect to an Audiotool project first (§23).", "error");
            return;
        }
        if (this.nexusLearningId !== null) { this.cancelNexusLearn(); return; }

        this.nexusLearn = new NexusLearn(this.nexusAdapter.document);
        this.nexusLearningId = control.id;
        this.render(this.container.parentElement!);

        try {
            const result = await this.nexusLearn.startLearn({ timeoutMs: 60000 });
            if (this.nexusLearningId !== control.id) {
                this.nexusLearn = null;
                this.render(this.container.parentElement!);
                return;
            }
            this.nexusLearn = null;
            this.nexusLearningId = null;
            this.bindingManager.applyLearnResult(control.id, result);
            this.nexusAdapter.subscribeBoundControl(control.id);
            this.deviceLibrary.saveCurrentDevice();
            // Reflect the learned value immediately (§23: value applied, normalized 0..1)
            const mapping = result.valueMapping ?? createNexusValueMapping(result.field);
            control.value = mapNexusToNormalized(mapping, result.value);
            console.log(`[METATRON LEARN SUCCESS] controlId=${control.id} entityId=${result.entityId} fieldName=${result.fieldPath} value=${result.value}`);
            Toast.show(`Learned → ${result.targetName}`, "success");
        } catch (e) {
            this.nexusLearn = null;
            this.nexusLearningId = null;
            if (e instanceof LearnTimeoutError) {
                Toast.show("Learn timed out (60s). No change was captured.", "error");
            } else if (e instanceof LearnCancelledError) {
                Toast.show("Learn cancelled. No binding was created.", "info");
            } else {
                Toast.show(`Learn failed: ${e instanceof Error ? e.message : String(e)}`, "error");
            }
        }
        this.render(this.container.parentElement!);
    }

    private cancelNexusLearn() {
        this.nexusLearn?.cancelLearn();
        this.nexusLearn = null;
        this.nexusLearningId = null;
        this.render(this.container.parentElement!);
    }

    private async startMidiLearn(control: any) {
        if (!this.midiAccess || !this.midiMapping || !this.midiLearn) return;
        if (this.midiLearn.isActive()) { this.midiLearn.cancelLearn(); this.render(this.container.parentElement!); return; }

        this.midiLearningId = control.id;
        this.render(this.container.parentElement!);

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
        this.midiLearningId = null;
        this.render(this.container.parentElement!);
    }

    // ---------- helpers ----------

    private snap(value: number): number {
        return this.snapEnabled ? Math.round(value / SNAP) * SNAP : Math.round(value);
    }

    private snapPos(value: number): number {
        return Math.max(0, this.snap(value));
    }

    private hexToRgba(hex: string, alpha: number): string {
        const h = hex.replace("#", "");
        const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
        const n = parseInt(full, 16);
        if (Number.isNaN(n)) return `rgba(51,51,51,${alpha})`;
        return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
    }
}