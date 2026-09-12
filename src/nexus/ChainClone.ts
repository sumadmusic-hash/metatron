/**
 * CHAIN CLONE ENGINE — the only module that MUTATES the TARGET document (production).
 *
 * Execution order: devices → id mapping → parameter restore → cables →
 * verification. The SOURCE document is only ever read (`ChainSnapshot`).
 *
 * Mutation surface used (all real `@audiotool/nexus` APIs):
 *   - `t.create(type, args)`        — device / cable creation
 *   - `t.tryUpdate(field, value)`   — parameter restore (error-string semantics)
 *
 * Nothing is guessed: every value/target decision comes from the real schema
 * details of the TARGET fields/sockets (`getSchemaLocationDetails`).
 *
 * Provenance: this module is the productive twin of `poc/chain-clone/clone.ts`.
 * The PoC module re-exports from here so PoC tests keep running against the
 * same single source of truth. `createSnapshot` itself comes from
 * `ChainSnapshot` (read-only); this module orchestriert creation + restore.
 */

import type { SyncedDocument } from "@audiotool/nexus";
import { getSchemaLocationDetails } from "@audiotool/nexus/document";
import { KNOWN_CREATABLE_TYPES } from "./ChainCreatableTypes";
import { resolveFieldByPath } from "./ChainPath";
import { normalizeEntityId } from "./ChainDiscovery";
import { discoverChainLive } from "./ChainLive";
import { createSnapshot } from "./ChainSnapshot";
import { planDevices, planParameters, planConnections, planDeviceLayout } from "./ChainPlanning";
import type { DevicePosition, ResolveTargetFieldMeta, ResolveTargetSocket } from "./ChainPlanning";
import { buildTargetDigest, compareSnapshotWithTarget } from "./ChainVerify";
import type {
    ChainSnapshot,
    CloneReport,
    CloneResult,
    DevicePlan,
    ConnectionPlan,
    FailureRecord,
    ParameterPlan,
    VerificationResult,
    FinalVerdict,
} from "./ChainTypes";

const LOG = "[METATRON CHAIN CLONE]";

export { KNOWN_CREATABLE_TYPES };

export interface CloneOptions {
    maxDepth?: number;
    onProgress?: (step: string) => void;
}

function progress(opts: CloneOptions | undefined, step: string) {
    console.log(`${LOG} ${step}`);
    opts?.onProgress?.(step);
}

function safeFieldDetails(field: any): any {
    if (!field?.location) return null;
    try {
        return getSchemaLocationDetails(field.location);
    } catch {
        return null;
    }
}

function fieldMetaOf(field: any): { primitiveType?: string; scalarType?: number; range?: { min: number; max: number }; immutable?: boolean } {
    const d = safeFieldDetails(field);
    if (!d || d.type !== "primitive") return {};
    return {
        primitiveType: d.primitive?.type,
        scalarType: d.primitive?.scalarType,
        range: d.primitive?.range,
        immutable: d.immutable,
    };
}

/**
 * Phase 1 — create every device on the target. Returns the source→target id map.
 * A per-device failure is captured instead of aborting the whole clone.
 */
export async function createDevicesInDoc(
    targetDoc: SyncedDocument,
    devicePlans: DevicePlan[],
    positions?: Map<string, DevicePosition>,
): Promise<{ idMap: Map<string, string>; failures: FailureRecord[] }> {
    const idMap = new Map<string, string>();
    const failures: FailureRecord[] = [];
    const creatable = devicePlans.filter((p) => p.action === "create");
    if (creatable.length === 0) return { idMap, failures };

    try {
        await (targetDoc as any).modify((t: any) => {
            for (const plan of creatable) {
                try {
                    const args: Record<string, unknown> = {};
                    if (plan.displayName) args.displayName = plan.displayName;
                    const pos = positions?.get(normalizeEntityId(plan.sourceId));
                    if (pos) {
                        args.positionX = pos.x;
                        args.positionY = pos.y;
                    }
                    const created = t.create(plan.entityType, args);
                    idMap.set(normalizeEntityId(plan.sourceId), created.id);
                } catch (e) {
                    failures.push({
                        step: "device",
                        sourceId: plan.sourceId,
                        message: `create ${plan.entityType}: ${String((e as any)?.message ?? e)}`,
                    });
                }
            }
        });
    } catch (e) {
        for (const plan of creatable) {
            if (!idMap.has(normalizeEntityId(plan.sourceId))) {
                failures.push({
                    step: "device",
                    sourceId: plan.sourceId,
                    message: `transaction rejected: ${String((e as any)?.message ?? e)}`,
                });
            }
        }
    }
    progress(undefined, `devices: created=${idMap.size} failed=${failures.length}`);
    return { idMap, failures };
}

