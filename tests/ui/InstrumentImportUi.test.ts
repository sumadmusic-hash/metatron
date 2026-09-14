// @vitest-environment happy-dom
/**
 * M23.3.1 — PERSISTENZ & UI NACH INSTRUMENT-PRESET-IMPORT.
 *
 * Regression: der UI-Importpfad (DeviceLibraryUI.runInstrumentImport) muss nach
 * dem Engine-Import den geänderten Device-Zustand persistieren und die UI über
 * onDeviceChanged() aktualisieren — ohne einen zweiten History-Eintrag.
 *
 * I19.2 — Racing: das Ziel-Device wird VOR dem ersten `await` gepinnt. Ein
 * Geräte-Wechsel während des laufenden Imports darf weder das andere Gerät
 * verändern (Bindings/Values) noch dessen Storage-Zustand überschreiben.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createOfflineDocument } from "@audiotool/nexus/node";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { Storage } from "../../src/persistence/Storage";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { BindingManager } from "../../src/core/BindingManager";
import { AppUI } from "../../src/ui/AppUI";
import { exportInstrumentToLibrary } from "../../src/integration/InstrumentPresetIntegration";

/** Test-only hook to hold the chain-clone promise open mid-import. */
const cloneHooks = vi.hoisted(() => {
    let gate: Promise<void> | null = null;
    let release: (() => void) | null = null;
    let blocking = false;
    return {
        /** Arm the gate: the NEXT chain clone blocks until release(). */
        armDelay() {
            gate = new Promise<void>((res) => { release = res; });
            blocking = false;
        },
        /** True while a clone is actually suspended on the gate. */
        isBlocking() { return blocking; },
        async wait() {
            if (!gate) return;
            blocking = true;
            await gate;
            blocking = false;
            gate = null;
            release = null;
        },
        /** Resolve the gate and let the suspended clone continue. */
        release() { release?.(); },
    };
});

vi.mock("../../src/nexus/ChainClone", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/nexus/ChainClone")>();
    return {
        ...actual,
        async cloneChainFromSnapshot(...args: Parameters<typeof actual.cloneChainFromSnapshot>) {
            await cloneHooks.wait();
            return actual.cloneChainFromSnapshot(...args);
        },
    };
});

