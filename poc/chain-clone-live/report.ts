/**
 * LIVE CHAIN CLONE TEST — pure report & gating layer (§9, §3).
 *
 * Pure and Nexus-free so the final-verdict rules are deterministic offline
 * (`report.test.ts`). The browser UI (main.ts) feeds REAL live data into it.
 *
 * Verdict rules (honest reporting — never claim PASS without a real mutation):
 *   - a missing REQUIRED capability        → BLOCKED (CAPABILITY)
 *   - OAuth/project/network failure        → BLOCKED (ENVIRONMENT)
 *   - mutation ran + all steps verified    → PASS
 *   - mutation ran + at least one deficit  → PARTIAL
 *   - engine answered NOT POSSIBLE         → BLOCKED (CAPABILITY)
 */

import { CAPABILITY_TABLE, type CapabilityRow, type CapabilityVerdict } from "../chain-clone/api-capabilities";
import type { ChainSnapshot, FinalVerdict } from "../chain-clone/types";

export type LiveVerdict = "CHAIN CLONE: PASS" | "CHAIN CLONE: PARTIAL" | "CHAIN CLONE: BLOCKED";
export type BlockReason = "CAPABILITY" | "ENVIRONMENT";

export interface LiveCounts {
    entities: number;
    parameters: number;
    cables: number;
}

export interface CapabilityReport {
    rows: { operation: string; verdict: CapabilityVerdict; proof: string }[];
    blockedReason?: string;
}

export interface LiveSection {
    label: string;
    verdict: string;
}

export interface LiveTestReport {
    text: string;
    source: LiveCounts;
    targetBefore: Pick<LiveCounts, "entities" | "cables">;
    targetAfter: LiveCounts;
    cloneSections: LiveSection[];
    verdict: LiveVerdict;
    blockReason?: BlockReason;
    blockDetail?: string;
}

/** §3 required operations for this POC's clone strategy. */
export const REQUIRED_OPERATIONS = ["Entity erzeugen", "Parameter schreiben", "Cable erzeugen"] as const;

/** True only when the operation row proves the capability is usable. */
function isUsable(verdict: CapabilityVerdict): boolean {
    return verdict === "YES" || verdict === "PARTIAL";
}

/**
 * Phase 3 — map the (already proven) capability table onto the REQUIRED
 * operations and check the tested creatable-capacity set. Runs BEFORE any
 * mutation; a missing operation blocks the clone up front (no workaround).
 */
export function assessRequiredCapabilities(
    snapshot: ChainSnapshot,
    creatableTypes: ReadonlySet<string>,
    table: CapabilityRow[] = CAPABILITY_TABLE,
): CapabilityReport {
    const rows = REQUIRED_OPERATIONS.map((operation) => {
        const row = table.find((r) => r.capability === operation);
        const verdict = row?.verdict ?? "NOT PROVIDED BY NEXUS";
        return { operation, verdict, proof: row?.proof ?? "no evidence row available" };
    });

    const missing = rows.find((r) => !isUsable(r.verdict));
    if (missing) {
        return { rows, blockedReason: `Nexus v0.0.17 does not provide: ${missing.operation}` };
    }

    const unsupported = snapshot.devices.filter((d) => d.entityType && !creatableTypes.has(d.entityType));
    if (unsupported.length > 0) {
        const types = [...new Set(unsupported.map((d) => d.entityType))].join(", ");
        return {
            rows,
            blockedReason: `entity creation not proven creatable for: ${types} — no workaround invented, clone blocked`,
        };
    }

    return { rows };
}

/** §9 report: exact text block + machine-readable verdict. */
export function buildLiveReport(input: {
    source: LiveCounts;
    targetBefore: Pick<LiveCounts, "entities" | "cables">;
    targetAfter: LiveCounts;
    cloneSections: LiveSection[];
    finalVerdict: FinalVerdict;
    mutationExecuted: boolean;
    capabilityBlock?: string;
    environmentBlock?: string;
}): LiveTestReport {
    const { source, targetBefore, targetAfter, cloneSections, finalVerdict, mutationExecuted } = input;

    let verdict: LiveVerdict;
    let blockReason: BlockReason | undefined;
    let blockDetail: string | undefined;

    if (input.environmentBlock) {
        verdict = "CHAIN CLONE: BLOCKED";
        blockReason = "ENVIRONMENT";
        blockDetail = input.environmentBlock;
    } else if (input.capabilityBlock) {
        verdict = "CHAIN CLONE: BLOCKED";
        blockReason = "CAPABILITY";
        blockDetail = input.capabilityBlock;
    } else if (finalVerdict === "CHAIN CLONE: NOT POSSIBLE WITH CURRENT NEXUS API") {
        verdict = "CHAIN CLONE: BLOCKED";
        blockReason = "CAPABILITY";
        blockDetail = "the clone engine answered NOT POSSIBLE WITH CURRENT NEXUS API";
    } else if (finalVerdict === "CHAIN CLONE: PASS" && mutationExecuted) {
        verdict = "CHAIN CLONE: PASS";
    } else if (mutationExecuted) {
        verdict = "CHAIN CLONE: PARTIAL";
        blockDetail = "clone executed but at least one step did not fully verify";
    } else {
        // PASS claimed without a real mutation → never reported as PASS.
        verdict = "CHAIN CLONE: PARTIAL";
        blockDetail = "no real mutation was executed — result cannot be counted as PASS";
    }

    const text = buildReportText(source, targetBefore, targetAfter, cloneSections, verdict, blockReason, blockDetail);

    return {
        text,
        source,
        targetBefore,
        targetAfter,
        cloneSections,
        verdict,
        blockReason,
        blockDetail,
    };
}

export function buildReportText(
    source: LiveCounts,
    targetBefore: Pick<LiveCounts, "entities" | "cables">,
    targetAfter: LiveCounts,
    cloneSections: LiveSection[],
    verdict: LiveVerdict,
    blockReason?: BlockReason,
    blockDetail?: string,
): string {
    const lines: string[] = ["CHAIN CLONE LIVE TEST", ""];
    lines.push("SOURCE:");
    lines.push(`  Entities:       ${source.entities}`);
    lines.push(`  Parameters:     ${source.parameters}`);
    lines.push(`  Cables:         ${source.cables}`);
    lines.push("");
    lines.push("TARGET BEFORE:");
    lines.push(`  Entities:       ${targetBefore.entities}`);
    lines.push(`  Cables:         ${targetBefore.cables}`);
    lines.push("");
    lines.push("CLONE:");
    for (const s of cloneSections) {
        lines.push(`  ${s.label}: ${s.verdict}`);
    }
    lines.push("");
    lines.push("TARGET AFTER:");
    lines.push(`  Entities:       ${targetAfter.entities}`);
    lines.push(`  Parameters:     ${targetAfter.parameters}`);
    lines.push(`  Cables:         ${targetAfter.cables}`);
    lines.push("");
    lines.push("FINAL RESULT:");
    lines.push("");
    lines.push(verdict);
    if (blockReason && blockDetail) {
        lines.push("");
        lines.push(`Reason (${blockReason}):`);
        lines.push(blockDetail);
    }
    return lines.join("\n");
}