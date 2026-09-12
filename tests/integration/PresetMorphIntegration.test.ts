import { describe, it, expect } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { Preset } from "../../src/core/model/Preset";
import { applyMorphToDevice, MorphValueSink } from "../../src/integration/PresetMorphIntegration";

function preset(name: string, deviceId: string, values: Record<string, number>): Preset {
    const p = new Preset(name, deviceId);
    p.controlValues = { ...values };
    return p;
}

function bind(control: Control, state: "CONNECTED" | "DISCONNECTED" | "UNCONFIGURED") {
    control.activeBindingState = state;
    if (state !== "UNCONFIGURED") {
        control.audiotoolBindingDefinition = {
            entityId: "entity-1",
            fieldPath: "filter.cutoffFrequency",
            targetName: "filter/cutoffFrequency",
        } as any;
    }
}

function makeDevice() {
    const d = new Device("Morph Host");
    const shared = new Control("knob", "Shared");
    shared.value = 0.5;
    const onlyA = new Control("knob", "Only A");
    onlyA.value = 0.1;
    const onlyB = new Control("knob", "Only B");
    onlyB.value = 0.9;
    const sw = new Control("switch", "Switch");
    sw.value = 0;
    const unused = new Control("knob", "Unused");
    unused.value = 0.42;
    d.addControl(shared);
    d.addControl(onlyA);
    d.addControl(onlyB);
    d.addControl(sw);
    d.addControl(unused);
    return { d, shared, onlyA, onlyB, sw, unused };
}

class RecordingSink implements MorphValueSink {
    calls: { controlId: string; value: number }[] = [];
    result = true;
    async updateBoundControl(controlId: string, value: number): Promise<boolean> {
        this.calls.push({ controlId, value });
        return this.result;
    }
}

