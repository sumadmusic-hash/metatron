/**
 * PHASE D — LIVE INSTRUMENT IMPORT — pure unit tests for the §20 report + §15
 * verdict rules. These guarantee the report is honest: never PASS without a
 * real executed mutation; BLOCKED on capability/environment/engine refusal.
 * The decisive verdict still requires the real browser/OAuth run (main.ts).
 */

import { describe, it, expect } from "vitest";
import { buildPhaseDReport, buildPhaseDReportText, probeSchedule } from "./report";
import type { PhaseDReportInput, CapabilityReport } from "./report";
import type { NexusValueMapping } from "../../src/nexus/NexusValueMapping";

const capabilityFree = (): CapabilityReport => ({
    rows: [
        { operation: "Entity erzeugen", verdict: "YES", proof: "probe" },
        { operation: "Parameter schreiben", verdict: "YES", proof: "probe" },
        { operation: "Cable erzeugen", verdict: "YES", proof: "probe" },
    ],
});

function baseline(overrides: Partial<PhaseDReportInput> = {}): PhaseDReportInput {
    return {
        environment: {
            oauth: "authenticated as sumad",
            nexusVersion: "0.0.17",
            sourceUrl: "projects/src-1",
            targetUrl: "projects/tgt-1",
        },
        source: { devices: 4, parameters: 93, cables: 3, topology: "pulv → chorus → flanger → mixer" },
        preset: { version: "0.1", controls: 3, bindings: 3, presetValues: 3 },
        capability: capabilityFree(),
        targetBefore: { entities: 5, cables: 0 },
        targetAfter: { entities: 12, cables: 3 },
        importResult: {
            entitiesCreated: 4,
            parameterWrites: 93,
            cablesCreated: 3,
            bindingsOk: 3,
            bindingsTotal: 3,
            presetValuesOk: 3,
            presetValuesTotal: 3,
        },
        idMapping: { sourceIdsReused: false, mappings: [["s1", "t1"], ["s2", "t2"]] },
        verification: {
            chain: "PASS devices 4/4 params 93/93 conns 3/3",
            topology: "PASS — source→target topology identical",
            bindings: "PASS — 3/3 bindings resolve on the target",
            presetValues: "PASS — 3/3 read-back equal",
        },
        checks: { chain: true, topology: true, bindings: true, presetValues: true },
        failures: [],
        probes: [
            { controlId: "c1", kind: "linear", pass: true, detail: "0/0.5/1 EQUAL" },
            { controlId: "c2", kind: "boolean", pass: true, detail: "0/1 EQUAL" },
        ],
        engineFinalVerdict: "CHAIN CLONE: PASS",
        engineOk: true,
        mutationExecuted: true,
        ...overrides,
    };
}

describe("probeSchedule (§9)", () => {
    it("linear float probes 0, 0.5, 1", () => {
        const mapping: NexusValueMapping = { kind: "linear", min: 18, max: 15500, isInteger: false };
        expect(probeSchedule(mapping)).toEqual([0, 0.5, 1]);
    });

    it("linear integer probes only the representable endpoints 0, 1", () => {
        const mapping: NexusValueMapping = { kind: "linear", min: -3, max: 3, isInteger: true };
        expect(probeSchedule(mapping)).toEqual([0, 1]);
    });

    it("boolean probes 0, 1", () => {
        expect(probeSchedule({ kind: "boolean" })).toEqual([0, 1]);
    });

    it("unsupported has nothing to probe", () => {
        expect(probeSchedule({ kind: "unsupported", typeLabel: "schema-unavailable" })).toEqual([]);
    });
});

