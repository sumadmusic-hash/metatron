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
        const logo = titleWrap.querySelector<HTMLImageElement>(".app-logo")!;
        expect(logo).not.toBeNull();
        expect(logo.getAttribute("src")).toBe("/metatron-logo-small.svg");
        expect(logo.getAttribute("alt")).toBe("Metatron");
    });

    it("places the logo LEFT of the 'Metatron' title in the same group", () => {
        const host = mount();
        const titleWrap = host.querySelector<HTMLElement>(".toolbar .app-title")!;
        const logo = titleWrap.children[0] as HTMLElement;
        const title = titleWrap.children[1] as HTMLElement;
        expect(logo.classList.contains("app-logo")).toBe(true);
        expect(title.tagName).toBe("H1");
        expect(title.textContent!.startsWith("Metatron")).toBe(true);
        // The title keeps its coexisting device-name suffix.
        expect(title.textContent).toContain("My Device");
    });

    it("keeps a 1:1 aspect ratio at a 28×28 display size", () => {
        const host = mount();
        expect(host.querySelector(".app-logo")).not.toBeNull();
        const css = readFileSync(resolve("src/ui/styles.css"), "utf8");
        const rule = css.match(/\.app-title \.app-logo\s*\{[^}]*\}/);
        expect(rule).toBeTruthy();
        expect(rule?.[0]).toMatch(/width:\s*28px/);
        expect(rule?.[0]).toMatch(/height:\s*28px/);
        expect(rule?.[0]).toMatch(/object-fit:\s*contain/);
        // Ungestörte Skalierung: die kleine, optimierte SVG ist ein perfektes Quadrat.
        const svg = readFileSync(resolve("public/metatron-logo-small.svg"), "utf8");
        expect(svg).toMatch(/viewBox="0 0 1600 1600"/);
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
        // Title block remains the first toolbar child; the toolbar is not empty.
        expect(toolbar.children[0].classList.contains("app-title")).toBe(true);
        expect(toolbar.children.length).toBeGreaterThan(1);
    });
});