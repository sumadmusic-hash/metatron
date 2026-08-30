import { describe, it, expect, beforeEach } from "vitest";
import { createOfflineDocument } from "@audiotool/nexus/node";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { BindingManager } from "../../src/core/BindingManager";
import {
    parseInstrumentPreset,
    serializeInstrumentPreset,
} from "../../src/core/instrument/InstrumentPreset";
import { idMapUsesNoSourceIds } from "../../src/nexus/ChainPlanning";
import { normalizeEntityId } from "../../src/nexus/ChainDiscovery";
import {
    exportInstrumentToLibrary,
    importInstrumentFromLibrary,
    selectRootId,
    selectSourceRoot,
} from "../../src/integration/InstrumentPresetIntegration";
import {
    InstrumentPresetLibrary,
    INSTRUMENT_PRESET_LIBRARY_KEY,
} from "../../src/persistence/InstrumentPresetLibrary";
import type { AudioDeviceNode } from "../../src/nexus/ChainDiscovery";
import type { RawCable } from "../../src/nexus/ChainLive";

/**
 * P4 — Instrument Preset integration tests (P1/P2 orchestration + D1 library).
 * Uses the REAL offline Nexus SDK for SOURCE and TARGET and the production
 * integration layer only. The 370-test baseline must stay green next to these.
 */

// Minimal localStorage shim (pattern of tests/core/DeviceLibrary.test.ts).
class FakeStorage implements Storage {
    private store = new Map<string, string>();
    get length(): number { return this.store.size; }
    clear(): void { this.store.clear(); }
    getItem(key: string): string | null { return this.store.get(key) ?? null; }
    key(index: number): string | null { return Array.from(this.store.keys())[index] ?? null; }
    removeItem(key: string): void { this.store.delete(key); }
    setItem(key: string, value: string): void { this.store.set(key, value); }
}

function freshDoc() {
    return createOfflineDocument({ validated: true });
}

/** Real SOURCE chain: pulverisateur → mixerChannel, cutoff value set. */
async function makeSource(): Promise<{ doc: any; pulv: any; mixer: any }> {
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
    return { doc, pulv, mixer };
}

