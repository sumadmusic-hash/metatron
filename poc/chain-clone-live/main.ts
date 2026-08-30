/**
 * METATRON LIVE CHAIN CLONE CAPABILITY TEST — main entry (browser).
 *
 * Nine phases against REAL projects with REAL OAuth and REAL @audiotool/nexus
 * v0.0.17. NO simulation. The SOURCE project is only ever read; the TARGET is
 * mutated ONLY when the user presses CLONE CHAIN.
 *
 * Phases:
 *   1 SOURCE DISCOVERY (read-only chain detection)
 *   2 SNAPSHOT (serializable §3 capture)
 *   3 CAPABILITY REPORT (gate: BLOCKED before any mutation when required op missing)
 *   4 TARGET BEFORE (read-only counts)
 *   5 CLONE PLAN (display only — no mutation)
 *   6 USER CONFIRMATION (CLONE CHAIN click)
 *   7 CLONE (create → parameters → cables)
 *   8 POST-CLONE DISCOVERY (re-read target, compare logical structure)
 *   9 VERIFICATION REPORT (PASS / PARTIAL / BLOCKED)
 */

import { audiotool, audiotoolPopup } from "@audiotool/nexus";
import type { AudiotoolClient, SyncedDocument } from "@audiotool/nexus";
import { discoverChainLive, listAudioDevicesLive, listCablesLive, listEntitiesLive, listParametersLive } from "../chain-discovery/live";
import { normalizeEntityId } from "../chain-discovery/discovery";
import { createSnapshot, serializeSnapshot } from "../chain-clone/snapshot";
import { cloneChainFromSnapshot, KNOWN_CREATABLE_TYPES } from "../chain-clone/clone";
import { CAPABILITY_TABLE } from "../chain-clone/api-capabilities";
import type { ChainSnapshot } from "../chain-clone/types";
import { assessRequiredCapabilities, buildLiveReport } from "./report";
import type { CapabilityReport, LiveCounts, LiveTestReport } from "./report";

const PREFIX = "[METATRON CHAIN CLONE LIVE]";
const ERR_PREFIX = "[METATRON CHAIN CLONE LIVE ERROR]";

const CLIENT_ID: string = import.meta.env.VITE_AUDIOTOOL_CLIENT_ID
    ?? "e498c930-864a-4ef0-8d57-b8a176bee096";

let client: AudiotoolClient | null = null;
let sourceDoc: SyncedDocument | null = null;
let targetDoc: SyncedDocument | null = null;
let liveSnapshot: ChainSnapshot | null = null;
let sourceCounts: LiveCounts = { entities: 0, parameters: 0, cables: 0 };
let targetBefore: { entities: number; cables: number } = { entities: 0, cables: 0 };
let capabilityReport: CapabilityReport | null = null;

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

/** Fill the root-device input from a real device on the SOURCE (no UUID typing). */
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