/** Build the target-schema read resolvers bound to the created devices. */
export function buildTargetResolvers(
    targetDoc: SyncedDocument,
    idMap: Map<string, string>,
): { resolveTargetMeta: ResolveTargetFieldMeta; resolveTargetSocket: ResolveTargetSocket } {
    let targetEntities = new Map<string, any>();
    try {
        targetEntities = new Map(
            (targetDoc.queryEntities as any).get().map((e: any) => [normalizeEntityId(e.id), e]),
        );
    } catch {
        targetEntities = new Map();
    }

    const targetEntityForSource = (sourceId: string): any | undefined => {
        const targetId = idMap.get(normalizeEntityId(sourceId));
        if (!targetId) return undefined;
        return targetEntities.get(normalizeEntityId(targetId)) ?? (targetDoc.queryEntities as any).getEntity(targetId);
    };

    const resolveTargetMeta: ResolveTargetFieldMeta = (sourceDeviceId, path) => {
        const entity = targetEntityForSource(sourceDeviceId);
        if (!entity) return undefined;
        const field = resolveFieldByPath(entity.fields, path);
        return field ? fieldMetaOf(field) : undefined;
    };

    const resolveTargetSocket: ResolveTargetSocket = (sourceDeviceId, segments, kind) => {
        const entity = targetEntityForSource(sourceDeviceId);
        if (!entity) return { ok: false, reason: "target device missing" };
        const field = resolveFieldByPath(entity.fields, segments.join("."));
        if (!field?.location) return { ok: false, reason: `socket ${segments.join(".")} not found on target` };
        const details = safeFieldDetails(field);
        if (!details || !(details.targetTypes ?? []).includes(kind)) {
            return { ok: false, reason: `socket ${segments.join(".")} is not a ${kind}` };
        }
        return { ok: true, location: field.location, socketField: segments[segments.length - 1] };
    };

    return { resolveTargetMeta, resolveTargetSocket };
}

/**
 * Phase 2 — restore parameter values on the target. Uses the real
 * target schema: immutable fields are skipped, values are clamped/rounded to
 * the real ranges, and `tryUpdate` is used so range rejections become records.
 */
export async function restoreParametersInDoc(
    targetDoc: SyncedDocument,
    idMap: Map<string, string>,
    paramPlans: ParameterPlan[],
): Promise<FailureRecord[]> {
    const failures: FailureRecord[] = [];

    // Resolve real primitive fields once, before mutating anything.
    const targets = new Map<string, { field: any; plan: ParameterPlan }>();
    for (const plan of paramPlans) {
        if (plan.action !== "update" && plan.action !== "rangeError") {
            failures.push({
                step: "parameter",
                sourceId: plan.sourceDeviceId,
                path: plan.path,
                message: `skipped (${plan.action}): ${plan.reason ?? "not restorable"}`,
            });
            continue;
        }
        const entity = targetEntityFor(targetDoc, idMap, plan.sourceDeviceId);
        if (!entity) {
            failures.push({ step: "parameter", sourceId: plan.sourceDeviceId, path: plan.path, message: "target device missing" });
            continue;
        }
        const field = resolveFieldByPath(entity.fields, plan.path);
        if (!field) {
            failures.push({ step: "parameter", sourceId: plan.sourceDeviceId, path: plan.path, message: "target field missing" });
            continue;
        }
        targets.set(`${plan.sourceDeviceId}:${plan.path}`, { field, plan });
    }

    // One transaction per device so a rejected field never aborts other devices.
    const byDevice = new Map<string, ParameterPlan[]>();
    for (const plan of paramPlans) {
        if (plan.action !== "update" && plan.action !== "rangeError") continue;
        const list = byDevice.get(normalizeEntityId(plan.sourceDeviceId)) ?? [];
        list.push(plan);
        byDevice.set(normalizeEntityId(plan.sourceDeviceId), list);
    }

    for (const [sourceId, plans] of byDevice) {
        try {
            await (targetDoc as any).modify((t: any) => {
                for (const plan of plans) {
                    const entry = targets.get(`${sourceId}:${plan.path}`);
                    if (!entry || plan.proposedValue === undefined) continue;
                    const error = t.tryUpdate(entry.field, plan.proposedValue);
                    if (typeof error === "string") {
                        failures.push({ step: "parameter", sourceId, path: plan.path, message: `tryUpdate: ${error}` });
                    }
                }
            });
        } catch (e) {
            failures.push({ step: "parameter", sourceId, message: `transaction rejected: ${String((e as any)?.message ?? e)}` });
        }
    }
    progress(undefined, `parameters: plans=${paramPlans.length} applied=${byDevice.size} failed=${failures.length}`);
    return failures;
}

