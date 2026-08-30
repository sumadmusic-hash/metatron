/**
 * PHASE C — INSTRUMENT IMPORT: `InstrumentPreset v0.1` → TARGET document.
 *
 * Pure import engine on top of the PROVEN chain-clone engine. There is no new
 * clone implementation here: `cloneChainFromSnapshot` (src/nexus/ChainClone)
 * recreates the stored chain and returns the source→target `idMap`. The import
 * then performs the three additional jobs defined by the spec:
 *
 *   1. RESOLVE every logical binding through the idMap where
 *      `sourceEntityIndex → snapshot.devices[index].sourceEntityId → idMap →
 *      targetEntityId` is the ONLY allowed translation. No name search, no
 *      heuristics, no source-id reuse.
 *   2. SET the bindings via the existing `BindingManager.setBinding` (ActiveBinding
 *      stays transient; the persistent logical definition remains the preset).
 *   3. APPLY every preset control value through the stored `valueMapping` via
 *      `mapNormalizedToNexus` (0..1 → real Nexus range/domain), then READ BACK
 *      from the target through `mapNexusToNormalized` and compare.
 *
 * Controlled failures (never silent skips):
 *   - sourceEntityIndex out of range / source id missing   → binding failure
 *   - source id not in idMap (device not cloned)           → binding failure
 *   - target entity / fieldPath not resolvable             → binding failure
 *   - target field immutable or schema-unavailable         → binding failure (NO write)
 *   - valueMapping kind "unsupported" / map yields undefined → binding failure (NO write)
 *   - control value missing a binding                      → preset failure ("not applicable")
 *   - non-normalized control value                        → preset failure (not clamped)
 *
 * The chain section is verified by the clone engine itself (read-back based,
 * BEFORE preset application so source-restore equality still holds). Bindings
 * and preset values are verified AFTER the writes by an independent fresh
 * read of the target document.
 */
import type { SyncedDocument } from "@audiotool/nexus";
import { getSchemaLocationDetails } from "@audiotool/nexus/document";
import { cloneChainFromSnapshot } from "../../nexus/ChainClone";
import { resolveFieldByPath } from "../../nexus/ChainPath";
import { normalizeEntityId } from "../../nexus/ChainDiscovery";
import { valuesEqualFloat32 } from "../../nexus/ChainVerify";
import {
    mapNexusToNormalized,
    mapNormalizedToNexus,
} from "../../nexus/NexusValueMapping";
import type { NexusValueMapping } from "../../nexus/NexusValueMapping";
import type { ChainSnapshot, CloneResult, FinalVerdict, VerificationResult } from "../../nexus/ChainTypes";
import type { InstrumentPreset, InstrumentPresetBinding } from "./InstrumentPreset";
import type { BindingManager } from "../BindingManager";

export interface InstrumentPresetImportOptions {
    /** Chain traversal / creation depth bound passed to the clone engine. */
    maxDepth?: number;
}

/** Per-binding resolution/import outcome. */
export interface ImportedBindingRecord {
    controlId: string;
    sourceEntityIndex: number;
    fieldPath: string;
    /** Target id resolved through the clone idMap (never a source id). */
    targetEntityId: string;
    valueMapping: NexusValueMapping;
    ok: boolean;
    message?: string;
}

/** Per-control-value application outcome. */
export interface ImportedPresetValueRecord {
    controlId: string;
    normalized: number;
    /** The raw value written to the target (mapped, not normalized). */
    nexusValue?: number | boolean;
    ok: boolean;
    message?: string;
}

export interface InstrumentImportVerification {
    /** Independent read-back verification from the clone engine (chain). */
    chain: VerificationResult;
    chainVerdict: FinalVerdict;
    /** Fresh re-read of every resolved binding on the target. */
    bindings: { ok: boolean; detail: string[] };
    /** Read-back of every applied preset value, normalized and compared. */
    preset: { ok: boolean; detail: string[] };
}

export interface InstrumentImportResult {
    ok: boolean;
    sections: {
        chain: { ok: boolean; detail: string };
        bindings: { ok: boolean; detail: string };
        preset: { ok: boolean; detail: string };
        verification: { ok: boolean; detail: string };
    };
    clone: CloneResult;
    /** Normalized source→target id translation (serializable). */
    idMap: Record<string, string>;
    bindings: ImportedBindingRecord[];
    presetValues: ImportedPresetValueRecord[];
    verification: InstrumentImportVerification;
    failures: string[];
}