function flush() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("applyMorphToDevice (M10)", () => {
    const A = "presetA";
    const B = "presetB";

    it("1 — shared controls receive interpolated values", () => {
        const { d, shared } = makeDevice();
        bind(shared, "UNCONFIGURED");
        const pa = preset(A, d.id, { [shared.id]: 0.2 });
        const pb = preset(B, d.id, { [shared.id]: 0.8 });

        applyMorphToDevice(d, pa, pb, 0.5, new RecordingSink());
        expect(shared.value).toBeCloseTo(0.5, 10);
    });

    it("2 — A-only control keeps the A value", () => {
        const { d, shared, onlyA } = makeDevice();
        bind(onlyA, "UNCONFIGURED");
        const pa = preset(A, d.id, { [shared.id]: 0.5, [onlyA.id]: 0.1 });
        const pb = preset(B, d.id, { [shared.id]: 0.5 });

        applyMorphToDevice(d, pa, pb, 0.5, new RecordingSink());
        expect(onlyA.value).toBe(0.1);
    });

    it("3 — B-only control keeps the B value", () => {
        const { d, shared, onlyB } = makeDevice();
        bind(onlyB, "UNCONFIGURED");
        const pa = preset(A, d.id, { [shared.id]: 0.5 });
        const pb = preset(B, d.id, { [shared.id]: 0.5, [onlyB.id]: 0.9 });

        applyMorphToDevice(d, pa, pb, 0.5, new RecordingSink());
        expect(onlyB.value).toBe(0.9);
    });

    it("4 — switch values from M9 are applied unchanged", () => {
        const { d, sw } = makeDevice();
        bind(sw, "UNCONFIGURED");
        const pa = preset(A, d.id, { [sw.id]: 0.2 });
        const pb = preset(B, d.id, { [sw.id]: 0.8 });

        applyMorphToDevice(d, pa, pb, 0.5, new RecordingSink());
        expect(sw.value).toBe(1); // M9 quantized 0.5 → 1, applied as-is
    });

    it("5 — controls not present in the morph result remain unchanged", () => {
        const { d, unused } = makeDevice();
        bind(unused, "UNCONFIGURED");
        const pa = preset(A, d.id, { ["other"]: 0.3 });
        const pb = preset(B, d.id, { ["other2"]: 0.9 });

        applyMorphToDevice(d, pa, pb, 0.5, new RecordingSink());
        expect(unused.value).toBe(0.42);
        expect(d.getActiveControlCount()).toBe(5);
    });

    it("6 — control name and binding metadata remain unchanged", () => {
        const { d, shared } = makeDevice();
        bind(shared, "CONNECTED");
        const bindingBefore = shared.audiotoolBindingDefinition;
        const nameBefore = shared.name;
        const pa = preset(A, d.id, { [shared.id]: 0.2 });
        const pb = preset(B, d.id, { [shared.id]: 0.8 });

        applyMorphToDevice(d, pa, pb, 0.5, new RecordingSink());
        expect(shared.name).toBe(nameBefore);
        expect(shared.audiotoolBindingDefinition).toBe(bindingBefore);
        expect(shared.type).toBe("knob");
    });

    it("7 — local values update even when the Nexus write refuses", async () => {
        const { d, shared } = makeDevice();
        bind(shared, "CONNECTED");
        const sink = new RecordingSink();
        sink.result = false;
        const pa = preset(A, d.id, { [shared.id]: 0.2 });
        const pb = preset(B, d.id, { [shared.id]: 0.8 });

        applyMorphToDevice(d, pa, pb, 0.5, sink);
        await flush();
        expect(shared.value).toBeCloseTo(0.5, 10);
        expect(sink.calls.length).toBe(1);
    });

    it("8 — only CONNECTED bound controls go through the write sink", async () => {
        const { d, shared, onlyB, sw } = makeDevice();
        bind(shared, "CONNECTED");
        bind(onlyB, "DISCONNECTED");
        bind(sw, "UNCONFIGURED");
        const sink = new RecordingSink();

        const pa = preset(A, d.id, { [shared.id]: 0.2, [onlyB.id]: 0.3, [sw.id]: 0.2 });
        const pb = preset(B, d.id, { [shared.id]: 0.8, [onlyB.id]: 0.9, [sw.id]: 0.8 });

        applyMorphToDevice(d, pa, pb, 0.5, sink);
        await flush();

        expect(onlyB.value).toBeCloseTo(0.6, 10); // local, DISCONNECTED not written
        expect(sw.value).toBe(1);

        expect(sink.calls.map((c) => c.controlId)).toEqual([shared.id]);
        expect(sink.calls[0].value).toBeCloseTo(0.5, 10);
    });

    it("9 — no controls are created or deleted", () => {
        const { d, shared } = makeDevice();
        bind(shared, "CONNECTED");
        const sizeBefore = d.controls.size;
        const activeBefore = d.getActiveControlCount();
        const pa = preset(A, d.id, { [shared.id]: 0.2, ghost: 0.9 });
        const pb = preset(B, d.id, { [shared.id]: 0.8, ghost: 0.1 });

        applyMorphToDevice(d, pa, pb, 0.5, new RecordingSink());
        expect(d.controls.size).toBe(sizeBefore);
        expect(d.getActiveControlCount()).toBe(activeBefore);
    });

    it("10 — preset A and B are not mutated", () => {
        const { d, shared } = makeDevice();
        bind(shared, "CONNECTED");
        const pa = preset(A, d.id, { [shared.id]: 0.2, extra: 0.9 });
        const pb = preset(B, d.id, { [shared.id]: 0.8, extra: 0.1 });
        const paBefore = JSON.stringify(pa.controlValues);
        const pbBefore = JSON.stringify(pb.controlValues);

        applyMorphToDevice(d, pa, pb, 0.5, new RecordingSink());
        applyMorphToDevice(d, pa, pb, 1.5, new RecordingSink());
        expect(JSON.stringify(pa.controlValues)).toBe(paBefore);
        expect(JSON.stringify(pb.controlValues)).toBe(pbBefore);
    });

    it("11 — existing preset load behavior remains unchanged", () => {
        const { d, shared, sw } = makeDevice();
        shared.value = 0.6;
        sw.value = 0;
        d.savePreset("Snap");

        shared.value = 0.1;
        sw.value = 1;
        const snap = d.presets.values().next().value;
        d.loadPreset(snap.id);
        expect(shared.value).toBe(0.6);
        expect(sw.value).toBe(0);
    });
});