function makeDevice() {
    const device = new Device("Lead");
    const cutoff = new Control("knob", "Cutoff"); cutoff.value = 0.5;
    const resonance = new Control("knob", "Resonance"); resonance.value = 0.25;
    device.addControl(cutoff);
    device.addControl(resonance);
    return { device, cutoffId: cutoff.id, resonanceId: resonance.id };
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

describe("P4 — Instrument Preset integration (deterministic root selection)", () => {
    const dev = (id: string): AudioDeviceNode => ({ id, entityType: "x", displayName: id });
    const cable = (from: string, to: string): RawCable =>
        ({ id: `c_${from}_${to}`, fromEntityId: from, toEntityId: to, fromSocketPath: from, toSocketPath: to });

    it("returns undefined for an empty document", () => {
        expect(selectRootId([], [])).toBeUndefined();
    });

    it("picks the first audio device when nothing has an input", () => {
        expect(selectRootId([dev("B"), dev("A")], [])).toBe("B");
    });

    it("picks the device with no incoming cable (A → B ⇒ root A)", () => {
        expect(selectRootId([dev("A"), dev("B")], [cable("A", "B")])).toBe("A");
    });

    it("normalizes cable endpoints (uppercase toEntityId still matches)", () => {
        expect(selectRootId([dev("A"), dev("B")], [cable("a", "B")])).toBe("A");
    });

    it("closed chain (every device has an input) falls back to the first audio device", () => {
        expect(selectRootId([dev("A"), dev("B")], [cable("A", "B"), cable("B", "A")])).toBe("A");
    });

    it("live selectSourceRoot resolves the real pulverisateur (no incoming cable)", async () => {
        const { doc, pulv, mixer } = await makeSource();
        const root = selectSourceRoot(doc);
        expect(root).toBeDefined();
        expect(normalizeEntityId(root ?? "")).toBe(normalizeEntityId(pulv.id));
        expect(normalizeEntityId(root ?? "")).not.toBe(normalizeEntityId(mixer.id));
    });
});

describe("P4 — Instrument Preset integration (library persistence, D1)", () => {
    beforeEach(() => {
        (globalThis as any).localStorage = new FakeStorage();
    });

    async function exportFixture() {
        const { doc, pulv } = await makeSource();
        const { device, cutoffId } = makeDevice();
        const bm = new BindingManager(device);
        bindCutoff(bm, pulv, cutoffId);
        const outcome = await exportInstrumentToLibrary(doc, device, bm, "Crunch Lead");
        expect(outcome.ok).toBe(true);
        expect(outcome.entry).toBeDefined();
        if (!outcome.ok || !outcome.entry) throw new Error("fixture export failed");
        return { device, cutoffId, entry: outcome.entry };
    }

    it("1. Export → serialize → parse round-trips the v0.1 envelope", async () => {
        const { entry } = await exportFixture();
        const preset = parseInstrumentPreset(entry.presetJson);
        expect(preset.name).toBe("Crunch Lead");
        expect(serializeInstrumentPreset(preset)).toBe(entry.presetJson);
    });

    it("2. Parse → Import applies the preset into a TARGET document", async () => {
        const { device, entry } = await exportFixture();
        const target = await freshDoc();
        const outcome = await importInstrumentFromLibrary(entry.id, target, new BindingManager(device));
        expect(outcome.ok).toBe(true);
        expect(outcome.import!.sections.chain.ok).toBe(true);
        expect(outcome.import!.sections.bindings.ok).toBe(true);
        expect(outcome.import!.sections.preset.ok).toBe(true);
        expect(outcome.import!.sections.verification.ok).toBe(true);
        expect(outcome.import!.failures).toEqual([]);
        expect(outcome.import!.clone.report.finalVerdict).toBe("CHAIN CLONE: PASS");
    });

    it("3. Export/Import never reuses SOURCE entity ids as TARGET ids", async () => {
        const { entry, device } = await exportFixture();
        const target = await freshDoc();
        const outcome = await importInstrumentFromLibrary(entry.id, target, new BindingManager(device));
        expect(outcome.ok).toBe(true);
        const preset = parseInstrumentPreset(entry.presetJson);
        const sourceIds = preset.chain.snapshot.devices.map((d) => d.sourceEntityId);
        const imported = outcome.import!;
        expect(idMapUsesNoSourceIds(imported.clone.idMap, sourceIds)).toBe(true);
        for (const src of sourceIds) {
            expect(normalizeEntityId(src)).not.toBe(normalizeEntityId(imported.idMap[src]));
            expect(imported.idMap[src]).toBeDefined();
        }
    });

    it("bindings in the envelope use sourceEntityIndex — no raw SOURCE entity ids travel in bindings", async () => {
        const { entry } = await exportFixture();
        const preset = parseInstrumentPreset(entry.presetJson);
        expect(preset.bindings.length).toBeGreaterThan(0);
        for (const b of preset.bindings) {
            expect(typeof b.sourceEntityIndex).toBe("number");
            expect((b as any).sourceEntityId).toBeUndefined();
        }
    });

    it("4. Persistence roundtrip: save → list → get → delete", async () => {
        const { entry } = await exportFixture();
        expect(InstrumentPresetLibrary.list().map((i) => i.id)).toContain(entry.id);
        expect(InstrumentPresetLibrary.get(entry.id)?.presetJson).toBe(entry.presetJson);
        expect(InstrumentPresetLibrary.list().length).toBe(1);
        expect(InstrumentPresetLibrary.delete(entry.id)).toBe(true);
        expect(InstrumentPresetLibrary.list().length).toBe(0);
        expect(InstrumentPresetLibrary.delete(entry.id)).toBe(false);
    });

    it("5. Invalid envelope → controlled import failure (no engine call)", async () => {
        const { entry, device } = await exportFixture();
        // Corrupt the stored envelope behind the library's back.
        const all = JSON.parse(localStorage.getItem(INSTRUMENT_PRESET_LIBRARY_KEY)!);
        all[0].presetJson = "{definitely not json";
        localStorage.setItem(INSTRUMENT_PRESET_LIBRARY_KEY, JSON.stringify(all));

        const target = await freshDoc();
        const outcome = await importInstrumentFromLibrary(entry.id, target, new BindingManager(device));
        expect(outcome.ok).toBe(false);
        expect(outcome.import).toBeUndefined();
        expect(outcome.errors?.[0]).toMatch(/invalid/i);
    });

    it("6. Missing TARGET document → controlled failure", async () => {
        const { entry, device } = await exportFixture();
        const outcome = await importInstrumentFromLibrary(entry.id, undefined as any, new BindingManager(device));
        expect(outcome.ok).toBe(false);
        expect(outcome.import).toBeUndefined();
        expect(outcome.errors?.[0]).toMatch(/no TARGET document/);
    });

    it("6b. Missing library entry id → controlled failure", async () => {
        const target = await freshDoc();
        const outcome = await importInstrumentFromLibrary("ipst_doesnotexist", target, new BindingManager(makeDevice().device));
        expect(outcome.ok).toBe(false);
        expect(outcome.errors?.[0]).toMatch(/no library entry/);
    });

    it("7. Binding restoration: import re-establishes ActiveBindings via setBinding", async () => {
        const { entry, cutoffId, device } = await exportFixture();
        const target = await freshDoc();
        const restoreBm = new BindingManager(device);
        const outcome = await importInstrumentFromLibrary(entry.id, target, restoreBm);
        expect(outcome.ok).toBe(true);
        const record = outcome.import!.bindings.find((b) => b.controlId === cutoffId)!;
        expect(record.ok).toBe(true);
        const active = restoreBm.getActiveBinding(cutoffId);
        expect(active).toBeDefined();
        expect(active!.entityId).toBe(record.targetEntityId);
        expect(active!.fieldPath).toBe("filter.cutoffFrequencyHz");
        expect(active!.fieldName).toBe("cutoffFrequencyHz");
        expect(active!.valueMapping?.kind).toBe("linear");
        expect(restoreBm.getActiveBinding("missing-ci")).toBeUndefined();
    });

    it("Export refuses when no control has an active binding (honest error)", async () => {
        const { doc } = await makeSource();
        const { device } = makeDevice();
        const outcome = await exportInstrumentToLibrary(doc, device, new BindingManager(device), "Empty");
        expect(outcome.ok).toBe(false);
        expect(outcome.errors?.[0]).toMatch(/no bound control/);
    });
});