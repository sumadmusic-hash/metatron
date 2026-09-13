// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOfflineDocument } from "@audiotool/nexus/node";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { StorageError } from "../../src/persistence/Storage";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { BindingManager } from "../../src/core/BindingManager";
import { AppUI } from "../../src/ui/AppUI";

/**
 * Save failure surfacing: a StorageError during DeviceLibraryUI.saveCurrentDevice
 * must surface an ERROR toast and MUST NOT show a success toast (§54: no silent
 * failures).
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
    const device = new Device("HDR");
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

describe("DeviceLibraryUI — save failure is surfaced, never silent", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
    });

    it("shows an ERROR toast and NO success toast when saveCurrentDevice throws StorageError", async () => {
        const { root } = await mount();

        const spy = vi.spyOn(DeviceLibrary.prototype, "saveCurrentDevice").mockImplementation(() => {
            throw new StorageError("quota exceeded");
        });

        const saveBtn = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.innerText === "Save")!;
        expect(saveBtn).toBeTruthy();
        saveBtn.click();

        expect(document.body.innerText).toContain("Speichern fehlgeschlagen: quota exceeded");
        expect(document.body.innerText).not.toContain("Device saved.");

        spy.mockRestore();
    });
});