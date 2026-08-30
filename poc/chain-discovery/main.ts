/**
 * METATRON CHAIN DISCOVERY POC — main entry (browser).
 *
 * Read-only diagnostic around a real Audiotool project via the real
 * `@audiotool/nexus` library. Reuses the same OAuth mechanism as the
 * productive Metatron PoC (VITE_AUDIOTOOL_CLIENT_ID) — no second auth
 * architecture.
 */

import { audiotool, audiotoolPopup } from "@audiotool/nexus";
import type { AudiotoolClient, SyncedDocument } from "@audiotool/nexus";
import { discoverChainLive, listAudioDevicesLive, listCablesLive, listEntitiesLive, listParametersLive } from "./live";
import { persistBindingsRead } from "./bindings";
import { chainToString } from "./discovery";
import type { ParameterInfo } from "./types";

const PREFIX = "[METATRON CHAIN DISCOVERY]";
const ERR_PREFIX = "[METATRON CHAIN DISCOVERY ERROR]";

const CLIENT_ID: string = import.meta.env.VITE_AUDIOTOOL_CLIENT_ID
    ?? "e498c930-864a-4ef0-8d57-b8a176bee096";

let client: AudiotoolClient | null = null;
let doc: SyncedDocument | null = null;

// ———————————————————————————————————————————————————————————————————————
// tiny DOM helpers
// ———————————————————————————————————————————————————————————————————————

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
}

function section(title: string): HTMLElement {
    const wrap = el("section");
    wrap.appendChild(el("h2", title));
    return wrap;
}

function render(content: string, target: HTMLElement) {
    const pre = preBox(content);
    target.appendChild(pre);
}

function preBox(content: string): HTMLPreElement {
    const pre = el("pre");
    pre.style.whiteSpace = "pre-wrap";
    pre.style.fontFamily = "monospace";
    pre.textContent = content;
    return pre;
}

function showError(message: string) {
    const area = document.getElementById("error-area");
    if (!area) return;
    const box = preBox(`${ERR_PREFIX}\n${message}`);
    box.style.color = "#ff8080";
    area.appendChild(box);
    console.error(ERR_PREFIX, message);
}

// ———————————————————————————————————————————————————————————————————————
// wiring
// ———————————————————————————————————————————————————————————————————————

function byId<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) throw new Error(`missing element #${id}`);
    return node as T;
}

async function refreshConnectionStatus(statusArea: HTMLElement) {
    if (client) {
        statusArea.textContent = "Connected";
        byId("connection-status").style.color = "#4caf50";
    } else {
        statusArea.textContent = "Disconnected";
        byId("connection-status").style.color = "#ff9800";
    }
}

async function bootstrap() {
    const statusArea = byId("connection-status");
    const statusDetail = byId("connection-detail");
    try {
        const result = await audiotool({
            clientId: CLIENT_ID,
            redirectUrl: `${window.location.origin}${window.location.pathname}`,
            scope: "project:write",
        });
        if (result.status === "authenticated") {
            client = result;
            statusDetail.textContent = `authenticated as ${result.userName} (shared with Metatron app)`;
            console.log(`${PREFIX} authenticated as ${result.userName}`);
        } else {
            statusDetail.textContent = "not authenticated — press CONNECT to start OAuth (popup)";
            console.log(`${PREFIX} unauthenticated — waiting for CONNECT`);
        }
    } catch (e) {
        showError(`OAuth bootstrap failed: ${String(e)}`);
    }
    await refreshConnectionStatus(statusArea);
}

async function connectFlow() {
    const statusArea = byId("connection-status");
    const statusDetail = byId("connection-detail");
    try {
        if (!client) {
            console.log(`${PREFIX} starting OAuth popup …`);
            const result = await audiotoolPopup({ clientId: CLIENT_ID, scope: "project:write" });
            if (result.status === "authenticated") {
                client = result;
                statusDetail.textContent = `authenticated as ${result.userName}`;
                console.log(`${PREFIX} authenticated as ${result.userName}`);
            } else {
                throw new Error(result.error?.message ?? "OAuth cancelled or failed");
            }
        }
    } catch (e) {
        showError(`OAuth failed: ${String(e)}`);
    }
    await refreshConnectionStatus(statusArea);
}

async function openProject() {
    const urlInput = byId<HTMLInputElement>("project-url");
    const url = urlInput.value.trim();
    if (!client) { showError("not authenticated — CONNECT first"); return; }
    if (!url) { showError("enter an Audiotool project URL"); return; }
    const detail = byId("project-detail");
    try {
        console.log(`${PREFIX} opening project ${url}`);
        doc = await client.open(url);
        await doc!.start();
        console.log(`${PREFIX} project open & syncing — READ ONLY`);
        detail.textContent = `open & syncing (read-only): ${url}`;
        renderEntities();
        renderDevices();
    } catch (e) {
        showError(`openProject failed: ${String(e)}`);
        return;
    }
}

