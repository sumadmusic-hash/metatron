/**
 * METATRON LIVE INSTRUMENT IMPORT CAPABILITY TEST — main entry (browser).
 *
 * PHASE D — the decisive question:
 *
 *   Can an `InstrumentPreset v0.1` created from a REAL SOURCE project via the
 *   productive Phase-B exporter be imported into a SECOND real TARGET project
 *   (Phase-C `importInstrumentPreset`) so that chain, current parameter values,
 *   topology and Metatron bindings are correctly resolved onto the NEW target
 *   entities — and independently read back as equal?
 *
 * NO simulation, real OAuth + real `@audiotool/nexus` v0.0.17. The SOURCE is
 * only ever read; the TARGET is mutated ONLY via the
 * [IMPORT INSTRUMENT PRESET] button.
 *
 * Phases:
 *   0  OAuth + open SOURCE/TARGET (read-only)
 *   1  SOURCE DISCOVERY (read-only chain detection)
 *   2  SNAPSHOT + InstrumentPreset EXPORT (Phase B) from the real SOURCE state
 *   3  CAPABILITY GATE (BLOCKED before any mutation when required op is missing)
 *   4  TARGET BEFORE (read-only counts)
 *   5  PLAN display (no mutation)
 *   6  USER CONFIRMATION ([IMPORT INSTRUMENT PRESET])
 *   7  IMPORT via Phase-C engine: clone → idMap → bindings → preset values
 *   8  TARGET RE-DISCOVERY + independent read-back verification
 *   9  FINAL VERDICT report ($20 layout, $15 honesty rules)
 */

import { audiotool, audiotoolPopup } from "@audiotool/nexus";
import type { AudiotoolClient, SyncedDocument } from "@audiotool/nexus";
import { getSchemaLocationDetails } from "@audiotool/nexus/document";
import {
    discoverChainLive,
    listAudioDevicesLive,
    listCablesLive,
    listEntitiesLive,
} from "../chain-discovery/live";
import { normalizeEntityId } from "../chain-discovery/discovery";
import { createSnapshot, serializeSnapshot } from "../chain-clone/snapshot";
import { KNOWN_CREATABLE_TYPES, resolveFieldByPath } from "../chain-clone/clone";
import { idMapUsesNoSourceIds } from "../chain-clone/planning";
import { valuesEqualFloat32 } from "../chain-clone/verify";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { Preset } from "../../src/core/model/Preset";
import { BindingManager } from "../../src/core/BindingManager";
import {
    exportInstrumentPreset,
    type InstrumentPresetBindingSource,
} from "../../src/core/instrument/InstrumentPresetExport";
import {
    fieldWriteBlockReason,
    importInstrumentPreset,
    type InstrumentImportResult,
} from "../../src/core/instrument/InstrumentPresetImport";
import {
    createNexusValueMappingFromSchema,
    mapNexusToNormalized,
    mapNormalizedToNexus,
} from "../../src/nexus/NexusValueMapping";
import type { NexusValueMapping } from "../../src/nexus/NexusValueMapping";
import type { ChainSnapshot, DeviceSnapshot, FieldSnapshot } from "../chain-clone/types";
import type { InstrumentPreset } from "../../src/core/instrument/InstrumentPreset";
import { assessRequiredCapabilities } from "../chain-clone-live/report";
import { buildPhaseDReport, probeSchedule } from "./report";
import type { CapabilityReport, PhaseDProbe, PhaseDReportInput } from "./report";
import { resolveTargetRootId } from "./rootId";

const PREFIX = "[METATRON INSTRUMENT IMPORT LIVE]";
const ERR_PREFIX = "[METATRON INSTRUMENT IMPORT LIVE ERROR]";
const NEXUS_VERSION = "0.0.17";

const CLIENT_ID: string = import.meta.env.VITE_AUDIOTOOL_CLIENT_ID
    ?? "e498c930-864a-4ef0-8d57-b8a176bee096";

let client: AudiotoolClient | null = null;
let sourceDoc: SyncedDocument | null = null;
let targetDoc: SyncedDocument | null = null;

let sourceRoot = "";
let targetRoot: string | undefined;
let discoverBtn: HTMLButtonElement | null = null;

let liveSnapshot: ChainSnapshot | null = null;
let emittedPreset: InstrumentPreset | null = null;
let exportDevice: Device | null = null;
let selection: SelectedControl[] = [];
let sourceIds: string[] = [];
let sourceCounts = { entities: 0, parameters: 0, cables: 0 };
let sourceTopology = "";
let targetBefore = { entities: 0, cables: 0 };
let capabilityReport: CapabilityReport | null = null;
let hasImported = false;

interface SelectedControl {
    controlId: string;
    device: DeviceSnapshot;
    field: FieldSnapshot;
    mapping: NexusValueMapping;
    normalized: number;
    raw: unknown;
}

// ———————————————————————————————————————————————————————————————————————
// tiny DOM helpers
// ———————————————————————————————————————————————————————————————————————

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
}

function preBox(content: string): HTMLPreElement {
    const pre = el("pre");
    pre.style.whiteSpace = "pre-wrap";
    pre.style.fontFamily = "monospace";
    pre.style.fontSize = "12px";
    pre.style.lineHeight = "1.5";
    pre.textContent = content;
    return pre;
}

