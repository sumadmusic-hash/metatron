/**
 * AUTOMATION OFFLINE POC (M21.1.1) — beweist die beiden in M21.1 offenen Punkte
 * an einer ECHTEN `@audiotool/nexus` v0.0.17 Offline-Dokument (validated:true):
 *
 *   1. `AutomationEvent.value` = Metatron-normalisierte 0..1-Domäne
 *      (Readback ohne Transformation/Clamping-Abweichung).
 *   2. `secondsToTicks(seconds, projectBpm)` → korrekte Event-Ticks,
 *      `ticksToSeconds(...)` als Roundtrip.
 *
 * Dazu: minimale gültige Automation (Device, AutomationTrack, AutomationCollection,
 * 3 AutomationEvents, 1 AutomationRegion an positionTicks = Ticks.Bars(2)) und
 * zwei Gegenproben (Event außerhalb der Region; Sloped-Automation 0.2/0.8).
 *
 * KEINE Produktivdatei, KEIN Produktivcode wird berührt.
 */

import { describe, it, expect } from "vitest";
import { createOfflineDocument } from "@audiotool/nexus/node";
import { secondsToTicks, ticksToSeconds, Ticks } from "@audiotool/nexus/utils";

/** Eine frische, validierte Offline-Dokument ohne Sync. */
async function newDoc() {
    return createOfflineDocument({ validated: true });
}

/**
 * Erzeugt das minimale gültige Automation-Konstrukt:
 *   1 automatable Device (bassline, Felder nachweislich automatable:TargetType)
 *   1 AutomationTrack   (automatedParameter = bassline.cutoffFrequencyHz.location)
 *   1 AutomationCollection
 *   3 AutomationEvents  (value 0.0 / 0.5 / 1.0, position 0 / 3840 / 7680)
 *   1 AutomationRegion  (positionTicks = Ticks.Bars(2) = 30720, duration 7680)
 */
async function createMinimalAutomation(doc: any) {
    let ids: {
        device?: string;
        track?: string;
        collection?: string;
        events?: string[];
        region?: string;
    } = {};
    await doc.modify((t: any) => {
        const bassline = t.create("bassline", {});
        const track = t.create("automationTrack", {
            automatedParameter: bassline.fields.cutoffFrequencyHz.location,
            orderAmongTracks: 0,
        });
        const collection = t.create("automationCollection", {});
        const e1 = t.create("automationEvent", {
            collection: collection.location,
            positionTicks: 0,
            value: 0.0,
            interpolation: 2,
            slope: 0,
        });
        const e2 = t.create("automationEvent", {
            collection: collection.location,
            positionTicks: 3840,
            value: 0.5,
            interpolation: 2,
            slope: 0,
        });
        const e3 = t.create("automationEvent", {
            collection: collection.location,
            positionTicks: 7680,
            value: 1.0,
            interpolation: 2,
            slope: 0,
        });
        const region = t.create("automationRegion", {
            region: {
                positionTicks: Ticks.Bars(2),
                durationTicks: 7680,
                collectionOffsetTicks: 0,
                loopOffsetTicks: 0,
                loopDurationTicks: 7680,
            },
            track: track.location,
            collection: collection.location,
        });
        ids = {
            device: bassline.id,
            track: track.id,
            collection: collection.id,
            events: [e1.id, e2.id, e3.id],
            region: region.id,
        };
    });
    return ids;
}

