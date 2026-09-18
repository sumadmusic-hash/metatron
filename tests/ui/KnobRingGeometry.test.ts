// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { BindingManager } from "../../src/core/BindingManager";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { AppUI } from "../../src/ui/AppUI";
import { KNOB_ARC_END, KNOB_RADIUS } from "../../src/ui/surface/SurfaceUI";

const STYLES = readFileSync(join(process.cwd(), "src/ui/styles.css"), "utf8");

function loadStyles() {
    const style = document.createElement("style");
    style.textContent = STYLES;
    document.head.append(style);
}

function makeRingDevice() {
    const device = new Device("Ring");
    device.addControl(new Control("knob", "Cutoff", { x: 0, y: 0 }, "cut"));
    device.controls.get("cut")!.value = 0.37;
    return device;
}

function mount(device: Device, mode: "edit" | "use") {
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    lib.saveCurrentDevice();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const app = new AppUI(root, lib, new NexusAdapter(), new MidiAccess(), new BindingManager(device));
    app.render();
    if (mode === "use") {
        const toggle = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
            (b) => b.id === "mode-toggle-btn",
        );
        toggle!.click();
    }
    return root;
}

function svgRing(root: HTMLElement): SVGSVGElement {
    const svg = root.querySelector<SVGSVGElement>(`[data-ctl-id="cut"] .knob-svg-ring`);
    expect(svg).toBeTruthy();
    return svg!;
}

function pointer(root: HTMLElement): HTMLElement {
    const p = root.querySelector<HTMLElement>(`[data-ctl-id="cut"] .knob-position`);
    expect(p).toBeTruthy();
    return p!;
}

function track(root: HTMLElement): SVGCircleElement {
    const t = root.querySelector<SVGCircleElement>(`[data-ctl-id="cut"] .knob-svg-track`);
    expect(t).toBeTruthy();
    return t!;
}

function valueArc(root: HTMLElement): SVGCircleElement {
    const a = root.querySelector<SVGCircleElement>(`[data-ctl-id="cut"] .knob-svg-value`);
    expect(a).toBeTruthy();
    return a!;
}

function circumference(): number {
    return 2 * Math.PI * KNOB_RADIUS;
}

describe("G1 — USE glow ring rotated to match the conic EDIT ring", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
        document.head.innerHTML = "";
        localStorage.clear();
        loadStyles();
    });

    it("USE .knob-svg-ring transform ist rotate(135deg) — SVG-Dash startet bei 3 Uhr, nicht bei 12 Uhr", () => {
        const root = mount(makeRingDevice(), "use");
        expect(getComputedStyle(svgRing(root)).transform).toBe("rotate(135deg)");
    });

    it("Zeigerwinkel-Guard: EDIT und USE liefern denselben Winkel (-135 + value*270) und bleiben deckungsgleich", () => {
        const device = makeRingDevice();
        const edit = mount(device, "edit");
        const use = mount(device, "use");
        expect(pointer(use).style.transform).toBe(`rotate(${-135 + device.controls.get("cut")!.value * 270}deg)`);
        expect(pointer(edit).style.transform).toBe(pointer(use).style.transform);
    });

    it("G2 — Track zeichnet denselben 270°-Bogen wie der Wertbogen (kein geschlossener Vollkreis durch die Luecke)", () => {
        const root = mount(makeRingDevice(), "use");
        const expected = `${KNOB_ARC_END} ${circumference()}`;
        expect(track(root).getAttribute("stroke-dasharray")).toBe(expected);
    });

    it("G3 — Ringband liegt in USE auf denselben 82.5–91.5% des Sockels wie die EDIT-Maske", () => {
        const root = mount(makeRingDevice(), "use");
        expect(KNOB_RADIUS).toBe(43.5);
        expect(KNOB_ARC_END).toBeCloseTo(0.75 * 2 * Math.PI * KNOB_RADIUS, 10);
        expect(valueArc(root).getAttribute("r")).toBe(String(KNOB_RADIUS));
        expect(track(root).getAttribute("r")).toBe(String(KNOB_RADIUS));
        // Band: r ± stroke/2 = 41.25…45.75 → 82.5%…91.5% bei Sockelradius 50,
        // Außenkante 45.75 < 50 (kein Clipping). stroke-width steckt in der CSS.
        expect(STYLES).toMatch(/\.knob-svg-ring \.knob-svg-track\s*\{[^}]*stroke-width:\s*4\.5/);
    });
});