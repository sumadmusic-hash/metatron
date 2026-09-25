// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { BindingManager } from "../../src/core/BindingManager";
import { AppUI } from "../../src/ui/AppUI";
import type { NexusValueMapping } from "../../src/nexus/NexusValueMapping";

const NORMALIZED_MAPPING: NexusValueMapping = { kind: "linear", min: 0, max: 1 };

/** Fake Nexus document that tracks real parameter subscriptions (see
 *  tests/nexus/NexusAdapterReconnect.test.ts — same shape). */
function makeNexusDoc() {
    const listeners = new Set<(v: number) => void>();
    const field = { value: 0, mutable: true, location: "L" };
    const entity = { id: "e1", fields: { cutoff: field } };
    return {
        field,
        entity,
        events: {
            onUpdate: (_f: unknown, cb: (v: number) => void) => {
                listeners.add(cb);
                return { terminate: () => listeners.delete(cb) };
            },
        },
        queryEntities: { getEntity: (id: string) => (id === entity.id ? entity : undefined) },
        stop: vi.fn(async () => {}),
        start: vi.fn(async () => {}),
        listenerCount: () => listeners.size,
        fire: (v: number) => listeners.forEach((cb) => cb(v)),
    };
}

function mountApp(device: Device, adapter: NexusAdapter): { app: AppUI; lib: DeviceLibrary; root: HTMLElement } {
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    lib.saveCurrentDevice();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const app = new AppUI(root, lib, adapter, new MidiAccess(), new BindingManager(device));
    app.render();
    return { app, lib, root };
}

function undoBtn(root: HTMLElement): HTMLButtonElement {
    return root.querySelector<HTMLButtonElement>("#history-undo")!;
}
function redoBtn(root: HTMLElement): HTMLButtonElement {
    return root.querySelector<HTMLButtonElement>("#history-redo")!;
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

describe("AppUI — Bug 1 (P1): Undo/Redo räumt die Nexus-Subscriptions des alten Geräts", () => {
    it("Library-Undo entfernt die Parameter-Subscription, obwohl restoreLibraryState deviceRef bereits umgepointet hat", async () => {
        const adapter = new NexusAdapter();
        const doc = makeNexusDoc();
        (adapter as any).client = {
            status: "authenticated",
            open: vi.fn(async () => doc),
        };

        const deviceA = new Device("A");
        const k1 = new Control("knob", "Cutoff", { x: 0, y: 0 }, "cutoff");
        deviceA.addControl(k1);

        const { app, lib, root } = mountApp(deviceA, adapter);
        const bm = (app as any).bindingManager as BindingManager;
        const history = (app as any).history;

        // Projekt öffnen und "k1" gegen A lernen → echte Subscribscription.
        await adapter.openProject("https://audiotool.com/project/123", bm);
        bm.setBinding(k1.id, "e1", "cutoff", "Cutoff", doc.field, "cutoff", NORMALIZED_MAPPING);
        adapter.subscribeBoundControl(k1.id);
        expect(doc.listenerCount()).toBe(1);

        // Neue Library-Aktion aufzeichnen (A → B, device.create). Der normale
        // Wechsel über die UI räumt die Subscriptions von A.
        const before = history.captureLibraryState();
        const deviceB = lib.createNewDevice("B");
        deviceB.addControl(new Control("knob", "Cutoff", { x: 0, y: 0 }, "cutoff"));
        lib.saveCurrentDevice();
        const after = history.captureLibraryState();
        history.record({ type: "device.create", scope: "library", deviceId: null, before, after });
        (app as any).onDeviceChanged();
        expect(doc.listenerCount()).toBe(0);

        // "k1" auf dem NEUEN Gerät B lernen → B besitzt jetzt die Subscription.
        bm.setBinding(k1.id, "e1", "cutoff", "Cutoff", doc.field, "cutoff", NORMALIZED_MAPPING);
        adapter.subscribeBoundControl(k1.id);
        expect(doc.listenerCount()).toBe(1);

        // UNDO über die echte UI-Schaltfläche: performUndoRedo fängt das
        // VOR-Device (B) ab. Ohne den Fix sieht onDeviceChanged keinen Wechsel
        // (deviceRef ist bereits A) und B's Subscription lebt weiter.
        undoBtn(root).click();
        expect(lib.currentDevice?.id).toBe(deviceA.id);
        expect(doc.listenerCount()).toBe(0); // B's Subscription wurde geräumt

        // Ein (veralteter) Nexus-Event aus B's Kontext darf das wiederherge-
        // stellte Gerät A nicht mehr verändern.
        const received: Array<{ id: string; value: number }> = [];
        const appHandler = adapter.onNexusValueChanged;
        adapter.onNexusValueChanged = (id, value) => received.push({ id, value });
        doc.fire(0.9);
        expect(received).toEqual([]);
        expect(lib.currentDevice!.getControl(k1.id)!.value).toBe(0);
        adapter.onNexusValueChanged = appHandler;

        // Wiederholtes Re/Undo ohne Akkumulation: nie taucht eine neue
        // Subscription auf, die an die nächste Runde weitergereicht wird.
        redoBtn(root).click();
        expect(doc.listenerCount()).toBe(0);
        undoBtn(root).click();
        expect(doc.listenerCount()).toBe(0);
        expect(lib.currentDevice?.id).toBe(deviceA.id);
    });
});