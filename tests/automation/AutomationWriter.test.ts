import { describe, it, expect } from "vitest";
import { createOfflineDocument } from "@audiotool/nexus/node";
import { Ticks, secondsToTicks } from "@audiotool/nexus/utils";
import { TargetType, getSchemaLocationDetails } from "@audiotool/nexus/document";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { BindingManager } from "../../src/core/BindingManager";
import { writeAutomationRecording, samplesToEvents } from "../../src/automation/AutomationWriter";
import type { AutomationRecording, AutomationSample } from "../../src/automation/AutomationRecording";

const KNOWN_SAMPLES: AutomationSample[] = [
    { timeSeconds: 0, normalizedValue: 0.0 },
    { timeSeconds: 0.5, normalizedValue: 0.5 },
    { timeSeconds: 2, normalizedValue: 1.0 },
];

function rec(
    entries: { controlId: string; controlType?: string; samples: AutomationSample[] }[],
    overrides: Partial<AutomationRecording> = {}
): AutomationRecording {
    return {
        projectBpm: 120,
        startTick: Ticks.Bars(2), // 30720
        durationSeconds: 2,
        tracks: entries.map((e) => ({ controlId: e.controlId, controlType: e.controlType, samples: e.samples })),
        ...overrides,
    };
}

async function newDoc(): Promise<any> {
    return createOfflineDocument({ validated: true });
}

async function addBassline(doc: any): Promise<string> {
    let id: string | undefined;
    await doc.modify((t: any) => {
        id = t.create("bassline", {}).id;
    });
    return id!;
}

function basslineField(doc: any, basslineId: string, fieldName: string): any {
    return doc.queryEntities.getEntity(basslineId).fields[fieldName];
}

function makeBindings(entries: { controlId: string; entityId: string; fieldPath: string; field?: any }[]) {
    const device = new Device("Test");
    const bindings = new BindingManager(device);
    for (const e of entries) {
        device.addControl(new Control("knob", e.controlId, undefined, e.controlId));
        bindings.setBinding(e.controlId, e.entityId, e.fieldPath, `bassline / ${e.fieldPath}`, e.field, e.fieldPath);
    }
    return bindings;
}

describe("M21.2 — samplesToEvents (deterministic tick conversion)", () => {
    it("maps seconds → ticks via the recording BPM (120 → Beat math)", () => {
        const events = samplesToEvents(KNOWN_SAMPLES, 120);
        expect(events).toEqual([
            { positionTicks: 0, value: 0.0 },
            { positionTicks: 3840, value: 0.5 },
            { positionTicks: 15360, value: 1.0 },
        ]);
    });

    it("collapses same-tick samples (latest value wins) — no invalid double event", () => {
        // At 30 BPM both 0s and 0.0001s resolve to tick 0.
        const events = samplesToEvents(
            [
                { timeSeconds: 0, normalizedValue: 0.2 },
                { timeSeconds: 0.0001, normalizedValue: 0.8 },
            ],
            30
        );
        expect(events).toEqual([{ positionTicks: 0, value: 0.8 }]);
    });

    it("is time-order independent (samples are sorted defensively)", () => {
        const sorted = samplesToEvents(KNOWN_SAMPLES, 120);
        const shuffled = samplesToEvents([...KNOWN_SAMPLES].reverse(), 120);
        expect(shuffled).toEqual(sorted);
    });
});

