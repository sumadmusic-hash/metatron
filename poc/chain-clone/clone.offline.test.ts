/**
 * CHAIN CLONE POC — REAL NEXUS v0.0.17 OFFLINE CLONE SUITE.
 *
 * Uses the REAL `@audiotool/nexus` package with in-memory offline documents
 * (createOfflineDocument from @audiotool/nexus/node). The SOURCE document is
 * only ever read; the TARGET document is the payload of the clone.
 *
 * Provenance of every result here: PROVEN BY OFFLINE TEST.
 * A real live clone (OAuth + real projects) is still required by §12.
 * NOTE: the offline fixture "creation" below is fixture construction, not a
 * capability claim for live projects.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { createOfflineDocument } from "@audiotool/nexus/node";
import type { OfflineDocument } from "@audiotool/nexus/node";
import { getSchemaLocationDetails } from "@audiotool/nexus/document";
import { createSnapshot, serializeSnapshot } from "./snapshot";
import { cloneChainToDoc, restoreParametersInDoc, KNOWN_CREATABLE_TYPES, resolveFieldByPath, buildTargetResolvers } from "./clone";
import { idMapUsesNoSourceIds, planDevices, planParameterField, socketSegmentsFromPath } from "./planning";
import { listCablesLive, listParametersLive } from "../chain-discovery/live";
import { valuesEqualFloat32 } from "./verify";
import { CAPABILITY_TABLE } from "./api-capabilities";
import type { ParameterPlan, ChainSnapshot } from "./types";

describe("REAL NEXUS CHAIN CLONE (offline fixture)", () => {
    let source: OfflineDocument;
    let target: OfflineDocument;
    let sourceRoot: string;
    let snapshot: ChainSnapshot;
    let result: Awaited<ReturnType<typeof cloneChainToDoc>>;
    let sourceParamCount: number;

    beforeAll(async () => {
        source = await createOfflineDocument({ validated: true });
        target = await createOfflineDocument({ validated: true });

        // — source fixture: SYNTH(pulv, cutoff=7421) → D1(delay, mix=0.31) → C1(compressor) —
        let pulv: any;
        await source.modify((t: any) => {
            pulv = t.create("pulverisateur", { displayName: "SYNTH" });
            t.create("stompboxDelay", { displayName: "D1" });
            t.create("stompboxCompressor", { displayName: "C1" });
        });
        const byName = (n: string) => source.queryEntities.get().find((e: any) => e.fields.displayName?.value === n) as any;
        pulv = byName("SYNTH");
        const delay = byName("D1");
        const comp = byName("C1");
        sourceRoot = pulv.id;

        await source.modify((t: any) => {
            t.update(pulv.fields.filter.fields.cutoffFrequencyHz, 7421);
            t.update(delay.fields.mix, 0.31);
            t.update(comp.fields.isActive, false);
        });
        await source.modify((t: any) => {
            t.create("desktopAudioCable", { fromSocket: pulv.fields.audioOutput.location, toSocket: delay.fields.audioInput.location });
            t.create("desktopAudioCable", { fromSocket: delay.fields.audioOutput.location, toSocket: comp.fields.audioInput.location });
        });

        // — clone —
        snapshot = createSnapshot(source as any, sourceRoot);
        sourceParamCount = snapshot.devices.reduce((n, d) => n + d.fields.length, 0);
        result = await cloneChainToDoc(source as any, target as any, sourceRoot);
    });

    it("1. snapshots the source chain and keeps raw current values", () => {
        expect(snapshot.devices.map((d) => d.entityType)).toEqual(["pulverisateur", "stompboxDelay", "stompboxCompressor"]);
        expect(snapshot.connections).toHaveLength(2);
        const cutoff = snapshot.devices[0].fields.find((f) => f.path === "filter.cutoffFrequencyHz");
        expect(cutoff).toBeDefined();
        expect(valuesEqualFloat32(cutoff!.value, 7421)).toBe(true);
        // §7: schema default vs source current value
        expect(cutoff!.defaultValue).toBe(15500);
        expect(cutoff!.range).toEqual({ min: 18, max: 15500 });
    });

    it("2. serialized snapshot round-trips losslessly", () => {
        const roundTrip = JSON.parse(serializeSnapshot(snapshot)) as ChainSnapshot;
        expect(roundTrip).toEqual(snapshot);
    });

    it("3. creates the devices on the target with a clean source→target id map", () => {
        expect(result.idMap.size).toBe(3);
        expect(idMapUsesNoSourceIds(result.idMap, snapshot.devices.map((d) => d.sourceEntityId))).toBe(true);
        for (const plan of planDevices(snapshot, KNOWN_CREATABLE_TYPES)) {
            expect(plan.action).toBe("create");
        }
    });

    it("4. restores §7 current values, not schema defaults", async () => {
        const targetByName = (n: string) => target.queryEntities.get().find((e: any) => e.fields.displayName?.value === n) as any;
        const pulvT = targetByName("SYNTH");
        const delayT = targetByName("D1");
        const compT = targetByName("C1");
        expect(pulvT).toBeDefined();
        expect(valuesEqualFloat32(pulvT.fields.filter.fields.cutoffFrequencyHz.value, 7421)).toBe(true);
        expect(valuesEqualFloat32(delayT.fields.mix.value, 0.31)).toBe(true);
        expect(compT.fields.isActive.value).toBe(false);
    });

    it("5. recreates A→B→C cables and the topology matches", () => {
        const cables = listCablesLive(target as any);
        expect(cables).toHaveLength(2);
        const { verification } = result;
        expect(verification!.connections.equal).toBe(true);
        expect(verification!.topology.equal).toBe(true);
        expect(verification!.ok).toBe(true);
    });

    it("6. verification reports PASS with float32-tolerant values and valid ranges", () => {
        expect(result.report.finalVerdict).toBe("CHAIN CLONE: PASS");
        expect(result.report.sections.entityCreation.verdict).toBe("PASS");
        expect(result.report.sections.parameterRestore.verdict).toBe("PASS");
        expect(result.report.sections.currentValues.verdict).toBe("PASS");
        expect(result.report.sections.connectionCreation.verdict).toBe("PASS");
        expect(result.report.sections.topologyRestore.verdict).toBe("PASS");
        expect(result.verification!.parameters.equal).toBe(true);
        expect(result.verification!.diffs.length).toBeLessThanOrEqual(sourceParamCount + 1);
    });

    it("7. never touches the SOURCE document", async () => {
        const pulv = source.queryEntities.get().find((e: any) => e.fields.displayName?.value === "SYNTH") as any;
        expect(valuesEqualFloat32(pulv.fields.filter.fields.cutoffFrequencyHz.value, 7421)).toBe(true);
        expect(listCablesLive(source as any)).toHaveLength(2);
        expect(source.queryEntities.get().filter((e: any) => e.entityType === "desktopAudioCable")).toHaveLength(2);
        expect(source.queryEntities.get().map((e: any) => e.id)).not.toContain(result.idMap.get(sourceRoot));
    });

    it("8. re-reading parameters after clone yields equal values within float32 tolerance", () => {
        for (const device of snapshot.devices) {
            const targetId = result.idMap.get(device.sourceEntityId)!;
            const targetParams = listParametersLive(target as any, targetId);
            for (const field of device.fields) {
                const tp = targetParams.find((p: any) => p.fieldPath === field.path);
                expect(tp, `target param ${device.entityType}.${field.path}`).toBeDefined();
                expect(valuesEqualFloat32(field.value, tp!.value)).toBe(true);
            }
        }
    });

    it("9. no immutable automatable parameters exist on real audio devices (read-only skip is schema-driven)", () => {
        for (const entity of source.queryEntities.get()) {
            if (!["pulverisateur", "stompboxDelay", "stompboxCompressor"].includes(entity.entityType)) continue;
            for (const [name, fieldRaw] of Object.entries(entity.fields) as any) {
                if (!fieldRaw || typeof fieldRaw !== "object" || !fieldRaw.location || "value" in fieldRaw === false) continue;
                if (name === "id") continue;
                const d = getSchemaLocationDetails(fieldRaw.location);
                if (d.type === "primitive" && (d.targetTypes ?? []).includes("AutomatableParameter")) {
                    expect(d.immutable, `immutable automatable param ${entity.entityType}.${name}`).toBe(false);
                }
            }
        }
        // and the planner still paths immutable fields into a SKIP
        const skip = planParameterField(
            { path: "x", value: 1, primitiveType: "number", scalarType: 2, mutable: true },
            { primitiveType: "number", scalarType: 2, immutable: true },
        );
        expect(skip.action).toBe("skipImmutable");
    });

    it("10. failed mutation returns an error string and is recorded, without changing the value", async () => {
        const fresh = await createOfflineDocument({ validated: true });
        let delay: any;
        await fresh.modify((t: any) => {
            t.create("stompboxDelay", { displayName: "D" });
        });
        delay = fresh.queryEntities.get().find((e: any) => e.fields.displayName?.value === "D");
        const idMap = new Map([["src", delay.id]]);
        const before = delay.fields.mix.value;
        const badPlan: ParameterPlan = {
            sourceDeviceId: "src",
            path: "mix",
            sourceValue: 0.5,
            action: "update",
            proposedValue: 2.5, // outside real range [0, 1]
        };
        const failures = await restoreParametersInDoc(fresh as any, idMap, [badPlan]);
        expect(failures.length).toBeGreaterThan(0);
        expect(failures[0].message).toContain("tryUpdate");
        expect(valuesEqualFloat32(delay.fields.mix.value, before)).toBe(true);
    });

    it("11. capability table rows carry SDK evidence (offline provable rows)", () => {
        const table = CAPABILITY_TABLE;
        const createRow = table.find((r) => r.capability === "Entity erzeugen")!;
        expect(createRow.verdict).toBe("YES");
        const cableRow = table.find((r) => r.capability === "Cable erzeugen")!;
        expect(cableRow.verdict).toBe("YES");
        const directRow = table.find((r) => r.capability === "Chain direkt klonen")!;
        expect(directRow.verdict).toBe("REQUIRES CLIENTSIDE RECONSTRUCTION");
    });
});

// ———————————————————————————————————————————————————————————————————————
// Fan-out A→B, A→C (§8 optional)
// ———————————————————————————————————————————————————————————————————————

describe("REAL NEXUS CHAIN CLONE — fan-out (offline)", () => {
    it("clones a fan-out topology A→B + A→C with matching topology", async () => {
        const source = await createOfflineDocument({ validated: true });
        const target = await createOfflineDocument({ validated: true });
        let od: any;
        await source.modify((t: any) => {
            t.create("pulverisateur", { displayName: "SYNTH" });
            t.create("stompboxDelay", { displayName: "B1" });
            t.create("stompboxCompressor", { displayName: "C1" });
        });
        const byName = (n: string) => source.queryEntities.get().find((e: any) => e.fields.displayName?.value === n) as any;
        od = byName("SYNTH");
        const d1 = byName("B1");
        const c1 = byName("C1");
        await source.modify((t: any) => {
            t.create("desktopAudioCable", { fromSocket: od.fields.audioOutput.location, toSocket: d1.fields.audioInput.location });
            t.create("desktopAudioCable", { fromSocket: od.fields.audioOutput.location, toSocket: c1.fields.audioInput.location });
        });

        const snapshot = createSnapshot(source as any, od.id);
        expect(snapshot.connections).toHaveLength(2);

        const result = await cloneChainToDoc(source as any, target as any, od.id);
        expect(result.report.finalVerdict).toBe("CHAIN CLONE: PASS");
        expect(result.verification!.connections.equal).toBe(true);
        expect(result.verification!.topology.equal).toBe(true);
        // both target cables originate at the same mapped source device
        const cables = listCablesLive(target as any);
        const froms = cables.map((c) => c.fromEntityId);
        expect(new Set(froms).size).toBe(1);
        expect(froms[0]).toBe(result.idMap.get(od.id));
    });
});

// ———————————————————————————————————————————————————————————————————————
// CAPACITY PROBES — self-cleaning create+remove / clone proof (§16 evidence)
// ———————————————————————————————————————————————————————————————————————

describe("REAL NEXUS CAPACITY PROBES (offline, self-cleaning)", () => {
    it("probing create+remove leaves the document untouched", async () => {
        const doc = await createOfflineDocument({ validated: true });
        const before = doc.queryEntities.get().filter((e: any) => e.entityType === "pulverisateur").length;
        await doc.modify((t: any) => {
            const e = t.create("pulverisateur", { displayName: "probe" });
            t.remove(e.id);
        });
        const after = doc.queryEntities.get().filter((e: any) => e.entityType === "pulverisateur").length;
        expect(after).toBe(before);
    });

    it("t.clone duplicates an entity (Device duplizieren capability)", async () => {
        const doc = await createOfflineDocument({ validated: true });
        let ids: string[] = [];
        await doc.modify((t: any) => {
            const e = t.create("pulverisateur", { displayName: "A" });
            const duplicate = t.clone(e);
            ids = [e.id, duplicate.id];
        });
        const pulvs = doc.queryEntities.get().filter((e: any) => e.entityType === "pulverisateur");
        expect(pulvs).toHaveLength(2);
        expect(new Set(pulvs.map((e: any) => e.id)).size).toBe(2);
        void ids;
    });

    it("KNOWN_CREATABLE_TYPES used by the fixtures are actually creatable at runtime", async () => {
        const doc = await createOfflineDocument({ validated: true });
        const types = ["pulverisateur", "stompboxDelay", "stompboxCompressor"];
        for (const type of types) {
            await doc.modify((t: any) => {
                t.create(type as any, { displayName: `cap-${type}` });
            });
        }
        const created = doc.queryEntities.get().map((e: any) => e.entityType);
        for (const type of types) expect(created).toContain(type);
    });

    it("socket path parsing matches the real schema-derived paths", () => {
        expect(socketSegmentsFromPath("pulverisateur.audioOutput", "pulverisateur")).toEqual(["audioOutput"]);
        expect(socketSegmentsFromPath("stompboxCompressor.audioInput", "stompboxCompressor")).toEqual(["audioInput"]);
    });
});

// ———————————————————————————————————————————————————————————————————————
// QUANTUM object-array (bands) — resolver regression → write → read-back
// See: live Phase-D import failed with `target field not found in schema`
// for `bands.[i].field`; the fresh TARGET quantum does contain these fields
// at `bands.array[i].fields.field`, so the resolver must descend into them.
// ———————————————————————————————————————————————————————————————————————

const QUANTUM_BAND_FIELDS = [
    "thresholdDb",
    "ratio",
    "kneeDb",
    "attackMs",
    "releaseMs",
    "makeupGainDb",
    "isCompressorActive",
    "isMuted",
    "isSoloed",
] as const;

const QUANTUM_BAND_PATHS = QUANTUM_BAND_FIELDS.flatMap((field) =>
    Array.from({ length: 4 }, (_, i) => `bands.[${i}].${field}`),
);

describe("REAL NEXUS QUANTUM object-array (bands) resolution + write/read-back", () => {
    it("D: fresh quantum exposes 4 bands and the real resolver finds all 36 band fields", async () => {
        const doc = await createOfflineDocument({ validated: true });
        let id: string;
        await doc.modify((t: any) => {
            id = t.create("quantum", {}).id;
        });
        const quantum: any = doc.queryEntities.getEntity(id!);
        expect(quantum.entityType).toBe("quantum");
        expect(quantum.fields.bands.array).toHaveLength(4);
        const missing: string[] = [];
        for (const p of QUANTUM_BAND_PATHS) {
            const field = resolveFieldByPath(quantum.fields, p);
            if (!field?.location) {
                missing.push(p);
                continue;
            }
            expect(getSchemaLocationDetails(field.location).type, p).toBe("primitive");
        }
        expect(missing).toEqual([]);
    });

    it("D-plan: mapping band params against the fresh target no longer plans missingField", async () => {
        const doc = await createOfflineDocument({ validated: true });
        let id: string;
        await doc.modify((t: any) => {
            id = t.create("quantum", {}).id;
        });
        const idMap = new Map([["quantum-src", id!]]);
        const { resolveTargetMeta } = buildTargetResolvers(doc as any, idMap);
        for (const p of QUANTUM_BAND_PATHS) {
            const meta = resolveTargetMeta("quantum-src", p);
            expect(meta?.primitiveType, p).toBeDefined();
            const plan = planParameterField({ path: p, value: 0, primitiveType: "number", scalarType: 2, mutable: true }, meta);
            expect(plan.action, p).not.toBe("missingField");
        }
    });

    it("E/F: writes representative band fields with valid values and independently re-reads them", async () => {
        const doc = await createOfflineDocument({ validated: true });
        let id: string;
        await doc.modify((t: any) => {
            id = t.create("quantum", {}).id;
        });
        const quantum: any = doc.queryEntities.getEntity(id!);

        const writes: { path: string; index: number; leaf: string; value: number | boolean }[] = [
            { path: "bands.[0].thresholdDb", index: 0, leaf: "thresholdDb", value: -12 },
            { path: "bands.[0].ratio", index: 0, leaf: "ratio", value: 5.5 },
            { path: "bands.[1].attackMs", index: 1, leaf: "attackMs", value: 125 },
            { path: "bands.[2].isMuted", index: 2, leaf: "isMuted", value: true },
            { path: "bands.[3].releaseMs", index: 3, leaf: "releaseMs", value: 375 },
        ];

        await doc.modify((t: any) => {
            for (const w of writes) {
                const field = resolveFieldByPath(quantum.fields, w.path)!;
                expect(field.location, w.path).toBeDefined();
                const error = t.tryUpdate(field, w.value);
                expect(typeof error, w.path).not.toBe("string");
            }
        });

        // independent fresh read: re-fetch the entity and navigate structurally
        const fresh: any = doc.queryEntities.getEntity(id!);
        for (const w of writes) {
            const read = fresh.fields.bands.array[w.index].fields[w.leaf].value;
            expect(read, w.path).toBeDefined();
            expect(valuesEqualFloat32(read, w.value), w.path).toBe(true);
        }
    });
});