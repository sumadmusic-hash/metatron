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
 * Header Restructure — the toolbar is one card split into .header-left /
 * .header-center / .header-right clusters. Left holds logo + title + mode pill
 * + undo/redo; center is the USE-mode transport; right holds the connection
 * cluster, MOD toggle (USE), library toggle and user badge. EDIT renders the
 * BUILDER bar below the card, USE renders the automation bar only while a
 * take is live. The sidebar is docked on the right.
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
    return toolbar(root).querySelector<HTMLElement>(".header-left")!;
}

function centerGroup(root: HTMLElement): HTMLElement {
    return toolbar(root).querySelector<HTMLElement>(".header-center")!;
}

function rightGroup(root: HTMLElement): HTMLElement {
    return toolbar(root).querySelector<HTMLElement>(".header-right")!;
}

function builderBar(root: HTMLElement): HTMLElement | null {
    return root.querySelector<HTMLElement>(".builder-bar");
}

function automationBar(root: HTMLElement): HTMLElement {
    return root.querySelector<HTMLElement>(".automation-bar")!;
}

function buttonsIn(el: HTMLElement): HTMLButtonElement[] {
    return [...el.querySelectorAll<HTMLButtonElement>("button")];
}

function modeToggle(root: HTMLElement): HTMLButtonElement {
    return buttonsIn(root).find((b) => b.id === "mode-toggle-btn")!;
}

/** Switch the currently EDIT-mounted app into USE mode (the header-center
 *  transport and live automation chrome are USE-only). */
function toUseMode(root: HTMLElement) {
    modeToggle(root).click();
}

