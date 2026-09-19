// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { BindingManager } from "../../src/core/BindingManager";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { MidiMapping } from "../../src/midi/MidiMapping";
import { SurfaceUI } from "../../src/ui/surface/SurfaceUI";
import { createDefaultMatrix } from "../../src/core/modulation/ModulationTypes";

/**
 * Bug 2 — ModMatrix-→-Surface-Sync: refreshModulationStates() recomputes the
 * modulated state per rendered knob from the CURRENT persisted matrix WITHOUT
 * a full surface re-render (selection/DOM refs/gestures survive).
 * Bug 4 — a switch press toggles WITHOUT selecting the control (no use-actions
 * bar); clicking anywhere else on the control still selects it for Learn/MIDI.
 */

function makeDevice(): Device {
    const device = new Device("Surface");
    const cutoff = new Control("knob", "Cutoff", { x: 0, y: 0 }, "cutoff");
    cutoff.value = 0.5;
    device.addControl(cutoff);
    const reso = new Control("knob", "Reso", { x: 200, y: 0 }, "reso");
    reso.value = 0.2;
    device.addControl(reso);
    const track = new Control("switch", "Track", { x: 400, y: 0 }, "track");
    track.value = 0;
    device.addControl(track);
    device.modulation = createDefaultMatrix();
    return device;
}

