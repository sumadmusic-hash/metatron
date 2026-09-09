// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { Group } from "../../src/core/model/Group";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { EditorUI } from "../../src/ui/editor/EditorUI";
import { SurfaceUI } from "../../src/ui/surface/SurfaceUI";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { BindingManager } from "../../src/core/BindingManager";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { MidiMapping } from "../../src/midi/MidiMapping";

/** A device with one colored Group containing a knob, a switch and another knob. */
function buildDevice(): Device {
    const d = new Device("Synth");
    const group = new Group("FILTER", { x: 40, y: 40 }, { width: 420, height: 260 });
    group.color = "#ff8800";
    d.addGroup(group);

    const cutoff = new Control("knob", "CUTOFF", { x: 80, y: 90 });
    const res = new Control("knob", "RES", { x: 220, y: 90 });
    const bypass = new Control("switch", "BYPASS", { x: 360, y: 90 });
    d.addControl(cutoff);
    d.addControl(res);
    d.addControl(bypass);
    d.setControlGroup(cutoff.id, group.id);
    d.setControlGroup(res.id, group.id);
    d.setControlGroup(bypass.id, group.id);
    return d;
}

function mount(): { host: HTMLElement; device: Device; library: DeviceLibrary } {
    const device = buildDevice();
    const library = new DeviceLibrary();
    library.currentDevice = device;
    const host = document.createElement("div");
    document.body.appendChild(host);
    return { host, device, library };
}

function mountSurface(): {
    host: HTMLElement;
    device: Device;
    library: DeviceLibrary;
    onLocalChange: ReturnType<typeof vi.fn>;
    ui: SurfaceUI;
} {
    const { host, device, library } = mount();
    const onLocalChange = vi.fn();
    const ui = new SurfaceUI(
        library,
        new NexusAdapter(),
        new MidiAccess(),
        new BindingManager(device),
        new MidiMapping(device),
        onLocalChange,
        vi.fn()
    );
    ui.render(host);
    return { host, device, library, onLocalChange, ui };
}

function mountEditor(): { host: HTMLElement; device: Device; library: DeviceLibrary; ui: EditorUI } {
    const { host, device, library } = mount();
    const ui = new EditorUI(library);
    ui.render(host);
    return { host, device, library, ui };
}

beforeEach(() => {
    document.body.innerHTML = "";
});

describe("Group visibility in EDIT mode (editor object)", () => {

    it("renders a Group container with name and color", () => {
        const { host, device } = mountEditor();
        const group = host.querySelector(".group-box") as HTMLElement;
        expect(group).not.toBeNull();
        expect(group.dataset.grpId).toBe(device.groups.values().next().value.id);
        expect(group.querySelector(".group-name")?.textContent).toBe("FILTER");
        // Single source of truth — exactly one visible name, no floating label.
        expect(host.querySelectorAll(".group-name").length).toBe(1);
        expect(host.querySelector(".group-label")).toBeNull();
    });

    it("applies a larger, prominent font to the Group Name and keeps the delete button separate", () => {
        const { host } = mountEditor();
        const header = host.querySelector(".group-header") as HTMLElement;
        const name = header.querySelector(".group-name") as HTMLElement;
        const del = header.querySelector(".group-delete-btn") as HTMLElement;
        // Structural separation: name and delete are siblings in the same header
        // (a flex row), so the delete never overlaps the name.
        expect(name.parentElement).toBe(header);
        expect(del.parentElement).toBe(header);

        // The stylesheet applies a clearly larger title-style font (1.1rem,
        // weight 600) rather than the 11px metadata size.
        const css = readFileSync(resolve("src/ui/styles.css"), "utf8");
        const nameRule = css.match(/\.group-header \.group-name\s*\{[^}]*\}/);
        expect(nameRule).toBeTruthy();
        expect(nameRule?.[0]).toMatch(/font-size:\s*1\.1rem/);
        expect(nameRule?.[0]).toMatch(/font-weight:\s*600/);
        // The delete button is explicitly reset to static (in-flow) so the
        // legacy absolute rule cannot pull it on top of the name.
        const delRule = css.match(/\.group-header \.group-delete-btn\s*\{[^}]*\}/);
        expect(delRule?.[0]).toMatch(/position:\s*static/);
    });

    it("carries editor affordances (resize handle + color picker)", () => {
        const { host } = mountEditor();
        const group = host.querySelector(".group-box") as HTMLElement;
        expect(group.querySelector(".resize-handle")).not.toBeNull();
        expect(group.querySelector(".group-color-input")).not.toBeNull();
    });

    it("renders member Controls on top of the edit Group", () => {
        const { host } = mountEditor();
        const group = host.querySelector(".group-box") as HTMLElement;
        const firstControl = host.querySelector(".control-wrapper") as HTMLElement;
        expect(group).not.toBeNull();
        expect(firstControl).not.toBeNull();
        expect((group.compareDocumentPosition(firstControl) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
    });
});

