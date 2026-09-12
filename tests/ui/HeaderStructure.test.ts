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
 * Header Restructure B — the main toolbar is split into a left and a right
 * flex group; the mode toggle lives alone in the right group as the final
 * header control. The automation strip is in a separate .automation-bar
 * below the main toolbar. All existing elements, labels and wiring are
 * preserved.
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

function toolbar(root: HTMLElement): HTMLElement {
    return root.querySelector<HTMLElement>(".toolbar")!;
}

function leftGroup(root: HTMLElement): HTMLElement {
    return toolbar(root).querySelector<HTMLElement>(".toolbar-left")!;
}

function rightGroup(root: HTMLElement): HTMLElement {
    return toolbar(root).querySelector<HTMLElement>(".toolbar-right")!;
}

function automationBar(root: HTMLElement): HTMLElement {
    return root.querySelector<HTMLElement>(".automation-bar")!;
}

function buttonsIn(el: HTMLElement): HTMLButtonElement[] {
    return [...el.querySelectorAll<HTMLButtonElement>("button")];
}

function modeToggle(root: HTMLElement): HTMLButtonElement {
    return buttonsIn(root).find((b) => b.innerText === "USE" || b.innerText === "EDIT")!;
}

describe("Header Restructure B: two-group layout with EDIT/USE as final control, automation in secondary bar", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
    });

    it("groups the header into .toolbar-left and .toolbar-right, with EDIT/USE as the last control", async () => {
        const { root } = await mount();

        const left = leftGroup(root);
        const right = rightGroup(root);
        expect(left).toBeTruthy();
        expect(right).toBeTruthy();

        // Left group: title, Library, connection UI (URL + Connect + status), Undo, Redo.
        expect(left.querySelector(".app-title")).toBeTruthy();
        expect(buttonsIn(left).map((b) => b.innerText)).toEqual(
            expect.arrayContaining(["Library", "Connect", "Undo", "Redo"]),
        );
        expect(left.querySelector<HTMLInputElement>("input[placeholder='Audiotool Project URL...']")).toBeTruthy();

        // Right group: the mode toggle is the sole rightmost header control.
        expect(right.querySelector(".automation-strip")).toBeNull();
        const rightButtons = buttonsIn(right);
        expect(rightButtons).toHaveLength(1);
        expect(rightButtons[0].innerText).toBe("USE");
        expect(right.lastElementChild).toBe(modeToggle(root));

        // The mode toggle is also the final control of the whole toolbar.
        const all = buttonsIn(toolbar(root));
        expect(all[all.length - 1]).toBe(modeToggle(root));

        // Automation strip is in its own secondary bar.
        const aBar = automationBar(root);
        expect(aBar).toBeTruthy();
        expect(aBar.querySelector(".automation-strip")).toBeTruthy();
    });

    it("still toggles from EDIT to USE and keeps EDIT/USE rightmost in USE mode", async () => {
        const { root } = await mount();

        modeToggle(root).click(); // EDIT -> USE

        // In USE mode the editor toolbar is gone; surface renders instead.
        expect(root.querySelector(".editor-toolbar")).toBeNull();
        expect(root.querySelector(".editor-canvas")).toBeTruthy();

        // Right group survived the rebuild; the mode toggle remains final.
        const right = rightGroup(root);
        expect(right).toBeTruthy();
        expect(right.querySelector(".automation-strip")).toBeNull();
        const rightButtons = buttonsIn(right);
        expect(rightButtons[rightButtons.length - 1].innerText).toBe("EDIT");
        expect(right.lastElementChild).toBe(modeToggle(root));

        // Automation strip is still in its own bar after mode switch.
        expect(automationBar(root).querySelector(".automation-strip")).toBeTruthy();
    });

    it("toggles from USE back to EDIT", async () => {
        const { root } = await mount();

        modeToggle(root).click(); // EDIT -> USE
        modeToggle(root).click(); // USE -> EDIT

        expect(root.querySelector(".editor-canvas")).toBeTruthy();
        const rightButtons = buttonsIn(rightGroup(root));
        expect(rightButtons[rightButtons.length - 1].innerText).toBe("USE");
        expect(rightGroup(root).lastElementChild).toBe(modeToggle(root));
    });

    it("keeps the Library button working in the left group", async () => {
        const { root } = await mount();

        const libBtn = buttonsIn(leftGroup(root)).find((b) => b.innerText === "Library")!;
        expect(libBtn).toBeTruthy();
        expect(libBtn.className).toContain("active");

        libBtn.click();
        expect(buttonsIn(leftGroup(root)).find((b) => b.innerText === "Library")!.className).not.toContain("active");

        buttonsIn(leftGroup(root)).find((b) => b.innerText === "Library")!.click();
        expect(buttonsIn(leftGroup(root)).find((b) => b.innerText === "Library")!.className).toContain("active");
    });

    it("keeps Undo/Redo working: + Knob records history, Undo removes it, Redo restores it", async () => {
        const { root } = await mount();

        const wrappers = () => root.querySelectorAll(".control-wrapper").length;
        expect(wrappers()).toBe(1); // the seeded "Gain" knob

        buttonsIn(root).find((b) => b.innerText === "+ Knob")!.click();
        expect(wrappers()).toBe(2);
        expect(document.getElementById("history-undo")).toBeTruthy();

        buttonsIn(root).find((b) => b.innerText === "Undo")!.click();
        expect(wrappers()).toBe(1);

        buttonsIn(root).find((b) => b.innerText === "Redo")!.click();
        expect(wrappers()).toBe(2);
    });

    it("keeps the automation strip wired in the automation bar (ARM -> REC -> STOP -> take -> CLEAR)", async () => {
        const { root } = await mount();
        const strip = () => automationBar(root).querySelector<HTMLElement>(".automation-strip")!;
        const status = () => strip().querySelector<HTMLElement>(".automation-status")!;
        const btn = (label: string) => buttonsIn(strip()).find((b) => b.innerText === label)!;

        ["ARM", "REC", "STOP", "APPLY TO AUDIOTOOL", "CLEAR"].forEach((label) => {
            expect(btn(label), `missing automation button ${label}`).toBeTruthy();
        });

        btn("ARM").click();
        expect(status().innerText).toBe("Armed — press REC to record");
        expect(btn("REC").disabled).toBe(false);

        btn("REC").click();
        expect(status().innerText).toBe("RECORDING");
        expect(btn("STOP").disabled).toBe(false);

        btn("STOP").click();
        expect(strip().querySelector(".automation-take")).toBeTruthy();

        btn("CLEAR").click();
        expect(strip().querySelector(".automation-take")).toBeFalsy();
        expect(status().innerText).toBe("IDLE");
    });

    it("removes no existing header functionality", async () => {
        const { root } = await mount();

        expect(root.querySelector(".app-title")!.textContent).toBe("Metatron | HDR");
        expect(buttonsIn(root).map((b) => b.innerText)).toEqual(
            expect.arrayContaining(["Library", "Connect", "Undo", "Redo"]),
        );
        expect(root.querySelector<HTMLInputElement>("input[placeholder='Audiotool Project URL...']")).toBeTruthy();
        expect(root.querySelector(".automation-strip")).toBeTruthy();
        expect(modeToggle(root)).toBeTruthy();
    });
});
