// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Group } from "../../src/core/model/Group";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { EditorUI } from "../../src/ui/editor/EditorUI";

function mount(): { host: HTMLElement; device: Device; library: DeviceLibrary; ui: EditorUI } {
    const device = new Device("Rename");
    const group = new Group("FILTER", { x: 100, y: 100 }, { width: 240, height: 180 });
    device.addGroup(group);
    const m = new Control("knob", "CUTOFF", { x: 130, y: 130 });
    device.addControl(m);
    device.setControlGroup(m.id, group.id);

    const library = new DeviceLibrary();
    library.currentDevice = device;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const ui = new EditorUI(library);
    ui.render(host);
    return { host, device, library, ui };
}

function pd(el: HTMLElement, x: number, y: number, id = 1) {
    el.dispatchEvent(new PointerEvent("pointerdown", { pointerId: id, clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }));
}
function pm(x: number, y: number, id = 1) {
    document.dispatchEvent(new PointerEvent("pointermove", { pointerId: id, clientX: x, clientY: y, bubbles: true, cancelable: true }));
}
function pu(id = 1) {
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: id, bubbles: true, cancelable: true }));
}

/** Mirrors a real double-click on the label (two click gestures + dblclick). */
function doubleClickLabel(label: HTMLElement) {
    for (let i = 0; i < 2; i++) {
        pd(label, 10, 10);
        pu();
        label.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }
    label.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

describe("Group rename regression", () => {

    it("Test 1 — double-click on the Group name enters rename and commits to the model", () => {
        const { host, device } = mount();
        const group = device.groups.values().next().value as Group;
        const label = host.querySelector<HTMLElement>(`[data-grp-id="${group.id}"] .group-label`)!;

        doubleClickLabel(label);

        const input = label.querySelector<HTMLInputElement>("input")!;
        expect(input).not.toBeNull();
        expect(input.value).toBe("FILTER");

        input.value = "FILTER CUTOFF";
        input.blur();

        expect(group.name).toBe("FILTER CUTOFF");
        expect(label.textContent).toBe("FILTER CUTOFF");
    });

    it("Test 2 — renamed Group persists through save/reload (localStorage)", () => {
        const { host, library } = mount();
        const device = library.currentDevice!;
        const group = device.groups.values().next().value as Group;
        const label = host.querySelector<HTMLElement>(`[data-grp-id="${group.id}"] .group-label`)!;

        doubleClickLabel(label);
        const input = label.querySelector<HTMLInputElement>("input")!;
        input.value = "FILTER CUTOFF";
        input.blur();

        const restored = new DeviceLibrary().loadDevice(device.id)!;
        expect(restored.getGroup(group.id)?.name).toBe("FILTER CUTOFF");
    });

    it("Test 3 — double-click name starts rename and does NOT move the Group", () => {
        const { host, device } = mount();
        const group = device.groups.values().next().value as Group;
        const label = host.querySelector<HTMLElement>(`[data-grp-id="${group.id}"] .group-label`)!;

        doubleClickLabel(label);
        expect(label.querySelector("input")).not.toBeNull();
        // No drag activation happened: position untouched.
        expect(group.position).toEqual({ x: 100, y: 100 });
    });

    it("Test 6 — single click on the Group selects it", () => {
        const { host, device } = mount();
        const group = device.groups.values().next().value as Group;
        const groupEl = host.querySelector<HTMLElement>(`[data-grp-id="${group.id}"]`)!;

        pd(groupEl, 20, 20);
        pu();

        expect(groupEl.classList.contains("selected")).toBe(true);
        expect(group.position).toEqual({ x: 100, y: 100 });
    });

    it("Test 7 — Enter commits the new name", () => {
        const { host, device } = mount();
        const group = device.groups.values().next().value as Group;
        const label = host.querySelector<HTMLElement>(`[data-grp-id="${group.id}"] .group-label`)!;

        doubleClickLabel(label);
        const input = label.querySelector<HTMLInputElement>("input")!;
        input.value = "DRUMS";
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

        expect(group.name).toBe("DRUMS");
        expect(label.textContent).toBe("DRUMS");
    });

    it("Test 8 — blur commits the new name", () => {
        const { host, device } = mount();
        const group = device.groups.values().next().value as Group;
        const label = host.querySelector<HTMLElement>(`[data-grp-id="${group.id}"] .group-label`)!;

        doubleClickLabel(label);
        const input = label.querySelector<HTMLInputElement>("input")!;
        input.value = "BASS";
        input.dispatchEvent(new Event("blur"));

        expect(group.name).toBe("BASS");
    });
});

describe("Group rename regression — other interactions keep working", () => {

    it("Test 4 — dragging the Group body still moves the Group", () => {
        const { host, device } = mount();
        const group = device.groups.values().next().value as Group;
        const groupEl = host.querySelector<HTMLElement>(`[data-grp-id="${group.id}"]`)!;

        pd(groupEl, 0, 0);
        pm(40, 40);
        pu();

        expect(group.position).toEqual({ x: 140, y: 140 });
    });

    it("Test 5 — dragging the Group resize handle still resizes it", () => {
        const { host, device } = mount();
        const group = device.groups.values().next().value as Group;
        const groupEl = host.querySelector<HTMLElement>(`[data-grp-id="${group.id}"]`)!;
        const handle = groupEl.querySelector<HTMLElement>(".resize-handle")!;

        pd(handle, 0, 0);
        pm(40, 40);
        pu();

        expect(group.size).toEqual({ width: 280, height: 220 });
        expect(group.position).toEqual({ x: 100, y: 100 });
    });

    it("a widget inside the Group remains independently draggable after rename", () => {
        const { host, device } = mount();
        const group = device.groups.values().next().value as Group;
        const member = device.getGroupControls(group.id)[0];
        const memberEl = host.querySelector<HTMLElement>(`[data-ctl-id="${member.id}"]`)!;

        pd(memberEl, 0, 0);
        pm(20, 0);
        pu();

        // +20 on the 20px grid: snap(130+20)=160, and snap(130)=140.
        expect(member.position).toEqual({ x: 160, y: 140 });
        expect(group.position).toEqual({ x: 100, y: 100 });
    });
});