function section(title: string): HTMLElement {
    const wrap = el("section");
    wrap.appendChild(el("h2", title));
    return wrap;
}

function byId<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) throw new Error(`missing element #${id}`);
    return node as T;
}

function showError(message: string) {
    const area = byId("error-area");
    area.appendChild(preBox(`${ERR_PREFIX}\n${message}`));
    console.error(ERR_PREFIX, message);
}

function status(text: string) {
    byId("status").textContent = text;
}

function deviceLabel(id: string): string {
    const device = liveSnapshot?.devices.find((d) => normalizeEntityId(d.sourceEntityId) === normalizeEntityId(id));
    if (!device) return id.slice(0, 8);
    return `${device.entityType}${device.displayName ? ` / ${device.displayName}` : ""}`;
}

function formatValue(value: unknown): string {
    if (typeof value === "number") return String(value);
    if (typeof value === "boolean") return String(value);
    return JSON.stringify(value);
}

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

function schemaDetailsOf(field: any): any {
    if (!field?.location) return undefined;
    try {
        return getSchemaLocationDetails(field.location);
    } catch {
        return undefined;
    }
}

// ———————————————————————————————————————————————————————————————————————
// OAuth (Phase 0)
// ———————————————————————————————————————————————————————————————————————

async function bootstrap() {
    try {
        const result = await audiotool({
            clientId: CLIENT_ID,
            redirectUrl: `${window.location.origin}${window.location.pathname}`,
            scope: "project:write",
        });
        if (result.status === "authenticated") {
            client = result;
            byId("conn").textContent = `authenticated as ${result.userName}`;
            byId("conn").style.color = "#4caf50";
            console.log(`${PREFIX} authenticated as ${result.userName}`);
        } else {
            byId("conn").textContent = "not authenticated — press CONNECT (popup)";
        }
    } catch (e) {
        byId("conn").textContent = "OAuth bootstrap failed — press CONNECT";
        showError(`OAuth bootstrap: ${String(e)}`);
    }
    refreshGate();
}

async function connectFlow() {
    if (client) {
        const msg = `already authenticated as ${(client as { userName?: string }).userName ?? "user"} — open a project directly`;
        byId("conn").textContent = `authenticated — ${msg}`;
        byId("conn").style.color = "#4caf50";
        status(msg);
        console.log(`${PREFIX} ${msg}`);
        return;
    }
    const origin = window.location.origin;
    const hint =
        `CONNECT opens a popup to accounts.audiotool.com. If nothing appears:\n` +
        `  1. blocker: allow popups for ${origin},\n` +
        `  2. origin check: the accounts page requires ${origin} registered as a redirect origin for client ${CLIENT_ID}\n` +
        `  3. look in the popup for an error message it may show.`;
    try {
        const result = await Promise.race([
            audiotoolPopup({ clientId: CLIENT_ID, scope: "project:write" }),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`popup did not respond within 90s — blocked, or accounts rejected target_origin ${origin}?`)), 90_000),
            ),
        ]);
        if (result.status === "authenticated") {
            client = result;
            byId("conn").textContent = `authenticated as ${result.userName}`;
            byId("conn").style.color = "#4caf50";
            console.log(`${PREFIX} authenticated as ${result.userName}`);
        } else {
            showError(`OAuth: ${result.error?.message ?? "cancelled or failed"} — cannot run the live test\n${hint}`);
        }
    } catch (e) {
        showError(`OAuth popup failed (ENVIRONMENTAL BLOCK candidate): ${String(e)}\n${hint}`);
    }
    status("");
    refreshGate();
}

// ———————————————————————————————————————————————————————————————————————
// Phase 0 — project open
// ———————————————————————————————————————————————————————————————————————

async function openSource() {
    const url = byId<HTMLInputElement>("source-url").value.trim();
    if (!client) return showError("not authenticated — CONNECT first");
    if (!url) return showError("enter the SOURCE project URL");
    try {
        sourceDoc = await client.open(url);
        await sourceDoc.start();
        byId("source-detail").textContent = `READ-ONLY source open & syncing: ${url}`;
        renderSourceDevices();
        console.log(`${PREFIX} source open (read-only)`);
    } catch (e) {
        showError(`openSource failed: ${String(e)}`);
    }
    refreshGate();
}

async function openTarget() {
    const url = byId<HTMLInputElement>("target-url").value.trim();
    if (!client) return showError("not authenticated — CONNECT first");
    if (!url) return showError("enter the TARGET project URL");
    try {
        targetDoc = await client.open(url);
        await targetDoc.start();
        byId("target-detail").textContent = `writable target open & syncing: ${url}`;
        targetBefore = {
            entities: listEntitiesLive(targetDoc).length,
            cables: listCablesLive(targetDoc).length,
        };
        byId("target-before").replaceChildren(
            preBox(`TARGET BEFORE\n\nEntities: ${targetBefore.entities}\nCables: ${targetBefore.cables}`),
        );
        console.log(`${PREFIX} target open — before: entities=${targetBefore.entities} cables=${targetBefore.cables}`);
    } catch (e) {
        showError(`openTarget failed: ${String(e)}`);
    }
    refreshGate();
}

