/**
 * METATRON CHAIN-UNION AUDIT — read-only live harness (STEP M19.2, AUDIT-ONLY).
 *
 * Proves the binding-based chain discovery (`chainUnionFromBindings`) against
 * REAL Audiotool project topology BEFORE the production root-based export is
 * touched. NO mutation, NO persistence, NO export changes — this page only
 * reads the connected project and compares:
 *
 *   OLD  selectSourceRoot() → createSnapshot(root)
 *   NEW  Metatron bindings → chainUnionFromBindings()
 *
 * In the real Metatron app the "bound entity ids" are produced by
 * `BindingManager.getActiveBinding(controlId).entityId`. This harness lets the
 * operator provide those ids by selecting project audio devices (the actual
 * app supplies them directly — the harness reproduces the same unique set).
 */

import { audiotool, audiotoolPopup } from "@audiotool/nexus";
import type { AudiotoolClient, SyncedDocument } from "@audiotool/nexus";
import { listAudioDevicesLive, listCablesLive, listEntitiesLive } from "../../src/nexus/ChainLive";
import { extractAudioConnections, normalizeEntityId } from "../../src/nexus/ChainDiscovery";
import { createSnapshot } from "../../src/nexus/ChainSnapshot";
import { selectSourceRoot } from "../../src/integration/InstrumentPresetIntegration";
import { buildUnionAudit } from "./audit";
import type { UnionAudit, DeviceInfo } from "./audit";

const PREFIX = "[METATRON CHAIN-UNION AUDIT]";
const ERR_PREFIX = "[METATRON CHAIN-UNION AUDIT ERROR]";

const CLIENT_ID: string =
    import.meta.env.VITE_AUDIOTOOL_CLIENT_ID ??
    "e498c930-864a-4ef0-8d57-b8a176bee096";

let client: AudiotoolClient | null = null;
let doc: SyncedDocument | null = null;
let boundIds = new Set<string>();

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

function byId<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) throw new Error(`missing element #${id}`);
    return node as T;
}

function showError(message: string) {
    byId("error-area").appendChild(preBox(`${ERR_PREFIX}\n${message}`));
    console.error(ERR_PREFIX, message);
}

function status(text: string) {
    byId("status").textContent = text;
}

function label(device: DeviceInfo | undefined, id: string): string {
    if (!device) return `${id.slice(0, 12)}… (no live info)`;
    const name = device.displayName && device.displayName !== device.entityType
        ? ` / ${device.displayName}`
        : "";
    const inOut = `${device.hasInputSocket ? "in" : ""}${device.hasOutputSocket ? "out" : ""}`.padEnd(6);
    return `${device.entityType ?? "?"}${name} [${inOut}]`;
}

// ———————————————————————————————————————————————————————————————————————
// bound-id selection
// ———————————————————————————————————————————————————————————————————————

function renderAudioDevices() {
    if (!doc) return;
    const target = byId("devices");
    target.replaceChildren();
    const devices = listAudioDevicesLive(doc);
    if (devices.length === 0) {
        target.appendChild(preBox("no audio-socket entities found on the connected project"));
        return;
    }
    const list = el("ul");
    list.style.listStyle = "none";
    list.style.padding = "0";
    for (const d of devices) {
        const item = el("li");
        item.style.margin = "4px 0";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = boundIds.has(normalizeEntityId(d.id));
        cb.addEventListener("change", () => {
            if (cb.checked) boundIds.add(normalizeEntityId(d.id));
            else boundIds.delete(normalizeEntityId(d.id));
            renderBoundSummary();
        });
        item.appendChild(cb);
        item.appendChild(document.createTextNode(` ${d.entityType} · ${d.displayName || "(no name)"} · ${d.id}`));
        list.appendChild(item);
    }
    target.appendChild(list);
    console.log(`${PREFIX} selectable bound candidates: ${devices.length}`);
}

function addRawIds() {
    const raw = byId<HTMLInputElement>("raw-bound").value.trim();
    if (!raw) return;
    for (const part of raw.split(/[\s,;]+/)) {
        const id = normalizeEntityId(part);
        if (id) boundIds.add(id);
    }
    byId<HTMLInputElement>("raw-bound").value = "";
    renderAudioDevices();
    renderBoundSummary();
}

function clearBound() {
    boundIds.clear();
    renderAudioDevices();
    renderBoundSummary();
}

function renderBoundSummary() {
    const list = [...boundIds];
    byId("bound-summary").replaceChildren(
        preBox(list.length === 0 ? "(no bound entities selected)" : list.map((id) => `  ${id}`).join("\n")),
    );
}

// ———————————————————————————————————————————————————————————————————————
// OAuth + project open (read-only)
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
            byId("conn").textContent = `authenticated as ${(result as { userName?: string }).userName ?? "user"}`;
            byId("conn").style.color = "#4caf50";
            console.log(`${PREFIX} authenticated`);
        } else {
            byId("conn").textContent = "not authenticated — press CONNECT (popup)";
        }
    } catch {
        byId("conn").textContent = "OAuth bootstrap failed — press CONNECT";
    }
}