function refreshCloneGate() {
    const btn = byId<HTMLButtonElement>("clone-btn");
    const detail = byId("clone-gate");
    btn.disabled = !(client && sourceDoc && targetDoc && liveSnapshot && capabilityReport && !capabilityReport.blockedReason);
    const reason = capabilityReport?.blockedReason;
    if (reason) {
        detail.textContent = `BLOCKED before mutation: ${reason}`;
        detail.style.color = "#f44336";
    } else if (liveSnapshot && targetDoc) {
        detail.textContent = "CLONE CHAIN will MUTATE the TARGET project. SOURCE stays read-only.";
        detail.style.color = "#ff9800";
    } else {
        detail.textContent = "";
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
    refreshCloneGate();
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
    console.log(`${PREFIX} ${hint.replaceAll("\n", " ")}`);
    status(`OAuth popup — target_origin=${origin}`);
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
    refreshCloneGate();
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
    refreshCloneGate();
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
    refreshCloneGate();
}

// ———————————————————————————————————————————————————————————————————————
// Phase 1 + 2 — SOURCE DISCOVERY + SNAPSHOT
// ———————————————————————————————————————————————————————————————————————

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

function discover() {
    if (!sourceDoc) return showError("open the SOURCE project first");
    const root = byId<HTMLInputElement>("root-device").value.trim();
    if (!root) return showError("enter the root device entity id");
    const out = byId("discover-out");
    out.replaceChildren();
    try {
        const { result } = discoverChainLive(sourceDoc, root, 32);
        liveSnapshot = createSnapshot(sourceDoc, root, 32);

        const deviceRows = result.order
            .map((id, i) => `#${i} ${deviceLabel(id)}`)
            .join("\n");
        const topology = result.chain.map((m) => `#${m.position} ${deviceLabel(m.node.id)}`).join(" → ");

        sourceCounts = {
            entities: listEntitiesLive(sourceDoc).length,
            parameters: liveSnapshot.devices.reduce((n, d) => n + d.fields.length, 0),
            cables: liveSnapshot.connections.length,
        };

        const lines = [
            "SOURCE CHAIN",
            "",
            `Entities: ${sourceCounts.entities}`,
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
        renderCapabilities();

        // Phase 3 gate — no mutation has happened yet.
        capabilityReport = assessRequiredCapabilities(liveSnapshot, KNOWN_CREATABLE_TYPES);
        out.appendChild(renderCapabilityReport(capabilityReport));
        renderPlan();
        console.log(`${PREFIX} discovered: entities=${sourceCounts.entities} params=${sourceCounts.parameters} cables=${sourceCounts.cables}`);
    } catch (e) {
        showError(`discover failed: ${String(e)}`);
    }
    refreshCloneGate();
}

// ———————————————————————————————————————————————————————————————————————
// Phase 3 — CAPABILITY REPORT
// ———————————————————————————————————————————————————————————————————————

function renderCapabilityReport(report: CapabilityReport): HTMLPreElement {
    const lines = [
        "CAPABILITY REPORT",
        "",
        ...report.rows.map((r) => `${r.operation.padEnd(24)} ${r.verdict}`),
        ...report.rows.map((r) => `  proof: ${r.proof}`),
        "",
        report.blockedReason ? `RESULT: BLOCKED — ${report.blockedReason}` : "RESULT: all required operations available — clone may proceed after confirmation",
    ];
    return preBox(lines.join("\n"));
}

function renderCapabilities() {
    const out = byId("capabilities-out");
    out.replaceChildren(
        preBox(
            CAPABILITY_TABLE.map((r) => `${r.capability}\n  → ${r.verdict}\n    proof: ${r.proof}`).join("\n\n"),
        ),
    );
}

// ———————————————————————————————————————————————————————————————————————
// Phase 5 — CLONE PLAN (display only, no mutation)
// ———————————————————————————————————————————————————————————————————————

function renderPlan() {
    if (!liveSnapshot) return;
    const out = byId("plan-out");
    const create = liveSnapshot.devices.map((d) => `  ${d.entityType}${d.displayName ? ` (${d.displayName})` : ""}`);
    const params = liveSnapshot.devices.flatMap((d) =>
        d.fields.map((f) => `  ${d.entityType}.${f.path} = ${formatValue(f.value)}`),
    );
    const conns = liveSnapshot.connections.map((c) => `  ${deviceLabel(c.fromEntityId)} → ${deviceLabel(c.toEntityId)}`);
    const lines = [
        "CHAIN CLONE PLAN",
        "",
        "Create:",
        ...(create.length ? create : ["  (none)"]),
        "",
        "Set parameters:",
        ...(params.length ? params : ["  (none)"]),
        "",
        "Create connections:",
        ...(conns.length ? conns : ["  (none)"]),
        "",
        "This plan performs no mutation. The real target schema (ranges,",
        "immutability) is applied at execution time.",
    ];
    out.replaceChildren(preBox(lines.join("\n")));
}

// ———————————————————————————————————————————————————————————————————————
// Phase 7 + 8 + 9 — CLONE, POST-CLONE DISCOVERY, VERIFICATION REPORT
// ———————————————————————————————————————————————————————————————————————

function formatCloneSectionVerdicts(result: { report: { sections: Record<string, { verdict: string }> } }) {
    const s = result.report.sections;
    return [
        { label: "Entity creation", verdict: s.entityCreation.verdict },
        { label: "Parameter writes", verdict: s.parameterRestore.verdict },
        { label: "Cable creation", verdict: s.connectionCreation.verdict },
        { label: "Topology", verdict: s.topologyRestore.verdict },
    ];
}

async function cloneChain() {
    if (!sourceDoc || !targetDoc) return showError("open SOURCE and TARGET first");
    if (!liveSnapshot) return showError("DISCOVER CHAIN first (Phase 1+2)");
    if (!sourceRoot()) return showError("re-discover before cloning (root required)");
    if (!capabilityReport || capabilityReport.blockedReason) {
        return showError(`clone blocked by capability gate: ${capabilityReport?.blockedReason ?? "no capability report"}`);
    }
    const target = targetDoc;

    const out = byId("clone-out");
    out.replaceChildren();
    const btn = byId<HTMLButtonElement>("clone-btn");
    btn.disabled = true;
    status("CLONE CHAIN — mutating the TARGET project…");
    try {
        const result = await cloneChainFromSnapshot(liveSnapshot, target, {
            onProgress: (step) => status(`CLONE CHAIN — ${step}`),
        });

        // Phase 8 — post-clone discovery (re-read TARGET, no source access).
        const targetParams = Array.from(result.idMap.values()).reduce(
            (n, targetId) => n + listParametersLive(target, targetId).length,
            0,
        );
        const targetAfter: LiveCounts = {
            entities: listEntitiesLive(target).length,
            parameters: targetParams,
            cables: listCablesLive(target).length,
        };

        const liveReport: LiveTestReport = buildLiveReport({
            source: sourceCounts,
            targetBefore,
            targetAfter,
            cloneSections: formatCloneSectionVerdicts(result),
            finalVerdict: result.report.finalVerdict,
            mutationExecuted: true,
        });

        out.appendChild(renderResult(liveReport, result));
        out.appendChild(renderIdMap(result.idMap));
        status(`cloned — final: ${liveReport.verdict}`);
    } catch (e) {
        showError(`clone failed: ${String(e)}`);
        status("");
    } finally {
        refreshCloneGate();
    }
}

function sourceRoot(): string | undefined {
    if (!liveSnapshot) return undefined;
    return liveSnapshot.rootCandidates[0];
}

function renderResult(report: LiveTestReport, result: unknown): HTMLElement {
    const box = el("div");
    const title = el("h3", "VERIFICATION REPORT");
    const verdictClass =
        report.verdict === "CHAIN CLONE: PASS"
            ? "verdict-pass"
            : report.verdict === "CHAIN CLONE: PARTIAL"
              ? "verdict-partial"
              : "verdict-fail";
    const verdict = el("p", report.verdict);
    verdict.className = verdictClass;
    box.appendChild(title);
    box.appendChild(preBox(report.text));
    box.appendChild(verdict);
    if (!report.blockDetail) {
        box.appendChild(
            preBox(
                "Machine-readable detail (failures per step):\n" +
                    JSON.stringify((result as { failures: unknown[] }).failures, null, 2),
            ),
        );
    }
    return box;
}

function renderIdMap(idMap: Map<string, string>): HTMLElement {
    const box = el("div");
    box.appendChild(el("h3", "SOURCE → TARGET ID MAP (logical identity preserved)"));
    box.appendChild(
        preBox(
            Array.from(idMap.entries())
                .map(([s, t]) => `${s}\n  ↓ ${t}`)
                .join("\n"),
        ),
    );
    return box;
}

// ———————————————————————————————————————————————————————————————————————
// UI construction
// ———————————————————————————————————————————————————————————————————————

function bootstrapUI() {
    const root = byId("app");
    root.appendChild(el("h1", "METATRON LIVE CHAIN CLONE CAPABILITY TEST"));
    const hint = el("p", "SOURCE project is read-only. TARGET project is mutated ONLY when CLONE CHAIN is pressed.");
    hint.style.color = "#aaa";
    root.appendChild(hint);

    const connSpan = el("span", "Disconnected");
    connSpan.id = "conn";
    root.appendChild(connSpan);
    const connectBtn = el("button", "CONNECT");
    connectBtn.className = "btn";
    connectBtn.addEventListener("click", () => void connectFlow());
    root.appendChild(connectBtn);

    // Phase 0 — SOURCE
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

    // root device
    const rootInput = el("input");
    rootInput.id = "root-device";
    rootInput.type = "text";
    rootInput.placeholder = "root device entity id";
    rootInput.style.width = "100%";
    const discoverBtn = el("button", "DISCOVER CHAIN (PHASES 1+2)");
    discoverBtn.className = "btn";
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
    const targetSec = section("PHASE 4 — TARGET PROJECT (CLONE PAYLOAD)");
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
    const planSec = section("PHASE 5 — CLONE PLAN (display only, no mutation)");
    const planOut = el("div");
    planOut.id = "plan-out";
    planSec.appendChild(planOut);

    // Phase 6/7 — clone
    const cloneSec = section("PHASE 6 — USER CONFIRMATION");
    const cloneBtn = el("button", "CLONE CHAIN");
    cloneBtn.id = "clone-btn";
    cloneBtn.className = "btn btn-danger";
    cloneBtn.disabled = true;
    cloneBtn.addEventListener("click", () => void cloneChain());
    const statusEl = el("p", "");
    statusEl.id = "status";
    const gateEl = el("p", "");
    gateEl.id = "clone-gate";
    const cloneOut = el("div");
    cloneOut.id = "clone-out";
    cloneSec.appendChild(cloneBtn);
    cloneSec.appendChild(statusEl);
    cloneSec.appendChild(gateEl);
    cloneSec.appendChild(cloneOut);

    const errorArea = el("div");
    errorArea.id = "error-area";

    root.appendChild(sourceSec);
    root.appendChild(capSec);
    root.appendChild(targetSec);
    root.appendChild(planSec);
    root.appendChild(cloneSec);
    root.appendChild(errorArea);

    // report anchors for styles
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