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
});