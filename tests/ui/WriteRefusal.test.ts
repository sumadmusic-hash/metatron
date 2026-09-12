// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOfflineDocument } from "@audiotool/nexus/node";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { AppUI } from "../../src/ui/AppUI";
import { Toast } from "../../src/ui/Toast";
import { WRITE_REFUSED_CLASS, WRITE_REFUSED_TITLE } from "../../src/ui/writeRefusal";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { BindingManager } from "../../src/core/BindingManager";
import { MidiAccess } from "../../src/midi/MidiAccess";
import type { MidiBindingDefinition } from "../../src/core/model/types";

class CapturingMidi extends MidiAccess {
    public installedHandler: ((channel: number, cc: number, value: number) => void) | null = null;
    public override setMessageHandler(callback: (channel: number, cc: number, value: number) => void) {
        this.installedHandler = callback;
    }
    public trigger(channel: number, cc: number, value: number) {
        this.installedHandler?.(channel, cc, value);
    }
}

class ToggleAdapter extends NexusAdapter {
    private doc: any;
    public refusing = false;
    constructor(doc: any) {
        super();
        this.doc = doc;
        this.document = doc;
    }
    public override updateBoundControl(_controlId: string, _value: number): Promise<boolean> {
        return Promise.resolve(!this.refusing);
    }
}

function addKnob(device: Device, name: string, cc: number, id = `${name.toLowerCase()}`): Control {
    const c = new Control("knob", name, { x: 100, y: 100 }, id);
    c.midiBindingDefinition = { channel: 1, cc } as MidiBindingDefinition;
    device.addControl(c);
    return c;
}

async function mount(device: Device): Promise<{ root: HTMLElement; midi: CapturingMidi; adapter: ToggleAdapter }> {
    const doc: any = await createOfflineDocument({ validated: true });
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    lib.saveCurrentDevice();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const midi = new CapturingMidi();
    const adapter = new ToggleAdapter(doc);
    const app = new AppUI(root, lib, adapter, midi, new BindingManager(device));
    app.render();
    const toggle = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        b.innerText === "USE",
    );
    toggle?.click();
    return { root, midi, adapter };
}

const wrapper = (root: HTMLElement, id: string) => root.querySelector<HTMLElement>(`[data-ctl-id="${id}"]`)!;
const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function toastText(): string {
    return Array.from(document.body.querySelectorAll("div"))
        .map((d) => d.innerText ?? "")
        .join("\n");
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    const toastContainer = (Toast as unknown as { container: HTMLElement | null }).container;
    if (toastContainer) {
        toastContainer.innerHTML = "";
        document.body.appendChild(toastContainer);
    }
});

describe("G-04: silent write-refusal indicator on Controls", () => {

    it("1. a refused write marks the correct Control with the refusal class", async () => {
        const device = new Device("G4-1");
        const c = addKnob(device, "Cut", 20);
        const { root, midi, adapter } = await mount(device);
        adapter.refusing = true;

        expect(wrapper(root, c.id).classList.contains(WRITE_REFUSED_CLASS)).toBe(false);

        midi.trigger(1, 20, 100);
        await settle();

        expect(wrapper(root, c.id).classList.contains(WRITE_REFUSED_CLASS)).toBe(true);
    });

    it("2. the refusal state exposes the user-facing explanation via title", async () => {
        const device = new Device("G4-2");
        const c = addKnob(device, "Cut", 20);
        const { root, midi, adapter } = await mount(device);
        adapter.refusing = true;

        expect(wrapper(root, c.id).hasAttribute("title")).toBe(false);

        midi.trigger(1, 20, 100);
        await settle();

        expect(wrapper(root, c.id).title).toBe(WRITE_REFUSED_TITLE);
        expect(wrapper(root, c.id).title).toBe("Audiotool did not accept this value.");
    });

    it("3. a successful subsequent write clears the refusal", async () => {
        const device = new Device("G4-3");
        const c = addKnob(device, "Cut", 20);
        const { root, midi, adapter } = await mount(device);
        adapter.refusing = true;

        midi.trigger(1, 20, 100);
        await settle();
        expect(wrapper(root, c.id).classList.contains(WRITE_REFUSED_CLASS)).toBe(true);

        adapter.refusing = false;
        midi.trigger(1, 20, 100);
        await settle();

        expect(wrapper(root, c.id).classList.contains(WRITE_REFUSED_CLASS)).toBe(false);
        expect(wrapper(root, c.id).hasAttribute("title")).toBe(false);
    });

    it("4. a refusal on one Control does not mark another Control", async () => {
        const device = new Device("G4-4");
        const a = addKnob(device, "Cut", 20);
        const b = addKnob(device, "Res", 21);
        const { root, midi, adapter } = await mount(device);
        adapter.refusing = true;

        midi.trigger(1, 20, 100);
        await settle();

        expect(wrapper(root, a.id).classList.contains(WRITE_REFUSED_CLASS)).toBe(true);
        expect(wrapper(root, b.id).classList.contains(WRITE_REFUSED_CLASS)).toBe(false);
        expect(wrapper(root, b.id).hasAttribute("title")).toBe(false);
    });

    it("5. repeated refused writes produce no toast notifications", async () => {
        const device = new Device("G4-5");
        const c = addKnob(device, "Cut", 20);
        const { root, midi, adapter } = await mount(device);
        adapter.refusing = true;

        for (let i = 0; i < 6; i++) {
            midi.trigger(1, 20, 10 + i);
        }
        await settle();

        expect(wrapper(root, c.id).classList.contains(WRITE_REFUSED_CLASS)).toBe(true);
        expect(toastText()).not.toContain("Audiotool");
        expect(toastText()).not.toContain("refused");
    });

    it("6. an accepted write is unchanged: marked never + value persisted", async () => {
        const device = new Device("G4-6");
        const c = addKnob(device, "Cut", 20);
        const { root, midi } = await mount(device);
        vi.spyOn(console, "warn");

        midi.trigger(1, 20, 100);
        await settle();

        expect(wrapper(root, c.id).classList.contains(WRITE_REFUSED_CLASS)).toBe(false);
        expect(wrapper(root, c.id).hasAttribute("title")).toBe(false);
        expect(c.value).toBeCloseTo(100 / 127, 2);
        expect(device.getControl(c.id)!.value).toBeCloseTo(100 / 127, 2);
    });
});