// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOfflineDocument } from "@audiotool/nexus/node";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { Group } from "../../src/core/model/Group";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { EditorUI } from "../../src/ui/editor/EditorUI";
import { AppUI } from "../../src/ui/AppUI";
import { Toast } from "../../src/ui/Toast";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { BindingManager } from "../../src/core/BindingManager";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { MidiMapping } from "../../src/midi/MidiMapping";

class FakeMidiAccess extends MidiAccess {
    public installedHandler: ((channel: number, cc: number, value: number) => void) | null = null;
    public override setMessageHandler(callback: (channel: number, cc: number, value: number) => void) {
        this.installedHandler = callback;
    }
}

class OfflineAdapter extends NexusAdapter {
    constructor(doc: any) {
        super();
        this.document = doc;
    }
    public override updateBoundControl(_controlId: string, _value: number): Promise<boolean> {
        return Promise.resolve(true);
    }
}

function addKnob(device: Device, name: string, x: number, y: number): Control {
    const c = new Control("knob", name, { x, y });
    device.addControl(c);
    return c;
}

function mountEditor(device: Device, midi: MidiAccess = new MidiAccess()): HTMLElement {
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    lib.saveCurrentDevice();
    const ui = new EditorUI(
        lib,
        new NexusAdapter(),
        new BindingManager(device),
        midi,
        new MidiMapping(device),
        vi.fn()
    );
    const host = document.createElement("div");
    document.body.appendChild(host);
    ui.render(host);
    return host;
}

async function mountApp(device: Device): Promise<{ root: HTMLElement }> {
    const doc: any = await createOfflineDocument({ validated: true });
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    lib.saveCurrentDevice();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const app = new AppUI(root, lib, new OfflineAdapter(doc), new FakeMidiAccess(), new BindingManager(device));
    app.render();
    return { root };
}

function selectControl(host: HTMLElement, ctlId: string) {
    const el = host.querySelector<HTMLElement>(`[data-ctl-id="${ctlId}"]`)!;
    el.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 9, clientX: 400, clientY: 300, button: 0, bubbles: true, cancelable: true }));
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 9, bubbles: true, cancelable: true }));
    expect(el.classList.contains("selected")).toBe(true);
}

function selectGroup(host: HTMLElement, grpId: string) {
    const el = host.querySelector<HTMLElement>(`[data-grp-id="${grpId}"]`)!;
    el.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 10, clientX: 300, clientY: 300, button: 0, bubbles: true, cancelable: true }));
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 10, bubbles: true, cancelable: true }));
    expect(el.classList.contains("selected")).toBe(true);
}

function uiKey(key: string, target: EventTarget = document.body): KeyboardEvent {
    const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
    return ev;
}

function toastText(): string {
    return Array.from(document.body.querySelectorAll("div"))
        .map((d) => d.innerText ?? "")
        .join("\n");
}

const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    const toastContainer = (Toast as unknown as { container: HTMLElement | null }).container;
    if (toastContainer) {
        toastContainer.innerHTML = "";
        document.body.appendChild(toastContainer);
    }
});

