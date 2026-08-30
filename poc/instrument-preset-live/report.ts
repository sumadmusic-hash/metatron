/**
 * PHASE D — LIVE INSTRUMENT IMPORT — pure report & verdict layer (§20 / §15).
 *
 * Pure and Nexus-free (like `../chain-clone-live/report.ts`) so the final
 * verdict rules are deterministic offline (`report.test.ts`). The browser UI
 * (`main.ts`) feeds REAL live data into this builder.
 *
 * Verdict rules (honest reporting — never claim PASS without a real mutation):
 *   - environment failure (OAuth / project / network / threw before result) → BLOCKED (ENVIRONMENT)
 *   - missing required capability (gate) or Phase-B export refusal on real
 *     SOURCE data                                            → BLOCKED (CAPABILITY)
 *   - the import engine answered NOT POSSIBLE                 → BLOCKED (CAPABILITY)
 *   - mutation ran + engine OK + chain/topology/bindings/preset verified
 *     + mapping probes OK                                     → PASS
 *   - mutation ran, but at least one required check is off    → PARTIAL
 *   - no real mutation executed                               → PARTIAL ("never PASS")
 */

import { assessRequiredCapabilities } from "../chain-clone-live/report";
import type { CapabilityReport } from "../chain-clone-live/report";
import type { NexusValueMapping } from "../../src/nexus/NexusValueMapping";

export type PhaseDVerdict =
    | "INSTRUMENT IMPORT: PASS"
    | "INSTRUMENT IMPORT: PARTIAL"
    | "INSTRUMENT IMPORT: BLOCKED";

export type PhaseDBlockReason = "ENVIRONMENT" | "CAPABILITY";

export interface PhaseDEnvironment {
    oauth: string;
    nexusVersion: string;
    sourceUrl: string;
    targetUrl: string;
}

export interface PhaseDSource {
    devices: number;
    parameters: number;
    cables: number;
    topology: string;
}

export interface PhaseDPreset {
    version: string;
    controls: number;
    bindings: number;
    presetValues: number;
}

export interface PhaseDImport {
    entitiesCreated: number;
    parameterWrites: number;
    cablesCreated: number;
    bindingsOk: number;
    bindingsTotal: number;
    presetValuesOk: number;
    presetValuesTotal: number;
}

export interface PhaseDIdMapping {
    /** True when a SOURCE id is (re)used as a TARGET id — always NO for a correct clone. */
    sourceIdsReused: boolean;
    /** [sourceEntityId, targetEntityId][] — logical identity only. */
    mappings: Array<[string, string]>;
}

export interface PhaseDVerificationText {
    chain: string;
    topology: string;
    bindings: string;
    presetValues: string;
}

/** One mapping endpoint probe on the real TARGET (§9 — linear 0/0.5/1, boolean 0/1, integer 0/1). */
export interface PhaseDProbe {
    controlId: string;
    kind: string;
    pass: boolean;
    detail: string;
}

export interface PhaseDReportInput {
    environment: PhaseDEnvironment;
    source: PhaseDSource;
    preset: PhaseDPreset;
    capability: CapabilityReport;
    targetBefore: { entities: number; cables: number };
    targetAfter: { entities: number; cables: number };
    importResult: PhaseDImport;
    idMapping: PhaseDIdMapping;
    verification: PhaseDVerificationText;
    /** Independent booleans the PASS verdict must satisfy. */
    checks: { chain: boolean; topology: boolean; bindings: boolean; presetValues: boolean };
    failures: string[];
    probes: PhaseDProbe[];
    engineFinalVerdict: string;
    engineOk: boolean;
    mutationExecuted: boolean;
    environmentBlock?: string;
    capabilityBlock?: string;
}

export interface PhaseDReport {
    text: string;
    verdict: PhaseDVerdict;
    blockReason?: PhaseDBlockReason;
    blockDetail?: string;
}

/** §9 mapping probes per kind: linear float 0/0.5/1, linear integer + boolean 0/1.
 *  0.5 is NOT probeable on an integral scalar field (rounding makes it lossy);
 *  unsupported mappings have nothing to probe. */
export function probeSchedule(mapping: NexusValueMapping): number[] {
    switch (mapping.kind) {
        case "boolean":
            return [0, 1];
        case "linear":
            return mapping.isInteger ? [0, 1] : [0, 0.5, 1];
        default:
            return [];
    }
}

