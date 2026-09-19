// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Device } from "../../src/core/model/Device";
import { BindingManager } from "../../src/core/BindingManager";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { DeviceHistory } from "../../src/core/history/DeviceHistory";
import { ModMatrixUI } from "../../src/ui/modmatrix/ModMatrixUI";

/**
 * Teil C (C11) — Smoke-Test für das rein visuelle ModMatrix-Redesign.
 * Der Redesign-Auftrag erzwingt: KEIN Elementtyp wechselt, keine
 * id / data-*-Attribute / geschützten Klassen verschwinden, und die
 * Akzent-Regel (A teal / B sky-blue für source-linked) bleibt im CSS.
 * Diese Suite liefert NEUE Behauptungen ausschliesslich in einer NEUEN
 * Datei — die bestehende ModMatrixUI.test.ts bleibt unangetastet.
 */

const STYLES = readFileSync(join(process.cwd(), "src/ui/styles.css"), "utf8");

function mount(): HTMLElement {
    const device = new Device("Redesign");
    const deviceLibrary = { currentDevice: device, saveCurrentDevice: () => {} };
    const ui = new ModMatrixUI({
        deviceLibrary,
        bindingManager: new BindingManager(device),
        nexusAdapter: new NexusAdapter(),
        history: new DeviceHistory(deviceLibrary as never),
    });
    const container = ui.getContainer();
    document.body.appendChild(container);
    return container;
}

beforeEach(() => {
    document.body.innerHTML = "";
});

describe("C11 — Elementtypen und geschützte Namen bleiben unangetastet", () => {
    it("Routing-Slots behalten select/range/number/checkbox-Naturen", () => {
        const root = mount();
        expect(root.querySelector(".mod-slot-source")!.tagName).toBe("SELECT");
        expect(root.querySelector(".mod-slot-dest")!.tagName).toBe("SELECT");
        expect(root.querySelector<HTMLInputElement>(".mod-slot-amount-slider")!.type).toBe("range");
        expect(root.querySelector<HTMLInputElement>(".mod-slot-amount")!.type).toBe("number");
        expect(root.querySelector<HTMLInputElement>(".mod-slot-enable")!.type).toBe("checkbox");
    });

    it("Source-Zeilen behalten select/range/number-Naturen + Mod-Klassen", () => {
        const root = mount();
        expect(root.querySelector(".mod-source-waveform")!.tagName).toBe("SELECT");
        expect(root.querySelector<HTMLInputElement>(".mod-source-phase")!.type).toBe("number");
        expect(root.querySelector<HTMLInputElement>(".mod-source-rate")!.type).toBe("number");
        expect(root.querySelector<HTMLInputElement>(".mod-source-rate-slider")!.type).toBe("range");
    });

    it("stabile ids und data-*-Attribute", () => {
        const root = mount();
        const firstSlot = root.querySelector('.mod-slot-row[data-slot-id="slot1"]')!;
        expect(firstSlot).toBeTruthy();
        expect(firstSlot.querySelector("#mod-slot-src-slot1")).toBeTruthy();
        expect(firstSlot.querySelector("#mod-slot-dest-slot1")).toBeTruthy();
        expect(firstSlot.querySelector("#mod-slot-amount-slider-slot1")).toBeTruthy();
        expect(firstSlot.querySelector("#mod-slot-amount-slot1")).toBeTruthy();
        expect(firstSlot.querySelector("#mod-slot-enable-slot1")).toBeTruthy();
        const firstSrc = root.querySelector('.mod-source-row[data-source-id="mod1"]')!;
        expect(firstSrc).toBeTruthy();
        expect(firstSrc.querySelector("#mod-src-wave-mod1")).toBeTruthy();
        expect(firstSrc.querySelector("#mod-src-rate-slider-mod1")).toBeTruthy();
        expect(firstSrc.querySelector("#mod-src-sync-mod1")).toBeTruthy();
    });

    it("der Slider setzt die fill-Variablen (bipolar), das %-Readout bleibt unberührt", () => {
        const root = mount();
        const slider = root.querySelector<HTMLInputElement>(".mod-slot-amount-slider")!;
        const num = root.querySelector<HTMLInputElement>(".mod-slot-amount")!;
        slider.value = "60";
        slider.dispatchEvent(new Event("input", { bubbles: true }));
        expect(slider.style.getPropertyValue("--mod-fill-start")).toBe("50%");
        expect(slider.style.getPropertyValue("--mod-fill-end")).toBe("80%");
        // num.value bleibt die rohe Zahl — das signed-Badge ist rein optisch.
        expect(num.value).toBe("60");
        const badge = root.querySelector<HTMLElement>(".mod-slot-amount-signed");
        expect(badge?.textContent).toBe("+60");
    });
});

describe("C11 — CSS-Guard: Design-Tokens, Layout-Geometrie und Akzent-Regel", () => {
    it("kehrt die --mm- Palette im :root ein", () => {
        expect(STYLES).toContain("--mm-canvas: #0d1117");
        expect(STYLES).toContain("--mm-panel: #161b22");
        expect(STYLES).toContain("--mm-accent-A: #2dd4bf");
        expect(STYLES).toContain("--mm-accent-B: #38bdf8");
        expect(STYLES).toContain("--mm-radius-lg: 8px");
        expect(STYLES).toContain("--mm-radius-pill: 13px");
    });

    it("behält die geschützte Layout-Geometrie (45vh, 46fr 54fr, Stack@1405px)", () => {
        expect(STYLES).toMatch(/\.mod-matrix-drawer\.open \{[\s\S]*?max-height: 45vh/);
        expect(STYLES).toMatch(/\.mod-matrix-drawer\.open \{[\s\S]*?grid-template-columns: 46fr 54fr/);
        expect(STYLES).toMatch(/@media \(max-width: 1405px\)/);
    });

    it("Akzent-Regel: .on-Zeilen = teal (A), .source-linked = sky-blue (B)", () => {
        // Quelleinblendung (cross-column) muss blau sein, NIE teal/cyan.
        expect(STYLES).toMatch(/\.mod-source-row\.source-linked \{[\s\S]*?(#0c4a6e|--mm-accent-B)/);
        // Aktive Zeilen sind teal.
        expect(STYLES).toMatch(/\.mod-slot-row\.on \{[\s\S]*?(#2dd4bf|--mm-accent-A)/);
    });
});