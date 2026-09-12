// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { Group } from "../../src/core/model/Group";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { BindingManager } from "../../src/core/BindingManager";
import { AppUI } from "../../src/ui/AppUI";

function mountApp(device: Device): { root: HTMLElement; device: Device } {
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    lib.saveCurrentDevice();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const app = new AppUI(root, lib, new NexusAdapter(), new MidiAccess(), new BindingManager(device));
    app.render();
    return { root, device };
}

function buildDevice(): Device {
    const d = new Device("Kit");
    const g = new Group("DRUMS", { x: 40, y: 40 }, { width: 300, height: 200 });
    d.addGroup(g);
    const k = new Control("knob", "GAIN", { x: 80, y: 90 });
    d.addControl(k);
    d.setControlGroup(k.id, g.id);
    return d;
}

function pane(root: HTMLElement): HTMLElement {
    return root.querySelector<HTMLElement>(".sidebar-pane")!;
}
function toggle(root: HTMLElement): HTMLButtonElement {
    return root.querySelector<HTMLButtonElement>(".sidebar-toggle")!;
}
function library(root: HTMLElement): HTMLElement {
    return root.querySelector<HTMLElement>(".device-sidebar-wrap")!;
}
function contentArea(root: HTMLElement): HTMLElement {
    return root.querySelector<HTMLElement>(".content-area")!;
}
function click(el: HTMLElement) {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}
function switchToUse(root: HTMLElement) {
    const b = [...root.querySelectorAll<HTMLButtonElement>("button")].find((x) =>
        x.innerText === "USE"
    )!;
    b.click();
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    sessionStorage.clear();
});

describe("Collapsible left sidebar", () => {

    it("renders an edge toggle plus the library, with the controller surface as a flex:1 sibling", () => {
        const { root } = mountApp(buildDevice());
        expect(pane(root)).toBeTruthy();
        expect(toggle(root)).toBeTruthy();
        expect(library(root)).toBeTruthy();
        expect(contentArea(root)).toBeTruthy();
        // Structural basis for genuine width reclamation: controller = flex:1.
        const css = readFileSync(resolve("src/ui/styles.css"), "utf8");
        const areaRule = css.match(/\.content-area\s*\{[^}]*\}/);
        expect(areaRule?.[0]).toMatch(/flex:\s*1/);
    });

    it("starts expanded in EDIT mode and collapses on toggle without destroying content", () => {
        const { root } = mountApp(buildDevice());
        expect(pane(root).classList.contains("collapsed")).toBe(false);

        click(toggle(root));
        expect(pane(root).classList.contains("collapsed")).toBe(true);
        // The library DOM is retained (only clipped) — state is never lost.
        expect(library(root)).toBeTruthy();
        expect(library(root).querySelector(".device-sidebar")).toBeTruthy();
    });

    it("starts collapsed in USE mode and can be reopened (library retained, toggle accessible)", () => {
        const { root } = mountApp(buildDevice());
        switchToUse(root); // USE mode starts collapsed
        expect(pane(root).classList.contains("collapsed")).toBe(true);

        // Reopen via the edge toggle — must work while collapsed in USE mode.
        expect(toggle(root)).toBeTruthy();
        click(toggle(root));
        expect(pane(root).classList.contains("collapsed")).toBe(false);
        expect(library(root)).toBeTruthy();
        // Collapse again.
        click(toggle(root));
        expect(pane(root).classList.contains("collapsed")).toBe(true);
        // The controller surface remains mounted throughout.
        expect(contentArea(root).querySelector(".control-wrapper")).toBeTruthy();
    });

    it("collapsed rule genuinely removes the library column width (CSS width:0)", () => {
        const { root } = mountApp(buildDevice());
        switchToUse(root);
        const css = readFileSync(resolve("src/ui/styles.css"), "utf8");
        const collapsedRule = css.match(/\.sidebar-pane\.collapsed \.device-sidebar-wrap\s*\{[^}]*\}/);
        expect(collapsedRule).toBeTruthy();
        expect(collapsedRule?.[0]).toMatch(/width:\s*0/);
        // The default (open) library column has an explicit non-zero width.
        const openRule = css.match(/\.sidebar-pane \.device-sidebar-wrap\s*\{[^}]*\}/);
        expect(openRule?.[0]).toMatch(/width:\s*250px/);
    });
});
