// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { createOfflineDocument } from "@audiotool/nexus/node";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { BindingManager } from "../../src/core/BindingManager";
import { AppUI } from "../../src/ui/AppUI";

/**
 * G-07 — the shared Library toolbar button uses one consistent user-facing
 * label ("Library") in both EDIT and USE modes; its collapse action is
 * unchanged.
 */

class OfflineAdapter extends NexusAdapter {
    constructor(doc: any) {
        super();
        this.document = doc;
    }
    public override updateBoundControl(_controlId: string, _value: number): Promise<boolean> {
        return Promise.resolve(true);
    }
}

class CapturingMidi extends MidiAccess {
    public override setMessageHandler(_callback: (channel: number, cc: number, value: number) => void) {
        // no-op
    }
}

function buildDevice(): Device {
    const device = new Device("G07");
    const c = new Control("knob", "Gain", undefined, "gain");
    device.addControl(c);
    return device;
}

async function mount(): Promise<{ root: HTMLElement }> {
    const doc: any = await createOfflineDocument({ validated: true });
    const lib = new DeviceLibrary();
    lib.currentDevice = buildDevice();
    lib.saveCurrentDevice();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const app = new AppUI(root, lib, new OfflineAdapter(doc), new CapturingMidi(), new BindingManager(lib.currentDevice!));
    app.render();
    return { root };
}

function button(root: HTMLElement, label: string): HTMLButtonElement | undefined {
    return [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.innerText === label);
}

function modeToggle(root: HTMLElement): HTMLButtonElement | undefined {
    return [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        b.innerText === "USE" || b.innerText === "EDIT",
    );
}

describe("G-07: consistent Library button label across modes", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
    });

    it("exposes the same 'Library' label in EDIT and USE, with no 'Device Library' label", async () => {
        const { root } = await mount();

        expect(button(root, "Device Library")).toBeUndefined();
        const editBtn = button(root, "Library");
        expect(editBtn).toBeDefined();

        const toggle = modeToggle(root)!;
        expect(toggle).toBeDefined();
        toggle.click();

        expect(button(root, "Device Library")).toBeUndefined();
        const useBtn = button(root, "Library");
        expect(useBtn).toBeDefined();
        expect(useBtn!.innerText).toBe(editBtn!.innerText);
    });

    it("keeps the collapse action wired to the single Library button", async () => {
        const { root } = await mount();

        const libBtn = button(root, "Library")!;
        expect(libBtn.className).toContain("active");

        libBtn.click();
        const rebuilt = button(root, "Library")!;
        expect(rebuilt.className).not.toContain("active");

        rebuilt.click();
        expect(button(root, "Library")!.className).toContain("active");
    });
});