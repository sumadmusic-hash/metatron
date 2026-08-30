/**
 * METATRON CHAIN — shared model types (production).
 *
 * The snapshot model follows the task spec (`poc/chain-clone/` §3): a
 * serializable capture of devices, their automatable parameter fields, and the
 * audio connections inside a chain. No entity id from the source is ever
 * reused as a target id.
 *
 * Provenance: this module is the productive twin of `poc/chain-clone/types.ts`.
 * The PoC module re-exports from here so PoC tests keep running against the
 * same single source of truth.
 */

/** Verdict used per clone step and for the final report (§10 / §11). */
export type Verdict = "PASS" | "PARTIAL" | "FAIL";

/** Final question of the task (§17). */
export type FinalVerdict =
    | "CHAIN CLONE: PASS"
    | "CHAIN CLONE: PARTIAL"
    | "CHAIN CLONE: NOT POSSIBLE WITH CURRENT NEXUS API";

/** One primitive parameter field captured from the source device. */
export interface FieldSnapshot {
    /** Human readable field path, e.g. "filter.cutoffFrequencyHz". */
    path: string;
    /** Raw current value of the source (never normalized/coerced). */
    value: unknown;
    /** Schema primitive type: "number" | "boolean" | "string" | "bytes" | "nexus-location". */
    primitiveType?: string;
    /** bufbuild ScalarType enum value (e.g. 2 = FLOAT, 5 = INT32, 8 = BOOL). */
    scalarType?: number;
    /** Real schema range for numeric fields. */
    range?: { min: number; max: number };
    /** Real schema default (used for the default-vs-current analysis §7). */
    defaultValue?: number | boolean;
    mutable: boolean;
}

/** One device of the source chain. */
export interface DeviceSnapshot {
    /** Source entity id — MUST never appear as a target id. */
    sourceEntityId: string;
    entityType: string;
    displayName?: string;
    /** Schema entity type key from Nexus entity details. */
    schemaTargetType?: string;
    fields: FieldSnapshot[];
}

/** One audio connection of the source chain. */
export interface ConnectionSnapshot {
    fromEntityId: string;
    /** Socket field on the from device, resolved from the real schema path. */
    fromSocket?: string;
    /** Full human readable socket path, e.g. "pulverisateur.audioOutput". */
    fromSocketPath?: string;
    toEntityId: string;
    toSocket?: string;
    toSocketPath?: string;
}

/** Serialized, JSON-safe chain capture (§3). */
export interface ChainSnapshot {
    version: number;
    devices: DeviceSnapshot[];
    connections: ConnectionSnapshot[];
    /** Device ids that have no incoming connection among the snapshot. */
    rootCandidates: string[];
}

// ———————————————————————————————————————————————————————————————————————
// Clone planning / execution records
// ———————————————————————————————————————————————————————————————————————

export type DevicePlanAction = "create" | "unsupported" | "missing";

export interface DevicePlan {
    sourceId: string;
    entityType: string;
    displayName?: string;
    action: DevicePlanAction;
    reason?: string;
}

export type ParameterPlanAction =
    | "update"
    | "skipImmutable"
    | "skipNonPrimitive"
    | "typeMismatch"
    | "rangeError"
    | "missingField";

export interface ParameterPlan {
    sourceDeviceId: string;
    path: string;
    sourceValue: unknown;
    action: ParameterPlanAction;
    /** Value that actually gets written (clamped/rounded) when action=update. */
    proposedValue?: unknown;
    range?: { min: number; max: number };
    reason?: string;
}

export type ConnectionPlanAction = "create" | "skipMissing" | "skipSocket" | "rangeError";

export interface ConnectionPlan {
    fromSourceDeviceId: string;
    toSourceDeviceId: string;
    fromSocketPath?: string;
    toSocketPath?: string;
    /** Relative socket field segments (type prefix already stripped) on the target. */
    fromSegments?: string[];
    toSegments?: string[];
    action: ConnectionPlanAction;
    reason?: string;
}

/** Full, pre-computed plan that the live engine executes against the target. */
export interface ClonePlan {
    devices: DevicePlan[];
    parameters: ParameterPlan[];
    connections: ConnectionPlan[];
}

// ———————————————————————————————————————————————————————————————————————
// Report (§10)
// ———————————————————————————————————————————————————————————————————————

export interface ReportSection {
    verdict: Verdict;
    detail: string[];
}

export interface CloneReport {
    sections: {
        entityCreation: ReportSection;
        parameterRestore: ReportSection;
        currentValues: ReportSection;
        connectionCreation: ReportSection;
        topologyRestore: ReportSection;
        verification: ReportSection;
    };
    supportedEntityTypes: string[];
    unsupportedEntityTypes: string[];
    nexusApiLimitations: string[];
    finalVerdict: FinalVerdict;
}

/** One per-step failure, used by the rollback/partial-failure reporting. */
export interface FailureRecord {
    step: "device" | "parameter" | "connection";
    sourceId?: string;
    targetId?: string;
    path?: string;
    message: string;
}

/** Aggregate result of a clone attempt. */
export interface CloneResult {
    snapshot: ChainSnapshot;
    /** Maps source entity ids to the created target entity ids. */
    idMap: Map<string, string>;
    failures: FailureRecord[];
    report: CloneReport;
    /** Target was read back and compared with the snapshot. */
    verification?: VerificationResult;
}

// ———————————————————————————————————————————————————————————————————————
// Verification (§9)
// ———————————————————————————————————————————————————————————————————————

export interface VerificationResult {
    devices: { expected: number; actual: number; matched: boolean };
    parameters: { expected: number; actual: number; matched: number; equal: boolean };
    connections: { expected: number; actual: number; matched: number; equal: boolean };
    topology: { sourceOrder: string[]; targetOrder: string[]; equal: boolean };
    diffs: string[];
    ok: boolean;
}