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
    it("Routing-Slots behalten select/range/badge/checkbox-Naturen", () => {
        const root = mount();
        expect(root.querySelector(".mod-slot-source")!.tagName).toBe("SELECT");
        expect(root.querySelector(".mod-slot-dest")!.tagName).toBe("SELECT");
        expect(root.querySelector<HTMLInputElement>(".mod-slot-amount-slider")!.type).toBe("range");
        // §6 — das read-only number-Input ist weg; das signed-Badge bleibt span.
        expect(root.querySelector(".mod-slot-amount")).toBeNull();
        expect(root.querySelector<HTMLElement>(".mod-slot-amount-signed")!.tagName).toBe("SPAN");
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
        // §6 — der entfernte number-Input existiert nicht mehr.
        expect(firstSlot.querySelector("#mod-slot-amount-slot1")).toBeNull();
        expect(firstSlot.querySelector("#mod-slot-enable-slot1")).toBeTruthy();
        const firstSrc = root.querySelector('.mod-source-row[data-source-id="mod1"]')!;
        expect(firstSrc).toBeTruthy();
        expect(firstSrc.querySelector("#mod-src-wave-mod1")).toBeTruthy();
        expect(firstSrc.querySelector("#mod-src-rate-slider-mod1")).toBeTruthy();
        expect(firstSrc.querySelector("#mod-src-sync-mod1")).toBeTruthy();
    });

    it("der Slider setzt die fill-Variablen (bipolar), das signed-Badge folgt live", () => {
        const root = mount();
        const slider = root.querySelector<HTMLInputElement>(".mod-slot-amount-slider")!;
        slider.value = "60";
        slider.dispatchEvent(new Event("input", { bubbles: true }));
        expect(slider.style.getPropertyValue("--mod-fill-start")).toBe("50%");
        expect(slider.style.getPropertyValue("--mod-fill-end")).toBe("80%");
        // §6/§7 — das signed-Badge ist die einzige %-Anzeige und folgt direkt
        // dem Fader-Wert.
        const badge = root.querySelector<HTMLElement>(".mod-slot-amount-signed");
        expect(badge?.textContent).toBe("+60");
        slider.value = "-35";
        slider.dispatchEvent(new Event("input", { bubbles: true }));
        expect(badge?.textContent).toBe("-35");
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

describe("CSS-Guard — Bug 1 (dynamische LFO-Wellenform) + Bug 3 (kein Oranger Vollring)", () => {
    it("Bug 1 - der Wave-Field hat KEINEN statischen ::before-Squiggle mehr", () => {
        // Der Glyph ist jetzt ein echtes, dynamisches Inline-SVG (.mod-wave-glyph)
        // pro Waveform — keine CSS-only-Lösung mit Data-URI.
        expect(STYLES).toContain(".mod-wave-glyph");
        expect(STYLES).not.toMatch(/\.mod-field--wave::before/);
    });

    it("Bug 1 - der Glyph folgt der Zeilenhelligkeit (teal auf aktiven Zeilen)", () => {
        expect(STYLES).toMatch(/\.mod-source-row\.on \.mod-wave-glyph \{[\s\S]*?(#2dd4bf|--mm-accent-A)/);
    });

    it("Bug 3 - der modulierte Knob faerbt NICHT mehr den ganzen Ring orange", () => {
        // Keine Vollring-Recolour mehr auf led-Ring oder SVG-Ring.
        expect(STYLES).not.toMatch(/\.knob-body\.modulated \.knob-svg-ring/);
        expect(STYLES).not.toMatch(/\.knob-body\.modulated \.knob-led-ring/);
        // Die Amberspanne lebt ausschliesslich im .knob-mod-ring.
        expect(STYLES).toContain(".knob-mod-ring");
    });
});

describe("Aufräum-Auftrag (1-20) — Captions, Label-Geometrie, Fader, Sticky, Akzent-Regel", () => {
    it("es gibt KEINE 'Wave'/'Mode'/'Phase'-Captions mehr, nur 'Freq' + φ-Symbol", () => {
        const root = mount();
        const caps = Array.from(root.querySelectorAll<HTMLElement>(".mod-field-caption")).map((c) => c.textContent?.trim());
        expect(caps).toContain("Freq");
        expect(caps).toContain("φ");
        expect(caps).not.toContain("Wave");
        expect(caps).not.toContain("Mode");
        expect(caps).not.toContain("Phase");
        expect(caps.some((t) => t === "Freq")).toBe(true);
    });

    it("der LFO-Wave/Mode-Bereich führt weiterhin Glyph + Free|Sync-Segment", () => {
        const root = mount();
        const src = root.querySelector('.mod-source-row[data-source-id="mod1"]')!;
        expect(src.querySelector(".mod-wave-glyph")).toBeTruthy();
        expect(src.querySelector("#mod-src-sync-mod1")).toBeTruthy();
        expect(src.querySelector(".mod-seg-btn")).toBeTruthy();
    });

    it("§1 — Source-Label ist 64px breit (keine 88px mehr)", () => {
        expect(STYLES).toMatch(/\.mod-source-label \{[\s\S]*?flex: 0 0 64px/);
        expect(STYLES).toMatch(/\.mod-source-label \{[\s\S]*?width: 64px/);
    });

    it("§1 — Rows füllen die Spaltenbreite aus (width 100%, min-width 0)", () => {
        expect(STYLES).toMatch(/\.mod-source-row,\s*\n\.mod-slot-row \{[\s\S]*?width: 100%;/);
        expect(STYLES).toMatch(/\.mod-source-row,\s*\n\.mod-slot-row \{[\s\S]*?min-width: 0;/);
    });

    it("§1/§8 — Rate- und Amount-Fader laufen über die volle Faderauflage (width: 100%)", () => {
        expect(STYLES).toMatch(/\.mod-source-row \.mod-source-rate-slider \{[\s\S]*?width: 100%;/);
        expect(STYLES).toMatch(/\.mod-slot-row \.mod-slot-amount-slider \{[\s\S]*?width: 100%;/);
        expect(STYLES).toMatch(/\.mod-amount \{[\s\S]*?flex: 1 1 0%;/);
    });

    it("§3 — nur ROUTING-Zeilen tragen die teal-Active-Wash, Source-Zeilen nie", () => {
        // Kein kombiniertes Selektoren-Paar mehr (.mod-source-row.on, .mod-slot-row.on).
        expect(STYLES).not.toMatch(/\.mod-source-row\.on,\s*\n\.mod-slot-row\.on/);
        expect(STYLES).not.toMatch(/\.mod-source-row\.on \{[^\n]*rgba\(45, 212, 191/);
        expect(STYLES).toMatch(/\.mod-slot-row\.on \{[\s\S]*?rgba\(45, 212, 191/);
        // Die Label-Chip-Line bleibt neutral — kein .on-spezifischer teal-Chip.
        expect(STYLES).not.toMatch(/\.mod-source-row\.on > \.mod-source-label/);
        // Der Wave-Glyph folgt weiterhin der Zeilen-Helligkeit (teal auf .on).
        expect(STYLES).toMatch(/\.mod-source-row\.on \.mod-wave-glyph \{[\s\S]*?(#2dd4bf|--mm-accent-A)/);
    });

    it("§4 — highlightCrossColumn stützt sich NUR auf .mod-slot-row.on", () => {
        const root = mount();
        const chk = root.querySelector<HTMLInputElement>("#mod-slot-enable-slot1")!;
        chk.checked = true;
        chk.dispatchEvent(new Event("change", { bubbles: true }));
        const srcRow = root.querySelector('.mod-source-row[data-source-id="mod1"]');
        expect(srcRow?.classList.contains("source-linked")).toBe(true);
        expect(root.querySelector('.mod-source-row[data-source-id="mod1"]')?.classList.contains("on")).toBe(true);
    });

    it("§5 — source-linked bleibt full-width (Gradient + beide Spines + Label-Pill)", () => {
        expect(STYLES).toMatch(/\.mod-source-row\.source-linked \{[\s\S]*?inset 2px 0 0 var\(--mm-accent-B\), inset -2px 0 0 var\(--mm-accent-B-solid\)/);
        expect(STYLES).toMatch(/\.mod-source-row\.source-linked > \.mod-source-label \{/);
    });

    it("§7 — Routing trägt 'Amt' statt 'Amount'", () => {
        const root = mount();
        const caps = Array.from(root.querySelectorAll<HTMLElement>(".mod-route-cap")).map((c) => c.textContent?.trim());
        expect(caps).toContain("Amt");
        expect(caps).not.toContain("Amount");
    });

    it("§8 — der Amount-Fader deckt den vollen Bipolarweg ab (min/mid/max)", () => {
        const root = mount();
        const device = new Device("Travel");
        const ui = new ModMatrixUI({
            deviceLibrary: { currentDevice: device, saveCurrentDevice: () => {} },
            bindingManager: new BindingManager(device),
            nexusAdapter: new NexusAdapter(),
            history: new DeviceHistory({ currentDevice: device, saveCurrentDevice: () => {} } as never),
        });
        const container = ui.getContainer();
        const slider = container.querySelector<HTMLInputElement>("#mod-slot-amount-slider-slot1")!;
        expect(slider.min).toBe("-100");
        expect(slider.max).toBe("100");
        slider.value = "-100";
        slider.dispatchEvent(new Event("input", { bubbles: true }));
        expect(device.modulation.slots[0].amount).toBe(-1);
        slider.value = "0";
        slider.dispatchEvent(new Event("input", { bubbles: true }));
        expect(device.modulation.slots[0].amount).toBe(0);
        slider.value = "100";
        slider.dispatchEvent(new Event("input", { bubbles: true }));
        expect(device.modulation.slots[0].amount).toBe(1);
        document.body.innerHTML = "";
    });

    it("§9 — Section-Titles sind stikky in den Scroll-Spalten", () => {
        expect(STYLES).toMatch(/\.mod-section-title \{[\s\S]*?position: sticky;/);
        expect(STYLES).toMatch(/\.mod-section-title \{[\s\S]*?top: 0;/);
    });
});