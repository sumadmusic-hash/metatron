// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { BindingManager } from "../../src/core/BindingManager";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { DeviceHistory } from "../../src/core/history/DeviceHistory";
import { ModMatrixUI, sourceLabel } from "../../src/ui/modmatrix/ModMatrixUI";

/**
 * Phase 2b — ModMatrixUI drawer (Source-Rack + Slot-Matrix) + history
 * integration: a matrix edit is recorded as ONE undoable device-scope action.
 * The ModSource accesses are written against the IST shape (flat
 * waveform/rateHz top-level, no `name`, no nested `lfo` sub-object).
 */

function makeDevice(): Device {
    return new Device("ModMatrix");
}

function makeDeps(device: Device) {
    const deviceLibrary = { currentDevice: device, saveCurrentDevice: vi.fn() };
    const history = new DeviceHistory(deviceLibrary as never);
    const ui = new ModMatrixUI({
        deviceLibrary,
        bindingManager: new BindingManager(device),
        nexusAdapter: new NexusAdapter(),
        history,
    });
    return { deviceLibrary, history, ui };
}

function mount(ui: ModMatrixUI): HTMLElement {
    const container = ui.getContainer();
    document.body.appendChild(container);
    return container;
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

describe("ModMatrixUI — drawer", () => {
function lookupLabelFor(root: HTMLElement, input: Element): HTMLLabelElement | null {
    return Array.from(root.querySelectorAll<HTMLLabelElement>("label")).find(
        (label) => label.contains(input),
    ) ?? null;
}

    it("getContainer mounts the drawer with source rack and slot matrix", () => {
        const device = makeDevice();
        const { ui } = makeDeps(device);
        const container = ui.getContainer();
        document.body.appendChild(container);
        expect(container.className).toContain("mod-matrix-drawer");
        expect(container.querySelector(".mod-source-rack")).toBeTruthy();
        expect(container.querySelector(".mod-slot-matrix")).toBeTruthy();
    });

    it("renders one source row per source with a sourceLabel", () => {
        const device = makeDevice();
        const { ui } = makeDeps(device);
        const container = mount(ui);
        const rows = container.querySelectorAll(".mod-source-row");
        expect(rows.length).toBe(device.modulation.sources.length);
        expect(rows[0].textContent).toContain("mod1");
    });

    it("renders one slot row per slot", () => {
        const device = makeDevice();
        const { ui } = makeDeps(device);
        const container = mount(ui);
        const rows = container.querySelectorAll(".mod-slot-row");
        expect(rows.length).toBe(device.modulation.slots.length);
    });

    it("sourceLabel maps the flat ModSource to id · TYPE", () => {
        expect(sourceLabel({ id: "mod1", type: "lfo" } as never, 0)).toBe("mod1 · LFO");
        expect(sourceLabel({ id: "mod2", type: "macro" } as never, 1)).toBe("mod2 · MACRO");
        expect(sourceLabel({ id: "mod3", type: "random" } as never, 2)).toBe("mod3 · RND");
    });

    it("bake button opens the bake dialog", () => {
        const { ui } = makeDeps(makeDevice());
        const container = mount(ui);
        const bake = container.querySelector<HTMLButtonElement>(".mod-matrix-bake");
        expect(bake).toBeTruthy();
        bake?.click();
        expect(container.querySelector(".mod-bake-dialog")).toBeTruthy();
        expect(container.querySelector<HTMLInputElement>(".mod-bake-bars")).toBeTruthy();
        expect(container.querySelector<HTMLSelectElement>(".mod-bake-grid")).toBeTruthy();
    });

    it("FIX 11 - the bake dialog controls carry stable ids and their labels wrap the control (no htmlFor / for=)", () => {
        const { ui } = makeDeps(makeDevice());
        const container = mount(ui);

        const bake = container.querySelector<HTMLButtonElement>(".mod-matrix-bake");
        expect(bake).toBeTruthy();
        bake?.click();

        const bars = container.querySelector<HTMLInputElement>("#mod-bake-bars");
        expect(bars).toBeTruthy();
        expect(bars?.id).toBe("mod-bake-bars");
        expect(bars?.name).toBe("bars");
        const barsLabel = lookupLabelFor(container, bars!);
        expect(barsLabel).toBeTruthy();
        expect(barsLabel?.htmlFor).toBe("");
        expect(barsLabel?.control).toBe(bars);

        const grid = container.querySelector<HTMLSelectElement>("#mod-bake-grid");
        expect(grid).toBeTruthy();
        expect(grid?.id).toBe("mod-bake-grid");
        expect(grid?.name).toBe("grid");
        const gridLabel = lookupLabelFor(container, grid!);
        expect(gridLabel).toBeTruthy();
        expect(gridLabel?.htmlFor).toBe("");
        expect(gridLabel?.control).toBe(grid);
    });

    it("bake with no open document surfaces an error toast", () => {
        const { ui } = makeDeps(makeDevice());
        const container = mount(ui);
        const bake = container.querySelector<HTMLButtonElement>(".mod-matrix-bake");
        bake?.click();
        const renderBtn = container.querySelector<HTMLButtonElement>(".mod-bake-render");
        expect(renderBtn).toBeTruthy();
        renderBtn?.click();
        expect(document.body.textContent).toContain("No open document — cannot bake.");
    });

    it("M1 - syncRowHeights aligns each routing row to its paired source row", () => {
        const device = makeDevice();
        const { ui } = makeDeps(device);
        const container = mount(ui);
        const srcRows = container.querySelectorAll<HTMLElement>(".mod-source-row");
        const slotRows = container.querySelectorAll<HTMLElement>(".mod-slot-row");
        expect(device.modulation.sources.length).toBe(srcRows.length);
        expect(device.modulation.slots.length).toBe(slotRows.length);

        // happy-dom has no layout engine (offsetHeight === 0), so the sync's
        // explicit-height fallback drives the pairing in tests.
        srcRows[0].style.height = "120px";
        srcRows[1].style.height = "64px";
        ui.syncRowHeights();

        expect(slotRows[0].style.minHeight).toBe("120px");
        expect(slotRows[1].style.minHeight).toBe("64px");
        expect(slotRows[2].style.minHeight).toBe("");
    });

    it("O1 - an enabled routing slot lifts its source row across columns", () => {
        const device = makeDevice();
        device.modulation.slots[0].enabled = true; // slot1 -> mod1
        const { ui } = makeDeps(device);
        const container = mount(ui);
        ui.highlightCrossColumn();

        const src1 = container.querySelector<HTMLElement>('.mod-source-row[data-source-id="mod1"]')!;
        const src2 = container.querySelector<HTMLElement>('.mod-source-row[data-source-id="mod2"]')!;
        expect(src1.classList.contains("source-linked")).toBe(true);
        expect(src2.classList.contains("source-linked")).toBe(false);
    });

    it("O1 - hover/focus (data-active) transiently links the source row", () => {
        const device = makeDevice();
        const { ui } = makeDeps(device);
        const container = mount(ui);
        const slotRow = container.querySelector<HTMLElement>('.mod-slot-row[data-slot-id="slot1"]')!;
        const srcRow = container.querySelector<HTMLElement>('.mod-source-row[data-source-id="mod1"]')!;

        slotRow.dispatchEvent(new Event("pointerover", { bubbles: true }));
        expect(slotRow.dataset.active).toBe("true");
        ui.highlightCrossColumn();
        expect(srcRow.classList.contains("source-linked")).toBe(true);

        slotRow.dispatchEvent(new Event("pointerout", { bubbles: true }));
        expect(slotRow.dataset.active).toBeUndefined();
        ui.highlightCrossColumn();
        expect(srcRow.classList.contains("source-linked")).toBe(false);
    });
});

describe("ModMatrixUI — history integration", () => {
    it("a source-row enable toggle records ONE undoable matrix.edit and restores exactly on undo", () => {
        const device = makeDevice();
        const { history, ui } = makeDeps(device);
        const container = mount(ui);

        const checkbox = container.querySelector<HTMLInputElement>(".mod-source-row .mod-source-enable");
        expect(checkbox).toBeTruthy();
        expect(device.modulation.sources[0].enabled).toBe(false);

        checkbox!.checked = true;
        checkbox!.dispatchEvent(new Event("change", { bubbles: true }));
        expect(device.modulation.sources[0].enabled).toBe(true);

        expect(history.canUndoOnCurrentDevice).toBe(true);

        history.undo();
        expect(device.modulation.sources[0].enabled).toBe(false);
    });

    it("matrix edit is undoable and restores the matrix exactly", () => {
        const device = makeDevice();
        const { history, ui } = makeDeps(device);
        ui.toggleDrawer();
        ui.render();

        const snapshotBefore = history.captureDeviceState(device);
        device.modulation.sources[0].enabled = true;
        device.modulation.slots[0].enabled = true;
        const snapshotAfter = history.captureDeviceState(device);
        history.record({
            type: "matrix.edit", scope: "device", deviceId: device.id,
            before: snapshotBefore, after: snapshotAfter,
        });

        expect(history.canUndoOnCurrentDevice).toBe(true);

        history.undo();
        expect(device.modulation.sources[0].enabled).toBe(false);
        expect(device.modulation.slots[0].enabled).toBe(false);

        history.redo();
        expect(device.modulation.sources[0].enabled).toBe(true);
        expect(device.modulation.slots[0].enabled).toBe(true);
    });
});

describe("ModMatrixUI — dead-reference selects and rate clamping", () => {
    it("destination select leads with an explicit — none — option", () => {
        const device = makeDevice();
        const control = new Control("knob", "Cutoff");
        device.addControl(control);
        const { ui } = makeDeps(device);
        const container = mount(ui);

        const dest = container.querySelector<HTMLSelectElement>(".mod-slot-row .mod-slot-dest");
        expect(dest).toBeTruthy();
        expect(dest?.options[0].value).toBe("");
        expect(dest?.options[0].text).toContain("none");
        expect(dest?.options.length).toBe(2); // none + the one real control
    });

    it("selects — none — when the destination reference is empty or dead", () => {
        const device = makeDevice();
        const control = new Control("knob", "Cutoff");
        device.addControl(control);
        const { ui } = makeDeps(device);
        const container = mount(ui);

        let dest = container.querySelector<HTMLSelectElement>(".mod-slot-row .mod-slot-dest");
        expect(dest?.selectedIndex).toBe(0);

        device.modulation.slots[0].destControlId = "dead-control";
        ui.render();
        dest = container.querySelector<HTMLSelectElement>(".mod-slot-row .mod-slot-dest");
        expect(dest?.selectedIndex).toBe(0);
        expect(dest?.value).toBe("");
    });

    it("selects the real control when the destination reference resolves", () => {
        const device = makeDevice();
        const control = new Control("knob", "Cutoff");
        device.addControl(control);
        device.modulation.slots[0].destControlId = control.id;
        const { ui } = makeDeps(device);
        const container = mount(ui);

        const dest = container.querySelector<HTMLSelectElement>(".mod-slot-row .mod-slot-dest");
        expect(dest?.value).toBe(control.id);
        expect(dest?.selectedIndex).toBe(1);
    });

    it("macro source select leads with — none — and keeps it for dead refs", () => {
        const device = makeDevice();
        const control = new Control("knob", "Cutoff");
        device.addControl(control);
        device.modulation.sources[0].type = "macro";
        device.modulation.sources[0].sourceId = "";
        const { ui } = makeDeps(device);
        const container = mount(ui);

        let select = container.querySelector<HTMLSelectElement>(".mod-source-row .mod-source-macro");
        expect(select).toBeTruthy();
        expect(select?.options[0].value).toBe("");
        expect(select?.options[0].text).toContain("none");
        expect(select?.selectedIndex).toBe(0);

        device.modulation.sources[0].sourceId = "dead-control";
        ui.render();
        select = container.querySelector<HTMLSelectElement>(".mod-source-row .mod-source-macro");
        expect(select?.selectedIndex).toBe(0);
        expect(select?.value).toBe("");

        device.modulation.sources[0].sourceId = control.id;
        ui.render();
        select = container.querySelector<HTMLSelectElement>(".mod-source-row .mod-source-macro");
        expect(select?.value).toBe(control.id);
    });

    function rateState(device: Device) {
        const { ui } = makeDeps(device);
        const container = mount(ui);
        const rate = container.querySelector<HTMLInputElement>(".mod-source-row .mod-source-rate");
        const slider = container.querySelector<HTMLInputElement>(".mod-source-row .mod-source-rate-slider");
        expect(rate).toBeTruthy();
        expect(slider).toBeTruthy();
        return { rate: rate!, slider: slider!, container };
    }

    it("rate number input exposes the engine range 0.01–20", () => {
        const device = makeDevice();
        const { rate } = rateState(device);
        expect(rate.min).toBe("0.01");
        expect(rate.max).toBe("20");
    });

    it("rate below the floor clamps to 0.01 and syncs the slider", () => {
        const device = makeDevice();
        const { rate, slider } = rateState(device);
        rate.value = "0.005";
        rate.dispatchEvent(new Event("change", { bubbles: true }));
        expect(device.modulation.sources[0].rateHz).toBe(0.01);
        expect(rate.value).toBe("0.01");
        expect(slider.value).toBe("0.01");
    });

    it("rate above the ceiling clamps to 20 and syncs the slider", () => {
        const device = makeDevice();
        const { rate, slider } = rateState(device);
        rate.value = "45";
        rate.dispatchEvent(new Event("change", { bubbles: true }));
        expect(device.modulation.sources[0].rateHz).toBe(20);
        expect(rate.value).toBe("20");
        expect(slider.value).toBe("20");
    });

    it("invalid rate input falls back to the floor 0.01", () => {
        const device = makeDevice();
        const { rate, slider } = rateState(device);
        rate.value = "";
        rate.dispatchEvent(new Event("change", { bubbles: true }));
        expect(device.modulation.sources[0].rateHz).toBe(0.01);
        expect(rate.value).toBe("0.01");
        expect(slider.value).toBe("0.01");
    });

    it("a valid in-range rate is written through unchanged", () => {
        const device = makeDevice();
        const { rate, slider } = rateState(device);
        rate.value = "4.5";
        rate.dispatchEvent(new Event("change", { bubbles: true }));
        expect(device.modulation.sources[0].rateHz).toBe(4.5);
        expect(rate.value).toBe("4.5");
        expect(slider.value).toBe("4.5");
    });
});