describe("M21.2 — writeAutomationRecording offline", () => {
    it("one knob control → AutomationTrack + Collection + Events + Region with readback", async () => {
        const doc = await newDoc();
        const basslineId = await addBassline(doc);
        const cutoff = basslineField(doc, basslineId, "cutoffFrequencyHz");
        const bindings = makeBindings([
            { controlId: "c1", entityId: basslineId, fieldPath: "cutoffFrequencyHz", field: cutoff },
        ]);

        const result = await writeAutomationRecording(rec([{ controlId: "c1", controlType: "knob", samples: KNOWN_SAMPLES }]), doc, bindings);

        expect(result.ok).toBe(true);
        expect(result.createdTracks).toBe(1);
        expect(result.perTrack).toHaveLength(1);
        expect(result.perTrack[0]).toMatchObject({ ok: true, controlId: "c1", eventCount: 3 });

        // Entity structure (M21.1.1-proven): 1 track, 1 collection, 3 events, 1 region, 1 bassline.
        const tracks = doc.queryEntities.ofTypes("automationTrack").get();
        const collections = doc.queryEntities.ofTypes("automationCollection").get();
        const events = doc.queryEntities
            .ofTypes("automationEvent")
            .get()
            .sort((a: any, b: any) => a.fields.positionTicks.value - b.fields.positionTicks.value);
        const regions = doc.queryEntities.ofTypes("automationRegion").get();
        expect(tracks).toHaveLength(1);
        expect(collections).toHaveLength(1);
        expect(events).toHaveLength(3);
        expect(regions).toHaveLength(1);

        const track: any = tracks[0];
        expect(track.fields.orderAmongTracks.value).toBe(1);
        expect(track.fields.automatedParameter.value.equals(cutoff.location)).toBe(true);

        const positions = events.map((e: any) => e.fields.positionTicks.value);
        expect(positions).toEqual([0, 3840, 15360]);
        const values = events.map((e: any) => e.fields.value.value);
        expect(values[0]).toBeCloseTo(0.0, 6);
        expect(values[1]).toBeCloseTo(0.5, 6);
        expect(values[2]).toBeCloseTo(1.0, 6);
        for (const e of events) {
            expect(e.fields.slope.value).toBe(0);
            expect(e.fields.interpolation.value).toBe(2); // continuous
        }

        const region: any = regions[0];
        expect(region.fields.region.fields.positionTicks.value).toBe(Ticks.Bars(2)); // startTick applied
        // duration = last event tick + one beat of headroom
        expect(region.fields.region.fields.durationTicks.value).toBe(15360 + Ticks.Beat);
        expect(region.fields.region.fields.collectionOffsetTicks.value).toBe(0);
        // events stay collection-local (all below the region window start)
        expect(positions.every((p: number) => p < Ticks.Bars(2))).toBe(true);

        const regionTrack = region.fields.track.value.entityId;
        const regionCollection = region.fields.collection.value.entityId;
        expect(regionTrack).toBe(tracks[0].id);
        expect(regionCollection).toBe(collections[0].id);
    });

    it("two controls → two AutomationTracks with unique orderAmongTracks", async () => {
        const doc = await newDoc();
        const basslineId = await addBassline(doc);
        const bindings = makeBindings([
            { controlId: "gain", entityId: basslineId, fieldPath: "gain", field: basslineField(doc, basslineId, "gain") },
            { controlId: "cutoff", entityId: basslineId, fieldPath: "cutoffFrequencyHz", field: basslineField(doc, basslineId, "cutoffFrequencyHz") },
        ]);

        const result = await writeAutomationRecording(
            rec([
                { controlId: "gain", controlType: "knob", samples: KNOWN_SAMPLES },
                { controlId: "cutoff", controlType: "knob", samples: KNOWN_SAMPLES },
            ]),
            doc,
            bindings
        );

        expect(result.ok).toBe(true);
        expect(result.createdTracks).toBe(2);
        const tracks = doc.queryEntities.ofTypes("automationTrack").get();
        expect(tracks).toHaveLength(2);
        const orders = tracks.map((t: any) => t.fields.orderAmongTracks.value).sort((a: number, b: number) => a - b);
        expect(orders).toEqual([1, 2]);
        // one collection per recorded track (M21.2 §8)
        expect(doc.queryEntities.ofTypes("automationCollection").get()).toHaveLength(2);
        expect(doc.queryEntities.ofTypes("automationRegion").get()).toHaveLength(2);
        expect(doc.queryEntities.ofTypes("automationEvent").get()).toHaveLength(6);
    });

    it("switch controls are stepped (interpolation 1), continuous controls sloped (2)", async () => {
        const doc = await newDoc();
        const basslineId = await addBassline(doc);
        const isActive = basslineField(doc, basslineId, "isActive");
        const gain = basslineField(doc, basslineId, "gain");
        const bindings = makeBindings([
            { controlId: "s1", entityId: basslineId, fieldPath: "isActive", field: isActive },
            { controlId: "k1", entityId: basslineId, fieldPath: "gain", field: gain },
        ]);
        const result = await writeAutomationRecording(
            rec([
                { controlId: "s1", controlType: "switch", samples: [{ timeSeconds: 0, normalizedValue: 0 }, { timeSeconds: 1, normalizedValue: 1 }] },
                { controlId: "k1", controlType: "knob", samples: [{ timeSeconds: 0, normalizedValue: 0 }, { timeSeconds: 1, normalizedValue: 1 }] },
            ]),
            doc,
            bindings
        );
        expect(result.createdTracks).toBe(2);

        const tracks = doc.queryEntities.ofTypes("automationTrack").get() as any[];
        const regions = doc.queryEntities.ofTypes("automationRegion").get() as any[];
        const events = doc.queryEntities.ofTypes("automationEvent").get() as any[];
        const switchTrack = tracks.find((t) => t.fields.automatedParameter.value.equals(isActive.location));
        const switchRegion = regions.find((r) => r.fields.track.value.entityId === switchTrack.id);
        const switchCollection = switchRegion.fields.collection.value.entityId;
        const switchEvents = events.filter((e) => e.fields.collection.value.entityId === switchCollection);
        expect(switchEvents).toHaveLength(2);
        expect(switchEvents.every((e) => e.fields.interpolation.value === 1)).toBe(true);

        const knobTrack = tracks.find((t) => t.fields.automatedParameter.value.equals(gain.location));
        const knobRegion = regions.find((r) => r.fields.track.value.entityId === knobTrack.id);
        const knobEvents = events.filter((e) => e.fields.collection.value.entityId === knobRegion.fields.collection.value.entityId);
        expect(knobEvents.every((e) => e.fields.interpolation.value === 2)).toBe(true);
    });

    it("non-automatable binding → explicit failure, other track still written (partial success)", async () => {
        const doc = await newDoc();
        const basslineId = await addBassline(doc);
        const microTuning = basslineField(doc, basslineId, "microTuning");
        // Prove the fail is real: microTuning is a location reference whose
        // schema targetTypes do not include AutomatableParameter.
        const details: any = getSchemaLocationDetails(microTuning.location);
        const automatableKey = TargetType[TargetType.AutomatableParameter];
        expect((details.targetTypes as string[]).includes(automatableKey)).toBe(false);

        const bindings = makeBindings([
            { controlId: "ok", entityId: basslineId, fieldPath: "gain", field: basslineField(doc, basslineId, "gain") },
            { controlId: "bad", entityId: basslineId, fieldPath: "microTuning", field: microTuning },
        ]);
        const result = await writeAutomationRecording(
            rec([
                { controlId: "ok", controlType: "knob", samples: KNOWN_SAMPLES },
                { controlId: "bad", controlType: "knob", samples: KNOWN_SAMPLES },
            ]),
            doc,
            bindings
        );

        expect(result.ok).toBe(true);
        expect(result.createdTracks).toBe(1);
        expect(result.perTrack.find((r) => r.controlId === "bad")).toMatchObject({ ok: false, reason: "not-automatable" });
        // Nothing was silently created for the failed track — only the good one.
        expect(doc.queryEntities.ofTypes("automationTrack").get()).toHaveLength(1);
        expect(doc.queryEntities.ofTypes("automationCollection").get()).toHaveLength(1);
        expect(doc.queryEntities.ofTypes("automationEvent").get().length).toBe(3);
        expect(doc.queryEntities.ofTypes("automationRegion").get()).toHaveLength(1);
    });

    it("missing binding / entity / field / immutable field → explicit per-track reasons", async () => {
        const doc = await newDoc();
        const basslineId = await addBassline(doc);
        const cutoff = basslineField(doc, basslineId, "cutoffFrequencyHz");

        const noBindingControl = "no-binding";
        const entityMissing = "entity-missing";
        const fieldMissing = "field-missing";
        const fieldImmutable = "field-immutable";

        const bindings = makeBindings([
            // entity does not exist in the document
            { controlId: entityMissing, entityId: "ghost-entity", fieldPath: "gain" },
            // path does not resolve; no stored live field
            { controlId: fieldMissing, entityId: basslineId, fieldPath: "nonexistent.nope" },
            // path does not resolve, but a field object marked immutable falls
            // back in (prototype-inherited value/location, own mutable=false)
            {
                controlId: fieldImmutable,
                entityId: basslineId,
                fieldPath: "nonresolvable.x",
                field: Object.assign(Object.create(cutoff), { mutable: false }),
            },
        ]);

        const result = await writeAutomationRecording(
            rec([
                { controlId: noBindingControl, controlType: "knob", samples: KNOWN_SAMPLES },
                { controlId: entityMissing, controlType: "knob", samples: KNOWN_SAMPLES },
                { controlId: fieldMissing, controlType: "knob", samples: KNOWN_SAMPLES },
                { controlId: fieldImmutable, controlType: "knob", samples: KNOWN_SAMPLES },
            ]),
            doc,
            bindings
        );

        expect(result.ok).toBe(true);
        expect(result.createdTracks).toBe(0);
        const reason = (controlId: string) => result.perTrack.find((r) => r.controlId === controlId);
        expect(reason(noBindingControl)).toMatchObject({ ok: false, reason: "no-binding" });
        expect(reason(entityMissing)).toMatchObject({ ok: false, reason: "entity-not-found" });
        expect(reason(fieldMissing)).toMatchObject({ ok: false, reason: "field-not-found" });
        expect(reason(fieldImmutable)).toMatchObject({ ok: false, reason: "field-immutable" });
        // nothing created at all for fully-failing writes
        expect(doc.queryEntities.ofTypes("automationTrack").get()).toHaveLength(0);
        expect(doc.queryEntities.ofTypes("automationCollection").get()).toHaveLength(0);
        expect(doc.queryEntities.ofTypes("automationEvent").get()).toHaveLength(0);
        expect(doc.queryEntities.ofTypes("automationRegion").get()).toHaveLength(0);
    });

    it("orderAmongTracks continues after existing tracks (max + 1 rule)", async () => {
        const doc = await newDoc();
        const basslineId = await addBassline(doc);
        const cutoff = basslineField(doc, basslineId, "cutoffFrequencyHz");
        // Pre-existing automation tracks with orders 3 and 5 (the writer only
        // ever appends with a unique max+1 value).
        await doc.modify((t: any) => {
            t.create("automationTrack", { automatedParameter: cutoff.location, orderAmongTracks: 3 });
            t.create("automationTrack", { automatedParameter: cutoff.location, orderAmongTracks: 5 });
        });
        const bindings = makeBindings([
            { controlId: "gain", entityId: basslineId, fieldPath: "gain", field: basslineField(doc, basslineId, "gain") },
        ]);
        const result = await writeAutomationRecording(
            rec([{ controlId: "gain", controlType: "knob", samples: KNOWN_SAMPLES }]),
            doc,
            bindings
        );
        expect(result.ok).toBe(true);
        const tracks = doc.queryEntities.ofTypes("automationTrack").get() as any[];
        expect(tracks).toHaveLength(3);
        const orders = tracks.map((t) => t.fields.orderAmongTracks.value).sort((a: number, b: number) => a - b);
        expect(orders).toEqual([3, 5, 6]);
    });

    it("empty recorded track is never written (no-samples)", async () => {
        const doc = await newDoc();
        const basslineId = await addBassline(doc);
        const bindings = makeBindings([
            { controlId: "gain", entityId: basslineId, fieldPath: "gain", field: basslineField(doc, basslineId, "gain") },
        ]);
        const result = await writeAutomationRecording(
            rec([{ controlId: "gain", controlType: "knob", samples: [] }]),
            doc,
            bindings
        );
        expect(result.ok).toBe(true);
        expect(result.createdTracks).toBe(0);
        expect(result.perTrack[0]).toMatchObject({ ok: false, reason: "no-samples" });
        expect(doc.queryEntities.ofTypes("automationTrack").get()).toHaveLength(0);
    });
});