describe("buildPhaseDReport (§15 verdict)", () => {
    it("reports PASS only for an executed, fully verified mutation with probes OK", () => {
        const report = buildPhaseDReport(baseline());
        expect(report.verdict).toBe("INSTRUMENT IMPORT: PASS");
        expect(report.blockReason).toBeUndefined();
        expect(report.text).toContain("FINAL VERDICT:");
        expect(report.text).toContain("INSTRUMENT IMPORT: PASS");
    });

    it("never reports PASS without an executed mutation (→ PARTIAL)", () => {
        const report = buildPhaseDReport(baseline({ mutationExecuted: false }));
        expect(report.verdict).toBe("INSTRUMENT IMPORT: PARTIAL");
        expect(report.blockDetail).toMatch(/no real mutation/);
    });

    it("maps a NOT-POSSIBLE engine answer to BLOCKED (CAPABILITY)", () => {
        const report = buildPhaseDReport(
            baseline({ engineFinalVerdict: "CHAIN CLONE: NOT POSSIBLE WITH CURRENT NEXUS API" }),
        );
        expect(report.verdict).toBe("INSTRUMENT IMPORT: BLOCKED");
        expect(report.blockReason).toBe("CAPABILITY");
    });

    it("maps an upstream capability block to BLOCKED (CAPABILITY)", () => {
        const report = buildPhaseDReport(
            baseline({ capabilityBlock: "entity creation not proven creatable for: gravitator" }),
        );
        expect(report.verdict).toBe("INSTRUMENT IMPORT: BLOCKED");
        expect(report.blockReason).toBe("CAPABILITY");
    });

    it("maps an environment block to BLOCKED (ENVIRONMENT)", () => {
        const report = buildPhaseDReport(baseline({ environmentBlock: "OAuth popup was blocked" }));
        expect(report.verdict).toBe("INSTRUMENT IMPORT: BLOCKED");
        expect(report.blockReason).toBe("ENVIRONMENT");
    });

    it("maps an executed import with a failing check to PARTIAL", () => {
        const report = buildPhaseDReport(
            baseline({ checks: { chain: true, topology: true, bindings: false, presetValues: true } }),
        );
        expect(report.verdict).toBe("INSTRUMENT IMPORT: PARTIAL");
        expect(report.blockDetail).toMatch(/verification block/);
    });

    it("maps a failed mapping probe to PARTIAL even when everything else passed", () => {
        const report = buildPhaseDReport(
            baseline({
                probes: [
                    { controlId: "c1", kind: "linear", pass: false, detail: "n=0.5 DIFF" },
                ],
            }),
        );
        expect(report.verdict).toBe("INSTRUMENT IMPORT: PARTIAL");
        expect(report.blockDetail).toMatch(/mapping probe failed/);
    });

    it("engine ~ok after a mutation → PARTIAL, not PASS", () => {
        const report = buildPhaseDReport(baseline({ engineOk: false }));
        expect(report.verdict).toBe("INSTRUMENT IMPORT: PARTIAL");
    });
});

describe("buildPhaseDReportText (§20 layout)", () => {
    it("renders every required section label", () => {
        const input = baseline();
        const text = buildPhaseDReportText(input, "INSTRUMENT IMPORT: PASS");
        for (const expected of [
            "# PHASE D — LIVE INSTRUMENT IMPORT",
            "ENVIRONMENT:",
            "SOURCE:",
            "INSTRUMENT PRESET:",
            "CAPABILITY GATE:",
            "TARGET BEFORE:",
            "IMPORT:",
            "ID MAPPING:",
            "VERIFICATION:",
            "FAILURES:",
            "FINAL VERDICT:",
            "INSTRUMENT IMPORT: PASS",
            "source IDs reused: NO",
        ]) {
            expect(text).toContain(expected);
        }
        expect(text).not.toContain("Reason (");
    });

    it("renders failures as a list and [] when empty", () => {
        const failed = buildPhaseDReportText(baseline(), "INSTRUMENT IMPORT: PASS");
        expect(failed).toContain("  []");

        const withFailures = buildPhaseDReportText(
            baseline({
                failures: [
                    "preset c1: tryUpdate: out of range",
                    "binding c2: source entity not in idMap",
                ],
            }),
            "INSTRUMENT IMPORT: PARTIAL",
        );
        expect(withFailures).toContain("  - preset c1: tryUpdate: out of range");
        expect(withFailures).toContain("  - binding c2: source entity not in idMap");
    });
});