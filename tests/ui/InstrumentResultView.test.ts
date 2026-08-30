// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { createOfflineDocument } from "@audiotool/nexus/node";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { BindingManager } from "../../src/core/BindingManager";
import {
    exportInstrumentToLibrary,
    importInstrumentFromLibrary,
} from "../../src/integration/InstrumentPresetIntegration";
import { renderInstrumentImportOutcome } from "../../src/ui/instrument/InstrumentResultView";

/**
 * F2 — result rendering uses the ACTUAL numeric counts from the engine,
 * never the boolean `VerificationResult.devices.matched`:
 * "devices 2/2" must appear, "devices true/2" / "devices false/2" never.
 * Uses the REAL offline Nexus SDK + production integration layer.
 */

function freshDoc() {
    return createOfflineDocument({ validated: true });
}

async function makeSource() {
    const doc: any = await freshDoc();
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
    return { doc, pulv };
}

function makeDevice() {
    const device = new Device("Lead");
    const cutoff = new Control("knob", "Cutoff"); cutoff.value = 0.5;
    device.addControl(cutoff);
    return { device, cutoffId: cutoff.id };
}

function bindCutoff(bm: BindingManager, pulv: any, cutoffId: string) {
    bm.setBinding(
        cutoffId,
        pulv.id,
        "cutoffFrequencyHz",
        "Cutoff",
        pulv.fields.filter.fields.cutoffFrequencyHz,
        "filter.cutoffFrequencyHz",
    );
}

describe("P4/F2 — InstrumentPreset Integration result rendering (InstrumentResultView)", () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it("renders the numeric device counts (devices 2/2), never a boolean match", async () => {
        const { doc, pulv } = await makeSource();
        const { device, cutoffId } = makeDevice();
        const bm = new BindingManager(device);
        bindCutoff(bm, pulv, cutoffId);

        const exported = await exportInstrumentToLibrary(doc, device, bm, "Crunch Lead");
        expect(exported.ok).toBe(true);
        if (!exported.ok || !exported.entry) throw new Error("fixture export failed");

        const target = await freshDoc();
        const outcome = await importInstrumentFromLibrary(exported.entry.id, target, new BindingManager(device));
        expect(outcome.ok).toBe(true);

        const text = renderInstrumentImportOutcome(outcome).textContent ?? "";
        expect(text).toContain("devices 2/2");
        expect(text).not.toMatch(/devices (true|false)\//);
        expect(text).toContain("device readback:   2/2");
    });
});