function renderSourceDevices() {
    if (!sourceDoc) return;
    const target = byId("source-devices");
    target.replaceChildren();
    const devices = listAudioDevicesLive(sourceDoc);
    if (devices.length === 0) {
        target.appendChild(preBox("no audio-socket entities found on SOURCE"));
        return;
    }
    const list = el("ul");
    list.style.listStyle = "none";
    list.style.padding = "0";
    for (const d of devices) {
        const item = el("li");
        item.style.margin = "4px 0";
        const btn = el("button", "[Select]");
        btn.className = "btn";
        btn.addEventListener("click", () => {
            byId<HTMLInputElement>("root-device").value = d.id;
            status(`root device selected: ${d.entityType} · ${d.displayName || "(no name)"}`);
        });
        item.appendChild(btn);
        item.appendChild(document.createTextNode(` ${d.entityType} · ${d.displayName || "(no name)"} · ${d.id}`));
        list.appendChild(item);
    }
    target.appendChild(list);
    console.log(`${PREFIX} AVAILABLE AUDIO DEVICES: ${devices.length}`);
}

// ———————————————————————————————————————————————————————————————————————
// Phase 1 + 2 — SOURCE DISCOVERY + SNAPSHOT + EXPORT (Phase B)
// ———————————————————————————————————————————————————————————————————————

/** Pick a representative, real-field control set: one float linear field, one
 *  integer linear field, one boolean field, plus a second float linear field
 *  on a DIFFERENT chain device (proves cross-device binding + idMap). Nothing
 *  is fabricated — every pick is a real automatable snapshot field. */
function selectControls(snapshot: ChainSnapshot): SelectedControl[] {
    const first = { linear: null as null | { d: DeviceSnapshot; f: FieldSnapshot; m: NexusValueMapping }, integer: null as null | { d: DeviceSnapshot; f: FieldSnapshot; m: NexusValueMapping }, boolean: null as null | { d: DeviceSnapshot; f: FieldSnapshot; m: NexusValueMapping } };

    for (const d of snapshot.devices) {
        for (const f of d.fields) {
            const m = createNexusValueMappingFromSchema(
                f.range,
                typeof f.scalarType === "number" ? f.scalarType : undefined,
                f.primitiveType,
            );
            if (m.kind === "unsupported") continue;
            if (m.kind === "boolean") {
                if (!first.boolean) first.boolean = { d, f, m };
            } else if (m.isInteger) {
                if (!first.integer) first.integer = { d, f, m };
            } else if (!first.linear) {
                first.linear = { d, f, m };
            }
        }
    }

    const cross: { d: DeviceSnapshot; f: FieldSnapshot; m: NexusValueMapping } | null = (() => {
        if (!first.linear) return null;
        for (const d of snapshot.devices) {
            if (normalizeEntityId(d.sourceEntityId) === normalizeEntityId(first.linear.d.sourceEntityId)) continue;
            for (const f of d.fields) {
                const m = createNexusValueMappingFromSchema(
                    f.range,
                    typeof f.scalarType === "number" ? f.scalarType : undefined,
                    f.primitiveType,
                );
                if (m.kind === "linear" && !m.isInteger) return { d, f, m };
            }
        }
        return null;
    })();

    const picks = [first.linear, first.integer, first.boolean, cross].filter(
        (p): p is { d: DeviceSnapshot; f: FieldSnapshot; m: NexusValueMapping } => p !== null,
    );
    return picks.map((p) => ({
        controlId: "",
        device: p.d,
        field: p.f,
        mapping: p.m,
        normalized: mapNexusToNormalized(p.m, p.f.value),
        raw: p.f.value,
    }));
}

