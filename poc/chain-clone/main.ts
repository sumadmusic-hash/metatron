/**
 * METATRON CHAIN CLONE POC — minimal browser UI (§14).
 *
 * Source project: READ ONLY. Target project: mutated only when the user clicks
 * CLONE CHAIN. Safety: the SOURCE doc is never passed to any mutation call —
 * `cloneChainToDoc(source, target, …)` only reads source and writes target.
 */

import { audiotool, audiotoolPopup } from "@audiotool/nexus";
import type { AudiotoolClient, SyncedDocument } from "@audiotool/nexus";
import { cloneChainToDoc } from "./clone";
import { createSnapshot, serializeSnapshot } from "./snapshot";
import { discoverChainLive } from "../chain-discovery/live";
import { chainToString } from "../chain-discovery/discovery";
import { CAPABILITY_TABLE } from "./api-capabilities";
import type { CloneResult } from "./types";

const PREFIX = "[METATRON CHAIN CLONE]";
const ERR_PREFIX = "[METATRON CHAIN CLONE ERROR]";

const CLIENT_ID: string =
    import.meta.env.VITE_AUDIOTOOL_CLIENT_ID ?? "e498c930-864a-4ef0-8d57-b8a176bee096";

let client: AudiotoolClient | null = null;
let sourceDoc: SyncedDocument | null = null;
let targetDoc: SyncedDocument | null = null;

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

function preBox(content: string): HTMLPreElement {
    const pre = el("pre");
    pre.textContent = content;
    return pre;
}

function byId<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) throw new Error(`missing element #${id}`);
    return node as T;
}

function showError(message: string) {
    const area = byId<HTMLElement>("error-area");
    const box = preBox(`${ERR_PREFIX}\n${message}`);
    box.style.color = "#ff8080";
    area.appendChild(box);
    console.error(ERR_PREFIX, message);
}

function status(text: string) {
    byId("status").textContent = text;
}

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
            console.log(`${PREFIX} unauthenticated`);
        }
    } catch (e) {
        showError(`OAuth bootstrap failed: ${String(e)}`);
    }
}

async function connectFlow() {
    try {
        if (!client) {
            status("OAuth popup …");
            const result = await audiotoolPopup({ clientId: CLIENT_ID, scope: "project:write" });
            if (result.status === "authenticated") {
                client = result;
                byId("conn").textContent = `authenticated as ${result.userName}`;
                byId("conn").style.color = "#4caf50";
                console.log(`${PREFIX} authenticated as ${result.userName}`);
            } else {
                throw new Error(result.error?.message ?? "OAuth cancelled or failed");
            }
        }
    } catch (e) {
        showError(`OAuth failed: ${String(e)}`);
    }
    status("");
}

async function openSource() {
    const url = byId<HTMLInputElement>("source-url").value.trim();
    if (!client) return showError("not authenticated — CONNECT first");
    if (!url) return showError("enter a SOURCE project URL");
    try {
        sourceDoc = await client.open(url);
        await sourceDoc.start();
        byId("source-detail").textContent = `READ-ONLY source open & syncing: ${url}`;
        console.log(`${PREFIX} source open (read-only)`);
    } catch (e) {
        showError(`openSource failed: ${String(e)}`);
    }
}

async function openTarget() {
    const url = byId<HTMLInputElement>("target-url").value.trim();
    if (!client) return showError("not authenticated — CONNECT first");
    if (!url) return showError("enter a TARGET project URL");
    try {
        targetDoc = await client.open(url);
        await targetDoc.start();
        byId("target-detail").textContent = `writable target open & syncing: ${url}`;
        console.log(`${PREFIX} target open`);
    } catch (e) {
        showError(`openTarget failed: ${String(e)}`);
    }
}