async function connectFlow() {
    if (client) {
        status("already authenticated — open a project");
        return;
    }
    const origin = window.location.origin;
    try {
        const result = await Promise.race([
            audiotoolPopup({ clientId: CLIENT_ID, scope: "project:write" }),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`popup did not respond within 90s (target_origin ${origin})`)), 90_000),
            ),
        ]);
        if (result.status === "authenticated") {
            client = result;
            byId("conn").textContent = `authenticated as ${(result as { userName?: string }).userName ?? "user"}`;
            byId("conn").style.color = "#4caf50";
            status("authenticated — open a project");
        } else {
            showError(`OAuth: ${result.error?.message ?? "cancelled or failed"}`);
        }
    } catch (e) {
        showError(`OAuth popup failed (ENVIRONMENTAL BLOCK candidate): ${String(e)}\n` +
            `allow popups for ${origin}; the accounts page requires ${origin} registered as redirect origin for client ${CLIENT_ID}`);
    }
    status("");
}

async function openProject() {
    const url = byId<HTMLInputElement>("project-url").value.trim();
    if (!client) return showError("not authenticated — CONNECT first");
    if (!url) return showError("enter the connected project URL");
    try {
        doc = await client.open(url);
        await doc.start();
        byId("project-detail").textContent = `READ-ONLY open & syncing: ${url}`;
        renderAudioDevices();
        status("select the Metatron-bound entities, then RUN AUDIT");
        console.log(`${PREFIX} project open (read-only)`);
    } catch (e) {
        showError(`openProject failed: ${String(e)}`);
    }
}

// ———————————————————————————————————————————————————————————————————————
// AUDIT (read-only: both selections are pure reads)
// ———————————————————————————————————————————————————————————————————————

function directionSummary(audit: UnionAudit, cables: { id: string; from: { entityId: string }; to: { entityId: string } }[]): string {
    const lines: string[] = [];
    for (const boundId of audit.normalizedBound) {
        const feedsIn = cables
            .filter((c) => normalizeEntityId(c.to.entityId) === boundId && audit.devices[normalizeEntityId(c.from.entityId)])
            .map((c) => label(audit.devices[normalizeEntityId(c.from.entityId)], normalizeEntityId(c.from.entityId)));
        const feedsOut = cables
            .filter((c) => normalizeEntityId(c.from.entityId) === boundId && audit.devices[normalizeEntityId(c.to.entityId)])
            .map((c) => label(audit.devices[normalizeEntityId(c.to.entityId)], normalizeEntityId(c.to.entityId)));
        lines.push(
            `bound ${boundId}  (${label(audit.devices[boundId], boundId)})`,
            `  ← upstream:  ${feedsIn.length === 0 ? "(none)" : feedsIn.join(", ")}`,
            `  → downstream: ${feedsOut.length === 0 ? "(none)" : feedsOut.join(", ")}`,
        );
    }
    return lines.join("\n");
}

function renderAudit(audit: UnionAudit, cables: { id: string; from: { entityId: string }; to: { entityId: string } }[]) {
    const allSelected = [...new Set([...audit.unionDeviceIds, ...audit.old.deviceIds])];
    const deviceRows = allSelected
        .map((id) => `  ${label(audit.devices[id], id)}  ${id}`)
        .join("\n");

    const oldRootDevice = audit.old.rootId ? audit.devices[audit.old.rootId] : undefined;
    const lines = [
        "METATRON CHAIN-UNION AUDIT (READ-ONLY)",
        "",
        `ACTIVE BINDINGS (unique bound entity ids): ${audit.boundIds.length}`,
        ...audit.boundIds.map((id) => `  ${id} → normalized ${normalizeEntityId(id)}`),
        "",
        "NEW — batting-based chainUnionFromBindings()",
        `  selected devices:        ${audit.unionDeviceIds.length}`,
        `  selected connections:    ${audit.unionConnections}`,
        `  root candidates:         ${audit.unionRootCandidates.length > 0 ? audit.unionRootCandidates.join(", ") : "(none)"}`,
        `  bound inside union:      ${audit.boundInsideUnion.length > 0 ? audit.boundInsideUnion.join(", ") : "(none)"}`,
        `  bound outside union:     ${audit.boundOutsideUnion.length > 0 ? audit.boundOutsideUnion.join(", ") : "(none)"}`,
        `  truncated by maxDepth:   ${audit.unionTruncated}`,
        "",
        "OLD — selectSourceRoot() → createSnapshot(root)",
        `  root:                    ${audit.old.rootId ? `${audit.old.rootId} (${label(oldRootDevice, audit.old.rootId)})` : "(no root selected)"}`,
        `  selected devices:        ${audit.old.deviceIds.length}`,
        `  selected connections:    ${audit.old.connectionCount}`,
        "",
        "COMPARISON",
        `  included by both:        ${audit.both.length}`,
        `    ${audit.both.join(", ")}`,
        `  only in OLD:             ${audit.onlyOld.length}`,
        `    ${audit.onlyOld.join(", ")}`,
        `  only in NEW:             ${audit.onlyNew.length}`,
        `    ${audit.onlyNew.join(", ")}`,
        `  bound omitted by OLD:    ${audit.boundOmittedByOld.length}`,
        `    ${audit.boundOmittedByOld.join(", ")}`,
        `  bound omitted by NEW:    ${audit.boundOutsideUnion.join(", ")}`,
        "",
        "BOUND DEVICE → COMPLETE CHAIN (within the union)",
        directionSummary(audit, cables),
        "",
        "SELECTED DEVICE DETAIL (union ∪ old)",
        deviceRows,
    ];
    byId("audit-out").replaceChildren(preBox(lines.join("\n")));
    status("audit complete (read-only)");
    console.log(PREFIX, "AUDIT", {
        bound: audit.normalizedBound,
        union: audit.unionDeviceIds,
        roots: audit.unionRootCandidates,
        connections: audit.unionConnections,
        both: audit.both,
        onlyOld: audit.onlyOld,
        onlyNew: audit.onlyNew,
        boundOmittedByOld: audit.boundOmittedByOld,
    });
}

