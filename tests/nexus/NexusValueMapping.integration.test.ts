import { describe, it, expect, beforeAll } from "vitest";
import { createOfflineDocument } from "@audiotool/nexus/node";
import { NexusLearn } from "../../src/nexus/NexusLearn";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { createNexusValueMapping, mapNexusToNormalized } from "../../src/nexus/NexusValueMapping";
import { BindingManager } from "../../src/core/BindingManager";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";

/**
 * GENERIC NEXUS VALUE MAPPING — proof against the real SDK + WASM validator.
 *
 * Reproduces the live bug ("value 1 out of range [18, 15500]",
 * filter.cutoffFrequencyHz) and proves the fix: the normalized Metatron value
 * is mapped into the schema-declared range before writing, so validation PASSES.
 *
 * NOTE: a failing (out-of-range) modify on the offline document blocks the
 * transaction lock, so the deliberate FAILING write lives in its own fresh doc.
 *
 * LIMITATION: offline document. Live OAuth + real project must still be
 * verified in the browser; everything network-independent is proven here.
 */

async function newDoc() {
    return await createOfflineDocument({ validated: true }) as any;
}

async function addPulv(doc: any) {
    await doc.modify((t: any) => {
        t.create("pulverisateur", { displayName: "MAP" });
    });
    return doc.queryEntities.get().find((e: any) => e.fields.displayName.value === "MAP");
}

async function learnField(doc: any, field: any, changeTo: any) {
    const learn = new NexusLearn(doc as any);
    const p = learn.startLearn({ filterToAutomatableParameters: true });
    await doc.modify((t: any) => { t.update(field, changeTo); });
    return p;
}

function build(device: Device, doc: any, result: any) {
    const ctl = Array.from(device.controls.values())[0];
    const manager = new BindingManager(device);
    manager.applyLearnResult(ctl.id, result);
    const adapter = new NexusAdapter();
    (adapter as any).document = doc;
    (adapter as any).bindingManager = manager;
    return { manager, adapter, ctl };
}

describe("REAL NEXUS VALUE MAPPING (offline document, validated WASM)", () => {
    let doc: any;
    let pulv: any;
    let cutoffField: any;

    beforeAll(async () => {
        doc = await newDoc();
        pulv = await addPulv(doc);
        expect(pulv).toBeDefined();
        cutoffField = pulv.fields.filter.fields.cutoffFrequencyHz;
        const mapping = createNexusValueMapping(cutoffField);
        expect(mapping.kind).toBe("linear");
        expect(mapping.min).toBe(18);
        expect(mapping.max).toBe(15500);
    });

    it("1. reproduce live bug: raw Metatron 1.0 hits 'out of range [18, 15500]'", async () => {
        const d = await newDoc();
        const pv = await addPulv(d);
        let failed = false;
        try {
            await d.modify((t: any) => { t.update(pv.fields.filter.fields.cutoffFrequencyHz, 1); });
        } catch (e: any) {
            failed = /out of range/.test(String(e?.message ?? e));
        }
        expect(failed).toBe(true); // the exact live failure, reproduced
    });

    it("2. mapped write: 1.0 -> 15500 and 0.0 -> 18 both PASS validation", async () => {
        const result = await learnField(doc, cutoffField, 4000);
        expect(result.valueMapping?.kind).toBe("linear");
        expect(result.valueMapping?.min).toBe(18);
        expect(result.valueMapping?.max).toBe(15500);

        const device = new Device("Cutoff");
        device.addControl(new Control("knob", "Cutoff"));
        const { adapter, ctl } = build(device, doc, result);

        const okHigh = await adapter.updateBoundControl(ctl.id, 1.0);
        expect(okHigh).toBe(true);
        expect(doc.queryEntities.getEntity(pulv.id).fields.filter.fields.cutoffFrequencyHz.value).toBe(15500);

        const okLow = await adapter.updateBoundControl(ctl.id, 0.0);
        expect(okLow).toBe(true);
        expect(doc.queryEntities.getEntity(pulv.id).fields.filter.fields.cutoffFrequencyHz.value).toBe(18);
    });

    it("3. round trip: 0.5 -> nexus ~7759 -> read back ~0.5 (not the raw 7759)", async () => {
        const midpointNexus = 18 + 0.5 * (15500 - 18); // 7759

        const result = await learnField(doc, cutoffField, 1000);
        const device = new Device("RT");
        device.addControl(new Control("knob", "RT"));
        const { adapter, ctl } = build(device, doc, result);

        const ok = await adapter.updateBoundControl(ctl.id, 0.5);
        expect(ok).toBe(true);
        const written = doc.queryEntities.getEntity(pulv.id).fields.filter.fields.cutoffFrequencyHz.value;
        expect(written).toBeCloseTo(midpointNexus, 1); // float32 field

        // READ direction via a live subscription (as the DAW would echo/change it).
        let received: number | null = null;
        adapter.onNexusValueChanged = (_cid, v) => { received = v; };
        adapter.subscribeBoundControl(ctl.id);
        await doc.modify((t: any) => { t.update(cutoffField, midpointNexus); });
        await new Promise((r) => setTimeout(r, 50));
        expect(received).not.toBeNull();
        expect(received!).toBeCloseTo(0.5, 2); // normalized, NOT ~7759

        expect(mapNexusToNormalized(result.valueMapping!, written)).toBeCloseTo(0.5, 2);
    });

    it("4. boolean switch: 'on' writes true, never a fraction 0.37", async () => {
        const isActive = pulv.fields.oscillatorA.fields.channel.fields.isActive;
        const result = await learnField(doc, isActive, false); // true -> false captures
        expect(result.valueMapping?.kind).toBe("boolean");

        const device = new Device("Switch");
        device.addControl(new Control("switch", "OscA"));
        const { adapter, ctl } = build(device, doc, result);

        const ok = await adapter.updateBoundControl(ctl.id, 1);
        expect(ok).toBe(true);
        expect(doc.queryEntities.getEntity(pulv.id).fields.oscillatorA.fields.channel.fields.isActive.value).toBeTruthy();

        let received: number | null = null;
        adapter.onNexusValueChanged = (_cid, v) => { received = v; };
        adapter.subscribeBoundControl(ctl.id);
        await doc.modify((t: any) => { t.update(isActive, false); });
        await new Promise((r) => setTimeout(r, 50));
        expect(received).toBe(0);
    });

    it("5. integer enum-like node (filter.modeIndex [1,2]) is rounded and in range", async () => {
        const modeIndex = pulv.fields.filter.fields.modeIndex;
        const result = await learnField(doc, modeIndex, 2); // 1 -> 2 captures
        expect(result.valueMapping?.isInteger).toBe(true);

        const device = new Device("Mode");
        device.addControl(new Control("knob", "Mode"));
        const { adapter, ctl } = build(device, doc, result);

        const ok = await adapter.updateBoundControl(ctl.id, 0.75);
        expect(ok).toBe(true);
        const v = doc.queryEntities.getEntity(pulv.id).fields.filter.fields.modeIndex.value;
        expect([1, 2]).toContain(v);
    });
});