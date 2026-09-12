// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { BindingManager } from "../../src/core/BindingManager";
import { AppUI } from "../../src/ui/AppUI";
import type { MidiBindingDefinition } from "../../src/core/model/types";

/** Real production pipeline classes; only MIDI input is injected via a fake
 *  handler capture (same pattern as tests/midi/MidiLearn.test.ts). */
class FakeMidiAccess extends MidiAccess {
    public installedHandler: ((channel: number, cc: number, value: number) => void) | null = null;

    public override setMessageHandler(callback: (channel: number, cc: number, value: number) => void) {
        this.installedHandler = callback;
    }

    public trigger(channel: number, cc: number, value: number) {
        this.installedHandler?.(channel, cc, value);
    }
}

const settle = (ms = 20) => new Promise<void>((r) => setTimeout(r, ms));

function knob(device: Device, id: string, def?: MidiBindingDefinition): Control {
    const c = new Control("knob", id, { x: 10, y: 10 }, id);
    c.midiBindingDefinition = def;
    device.addControl(c);
    return c;
}

function mount(device: Device) {
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    lib.saveCurrentDevice();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const midi = new FakeMidiAccess();
    new AppUI(root, lib, new NexusAdapter(), midi, new BindingManager(device)).render();
    // Mount the USE-mode surface (MIDI ends up in the surface DOM).
    const toggle = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.innerText === "USE",
    )!;
    toggle.click();
    return { root, midi, lib, device };
}

const box = (root: HTMLElement, id: string) => root.querySelector<HTMLElement>(`[data-ctl-id="${id}"]`)!;
const act = (root: HTMLElement, id: string) => box(root, id).querySelector<HTMLElement>(".use-actions")!;
const select = (root: HTMLElement, id: string) =>
    box(root, id).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
const readoutOf = (root: HTMLElement, id: string) =>
    act(root, id).querySelector(".use-midi-readout")?.textContent ?? "";
const field = (root: HTMLElement, id: string, name: string) =>
    act(root, id).querySelector<HTMLInputElement>(`[data-scaling="${name}"]`);
const midiButton = (root: HTMLElement, id: string) =>
    [...act(root, id).querySelectorAll<HTMLButtonElement>("button")].find((b) => b.innerText === "MIDI")!;
const unmapButton = (root: HTMLElement, id: string) =>
    act(root, id).querySelector<HTMLButtonElement>(".use-midi-map .mini-btn");
const setNumber = (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
};
const setCheck = (input: HTMLInputElement, checked: boolean) => {
    input.checked = checked;
    input.dispatchEvent(new Event("change", { bubbles: true }));
};

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

