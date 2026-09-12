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

    it("applies a larger, prominent font to the Group Name in the header", () => {
        const { host } = mountEditor();
        const header = host.querySelector(".group-header") as HTMLElement;
        const name = header.querySelector(".group-name") as HTMLElement;
        expect(name.parentElement).toBe(header);

        // The stylesheet applies a clearly larger title-style font (1.1rem,
        // weight 600) rather than the 11px metadata size.
        const css = readFileSync(resolve("src/ui/styles.css"), "utf8");
        const nameRule = css.match(/\.group-header \.group-name\s*\{[^}]*\}/);
        expect(nameRule).toBeTruthy();
        expect(nameRule?.[0]).toMatch(/font-size:\s*1\.1rem/);
        expect(nameRule?.[0]).toMatch(/font-weight:\s*600/);
    });

    it("keeps only the resize handle in-box; the edit toolbar is an external sibling", () => {
        const { host } = mountEditor();
        const group = host.querySelector(".group-box") as HTMLElement;
        expect(group.querySelector(".resize-handle")).not.toBeNull();
        // Color/hex/delete affordances moved OUT of the box (M20.11).
        expect(group.querySelector(".group-color-input")).toBeNull();
        expect(group.querySelector(".group-delete-btn")).toBeNull();
        // They live in an adjacent sibling toolbar, not inside the group box.
        const tools = host.querySelector(".group-tools") as HTMLElement;
        expect(tools).not.toBeNull();
        expect(tools.parentElement).toBe(group.parentElement);
        expect(tools.querySelector(":scope > .group-color-input")).not.toBeNull();
        expect(tools.querySelector(":scope > .group-delete-btn")).not.toBeNull();
        expect(tools.querySelector(":scope > .group-delete-btn")!.textContent).toBe("✕");
        // The toolbar carries the full edit set: color, hex + Copy/Paste, Delete.
        expect(tools.querySelector(":scope > .group-hex-row .color-hex-label")).not.toBeNull();
        expect(tools.querySelector(":scope > .group-hex-row .tool-btn")?.textContent).toBe("Copy");
    });

    it("renders member Controls on top of the edit Group", () => {
        const { host } = mountEditor();
        const group = host.querySelector(".group-box") as HTMLElement;
        const firstControl = host.querySelector(".control-wrapper") as HTMLElement;
        expect(group).not.toBeNull();
        expect(firstControl).not.toBeNull();
        expect((group.compareDocumentPosition(firstControl) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
    });

    it("M20.11 — the group edit toolbar is fully external; no in-box color rules remain", () => {
        const css = readFileSync(resolve("src/ui/styles.css"), "utf8");
        // The external toolbar rule exists and is JS-positioned (not box-relative).
        const toolsRule = css.match(/\.group-tools\s*\{[^}]*\}/);
        expect(toolsRule).toBeTruthy();
        expect(toolsRule?.[0]).toMatch(/position:\s*absolute/);
        // M20.15 — visibility is SELECTION-driven (not pointer-position):
        // hidden with `display:none`, revealed by the selected sibling box.
        expect(toolsRule?.[0]).toMatch(/display:\s*none/);
        expect(toolsRule?.[0]).not.toMatch(/opacity/);
        expect(toolsRule?.[0]).not.toMatch(/pointer-events/);
        expect(css).toMatch(/\.group-box\.selected\s*\+\s*\.group-tools\s*,\s*\.group-box:hover\s*\+\s*\.group-tools\s*,\s*\.group-tools:hover\s*,\s*\.group-tools:focus-within\s*\{\s*display:\s*flex;\s*\}/);
        // Hover/:focus-within rules remain as optional discoverability extras.
        expect(css).toMatch(/\.group-box:hover\s*\+\s*\.group-tools/);
        expect(css).toMatch(/\.group-tools:hover/);
        expect(css).toMatch(/\.group-tools:focus-within/);
        // Delete is pinned to the RIGHT END of the toolbar.
        const delRule = css.match(/\.group-tools \.group-delete-btn\s*\{[^}]*\}/);
        expect(delRule?.[0]).toMatch(/margin-left:\s*auto/);
        // The old in-box affordances are gone — no absolutely-positioned color
        // zones or delete button inside the group geometry.
        expect(css).not.toMatch(/\.group-box \.group-color-input/);
        expect(css).not.toMatch(/\.group-box \.group-hex-row/);
        expect(css).not.toMatch(/\.group-box \.group-delete-btn/);
        expect(css).not.toMatch(/\.group-header \.group-delete-btn/);
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
        // The external edit toolbar is not rendered on the performance surface.
        expect(host.querySelector(".group-tools")).toBeNull();
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

describe("M20.7 — Group name is always light in USE mode", () => {

    it("renders a dark group's name light in USE mode", () => {
        const { host, device, ui } = mountSurface();
        const group = device.groups.values().next().value as Group;
        group.color = "#101030";
        host.innerHTML = "";
        ui.render(host);
        const name = host.querySelector(".group-box.use-group .group-name") as HTMLElement;
        expect(name.style.color).toBe("#fff");
    });

    it("does not let a light group color darken the name in USE mode", () => {
        const { host, device, ui } = mountSurface();
        // so light that contrastTextColor(...) would return near-black (#101010)
        const group = device.groups.values().next().value as Group;
        group.color = "#ffffaa";
        host.innerHTML = "";
        ui.render(host);
        const name = host.querySelector(".group-box.use-group .group-name") as HTMLElement;
        expect(name.style.color).toBe("#fff");
        expect(name.style.color).not.toBe("#101010");
    });

    it("keeps EDIT mode unchanged (name still inherits the light theme color)", () => {
        const { host } = mountEditor();
        const name = host.querySelector(".group-box .group-name") as HTMLElement;
        // No inline force in EDIT mode — the fix did not leak out of USE mode.
        expect(name.style.color).toBe("");
    });
});

describe("M20.15 — the group toolbar stays visible via Group SELECTION, not hover", () => {

    /** Injects the real `.group-tools` visibility rules from styles.css into a
     *  live <style> element so computed `display` reflects the production CSS. */
    function injectGroupToolsRules(): string {
        const css = readFileSync(resolve("src/ui/styles.css"), "utf8");
        const base = css.match(/\.group-tools\s*\{[^}]*\}/)![0];
        const reveal = css.match(
            /\.group-box\.selected\s*\+\s*\.group-tools\s*,\s*\.group-box:hover\s*\+\s*\.group-tools\s*,\s*\.group-tools:hover\s*,\s*\.group-tools:focus-within\s*\{[^}]*\}/
        )![0];
        const style = document.createElement("style");
        style.textContent = `${base}${reveal}`;
        document.head.appendChild(style);
        return css;
    }

    it("shows the toolbar on selection and hides it again on deselection", () => {
        const { host } = mountEditor();
        injectGroupToolsRules();
        const box = host.querySelector<HTMLElement>(".group-box")!;
        const tools = host.querySelector<HTMLElement>(".group-tools")!;

        // 1. Grundzustand: `display: none`.
        expect(getComputedStyle(tools).display).toBe("none");

        // 2+3. pointerdown wählt die Group aus und enthüllt die Toolbar.
        box.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 60, clientY: 60, button: 0, bubbles: true, cancelable: true }));
        expect(box.classList.contains("selected")).toBe(true);
        expect(getComputedStyle(tools).display).toBe("flex");

        // 4. Kein Hover nötig: Verlassen der Box ändert nichts.
        document.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 900, clientY: 900, bubbles: true }));
        expect(box.classList.contains("selected")).toBe(true);
        expect(getComputedStyle(tools).display).toBe("flex");

        // 5+6. Klick auf leere Canvas-Fläche deselektiert und verbirgt die Toolbar.
        const inner = host.querySelector(".editor-canvas-inner")!;
        inner.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        expect(box.classList.contains("selected")).toBe(false);
        expect(getComputedStyle(tools).display).toBe("none");
    });

    it("keeps the toolbar clickable when visible and leaves the control toolbar untouched", () => {
        const { host, device } = mountEditor();
        injectGroupToolsRules();
        const box = host.querySelector<HTMLElement>(".group-box")!;
        const tools = host.querySelector<HTMLElement>(".group-tools")!;
        const groupEl = host.querySelector<HTMLElement>(".group-box")!;

        box.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 60, clientY: 60, button: 0, bubbles: true, cancelable: true }));
        expect(getComputedStyle(tools).display).toBe("flex");
        // No pointer-events blocking in the visible state.
        expect(getComputedStyle(tools).pointerEvents).not.toBe("none");

        // Delete innerhalb der Toolbar funktioniert weiterhin (Model + DOM weg).
        const del = tools.querySelector<HTMLElement>(".group-delete-btn")!;
        del.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        expect(device.getGroup(groupEl.dataset.grpId!)).toBeUndefined();
        expect(host.querySelector(".group-box")).toBeNull();

        // Die Control-Toolbar-Mechanik ist unverändert (display-gesteuert via Selection).
        const css = readFileSync(resolve("src/ui/styles.css"), "utf8");
        expect(css).toMatch(/\.control-wrapper\.selected \.control-tools\s*\{\s*display:\s*flex;\s*\}/);
    });

    it("does not regress Group drag: selection still fires before a drag starts", () => {
        const { host } = mountEditor();
        injectGroupToolsRules();
        const box = host.querySelector<HTMLElement>(".group-box")!;
        const tools = host.querySelector<HTMLElement>(".group-tools")!;

        // Drag-Geste: pointerdown + Bewegung → Gruppe wandert, Toolbar bleibt sichtbar.
        box.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 50, clientY: 50, button: 0, bubbles: true, cancelable: true }));
        document.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 90, clientY: 90, bubbles: true, cancelable: true }));
        document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true, cancelable: true }));
        expect(box.classList.contains("selected")).toBe(true);
        expect(getComputedStyle(tools).display).toBe("flex");
    });
});