/** Real SOURCE chain with a bound "Cutoff" knob (mirrors the integration fixture). */
async function exportFixture() {
    const doc: any = await createOfflineDocument({ validated: true });
    await doc.modify((t: any) => {
        t.create("pulverisateur", { displayName: "SYNTH" });
        t.create("mixerChannel", { displayName: "MIXER" });
    });
    const byType = (type: string) =>
        doc.queryEntities.get().find((e: any) => e.entityType === type) as any;
    const pulv = byType("pulverisateur");
    const mixer = byType("mixerChannel");
    await doc.modify((t: any) => {
        t.update(pulv.fields.filter.fields.cutoffFrequencyHz, 9353.88);
    });
    await doc.modify((t: any) => {
        t.create("desktopAudioCable", { fromSocket: pulv.fields.audioOutput.location, toSocket: mixer.fields.audioInput.location });
    });

    const device = new Device("Lead");
    const cutoff = new Control("knob", "Cutoff");
    cutoff.value = 0.5;
    device.addControl(cutoff);
    const bm = new BindingManager(device);
    bm.setBinding(
        cutoff.id,
        pulv.id,
        "Cutoff",
        "cutoffFrequencyHz",
        pulv.fields.filter.fields.cutoffFrequencyHz,
        "filter.cutoffFrequencyHz",
    );
    const outcome = await exportInstrumentToLibrary(doc, device, bm, "Crunch Lead");
    expect(outcome.ok).toBe(true);
    return { device, cutoffId: cutoff.id };
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

describe("M23.3.1 — Instrument-Preset-Import: Persistenz & UI-Refresh (DeviceLibraryUI)", () => {
    it("speichert den importierten Device-State und löst die UI-Aktualisierung aus — genau eine History-Aktion", async () => {
        const { device, cutoffId } = await exportFixture();
        const cutoff = device.getControl(cutoffId)!;

        // Zieldokument für den Import (frisches Offline-Dokument).
        const target: any = await createOfflineDocument({ validated: true });

        // AppUI real mounten (der Import-Button wirkt über die echte Kette
        // confirmInstrumentImport → runInstrumentImport).
        const lib = new DeviceLibrary();
        lib.currentDevice = device;
        lib.saveCurrentDevice();
        const adapter = new NexusAdapter();
        adapter.document = target;
        const root = document.createElement("div");
        document.body.appendChild(root);
        const app = new AppUI(root, lib, adapter, new MidiAccess());
        app.render();

        // Divergenter Ausgangszustand: lokal 0.9, gespeichertes Preset enthält 0.5.
        cutoff.value = 0.9;
        lib.saveCurrentDevice();

        const libSaveSpy = vi.spyOn(lib, "saveCurrentDevice");
        // Control.value ist seit I17 §13 SERIALISIERT (überlebt save/load); nach
        // dem Import enthält device den gespeicherten Zustand mit der
        // importierten Regelposition. Beweis über das übergebene Objekt.
        const storageSaveSpy = vi.spyOn(Storage, "saveDevice");
        const renderSpy = vi.spyOn(AppUI.prototype, "render");
        const rendersBefore = renderSpy.mock.calls.length;

        // Import über die UI anklicken.
        const importBtn = Array.from(
            root.querySelectorAll<HTMLButtonElement>(".preset-list-item button.mini-btn"),
        ).find((b) => b.innerText === "Import")!;
        expect(importBtn).toBeTruthy();
        importBtn.click();

        const confirmYes = document.querySelector<HTMLButtonElement>(".confirm-bar.danger button.btn.small")!;
        expect(confirmYes).toBeTruthy();
        confirmYes.click();

        // 1. Der erfolgreiche Import setzt Control.value auf den Preset-Wert.
        await vi.waitFor(() => {
            expect(cutoff.value).toBe(0.5);
        });

        // 2. Der Import persistiert das GEPINNTE Gerät direkt über den Storage
        //    (Storage.saveDevice(device)) — genau EIN mal, mit dem gepinnten
        //    Device. saveCurrentDevice() wird bewusst NICHT benutzt: es würde
        //    den inzwischen aktiven (möglicherweise gewechselten) Device-Zustand
        //    schreiben statt des Import-Ziels (I19.2).
        expect(libSaveSpy).not.toHaveBeenCalled();
        expect(storageSaveSpy).toHaveBeenCalledTimes(1);
        expect(storageSaveSpy).toHaveBeenCalledWith(device);

        // 3. Die Device-Changed-/UI-Aktualisierung wird ausgelöst.
        expect(renderSpy.mock.calls.length).toBeGreaterThan(rendersBefore);
        // Der Report überlebt das Re-Rendering (nach onDeviceChanged eingehängt).
        expect(root.querySelector(".device-sidebar pre")?.textContent).toContain("INSTRUMENT PRESET IMPORT");

        // 4. Genau EINE instrument.import-History-Aktion: ein Undo setzt zurück,
        //    ein Redo wendet erneut an — ein zweiter Eintrag wäre sichtbar.
        const undo = root.querySelector<HTMLButtonElement>("#history-undo")!;
        const redo = root.querySelector<HTMLButtonElement>("#history-redo")!;
        expect(undo.disabled).toBe(false);
        expect(redo.disabled).toBe(true);

        undo.click();
        expect(cutoff.value).toBe(0.9);
        expect(root.querySelector<HTMLButtonElement>("#history-undo")!.disabled).toBe(true);
        expect(root.querySelector<HTMLButtonElement>("#history-redo")!.disabled).toBe(false);

        root.querySelector<HTMLButtonElement>("#history-redo")!.click();
        expect(cutoff.value).toBe(0.5);
        expect(root.querySelector<HTMLButtonElement>("#history-undo")!.disabled).toBe(false);
        expect(root.querySelector<HTMLButtonElement>("#history-redo")!.disabled).toBe(true);
    });

    it("I19.2 — Geräte-Wechsel WÄHREND des laufenden Imports trifft ausschließlich das gepinnte Gerät", async () => {
        const { device, cutoffId } = await exportFixture();
        const cutoff = device.getControl(cutoffId)!;
        cutoff.value = 0.9;

        // Zweites Gerät in der Library, das während des Imports geöffnet wird.
        const other = new Device("Other Device");
        const otherKnob = new Control("knob", "Untouched");
        otherKnob.value = 0.3;
        other.addControl(otherKnob);

        const target: any = await createOfflineDocument({ validated: true });

        const lib = new DeviceLibrary();
        lib.currentDevice = device;
        lib.saveCurrentDevice();
        Storage.saveDevice(other);

        const adapter = new NexusAdapter();
        adapter.document = target;
        const root = document.createElement("div");
        document.body.appendChild(root);
        const app = new AppUI(root, lib, adapter, new MidiAccess());
        app.render();

        // Import starten, aber den Chain-Clone am Gate hängen lassen.
        const importBtn = Array.from(
            root.querySelectorAll<HTMLButtonElement>(".preset-list-item button.mini-btn"),
        ).find((b) => b.innerText === "Import")!;
        cloneHooks.armDelay();
        importBtn.click();
        document.querySelector<HTMLButtonElement>(".confirm-bar.danger button.btn.small")!.click();

        await vi.waitFor(() => {
            expect(cloneHooks.isBlocking()).toBe(true);
        });
        // Noch kein Wert geschrieben: der Import hängt im Clone.
        expect(cutoff.value).toBe(0.9);

        // Geräte-Wechsel: "Other Device" öffnen → BindingManager wird auf das
        // neue Gerät umgebogen (setDevice + activeBindings.clear()).
        const otherRow = Array.from(root.querySelectorAll<HTMLElement>(".device-list-item"))
            .find((r) => r.textContent?.includes("Other Device"))!;
        expect(otherRow).toBeTruthy();
        otherRow.click();
        expect(lib.currentDevice?.id).toBe(other.id);

        // Clone freigeben → Import läuft gegen das GEPINNTE Gerät weiter.
        cloneHooks.release();
        await vi.waitFor(() => {
            expect(cutoff.value).toBe(0.5);
        });

        // Das GEPINNTE Gerät trägt die Import-Bindung + den Preset-Wert …
        expect(cutoff.audiotoolBindingDefinition).toBeDefined();
        expect(cutoff.value).toBe(0.5);
        expect(Storage.loadDevice(device.id)!.getControl(cutoffId)!.value).toBe(0.5);
        expect(Storage.loadDevice(device.id)!.getControl(cutoffId)!.audiotoolBindingDefinition).toBeDefined();

        // … das ANDERE Gerät bleibt vollständig unangetastet: kein Binding,
        // kein Wert, kein Storage-Überschreiben (auch lokal ist es NICHT das
        // aktive Gerät — der Import hat nichts über saveCurrentDevice() geschrieben).
        expect(other.getControl(otherKnob.id)!.value).toBe(0.3);
        expect(other.getControl(otherKnob.id)!.audiotoolBindingDefinition).toBeUndefined();
        expect(lib.currentDevice?.id).toBe(other.id);
        const storedOther = Storage.loadDevice(other.id)!;
        expect(storedOther.getControl(otherKnob.id)!.value).toBe(0.3);
        expect(storedOther.getControl(otherKnob.id)!.audiotoolBindingDefinition).toBeUndefined();
    });
});