describe("SurfaceUI — MIDI mapping management + scaling editor (C2 §7/§9)", () => {
    it("1. a mapped control shows Ch/CC", () => {
        const d = new Device("T");
        knob(d, "a", { channel: 1, cc: 20 });
        const { root } = mount(d);
        select(root, "a");
        expect(readoutOf(root, "a")).toBe("Ch 1 / CC 20");
    });

    it("2. an unmapped control shows Unmapped", () => {
        const d = new Device("T");
        knob(d, "a", undefined);
        const { root } = mount(d);
        select(root, "a");
        expect(readoutOf(root, "a")).toBe("Unmapped");
    });

    it("3+4. Unmap clears mapping on the production path and forward lookup stops", () => {
        const d = new Device("T");
        const a = knob(d, "a", { channel: 1, cc: 20 });
        const { root, midi, lib } = mount(d);
        select(root, "a");
        const saveSpy = vi.spyOn(lib, "saveCurrentDevice");

        unmapButton(root, "a")!.click();

        expect(a.midiBindingDefinition).toBeUndefined();
        expect(saveSpy).toHaveBeenCalled();
        expect(readoutOf(root, "a")).toBe("Unmapped");
        midi.trigger(1, 20, 100);
        expect(a.value).toBe(0);
    });

    it("5+6+7. min/max/flip/exponent are stored via the production path", () => {
        const d = new Device("T");
        const a = knob(d, "a", { channel: 1, cc: 20, min: 0.2, max: 0.9 });
        const { root, lib } = mount(d);
        select(root, "a");
        const saveSpy = vi.spyOn(lib, "saveCurrentDevice");

        setNumber(field(root, "a", "min")!, "0.35");
        setNumber(field(root, "a", "max")!, "0.8");
        setCheck(field(root, "a", "flip")!, true);
        setNumber(field(root, "a", "exponent")!, "2.5");

        expect(a.midiBindingDefinition).toEqual({
            channel: 1, cc: 20, min: 0.35, max: 0.8, flip: true, exponent: 2.5,
        });
        expect(saveSpy).toHaveBeenCalled();
    });

    it("8. out-of-range UI values are never persisted as-is; invalid input reverts the field", () => {
        const d = new Device("T");
        const a = knob(d, "a", { channel: 1, cc: 20, min: 0.4, max: 0.9, exponent: 2 });
        const { root, lib } = mount(d);
        select(root, "a");
        const saveSpy = vi.spyOn(lib, "saveCurrentDevice");

        setNumber(field(root, "a", "min")!, "-0.7"); // clamp → 0
        expect(a.midiBindingDefinition?.min).toBe(0);
        setNumber(field(root, "a", "min")!, "1.6");  // clamp → 1
        expect(a.midiBindingDefinition?.min).toBe(1);
        const callsAfterValidEdits = saveSpy.mock.calls.length;
        expect(callsAfterValidEdits).toBeGreaterThan(0);

        // invalid exponent inputs: model unchanged, nothing persisted,
        // and the visible field is reset to the stored model value (F-4)
        setNumber(field(root, "a", "exponent")!, "0");  // revert
        expect(a.midiBindingDefinition?.exponent).toBe(2);
        expect(saveSpy.mock.calls.length).toBe(callsAfterValidEdits);
        expect(field(root, "a", "exponent")?.value).toBe("2");

        setNumber(field(root, "a", "exponent")!, "-3"); // revert
        expect(a.midiBindingDefinition?.exponent).toBe(2);
        expect(saveSpy.mock.calls.length).toBe(callsAfterValidEdits);
        expect(field(root, "a", "exponent")?.value).toBe("2");

        setNumber(field(root, "a", "exponent")!, "");   // revert
        expect(a.midiBindingDefinition?.exponent).toBe(2);
        expect(saveSpy.mock.calls.length).toBe(callsAfterValidEdits);
        expect(field(root, "a", "exponent")?.value).toBe("2");
    });

    it("9. editing one control's scaling never touches another control", () => {
        const d = new Device("T");
        const a = knob(d, "a", { channel: 1, cc: 20, min: 0.1 });
        const b = knob(d, "b", { channel: 2, cc: 30, min: 0.5, max: 0.8, flip: true, exponent: 3 });
        const { root } = mount(d);
        select(root, "a");

        setNumber(field(root, "a", "min")!, "0.9");

        expect(a.midiBindingDefinition?.min).toBe(0.9);
        expect(b.midiBindingDefinition).toEqual({ channel: 2, cc: 30, min: 0.5, max: 0.8, flip: true, exponent: 3 });
    });

    it("10. archived controls offer no mapping/scaling controls at all", () => {
        const d = new Device("T");
        const g = knob(d, "gone", { channel: 1, cc: 20 });
        g.softDelete();
        knob(d, "live", { channel: 2, cc: 30 });
        const { root } = mount(d);
        expect(root.querySelector('[data-ctl-id="gone"]')).toBeNull();
        expect(root.querySelector('[data-ctl-id="live"]')).not.toBeNull();
    });

    it("11. MIDI-Learn still assigns a new mapping and routes it", async () => {
        const d = new Device("T");
        const a = knob(d, "a", undefined);
        const { root, midi } = mount(d);
        select(root, "a");
        expect(readoutOf(root, "a")).toBe("Unmapped");

        midiButton(root, "a").click();
        await settle(10);
        midi.trigger(5, 77, 100); // first CC captured by learn
        await settle(40);

        expect(a.midiBindingDefinition).toEqual({ channel: 5, cc: 77 });
        expect(readoutOf(root, "a")).toBe("Ch 5 / CC 77");

        midi.trigger(5, 77, 64); // routed through the normal pipeline again
        expect(a.value).toBeCloseTo(64 / 127, 10);
    });

    it("12. existing scaling survives MIDI-Learn (channel/cc replaced only)", async () => {
        const d = new Device("T");
        const a = knob(d, "a", { channel: 1, cc: 20, min: 0.3, max: 0.7, flip: true, exponent: 2 });
        const { root, midi } = mount(d);
        select(root, "a");

        midiButton(root, "a").click();
        await settle(10);
        midi.trigger(2, 50, 100);
        await settle(40);

        expect(a.midiBindingDefinition).toEqual({ channel: 2, cc: 50, min: 0.3, max: 0.7, flip: true, exponent: 2 });
    });

    it("13. an incomplete definition ({min: 0.5}) shows Unmapped but NO scaling editor", () => {
        const d = new Device("T");
        knob(d, "a", { min: 0.5 });
        const { root } = mount(d);
        select(root, "a");

        expect(readoutOf(root, "a")).toBe("Unmapped");
        expect(act(root, "a").querySelector(".use-midi-scaling")).toBeNull();
        expect(field(root, "a", "min")).toBeNull();
        expect(field(root, "a", "flip")).toBeNull();
    });

    it("14. a fully mapped control shows the scaling editor", () => {
        const d = new Device("T");
        knob(d, "a", { channel: 1, cc: 20, min: 0.3 });
        const { root } = mount(d);
        select(root, "a");

        expect(readoutOf(root, "a")).toBe("Ch 1 / CC 20");
        expect(act(root, "a").querySelector(".use-midi-scaling")).not.toBeNull();
        expect(field(root, "a", "min")?.value).toBe("0.3");
    });
});