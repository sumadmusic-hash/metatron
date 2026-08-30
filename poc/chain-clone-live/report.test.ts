/**
 * LIVE CHAIN CLONE TEST — pure unit tests for the §9 report + §3 gate.
 *
 * Note: these are supporting tests. The DECISIVE verdict requires the real
 * browser/OAuth/project run (main.ts); the rules tested here guarantee the
 * report is honest (never PASS without a real executed mutation).
 */

import { describe, it, expect } from "vitest";
import { buildLiveReport, assessRequiredCapabilities, buildReportText } from "./report";
import { KNOWN_CREATABLE_TYPES } from "../chain-clone/clone";
import { CAPABILITY_TABLE } from "../chain-clone/api-capabilities";
import type { ChainSnapshot } from "../chain-clone/types";

const snapshot = (types: string[]): ChainSnapshot => ({
    version: 1,
    devices: types.map((entityType, i) => ({
        sourceEntityId: `src-${i}`,
        entityType,
        fields: [],
    })),
    connections: [],
    rootCandidates: [],
});

const passSections = () => [
    { label: "Entity creation", verdict: "PASS" },
    { label: "Parameter writes", verdict: "PASS" },
    { label: "Cable creation", verdict: "PASS" },
    { label: "Topology", verdict: "PASS" },
];

describe("assessRequiredCapabilities (§3 gate)", () => {
    it("passes when every snapshot device type is proven creatable", () => {
        const report = assessRequiredCapabilities(snapshot(["pulverisateur", "stompboxDelay"]), KNOWN_CREATABLE_TYPES);
        expect(report.blockedReason).toBeUndefined();
        expect(report.rows.map((r) => r.operation)).toEqual(["Entity erzeugen", "Parameter schreiben", "Cable erzeugen"]);
    });

    it("blocks a chain with a not-proven-creatable device type (no workaround)", () => {
        const report = assessRequiredCapabilities(snapshot(["gravitator"]), KNOWN_CREATABLE_TYPES);
        expect(report.blockedReason).toMatch(/gravitator/);
    });

    it("blocks when the capability table lacks a required operation", () => {
        const trimmed = CAPABILITY_TABLE.filter((r) => r.capability !== "Cable erzeugen");
        const report = assessRequiredCapabilities(snapshot(["pulverisateur"]), KNOWN_CREATABLE_TYPES, trimmed);
        expect(report.blockedReason).toMatch(/Cable erzeugen/);
    });
});

describe("buildLiveReport (§9 verdict)", () => {
    it("reports PASS only for an executed, fully verified mutation", () => {
        const report = buildLiveReport({
            source: { entities: 3, parameters: 12, cables: 2 },
            targetBefore: { entities: 1, cables: 0 },
            targetAfter: { entities: 4, parameters: 12, cables: 2 },
            cloneSections: passSections(),
            finalVerdict: "CHAIN CLONE: PASS",
            mutationExecuted: true,
        });
        expect(report.verdict).toBe("CHAIN CLONE: PASS");
        expect(report.text).toContain("CHAIN CLONE LIVE TEST");
        expect(report.text).toContain("FINAL RESULT:");
    });

    it("never reports PASS without an executed mutation", () => {
        const report = buildLiveReport({
            source: { entities: 3, parameters: 12, cables: 2 },
            targetBefore: { entities: 1, cables: 0 },
            targetAfter: { entities: 4, parameters: 12, cables: 2 },
            cloneSections: passSections(),
            finalVerdict: "CHAIN CLONE: PASS",
            mutationExecuted: false,
        });
        expect(report.verdict).not.toBe("CHAIN CLONE: PASS");
        expect(report.verdict).toBe("CHAIN CLONE: PARTIAL");
        expect(report.blockDetail).toMatch(/no real mutation/);
    });

    it("maps NOT POSSIBLE from the engine to BLOCKED (CAPABILITY)", () => {
        const report = buildLiveReport({
            source: { entities: 1, parameters: 0, cables: 0 },
            targetBefore: { entities: 1, cables: 0 },
            targetAfter: { entities: 1, parameters: 0, cables: 0 },
            cloneSections: [{ label: "Entity creation", verdict: "FAIL" }],
            finalVerdict: "CHAIN CLONE: NOT POSSIBLE WITH CURRENT NEXUS API",
            mutationExecuted: true,
        });
        expect(report.verdict).toBe("CHAIN CLONE: BLOCKED");
        expect(report.blockReason).toBe("CAPABILITY");
    });

    it("maps a partial clone to PARTIAL", () => {
        const report = buildLiveReport({
            source: { entities: 2, parameters: 5, cables: 1 },
            targetBefore: { entities: 1, cables: 0 },
            targetAfter: { entities: 3, parameters: 5, cables: 0 },
            cloneSections: [
                { label: "Entity creation", verdict: "PASS" },
                { label: "Parameter writes", verdict: "PASS" },
                { label: "Cable creation", verdict: "FAIL" },
                { label: "Topology", verdict: "FAIL" },
            ],
            finalVerdict: "CHAIN CLONE: PARTIAL",
            mutationExecuted: true,
        });
        expect(report.verdict).toBe("CHAIN CLONE: PARTIAL");
    });

    it("treats an upstream capability block as BLOCKED before any mutation", () => {
        const report = buildLiveReport({
            source: { entities: 1, parameters: 0, cables: 0 },
            targetBefore: { entities: 1, cables: 0 },
            targetAfter: { entities: 1, parameters: 0, cables: 0 },
            cloneSections: [],
            finalVerdict: "CHAIN CLONE: PARTIAL",
            mutationExecuted: false,
            capabilityBlock: "Nexus v0.0.17 does not provide: Cable erzeugen",
        });
        expect(report.verdict).toBe("CHAIN CLONE: BLOCKED");
        expect(report.blockReason).toBe("CAPABILITY");
    });

    it("treats OAuth/project failure as BLOCKED (ENVIRONMENT)", () => {
        const report = buildLiveReport({
            source: { entities: 0, parameters: 0, cables: 0 },
            targetBefore: { entities: 0, cables: 0 },
            targetAfter: { entities: 0, parameters: 0, cables: 0 },
            cloneSections: [],
            finalVerdict: "CHAIN CLONE: PARTIAL",
            mutationExecuted: false,
            environmentBlock: "OAuth popup was blocked by the browser",
        });
        expect(report.verdict).toBe("CHAIN CLONE: BLOCKED");
        expect(report.blockReason).toBe("ENVIRONMENT");
    });
});

describe("buildReportText (§9 layout)", () => {
    it("renders the full report block with the exact section labels", () => {
        const text = buildReportText(
            { entities: 3, parameters: 11, cables: 2 },
            { entities: 1, cables: 0 },
            { entities: 4, parameters: 11, cables: 2 },
            passSections(),
            "CHAIN CLONE: PASS",
        );
        for (const expected of [
            "SOURCE:",
            "Entities:",
            "TARGET BEFORE:",
            "CLONE:",
            "Entity creation: PASS",
            "TARGET AFTER:",
            "FINAL RESULT:",
            "CHAIN CLONE: PASS",
        ]) {
            expect(text).toContain(expected);
        }
        expect(text).not.toContain("Reason (");
    });
});