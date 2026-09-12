// @vitest-environment happy-dom
/**
 * M23.3.1 — PERSISTENZ & UI NACH INSTRUMENT-PRESET-IMPORT.
 *
 * Regression: der UI-Importpfad (DeviceLibraryUI.runInstrumentImport) muss nach
 * dem Engine-Import den geänderten Device-Zustand über den bestehenden
 * DeviceLibrary.saveCurrentDevice()-Pfad persistieren und die UI über
 * onDeviceChanged() aktualisieren — ohne einen zweiten History-Eintrag.
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
        // Control.value ist im Metatron-Modell bewusst transient (wird nicht
        // serialisiert). "Gespeichert" heißt hier: der Live-Zustand des
        // DEVICES (in dem Control.value gesetzt wurde) geht über den
        // bestehenden Storage-Pfad. Beweis über das übergebene Objekt.
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

        // 2. Der geänderte Device-State wird über den bestehenden Pfad
        //    gespeichert: genau EIN mal wird das veränderte Live-Device an den
        //    Storage übergeben (Control.value ist transient, der Device-Zustand
        //    inkl. Event-inkonsistenzen wird persistiert).
        expect(libSaveSpy).toHaveBeenCalledTimes(1);
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
});