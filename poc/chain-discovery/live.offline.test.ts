import { describe, it, expect, beforeAll } from "vitest";
import { createOfflineDocument } from "@audiotool/nexus/node";
import {
    discoverChainLive,
    listAudioDevicesLive,
    listCablesLive,
    listEntitiesLive,
    listParametersLive,
} from "./live";

/**
 * OFFLINE FIXTURE VALIDATION — the read-only live-layer interfaces executed
 * against the REAL `@audiotool/nexus` (v0.0.17) via an in-memory offline
 * document. This proves field walking, socket pointer resolution, cable
 * reading, schema lookup and traversal against genuine library data.
 *
 * NOTE: the fixture document below is purely offline/in-memory (create =
 * fixture construction). The live path (`live.ts`) itself never writes.
 *
 * Provenance of these results: PROVEN BY OFFLINE TEST.
 */

describe("REAL NEXUS CHAIN DISCOVERY (offline fixture)", () => {
    let doc: any;
    let pulv: any;
    let delay: any;
    let comp: any;

    beforeAll(async () => {
        doc = await createOfflineDocument({ validated: true });
        await doc.modify((t: any) => {
            t.create("pulverisateur", { displayName: "SYNTH" });
            t.create("stompboxDelay", { displayName: "D1" });
            t.create("stompboxCompressor", { displayName: "C1" });
        });
        const byName = (n: string) => doc.queryEntities.get().find((e: any) => e.fields.displayName?.value === n);
        pulv = byName("SYNTH");
        delay = byName("D1");
        comp = byName("C1");
    });

    it("1. lists all entities with id/type/name", () => {
        const entities = listEntitiesLive(doc);
        const names = entities.map((e) => e.displayName).filter(Boolean);
        expect(names).toContain("SYNTH");
        expect(names).toContain("D1");
        expect(names).toContain("C1");
        const pulvEntry = entities.find((e) => e.displayName === "SYNTH");
        expect(pulvEntry?.id).toBe(pulv.id);
        expect(pulvEntry?.entityType).toBe("pulverisateur");
    });

    it("2. lists audio devices via real socket fields", () => {
        const devices = listAudioDevicesLive(doc);
        const ids = devices.map((d) => d.id);
        expect(ids).toContain(pulv.id);
        expect(ids).toContain(delay.id);
        expect(ids).toContain(comp.id);
    });

    it("3. discovers the real chain through DesktopAudioCables", async () => {
        // Fixture construction (offline only): cable SYNTH→D1→C1
        await doc.modify((t: any) => {
            t.create("desktopAudioCable", { fromSocket: pulv.fields.audioOutput.location, toSocket: delay.fields.audioInput.location });
            t.create("desktopAudioCable", { fromSocket: delay.fields.audioOutput.location, toSocket: comp.fields.audioInput.location });
        });

        const cables = listCablesLive(doc);
        expect(cables).toHaveLength(2);
        expect(cables[0].fromEntityId).toBe(pulv.id);
        expect(cables[0].toEntityId).toBe(delay.id);
        expect(cables[1].fromEntityId).toBe(delay.id);
        expect(cables[1].toEntityId).toBe(comp.id);

        const { result } = discoverChainLive(doc, pulv.id, 32);
        expect(result.order).toEqual([pulv.id, delay.id, comp.id]);
        expect(result.chain.map((m) => m.node.displayName)).toEqual(["SYNTH", "D1", "C1"]);
    });

    it("4. reads automatable parameters with a real schema range", () => {
        const params = listParametersLive(doc, pulv.id);
        const cutoff = params.find((p) => p.fieldPath === "filter.cutoffFrequencyHz");
        expect(cutoff).toBeDefined();
        expect(cutoff?.range).toEqual({ min: 18, max: 15500 });
        expect(cutoff?.value).toBe(15500); // schema default
        expect(cutoff?.provenance).toBe("PROVEN BY REAL NEXUS");
    });

    it("5. cycle + duplicate protection on a real loop fixture", async () => {
        await doc.modify((t: any) => {
            t.create("desktopAudioCable", { fromSocket: comp.fields.audioOutput.location, toSocket: pulv.fields.audioInput.location });
        });
        const { result } = discoverChainLive(doc, pulv.id, 32);
        expect(result.order).toEqual([pulv.id, delay.id, comp.id]);
        expect(result.visitedCount).toBe(3);
    });
});