function targetEntityFor(targetDoc: SyncedDocument, idMap: Map<string, string>, sourceId: string): any | undefined {
    const targetId = idMap.get(normalizeEntityId(sourceId));
    if (!targetId) return undefined;
    try {
        return (targetDoc.queryEntities as any).getEntity(targetId);
    } catch {
        return undefined;
    }
}

/**
 * Phase 3 — recreate the `desktopAudioCable` entities on the target,
 * resolving socket LOCATIONS from the created target devices by schema path.
 */
export async function createConnectionsInDoc(
    targetDoc: SyncedDocument,
    idMap: Map<string, string>,
    connPlans: ConnectionPlan[],
): Promise<FailureRecord[]> {
    const failures: FailureRecord[] = [];
    const resolvers = buildTargetResolvers(targetDoc, idMap);

    const resolved: { plan: ConnectionPlan; from: any; to: any }[] = [];
    for (const plan of connPlans) {
        if (plan.action !== "create") {
            failures.push({
                step: "connection",
                sourceId: plan.fromSourceDeviceId,
                message: `skipped (${plan.action}): ${plan.reason ?? ""} ${plan.toSourceDeviceId}`,
            });
            continue;
        }
        const fromRes = resolvers.resolveTargetSocket(plan.fromSourceDeviceId, plan.fromSegments ?? [], "AudioOutput");
        if (!fromRes.ok) {
            failures.push({
                step: "connection",
                sourceId: plan.fromSourceDeviceId,
                message: `from socket unresolved: ${fromRes.reason}`,
            });
            continue;
        }
        if (!fromRes.location) {
            failures.push({
                step: "connection",
                sourceId: plan.fromSourceDeviceId,
                message: "from socket resolved without location",
            });
            continue;
        }
        const toRes = resolvers.resolveTargetSocket(plan.toSourceDeviceId, plan.toSegments ?? [], "AudioInput");
        if (!toRes.ok) {
            failures.push({
                step: "connection",
                sourceId: plan.fromSourceDeviceId,
                message: `to socket unresolved: ${toRes.reason}`,
            });
            continue;
        }
        if (!toRes.location) {
            failures.push({
                step: "connection",
                sourceId: plan.fromSourceDeviceId,
                message: "to socket resolved without location",
            });
            continue;
        }
        resolved.push({ plan, from: fromRes.location, to: toRes.location });
    }

    let created = 0;
    for (const entry of resolved) {
        try {
            await (targetDoc as any).modify((t: any) => {
                t.create("desktopAudioCable", { fromSocket: entry.from, toSocket: entry.to });
            });
            created++;
        } catch (e) {
            failures.push({
                step: "connection",
                sourceId: entry.plan.fromSourceDeviceId,
                message: `cable create: ${String((e as any)?.message ?? e)}`,
            });
        }
    }
    progress(undefined, `connections: created=${created} failed=${failures.length}`);
    return failures;
}