function discover() {
    if (!sourceDoc) return showError("open the SOURCE project first");
    const root = byId<HTMLInputElement>("root-device").value.trim();
    if (!root) return showError("enter the SOURCE root device entity id (Phase 1+2)");
    sourceRoot = root;
    const out = byId("discover-out");
    out.replaceChildren();
    try {
        const { result } = discoverChainLive(sourceDoc, root, 32);
        liveSnapshot = createSnapshot(sourceDoc, root, 32);

        const deviceRows = result.order
            .map((id, i) => `#${i} ${deviceLabel(id)}`)
            .join("\n");
        const topology = result.chain.map((m) => `#${m.position} ${deviceLabel(m.node.id)}`).join(" → ");
        sourceTopology = result.order.map((id) => deviceLabel(id)).join(" → ");

        sourceCounts = {
            entities: listEntitiesLive(sourceDoc).length,
            parameters: liveSnapshot.devices.reduce((n, d) => n + d.fields.length, 0),
            cables: liveSnapshot.connections.length,
        };
        sourceIds = liveSnapshot.devices.map((d) => d.sourceEntityId);

        const lines = [
            "SOURCE CHAIN",
            "",
            `Entities: ${sourceCounts.entities}`,
            `Parameters (automatable): ${sourceCounts.parameters}`,
            `Cables: ${sourceCounts.cables}`,
            "",
            deviceRows,
            "",
            "Topology:",
            topology,
            "",
            "SNAPSHOT (serialized):",
            serializeSnapshot(liveSnapshot),
        ];
        out.appendChild(preBox(lines.join("\n")));

        // SELECT controls from REAL source fields → Device/Preset → Phase B export.
        selection = selectControls(liveSnapshot);
        if (selection.length === 0) {
            out.appendChild(preBox("BLOCKED: no automatable number/boolean field found on the SOURCE chain — cannot build a representative preset from real data."));
            capabilityReport = { rows: [], blockedReason: "no automatable numeric/boolean field on the SOURCE chain" };
            renderCapabilityReport();
            refreshGate();
            return;
        }
        const device = new Device("Live Instrument Import Test");
        for (const item of selection) {
            const control = new Control("knob", `${item.device.entityType} · ${item.field.path}`);
            device.addControl(control);
            item.controlId = control.id;
        }
        const preset = new Preset("InstrumentPreset v0.1 — live SOURCE state", device.id);
        for (const item of selection) preset.controlValues[item.controlId] = item.normalized;
        exportDevice = device;

        const bindings: InstrumentPresetBindingSource[] = selection.map((item) => ({
            controlId: item.controlId,
            sourceEntityId: item.device.sourceEntityId,
            fieldPath: item.field.path,
        }));

        const exported = exportInstrumentPreset({ device, preset, snapshot: liveSnapshot, bindings });
        if (!exported.ok) {
            const detail = exported.errors.join("\n    - ");
            out.appendChild(preBox(`PHASE B EXPORT REFUSED REAL SOURCE DATA (capability block — NO mutation):\n    - ${detail}`));
            capabilityReport = { rows: [], blockedReason: `Phase B export failed on the real SOURCE: ${exported.errors[0] ?? "unknown"}` };
            renderCapabilityReport();
            refreshGate();
            return;
        }
        emittedPreset = exported.preset;
        capabilityReport = assessCapabilities();

        out.appendChild(preBox(renderEnvelopeText()));
        out.appendChild(renderCapabilityReport());
        renderPlan();
        console.log(
            `${PREFIX} discovered+exported: entities=${sourceCounts.entities} params=${sourceCounts.parameters} cables=${sourceCounts.cables} controls=${selection.length}`,
        );
    } catch (e) {
        showError(`discover failed: ${String(e)}`);
    }
    refreshGate();
}

// ———————————————————————————————————————————————————————————————————————
// Phase 3 — CAPABILITY GATE
// ———————————————————————————————————————————————————————————————————————

function assessCapabilities(): CapabilityReport {
    if (!liveSnapshot) return { rows: [], blockedReason: "no snapshot" };
    return assessRequiredCapabilities(liveSnapshot, KNOWN_CREATABLE_TYPES);
}

function renderCapabilityReport(): HTMLPreElement {
    const report = capabilityReport;
    const lines = [
        "CAPABILITY REPORT",
        "",
        ...(report?.rows ?? []).map((r) => `${r.operation.padEnd(24)} ${r.verdict}`),
        ...(report?.rows ?? []).map((r) => `  proof: ${r.proof}`),
        "",
        report?.blockedReason ? `RESULT: BLOCKED — ${report.blockedReason}` : "RESULT: all required operations available — import may proceed after confirmation",
    ];
    const pre = preBox(lines.join("\n"));
    byId("capabilities-out").replaceChildren(pre);
    return pre;
}

function renderEnvelopeText(): string {
    const preset = emittedPreset;
    if (!preset) return "INSTRUMENT PRESET: (none)";
    const lines = [
        "INSTRUMENT PRESET v0.1 (exported from REAL SOURCE via Phase B)",
        "",
        `version:        ${preset.version}`,
        `name:           ${preset.name}`,
        `controls:       ${Object.keys(preset.metatron.controlValues).length}`,
        `bindings:       ${preset.bindings.length}`,
        `preset values:  ${Object.keys(preset.metatron.controlValues).length}`,
        "",
        "CONTROLS (real source values, normalized via the field schema):",
    ];
    for (const item of selection) {
        const map = item.mapping.kind === "linear"
            ? `linear [${item.mapping.min}..${item.mapping.max}]${item.mapping.isInteger ? " int" : ""}`
            : item.mapping.kind;
        lines.push(
            `  ${item.controlId}  ${map.padEnd(28)} normalized=${item.normalized.toFixed(4)}  sourceRaw=${formatValue(item.raw)}  ${item.device.entityType}.${item.field.path}`,
        );
    }
    lines.push("");
    lines.push("BINDINGS → snapshot.devices[sourceEntityIndex].fieldPath:");
    for (const b of preset.bindings) {
        const device = preset.chain.snapshot.devices[b.sourceEntityIndex];
        lines.push(`  ${b.controlId} → index ${b.sourceEntityIndex} [${device.entityType}] ${b.fieldPath}`);
    }
    return lines.join("\n");
}

// ———————————————————————————————————————————————————————————————————————
// Phase 5 — PLAN (display only, no mutation)
// ———————————————————————————————————————————————————————————————————————