describe("Group visibility in USE mode (finished surface)", () => {

    it("renders a Group in USE mode", () => {
        const { host } = mountSurface();
        const group = host.querySelector(".group-box.use-group") as HTMLElement;
        expect(group).not.toBeNull();
        expect(group.dataset.grpId).toBeDefined();
    });

    it("shows the Group name inside the Group Box in USE mode", () => {
        const { host } = mountSurface();
        const group = host.querySelector(".group-box.use-group") as HTMLElement;
        expect(group).not.toBeNull();
        // The name lives in the group-header, which is INSIDE the group box
        // (not a floating label positioned above it).
        const header = group.querySelector(":scope > .group-header") as HTMLElement;
        expect(header).not.toBeNull();
        const name = header.querySelector(":scope > .group-name") as HTMLElement;
        expect(name).not.toBeNull();
        expect(name.textContent).toBe("FILTER");
        // Exactly one visible group name — no floating duplicate.
        expect(host.querySelectorAll(".group-name").length).toBe(1);
        expect(host.querySelector(".group-label")).toBeNull();
    });

    it("keeps the Group name visible and hides the delete button in USE mode", () => {
        const { host } = mountSurface();
        const group = host.querySelector(".group-box.use-group") as HTMLElement;
        // Name is present (visible in USE).
        expect(group.querySelector(".group-name")?.textContent).toBe("FILTER");
        // No delete affordance is created on the performance surface.
        expect(group.querySelector(".group-delete-btn")).toBeNull();
        // The group header itself is not hidden.
        const header = group.querySelector(".group-header") as HTMLElement;
        expect(header).not.toBeNull();
        expect(getComputedStyle(header).display).not.toBe("none");
    });

    it("shows the Group color in USE mode", () => {
        const { host } = mountSurface();
        const group = host.querySelector(".group-box.use-group") as HTMLElement;
        const fill = group.children[0] as HTMLElement;
        // happy-dom serializes the color components with spaces, browsers may not.
        expect(fill.style.background.replace(/\s+/g, " ")).toBe("rgba(255, 136, 0, 0.12)");
    });

    it("renders the Group behind its member Controls", () => {
        const { host } = mountSurface();
        const group = host.querySelector(".group-box") as HTMLElement;
        const firstControl = host.querySelector(".control-wrapper") as HTMLElement;
        expect(group).not.toBeNull();
        expect(firstControl).not.toBeNull();
        // Group is a DOM sibling preceding the Controls → painted underneath.
        expect((group.compareDocumentPosition(firstControl) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
    });

    it("does not intercept pointer events destined for Controls", () => {
        const { host } = mountSurface();
        const group = host.querySelector(".group-box.use-group") as HTMLElement;
        expect(group.style.pointerEvents).toBe("none");
    });

    it("keeps a switch inside a Group toggleable", () => {
        const { device, onLocalChange, host } = mountSurface();
        const [, , bypass] = Array.from(device.controls.values());
        const sw = host.querySelector(".switch-body") as HTMLElement;
        sw.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(onLocalChange).toHaveBeenCalledWith(bypass.id, 1);
    });

    it("keeps a knob inside a Group draggable", () => {
        const { device, onLocalChange, host } = mountSurface();
        const [cutoff] = Array.from(device.controls.values());
        const knob = host.querySelector(".knob-body") as HTMLElement;
        knob.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientY: 100, bubbles: true }));
        knob.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientY: 80, bubbles: true }));
        knob.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
        expect(onLocalChange).toHaveBeenCalledWith(cutoff.id, 0.1);
    });

    it("hides all editor handles and tools in USE mode", () => {
        const { host } = mountSurface();
        const group = host.querySelector(".group-box.use-group") as HTMLElement;
        // No Group editor affordances
        expect(group.querySelector(".resize-handle")).toBeNull();
        expect(group.querySelector(".group-color-input")).toBeNull();
        // No Control editor furniture anywhere on the surface
        expect(host.querySelector(".control-wrapper.edit-mode")).toBeNull();
        expect(host.querySelector(".control-tools")).toBeNull();
        // The USE group is not the dashed/selected editor object
        expect(group.classList.contains("selected")).toBe(false);
    });

    it("keeps Control selection working inside a Group (USE action bar)", () => {
        const { host } = mountSurface();
        const control = host.querySelector(".control-wrapper") as HTMLElement;
        control.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        expect(control.classList.contains("selected")).toBe(true);
        expect(host.querySelector(".use-actions")).not.toBeNull();
    });
});