interface ResolvedBinding {
    record: ImportedBindingRecord;
    field: any;
    details: any;
}

/** Pure write-guard decision (SDK-proven: no immutable primitive fields exist
 *  in v0.0.17 for any creatable type — the guard is still enforced so a future
 *  field can never be written). */
export function fieldWriteBlockReason(details: { immutable?: boolean } | undefined): string | undefined {
    if (!details) return "target field schema unavailable";
    if (details.immutable === true) return "target field is immutable (read-only) — write refused";
    return undefined;
}

function schemaDetailsOf(field: any): any {
    if (!field?.location) return undefined;
    try {
        return getSchemaLocationDetails(field.location);
    } catch {
        return undefined;
    }
}

function lastPathSegment(path: string): string {
    const parts = path.split(".").filter((s) => s.length > 0);
    return parts[parts.length - 1] ?? path;
}

/** Resolve one binding through snapshot → idMap → target field.
 *  Never guesses names; never reuses source ids as target ids. */
function resolveBinding(
    snapshot: ChainSnapshot,
    idMap: Map<string, string>,
    targetDoc: SyncedDocument,
    binding: InstrumentPresetBinding,
): { ok: true; resolved: ResolvedBinding } | { ok: false; message: string } {
    const index = binding.sourceEntityIndex;
    if (!Number.isInteger(index) || index < 0 || index >= snapshot.devices.length) {
        return { ok: false, message: `sourceEntityIndex ${index} out of range (devices.length=${snapshot.devices.length})` };
    }

    const sourceEntityId = snapshot.devices[index].sourceEntityId;
    if (!sourceEntityId) {
        return { ok: false, message: `snapshot.devices[${index}] has no sourceEntityId` };
    }

    const targetEntityId = idMap.get(normalizeEntityId(sourceEntityId));
    if (!targetEntityId) {
        return { ok: false, message: `source entity "${sourceEntityId}" not in idMap (device not cloned)` };
    }

    let entity: any;
    try {
        entity = (targetDoc.queryEntities as any).getEntity(targetEntityId);
    } catch {
        entity = undefined;
    }
    if (!entity) {
        return { ok: false, message: `target entity "${targetEntityId}" missing` };
    }

    const field = resolveFieldByPath(entity.fields, binding.fieldPath);
    if (!field?.location) {
        return { ok: false, message: `fieldPath "${binding.fieldPath}" not resolvable on target entity "${targetEntityId}"` };
    }

    const details = schemaDetailsOf(field);
    const blockReason = fieldWriteBlockReason(details);
    if (blockReason) {
        return { ok: false, message: `fieldPath "${binding.fieldPath}": ${blockReason}` };
    }

    if (!binding.valueMapping || binding.valueMapping.kind === "unsupported") {
        return { ok: false, message: `binding "${binding.controlId}": no supported numeric mapping (${binding.valueMapping?.typeLabel ?? "missing"}) — write refused` };
    }

    return {
        ok: true,
        resolved: {
            record: {
                controlId: binding.controlId,
                sourceEntityIndex: index,
                fieldPath: binding.fieldPath,
                targetEntityId,
                valueMapping: binding.valueMapping,
                ok: true,
            },
            field,
            details,
        },
    };
}

/** Chain structure is ok when every expected device/cable is present and the
 *  topology matches. Uses `connections.matched === connections.expected` (0==0
 *  equals) instead of the Comparison engine's `equal` boolean which reports
 *  false for an empty cable set — a single-device chain is still a valid, fully
 *  recreated chain. */
function chainStructureOk(clone: CloneResult): boolean {
    if (clone.failures.length > 0) return false;
    const v = clone.verification;
    if (!v) return false;
    return (
        v.devices.matched === true &&
        v.connections.matched === v.connections.expected &&
        v.topology.equal === true
    );
}

/** Independent fresh read of a target field value (not the just-written ref). */
function readTargetValue(targetDoc: SyncedDocument, entityId: string, fieldPath: string): unknown {
    try {
        const entity = (targetDoc.queryEntities as any).getEntity(entityId);
        if (!entity) return undefined;
        const field = resolveFieldByPath(entity.fields, fieldPath);
        return field?.value;
    } catch {
        return undefined;
    }
}

/**
 * Orchestrate the TARGET import of one `InstrumentPreset`.
 * Mutations are limited to the TARGET document (via the clone engine and the
 * direct preset-value writes) and the transient BindingManager state.
 */
