// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { Group } from "../../src/core/model/Group";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { EditorUI } from "../../src/ui/editor/EditorUI";
import { DeviceHistory } from "../../src/core/history/DeviceHistory";

function addKnob(device: Device, name: string, x: number, y: number): Control {
    const c = new Control("knob", name, { x, y });
    device.addControl(c);
    return c;
}

function mountEditor(device: Device, history: DeviceHistory): { host: HTMLElement; ui: EditorUI } {
    const library = new DeviceLibrary();
    library.currentDevice = device;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const ui = new EditorUI(library, undefined, undefined, undefined, undefined, undefined, history);
    ui.render(host);
    return { host, ui };
}

/** Mirrors a real double-click on the control name label. */
function doubleClickLabel(label: HTMLElement) {
    for (let i = 0; i < 2; i++) {
        label.dispatchEvent(new PointerEvent("pointerdown", { pointerId: i + 1, clientX: 10, clientY: 10, button: 0, bubbles: true, cancelable: true }));
        label.dispatchEvent(new PointerEvent("pointerup", { pointerId: i + 1, bubbles: true, cancelable: true }));
        label.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }
    label.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

describe("Control nameSource tracking (M3)", () => {

    it("1 — a new control can carry nameSource = auto | manual", () => {
        const c = new Control("knob", "Knob");
        expect(c.nameSource).toBeUndefined();

        c.nameSource = "auto";
        expect(c.nameSource).toBe("auto");

        c.nameSource = "manual";
        expect(c.nameSource).toBe("manual");
    });

    it("2 — serialization preserves nameSource", () => {
        const device = new Device("D");
        const c = addKnob(device, "Pulverisateur / cutoff", 100, 100);
        c.nameSource = "auto";

        const restored = Device.deserialize(device.serialize());
        expect(restored.getControl(c.id)?.nameSource).toBe("auto");
        expect(restored.getControl(c.id)?.name).toBe("Pulverisateur / cutoff");
    });

    it("2b — nameSource survives the JSON round-trip used by Storage", () => {
        const device = new Device("D");
        const c = addKnob(device, "Delay / feedbackFactor", 0, 0);
        c.nameSource = "auto";

        const json = JSON.parse(JSON.stringify(device.serialize()));
        const restored = Device.deserialize(json);
        expect(restored.getControl(c.id)?.nameSource).toBe("auto");
    });

    it("3 — deserialization preserves nameSource for both values", () => {
        const device = new Device("D");
        const auto = addKnob(device, "A", 0, 0);
        auto.nameSource = "auto";
        const manual = addKnob(device, "B", 100, 0);
        manual.nameSource = "manual";

        const restored = Device.deserialize(device.serialize());
        expect(restored.getControl(auto.id)?.nameSource).toBe("auto");
        expect(restored.getControl(manual.id)?.nameSource).toBe("manual");
    });

    it("4 — legacy controls without the field still load correctly", () => {
        const device = new Device("D");
        const c = addKnob(device, "Cutoff", 100, 100);

        // Simulate pre-M3 stored data: the property is genuinely absent.
        const legacy = JSON.parse(JSON.stringify(device.serialize())) as any;
        delete legacy.controls[0].nameSource;

        const restored = Device.deserialize(legacy);
        expect(restored.getControl(c.id)?.name).toBe("Cutoff");
        expect(restored.getControl(c.id)?.nameSource).toBeUndefined();
    });

    it("4b — undefined nameSource is omitted from serialized output (keeps old data shape)", () => {
        const device = new Device("D");
        const c = addKnob(device, "Cutoff", 100, 100);
        c.nameSource = undefined;

        const json = JSON.parse(JSON.stringify(device.serialize())) as any;
        expect(Object.prototype.hasOwnProperty.call(json.controls[0], "nameSource")).toBe(false);
    });

    it("5 — manual rename via the UI sets nameSource = manual", () => {
        const device = new Device("D");
        const a = addKnob(device, "Knob", 100, 100);
        const library = new DeviceLibrary();
        library.currentDevice = device;
        const history = new DeviceHistory(library);
        const { host } = mountEditor(device, history);

        const label = host.querySelector<HTMLElement>(`[data-ctl-id="${a.id}"] .control-name`)!;
        doubleClickLabel(label);
        const input = label.querySelector<HTMLInputElement>("input")!;
        input.value = "MY KNOB";
        input.blur();

        expect(a.name).toBe("MY KNOB");
        expect(a.nameSource).toBe("manual");
    });

    it("6 — undo restores both name and nameSource", () => {
        const device = new Device("D");
        const a = addKnob(device, "Knob", 100, 100);
        const library = new DeviceLibrary();
        library.currentDevice = device;
        const history = new DeviceHistory(library);
        const { host } = mountEditor(device, history);

        const label = host.querySelector<HTMLElement>(`[data-ctl-id="${a.id}"] .control-name`)!;
        doubleClickLabel(label);
        const input = label.querySelector<HTMLInputElement>("input")!;
        input.value = "BASS";
        input.blur();

        // Before undo: renamed manually.
        expect(a.name).toBe("BASS");
        expect(a.nameSource).toBe("manual");
        expect(history.canUndo).toBe(true);

        history.undo();
        expect(a.name).toBe("Knob");
        expect(a.nameSource).toBeUndefined();
    });

    it("7 — redo reapplies both name and nameSource", () => {
        const device = new Device("D");
        const a = addKnob(device, "Knob", 100, 100);
        const library = new DeviceLibrary();
        library.currentDevice = device;
        const history = new DeviceHistory(library);
        const { host } = mountEditor(device, history);

        const label = host.querySelector<HTMLElement>(`[data-ctl-id="${a.id}"] .control-name`)!;
        doubleClickLabel(label);
        const input = label.querySelector<HTMLInputElement>("input")!;
        input.value = "BASS";
        input.blur();

        history.undo();
        expect(a.name).toBe("Knob");
        expect(a.nameSource).toBeUndefined();

        expect(history.redo()).toBe(true);
        expect(a.name).toBe("BASS");
        expect(a.nameSource).toBe("manual");
    });

    it("6b — renaming an auto-named control undoes to the previous auto state", () => {
        const device = new Device("D");
        const a = addKnob(device, "Pulverisateur / cutoff", 100, 100);
        a.nameSource = "auto";
        const library = new DeviceLibrary();
        library.currentDevice = device;
        const history = new DeviceHistory(library);
        const { host } = mountEditor(device, history);

        const label = host.querySelector<HTMLElement>(`[data-ctl-id="${a.id}"] .control-name`)!;
        doubleClickLabel(label);
        const input = label.querySelector<HTMLInputElement>("input")!;
        input.value = "RENAMED";
        input.blur();

        expect(a.name).toBe("RENAMED");
        expect(a.nameSource).toBe("manual");

        history.undo();
        expect(a.name).toBe("Pulverisateur / cutoff");
        expect(a.nameSource).toBe("auto");

        history.redo();
        expect(a.name).toBe("RENAMED");
        expect(a.nameSource).toBe("manual");
    });

    it("legacy controls without the field are bound-safe: no nameSource ever leaks to Groups", () => {
        const device = new Device("D");
        const a = addKnob(device, "A", 0, 0);
        addKnob(device, "B", 100, 0);
        const g = new Group("FILTER", { x: 0, y: 0 }, { width: 100, height: 100 });
        device.addGroup(g);

        const restored = Device.deserialize(device.serialize());
        expect((restored.getGroup(g.id) as any).nameSource).toBeUndefined();
        expect(restored.getControl(a.id)?.nameSource).toBeUndefined();
    });
});