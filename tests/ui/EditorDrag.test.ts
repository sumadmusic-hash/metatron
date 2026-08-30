// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { Group } from "../../src/core/model/Group";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { EditorUI } from "../../src/ui/editor/EditorUI";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { BindingManager } from "../../src/core/BindingManager";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { MidiMapping } from "../../src/midi/MidiMapping";

function mountEditorLib(device: Device): DeviceLibrary {
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    return lib;
}

function fullEditor(device: Device): EditorUI {
    return new EditorUI(
        mountEditorLib(device),
        new NexusAdapter(),
        new BindingManager(device),
        new MidiAccess(),
        new MidiMapping(device),
        vi.fn()
    );
}

function mount(device: Device, ui: EditorUI): HTMLElement {
    const host = document.createElement("div");
    document.body.appendChild(host);
    ui.render(host);
    return host;
}

function addKnob(device: Device, name: string, x: number, y: number): Control {
    const c = new Control("knob", name, { x, y });
    device.addControl(c);
    return c;
}

/** Pointer gesture helpers (pointerId defaults to 1). */
function pd(el: HTMLElement, x: number, y: number, id = 1) {
    el.dispatchEvent(new PointerEvent("pointerdown", { pointerId: id, clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }));
}
function pm(x: number, y: number, id = 1) {
    document.dispatchEvent(new PointerEvent("pointermove", { pointerId: id, clientX: x, clientY: y, bubbles: true, cancelable: true }));
}
function pu(id = 1) {
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: id, bubbles: true, cancelable: true }));
}
function pc(id = 1) {
    document.dispatchEvent(new PointerEvent("pointercancel", { pointerId: id, bubbles: true, cancelable: true }));
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

describe("Control drag & drop — drag lifecycle", () => {

    it("Test 1 — basic drag updates the model and the DOM", () => {
        const device = new Device("T1");
        const a = addKnob(device, "A", 100, 100);
        const host = mount(device, fullEditor(device));
        const el = host.querySelector<HTMLElement>(`[data-ctl-id="${a.id}"]`)!;

        pd(el, 400, 300);
        pm(440, 360);
        pu();

        expect(a.position).toEqual({ x: 140, y: 160 });
        expect(el.style.left).toBe("140px");
        expect(el.style.top).toBe("160px");
    });

    it("Test 2 — a second click does not move the Control again", () => {
        const device = new Device("T2");
        const a = addKnob(device, "A", 100, 100);
        const host = mount(device, fullEditor(device));
        const el = host.querySelector<HTMLElement>(`[data-ctl-id="${a.id}"]`)!;

        pd(el, 400, 300);
        pm(440, 360);
        pu();
        const after = { ...a.position };

        // Plain click again: no drag, no movement.
        pd(el, 500, 400);
        pu();
        expect(a.position).toEqual(after);

        // And the state machine is clean — a fresh drag works.
        pd(el, 500, 400);
        pm(560, 440);
        pu();
        expect(a.position.x).toBe(after.x + 60);
        expect(a.position.y).toBe(after.y + 40);
    });

    it("Test 3 — dragging B leaves A untouched", () => {
        const device = new Device("T3");
        const a = addKnob(device, "A", 100, 100);
        const b = addKnob(device, "B", 200, 100);
        const host = mount(device, fullEditor(device));
        const aEl = host.querySelector<HTMLElement>(`[data-ctl-id="${a.id}"]`)!;
        const bEl = host.querySelector<HTMLElement>(`[data-ctl-id="${b.id}"]`)!;

        pd(aEl, 0, 0);
        pm(40, 40);
        pu();
        expect(a.position).toEqual({ x: 140, y: 140 });

        pd(bEl, 0, 0);
        pm(20, 0);
        pu();
        expect(b.position).toEqual({ x: 220, y: 100 });
        // A keeps its earlier moved position.
        expect(a.position).toEqual({ x: 140, y: 140 });
    });

    it("Test 4 — click without movement selects, position unchanged", () => {
        const device = new Device("T4");
        const a = addKnob(device, "A", 100, 100);
        const host = mount(device, fullEditor(device));
        const el = host.querySelector<HTMLElement>(`[data-ctl-id="${a.id}"]`)!;

        pd(el, 300, 300);
        pu();

        expect(a.position).toEqual({ x: 100, y: 100 });
        expect(el.classList.contains("selected")).toBe(true);
    });

    it("Test 5 — sub-threshold movement does not drag", () => {
        const device = new Device("T5");
        const a = addKnob(device, "A", 100, 100);
        const host = mount(device, fullEditor(device));
        const el = host.querySelector<HTMLElement>(`[data-ctl-id="${a.id}"]`)!;

        pd(el, 0, 0);
        pm(2, 2);
        pu();

        expect(a.position).toEqual({ x: 100, y: 100 });
    });

    it("Test 6 — Learn button neither drags nor breaks Learn", () => {
        const device = new Device("T6");
        const a = addKnob(device, "A", 100, 100);
        const host = mount(device, fullEditor(device));

        const learnBtn = [...host.querySelectorAll<HTMLElement>(".control-tools .tool-btn")]
            .find((b) => b.textContent === "Learn")!;
        expect(learnBtn).toBeDefined();

        // Press-and-drag that starts on the Learn button → zero movement.
        pd(learnBtn, 400, 300);
        pm(500, 400);
        pu();
        expect(a.position).toEqual({ x: 100, y: 100 });

        // The Learn button itself still works.
        learnBtn.click();
        expect(document.body.textContent).toContain("Connect to an Audiotool project first");
    });

    it("Test 7 — resize handle resizes (min-size preserved) and never drags", () => {
        const device = new Device("T7");
        const a = addKnob(device, "A", 100, 100);
        const host = mount(device, fullEditor(device));
        const el = host.querySelector<HTMLElement>(`[data-ctl-id="${a.id}"]`)!;
        const handle = el.querySelector<HTMLElement>(".resize-handle")!;

        pd(handle, 0, 0);
        pm(40, 40);
        pu();
        expect(a.size).toEqual({ width: 160, height: 160 });
        expect(a.position).toEqual({ x: 100, y: 100 });

        // Shrinking cannot go below CONTROL_MIN_SIZE (48×48), even on the grid.
        pd(handle, 100, 100);
        pm(-900, -900);
        pu();
        expect(a.size).toEqual({ width: 48, height: 48 });
        expect(a.position).toEqual({ x: 100, y: 100 });
    });

    it("Test 8 — Snap ON aligns the final position to the grid", () => {
        const device = new Device("T8");
        const a = addKnob(device, "A", 100, 100);
        const host = mount(device, fullEditor(device));
        const el = host.querySelector<HTMLElement>(`[data-ctl-id="${a.id}"]`)!;

        pd(el, 0, 0);
        pm(37, 43);
        pu();
        expect(a.position).toEqual({ x: 140, y: 140 });
    });

    it("Test 9 — Snap OFF allows free positioning", () => {
        const device = new Device("T9");
        const a = addKnob(device, "A", 100, 100);
        const host = mount(device, fullEditor(device));

        // Toggle the Snap button OFF (re-renders the canvas).
        const snapBtn = [...host.querySelectorAll<HTMLElement>(".editor-toolbar button")]
            .find((b) => b.textContent?.startsWith("Snap"))!;
        snapBtn.click();

        const el = host.querySelector<HTMLElement>(`[data-ctl-id="${a.id}"]`)!;
        pd(el, 0, 0);
        pm(37, 43);
        pu();
        expect(a.position).toEqual({ x: 137, y: 143 });
    });

    it("Test 11 — pointercancel ends the drag and allows a clean next drag", () => {
        const device = new Device("T11");
        const a = addKnob(device, "A", 100, 100);
        const host = mount(device, fullEditor(device));
        const el = host.querySelector<HTMLElement>(`[data-ctl-id="${a.id}"]`)!;

        pd(el, 0, 0);
        pm(40, 0);
        pc();
        expect(a.position).toEqual({ x: 140, y: 100 });

        // dragState is IDLE again — the next drag works normally.
        pd(el, 0, 0);
        pm(20, 0);
        pu();
        expect(a.position).toEqual({ x: 160, y: 100 });
    });

    it("Test 12 — position persists through save + reload", () => {
        const device = new Device("T12");
        const deviceId = device.id;
        const a = addKnob(device, "A", 100, 100);
        const lib = mountEditorLib(device);
        const host = mount(device, fullEditor(device));
        const el = host.querySelector<HTMLElement>(`[data-ctl-id="${a.id}"]`)!;

        pd(el, 0, 0);
        pm(40, 40);
        pu();

        // pointerup persisted via saveCurrentDevice → localStorage.
        const restored = new DeviceLibrary().loadDevice(deviceId)!;
        expect(restored.getControl(a.id)?.position).toEqual({ x: 140, y: 140 });
        expect(restored.getControl(a.id)?.size).toEqual({ width: 120, height: 120 });
        expect(restored.getControl(a.id)?.id).toBe(a.id);
    });
});

describe("Group drag — separation and member movement", () => {

    function deviceWithGroup(): Device {
        const d = new Device("Grp");
        const g = new Group("FILTER", { x: 100, y: 100 }, { width: 240, height: 180 });
        d.addGroup(g);
        const m = addKnob(d, "CUTOFF", 120, 120);
        d.setControlGroup(m.id, g.id);
        return d;
    }

    it("Test 10 — moving a Group moves member Controls exactly once, DOM included", () => {
        const device = deviceWithGroup();
        const g = device.groups.values().next().value as Group;
        const member = device.getGroupControls(g.id)[0];
        const host = mount(device, fullEditor(device));
        const groupEl = host.querySelector<HTMLElement>(`[data-grp-id="${g.id}"]`)!;
        const memberEl = host.querySelector<HTMLElement>(`[data-ctl-id="${member.id}"]`)!;

        pd(groupEl, 0, 0);
        pm(40, 40);
        pu();

        expect(g.position).toEqual({ x: 140, y: 140 });
        // Exactly one delta application (not doubled).
        expect(member.position).toEqual({ x: 160, y: 160 });
        expect(memberEl.style.left).toBe("160px");
        expect(memberEl.style.top).toBe("160px");
        // Group container DOM follows.
        expect(groupEl.style.left).toBe("140px");
    });

    it("a member Control inside a Group stays independently draggable", () => {
        const device = deviceWithGroup();
        const g = device.groups.values().next().value as Group;
        const member = device.getGroupControls(g.id)[0];
        const host = mount(device, fullEditor(device));
        const memberEl = host.querySelector<HTMLElement>(`[data-ctl-id="${member.id}"]`)!;

        // Move just the member within its group.
        pd(memberEl, 0, 0);
        pm(20, 0);
        pu();

        expect(member.position).toEqual({ x: 140, y: 120 });
        // The Group itself did not move.
        expect(g.position).toEqual({ x: 100, y: 100 });
    });

    it("clicking the Group color input selects/drags nothing", () => {
        const device = deviceWithGroup();
        const g = device.groups.values().next().value as Group;
        const host = mount(device, fullEditor(device));
        const groupEl = host.querySelector<HTMLElement>(`[data-grp-id="${g.id}"]`)!;
        const colorInput = groupEl.querySelector<HTMLElement>(".group-color-input")!;

        pd(colorInput, 0, 0);
        pm(50, 50);
        pu();

        expect(g.position).toEqual({ x: 100, y: 100 });
    });
});