function renderPlan() {
    if (!liveSnapshot || !emittedPreset) return;
    const out = byId("plan-out");
    const create = liveSnapshot.devices.map((d) => `  ${d.entityType}${d.displayName ? ` (${d.displayName})` : ""}`);
    const params = liveSnapshot.devices.flatMap((d) =>
        d.fields.map((f) => `  ${d.entityType}.${f.path} = ${formatValue(f.value)}`),
    );
    const conns = liveSnapshot.connections.map((c) => `  ${deviceLabel(c.fromEntityId)} → ${deviceLabel(c.toEntityId)}`);
    const lines = [
        "INSTRUMENT IMPORT PLAN",
        "",
        "Clone (create):",
        ...(create.length ? create : ["  (none)"]),
        "",
        "Restore parameters:",
        ...(params.length ? params : ["  (none)"]),
        "",
        "Create connections:",
        ...(conns.length ? conns : ["  (none)"]),
        "",
        "Set Metatron bindings (controlId → targetEntityId → fieldPath):",
        ...selection.map((s) => `  ${s.controlId} → ${s.device.entityType}.${s.field.path} (${s.mapping.kind})`),
        "",
        "Apply preset values (normalized → NexusValueMapping → target field).",
        "",
        "This plan performs no mutation. The real target schema (ranges,",
        "immutability) is applied at execution time by the Phase-C engine.",
    ];
    out.replaceChildren(preBox(lines.join("\n")));
}

// ———————————————————————————————————————————————————————————————————————
// Phase 8 — MAPPING PROBES (§9 — real target writes, restored afterwards)
// ———————————————————————————————————————————————————————————————————————

async function writeField(targetDoc: SyncedDocument, field: any, value: number | boolean): Promise<string | undefined> {
    let error: string | undefined;
    try {
        await (targetDoc as any).modify((t: any) => {
            const err = t.tryUpdate(field, value);
            if (typeof err === "string" && err) error = err;
        });
    } catch (e) {
        error = String((e as any)?.message ?? e);
    }
    return error;
}

async function runMappingProbes(
    targetDoc: SyncedDocument,
    result: InstrumentImportResult,
    preset: InstrumentPreset,
): Promise<PhaseDProbe[]> {
    const probes: PhaseDProbe[] = [];
    for (const rec of result.bindings) {
        const kind = rec.valueMapping?.kind ?? "unknown";
        if (!rec.ok) {
            probes.push({ controlId: rec.controlId, kind, pass: false, detail: rec.message ?? "binding not resolved" });
            continue;
        }
        const schedule = probeSchedule(rec.valueMapping);
        if (schedule.length === 0) {
            probes.push({ controlId: rec.controlId, kind, pass: true, detail: "no probeable mapping (unsupported)" });
            continue;
        }
        const entity = (targetDoc.queryEntities as any).getEntity(rec.targetEntityId);
        const field = entity ? resolveFieldByPath(entity.fields, rec.fieldPath) : undefined;
        if (!field?.location) {
            probes.push({ controlId: rec.controlId, kind, pass: false, detail: `target field ${rec.targetEntityId}.${rec.fieldPath} unresolvable` });
            continue;
        }
        const block = fieldWriteBlockReason(schemaDetailsOf(field));
        if (block) {
            probes.push({ controlId: rec.controlId, kind, pass: false, detail: block });
            continue;
        }

        const presetValue = preset.metatron.controlValues[rec.controlId];
        let ok = true;
        const steps: string[] = [];
        for (const n of schedule) {
            const raw = mapNormalizedToNexus(rec.valueMapping, n);
            if (raw === undefined) {
                steps.push(`n=${n}: no mapped value — write refused`);
                ok = false;
                continue;
            }
            const writeErr = await writeField(targetDoc, field, raw);
            if (writeErr) {
                steps.push(`n=${n}: write refused: ${writeErr}`);
                ok = false;
                continue;
            }
            const readRaw = readTargetValue(targetDoc, rec.targetEntityId, rec.fieldPath);
            const readNorm = mapNexusToNormalized(rec.valueMapping, readRaw);
            const pass = valuesEqualFloat32(readNorm, n);
            steps.push(`n=${n} → raw=${String(readRaw)} → readback=${readNorm} ${pass ? "EQUAL" : "DIFF"}`);
            if (!pass) ok = false;
        }

        // restore the applied preset value so the target is left as imported
        const restoreRaw = mapNormalizedToNexus(rec.valueMapping, presetValue);
        if (restoreRaw === undefined) {
            steps.push(`restore: no mapped value for preset ${presetValue}`);
            ok = false;
        } else {
            const restoreErr = await writeField(targetDoc, field, restoreRaw);
            if (restoreErr) {
                steps.push(`restore failed: ${restoreErr}`);
                ok = false;
            } else {
                const restoreNorm = mapNexusToNormalized(rec.valueMapping, readTargetValue(targetDoc, rec.targetEntityId, rec.fieldPath));
                if (!valuesEqualFloat32(restoreNorm, presetValue)) {
                    steps.push(`restore readback ${restoreNorm.toFixed(4)} != preset ${presetValue.toFixed(4)}`);
                    ok = false;
                } else {
                    steps.push(`restored preset ${presetValue.toFixed(4)} → readback ${restoreNorm.toFixed(4)} EQUAL`);
                }
            }
        }

        probes.push({ controlId: rec.controlId, kind, pass: ok, detail: steps.join(" | ") });
    }
    return probes;
}

