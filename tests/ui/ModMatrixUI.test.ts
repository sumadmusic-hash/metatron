// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Device } from "../../src/core/model/Device";
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

function makeDeps(device: Device, onBakeRequested: () => void = vi.fn()) {
    const deviceLibrary = { currentDevice: device, saveCurrentDevice: vi.fn() };
    const history = new DeviceHistory(deviceLibrary as never);
    const ui = new ModMatrixUI({
        deviceLibrary,
        bindingManager: new BindingManager(device),
        nexusAdapter: new NexusAdapter(),
        history,
        onBakeRequested,
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

    it("bake button fires onBakeRequested", () => {
        const bakeSpy = vi.fn();
        const { ui } = makeDeps(makeDevice(), bakeSpy);
        const container = mount(ui);
        const bake = container.querySelector<HTMLButtonElement>(".mod-matrix-bake");
        expect(bake).toBeTruthy();
        bake?.click();
        expect(bakeSpy).toHaveBeenCalledTimes(1);
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