/** Phase 4 — read the target back and compare. */
export function verifyClone(
    targetDoc: SyncedDocument,
    snapshot: ChainSnapshot,
    idMap: Map<string, string>,
): VerificationResult {
    const digest = buildTargetDigest(targetDoc);
    const targetOrder: string[] = [];
    const visited = new Set<string>();
    for (const candidate of snapshot.rootCandidates) {
        const targetRoot = candidate ? idMap.get(normalizeEntityId(candidate)) : undefined;
        if (!targetRoot) continue;
        try {
            for (const id of discoverChainLive(targetDoc, targetRoot, 32).result.order) {
                if (visited.has(id)) continue;
                visited.add(id);
                targetOrder.push(id);
            }
        } catch {
            // a root that cannot be traversed is simply not visited
        }
    }
    const verification = compareSnapshotWithTarget(snapshot, digest, idMap, targetOrder);
    progress(undefined, `verify: devices=${verification.devices.actual}/${verification.devices.expected} params=${verification.parameters.matched}/${verification.parameters.expected} connections=${verification.connections.matched}/${verification.connections.expected} topology=${verification.topology.equal ? "equal" : "DIFF"}`);
    return verification;
}

function finalVerdictOf(report: CloneReport): FinalVerdict {
    const all = [
        report.sections.entityCreation.verdict,
        report.sections.parameterRestore.verdict,
        report.sections.currentValues.verdict,
        report.sections.connectionCreation.verdict,
        report.sections.topologyRestore.verdict,
        report.sections.verification.verdict,
    ] as const;
    if (all.includes("FAIL") || report.sections.entityCreation.verdict === "FAIL") {
        if (report.sections.entityCreation.verdict === "FAIL") return "CHAIN CLONE: NOT POSSIBLE WITH CURRENT NEXUS API";
        return "CHAIN CLONE: PARTIAL";
    }
    if (all.includes("PARTIAL")) return "CHAIN CLONE: PARTIAL";
    return "CHAIN CLONE: PASS";
}

/** Assemble the machine-readable report. */
export function buildCloneReport(input: {
    snapshot: ChainSnapshot;
    failures: FailureRecord[];
    verification?: VerificationResult;
    unsupportedTypes: string[];
    nexusApiLimitations: string[];
}): CloneReport {
    const { snapshot, failures, verification, unsupportedTypes } = input;

    const failedDevices = failures.filter((f) => f.step === "device");
    const failedParams = failures.filter((f) => f.step === "parameter");
    const failedConnections = failures.filter((f) => f.step === "connection");

    const deviceOk = snapshot.devices.length - failedDevices.length;
    const paramOk = snapshot.devices.flatMap((d) => d.fields).length - failedParams.length;
    const connOk = snapshot.connections.length - failedConnections.length;

    const entityCreation = {
        verdict: verdictFromTried(snapshot.devices.length, deviceOk),
        detail: [
            `devices: ${deviceOk}/${snapshot.devices.length}`,
            ...failedDevices.map((f) => `FAIL ${f.sourceId}: ${f.message}`),
        ],
    };
    const parameterRestore = {
        verdict: verdictFromTried(snapshot.devices.flatMap((d) => d.fields).length, paramOk),
        detail: [`parameters: ${paramOk}/${snapshot.devices.flatMap((d) => d.fields).length}`, ...failedParams.map((f) => `FAIL ${f.path}: ${f.message}`)],
    };

    const verificationSection = verification
        ? {
            verdict: verification.ok ? ("PASS" as const) : ("PARTIAL" as const),
            detail: [
                `devices ${verification.devices.matched ? "OK" : "DIFF"} (${verification.devices.actual}/${verification.devices.expected})`,
                `parameters ${verification.parameters.equal ? "OK" : "DIFF"} (${verification.parameters.matched}/${verification.parameters.expected})`,
                `connections ${verification.connections.equal ? "OK" : "DIFF"} (${verification.connections.matched}/${verification.connections.expected})`,
                `topology ${verification.topology.equal ? "OK" : "DIFF"}`,
                ...verification.diffs.slice(0, 40),
            ],
        }
        : { verdict: "FAIL" as const, detail: ["verification not performed"] };

    const report: CloneReport = {
        sections: {
            entityCreation,
            parameterRestore,
            currentValues: {
                verdict: verificationSection.verdict === "PASS" ? "PASS" : verificationSection.verdict === "FAIL" ? "FAIL" : "PARTIAL",
                detail: [
                    verificationSection.verdict === "PASS"
                        ? "source current values restored and readable on target"
                        : "some current values differ from the source snapshot (see verification)",
                ],
            },
            connectionCreation: {
                verdict: verdictFromTried(snapshot.connections.length, connOk),
                detail: [`cables: ${connOk}/${snapshot.connections.length}`, ...failedConnections.map((f) => `FAIL ${f.message}`)],
            },
            topologyRestore: {
                verdict: verification?.topology.equal ? "PASS" : "FAIL",
                detail: [verification?.topology.equal ? "source->target topology identical" : "target topology differs"],
            },
            verification: verificationSection,
        },
        supportedEntityTypes: snapshot.devices.map((d) => d.entityType),
        unsupportedEntityTypes: unsupportedTypes,
        nexusApiLimitations: input.nexusApiLimitations,
        finalVerdict: "CHAIN CLONE: PARTIAL",
    };

    const finalWiki = finalVerdictOf(report);
    report.finalVerdict = finalWiki;
    return report;
}