// ———————————————————————————————————————————————————————————————————————
// Phase 6/7/8/9 — IMPORT, RE-DISCOVERY, VERIFICATION, REPORT
// ———————————————————————————————————————————————————————————————————————

function refreshGate() {
    const btn = byId<HTMLButtonElement>("import-btn");
    const detail = byId("import-gate");
    const ready = Boolean(
        client && sourceDoc && targetDoc && liveSnapshot && emittedPreset && capabilityReport && !capabilityReport.blockedReason,
    );
    btn.disabled = hasImported || !ready;
    if (discoverBtn) discoverBtn.disabled = hasImported;
    const reason = capabilityReport?.blockedReason;
    if (reason) {
        detail.textContent = `BLOCKED before mutation: ${reason}`;
        detail.style.color = "#f44336";
    } else if (ready) {
        detail.textContent = "IMPORT INSTRUMENT PRESET will MUTATE the TARGET project (clone + parameter writes + cables + bindings + preset values + mapping probes, restored). SOURCE stays read-only.";
        detail.style.color = "#ff9800";
    } else {
        detail.textContent = "";
    }
}

function collectFailures(result: InstrumentImportResult): string[] {
    const failures: string[] = [];
    // chain failures are already grouped; re-emit as concrete per-step records (§16)
    for (const f of result.clone.failures) {
        failures.push(`chain.${f.step} entity=${f.sourceId ?? ""} fieldPath=${f.path ?? "-"} error=${f.message}`);
    }
    for (const b of result.bindings) {
        if (!b.ok) {
            failures.push(`binding.${b.controlId} entity index=${b.sourceEntityIndex} fieldPath=${b.fieldPath} error=${b.message ?? "unresolvable"}`);
        }
    }
    for (const p of result.presetValues) {
        if (!p.ok) {
            failures.push(`preset.${p.controlId} expected=${String(p.normalized)} actual=${String(p.nexusValue)} error=${p.message ?? "not applied"}`);
        }
    }
    for (const f of result.failures) {
        if (!failures.includes(f)) failures.push(f);
    }
    return failures;
}

function reportInput(
    result: InstrumentImportResult,
    extras: Partial<PhaseDReportInput>,
): PhaseDReportInput {
    const snapshot = liveSnapshot!;
    const chain = result.verification.chain;
    const paramFailures = result.clone.failures.filter((f) => f.step === "parameter").length;
    const connFailures = result.clone.failures.filter((f) => f.step === "connection").length;
    const parameterTotal = snapshot.devices.reduce((n, d) => n + d.fields.length, 0);
    const mappings = Object.entries(result.idMap);

    const targetAfter = {
        entities: targetDoc ? listEntitiesLive(targetDoc).length : 0,
        cables: targetDoc ? listCablesLive(targetDoc).length : 0,
    };

    return {
        environment: {
            oauth: client ? `authenticated as ${(client as { userName?: string }).userName ?? "user"}` : "not authenticated",
            nexusVersion: NEXUS_VERSION,
            sourceUrl: byId<HTMLInputElement>("source-url").value.trim() || "(none)",
            targetUrl: byId<HTMLInputElement>("target-url").value.trim() || "(none)",
        },
        source: {
            devices: sourceCounts.entities,
            parameters: sourceCounts.parameters,
            cables: sourceCounts.cables,
            topology: sourceTopology,
        },
        preset: {
            version: emittedPreset?.version ?? "0.1",
            controls: emittedPreset ? Object.keys(emittedPreset.metatron.controlValues).length : 0,
            bindings: emittedPreset?.bindings.length ?? 0,
            presetValues: emittedPreset ? Object.keys(emittedPreset.metatron.controlValues).length : 0,
        },
        capability: capabilityReport ?? { rows: [], blockedReason: "capability gate not run" },
        targetBefore,
        targetAfter,
        importResult: {
            entitiesCreated: result.clone.idMap.size,
            parameterWrites: parameterTotal - paramFailures,
            cablesCreated: snapshot.connections.length - connFailures,
            bindingsOk: result.bindings.filter((b) => b.ok).length,
            bindingsTotal: result.bindings.length,
            presetValuesOk: result.presetValues.filter((p) => p.ok).length,
            presetValuesTotal: result.presetValues.length,
        },
        idMapping: {
            sourceIdsReused: !idMapUsesNoSourceIds(result.clone.idMap, sourceIds),
            mappings,
        },
        verification: {
            chain: `PASS or DIFF: devices ${chain.devices.matched}/${chain.devices.expected} parameters ${chain.parameters.matched}/${chain.parameters.expected} connections ${chain.connections.matched}/${chain.connections.expected}`,
            topology: chain.topology.equal ? "PASS — source→target topology identical (ids differ)" : `DIFF — target order ${JSON.stringify(chain.topology.targetOrder)}`,
            bindings: `${result.verification.bindings.ok ? "PASS" : "FAIL"} — ${result.verification.bindings.detail.join("; ") || "no bindings"}`,
            presetValues: `${result.verification.preset.ok ? "PASS" : "FAIL"} — ${result.verification.preset.detail.join("; ") || "no values"}`,
        },
        checks: {
            chain: result.sections.chain.ok,
            topology: chain.topology.equal === true,
            bindings: result.verification.bindings.ok,
            presetValues: result.verification.preset.ok,
        },
        failures: collectFailures(result),
        probes: [],
        engineFinalVerdict: result.clone.report.finalVerdict,
        engineOk: result.ok,
        mutationExecuted: true,
        ...extras,
    };
}