describe("G-06: keyboard Delete/Backspace and Learn Escape", () => {

    it("1. Delete on a selected control uses the existing delete path (archives the control)", () => {
        const device = new Device("D1");
        const c = addKnob(device, "Cut", 100, 100);
        const host = mountEditor(device);
        selectControl(host, c.id);

        const ev = uiKey("Delete");

        expect(ev.defaultPrevented).toBe(true);
        expect(device.getControl(c.id)!.archived).toBe(true);
        expect(toastText()).toContain("Control archived. Preset references remain valid.");
    });

    it("2. Backspace on a selected control uses the existing delete path (archives the control)", () => {
        const device = new Device("D2");
        const c = addKnob(device, "Cut", 100, 100);
        const host = mountEditor(device);
        selectControl(host, c.id);

        const ev = uiKey("Backspace");

        expect(ev.defaultPrevented).toBe(true);
        expect(device.getControl(c.id)!.archived).toBe(true);
        expect(toastText()).toContain("Control archived. Preset references remain valid.");
    });

    it("3. Delete/Backspace do nothing when no control is selected", () => {
        const device = new Device("D3");
        const c = addKnob(device, "Cut", 100, 100);
        mountEditor(device);

        const ev1 = uiKey("Delete");
        const ev2 = uiKey("Backspace");

        expect(ev1.defaultPrevented).toBe(false);
        expect(ev2.defaultPrevented).toBe(false);
        expect(device.getControl(c.id)!.archived).toBe(false);
        expect(toastText()).not.toContain("Control archived");
    });

    it("keyboard Delete never deletes a selected group", () => {
        const device = new Device("D4");
        const g = new Group("G", { x: 100, y: 100 }, { width: 240, height: 180 });
        device.addGroup(g);
        const host = mountEditor(device);
        selectGroup(host, g.id);

        const ev = uiKey("Delete");

        expect(ev.defaultPrevented).toBe(false);
        expect(device.groups.size).toBe(1);
        expect(device.getGroup(g.id)).toBeDefined();
    });

    it("4. Delete/Backspace/Escape do nothing in USE mode", async () => {
        const device = new Device("D5");
        const c = addKnob(device, "Cut", 100, 100);
        const { root } = await mountApp(device);

        const el = root.querySelector<HTMLElement>(`[data-ctl-id="${c.id}"]`)!;
        el.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 11, clientX: 400, clientY: 300, button: 0, bubbles: true, cancelable: true }));
        document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 11, bubbles: true, cancelable: true }));

        const toggle = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
            b.innerText === "USE",
        )!;
        toggle.click();

        for (const key of ["Delete", "Backspace", "Escape"]) {
            const ev = uiKey(key);
            expect(ev.defaultPrevented).toBe(false);
        }

        expect(device.getControl(c.id)!.archived).toBe(false);
        expect(toastText()).not.toContain("Control archived");
    });

    it("5. Escape cancels an armed MIDI Learn via the existing cancel path", async () => {
        const device = new Device("D6");
        const c = addKnob(device, "Cut", 100, 100);
        const midi = new FakeMidiAccess();
        const host = mountEditor(device, midi);

        const midiBtn = host.querySelector<HTMLButtonElement>(`[data-ctl-id="${c.id}"] button[title*="MIDI-learn"]`)!;
        expect(midiBtn).toBeDefined();
        midiBtn.click();

        expect(host.querySelector(".learn-bar")).not.toBeNull();
        expect(midi.installedHandler).not.toBeNull();

        const ev = uiKey("Escape");

        expect(ev.defaultPrevented).toBe(true);
        expect(host.querySelector(".learn-bar")).toBeNull();
        expect(c.midiBindingDefinition).toBeUndefined();
        expect(midi.installedHandler).not.toBeNull();

        await settle();
        expect(toastText()).toContain("MIDI Learn cancelled.");
    });

    it("6. Escape with no active Learn makes no state change and is not consumed", () => {
        const device = new Device("D7");
        const c = addKnob(device, "Cut", 100, 100);
        const host = mountEditor(device);

        const ev = uiKey("Escape");

        expect(ev.defaultPrevented).toBe(false);
        expect(host.querySelector(".learn-bar")).toBeNull();
        expect(c.midiBindingDefinition).toBeUndefined();
    });

    it("7. does not hijack text/editable input contexts", () => {
        const device = new Device("D8");
        const c = addKnob(device, "Cut", 100, 100);
        const host = mountEditor(device);
        selectControl(host, c.id);

        const input = document.createElement("input");
        document.body.appendChild(input);
        input.focus();

        for (const key of ["Delete", "Backspace", "Escape"]) {
            const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
            input.dispatchEvent(ev);
            expect(ev.defaultPrevented).toBe(false);
        }
        expect(device.getControl(c.id)!.archived).toBe(false);
        expect(toastText()).not.toContain("Control archived");
    });

    it("modifier shortcuts (Ctrl/Meta) are never intercepted", () => {
        const device = new Device("D9");
        const c = addKnob(device, "Cut", 100, 100);
        const host = mountEditor(device);
        selectControl(host, c.id);

        const ev = new KeyboardEvent("keydown", { key: "Delete", ctrlKey: true, bubbles: true, cancelable: true });
        document.body.dispatchEvent(ev);

        expect(ev.defaultPrevented).toBe(false);
        expect(device.getControl(c.id)!.archived).toBe(false);
        expect(toastText()).not.toContain("Control archived");
    });
});