function verdictFromTried(tried: number, ok: number): "PASS" | "PARTIAL" | "FAIL" {
    if (tried === 0) return "FAIL";
    if (ok === tried) return "PASS";
    if (ok === 0) return "FAIL";
    return "PARTIAL";
}

/** Full orchestration: snapshot source → plan → create → restore → cable → verify → report. */
export async function cloneChainToDoc(
    sourceDoc: SyncedDocument,
    targetDoc: SyncedDocument,
    rootId: string,
    options?: CloneOptions,
): Promise<CloneResult> {
    const maxDepth = options?.maxDepth ?? 32;
    const snapshot = createSnapshot(sourceDoc, rootId, maxDepth);
    progress(options, `snapshot captured: ${snapshot.devices.length} devices, ${snapshot.connections.length} connections`);
    return cloneChainFromSnapshot(snapshot, targetDoc, options);
}

/**
 * Clone orchestration from an ALREADY captured snapshot:
 * the source document is not touched here at all — only the snapshot and the
 * target. Planning still uses the REAL target schema at execution time.
 */
export async function cloneChainFromSnapshot(
    snapshot: ChainSnapshot,
    targetDoc: SyncedDocument,
    options?: CloneOptions,
): Promise<CloneResult> {
    const devicePlans = planDevices(snapshot, KNOWN_CREATABLE_TYPES);
    const unsupportedTypes = devicePlans.filter((p) => p.action === "unsupported").map((p) => p.entityType);
    const layout = planDeviceLayout(snapshot);

    const { idMap, failures: deviceFailures } = await createDevicesInDoc(targetDoc, devicePlans, layout);
    progress(options, `creating devices…`);

    const resolvers = buildTargetResolvers(targetDoc, idMap);
    const paramPlans = planParameters(snapshot, resolvers.resolveTargetMeta);
    const connPlans = planConnections(snapshot, resolvers.resolveTargetSocket, idMap);

    const paramFailures = await restoreParametersInDoc(targetDoc, idMap, paramPlans);
    progress(options, `restoring parameters…`);

    const connFailures = await createConnectionsInDoc(targetDoc, idMap, connPlans);
    progress(options, `creating connections…`);

    const verification = verifyClone(targetDoc, snapshot, idMap);
    progress(options, `verifying…`);

    const report = buildCloneReport({
        snapshot,
        failures: [...deviceFailures, ...paramFailures, ...connFailures],
        verification,
        unsupportedTypes,
        nexusApiLimitations: [
            "Entity creation limited to entity constructor map (runtime 'No defaults' errors observed for some types).",
            "No dedicated 'clone this chain' API — manual device + cable reconstruction under a source→target id map.",
            "Float32 fields: values are float32; comparison uses tolerance > float32 precision.",
        ],
    });

    progress(options, `RESULT ${report.finalVerdict}`);
    return { snapshot, idMap, failures: [...deviceFailures, ...paramFailures, ...connFailures], report, verification };
}