async function doImport() {
    if (!sourceDoc || !targetDoc) return showError("open SOURCE and TARGET first");
    if (!liveSnapshot) return showError("DISCOVER the SOURCE chain first (Phase 1+2)");
    if (!emittedPreset || !exportDevice) return showError("EXPORT the preset first (Phase 2)");
    if (!capabilityReport || capabilityReport.blockedReason) {
        return showError(`import blocked by capability gate: ${capabilityReport?.blockedReason ?? "no capability report"}`);
    }

    const out = byId("import-out");
    out.replaceChildren();
    const btn = byId<HTMLButtonElement>("import-btn");
    btn.disabled = true;
    hasImported = true;
    status("IMPORT INSTRUMENT PRESET — mutating the TARGET project…");
    try {
        const result = await importInstrumentPreset(emittedPreset, targetDoc, new BindingManager(exportDevice), { maxDepth: 32 });
        targetRoot = resolveTargetRootId(liveSnapshot.rootCandidates?.[0] ?? undefined, result.idMap);

        const probes = await runMappingProbes(targetDoc, result, emittedPreset);
        const input = reportInput(result, { probes });
        const report = buildPhaseDReport(input);
        out.appendChild(renderResult(report));
        out.appendChild(renderIdMap(result, targetRoot));
        status(`imported — final: ${report.verdict}`);
        console.log(`${PREFIX} RESULT ${report.verdict}`);
    } catch (e) {
        out.appendChild(
            renderResult(
                buildPhaseDReport(
                    reportInput(emptyResult(), {
                        probes: [],
                        environmentBlock: `importInstrumentPreset threw before returning a result (partial mutations are possible, NOT verified): ${String((e as any)?.message ?? e)}`,
                    }),
                ),
            ),
        );
        status("import threw — see report");
    } finally {
        refreshGate();
    }
}

/** Fallback empty result for the thrown-before-result case (§15 BLOCKED (ENVIRONMENT)). */
function emptyResult(): InstrumentImportResult {
    return {
        ok: false,
        sections: {
            chain: { ok: false, detail: "not run" },
            bindings: { ok: false, detail: "not run" },
            preset: { ok: false, detail: "not run" },
            verification: { ok: false, detail: "not run" },
        },
        clone: {
            snapshot: liveSnapshot!,
            idMap: new Map(),
            failures: [],
            report: {
                sections: {
                    entityCreation: { verdict: "FAIL", detail: ["not run"] },
                    parameterRestore: { verdict: "FAIL", detail: ["not run"] },
                    currentValues: { verdict: "FAIL", detail: ["not run"] },
                    connectionCreation: { verdict: "FAIL", detail: ["not run"] },
                    topologyRestore: { verdict: "FAIL", detail: ["not run"] },
                    verification: { verdict: "FAIL", detail: ["not run"] },
                },
                supportedEntityTypes: [],
                unsupportedEntityTypes: [],
                nexusApiLimitations: [],
                finalVerdict: "CHAIN CLONE: PARTIAL",
            },
            verification: undefined,
        },
        idMap: {},
        bindings: [],
        presetValues: [],
        verification: {
            chain: {
                devices: { expected: 0, actual: 0, matched: false },
                parameters: { expected: 0, actual: 0, matched: 0, equal: false },
                connections: { expected: 0, actual: 0, matched: 0, equal: false },
                topology: { sourceOrder: [], targetOrder: [], equal: false },
                diffs: ["not run"],
                ok: false,
            },
            chainVerdict: "CHAIN CLONE: PARTIAL",
            bindings: { ok: false, detail: ["not run"] },
            preset: { ok: false, detail: ["not run"] },
        },
        failures: ["import threw before returning a result"],
    };
}

function renderResult(report: { text: string; verdict: string; blockDetail?: string }): HTMLElement {
    const box = el("div");
    const title = el("h3", "VERIFICATION REPORT");
    const verdictClass =
        report.verdict === "INSTRUMENT IMPORT: PASS"
            ? "verdict-pass"
            : report.verdict === "INSTRUMENT IMPORT: PARTIAL"
              ? "verdict-partial"
              : "verdict-fail";
    const verdict = el("p", report.verdict);
    verdict.className = verdictClass;
    box.appendChild(title);
    box.appendChild(preBox(report.text));
    box.appendChild(verdict);
    return box;
}

function renderIdMap(result: InstrumentImportResult, targetRootFromIdMap: string | undefined): HTMLElement {
    const box = el("div");
    box.appendChild(el("h3", "SOURCE → TARGET ID MAP (logical identity preserved, ids differ)"));
    box.appendChild(
        preBox(
            [
                "",
                `SOURCE ROOT: ${sourceRoot || "(not selected)"}`,
                `TARGET ROOT: ${targetRootFromIdMap ?? "(unresolved — no valid source→target mapping)"}`,
                "",
                ...Object.entries(result.idMap).map(([s, t]) => `${s}\n  ↓ ${t}`),
            ].join("\n"),
        ),
    );
    return box;
}