function renderEntities() {
    if (!doc) return;
    const target = byId("entities-out");
    target.replaceChildren();
    const entities = listEntitiesLive(doc);
    if (entities.length === 0) {
        render("NOT AVAILABLE — no entities returned by Nexus", target);
        return;
    }
    render(
        entities
            .map((e) => `${e.entityType}\t${e.displayName || "(no displayName)"}\t${e.id}\ttargets: ${e.targetTypes.join(",") || "-"}`)
            .join("\n"),
        target,
    );
    console.log(`${PREFIX} ENTITIES: ${entities.length}`);
}

function renderDevices() {
    if (!doc) return;
    const target = byId("devices-out");
    target.replaceChildren();
    const devices = listAudioDevicesLive(doc);
    if (devices.length === 0) {
        render("NOT AVAILABLE — no audio-socket entities found", target);
        return;
    }
    const list = el("ul");
    for (const d of devices) {
        const item = el("li");
        const btn = el("button", "[Select]");
        btn.className = "btn";
        const label = `${d.entityType} · ${d.displayName || "(no name)"} · ${d.id}`;
        btn.addEventListener("click", () => {
            byId<HTMLInputElement>("root-device").value = d.id;
        });
        item.appendChild(btn);
        item.appendChild(document.createTextNode(` ${label}`));
        list.appendChild(item);
    }
    target.appendChild(list);
    console.log(`${PREFIX} AVAILABLE AUDIO DEVICES: ${devices.length}`);
}

function renderConnections() {
    if (!doc) return;
    const cables = listCablesLive(doc);
    const target = byId("connections-out");
    target.replaceChildren();
    if (cables.length === 0) {
        render(
            `NOT AVAILABLE — no DesktopAudioCable entities (count=0)\n${PREFIX} CONNECTIONS: 0`,
            target,
        );
        return;
    }
    render(
        cables.map((c) => `${c.id}\n  ${c.fromEntityId} ${c.fromSocketPath || "(path N/A)"}\n  → ${c.toEntityId} ${c.toSocketPath || "(path N/A)"}`).join("\n\n"),
        target,
    );
    console.log(`${PREFIX} CONNECTIONS: ${cables.length} desktop audio cables`);
}

function renderChain(rootId: string) {
    if (!doc) return;
    const target = byId("chain-out");
    target.replaceChildren();
    try {
        const { result } = discoverChainLive(doc, rootId.trim(), 32);
        render(chainToString(result.chain), target);
        const meta = el("p");
        meta.textContent = `visited=${result.visitedCount} truncated=${result.truncated} maxDepth=${result.maxDepth}`;
        target.appendChild(meta);
    } catch (e) {
        showError(`discoverChain failed: ${String(e)}`);
    }
}

function renderParameters(rootId: string) {
    if (!doc) return;
    const target = byId("parameters-out");
    target.replaceChildren();
    const chainRoot = rootId.trim();
    let entities: { id: string; label: string }[] = [];
    try {
        const { result } = discoverChainLive(doc, chainRoot, 32);
        entities = result.order.map((id) => ({
            id,
            label: result.chain.find((m) => m.node.id === id)?.node.displayName || id,
        }));
    } catch {
        entities = [{ id: chainRoot, label: chainRoot }];
    }

    const valueLog: string[] = [];
    for (const ent of entities) {
        const params: ParameterInfo[] = listParametersLive(doc, ent.id);
        const head = el("h3", `${ent.label} (${ent.id})`);
        target.appendChild(head);
        if (params.length === 0) {
            target.appendChild(preBox("NOT AVAILABLE — no automatable parameters"));
            continue;
        }
        const lines: string[] = [];
        for (const p of params) {
            lines.push(
                `${p.fieldPath}\n  value: ${String(p.value)}\n  range: ${p.range ? `[${p.range.min}, ${p.range.max}]` : "N/A"}\n  type: ${p.scalarType ?? "N/A"}\n  mutable: ${p.mutable}`,
            );
            valueLog.push(`${ent.label}: ${p.fieldPath} = ${String(p.value)}`);
        }
        target.appendChild(preBox(lines.join("\n\n")));
    }
    const valuesOut = byId("current-values-out");
    valuesOut.replaceChildren();
    valuesOut.appendChild(preBox(valueLog.length ? valueLog.join("\n") : "NOT AVAILABLE"));
}

