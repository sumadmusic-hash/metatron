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

// Shared backing store so a ThrowingStorage (setItem-only) still sees the data
// written through a previous healthy FakeStorage — writes fail, reads don't.
const localStorageStore = new Map<string, string>();
class FakeStorage implements Storage {
    get length(): number { return localStorageStore.size; }
    clear(): void { localStorageStore.clear(); }
    getItem(key: string): string | null { return localStorageStore.get(key) ?? null; }
    key(index: number): string | null { return Array.from(localStorageStore.keys())[index] ?? null; }
    removeItem(key: string): void { localStorageStore.delete(key); }
    setItem(key: string, value: string): void { localStorageStore.set(key, value); }
}

/** localStorage whose writes always fail (quota/private-mode simulation).
 *  Reads still work — the persistence failure is isolated to setItem. */
class ThrowingStorage extends FakeStorage {
    override setItem(): void {
        throw new Error("QuotaExceededError");
    }
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

/** Multi-chain fixture: two independent audio chains on the SOURCE project. */
async function makeDualChainSource(): Promise<{
    doc: any;
    chainA: { synth: any; chorus: any; mixer: any };
    chainB: { synth: any; delay: any; mixer: any };
}> {
    const doc: any = await createOfflineDocument({ validated: true });
    await doc.modify((t: any) => {
        t.create("pulverisateur", { displayName: "SYNTH A" });
        t.create("stompboxChorus", { displayName: "CHORUS A" });
        t.create("mixerChannel", { displayName: "MIXER A" });
        t.create("heisenberg", { displayName: "SYNTH B" });
        t.create("stompboxDelay", { displayName: "DELAY B" });
        t.create("mixerChannel", { displayName: "MIXER B" });
    });
    const byType = (type: string, i = 0) =>
        doc.queryEntities.get().filter((x: any) => x.entityType === type)[i];
    await doc.modify((t: any) => {
        t.create("desktopAudioCable", {
            fromSocket: byType("pulverisateur", 0).fields.audioOutput.location,
            toSocket: byType("stompboxChorus", 0).fields.audioInput.location,
        });
        t.create("desktopAudioCable", {
            fromSocket: byType("stompboxChorus", 0).fields.audioOutput.location,
            toSocket: byType("mixerChannel", 0).fields.audioInput.location,
        });
        t.create("desktopAudioCable", {
            fromSocket: byType("heisenberg", 0).fields.audioOutput.location,
            toSocket: byType("stompboxDelay", 0).fields.audioInput.location,
        });
        t.create("desktopAudioCable", {
            fromSocket: byType("stompboxDelay", 0).fields.audioOutput.location,
            toSocket: byType("mixerChannel", 1).fields.audioInput.location,
        });
    });
    return {
        doc,
        chainA: { synth: byType("pulverisateur", 0), chorus: byType("stompboxChorus", 0), mixer: byType("mixerChannel", 0) },
        chainB: { synth: byType("heisenberg", 0), delay: byType("stompboxDelay", 0), mixer: byType("mixerChannel", 1) },
    };
}

/** Build a Metatron device with two controls for binding. */
function makeDualControlDevice() {
    const device = new Device("Test Instrument");
    const ctrlA = new Control("knob", "Control A"); ctrlA.value = 0.5;
    const ctrlB = new Control("knob", "Control B"); ctrlB.value = 0.25;
    device.addControl(ctrlA);
    device.addControl(ctrlB);
    return { device, ctrlAId: ctrlA.id, ctrlBId: ctrlB.id };
}

function bindControl(bm: BindingManager, controlId: string, entity: any, fieldName: string, fieldPath: string) {
    bm.setBinding(controlId, entity.id, fieldName, fieldName, entity.fields[fieldName], fieldPath);
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
        const storage = new FakeStorage();
        storage.clear();
        (globalThis as any).localStorage = storage;
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

    it("F1 save: storage write failure returns ok:false, never a fake success", async () => {
        const { doc, pulv } = await makeSource();
        const { device, cutoffId } = makeDevice();
        const bm = new BindingManager(device);
        bindCutoff(bm, pulv, cutoffId);
        const normal = await exportInstrumentToLibrary(doc, device, bm, "P");
        expect(normal.ok).toBe(true);
        if (!normal.ok || !normal.preset) throw new Error("fixture export failed");
        const countBefore = InstrumentPresetLibrary.list().length;
        expect(countBefore).toBe(1);

        (globalThis as any).localStorage = new ThrowingStorage();
        const saved = InstrumentPresetLibrary.save(normal.preset);
        expect(saved.ok).toBe(false);
        if (saved.ok) throw new Error("expected failure");
        expect(saved.errors?.[0]).toMatch(/persist/i);
        // The failed save must not have persisted anything (store unchanged).
        expect(InstrumentPresetLibrary.list().length).toBe(countBefore);
    });

    it("F1 export: orchestration reports NOT ok:true when persistence fails", async () => {
        const { doc, pulv } = await makeSource();
        const { device, cutoffId } = makeDevice();
        const bm = new BindingManager(device);
        bindCutoff(bm, pulv, cutoffId);
        (globalThis as any).localStorage = new ThrowingStorage();

        const outcome = await exportInstrumentToLibrary(doc, device, bm, "P");
        expect(outcome.ok).toBe(false);
        expect(outcome.entry).toBeUndefined();
        expect(outcome.preset).toBeUndefined();
        expect(outcome.errors?.[0]).toMatch(/persist/i);
        expect(InstrumentPresetLibrary.list().length).toBe(0);
    });

    it("F1 delete: normal delete works, storage write failure returns false", async () => {
        const { entry } = await exportFixture();
        expect(InstrumentPresetLibrary.delete(entry.id)).toBe(true);
        expect(InstrumentPresetLibrary.list().length).toBe(0);
    });

    it("F1 delete: storage write failure is reported as a failed operation", async () => {
        const { entry } = await exportFixture();
        (globalThis as any).localStorage = new ThrowingStorage();
        expect(InstrumentPresetLibrary.delete(entry.id)).toBe(false);
        expect(InstrumentPresetLibrary.list().length).toBe(1);
    });
});

