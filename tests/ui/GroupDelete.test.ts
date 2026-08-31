// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Group } from "../../src/core/model/Group";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { DeviceHistory } from "../../src/core/history/DeviceHistory";
import { EditorUI } from "../../src/ui/editor/EditorUI";

function mount(): { host: HTMLElement; device: Device; library: DeviceLibrary; ui: EditorUI; history: DeviceHistory; member: Control; group: Group } {
    const device = new Device("Delete");
    const group = new Group("FILTER", { x: 100, y: 100 }, { width: 240, height: 180 });
    device.addGroup(group);
    const member = new Control("knob", "CUTOFF", { x: 130, y: 130 });
    device.addControl(member);
    device.setControlGroup(member.id, group.id);

    const library = new DeviceLibrary();
    library.currentDevice = device;
    const history = new DeviceHistory(library);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const ui = new EditorUI(library, undefined, undefined, undefined, undefined, undefined, history);
    ui.render(host);
    return { host, device, library, ui, history, member, group };
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    vi.restoreAllMocks();
});

describe("Group delete UI fix", () => {

    it("Test 1 — Group delete surrounds are present and remove group, keep controls, persist, toast, undo", () => {
        const { host, device, library, ui, history, member, group } = mount();
        const saveSpy = vi.spyOn(library, "saveCurrentDevice");

        const groupEl = host.querySelector<HTMLElement>(`[data-grp-id="${group.id}"]`)!;
        const deleteBtn = groupEl.querySelector<HTMLElement>(".group-delete-btn")!;
        expect(deleteBtn).not.toBeNull();
        expect(deleteBtn.title).toBe("Delete group");

        deleteBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

        // Group removed from model and DOM.
        expect(device.getGroup(group.id)).toBeUndefined();
        expect(host.querySelector(`[data-grp-id="${group.id}"]`)).toBeNull();

        // Member control survives, ungrouped.
        expect(device.getControl(member.id)).toBe(member);
        expect(member.groupId).toBeUndefined();

        // Persisted through the real saveCurrentDevice path.
        expect(saveSpy).toHaveBeenCalledTimes(1);
        const restored = new DeviceLibrary().loadDevice(device.id)!;
        expect(restored.getGroup(group.id)).toBeUndefined();
        const restoredMember = restored.getControl(member.id);
        expect(restoredMember).toBeDefined();
        expect(restoredMember!.groupId).toBeUndefined();

        // Ungroup feedback toast is present.
        const toast = Array.from(document.body.querySelectorAll("div")).find((d) =>
            d.innerText?.includes("Removing it leaves them ungrouped")
        );
        expect(toast).toBeDefined();

        // Undo restores group and memberships (in place, persisted).
        expect(history.undo()).toBe(true);
        expect(device.getGroup(group.id)).toBeDefined();
        expect(member.groupId).toBe(group.id);
        const afterUndo = new DeviceLibrary().loadDevice(device.id)!;
        expect(afterUndo.getGroup(group.id)).toBeDefined();
        expect(afterUndo.getControl(member.id)?.groupId).toBe(group.id);
    });

    it("Test 2 — group delete button does not start a group drag", () => {
        const { host, device, group } = mount();
        const deleteBtn = host.querySelector<HTMLElement>(`[data-grp-id="${group.id}"] .group-delete-btn`)!;

        deleteBtn.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 5, clientY: 5, button: 0, bubbles: true, cancelable: true }));
        document.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 60, clientY: 60, bubbles: true, cancelable: true }));

        expect(group.position).toEqual({ x: 100, y: 100 });
    });
});