describe("Header Restructure: three-cluster card, USE transport center, BUILDER bar, right-docked sidebar", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
    });

    it("groups the standalone toolbar card into left/center/right, mode pill + undo/redo in the left cluster", async () => {
        const { root } = await mount();

        const left = leftGroup(root);
        const center = centerGroup(root);
        const right = rightGroup(root);
        expect(left).toBeTruthy();
        expect(center).toBeTruthy();
        expect(right).toBeTruthy();
        expect(document.documentElement.getAttribute("data-mode")).toBe("edit");

        // Left cluster: logo + title, mode pill (USE/EDIT) and undo/redo.
        expect(left.querySelector(".app-title")).toBeTruthy();
        expect(left.querySelector(".app-title .app-logo-wrap svg.app-logo-svg")).toBeTruthy();
        expect(left.querySelector(".app-title h1")!.textContent!.startsWith("Metatron")).toBe(true);

        const pill = left.querySelector<HTMLButtonElement>("#mode-toggle-btn")!;
        expect(pill.classList.contains("mode-pill")).toBe(true);
        expect((pill.querySelectorAll(".mode-pill-half")[0] as HTMLElement).textContent).toBe("USE");
        expect((pill.querySelectorAll(".mode-pill-half")[1] as HTMLElement).textContent).toBe("EDIT");
        expect((pill.querySelectorAll(".mode-pill-half")[0] as HTMLElement).classList.contains("active")).toBe(false);
        expect((pill.querySelectorAll(".mode-pill-half")[1] as HTMLElement).classList.contains("active")).toBe(true);

        const seg = left.querySelector(".toolbar-seg")!;
        expect(seg.querySelector("#history-undo")).toBeTruthy();
        expect(seg.querySelector("#history-redo")).toBeTruthy();

        // Center cluster is empty in EDIT (transport is USE-only).
        expect(center.querySelector(".transport")).toBeNull();

        // Right cluster: connection field + Connect + library toggle (+ badge when session user).
        expect(right.querySelector<HTMLInputElement>("input.conn-input[placeholder='Audiotool Project URL...']")).toBeTruthy();
        expect(right.querySelector(".conn-chip")).toBeTruthy();
        expect(buttonsIn(right).map((b) => b.innerText)).toEqual(expect.arrayContaining(["Connect", "Library"]));
        // MOD matrix toggle is USE-only chrome.
        expect(right.querySelector("#mod-matrix-toggle")).toBeNull();

        // BUILDER bar is EDIT-only; automation bar is only present with a live take.
        const builder = builderBar(root);
        expect(builder).toBeTruthy();
        expect(builder!.querySelector(".builder-label")!.textContent).toBe("Builder");
        expect(buttonsIn(builder!).map((b) => b.innerText)).toEqual(
            expect.arrayContaining(["+ Knob", "+ Switch", "+ Group", "SNAP: ON", "Delete Selected"]),
        );
        expect(automationBar(root)).toBeFalsy();
    });

    it("USE mode moves the transport into the center cluster and leaves BUILDER/automation chrome in sync", async () => {
        const { root } = await mount();
        toUseMode(root);

        expect(document.documentElement.getAttribute("data-mode")).toBe("use");
        expect(root.querySelector(".editor-canvas")).toBeTruthy();
        expect(root.querySelector(".builder-bar")).toBeNull();

        // Transport (ARM/REC/STOP + engine chip + APPLY) sits in header-center.
        const transport = centerGroup(root).querySelector<HTMLElement>(".transport")!;
        expect(transport).toBeTruthy();
        const labels = buttonsIn(transport).map((b) => b.innerText);
        expect(labels).toEqual(expect.arrayContaining(["ARM", "REC", "STOP", "APPLY TO AUDIOTOOL"]));
        const engineChip = transport.querySelector<HTMLElement>(".engine-chip")!;
        expect(engineChip).toBeTruthy();
        expect(engineChip.querySelector(".engine-chip-label")!.textContent).toBe("IDLE");

        // MOD matrix toggle appears in the right cluster.
        expect(rightGroup(root).querySelector("#mod-matrix-toggle")).toBeTruthy();

        // At IDLE the automation bar is absent entirely; ARM summons it.
        expect(automationBar(root)).toBeFalsy();
        buttonsIn(transport).find((b) => b.innerText === "ARM")!.click();
        const aBar = automationBar(root);
        expect(aBar).toBeTruthy();
        expect(aBar.querySelector(".automation-strip")).toBeTruthy();
        expect(aBar.querySelector(".automation-status")!.innerText).toBe("Armed — press REC to record");
    });

    it("toggles from USE back to EDIT", async () => {
        const { root } = await mount();

        toUseMode(root);
        toUseMode(root);

        expect(document.documentElement.getAttribute("data-mode")).toBe("edit");
        expect(root.querySelector(".editor-canvas")).toBeTruthy();
        const builder = builderBar(root);
        expect(builder).toBeTruthy();
        expect(buttonsIn(builder!).map((b) => b.innerText)).toEqual(
            expect.arrayContaining(["+ Knob", "+ Switch", "+ Group", "Delete Selected"]),
        );
        expect(rightGroup(root).querySelector("#mod-matrix-toggle")).toBeNull();
    });

    it("keeps the Library button working in the right cluster", async () => {
        const { root } = await mount();

        const libBtn = buttonsIn(rightGroup(root)).find((b) => b.innerText === "Library")!;
        expect(libBtn).toBeTruthy();
        expect(libBtn.className).toContain("active");

        libBtn.click();
        expect(buttonsIn(rightGroup(root)).find((b) => b.innerText === "Library")!.className).not.toContain("active");

        buttonsIn(rightGroup(root)).find((b) => b.innerText === "Library")!.click();
        expect(buttonsIn(rightGroup(root)).find((b) => b.innerText === "Library")!.className).toContain("active");
    });

    it("keeps Undo/Redo working: + Knob records history, Undo removes it, Redo restores it", async () => {
        const { root } = await mount();

        const wrappers = () => root.querySelectorAll(".control-wrapper").length;
        expect(wrappers()).toBe(1); // the seeded "Gain" knob

        buttonsIn(builderBar(root)!).find((b) => b.innerText === "+ Knob")!.click();
        expect(wrappers()).toBe(2);
        expect(document.getElementById("history-undo")).toBeTruthy();

        document.getElementById("history-undo")!.click();
        expect(wrappers()).toBe(1);

        document.getElementById("history-redo")!.click();
        expect(wrappers()).toBe(2);
    });

    it("keeps the automation wiring: USE transport ARM -> REC -> STOP -> take -> CLEAR", async () => {
        const { root } = await mount();
        toUseMode(root);

        const transport = () => centerGroup(root).querySelector<HTMLElement>(".transport")!;
        const tBtn = (label: string) => buttonsIn(transport()).find((b) => b.innerText === label)!;
        const strip = () => automationBar(root).querySelector<HTMLElement>(".automation-strip")!;
        const status = () => strip().querySelector<HTMLElement>(".automation-status")!;

        // IDLE: only ARM is enabled.
        expect(tBtn("ARM").disabled).toBe(false);
        expect(tBtn("REC").disabled).toBe(true);
        expect(tBtn("STOP").disabled).toBe(true);

        tBtn("ARM").click();
        expect(status().innerText).toBe("Armed — press REC to record");
        expect(tBtn("REC").disabled).toBe(false);

        tBtn("REC").click();
        expect(status().innerText).toBe("RECORDING");
        expect(tBtn("STOP").disabled).toBe(false);

        tBtn("STOP").click();
        expect(strip().querySelector(".automation-take")).toBeTruthy();
        // CLEAR lives in the take-local chrome of the automation bar.
        const clearBtn = buttonsIn(strip()).find((b) => b.innerText === "CLEAR")!;
        expect(clearBtn).toBeTruthy();

        clearBtn.click();
        // Back at IDLE the automation bar disappears entirely (USE design).
        expect(automationBar(root)).toBeFalsy();
        const freshTransport = centerGroup(root).querySelector<HTMLElement>(".transport")!;
        expect(buttonsIn(freshTransport).find((b) => b.innerText === "ARM")!.disabled).toBe(false);
        expect(freshTransport.querySelector(".engine-chip-label")!.textContent).toBe("IDLE");
    });

    it("removes no existing header functionality", async () => {
        const { root } = await mount();

        expect(root.querySelector(".app-title")!.textContent).toBe("Metatron | HDR");
        expect(buttonsIn(root).map((b) => b.innerText)).toEqual(
            expect.arrayContaining(["Library", "Connect"]),
        );
        expect(root.querySelector<HTMLInputElement>("input[placeholder='Audiotool Project URL...']")).toBeTruthy();
        expect(root.querySelector(".builder-bar")).toBeTruthy();
        expect(modeToggle(root)).toBeTruthy();
    });
});