export function buildPhaseDReport(input: PhaseDReportInput): PhaseDReport {
    let verdict: PhaseDVerdict;
    let blockReason: PhaseDBlockReason | undefined;
    let blockDetail: string | undefined;

    if (input.environmentBlock) {
        verdict = "INSTRUMENT IMPORT: BLOCKED";
        blockReason = "ENVIRONMENT";
        blockDetail = input.environmentBlock;
    } else if (input.capabilityBlock) {
        verdict = "INSTRUMENT IMPORT: BLOCKED";
        blockReason = "CAPABILITY";
        blockDetail = input.capabilityBlock;
    } else if (input.engineFinalVerdict === "CHAIN CLONE: NOT POSSIBLE WITH CURRENT NEXUS API") {
        verdict = "INSTRUMENT IMPORT: BLOCKED";
        blockReason = "CAPABILITY";
        blockDetail = "the import engine answered CHAIN CLONE: NOT POSSIBLE WITH CURRENT NEXUS API";
    } else if (input.engineOk && input.mutationExecuted) {
        const checksOk =
            input.checks.chain &&
            input.checks.topology &&
            input.checks.bindings &&
            input.checks.presetValues;
        const probesOk = input.probes.every((p) => p.pass);
        if (checksOk && probesOk && input.probes.length > 0) {
            verdict = "INSTRUMENT IMPORT: PASS";
        } else {
            verdict = "INSTRUMENT IMPORT: PARTIAL";
            blockDetail = [
                checksOk ? null : "at least one verification block is not fully OK",
                probesOk ? null : "at least one target mapping probe failed",
            ]
                .filter((s): s is string => Boolean(s))
                .join("; ");
        }
    } else if (input.mutationExecuted) {
        verdict = "INSTRUMENT IMPORT: PARTIAL";
        blockDetail = "import executed on the real target but the engine did not verify OK — see FAILURES";
    } else {
        verdict = "INSTRUMENT IMPORT: PARTIAL";
        blockDetail = "no real mutation was executed — the result cannot be counted as PASS";
    }

    const text = buildPhaseDReportText(input, verdict, blockReason, blockDetail);
    return { text, verdict, blockReason, blockDetail };
}

export function buildPhaseDReportText(
    input: PhaseDReportInput,
    verdict: PhaseDVerdict,
    blockReason?: PhaseDBlockReason,
    blockDetail?: string,
): string {
    const env = input.environment;
    const cap = input.capability;
    const lines: string[] = ["# PHASE D — LIVE INSTRUMENT IMPORT", ""];

    lines.push("ENVIRONMENT:");
    lines.push(`  OAuth:            ${env.oauth}`);
    lines.push(`  Nexus version:    ${env.nexusVersion}`);
    lines.push(`  SOURCE:           ${env.sourceUrl}`);
    lines.push(`  TARGET:           ${env.targetUrl}`);
    lines.push("");

    lines.push("SOURCE:");
    lines.push(`  devices:          ${input.source.devices}`);
    lines.push(`  parameters:       ${input.source.parameters}`);
    lines.push(`  cables:           ${input.source.cables}`);
    lines.push(`  topology:         ${input.source.topology}`);
    lines.push("");

    lines.push("INSTRUMENT PRESET:");
    lines.push(`  version:          ${input.preset.version}`);
    lines.push(`  controls:         ${input.preset.controls}`);
    lines.push(`  bindings:         ${input.preset.bindings}`);
    lines.push(`  preset values:    ${input.preset.presetValues}`);
    lines.push("");

    lines.push("CAPABILITY GATE:");
    for (const row of cap.rows) {
        lines.push(`  ${row.operation.padEnd(20)} ${row.verdict}`);
    }
    lines.push(cap.blockedReason ? `  RESULT: BLOCKED — ${cap.blockedReason}` : `  RESULT: all required operations available`);
    lines.push("");

    lines.push("TARGET BEFORE:");
    lines.push(`  entities:         ${input.targetBefore.entities}`);
    lines.push(`  cables:           ${input.targetBefore.cables}`);
    lines.push("");

    const imp = input.importResult;
    lines.push("IMPORT:");
    lines.push(`  entities created: ${imp.entitiesCreated}`);
    lines.push(`  parameter writes: ${imp.parameterWrites}`);
    lines.push(`  cables created:   ${imp.cablesCreated}`);
    lines.push(`  bindings:         ${imp.bindingsOk}/${imp.bindingsTotal}`);
    lines.push(`  preset values:    ${imp.presetValuesOk}/${imp.presetValuesTotal}`);
    lines.push("TARGET AFTER:");
    lines.push(`  entities:         ${input.targetAfter.entities}`);
    lines.push(`  cables:           ${input.targetAfter.cables}`);
    lines.push("");

    lines.push("ID MAPPING:");
    lines.push(`  source IDs reused: ${input.idMapping.sourceIdsReused ? "YES" : "NO"}`);
    lines.push("  source→target mappings:");
    if (input.idMapping.mappings.length === 0) {
        lines.push("    (none)");
    }
    for (const [source, target] of input.idMapping.mappings) {
        lines.push(`    ${source} → ${target}`);
    }
    lines.push("");

    lines.push("VERIFICATION:");
    lines.push(`  chain:                 ${input.verification.chain}`);
    lines.push(`  topology:              ${input.verification.topology}`);
    lines.push(`  bindings:              ${input.verification.bindings}`);
    lines.push(`  preset values:         ${input.verification.presetValues}`);
    lines.push("");

    lines.push("MAPPING PROBES:");
    if (input.probes.length === 0) {
        lines.push("  (no probeable controls)");
    }
    for (const p of input.probes) {
        lines.push(`  ${p.controlId} [${p.kind}]: ${p.pass ? "PASS" : "FAIL"} — ${p.detail}`);
    }
    lines.push("");

    lines.push("FAILURES:");
    if (input.failures.length === 0) {
        lines.push("  []");
    }
    for (const f of input.failures) {
        lines.push(`  - ${f}`);
    }
    lines.push("");

    lines.push("FINAL VERDICT:");
    lines.push(`  ${verdict}`);
    if (blockReason && blockDetail) {
        lines.push("");
        lines.push(`Reason (${blockReason}):`);
        lines.push(`  ${blockDetail}`);
    }
    return lines.join("\n");
}

// re-export for convenience (identical §3 gate used by the browser UI)
export { assessRequiredCapabilities };
export type { CapabilityReport } from "../chain-clone-live/report";