function discover() {
    if (!sourceDoc) return showError("open the SOURCE project first");
    const root = byId<HTMLInputElement>("root-device").value.trim();
    if (!root) return showError("enter the root device entity id");
    const out = byId("discover-out");
    out.replaceChildren();
    try {
        const { result } = discoverChainLive(sourceDoc, root, 32);
        const preview = createSnapshot(sourceDoc, root);
        const lines = [
            chainToString(result.chain),
            "",
            `Discovered: ${result.order.length} devices · ${preview.connections.length} connections · ${preview.devices.reduce((n, d) => n + d.fields.length, 0)} parameters`,
            `rootCandidates: ${preview.rootCandidates.join(", ")}`,
            "",
            "SNAPSHOT (serialized):",
            serializeSnapshot(preview),
        ];
        out.appendChild(preBox(lines.join("\n")));
    } catch (e) {
        showError(`discover failed: ${String(e)}`);
    }
}

async function cloneChain() {
    if (!sourceDoc) return showError("open the SOURCE project first");
    if (!targetDoc) return showError("open the TARGET project first");
    const root = byId<HTMLInputElement>("root-device").value.trim();
    if (!root) return showError("enter the root device entity id");
    const out = byId("clone-out");
    out.replaceChildren();
    const confidence = byId<HTMLElement>("confidence");
    confidence.textContent = "CLONE CHAIN will MUTATE THE TARGET PROJECT.";
    confidence.style.color = "#ff9800";

    byId<HTMLButtonElement>("clone-btn").disabled = true;
    status("Creating devices…");
    try {
        const result: CloneResult = await cloneChainToDoc(sourceDoc, targetDoc, root, {
            onProgress: (step) => status(`${step}…`),
        });
        out.appendChild(renderResult(result));
        status("done");
    } catch (e) {
        showError(`clone failed: ${String(e)}`);
        status("");
    } finally {
        byId<HTMLButtonElement>("clone-btn").disabled = false;
    }
}

function renderResult(result: CloneResult): HTMLElement {
    const box = el("div");
    box.appendChild(el("h3", "CHAIN CLONE POC"));
    const lines: string[] = [];
    const verdictClass = (v: string) =>
        v === "PASS" ? "verdict-pass" : v === "PARTIAL" ? "verdict-partial" : "verdict-fail";
    const s = result.report.sections;
    const pushSection = (label: string, sec: { verdict: string; detail: string[] }) => {
        const span = el("span", `\n${label}: ${sec.verdict}\n`);
        span.className = verdictClass(sec.verdict);
        box.appendChild(span);
        box.appendChild(preBox(sec.detail.join("\n")));
    };
    pushSection("ENTITY CREATION", s.entityCreation);
    pushSection("PARAMETER RESTORE", s.parameterRestore);
    pushSection("CURRENT VALUES", s.currentValues);
    pushSection("CONNECTION CREATION", s.connectionCreation);
    pushSection("TOPOLOGY RESTORE", s.topologyRestore);
    pushSection("VERIFICATION", s.verification);

    const verdict = el("p", `\nFINAL VERDICT: ${result.report.finalVerdict}`);
    verdict.className = verdictClass(result.report.finalVerdict === "CHAIN CLONE: PASS" ? "PASS" : result.report.finalVerdict === "CHAIN CLONE: PARTIAL" ? "PARTIAL" : "FAIL");
    box.appendChild(verdict);

    box.appendChild(preBox(`\nSUPPORTED ENTITY TYPES:\n${result.report.supportedEntityTypes.join(", ") || "(none)"}`));
    box.appendChild(preBox(`UNSUPPORTED ENTITY TYPES:\n${result.report.unsupportedEntityTypes.join(", ") || "(none)"}`));
    box.appendChild(preBox(`NEXUS API LIMITATIONS:\n${result.report.nexusApiLimitations.map((l) => `- ${l}`).join("\n")}`));

    box.appendChild(el("h3", "SOURCE → TARGET ID MAP"));
    box.appendChild(preBox(Array.from(result.idMap.entries()).map(([s, t]) => `${s}\n  ↓ ${t}`).join("\n")));
    void lines;
    return box;
}

function renderCapabilities() {
    const out = byId("capabilities-out");
    out.replaceChildren();
    out.appendChild(
        preBox(
            CAPABILITY_TABLE.map((r) => `${r.capability}\n  → ${r.verdict}\n    proof: ${r.proof}`).join("\n\n"),
        ),
    );
}