function mount(device: Device) {
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    lib.saveCurrentDevice();
    const adapter = new NexusAdapter();
    const bm = new BindingManager(device);
    const changes: Array<[string, number]> = [];
    const surface = new SurfaceUI(
        lib,
        adapter,
        new MidiAccess(),
        bm,
        new MidiMapping(device),
        (id, value) => {
            // AppUI's onLocalChange persists the value on the control; the
            // SurfaceUI itself only reports the change. Mirror that here so
            // consecutive toggles flip like in production.
            if (device.controls.has(id)) device.controls.get(id)!.value = value;
            changes.push([id, value]);
        },
        () => {},
    );
    const root = document.createElement("div");
    document.body.appendChild(root);
    surface.render(root);
    return { lib, surface, root, changes };
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

function enable(device: Device, index: number, destControlId: string) {
    device.modulation.slots[index].enabled = true;
    device.modulation.slots[index].destControlId = destControlId;
}

describe("SurfaceUI — Bug 2 refreshModulationStates (Matrix → Surface, sofort & gezielt)", () => {
    it("no active route → no knob carries the modulated state", () => {
        const device = makeDevice();
        const { root, surface } = mount(device);
        expect(root.querySelector(".control-wrapper[data-ctl-id='cutoff']")!.classList.contains("modulated")).toBe(false);
        expect(root.querySelector(".control-wrapper[data-ctl-id='reso']")!.classList.contains("modulated")).toBe(false);
        // re-apply is a no-op
        surface.refreshModulationStates();
        expect(root.querySelectorAll(".control-wrapper.modulated").length).toBe(0);
    });

    it("an enabled route puts the modulated state on that knob only", () => {
        const device = makeDevice();
        enable(device, 0, "cutoff");
        const { root, surface } = mount(device);
        const cutoff = root.querySelector<HTMLElement>(".control-wrapper[data-ctl-id='cutoff']")!;
        const reso = root.querySelector<HTMLElement>(".control-wrapper[data-ctl-id='reso']")!;
        expect(cutoff.classList.contains("modulated")).toBe(true);
        expect(cutoff.querySelector(".knob-body")!.classList.contains("modulated")).toBe(true);
        expect(reso.classList.contains("modulated")).toBe(false);
        // re-apply keeps the state (idempotent)
        surface.refreshModulationStates();
        expect(cutoff.classList.contains("modulated")).toBe(true);
    });

    it("disabling the route clears the state immediately AND idles the live mod-ring", () => {
        const device = makeDevice();
        enable(device, 0, "cutoff");
        const { root, surface } = mount(device);
        // a live (non-idle) amber arc is active on the knob
        surface.applyModDisplay("cutoff", 0.7);
        const modRing = root.querySelector<HTMLElement>(".knob-mod-ring")!;
        expect(modRing.classList.contains("idle")).toBe(false);

        // slot.enabled flipped in the persisted matrix
        device.modulation.slots[0].enabled = false;
        surface.refreshModulationStates(); // ← AppUI wires this to onMatrixChange

        const cutoff = root.querySelector<HTMLElement>(".control-wrapper[data-ctl-id='cutoff']")!;
        expect(cutoff.classList.contains("modulated")).toBe(false);
        expect(cutoff.querySelector(".knob-body")!.classList.contains("modulated")).toBe(false);
        expect(modRing.classList.contains("idle")).toBe(true); // arc gone, no re-render
    });

    it("a destination change (A→B) relocates the state without re-rendering", () => {
        const device = makeDevice();
        enable(device, 0, "cutoff");
        const { root, surface } = mount(device);
        const cutoff = root.querySelector<HTMLElement>(".control-wrapper[data-ctl-id='cutoff']")!;
        const reso = root.querySelector<HTMLElement>(".control-wrapper[data-ctl-id='reso']")!;
        const cutoffBody = cutoff.querySelector<HTMLElement>(".knob-body");
        expect(cutoff.classList.contains("modulated")).toBe(true);
        const domRef = cutoff.querySelector(".knob-svg-ring"); // would die on re-render

        device.modulation.slots[0].destControlId = "reso";
        surface.refreshModulationStates();

        expect(cutoff.classList.contains("modulated")).toBe(false);
        expect(cutoffBody!.classList.contains("modulated")).toBe(false);
        expect(reso.classList.contains("modulated")).toBe(true);
        // NO full re-render happened — the same DOM node survived.
        expect(cutoff.querySelector(".knob-svg-ring")).toBe(domRef);
    });

    it("two active slots on the same destination keep it modulated while either stays active", () => {
        const device = makeDevice();
        enable(device, 0, "cutoff");
        enable(device, 1, "cutoff");
        device.modulation.slots[1].sourceId = device.modulation.sources[1].id;
        const { root, surface } = mount(device);
        const cutoff = root.querySelector<HTMLElement>(".control-wrapper[data-ctl-id='cutoff']")!;

        device.modulation.slots[0].enabled = false;
        surface.refreshModulationStates();
        expect(cutoff.classList.contains("modulated")).toBe(true); // slot1 still active

        device.modulation.slots[1].enabled = false;
        surface.refreshModulationStates();
        expect(cutoff.classList.contains("modulated")).toBe(false); // now truly idle
    });
});

describe("SurfaceUI — Bug 4 Switch: Toggle ohne Selection (use-actions bleiben zu)", () => {
    it("switch mousedown/pointerdown/click toggles WITHOUT selecting the control", () => {
        const device = makeDevice();
        const { root, changes } = mount(device);
        const wrapper = root.querySelector<HTMLElement>(".control-wrapper[data-ctl-id='track']")!;
        const body = wrapper.querySelector<HTMLElement>(".switch-body")!;

        body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
        body.dispatchEvent(new Event("click", { bubbles: true }));

        // Toggle happened
        expect(changes).toContainEqual(["track", 1]);
        expect(device.getControl("track")!.value).toBe(1);
        expect(body.classList.contains("on")).toBe(true);
        // …but the control was NEVER selected (no use-actions / Learn-MIDI bar)
        expect(wrapper.classList.contains("selected")).toBe(false);
    });

    it("clicking anywhere else on the control (label) still selects it", () => {
        const device = makeDevice();
        const { root } = mount(device);
        const wrapper = root.querySelector<HTMLElement>(".control-wrapper[data-ctl-id='track']")!;
        const label = wrapper.querySelector<HTMLElement>(".control-label-area")!;

        label.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        expect(wrapper.classList.contains("selected")).toBe(true);
    });

    it("a second switch toggle flips the value back (0) without selecting", () => {
        const device = makeDevice();
        const { root, changes } = mount(device);
        const wrapper = root.querySelector<HTMLElement>(".control-wrapper[data-ctl-id='track']")!;
        const body = wrapper.querySelector<HTMLElement>(".switch-body")!;

        body.click();
        body.click();
        expect(changes).toEqual([["track", 1], ["track", 0]]);
        expect(wrapper.classList.contains("selected")).toBe(false);
    });
});