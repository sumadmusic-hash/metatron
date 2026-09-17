// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { BindingManager } from "../../src/core/BindingManager";
import { AppUI } from "../../src/ui/AppUI";

/**
 * M20.12 — the square Metatron logo renders left of the "Metatron" title in
 * the app header. The SVG asset is used unchanged and displayed at 28×28.
 */

function mount(): HTMLElement {
    const device = new Device("My Device");
    const ctrl = new Control("knob", "k", { x: 0, y: 0 }, "k1");
    device.addControl(ctrl);
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = new AppUI(host, lib, new NexusAdapter(), new MidiAccess(), new BindingManager(device));
    app.render();
    return host;
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

describe("M20.12 — Metatron logo left of the title", () => {
    it("renders the logo in the header toolbar", () => {
        const host = mount();
        const titleWrap = host.querySelector<HTMLElement>(".toolbar .app-title")!;
        expect(titleWrap).not.toBeNull();
        // The logo is now an inline SVG (square mark) inside the title group —
        // the img asset is unused at runtime but stays shipped under public/.
        const logo = titleWrap.querySelector<SVGElement>(".app-logo-wrap .app-logo-svg")!;
        expect(logo).not.toBeNull();
        expect(logo.tagName).toBe("svg");
    });

    it("places the logo LEFT of the 'Metatron' title in the same group", () => {
        const host = mount();
        const titleWrap = host.querySelector<HTMLElement>(".toolbar .app-title")!;
        const logoWrap = titleWrap.children[0] as HTMLElement;
        const title = titleWrap.children[1] as HTMLElement;
        expect(logoWrap.classList.contains("app-logo-wrap")).toBe(true);
        expect(logoWrap.querySelector("svg.app-logo-svg")).toBeTruthy();
        expect(title.tagName).toBe("H1");
        expect(title.textContent!.startsWith("Metatron")).toBe(true);
        // The title keeps its coexisting device-name suffix.
        expect(title.textContent).toContain("My Device");
    });

    it("keeps a 1:1 aspect ratio at a 28×28 display size", () => {
        const host = mount();
        expect(host.querySelector(".app-logo-svg")).not.toBeNull();
        const css = readFileSync(resolve("src/ui/styles.css"), "utf8");
        const rule = css.match(/\.app-logo-svg\s*\{[^}]*\}/);
        expect(rule).toBeTruthy();
        expect(rule?.[0]).toMatch(/width:\s*28px/);
        expect(rule?.[0]).toMatch(/height:\s*28px/);
        // Ungestörte Skalierung: das Logo-Mark ist ein perfektes Quadrat.
        // The original img asset stays under public/ (untouched, still shipped).
        const svg = readFileSync(resolve("public/metatron-logo-mark.svg"), "utf8");
        expect(svg).toMatch(/viewBox="-2 -2 28 28"/);
        expect(svg).toMatch(/polygon/);
        expect(svg).toMatch(/#00e5ff/);
        // Die große Original-SVG bleibt erhalten (nicht gelöscht).
        expect(readFileSync(resolve("public/metatron-logo.svg"), "utf8")).toMatch(/viewBox="0 0 1600 1600"/);
    });

    it("spaces the logo ~8-10px from the title without shifting other header elements", () => {
        const host = mount();
        const css = readFileSync(resolve("src/ui/styles.css"), "utf8");
        const wrapRule = css.match(/\.app-title\s*\{[^}]*\}/);
        expect(wrapRule).toBeTruthy();
        expect(wrapRule?.[0]).toMatch(/gap:\s*8px/);
        expect(wrapRule?.[0]).toMatch(/align-items:\s*center/);
        // The rest of the toolbar (library button, connection UI) still renders.
        const toolbar = host.querySelector(".toolbar")!;
        const libraryBtn = [...toolbar.querySelectorAll("button")].find((b) => b.innerText.includes("Library"));
        expect(libraryBtn).toBeDefined();
        // Title block is inside .header-left which is the first toolbar child.
        expect(toolbar.querySelector(".header-left")).toBeTruthy();
        expect(toolbar.querySelector(".header-left .app-title")).toBeTruthy();
        expect(toolbar.children.length).toBeGreaterThan(1);
    });
});

function mountWithDevice(deviceName: string): HTMLElement {
    const device = new Device(deviceName);
    const ctrl = new Control("knob", "k", { x: 0, y: 0 }, "k1");
    device.addControl(ctrl);
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = new AppUI(host, lib, new NexusAdapter(), new MidiAccess(), new BindingManager(device));
    app.render();
    return host;
}

describe("Device Title compactness and accessibility", () => {
    it("1. Normal device name remains visible in the title text", () => {
        const host = mountWithDevice("Lead Synth");
        const title = host.querySelector<HTMLElement>(".toolbar .app-title h1")!;
        expect(title.textContent).toBe("Metatron | Lead Synth");
        expect(title.title).toBe("Lead Synth");
    });

    it("2. Long device name does not replace visible text with custom abbreviation", () => {
        const longName = "Very Long Custom Synthesizer Performance Controller With Extra Modulations";
        const host = mountWithDevice(longName);
        const title = host.querySelector<HTMLElement>(".toolbar .app-title h1")!;
        expect(title.textContent).toBe(`Metatron | ${longName}`);
        expect(title.textContent).not.toContain("...");
    });

    it("3. The title uses ellipsis/overflow behavior in styles.css", () => {
        const css = readFileSync(resolve("src/ui/styles.css"), "utf8");
        const h1Rule = css.match(/\.toolbar h1\s*\{[^}]*\}/);
        expect(h1Rule).toBeTruthy();
        expect(h1Rule?.[0]).toMatch(/max-width:\s*260px/);
        expect(h1Rule?.[0]).toMatch(/overflow:\s*hidden/);
        expect(h1Rule?.[0]).toMatch(/text-overflow:\s*ellipsis/);
        expect(h1Rule?.[0]).toMatch(/white-space:\s*nowrap/);

        const wrapRule = css.match(/\.app-title\s*\{[^}]*\}/);
        expect(wrapRule?.[0]).toMatch(/min-width:\s*0/);
    });

    it("4. The full device name is available through native title attribute", () => {
        const longName = "Deep Horizon Filter Cutoff Frequency Controller Extra Long Name";
        const host = mountWithDevice(longName);
        const title = host.querySelector<HTMLElement>(".toolbar .app-title h1")!;
        const wrap = host.querySelector<HTMLElement>(".toolbar .app-title")!;
        expect(title.getAttribute("title")).toBe(longName);
        expect(title.title).toBe(longName);
        expect(wrap.getAttribute("title")).toBe(longName);
    });

    it("5. Existing header structure and EDIT/USE behavior remain unchanged", () => {
        const longName = "Very Long Custom Synthesizer Performance Controller";
        const host = mountWithDevice(longName);
        const toolbar = host.querySelector<HTMLElement>(".toolbar")!;
        expect(toolbar.querySelector(".header-left .app-title")).toBeTruthy();
        expect(toolbar.querySelector(".header-right button")).toBeTruthy(); // Library in the right cluster

        const modePill = toolbar.querySelector<HTMLButtonElement>("#mode-toggle-btn")!;
        expect(modePill.classList.contains("mode-pill")).toBe(true);
        modePill.click();
        const updatedPill = host.querySelector<HTMLButtonElement>("#mode-toggle-btn")!;
        expect(updatedPill.classList.contains("mode-pill")).toBe(true);
        const title = host.querySelector<HTMLElement>(".toolbar .app-title h1")!;
        expect(title.title).toBe(longName);
    });
});