function bootstrapUI() {
    const root = byId("app");
    const title = el("h1", "METATRON CHAIN CLONE POC");
    const hint = el("p", "SOURCE project is read-only. TARGET project is modified only when CLONE CHAIN is pressed.");
    hint.style.color = "#aaa";

    const connStatus = el("div");
    const connSpan = el("span", "Disconnected");
    connSpan.id = "conn";
    connStatus.appendChild(connSpan);

    const connectBtn = el("button", "CONNECT");
    connectBtn.className = "btn";
    connectBtn.addEventListener("click", connectFlow);

    // source
    const sourceSec = section("SOURCE PROJECT (READ-ONLY)");
    const srcInput = el("input");
    srcInput.id = "source-url";
    srcInput.type = "text";
    srcInput.placeholder = "https://beta.audiotool.com/studio?project=…  or  projects/…";
    srcInput.style.width = "100%";
    const openSrcBtn = el("button", "OPEN SOURCE");
    openSrcBtn.className = "btn";
    openSrcBtn.addEventListener("click", openSource);
    const srcDetail = el("p", "");
    srcDetail.id = "source-detail";
    srcDetail.className = "dim";
    sourceSec.appendChild(srcInput);
    sourceSec.appendChild(openSrcBtn);
    sourceSec.appendChild(srcDetail);

    // target
    const targetSec = section("TARGET PROJECT (CLONE PAYLOAD)");
    const tgInput = el("input");
    tgInput.id = "target-url";
    tgInput.type = "text";
    tgInput.placeholder = "https://beta.audiotool.com/studio?project=…  or  projects/…";
    tgInput.style.width = "100%";
    const openTgBtn = el("button", "OPEN TARGET");
    openTgBtn.className = "btn";
    openTgBtn.addEventListener("click", openTarget);
    const tgDetail = el("p", "");
    tgDetail.id = "target-detail";
    tgDetail.className = "dim";
    targetSec.appendChild(tgInput);
    targetSec.appendChild(openTgBtn);
    targetSec.appendChild(tgDetail);

    // root device
    const rootSec = section("CHAIN");
    const rootInput = el("input");
    rootInput.id = "root-device";
    rootInput.type = "text";
    rootInput.placeholder = "root device entity id";
    rootInput.style.width = "100%";
    const discoverBtn = el("button", "DISCOVER CHAIN");
    discoverBtn.className = "btn";
    discoverBtn.addEventListener("click", discover);
    const discoverOut = el("div");
    discoverOut.id = "discover-out";
    rootSec.appendChild(rootInput);
    rootSec.appendChild(discoverBtn);
    rootSec.appendChild(discoverOut);

    // clone
    const cloneSec = section("CLONE");
    const cloneBtn = el("button", "CLONE CHAIN");
    cloneBtn.id = "clone-btn";
    cloneBtn.className = "btn btn-danger";
    cloneBtn.addEventListener("click", cloneChain);
    const statusEl = el("p", "");
    statusEl.id = "status";
    const confidenceEl = el("p", "");
    confidenceEl.id = "confidence";
    const cloneOut = el("div");
    cloneOut.id = "clone-out";
    cloneSec.appendChild(cloneBtn);
    cloneSec.appendChild(statusEl);
    cloneSec.appendChild(confidenceEl);
    cloneSec.appendChild(cloneOut);

    const errorArea = el("div");
    errorArea.id = "error-area";

    const capSec = section("NEXUS 0.0.17 API CAPABILITIES (§16)");
    const capOut = el("div");
    capOut.id = "capabilities-out";
    capSec.appendChild(capOut);

    root.appendChild(title);
    root.appendChild(hint);
    root.appendChild(connStatus);
    root.appendChild(connectBtn);
    root.appendChild(sourceSec);
    root.appendChild(targetSec);
    root.appendChild(rootSec);
    root.appendChild(cloneSec);
    root.appendChild(errorArea);
    root.appendChild(capSec);

    renderCapabilities();
}

bootstrapUI();
void bootstrap();