describe("P4 — Instrument Preset export (binding-based union selection, M19.3)", () => {
    beforeEach(() => {
        const storage = new FakeStorage();
        storage.clear();
        (globalThis as any).localStorage = storage;
    });

    it("1. One bound device in one chain exports that complete chain", async () => {
        const { doc, chainA } = await makeDualChainSource();
        const { device, ctrlAId } = makeDualControlDevice();
        const bm = new BindingManager(device);
        bindControl(bm, ctrlAId, chainA.synth, "cutoffFrequencyHz", "filter.cutoffFrequencyHz");
        const outcome = await exportInstrumentToLibrary(doc, device, bm, "Single Chain");
        expect(outcome.ok).toBe(true);
        const preset = parseInstrumentPreset(outcome.entry!.presetJson);
        // Both synth and chorus and mixer should be in snapshot (chain A complete)
        const deviceTypes = preset.chain.snapshot.devices.map((d) => d.entityType);
        expect(deviceTypes).toContain("pulverisateur");
        expect(deviceTypes).toContain("stompboxChorus");
        expect(deviceTypes).toContain("mixerChannel");
        // Chain B devices NOT included (no binding there)
        const chainBTypes = deviceTypes.filter((t) => t === "heisenberg" || t === "stompboxDelay");
        expect(chainBTypes.length).toBe(0);
    });

    it("2. Two bound devices in the same chain export that chain only once (no duplicates)", async () => {
        const { doc, chainA } = await makeDualChainSource();
        const { device, ctrlAId, ctrlBId } = makeDualControlDevice();
        const bm = new BindingManager(device);
        bindControl(bm, ctrlAId, chainA.synth, "cutoffFrequencyHz", "filter.cutoffFrequencyHz");
        bindControl(bm, ctrlBId, chainA.chorus, "delayTimeMs", "delayTimeMs");
        const outcome = await exportInstrumentToLibrary(doc, device, bm, "Same Chain Dual");
        expect(outcome.ok).toBe(true);
        const preset = parseInstrumentPreset(outcome.entry!.presetJson);
        // No duplicate devices (each sourceEntityId appears once)
        const ids = preset.chain.snapshot.devices.map((d) => d.sourceEntityId);
        const uniqueIds = new Set(ids);
        expect(ids.length).toBe(uniqueIds.size);
        // All three devices of chain A present
        const deviceTypes = preset.chain.snapshot.devices.map((d) => d.entityType);
        expect(deviceTypes).toContain("pulverisateur");
        expect(deviceTypes).toContain("stompboxChorus");
        expect(deviceTypes).toContain("mixerChannel");
    });

    it("3. Two bound devices in independent chains export both complete chains", async () => {
        const { doc, chainA, chainB } = await makeDualChainSource();
        const { device, ctrlAId, ctrlBId } = makeDualControlDevice();
        const bm = new BindingManager(device);
        bindControl(bm, ctrlAId, chainA.synth, "cutoffFrequencyHz", "filter.cutoffFrequencyHz");
        bindControl(bm, ctrlBId, chainB.synth, "tuneSemitones", "tuneSemitones");
        const outcome = await exportInstrumentToLibrary(doc, device, bm, "Dual Chain");
        expect(outcome.ok).toBe(true);
        const preset = parseInstrumentPreset(outcome.entry!.presetJson);
        const deviceTypes = preset.chain.snapshot.devices.map((d) => d.entityType);
        // Chain A complete
        expect(deviceTypes).toContain("pulverisateur");
        expect(deviceTypes).toContain("stompboxChorus");
        expect(deviceTypes).toContain("mixerChannel");
        // Chain B complete (heisenberg + stompboxDelay + mixerChannel)
        // There are two mixerChannels total in the project; snapshot should include both (one per chain)
        const mixerCount = deviceTypes.filter((t) => t === "mixerChannel").length;
        expect(mixerCount).toBe(2);
        expect(deviceTypes).toContain("heisenberg");
        expect(deviceTypes).toContain("stompboxDelay");
    });

    it("4. Bound device in the middle of a chain includes upstream and downstream devices", async () => {
        const { doc, chainA } = await makeDualChainSource();
        const { device, ctrlAId } = makeDualControlDevice();
        const bm = new BindingManager(device);
        // Bind to the middle device (chorus)
        bindControl(bm, ctrlAId, chainA.chorus, "delayTimeMs", "delayTimeMs");
        const outcome = await exportInstrumentToLibrary(doc, device, bm, "Middle Bound");
        expect(outcome.ok).toBe(true);
        const preset = parseInstrumentPreset(outcome.entry!.presetJson);
        const deviceTypes = preset.chain.snapshot.devices.map((d) => d.entityType);
        // All three devices of chain A should be included (synth→chorus→mixer)
        expect(deviceTypes).toContain("pulverisateur");
        expect(deviceTypes).toContain("stompboxChorus");
        expect(deviceTypes).toContain("mixerChannel");
    });

    it("5. All selected connections are included in the snapshot", async () => {
        const { doc, chainA } = await makeDualChainSource();
        const { device, ctrlAId } = makeDualControlDevice();
        const bm = new BindingManager(device);
        bindControl(bm, ctrlAId, chainA.synth, "cutoffFrequencyHz", "filter.cutoffFrequencyHz");
        const outcome = await exportInstrumentToLibrary(doc, device, bm, "Connections Check");
        expect(outcome.ok).toBe(true);
        const preset = parseInstrumentPreset(outcome.entry!.presetJson);
        // Chain A has 2 cables: synth→chorus, chorus→mixer
        expect(preset.chain.snapshot.connections.length).toBe(2);
        const conn = preset.chain.snapshot.connections;
        expect(conn.some((c) => c.fromEntityId && c.toEntityId)).toBe(true);
    });

    it("6. No duplicate devices or cables occur in the snapshot", async () => {
        const { doc, chainA, chainB } = await makeDualChainSource();
        const { device, ctrlAId, ctrlBId } = makeDualControlDevice();
        const bm = new BindingManager(device);
        bindControl(bm, ctrlAId, chainA.synth, "cutoffFrequencyHz", "filter.cutoffFrequencyHz");
        bindControl(bm, ctrlBId, chainB.synth, "tuneSemitones", "tuneSemitones");
        const outcome = await exportInstrumentToLibrary(doc, device, bm, "No Duplicates");
        expect(outcome.ok).toBe(true);
        const preset = parseInstrumentPreset(outcome.entry!.presetJson);
        const ids = preset.chain.snapshot.devices.map((d) => d.sourceEntityId);
        const uniqueIds = new Set(ids);
        expect(ids.length).toBe(uniqueIds.size);
        // Connections deduped
        const connKeys = preset.chain.snapshot.connections.map((c) => `${c.fromEntityId}→${c.toEntityId}`);
        const uniqueConns = new Set(connKeys);
        expect(connKeys.length).toBe(uniqueConns.size);
    });

    it("7. Every exported binding resolves to a device inside the snapshot (sourceEntityIndex integrity)", async () => {
        const { doc, chainA, chainB } = await makeDualChainSource();
        const { device, ctrlAId, ctrlBId } = makeDualControlDevice();
        const bm = new BindingManager(device);
        bindControl(bm, ctrlAId, chainA.synth, "cutoffFrequencyHz", "filter.cutoffFrequencyHz");
        bindControl(bm, ctrlBId, chainB.synth, "tuneSemitones", "tuneSemitones");
        const outcome = await exportInstrumentToLibrary(doc, device, bm, "Binding Integrity");
        expect(outcome.ok).toBe(true);
        const preset = parseInstrumentPreset(outcome.entry!.presetJson);
        // Both bindings present
        expect(preset.bindings.length).toBe(2);
        // Each binding's sourceEntityIndex points to a valid device in snapshot.devices
        for (const b of preset.bindings) {
            expect(b.sourceEntityIndex).toBeGreaterThanOrEqual(0);
            expect(b.sourceEntityIndex).toBeLessThan(preset.chain.snapshot.devices.length);
            const snapDev = preset.chain.snapshot.devices[b.sourceEntityIndex];
            expect(snapDev).toBeDefined();
        }
    });

    it("8. Export envelope format remains unchanged (v0.1 structure)", async () => {
        const { doc, chainA } = await makeDualChainSource();
        const { device, ctrlAId } = makeDualControlDevice();
        const bm = new BindingManager(device);
        bindControl(bm, ctrlAId, chainA.synth, "cutoffFrequencyHz", "filter.cutoffFrequencyHz");
        const outcome = await exportInstrumentToLibrary(doc, device, bm, "Format Check");
        expect(outcome.ok).toBe(true);
        const preset = parseInstrumentPreset(outcome.entry!.presetJson);
        // v0.1 envelope fields
        expect(preset.version).toBe("0.1");
        expect(typeof preset.name).toBe("string");
        expect(preset.metatron).toHaveProperty("deviceId");
        expect(preset.metatron).toHaveProperty("presetId");
        expect(preset.metatron).toHaveProperty("controlValues");
        expect(preset.chain).toHaveProperty("snapshot");
        expect(Array.isArray(preset.bindings)).toBe(true);
    });

    it("9. Existing parameter capture (automatable fields) remains unchanged", async () => {
        const { doc, chainA } = await makeDualChainSource();
        const { device, ctrlAId } = makeDualControlDevice();
        const bm = new BindingManager(device);
        bindControl(bm, ctrlAId, chainA.synth, "cutoffFrequencyHz", "filter.cutoffFrequencyHz");
        const outcome = await exportInstrumentToLibrary(doc, device, bm, "Param Capture");
        expect(outcome.ok).toBe(true);
        const preset = parseInstrumentPreset(outcome.entry!.presetJson);
        const synthSnap = preset.chain.snapshot.devices.find((d) => d.entityType === "pulverisateur");
        expect(synthSnap).toBeDefined();
        // Has at least the cutoff field (automatable number)
        const cutoffField = synthSnap!.fields.find((f) => f.path === "filter.cutoffFrequencyHz");
        expect(cutoffField).toBeDefined();
        expect(cutoffField!.primitiveType).toBe("number");
        expect(typeof cutoffField!.value).toBe("number");
    });

    it("10. Existing single-chain export still works (regression)", async () => {
        // Reuses the original single-chain fixture from makeSource()
        const { doc, pulv, mixer } = await makeSource();
        const { device, cutoffId } = makeDevice();
        const bm = new BindingManager(device);
        bindCutoff(bm, pulv, cutoffId);
        const outcome = await exportInstrumentToLibrary(doc, device, bm, "Regression Single");
        expect(outcome.ok).toBe(true);
        const preset = parseInstrumentPreset(outcome.entry!.presetJson);
        expect(preset.chain.snapshot.devices.length).toBe(2);
        expect(preset.bindings.length).toBe(1);
    });

    it("11. Real-graph regression: two active bound entities on independent chains (Heisenberg + Pulverisateur pattern)", async () => {
        const { doc, chainA, chainB } = await makeDualChainSource();
        const { device, ctrlAId, ctrlBId } = makeDualControlDevice();
        const bm = new BindingManager(device);
        // Bind to the two synths (mirrors M19.2 observation: Heisenberg + Pulverisateur)
        bindControl(bm, ctrlAId, chainA.synth, "cutoffFrequencyHz", "filter.cutoffFrequencyHz");
        bindControl(bm, ctrlBId, chainB.synth, "tuneSemitones", "tuneSemitones");
        const outcome = await exportInstrumentToLibrary(doc, device, bm, "Real-Graph Regression");
        expect(outcome.ok).toBe(true);
        const preset = parseInstrumentPreset(outcome.entry!.presetJson);
        const deviceTypes = preset.chain.snapshot.devices.map((d) => d.entityType);
        // Both complete chains selected
        expect(deviceTypes).toContain("pulverisateur");
        expect(deviceTypes).toContain("heisenberg");
        expect(deviceTypes.filter((t) => t === "mixerChannel").length).toBe(2);
        // Both bindings resolve
        expect(preset.bindings.length).toBe(2);
        for (const b of preset.bindings) {
            expect(b.sourceEntityIndex).toBeGreaterThanOrEqual(0);
            expect(b.sourceEntityIndex).toBeLessThan(preset.chain.snapshot.devices.length);
        }
    });
});