function runAudit() {
    if (!doc) return showError("open the project first");
    if (boundIds.size === 0) return showError("select at least one bound entity");
    const cables = extractAudioConnections(listCablesLive(doc));
    const entities = listEntitiesLive(doc).map((e) => ({ id: e.id, entityType: e.entityType, displayName: e.displayName }));
    const audioDeviceIds = listAudioDevicesLive(doc).map((e) => e.id);
    const oldRootId = selectSourceRoot(doc);
    if (!oldRootId) return showError("OLD comparison unavailable: no audio chain root found (no audio devices)");
    const oldSnapshot = createSnapshot(doc, oldRootId);
    const audit = buildUnionAudit({ cables, boundEntityIds: [...boundIds], entities, audioDeviceIds, oldRootId, oldSnapshot });
    renderAudit(audit, cables);
}

// ———————————————————————————————————————————————————————————————————————
// UI
// ———————————————————————————————————————————————————————————————————————

function buildUI() {
    const root = byId("app");
    root.appendChild(el("h1", "METATRON CHAIN-UNION AUDIT (READ-ONLY · M19.2)"));
    const banner = el("p", "AUDIT-ONLY: this page never writes to Nexus, never persists, and does not touch production export. It only reads the connected project and compares the current root-based selection with the new binding-based chain union.");
    banner.style.color = "#ffcc00";
    root.appendChild(banner);

    const conn = el("span", "Disconnected");
    conn.id = "conn";
    const connectBtn = el("button", "CONNECT");
    connectBtn.className = "btn";
    connectBtn.addEventListener("click", () => void connectFlow());
    root.appendChild(conn);
    root.appendChild(connectBtn);

    const projSec = el("section");
    projSec.appendChild(el("h2", "PROJECT (READ-ONLY)"));
    const urlInput = el("input");
    urlInput.id = "project-url";
    urlInput.type = "text";
    urlInput.placeholder = "https://beta.audiotool.com/studio?project=…  or  projects/…";
    urlInput.style.width = "100%";
    const openBtn = el("button", "OPEN PROJECT");
    openBtn.className = "btn";
    openBtn.addEventListener("click", () => void openProject());
    const detail = el("p", "");
    detail.id = "project-detail";
    detail.className = "dim";
    projSec.appendChild(urlInput);
    projSec.appendChild(openBtn);
    projSec.appendChild(detail);
    root.appendChild(projSec);

    const boundSec = el("section");
    boundSec.appendChild(el("h2", "BOUND ENTITIES (the app supplies these via BindingManager.getActiveBinding(controlId).entityId)"));
    const devices = el("div");
    devices.id = "devices";
    const raw = el("input");
    raw.id = "raw-bound";
    raw.type = "text";
    raw.placeholder = "paste raw entity ids, comma/space separated";
    raw.style.width = "70%";
    const addBtn = el("button", "ADD");
    addBtn.className = "btn";
    addBtn.addEventListener("click", addRawIds);
    const clearBtn = el("button", "CLEAR");
    clearBtn.className = "btn";
    clearBtn.addEventListener("click", clearBound);
    const summary = el("div");
    summary.id = "bound-summary";
    boundSec.appendChild(devices);
    boundSec.appendChild(raw);
    boundSec.appendChild(addBtn);
    boundSec.appendChild(clearBtn);
    boundSec.appendChild(summary);
    root.appendChild(boundSec);

    const runSec = el("section");
    runSec.appendChild(el("h2", "RUN AUDIT (read-only)"));
    const runBtn = el("button", "RUN AUDIT");
    runBtn.className = "btn";
    runBtn.id = "run-btn";
    runBtn.addEventListener("click", runAudit);
    const statusEl = el("p", "");
    statusEl.id = "status";
    const auditOut = el("div");
    auditOut.id = "audit-out";
    runSec.appendChild(runBtn);
    runSec.appendChild(statusEl);
    runSec.appendChild(auditOut);
    root.appendChild(runSec);

    const errorArea = el("div");
    errorArea.id = "error-area";
    root.appendChild(errorArea);
}

buildUI();
void bootstrap();