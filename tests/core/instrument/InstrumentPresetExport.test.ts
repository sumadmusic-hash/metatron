import { describe, it, expect, beforeAll } from "vitest";
import { createOfflineDocument } from "@audiotool/nexus/node";
import { createSnapshot } from "../../../src/nexus/ChainSnapshot";
import { normalizeEntityId } from "../../../src/nexus/ChainDiscovery";
import { Device } from "../../../src/core/model/Device";
import { Control } from "../../../src/core/model/Control";
import {
    createNexusValueMappingFromSchema,
} from "../../../src/nexus/NexusValueMapping";
import { exportInstrumentPreset } from "../../../src/core/instrument/InstrumentPresetExport";
import {
    parseInstrumentPreset,
    serializeInstrumentPreset,
    validateInstrumentPreset,
} from "../../../src/core/instrument/InstrumentPreset";
import type { ChainSnapshot } from "../../../src/nexus/ChainTypes";
import type { InstrumentPresetExportInput } from "../../../src/core/instrument/InstrumentPresetExport";

/**
 * PHASE B — SOURCE → InstrumentPreset v0.1 export.
 * Uses a REAL offline Nexus SOURCE document (read-only) + a REAL Metatron
 * Device/Preset. The export must be pure: no target, no DOM, no Nexus write.
 */