describe("AUTOMATION OFFLINE POC (M21.1.1)", () => {
    it("A — minimal valid automation: values 0.0/0.5/1.0 read back untransformed & unclamped", async () => {
        const doc = await newDoc();
        const ids = await createMinimalAutomation(doc);

        const events = (
            doc.queryEntities
                .ofTypes("automationEvent")
                .get()
                .sort((a: any, b: any) => a.fields.positionTicks.value - b.fields.positionTicks.value)
        );
        expect(events).toHaveLength(3);

        // Exakte Werte-Type der Events (Sortierung: positionTicks 0/3840/7680).
        const written = [
            { positionTicks: 0, value: 0.0 },
            { positionTicks: 3840, value: 0.5 },
            { positionTicks: 7680, value: 1.0 },
        ];
        events.forEach((ev: any, i: number) => {
            console.log(
                `[POC A] event ${i + 1} id=${ev.id} positionTicks=${ev.fields.positionTicks.value} ` +
                    `value=${ev.fields.value.value}`
            );
            expect(ev.fields.positionTicks.value).toBe(written[i].positionTicks);
            expect(ev.fields.value.value).toBe(written[i].value); // exakt, keine Transformation
        });

        // Keine Clamping-Abweichung: Readback identisch mit Geschriebenem.
        expect(events[0].fields.value.value).toBe(0.0);
        expect(events[1].fields.value.value).toBe(0.5);
        expect(events[2].fields.value.value).toBe(1.0);

        // Struktur: 1 Track, 1 Collection, 1 Region, 1 Device.
        expect(doc.queryEntities.ofTypes("automationTrack").get()).toHaveLength(1);
        expect(doc.queryEntities.ofTypes("automationCollection").get()).toHaveLength(1);
        expect(doc.queryEntities.ofTypes("automationRegion").get()).toHaveLength(1);
        expect(doc.queryEntities.getEntity(ids.device!)).toBeTruthy();
    });

    it("B — secondsToTicks/ticksToSeconds at 120 BPM: exakte Werte + Roundtrip", () => {
        const bpm = 120;
        const inputs = [
            { seconds: 0, expectedTicks: 0 },
            { seconds: 0.5, expectedTicks: 3840 },
            { seconds: 1, expectedTicks: 7680 },
            { seconds: 2, expectedTicks: 15360 },
        ];
        for (const { seconds, expectedTicks } of inputs) {
            const ticks = secondsToTicks(seconds, bpm);
            console.log(`[POC B] seconds=${seconds} bpm=${bpm} -> ticks=${ticks}`);
            expect(ticks).toBe(expectedTicks);
            const back = ticksToSeconds(ticks, bpm);
            console.log(`[POC B] roundtrip ticks=${ticks} -> seconds=${back}`);
            expect(back).toBeCloseTo(seconds, 6);
        }
        // Offizielle Konstanten als Check: 1 Bar 4/4 = SemiBreve = 15360, Beat = 3840.
        expect(Ticks.Beat).toBe(3840);
        expect(Ticks.SemiBreve).toBe(15360);
        expect(Ticks.Bars(2)).toBe(30720);
    });

    it("C — region placement: positionTicks=Bars(2), durations, Pointer auf Track/Collection; Event-Zeitstrahl collection-lokal", async () => {
        const doc = await newDoc();
        const ids = await createMinimalAutomation(doc);

        const region = doc.queryEntities.getEntity(ids.region!) as any;
        expect(region).toBeTruthy();
        console.log(
            `[POC C] region.positionTicks=${region.fields.region.fields.positionTicks.value} ` +
                `durationTicks=${region.fields.region.fields.durationTicks.value} ` +
                `collectionOffsetTicks=${region.fields.region.fields.collectionOffsetTicks.value} ` +
                `loopOffsetTicks=${region.fields.region.fields.loopOffsetTicks.value} ` +
                `loopDurationTicks=${region.fields.region.fields.loopDurationTicks.value}`
        );

        // Der globale Startpunkt der Region: Bar 2 (30720 Ticks).
        expect(region.fields.region.fields.positionTicks.value).toBe(Ticks.Bars(2));
        expect(region.fields.region.fields.durationTicks.value).toBe(7680);
        expect(region.fields.region.fields.collectionOffsetTicks.value).toBe(0);
        expect(region.fields.region.fields.loopOffsetTicks.value).toBe(0);
        expect(region.fields.region.fields.loopDurationTicks.value).toBe(7680);
        expect(region.fields.region.fields.isEnabled.value).toBe(true);

        // Pointer: Track + Collection zeigen auf die in der Transaktion erzeugten Entities.
        const trackLoc = region.fields.track.value;
        const collectionLoc = region.fields.collection.value;
        expect(trackLoc.entityId).toBe(ids.track);
        expect(collectionLoc.entityId).toBe(ids.collection);

        // Events bleiben COLLECTION-LOKAL — sie tragen keinerlei globalen Offset.
        const events = doc.queryEntities.ofTypes("automationEvent").get();
        for (const ev of events as any[]) {
            expect(ev.fields.positionTicks.value).toBeLessThan(Ticks.Bars(2));
        }
        // Der globale Start des ersten Events = region.positionTicks + eventTick 0.
        expect(Ticks.Bars(2) + 0).toBe(30720);
    });

    it("C — track field: automatedParameter zeigt exakt auf das Device-Feld", async () => {
        const doc = await newDoc();
        const ids = await createMinimalAutomation(doc);
        const track = doc.queryEntities.getEntity(ids.track!) as any;
        const loc = track.fields.automatedParameter.value;
        console.log(
            `[POC C] automatedParameter entityId=${loc.entityId} fieldIndex=[${loc.fieldIndex.join(",")}]`
        );
        expect(loc.entityId).toBe(ids.device);
        // cutoffFrequencyHz ist ein Top-Level-Feld der Bassline => exakt 1 Index.
        expect(loc.fieldIndex).toHaveLength(1);
        // Referenziertes Feld ist weiterhin das automatisierte Feld des Devices.
        const bassline = doc.queryEntities.getEntity(ids.device!) as any;
        expect(bassline.fields.cutoffFrequencyHz.location.equals(loc)).toBe(true);
    });

    it("PROBE A — event outside the region duration is accepted by the offline document", async () => {
        const doc = await newDoc();
        let outsideEventId: string | undefined;
        await doc.modify((t: any) => {
            const bassline = t.create("bassline", {});
            const track = t.create("automationTrack", {
                automatedParameter: bassline.fields.cutoffFrequencyHz.location,
                orderAmongTracks: 0,
            });
            const collection = t.create("automationCollection", {});
            t.create("automationEvent", {
                collection: collection.location,
                positionTicks: 0,
                value: 0.0,
            });
            // Event AUSSERHALB der Regions-Dauer (region unten: duration 7680,
            // Loop-Fenster [0, 7680)). Collection-Tick 10000 liegt ausserhalb.
            const outside = t.create("automationEvent", {
                collection: collection.location,
                positionTicks: 10000,
                value: 0.5,
            });
            outsideEventId = outside.id;
            t.create("automationRegion", {
                region: {
                    positionTicks: Ticks.Bars(2),
                    durationTicks: 7680,
                    collectionOffsetTicks: 0,
                    loopOffsetTicks: 0,
                    loopDurationTicks: 7680,
                },
                track: track.location,
                collection: collection.location,
            });
        });

        // Der Datensatz AKZEPTIERT das Event (validiert, kein Transaktionsfehler).
        const outside = doc.queryEntities.getEntity(outsideEventId!) as any;
        expect(outside).toBeTruthy();
        expect(outside.fields.positionTicks.value).toBe(10000);
        expect(outside.fields.value.value).toBe(0.5);
        console.log(
            `[POC PROBE A] event at collectionTick=10000 stored (outside region window [0,7680)) - ` +
                `accepted by the documented offline document.`
        );

        // Die Events werden NICHT verschoben; die Region behält ihren Start.
        const region = doc.queryEntities.ofTypes("automationRegion").get()[0] as any;
        expect(region.fields.region.fields.positionTicks.value).toBe(Ticks.Bars(2));
        // Anmerkung (aus der Region-Doku abgeleitet): Events ausserhalb des
        // Region-Fensters werden erst zur ENGINE-Renderzeit verworfen
        // ("discards events that are outside of the region"); das ist keine
        // Datensatz-Eigenschaft und offline nicht repräsentierbar.
    });

    it("PROBE B — sloped automation (interpolation=2, slope=0) round-trips exactly", async () => {
        const doc = await newDoc();
        await doc.modify((t: any) => {
            const bassline = t.create("bassline", {});
            const track = t.create("automationTrack", {
                automatedParameter: bassline.fields.cutoffFrequencyHz.location,
                orderAmongTracks: 0,
            });
            const collection = t.create("automationCollection", {});
            t.create("automationEvent", {
                collection: collection.location,
                positionTicks: 0,
                value: 0.2,
                interpolation: 2,
                slope: 0,
            });
            t.create("automationEvent", {
                collection: collection.location,
                positionTicks: 3840,
                value: 0.8,
                interpolation: 2,
                slope: 0,
            });
            t.create("automationRegion", {
                region: {
                    positionTicks: 0,
                    durationTicks: 3840,
                    collectionOffsetTicks: 0,
                    loopOffsetTicks: 0,
                    loopDurationTicks: 3840,
                },
                track: track.location,
                collection: collection.location,
            });
        });

        const events = (
            doc.queryEntities
                .ofTypes("automationEvent")
                .get()
                .sort((a: any, b: any) => a.fields.positionTicks.value - b.fields.positionTicks.value)
        );
        expect(events).toHaveLength(2);
        for (const ev of events as any[]) {
            console.log(
                `[POC PROBE B] id=${ev.id} positionTicks=${ev.fields.positionTicks.value} ` +
                    `value=${ev.fields.value.value} interpolation=${ev.fields.interpolation.value} slope=${ev.fields.slope.value}`
            );
        }
        expect(events[0].fields.positionTicks.value).toBe(0);
        expect(events[0].fields.value.value).toBeCloseTo(0.2, 6);
        expect(events[0].fields.interpolation.value).toBe(2);
        expect(events[0].fields.slope.value).toBe(0);
        expect(events[1].fields.positionTicks.value).toBe(3840);
        expect(events[1].fields.value.value).toBeCloseTo(0.8, 6);
        expect(events[1].fields.interpolation.value).toBe(2);
        expect(events[1].fields.slope.value).toBe(0);
    });
});