export async function importInstrumentPreset(
    preset: InstrumentPreset,
    targetDoc: SyncedDocument,
    bindingManager: BindingManager,
    options?: InstrumentPresetImportOptions,
): Promise<InstrumentImportResult> {
    const failures: string[] = [];
    const snapshot = preset.chain.snapshot;

    // ── 1. CHAIN ───────────────────────────────────────────────────────────
    const clone = await cloneChainFromSnapshot(snapshot, targetDoc, { maxDepth: options?.maxDepth });
    for (const f of clone.failures) {
        failures.push(`chain ${f.step}: ${f.message}`);
    }
    const chainVerificationOk = chainStructureOk(clone);
    if (!chainVerificationOk) {
        failures.push(`chain structure: ${(clone.verification?.diffs ?? []).slice(0, 20).join(" | ") || "not ok"}`);
    }
    const chainOk = chainVerificationOk;

    const idMap = clone.idMap;
    const serializableIdMap: Record<string, string> = {};
    for (const [source, target] of idMap) serializableIdMap[source] = target;

    // ── 2. BINDINGS ────────────────────────────────────────────────────────
    const device = bindingManager.deviceRef;
    const bindingRecords: ImportedBindingRecord[] = [];
    const liveBindings = new Map<string, ResolvedBinding>();

    for (const binding of preset.bindings) {
        if (!device.getControl(binding.controlId)) {
            const record: ImportedBindingRecord = {
                controlId: binding.controlId,
                sourceEntityIndex: binding.sourceEntityIndex,
                fieldPath: binding.fieldPath,
                targetEntityId: "",
                valueMapping: binding.valueMapping,
                ok: false,
                message: `control "${binding.controlId}" does not exist on device "${device.id}"`,
            };
            bindingRecords.push(record);
            failures.push(`binding ${binding.controlId}: ${record.message}`);
            continue;
        }

        const resolved = resolveBinding(snapshot, idMap, targetDoc, binding);
        if (!resolved.ok) {
            const record: ImportedBindingRecord = {
                controlId: binding.controlId,
                sourceEntityIndex: binding.sourceEntityIndex,
                fieldPath: binding.fieldPath,
                targetEntityId: "",
                valueMapping: binding.valueMapping,
                ok: false,
                message: resolved.message,
            };
            bindingRecords.push(record);
            failures.push(`binding ${binding.controlId}: ${record.message}`);
            continue;
        }

        const { record, field } = resolved.resolved;
        bindingManager.setBinding(
            record.controlId,
            record.targetEntityId,
            lastPathSegment(record.fieldPath),
            undefined,
            field,
            record.fieldPath,
            record.valueMapping,
        );
        liveBindings.set(record.controlId, resolved.resolved);
        bindingRecords.push(record);
    }
    const bindingsOk = bindingRecords.every((b) => b.ok);

    // ── 3. PRESET VALUES ───────────────────────────────────────────────────
    const presetRecords: ImportedPresetValueRecord[] = [];
    for (const [controlId, normalized] of Object.entries(preset.metatron.controlValues)) {
        const binding = preset.bindings.find((b) => b.controlId === controlId);
        const bindingRecord = bindingRecords.find((b) => b.controlId === controlId);

        if (!binding) {
            presetRecords.push({ controlId, normalized, ok: false, message: "control has no binding — not applicable" });
            failures.push(`preset ${controlId}: control has no binding — not applicable`);
            continue;
        }
        if (!bindingRecord || !bindingRecord.ok) {
            const reason = bindingRecord?.message ?? "binding not resolvable — not applied";
            presetRecords.push({ controlId, normalized, ok: false, message: reason });
            failures.push(`preset ${controlId}: ${reason}`);
            continue;
        }
        if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1) {
            presetRecords.push({ controlId, normalized, ok: false, message: `value ${normalized} not normalized (0..1) — not clamped` });
            failures.push(`preset ${controlId}: value ${normalized} not normalized (0..1)`);
            continue;
        }

        const live = liveBindings.get(controlId);
        const mapping = live?.record.valueMapping ?? bindingRecord.valueMapping;
        const nexusValue = mapNormalizedToNexus(mapping, normalized);
        if (nexusValue === undefined) {
            presetRecords.push({ controlId, normalized, ok: false, message: "no numeric mapping — write refused" });
            failures.push(`preset ${controlId}: no numeric mapping — write refused`);
            continue;
        }

        // Final guard: never write an immutable/schema-less target field.
        const blockReason = fieldWriteBlockReason(live?.details);
        if (blockReason || !live) {
            presetRecords.push({ controlId, normalized, nexusValue, ok: false, message: blockReason ?? "target field unavailable" });
            failures.push(`preset ${controlId}: ${blockReason ?? "target field unavailable"}`);
            continue;
        }

        try {
            let updateError: string | undefined;
            await (targetDoc as any).modify((t: any) => {
                const err = t.tryUpdate(live.field, nexusValue);
                if (typeof err === "string" && err) updateError = err;
            });
            if (updateError) {
                presetRecords.push({ controlId, normalized, nexusValue, ok: false, message: `tryUpdate: ${updateError}` });
                failures.push(`preset ${controlId}: tryUpdate: ${updateError}`);
            } else {
                presetRecords.push({ controlId, normalized, nexusValue, ok: true });
            }
        } catch (e) {
            presetRecords.push({ controlId, normalized, nexusValue, ok: false, message: `transaction rejected: ${String((e as any)?.message ?? e)}` });
            failures.push(`preset ${controlId}: transaction rejected: ${String((e as any)?.message ?? e)}`);
        }
    }
    const presetOk = presetRecords.every((r) => r.ok);

    // ── 4. VERIFICATION (independent re-read) ──────────────────────────────
    const bindingVerify: string[] = [];
    let bindingVerifyOk = true;
    for (const record of bindingRecords) {
        if (!record.ok) {
            bindingVerifyOk = false;
            bindingVerify.push(`binding ${record.controlId}: ${record.message ?? "not resolved"}`);
            continue;
        }
        const field = readTargetValue(targetDoc, record.targetEntityId, record.fieldPath);
        bindingVerify.push(`binding ${record.controlId}: target=${record.targetEntityId} path=${record.fieldPath} resolved=${field !== undefined}`);
        if (field === undefined) bindingVerifyOk = false;
    }

    const presetVerifyDetail: string[] = [];
    let presetVerifyOk = true;
    for (const record of presetRecords) {
        if (!record.ok) {
            presetVerifyOk = false;
            presetVerifyDetail.push(`preset ${record.controlId}: ${record.message ?? "not applied"}`);
            continue;
        }
        const bindingRecord = bindingRecords.find((b) => b.controlId === record.controlId);
        if (!bindingRecord?.ok) {
            presetVerifyOk = false;
            presetVerifyDetail.push(`preset ${record.controlId}: no resolved binding`);
            continue;
        }
        const raw = readTargetValue(targetDoc, bindingRecord.targetEntityId, bindingRecord.fieldPath);
        const normalizedRead = mapNexusToNormalized(bindingRecord.valueMapping, raw);
        const equal = valuesEqualFloat32(normalizedRead, record.normalized);
        presetVerifyDetail.push(
            `preset ${record.controlId}: value=${record.normalized} nexus=${String(raw)} readback=${normalizedRead.toFixed(4)} ${equal ? "EQUAL" : "DIFF"}`,
        );
        if (!equal) presetVerifyOk = false;
    }

    const verificationOk = chainVerificationOk && bindingVerifyOk && presetVerifyOk;
    const verification: InstrumentImportVerification = {
        chain: clone.verification!,
        chainVerdict: clone.report.finalVerdict,
        bindings: { ok: bindingVerifyOk, detail: bindingVerify },
        preset: { ok: presetVerifyOk, detail: presetVerifyDetail },
    };

    const ok = chainOk && bindingsOk && presetOk && verificationOk;

    return {
        ok,
        sections: {
            chain: {
                ok: chainOk,
                detail: `chain ${clone.report.finalVerdict}: devices=${(clone.report.sections.entityCreation.detail[0])} params=${clone.verification?.parameters.matched}/${clone.verification?.parameters.expected} connections=${clone.verification?.connections.matched}/${clone.verification?.connections.expected} topology=${clone.verification?.topology.equal ? "equal" : "DIFF"}`,
            },
            bindings: { ok: bindingsOk, detail: `${bindingRecords.filter((b) => b.ok).length}/${bindingRecords.length} bindings resolved` },
            preset: { ok: presetOk, detail: `${presetRecords.filter((r) => r.ok).length}/${presetRecords.length} preset values applied` },
            verification: { ok: verificationOk, detail: `bindings ${bindingVerifyOk ? "PASS" : "FAIL"} · preset ${presetVerifyOk ? "PASS" : "FAIL"}` },
        },
        clone,
        idMap: serializableIdMap,
        bindings: bindingRecords,
        presetValues: presetRecords,
        verification,
        failures,
    };
}