describe("InstrumentPresetExport v0.1 — fixture (real offline SOURCE)", () => {
    let snapshot: ChainSnapshot;
    let device: Device;
    let cutoffControl: Control;
    let flangerControl: Control;
    let resonanceControl: Control;
    let lateControl: Control;
    let presetId: string;
    let input: () => InstrumentPresetExportInput;

    beforeAll(async () => {
        const source: any = await createOfflineDocument({ validated: true });
        await source.modify((t: any) => {
            t.create("pulverisateur", { displayName: "SYNTH" });
            t.create("stompboxChorus", { displayName: "CHORUS" });
            t.create("stompboxFlanger", { displayName: "FLANGER" });
            t.create("mixerChannel", { displayName: "MIXER" });
        });
        const byType = (type: string) =>
            source.queryEntities.get().find((e: any) => e.entityType === type) as any;
        const pulv = byType("pulverisateur");
        const chorus = byType("stompboxChorus");
        const flanger = byType("stompboxFlanger");
        const mixer = byType("mixerChannel");
        await source.modify((t: any) => {
            t.create("desktopAudioCable", { fromSocket: pulv.fields.audioOutput.location, toSocket: chorus.fields.audioInput.location });
            t.create("desktopAudioCable", { fromSocket: chorus.fields.audioOutput.location, toSocket: flanger.fields.audioInput.location });
            t.create("desktopAudioCable", { fromSocket: flanger.fields.audioOutput.location, toSocket: mixer.fields.audioInput.location });
        });
        snapshot = createSnapshot(source, pulv.id);

        // Metatron instrument with controls + a saved preset
        device = new Device("Lead");
        cutoffControl = new Control("knob", "Cutoff");
        cutoffControl.value = 0.5;
        flangerControl = new Control("rotary", "Flanger");
        flangerControl.value = 0;
        resonanceControl = new Control("switch", "Resonance");
        resonanceControl.value = 1;
        device.addControl(cutoffControl);
        device.addControl(flangerControl);
        device.addControl(resonanceControl);
        const preset = device.savePreset("Crunch Lead");
        presetId = preset.id;

        // A control added AFTER saving → bound but explicitly without stored value
        lateControl = new Control("knob", "Late");
        device.addControl(lateControl);

        input = () => ({
            device,
            preset,
            snapshot,
            bindings: [
                { controlId: cutoffControl.id, sourceEntityId: pulv.id, fieldPath: "filter.cutoffFrequencyHz" },
                { controlId: flangerControl.id, sourceEntityId: flanger.id, fieldPath: "lfoModulationDepth" },
                { controlId: resonanceControl.id, sourceEntityId: pulv.id, fieldPath: "filter.resonance" },
                { controlId: lateControl.id, sourceEntityId: pulv.id, fieldPath: "filter.resonance" },
            ],
        });
    });

    it("A. export returns ok:true with a valid v0.1 envelope", () => {
        const result = exportInstrumentPreset(input());
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.preset.version).toBe("0.1");
        expect(result.preset.name).toBe("Crunch Lead");
        expect(result.preset.metatron.deviceId).toBe(device.id);
        expect(result.preset.metatron.presetId).toBe(presetId);
        expect(validateInstrumentPreset(result.preset).valid).toBe(true);
    });

    it("B. chain.snapshot is preserved exactly (real SOURCE capture)", () => {
        const result = exportInstrumentPreset(input());
        if (!result.ok) return;
        expect(result.preset.chain.snapshot).toEqual(snapshot);
        expect(result.preset.chain.snapshot.devices).toHaveLength(4);
        expect(result.preset.chain.snapshot.connections).toHaveLength(3);
        // serialization round-trips the exported envelope
        const restored = parseInstrumentPreset(serializeInstrumentPreset(result.preset));
        expect(restored).toEqual(result.preset);
    });

    it("C. sourceEntityIndex is EXACTLY the index inside snapshot.devices", () => {
        const result = exportInstrumentPreset(input());
        if (!result.ok) return;
        const idxByType = new Map(snapshot.devices.map((d, i) => [d.entityType, i]));
        const byControl = new Map(result.preset.bindings.map((b) => [b.controlId, b]));
        const cutoff = byControl.get(cutoffControl.id)!;
        const flanger = byControl.get(flangerControl.id)!;
        const resonance = byControl.get(resonanceControl.id)!;
        expect(cutoff.sourceEntityIndex).toBe(idxByType.get("pulverisateur")!);
        expect(flanger.sourceEntityIndex).toBe(idxByType.get("stompboxFlanger")!);
        expect(resonance.sourceEntityIndex).toBe(idxByType.get("pulverisateur")!);
        // the index resolves via normalizeEntityId, exactly like the snapshot layer
        for (const b of result.preset.bindings) {
            const snapDevice = snapshot.devices[b.sourceEntityIndex];
            expect(snapDevice).toBeDefined();
            expect(normalizeEntityId(snapDevice.sourceEntityId)).toBe(normalizeEntityId(
                input().bindings.find((s) => s.controlId === b.controlId)!.sourceEntityId,
            ));
        }
        expect(result.preset.bindings.map((b) => b.fieldPath)).toEqual([
            "filter.cutoffFrequencyHz",
            "lfoModulationDepth",
            "filter.resonance",
            "filter.resonance",
        ]);
    });

    it("D. valueMapping is schema-derived (pure), matching createNexusValueMappingFromSchema", () => {
        const result = exportInstrumentPreset(input());
        if (!result.ok) return;
        const byControl = new Map(result.preset.bindings.map((b) => [b.controlId, b]));
        for (const b of result.preset.bindings) {
            const snapDevice = snapshot.devices[b.sourceEntityIndex];
            const field = snapDevice.fields.find((f) => f.path === b.fieldPath)!;
            const expected = createNexusValueMappingFromSchema(field.range, field.scalarType, field.primitiveType);
            expect(b.valueMapping).toEqual(expected);
        }
        // proven spot-checks: cutoff [18,15500] float, resonance [0,1]
        const cutoff = byControl.get(cutoffControl.id)!;
        expect(cutoff.valueMapping).toEqual({ kind: "linear", min: 18, max: 15500, isInteger: false, typeLabel: "number" });
        const resonance = byControl.get(resonanceControl.id)!;
        expect(resonance.valueMapping).toEqual({ kind: "linear", min: 0, max: 1, isInteger: false, typeLabel: "number" });
    });

    it("E. controlValues carry the normalized 0/0.5/1 values untouched", () => {
        const result = exportInstrumentPreset(input());
        if (!result.ok) return;
        expect(result.preset.metatron.controlValues).toEqual({
            [cutoffControl.id]: 0.5,
            [flangerControl.id]: 0,
            [resonanceControl.id]: 1,
        });
    });

    it("J. bindings carry only logical identity — no source id leaks", () => {
        const result = exportInstrumentPreset(input());
        if (!result.ok) return;
        // M23.2 — the envelope additively carries OPTIONAL control descriptors
        // (controlName/controlType/controlNameSource). The logical identity set
        // (controlId/sourceEntityIndex/fieldPath/valueMapping) is unchanged and
        // no other keys may appear.
        for (const b of result.preset.bindings) {
            const allowed = ["controlId", "controlName", "controlType", "controlNameSource", "fieldPath", "sourceEntityIndex", "valueMapping"];
            for (const k of Object.keys(b)) {
                expect(allowed).toContain(k);
            }
            expect(Object.keys(b).sort()).toEqual(
                expect.arrayContaining(["controlId", "fieldPath", "sourceEntityIndex", "valueMapping"]),
            );
            expect(device.controls.has(b.controlId)).toBe(true);
            // a knob/switch control must carry its descriptor; a runtime-only
            // type (rotary) must NOT emit a controlType
            const liveControl = device.controls.get(b.controlId)!;
            if (liveControl.type === "knob" || liveControl.type === "switch") {
                expect(b.controlName).toBe(liveControl.name);
                expect(b.controlType).toBe(liveControl.type);
            } else {
                expect(b.controlType).toBeUndefined();
            }
        }
        const json = serializeInstrumentPreset(result.preset);
        for (const s of input().bindings) {
            // the project-specific document entity id never appears as a binding identity;
            // it stays confined to chain.snapshot.devices[].sourceEntityId (the source capture)
            const meta: string[] = result.preset.bindings.map((b) => JSON.stringify(b));
            expect(meta.some((m) => m.includes(s.sourceEntityId))).toBe(false);
        }
        void json;
    });

    it("bound control WITHOUT a stored value → ok:true with a warning (binding travels, value does not)", () => {
        const result = exportInstrumentPreset(input());
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.warnings.some((w) => w.includes(lateControl.id) && w.includes("no value"))).toBe(true);
        expect(result.preset.metatron.controlValues[lateControl.id]).toBeUndefined();
    });
});