describe("M22.0 — shared take duration for every AutomationRegion", () => {
    const BPM = 120;

    const takeRegionTicks = (durationSeconds: number) =>
        Math.max(1, secondsToTicks(durationSeconds, BPM) + Ticks.Beat);

    const regionDurations = (regions: any[]): number[] =>
        regions.map((r) => r.fields.region.fields.durationTicks.value);

    async function writeWith(
        samplesByControl: { controlId: string; controlType?: string; samples: AutomationSample[] }[],
        overrides: Partial<AutomationRecording> = {}
    ) {
        const doc = await newDoc();
        const basslineId = await addBassline(doc);
        const bindings = makeBindings(
            samplesByControl.map((s) => ({
                controlId: s.controlId,
                entityId: basslineId,
                fieldPath: "gain",
                field: basslineField(doc, basslineId, "gain"),
            }))
        );
        const result = await writeAutomationRecording(
            rec(samplesByControl, { projectBpm: BPM, ...overrides }),
            doc,
            bindings
        );
        const regions = doc.queryEntities.ofTypes("automationRegion").get() as any[];
        const events = doc.queryEntities.ofTypes("automationEvent").get() as any[];
        return { doc, result, regions, events };
    }

    it("1. two tracks with different last events → identical region duration", async () => {
        const { result, regions } = await writeWith(
            [
                {
                    controlId: "long",
                    controlType: "knob",
                    samples: [
                        { timeSeconds: 0, normalizedValue: 0 },
                        { timeSeconds: 2, normalizedValue: 1 },
                    ],
                },
                {
                    controlId: "short",
                    controlType: "knob",
                    samples: [
                        { timeSeconds: 0, normalizedValue: 0 },
                        { timeSeconds: 0.5, normalizedValue: 1 },
                    ],
                },
            ],
            { durationSeconds: 2 }
        );
        expect(result.ok).toBe(true);
        expect(result.createdTracks).toBe(2);
        const d = regionDurations(regions);
        expect(new Set(d).size).toBe(1);
        expect(d[0]).toBe(takeRegionTicks(2));
    });

    it("2. three tracks → all identical region duration", async () => {
        const { regions } = await writeWith(
            [
                {
                    controlId: "a",
                    controlType: "knob",
                    samples: [{ timeSeconds: 0, normalizedValue: 0 }],
                },
                {
                    controlId: "b",
                    controlType: "knob",
                    samples: [
                        { timeSeconds: 0, normalizedValue: 0 },
                        { timeSeconds: 5, normalizedValue: 1 },
                    ],
                },
                {
                    controlId: "c",
                    controlType: "knob",
                    samples: [
                        { timeSeconds: 0, normalizedValue: 0 },
                        { timeSeconds: 3, normalizedValue: 0.5 },
                        { timeSeconds: 7, normalizedValue: 1 },
                    ],
                },
            ],
            { durationSeconds: 10 }
        );
        expect(regions).toHaveLength(3);
        const d = regionDurations(regions);
        expect(new Set(d).size).toBe(1);
        expect(d[0]).toBe(takeRegionTicks(10));
    });

    it("3. a single early event still yields a full-take region", async () => {
        const { regions } = await writeWith(
            [
                {
                    controlId: "once",
                    controlType: "knob",
                    samples: [{ timeSeconds: 0.2, normalizedValue: 0.9 }],
                },
            ],
            { durationSeconds: 10 }
        );
        expect(regions).toHaveLength(1);
        expect(regionDurations(regions)[0]).toBe(takeRegionTicks(10));
    });

    it("4. a control first moved late still yields a full-take region", async () => {
        const { regions, events } = await writeWith(
            [
                {
                    controlId: "late",
                    controlType: "knob",
                    samples: [
                        { timeSeconds: 9, normalizedValue: 0.2 },
                        { timeSeconds: 9.5, normalizedValue: 0.6 },
                        { timeSeconds: 10, normalizedValue: 1 },
                    ],
                },
            ],
            { durationSeconds: 10 }
        );
        expect(regions).toHaveLength(1);
        expect(regionDurations(regions)[0]).toBe(takeRegionTicks(10));
        const positions = events.map((e: any) => e.fields.positionTicks.value);
        expect(positions).toEqual([secondsToTicks(9, BPM), secondsToTicks(9.5, BPM), secondsToTicks(10, BPM)]);
    });

    it("5. an event exactly at the take end stays strictly inside (headroom)", async () => {
        const { regions, events } = await writeWith(
            [
                {
                    controlId: "end",
                    controlType: "knob",
                    samples: [{ timeSeconds: 10, normalizedValue: 1 }],
                },
            ],
            { durationSeconds: 10 }
        );
        const duration = regionDurations(regions)[0];
        expect(duration).toBe(takeRegionTicks(10));
        const lastEventTick = Math.max(...events.map((e: any) => e.fields.positionTicks.value));
        expect(lastEventTick).toBe(secondsToTicks(10, BPM));
        expect(lastEventTick).toBeLessThan(duration);
        // loopDurationTicks stays deliberately coupled to durationTicks
        expect(regions[0].fields.region.fields.loopDurationTicks.value).toBe(duration);
    });

    it("6. durationSeconds = 0 → still a valid positive region (one beat)", async () => {
        const { regions } = await writeWith(
            [
                {
                    controlId: "inst",
                    controlType: "knob",
                    samples: [{ timeSeconds: 0, normalizedValue: 0.5 }],
                },
            ],
            { durationSeconds: 0 }
        );
        expect(regions).toHaveLength(1);
        expect(regionDurations(regions)[0]).toBe(Math.max(1, 0 + Ticks.Beat));
        expect(regionDurations(regions)[0]).toBeGreaterThan(0);
    });

    it("7. an empty track is still skipped (no-samples) and creates no region", async () => {
        const { result, regions, events } = await writeWith(
            [
                {
                    controlId: "real",
                    controlType: "knob",
                    samples: [{ timeSeconds: 0, normalizedValue: 0.5 }],
                },
                { controlId: "empty", controlType: "knob", samples: [] },
            ],
            { durationSeconds: 10 }
        );
        expect(result.createdTracks).toBe(1);
        expect(result.perTrack.find((r) => r.controlId === "empty")).toMatchObject({
            ok: false,
            reason: "no-samples",
        });
        expect(regions).toHaveLength(1);
        expect(events).toHaveLength(1);
    });

    it("8. region positionTicks stays at recording.startTick", async () => {
        const { regions } = await writeWith(
            [
                {
                    controlId: "p",
                    controlType: "knob",
                    samples: [{ timeSeconds: 0, normalizedValue: 0.5 }],
                },
            ],
            { durationSeconds: 10, startTick: Ticks.Bars(2) }
        );
        expect(regions[0].fields.region.fields.positionTicks.value).toBe(Ticks.Bars(2));
    });

    it("9. event positions and values are unchanged (per-control, take-relative)", async () => {
        const { result, events } = await writeWith(
            [
                {
                    controlId: "k",
                    controlType: "knob",
                    samples: [
                        { timeSeconds: 0, normalizedValue: 0.0 },
                        { timeSeconds: 0.5, normalizedValue: 0.5 },
                        { timeSeconds: 2, normalizedValue: 1.0 },
                    ],
                },
            ],
            { durationSeconds: 2 }
        );
        expect(result.createdTracks).toBe(1);
        const sorted = events
            .slice()
            .sort((a: any, b: any) => a.fields.positionTicks.value - b.fields.positionTicks.value);
        expect(sorted.map((e: any) => e.fields.positionTicks.value)).toEqual([0, 3840, 15360]);
        expect(sorted[0].fields.value.value).toBeCloseTo(0.0, 6);
        expect(sorted[1].fields.value.value).toBeCloseTo(0.5, 6);
        expect(sorted[2].fields.value.value).toBeCloseTo(1.0, 6);
    });

    it("10. all non-empty tracks of one recording share the exact same durationTicks (= invariant)", async () => {
        const { regions } = await writeWith(
            [
                {
                    controlId: "a",
                    controlType: "knob",
                    samples: [{ timeSeconds: 6, normalizedValue: 1 }],
                },
                {
                    controlId: "b",
                    controlType: "knob",
                    samples: [{ timeSeconds: 0, normalizedValue: 0 }],
                },
            ],
            { durationSeconds: 6 }
        );
        const durations = regionDurations(regions);
        for (const d of durations) expect(d).toBe(secondsToTicks(6, BPM) + Ticks.Beat);
    });
});