// ———————————————————————————————————————————————————————————————————————
// UI construction
// ———————————————————————————————————————————————————————————————————————

function bootstrapUI() {
    const root = byId("app");
    root.appendChild(el("h1", "METATRON LIVE INSTRUMENT IMPORT CAPABILITY TEST"));
    const hint = el("p", "SOURCE project is read-only. TARGET is mutated ONLY when [IMPORT INSTRUMENT PRESET] is pressed.");
    hint.style.color = "#aaa";
    root.appendChild(hint);

    const connSpan = el("span", "Disconnected");
    connSpan.id = "conn";
    root.appendChild(connSpan);
    const connectBtn = el("button", "CONNECT");
    connectBtn.className = "btn";
    connectBtn.addEventListener("click", () => void connectFlow());
    root.appendChild(connectBtn);

    // Phase 0/1 — SOURCE
    const sourceSec = section("PHASE 0/1 — SOURCE PROJECT (READ-ONLY)");
    const srcInput = el("input");
    srcInput.id = "source-url";
    srcInput.type = "text";
    srcInput.placeholder = "https://beta.audiotool.com/studio?project=…  or  projects/…";
    srcInput.style.width = "100%";
    const openSrcBtn = el("button", "OPEN SOURCE");
    openSrcBtn.className = "btn";
    openSrcBtn.addEventListener("click", () => void openSource());
    const srcDetail = el("p", "");
    srcDetail.id = "source-detail";
    srcDetail.className = "dim";
    const srcDevices = el("div");
    srcDevices.id = "source-devices";
    sourceSec.appendChild(srcInput);
    sourceSec.appendChild(openSrcBtn);
    sourceSec.appendChild(srcDetail);
    sourceSec.appendChild(srcDevices);

    const rootInput = el("input");
    rootInput.id = "root-device";
    rootInput.type = "text";
    rootInput.placeholder = "root device entity id";
    rootInput.style.width = "100%";
    discoverBtn = el("button", "DISCOVER + EXPORT PRESET (PHASES 1+2+3)");
    discoverBtn.className = "btn";
    discoverBtn.disabled = hasImported;
    discoverBtn.addEventListener("click", discover);
    sourceSec.appendChild(rootInput);
    sourceSec.appendChild(discoverBtn);
    const discoverOut = el("div");
    discoverOut.id = "discover-out";
    sourceSec.appendChild(discoverOut);

    // Phase 3 — capabilities
    const capSec = section("PHASE 3 — NEXUS CAPABILITY REPORT");
    const capOut = el("div");
    capOut.id = "capabilities-out";
    capSec.appendChild(capOut);

    // Phase 4 — TARGET
    const targetSec = section("PHASE 4 — TARGET PROJECT (IMPORT PAYLOAD)");
    const tgInput = el("input");
    tgInput.id = "target-url";
    tgInput.type = "text";
    tgInput.placeholder = "https://beta.audiotool.com/studio?project=…  or  projects/…";
    tgInput.style.width = "100%";
    const openTgBtn = el("button", "OPEN TARGET");
    openTgBtn.className = "btn";
    openTgBtn.addEventListener("click", () => void openTarget());
    const tgDetail = el("p", "");
    tgDetail.id = "target-detail";
    tgDetail.className = "dim";
    const targetBefore = el("div");
    targetBefore.id = "target-before";
    targetSec.appendChild(tgInput);
    targetSec.appendChild(openTgBtn);
    targetSec.appendChild(tgDetail);
    targetSec.appendChild(targetBefore);

    // Phase 5 — plan
    const planSec = section("PHASE 5 — IMPORT PLAN (display only, no mutation)");
    const planOut = el("div");
    planOut.id = "plan-out";
    planSec.appendChild(planOut);

    // Phase 6/7/8/9 — import
    const importSec = section("PHASE 6 — USER CONFIRMATION");
    const importBtn = el("button", "IMPORT INSTRUMENT PRESET");
    importBtn.id = "import-btn";
    importBtn.className = "btn btn-danger";
    importBtn.disabled = true;
    importBtn.addEventListener("click", () => void doImport());
    const statusEl = el("p", "");
    statusEl.id = "status";
    const gateEl = el("p", "");
    gateEl.id = "import-gate";
    const importOut = el("div");
    importOut.id = "import-out";
    importSec.appendChild(importBtn);
    importSec.appendChild(statusEl);
    importSec.appendChild(gateEl);
    importSec.appendChild(importOut);

    const errorArea = el("div");
    errorArea.id = "error-area";

    root.appendChild(sourceSec);
    root.appendChild(capSec);
    root.appendChild(targetSec);
    root.appendChild(planSec);
    root.appendChild(importSec);
    root.appendChild(errorArea);

    const style = el("style");
    style.textContent = [
        ".verdict-pass { color: #4caf50; font-weight: bold; }",
        ".verdict-partial { color: #ff9800; font-weight: bold; }",
        ".verdict-fail { color: #f44336; font-weight: bold; }",
    ].join("\n");
    root.appendChild(style);
}

bootstrapUI();
void bootstrap();