describe("InstrumentPresetExport v0.1 — F. pure mapping builder (schema only, no live field)", () => {
    it("linear [18,15500] float", () => {
        expect(createNexusValueMappingFromSchema({ min: 18, max: 15500 }, 2, "number"))
            .toEqual({ kind: "linear", min: 18, max: 15500, isInteger: false, typeLabel: "number" });
    });
    it("linear [-1,1] float", () => {
        expect(createNexusValueMappingFromSchema({ min: -1, max: 1 }, 2, "number"))
            .toEqual({ kind: "linear", min: -1, max: 1, isInteger: false, typeLabel: "number" });
    });
    it("linear [0,1] float", () => {
        expect(createNexusValueMappingFromSchema({ min: 0, max: 1 }, 2, "number"))
            .toEqual({ kind: "linear", min: 0, max: 1, isInteger: false, typeLabel: "number" });
    });
    it("linear [1,2] integer scalar (5=INT32) rounds on write", () => {
        expect(createNexusValueMappingFromSchema({ min: 1, max: 2 }, 5, "number"))
            .toEqual({ kind: "linear", min: 1, max: 2, isInteger: true, typeLabel: "number" });
    });
    it("boolean", () => {
        expect(createNexusValueMappingFromSchema(undefined, undefined, "boolean"))
            .toEqual({ kind: "boolean", typeLabel: "boolean" });
    });
    it("string → unsupported (honest refusal, no fake linear)", () => {
        expect(createNexusValueMappingFromSchema(undefined, undefined, "string").kind).toBe("unsupported");
    });
    it("number without range → unsupported", () => {
        expect(createNexusValueMappingFromSchema(undefined, 2, "number").kind).toBe("unsupported");
    });
});

describe("InstrumentPresetExport v0.1 — honest errors", () => {
    let base: () => InstrumentPresetExportInput;

    beforeAll(async () => {
        const source: any = await createOfflineDocument({ validated: true });
        await source.modify((t: any) => {
            t.create("pulverisateur", {});
        });
        const pulv = source.queryEntities.get().find((e: any) => e.entityType === "pulverisateur") as any;
        const snap = createSnapshot(source, pulv.id);
        const d = new Device("E");
        const c = new Control("knob", "K");
        c.value = 0.5;
        d.addControl(c);
        d.savePreset("P");
        base = () => ({
            device: d,
            preset: Array.from(d.presets.values())[0],
            snapshot: snap,
            bindings: [{ controlId: c.id, sourceEntityId: pulv.id, fieldPath: "filter.cutoffFrequencyHz" }],
        });
    });

    it("G. unsupported (non-numeric) field → ok:false, no fake linear mapping", () => {
        const input = base();
        const snap = structuredClone(input.snapshot) as ChainSnapshot;
        snap.devices[0].fields.push({ path: "label", value: "x", primitiveType: "string", mutable: true });
        const result = exportInstrumentPreset({ ...input, snapshot: snap, bindings: [
            { ...input.bindings[0], fieldPath: "label" },
        ]});
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors.some((e) => e.includes("no supported numeric mapping"))).toBe(true);
    });

    it("H. fieldPath not found on the snapshot device → ok:false", () => {
        const input = base();
        const result = exportInstrumentPreset({ ...input, bindings: [
            { ...input.bindings[0], fieldPath: "filter.doesNotExist" },
        ]});
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.errors.some((e) => e.includes("doesNotExist"))).toBe(true);
    });

    it("H2. sourceEntityId not in snapshot.devices → ok:false", () => {
        const input = base();
        const result = exportInstrumentPreset({ ...input, bindings: [
            { ...input.bindings[0], sourceEntityId: "00000000-0000-0000-0000-000000000000" },
        ]});
        expect(result.ok).toBe(false);
    });

    it("H3. duplicate binding for the same control → ok:false (no silent merge)", () => {
        const input = base();
        const result = exportInstrumentPreset({
            ...input,
            bindings: [
                input.bindings[0],
                { ...input.bindings[0], fieldPath: "filter.resonance" },
            ],
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.errors.some((e) => e.includes("duplicate binding"))).toBe(true);
    });

    it("I. out-of-range control value → ok:false (no clamping)", () => {
        const input = base();
        const preset = input.preset;
        preset.controlValues[input.bindings[0].controlId] = 1.5;
        const result = exportInstrumentPreset({ ...input, preset });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.errors.some((e) => e.includes("0..1"))).toBe(true);
    });

    it("I2. binding for a control that does not exist on the device → ok:false", () => {
        const input = base();
        const result = exportInstrumentPreset({ ...input, bindings: [
            { controlId: "ctl_unknown", sourceEntityId: input.bindings[0].sourceEntityId, fieldPath: "filter.cutoffFrequencyHz" },
        ]});
        expect(result.ok).toBe(false);
    });
});