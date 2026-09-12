// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { createOfflineDocument } from "@audiotool/nexus/node";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { BindingManager } from "../../src/core/BindingManager";
import { AppUI, summarizeTakeTracks, takeRowText } from "../../src/ui/AppUI";
import type { MidiBindingDefinition } from "../../src/core/model/types";

/**
 * M21.8 — automation-strip UX: ARMED/RECORDING visual states, live elapsed
 * timer, take overview with control names, CLEAR, and the double-write guard
 * (APPLIED + disabled until a new ARM). Everything is UI-only; the recording
 * engine and the Audiotool write path are untouched.
 */

const HINT = "Audiotool and Metatron must remain visible at the same time for live sound feedback.";

class CapturingMidi extends MidiAccess {
    public installedHandler: ((channel: number, cc: number, value: number) => void) | null = null;
    public override setMessageHandler(callback: (channel: number, cc: number, value: number) => void) {
        this.installedHandler = callback;
    }
    public trigger(channel: number, cc: number, value: number) {
        this.installedHandler?.(channel, cc, value);
    }
}

class PassingAdapter extends NexusAdapter {
    public override updateBoundControl(_controlId: string, _value: number): Promise<boolean> {
        return Promise.resolve(true);
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

function buildDevice(): Device {
    const device = new Device("UX");
    const defs: [string, string, number][] = [
        ["cut", "Cutoff", 20],
        ["res", "Resonance", 21],
        ["mix", "Delay Mix", 22],
    ];
    for (const [id, name, cc] of defs) {
        const c = new Control("knob", name, undefined, id);
        c.midiBindingDefinition = { channel: 1, cc } as MidiBindingDefinition;
        device.addControl(c);
    }
    return device;
}

async function offlineSetup() {
    const doc: any = await createOfflineDocument({ validated: true });
    let basslineId: string | undefined;
    await doc.modify((t: any) => {
        basslineId = t.create("bassline", {}).id;
    });
    const gainField = doc.queryEntities.getEntity(basslineId).fields.gain;
    const device = buildDevice();
    const bindings = new BindingManager(device);
    for (const c of device.controls.values()) {
        bindings.setBinding(c.id, basslineId, "gain", "bassline / gain", gainField, "gain");
    }
    const adapter = new OfflineAdapter(doc);
    return { doc, gainField, device, bindings, adapter };
}

function mount(device: Device, adapter: NexusAdapter, bindings: BindingManager): { root: HTMLElement; midi: CapturingMidi } {
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    lib.saveCurrentDevice();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const midi = new CapturingMidi();
    const app = new AppUI(root, lib, adapter, midi, bindings);
    app.render();
    const toggle = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        b.innerText === "USE",
    );
    toggle?.click();
    return { root, midi };
}

function button(root: HTMLElement, label: string): HTMLButtonElement | undefined {
    return [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.innerText === label);
}

function status(root: HTMLElement): string {
    return root.querySelector(".automation-status")?.textContent ?? "";
}

function hint(root: HTMLElement): HTMLElement | null {
    return root.querySelector(".automation-hint");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function recordTwoControls(root: HTMLElement, midi: CapturingMidi): Promise<void> {
    button(root, "ARM")!.click();
    button(root, "REC")!.click();
    midi.trigger(1, 20, 100);
    await sleep(5);
    midi.trigger(1, 21, 50);
    await sleep(5);
    button(root, "STOP")!.click();
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

describe("M21.8 — automation strip UX", () => {
    it("1. ARM shows the armed status text and tints the ARM button", () => {
        const device = buildDevice();
        const { root } = mount(device, new PassingAdapter(), new BindingManager(device));
        button(root, "ARM")!.click();
        expect(status(root)).toBe("Armed — press REC to record");
        expect(button(root, "ARM")!.className).toContain("armed");
        expect(button(root, "REC")!.className).not.toContain("armed");
    });

    it("2. RECORDING shows RECORDING and paints the REC button red", () => {
        const device = buildDevice();
        const { root } = mount(device, new PassingAdapter(), new BindingManager(device));
        button(root, "ARM")!.click();
        button(root, "REC")!.click();
        expect(status(root)).toBe("RECORDING");
        expect(button(root, "REC")!.className).toContain("recording");
        expect(button(root, "ARM")!.className).toContain("armed");
    });

    it("3. RECORDING shows a live elapsed timer (● N.Ns)", async () => {
        const device = buildDevice();
        const { root, midi } = mount(device, new PassingAdapter(), new BindingManager(device));
        button(root, "ARM")!.click();
        button(root, "REC")!.click();
        const el = root.querySelector(".automation-elapsed");
        expect(el).not.toBeNull();
        expect(el!.textContent).toMatch(/^● \d\.\ds$/);
        const t0 = parseFloat(el!.textContent!.slice(2));
        await sleep(250);
        const t1 = parseFloat(el!.textContent!.slice(2));
        expect(t1).toBeGreaterThan(t0);
        expect(el!.textContent).toMatch(/^● \d\.\ds$/);
        button(root, "STOP")!.click();
        expect(root.querySelector(".automation-elapsed")).toBeNull();
    });

    it("4. the live-feedback hint stays visible in ARMED and RECORDING", () => {
        const device = buildDevice();
        const { root } = mount(device, new PassingAdapter(), new BindingManager(device));
        button(root, "ARM")!.click();
        expect(hint(root)).not.toBeNull();
        expect(hint(root)!.innerText).toBe(HINT);
        button(root, "REC")!.click();
        expect(hint(root)).not.toBeNull();
        expect(hint(root)!.innerText).toBe(HINT);
    });

    it("5. STOP shows the take overview head 'Take: N Controls · Xs'", async () => {
        const device = buildDevice();
        const { root, midi } = mount(device, new PassingAdapter(), new BindingManager(device));
        button(root, "ARM")!.click();
        button(root, "REC")!.click();
        midi.trigger(1, 20, 100);
        await sleep(5);
        button(root, "STOP")!.click();
        const head = root.querySelector(".automation-take-head");
        expect(head).not.toBeNull();
        expect(head!.textContent).toMatch(/^Take: 1 Controls · \d\.\ds$/);
    });

    it("6. take rows list the control names from the device", async () => {
        const device = buildDevice();
        const { root, midi } = mount(device, new PassingAdapter(), new BindingManager(device));
        button(root, "ARM")!.click();
        button(root, "REC")!.click();
        midi.trigger(1, 20, 100);
        await sleep(5);
        midi.trigger(1, 21, 50);
        await sleep(5);
        midi.trigger(1, 22, 80);
        await sleep(5);
        button(root, "STOP")!.click();
        const rows = [...root.querySelectorAll<HTMLElement>(".automation-take-row")].map((r) => r.innerText);
        expect(rows).toEqual(["Cutoff", "Resonance", "Delay Mix"]);
    });

    it("7. tracks with 0 events render as '(0 events)', unnamed fall back to controlId", () => {
        const rows = summarizeTakeTracks(
            [
                { controlId: "cut", samples: [] },
                { controlId: "mix", samples: [{ timeSeconds: 1, normalizedValue: 0.5 }] },
            ],
            { getControl: (id) => (id === "cut" ? ({ name: "Cutoff" } as any) : undefined) },
        );
        expect(rows).toEqual([
            { name: "Cutoff", eventCount: 0 },
            { name: "mix", eventCount: 1 },
        ]);
        expect(takeRowText("Cutoff", 0)).toBe("Cutoff (0 events)");
        expect(takeRowText("Resonance", 3)).toBe("Resonance");
    });

    it("8. CLEAR discards the take locally and returns to IDLE", async () => {
        const device = buildDevice();
        const { root, midi } = mount(device, new PassingAdapter(), new BindingManager(device));
        await recordTwoControls(root, midi);
        expect(status(root)).not.toBe("IDLE");
        button(root, "CLEAR")!.click();
        expect(status(root)).toBe("IDLE");
        expect(root.querySelector(".automation-take")).toBeNull();
        expect(root.querySelector(".automation-elapsed")).toBeNull();
        expect(button(root, "CLEAR")!.disabled).toBe(true);
        expect(button(root, "ARM")!.disabled).toBe(false);
        expect(button(root, "APPLY TO AUDIOTOOL")!.disabled).toBe(true);
    });

    it("9. APPLY writes real automation and shows APPLIED with the button disabled", async () => {
        const { device, adapter, bindings, doc } = await offlineSetup();
        const { root, midi } = mount(device, adapter, bindings);
        await recordTwoControls(root, midi);
        const apply = button(root, "APPLY TO AUDIOTOOL")!;
        expect(apply.disabled).toBe(false);
        apply.click();
        await sleep(20);
        expect(button(root, "APPLY TO AUDIOTOOL")!.disabled).toBe(true);
        expect(status(root)).toBe("APPLIED");
        expect(doc.queryEntities.ofTypes("automationTrack").get()).toHaveLength(2);
        expect(doc.queryEntities.ofTypes("automationCollection").get()).toHaveLength(2);
        expect(doc.queryEntities.ofTypes("automationRegion").get()).toHaveLength(2);
        expect(doc.queryEntities.ofTypes("automationEvent").get().length).toBeGreaterThanOrEqual(2);
    });

    it("10. a second APPLY of the same take is impossible (no duplicate entities)", async () => {
        const { device, adapter, bindings, doc } = await offlineSetup();
        const { root, midi } = mount(device, adapter, bindings);
        await recordTwoControls(root, midi);
        button(root, "APPLY TO AUDIOTOOL")!.click();
        await sleep(20);
        const before = doc.queryEntities.ofTypes("automationTrack").get().length;
        expect(before).toBe(2);
        expect(button(root, "APPLY TO AUDIOTOOL")!.disabled).toBe(true);
        button(root, "APPLY TO AUDIOTOOL")!.click();
        await sleep(10);
        expect(doc.queryEntities.ofTypes("automationTrack").get()).toHaveLength(before);
    });

    it("11. a new ARM + take re-enables APPLY for the new take", async () => {
        const { device, adapter, bindings, doc } = await offlineSetup();
        const { root, midi } = mount(device, adapter, bindings);
        await recordTwoControls(root, midi);
        button(root, "APPLY TO AUDIOTOOL")!.click();
        await sleep(20);
        expect(status(root)).toBe("APPLIED");

        button(root, "ARM")!.click();
        button(root, "REC")!.click();
        midi.trigger(1, 22, 80);
        await sleep(5);
        button(root, "STOP")!.click();

        const apply = button(root, "APPLY TO AUDIOTOOL")!;
        expect(apply.disabled).toBe(false);
        expect(status(root)).not.toBe("APPLIED");
        apply.click();
        await sleep(20);
        expect(doc.queryEntities.ofTypes("automationTrack").get()).toHaveLength(3);
        expect(status(root)).toBe("APPLIED");
    });

    it("12. the created entities are real automation with a proper automatedParameter", async () => {
        const { device, adapter, bindings, doc, gainField } = await offlineSetup();
        const { root, midi } = mount(device, adapter, bindings);
        await recordTwoControls(root, midi);
        button(root, "APPLY TO AUDIOTOOL")!.click();
        await sleep(20);

        const tracks = doc.queryEntities.ofTypes("automationTrack").get();
        expect(tracks).toHaveLength(2);
        for (const t of tracks as any[]) {
            const automatedParameter = t.fields.automatedParameter.value;
            expect(automatedParameter).toBeDefined();
            expect(automatedParameter === gainField.location || automatedParameter.equals?.(gainField.location)).toBe(true);
        }
        if (typeof doc.validate === "function") {
            await doc.validate();
        }
    });

    it("13. take rows expose the FULL control name via a native title (G-09)", async () => {
        const device = new Device("G9");
        const longName = "Deep Horizon Filter Cutoff Frequency";
        const c = new Control("knob", longName, undefined, "cut");
        c.midiBindingDefinition = { channel: 1, cc: 20 } as MidiBindingDefinition;
        device.addControl(c);
        const { root, midi } = mount(device, new PassingAdapter(), new BindingManager(device));
        button(root, "ARM")!.click();
        button(root, "REC")!.click();
        midi.trigger(1, 20, 100);
        await sleep(5);
        button(root, "STOP")!.click();
        const rows = [...root.querySelectorAll<HTMLElement>(".automation-take-row")];
        expect(rows).toHaveLength(1);
        expect(rows[0].title).toBe(longName);
        expect(rows[0].innerText).toBe(longName);
    });
});