function renderBindings() {
    const target = byId("bindings-out");
    target.replaceChildren();
    const bindings = persistBindingsRead();
    if (bindings.length === 0) {
        target.appendChild(preBox("METATRON BINDINGS: NOT TESTED — no persisted bindings in localStorage"));
        return;
    }
    target.appendChild(
        preBox(
            bindings
                .map((b) => `${b.controlLabel}\n → ${b.deviceName}\n → targetName: ${b.targetName ?? "(none)"}\n state(persisted): ${b.state} · ${b.provenance}`)
                .join("\n\n"),
        ),
    );
}

function discoverChain() {
    if (!doc) { showError("open a project first"); return; }
    const rootId = byId<HTMLInputElement>("root-device").value.trim();
    if (!rootId) { showError("choose / enter a root device id"); return; }
    console.log(`${PREFIX} DISCOVER CHAIN root=${rootId}`);
    renderChain(rootId);
    renderConnections();
    renderParameters(rootId);
    renderBindings();
}

function bootstrapUI() {
    const root = byId("app");

    const title = el("h1", "METATRON CHAIN DISCOVERY");
    const hint = el("p", "Read-only diagnostic — never mutates the Audiotool project.");
    hint.style.color = "#aaa";

    // project url
    const urlRow = el("div");
    const urlInput = el("input");
    urlInput.id = "project-url";
    urlInput.type = "text";
    urlInput.placeholder = "https://beta.audiotool.com/studio?project=…  or  projects/…";
    urlInput.style.width = "100%";
    urlInput.style.boxSizing = "border-box";
    const connectBtn = el("button", "CONNECT");
    connectBtn.className = "btn";
    connectBtn.addEventListener("click", connectFlow);
    const openBtn = el("button", "OPEN PROJECT");
    openBtn.className = "btn";
    openBtn.addEventListener("click", openProject);
    urlRow.appendChild(urlInput);
    urlRow.appendChild(connectBtn);
    urlRow.appendChild(openBtn);

    const connStatus = el("div");
    connStatus.appendChild(el("span", "Connection: "));
    const connStatusSpan = el("span", "Disconnected");
    connStatusSpan.id = "connection-status";
    const connDetail = el("span", "");
    connDetail.id = "connection-detail";
    connDetail.style.marginLeft = "12px";
    connDetail.style.color = "#888";
    connStatus.appendChild(connStatusSpan);
    connStatus.appendChild(connDetail);

    const projectDetail = el("p", "");
    projectDetail.id = "project-detail";
    projectDetail.style.color = "#888";

    // root device
    const rootRow = el("div");
    const rootInput = el("input");
    rootInput.id = "root-device";
    rootInput.type = "text";
    rootInput.placeholder = "root device entity id (or use [Select] below)";
    rootInput.style.width = "100%";
    rootInput.style.boxSizing = "border-box";
    const discoverBtn = el("button", "DISCOVER CHAIN");
    discoverBtn.className = "btn";
    discoverBtn.addEventListener("click", discoverChain);
    rootRow.appendChild(rootInput);
    rootRow.appendChild(discoverBtn);

    const errorArea = el("div");
    errorArea.id = "error-area";
    errorArea.style.color = "#ff8080";

    const entitiesSec = section("ENTITIES");
    const entitiesOut = el("div");
    entitiesOut.id = "entities-out";
    entitiesSec.appendChild(entitiesOut);

    const devicesSec = section("AVAILABLE AUDIO DEVICES");
    const devicesOut = el("div");
    devicesOut.id = "devices-out";
    devicesSec.appendChild(devicesOut);

    const chainSec = section("CHAIN");
    const chainOut = el("div");
    chainOut.id = "chain-out";
    chainSec.appendChild(chainOut);

    const connSec = section("CONNECTIONS");
    const connOut = el("div");
    connOut.id = "connections-out";
    connSec.appendChild(connOut);

    const paramSec = section("PARAMETERS");
    const paramsOut = el("div");
    paramsOut.id = "parameters-out";
    paramSec.appendChild(paramsOut);

    const valueSec = section("CURRENT VALUES");
    const valuesOut = el("div");
    valuesOut.id = "current-values-out";
    valueSec.appendChild(valuesOut);

    const bindSec = section("METATRON BINDINGS");
    const bindOut = el("div");
    bindOut.id = "bindings-out";
    bindSec.appendChild(bindOut);

    root.appendChild(title);
    root.appendChild(hint);
    root.appendChild(urlRow);
    root.appendChild(connStatus);
    root.appendChild(projectDetail);
    root.appendChild(rootRow);
    root.appendChild(errorArea);
    root.appendChild(entitiesSec);
    root.appendChild(devicesSec);
    root.appendChild(chainSec);
    root.appendChild(connSec);
    root.appendChild(paramSec);
    root.appendChild(valueSec);
    root.appendChild(bindSec);
}

bootstrapUI();
void bootstrap();