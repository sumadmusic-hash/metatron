// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { BindingManager } from "../../src/core/BindingManager";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { DeviceHistory } from "../../src/core/history/DeviceHistory";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { Storage } from "../../src/persistence/Storage";
import { ModMatrixUI, sourceLabel } from "../../src/ui/modmatrix/ModMatrixUI";
import { MAX_BAKE_BARS } from "../../src/modulation/BakeRenderer";
import { Toast } from "../../src/ui/Toast";

/**
 * Phase 2b — ModMatrixUI drawer (Source-Rack + Slot-Matrix) + history
 * integration: a matrix edit is recorded as ONE undoable device-scope action.
 * The ModSource accesses are written against the IST shape (flat
 * waveform/rateHz top-level, no `name`, no nested `lfo` sub-object).
 */

function makeDevice(): Device {
    return new Device("ModMatrix");
}

function makeDeps(device: Device, opts: { onMatrixChange?: () => void } = {}) {
    const deviceLibrary = { currentDevice: device, saveCurrentDevice: vi.fn(), saveDevice: vi.fn() };
    const history = new DeviceHistory(deviceLibrary as never);
    const ui = new ModMatrixUI({
        deviceLibrary,
        bindingManager: new BindingManager(device),
        nexusAdapter: new NexusAdapter(),
        history,
        onMatrixChange: opts.onMatrixChange,
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
    // Toast.container ist statisch gecacht; ein vorheriger Test (setTimeout
    // laeuft zwischen den Tests), der die Body-Wipe bereits erlebt hat, wuerde
    // sonst in einen detached Container schreiben und .toContain-Assertions
    // order-abhaengig machen. Frischer Container pro Test.
    (Toast as unknown as { container: HTMLElement | null }).container = null;
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
        expect(rows[0].textContent).toContain("LFO 1");
    });

    it("B30 - source rows are OFF unless an enabled slot routes that source", () => {
        const device = makeDevice();
        const { ui } = makeDeps(device);
        const container = mount(ui);
        // Nothing enabled → every source row is off.
        const rows = container.querySelectorAll<HTMLElement>(".mod-source-row");
        rows.forEach((row) => expect(row.classList.contains("on")).toBe(false));

        // Enable a slot whose source is mod1 → only that row goes ON.
        device.modulation.slots[0].enabled = true; // slot1 → source mod1
        ui.render();
        const src1 = container.querySelector<HTMLElement>('.mod-source-row[data-source-id="mod1"]')!;
        const src2 = container.querySelector<HTMLElement>('.mod-source-row[data-source-id="mod2"]')!;
        expect(src1.classList.contains("on")).toBe(true);
        expect(src2.classList.contains("on")).toBe(false);
    });

    it("renders one slot row per slot", () => {
        const device = makeDevice();
        const { ui } = makeDeps(device);
        const container = mount(ui);
        const rows = container.querySelectorAll(".mod-slot-row");
        expect(rows.length).toBe(device.modulation.slots.length);
    });

    it("sourceLabel maps the flat ModSource to id · TYPE", () => {
        expect(sourceLabel({ id: "mod1", type: "lfo" } as never, 0)).toBe("LFO 1");
        expect(sourceLabel({ id: "mod2", type: "macro" } as never, 1)).toBe("MACRO 2");
        expect(sourceLabel({ id: "mod3", type: "random" } as never, 2)).toBe("RND 3");
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

    it("B29 - bake dialog states that the bake starts at project start (tick 0)", () => {
        const { ui } = makeDeps(makeDevice());
        const container = mount(ui);
        const bake = container.querySelector<HTMLButtonElement>(".mod-matrix-bake");
        bake?.click();
        const note = container.querySelector<HTMLElement>(".mod-bake-note");
        expect(note).toBeTruthy();
        expect(note?.textContent).toContain("Tick 0");
        expect(note?.textContent).toContain("Nexus");
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

    it("B13 - bake dialog caps the bars input at MAX_BAKE_BARS", () => {
        const { ui } = makeDeps(makeDevice());
        const container = mount(ui);
        container.querySelector<HTMLButtonElement>(".mod-matrix-bake")?.click();
        const bars = container.querySelector<HTMLInputElement>("#mod-bake-bars");
        expect(bars?.max).toBe(String(MAX_BAKE_BARS));
        expect(bars?.min).toBe("1");
    });

    it("B13 - an absurd bars value is clamped before rendering (warning toast, no unbounded bake)", () => {
        const { ui } = makeDeps(makeDevice());
        const container = mount(ui);
        container.querySelector<HTMLButtonElement>(".mod-matrix-bake")?.click();

        const bars = container.querySelector<HTMLInputElement>("#mod-bake-bars");
        bars!.value = "999999";
        container.querySelector<HTMLButtonElement>(".mod-bake-render")?.click();

        // The handler clamps to MAX_BAKE_BARS and surfaces the cap - it never
        // feeds 999999 bars into the renderer (old behavior: unbounded loop).
        expect(document.body.innerText).toContain(`Bake capped to ${MAX_BAKE_BARS} bars.`);
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

    it("source-linked is persistent matrix state only; disabled hover/focus never links a source", () => {
        const device = makeDevice();
        const { ui } = makeDeps(device);
        const container = mount(ui);
        const slotRow = container.querySelector<HTMLElement>('.mod-slot-row[data-slot-id="slot1"]')!;
        const srcRow = container.querySelector<HTMLElement>('.mod-source-row[data-source-id="mod1"]')!;
        const destSel = container.querySelector<HTMLElement>("#mod-slot-dest-slot1")!;

        slotRow.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
        expect(slotRow.dataset.active).toBe("true");
        expect(srcRow.classList.contains("source-linked")).toBe(false);

        slotRow.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
        expect(slotRow.dataset.active).toBeUndefined();
        expect(srcRow.classList.contains("source-linked")).toBe(false);

        destSel.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
        expect(slotRow.dataset.active).toBe("true");
        expect(srcRow.classList.contains("source-linked")).toBe(false);

        destSel.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        expect(slotRow.dataset.active).toBeUndefined();
        expect(srcRow.classList.contains("source-linked")).toBe(false);
    });

    it("intra-row pointer moves do not flicker the transient active state", () => {
        const device = makeDevice();
        const { ui } = makeDeps(device);
        const container = mount(ui);
        const slotRow = container.querySelector<HTMLElement>('.mod-slot-row[data-slot-id="slot1"]')!;
        const srcSelect = container.querySelector<HTMLElement>("#mod-slot-src-slot1")!;
        const destSelect = container.querySelector<HTMLElement>("#mod-slot-dest-slot1")!;

        srcSelect.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: null }));
        expect(slotRow.dataset.active).toBe("true");

        srcSelect.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: destSelect }));
        expect(slotRow.dataset.active).toBe("true");
        destSelect.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: srcSelect }));
        expect(slotRow.dataset.active).toBe("true");

        destSelect.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
        expect(slotRow.dataset.active).toBeUndefined();
    });

    it("persistent source-linked survives hover/focus churn and clears immediately on disable", () => {
        const device = makeDevice();
        device.modulation.slots[0].enabled = true; // persistent link via .on
        const { ui } = makeDeps(device);
        const container = mount(ui);
        ui.highlightCrossColumn();
        const slotRow = container.querySelector<HTMLElement>('.mod-slot-row[data-slot-id="slot1"]')!;
        const srcRow = container.querySelector<HTMLElement>('.mod-source-row[data-source-id="mod1"]')!;

        slotRow.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
        expect(slotRow.dataset.active).toBe("true");
        expect(srcRow.classList.contains("source-linked")).toBe(true);

        const destSel = container.querySelector<HTMLElement>("#mod-slot-dest-slot1")!;
        destSel.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
        expect(slotRow.dataset.active).toBe("true");
        expect(srcRow.classList.contains("source-linked")).toBe(true);

        destSel.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        slotRow.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
        expect(slotRow.dataset.active).toBeUndefined();
        expect(srcRow.classList.contains("source-linked")).toBe(true);

        const chk = container.querySelector<HTMLInputElement>("#mod-slot-enable-slot1")!;
        chk.checked = false;
        chk.dispatchEvent(new Event("change", { bubbles: true }));
        expect(srcRow.classList.contains("source-linked")).toBe(false);
    });
});

describe("ModMatrixUI — history integration", () => {
    it("matrix edit is undoable and restores the matrix exactly", () => {
        const device = makeDevice();
        const { history, ui } = makeDeps(device);
        ui.toggleDrawer();
        ui.render();

        const snapshotBefore = history.captureDeviceState(device);
        device.modulation.slots[0].enabled = true;
        const snapshotAfter = history.captureDeviceState(device);
        history.record({
            type: "matrix.edit", scope: "device", deviceId: device.id,
            before: snapshotBefore, after: snapshotAfter,
        });

        expect(history.canUndoOnCurrentDevice).toBe(true);

        history.undo();
        expect(device.modulation.slots[0].enabled).toBe(false);

        history.redo();
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

    it("B36 - archived destination keeps a disabled, labelled '(deleted)' option that stays selected", () => {
        const device = makeDevice();
        const control = new Control("knob", "Cutoff");
        device.addControl(control);
        device.modulation.slots[0].destControlId = control.id;
        device.modulation.slots[0].enabled = true; // slot row stays ON
        device.removeControl(control.id); // soft delete / archive
        expect(control.archived).toBe(true);

        const { ui } = makeDeps(device);
        const container = mount(ui);

        const row = container.querySelector<HTMLElement>('.mod-slot-row[data-slot-id="slot1"]')!;
        expect(row.classList.contains("on")).toBe(true);
        const dest = container.querySelector<HTMLSelectElement>(".mod-slot-row .mod-slot-dest")!;
        const archivedOpt = Array.from(dest.options).find((o) => o.value === control.id)!;
        expect(archivedOpt).toBeTruthy();
        expect(archivedOpt.disabled).toBe(true);
        expect(archivedOpt.text).toContain("(deleted)");
        expect(archivedOpt.selected).toBe(true);
        // archived controls are hidden from fresh destinations: option list =
        // — none — + archived stale ref only (no duplicates/phantoms).
        expect(dest.options.length).toBe(2);
    });

    it("B36 - archived controls are absent from the destination list for a fresh slot", () => {
        const device = makeDevice();
        const dead = new Control("knob", "Dead");
        device.addControl(dead);
        device.removeControl(dead.id); // archive
        const live = new Control("knob", "Live");
        device.addControl(live);

        const { ui } = makeDeps(device);
        const container = mount(ui);

        const dest = container.querySelector<HTMLSelectElement>(".mod-slot-row .mod-slot-dest")!;
        const values = Array.from(dest.options).map((o) => o.value);
        expect(values).toContain(live.id);
        expect(values).not.toContain(dead.id);
        expect(values).toContain(""); // — none —
    });

    it("B36 - archived macro source keeps a disabled '(deleted)' option that stays selected", () => {
        const device = makeDevice();
        const control = new Control("knob", "Follow");
        device.addControl(control);
        device.modulation.sources[0].type = "macro";
        device.modulation.sources[0].sourceId = control.id;
        device.removeControl(control.id); // archive

        const { ui } = makeDeps(device);
        const container = mount(ui);

        const select = container.querySelector<HTMLSelectElement>(".mod-source-row .mod-source-macro")!;
        const archivedOpt = Array.from(select.options).find((o) => o.value === control.id)!;
        expect(archivedOpt).toBeTruthy();
        expect(archivedOpt.disabled).toBe(true);
        expect(archivedOpt.text).toContain("(deleted)");
        expect(archivedOpt.selected).toBe(true);
    });

    it("B36 - hard delete removes the option entirely and the slot reads — none —", () => {
        const device = makeDevice();
        const control = new Control("knob", "Cutoff");
        device.addControl(control);
        device.modulation.slots[0].destControlId = control.id;
        device.removeControl(control.id, true); // hard delete
        expect(device.controls.has(control.id)).toBe(false);
        expect(device.modulation.slots[0].destControlId).toBe(""); // clearModulationReferences

        const { ui } = makeDeps(device);
        const container = mount(ui);

        const dest = container.querySelector<HTMLSelectElement>(".mod-slot-row .mod-slot-dest")!;
        expect(dest.value).toBe("");
        expect(dest.selectedIndex).toBe(0);
        const values = Array.from(dest.options).map((o) => o.value);
        expect(values).not.toContain(control.id);
    });

    it("B37 - refresh() re-renders the drawer while it stays open", () => {
        const device = makeDevice();
        const control = new Control("knob", "Gone");
        device.addControl(control);
        device.modulation.slots[0].destControlId = control.id;
        const { ui } = makeDeps(device);
        const container = mount(ui);
        ui.toggleDrawer(); // drawer stays open across the structural change
        const before = Array.from(container.querySelectorAll(".mod-slot-dest")).length;

        // structural change after render (archive + save), drawer untouched
        device.removeControl(control.id);
        expect(container.querySelectorAll(".mod-slot-dest").length).toBe(before);

        ui.refresh(); // AppUI calls this on control create/delete/rename
        const after = container.querySelectorAll(".mod-slot-dest");
        expect(after.length).toBe(before);
        const opt = Array.from(after[0].options).find((o) => o.value === control.id)!;
        expect(opt.disabled).toBe(true);
        expect(opt.text).toContain("(deleted)");
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

/* ------------------------------------------------------------------ *
 *  Bug 1 — LFO-Waveform: echte, dynamische Welle
 * ------------------------------------------------------------------ */

describe("ModMatrixUI — Bug 1 LFO-Waveform-Glyph (echte, dynamische Welle)", () => {
    const WAVEFORMS = ["sine", "triangle", "saw", "square", "sampleHold", "smoothRandom"] as const;

    it("renders a real inline-SVG glyph per waveform, all pairwise distinct", () => {
        const device = makeDevice();
        const { ui } = makeDeps(device);
        const container = mount(ui);
        const distinct = new Set<string>();
        WAVEFORMS.forEach((waveform, i) => {
            device.modulation.sources[i].waveform = waveform;
            ui.render();
            const row = container.querySelector<HTMLElement>(`.mod-source-row[data-source-id="mod${i + 1}"]`)!;
            const glyph = row.querySelector(".mod-wave-glyph");
            expect(glyph).toBeTruthy(); // real element, NOT the old CSS-only squiggle
            expect(glyph!.tagName).toBe("svg");
            const d = glyph!.querySelector("path")?.getAttribute("d");
            expect(d).toBeTruthy();
            distinct.add(d!);
        });
        expect(distinct.size).toBe(WAVEFORMS.length);
    });

    it("the glyph mirrors the ACTUAL selected waveform and follows edits", () => {
        const device = makeDevice();
        const control = new Control("knob", "Cutoff");
        device.addControl(control);
        const { ui } = makeDeps(device);
        const container = mount(ui);
        const row = container.querySelector<HTMLElement>(`.mod-source-row[data-source-id="mod1"]`)!;
        const glyphD = () => row.querySelector(".mod-wave-glyph path")?.getAttribute("d");

        const before = glyphD();
        const select = row.querySelector<HTMLSelectElement>("#mod-src-wave-mod1")!;
        select.value = "saw";
        select.dispatchEvent(new Event("change", { bubbles: true }));

        // Persistence unchanged (editSource) …
        expect(device.modulation.sources[0].waveform).toBe("saw");
        // … and the freshly rendered row carries the new waveform's glyph.
        ui.render();
        const rowAfter = container.querySelector<HTMLElement>(`.mod-source-row[data-source-id="mod1"]`)!;
        const after = rowAfter.querySelector(".mod-wave-glyph path")?.getAttribute("d");
        expect(after).toBeTruthy();
        expect(after).not.toBe(before);
    });
});

/* ------------------------------------------------------------------ *
 *  Bug 2 — drei jeder Matrix-Edit wird via onMatrixChange gespiegelt
 * ------------------------------------------------------------------ */

describe("ModMatrixUI — Bug 2 meldet jeden Matrix-Edit an onMatrixChange", () => {
    it("slot enable (checkbox) fires the sync callback", () => {
        const device = makeDevice();
        const onMatrixChange = vi.fn();
        const { ui } = makeDeps(device, { onMatrixChange });
        const container = mount(ui);

        const chk = container.querySelector<HTMLInputElement>("#mod-slot-enable-slot1")!;
        chk.checked = true;
        chk.dispatchEvent(new Event("change", { bubbles: true }));
        expect(device.modulation.slots[0].enabled).toBe(true);
        expect(onMatrixChange).toHaveBeenCalledTimes(1);
    });

    it("destination change fires the sync callback", () => {
        const device = makeDevice();
        const control = new Control("knob", "Cutoff");
        device.addControl(control);
        const onMatrixChange = vi.fn();
        const { ui } = makeDeps(device, { onMatrixChange });
        const container = mount(ui);

        const dest = container.querySelector<HTMLSelectElement>("#mod-slot-dest-slot1")!;
        dest.value = control.id;
        dest.dispatchEvent(new Event("change", { bubbles: true }));
        expect(device.modulation.slots[0].destControlId).toBe(control.id);
        expect(onMatrixChange).toHaveBeenCalledTimes(1);
    });

    it("source edit (waveform) fires the sync callback", () => {
        const device = makeDevice();
        const onMatrixChange = vi.fn();
        const { ui } = makeDeps(device, { onMatrixChange });
        const container = mount(ui);

        const wave = container.querySelector<HTMLSelectElement>("#mod-src-wave-mod1")!;
        wave.value = "triangle";
        wave.dispatchEvent(new Event("change", { bubbles: true }));
        expect(device.modulation.sources[0].waveform).toBe("triangle");
        expect(onMatrixChange).toHaveBeenCalledTimes(1);
    });
});

/* ------------------------------------------------------------------ *
 *  Bug 5 — Sofort-Markierung des aktiven LFO (ohne Re-Render)
 * ------------------------------------------------------------------ */

describe("ModMatrixUI — Bug 5 aktiver LFO wird sofort markiert", () => {
    it("enabling a routing marks the source row IMMEDIATELY + links it", () => {
        const device = makeDevice();
        const { ui } = makeDeps(device);
        const container = mount(ui);
        const src1 = container.querySelector<HTMLElement>('.mod-source-row[data-source-id="mod1"]')!;
        expect(src1.classList.contains("on")).toBe(false);

        const chk = container.querySelector<HTMLInputElement>("#mod-slot-enable-slot1")!;
        chk.checked = true;
        chk.dispatchEvent(new Event("change", { bubbles: true }));

        // without ui.render() the left-column marking is already there
        expect(src1.classList.contains("on")).toBe(true);
        expect(src1.classList.contains("off")).toBe(false);
        expect(src1.classList.contains("source-linked")).toBe(true);

        chk.checked = false;
        chk.dispatchEvent(new Event("change", { bubbles: true }));
        expect(src1.classList.contains("on")).toBe(false);
        expect(src1.classList.contains("source-linked")).toBe(false);
    });

    it("switching a slot's source moves the active marking instantly", () => {
        const device = makeDevice();
        const { ui } = makeDeps(device);
        const container = mount(ui);
        const src1 = container.querySelector<HTMLElement>('.mod-source-row[data-source-id="mod1"]')!;
        const src2 = container.querySelector<HTMLElement>('.mod-source-row[data-source-id="mod2"]')!;

        const chk = container.querySelector<HTMLInputElement>("#mod-slot-enable-slot1")!;
        chk.checked = true;
        chk.dispatchEvent(new Event("change", { bubbles: true }));
        expect(src1.classList.contains("on")).toBe(true);
        expect(src2.classList.contains("on")).toBe(false);

        const srcSel = container.querySelector<HTMLSelectElement>("#mod-slot-src-slot1")!;
        srcSel.value = "mod2";
        srcSel.dispatchEvent(new Event("change", { bubbles: true }));

        expect(src1.classList.contains("on")).toBe(false);
        expect(src1.classList.contains("source-linked")).toBe(false);
        expect(src2.classList.contains("on")).toBe(true);
        expect(src2.classList.contains("source-linked")).toBe(true);
    });

    it("source-linked remains while any enabled slot still routes the same source", () => {
        const device = makeDevice();
        device.modulation.slots[0].enabled = true;
        device.modulation.slots[0].sourceId = "mod1";
        device.modulation.slots[1].enabled = true;
        device.modulation.slots[1].sourceId = "mod1";
        const { ui } = makeDeps(device);
        const container = mount(ui);
        ui.highlightCrossColumn();
        const src1 = container.querySelector<HTMLElement>('.mod-source-row[data-source-id="mod1"]')!;
        expect(src1.classList.contains("source-linked")).toBe(true);

        const slot1 = container.querySelector<HTMLInputElement>("#mod-slot-enable-slot1")!;
        slot1.checked = false;
        slot1.dispatchEvent(new Event("change", { bubbles: true }));
        expect(src1.classList.contains("source-linked")).toBe(true);

        const slot2 = container.querySelector<HTMLInputElement>("#mod-slot-enable-slot2")!;
        slot2.checked = false;
        slot2.dispatchEvent(new Event("change", { bubbles: true }));
        expect(src1.classList.contains("source-linked")).toBe(false);
    });
});

/* ------------------------------------------------------------------ *
 *  Bug 5 — LFO-Speed (free) + Mod-Depth live in Echtzeit (1 Undo pro Geste)
 * ------------------------------------------------------------------ */

describe("ModMatrixUI — Bug 5 Live-Slider (Echtzeit ohne Undo-Flut)", () => {
    it("depth slider writes slot.amount on EVERY input; ONE undo step on release", () => {
        const device = makeDevice();
        const { history, ui } = makeDeps(device);
        const container = mount(ui);
        const slider = container.querySelector<HTMLInputElement>("#mod-slot-amount-slider-slot1")!;
        expect(history.canUndoOnCurrentDevice).toBe(false);

        slider.value = "40";
        slider.dispatchEvent(new Event("input", { bubbles: true }));
        expect(device.modulation.slots[0].amount).toBe(0.4); // real-time write-through

        slider.value = "60";
        slider.dispatchEvent(new Event("input", { bubbles: true }));
        expect(device.modulation.slots[0].amount).toBe(0.6);
        // still mid-gesture → no undo entry yet (one snapshot, deferred commit)
        expect(history.canUndoOnCurrentDevice).toBe(false);

        slider.dispatchEvent(new Event("change", { bubbles: true }));
        expect(history.canUndoOnCurrentDevice).toBe(true); // exactly ONE gesture entry
    });

    it("free-rate slider writes src.rateHz on EVERY input", () => {
        const device = makeDevice();
        const { ui } = makeDeps(device);
        const container = mount(ui);
        const slider = container.querySelector<HTMLInputElement>("#mod-src-rate-slider-mod1")!;

        slider.value = "2";
        slider.dispatchEvent(new Event("input", { bubbles: true }));
        expect(device.modulation.sources[0].rateHz).toBe(2); // live, before any change event

        slider.value = "4.5";
        slider.dispatchEvent(new Event("input", { bubbles: true }));
        expect(device.modulation.sources[0].rateHz).toBe(4.5);
        // number readout follows live
        expect(container.querySelector<HTMLInputElement>("#mod-src-rate-mod1")!.value).toBe("4.5");
    });

    it("live slider persistence is debounced while the model updates immediately", () => {
        vi.useFakeTimers();
        try {
            const device = makeDevice();
            const { deviceLibrary, ui } = makeDeps(device);
            const container = mount(ui);
            const slider = container.querySelector<HTMLInputElement>("#mod-slot-amount-slider-slot1")!;

            slider.value = "20";
            slider.dispatchEvent(new Event("input", { bubbles: true }));
            slider.value = "70";
            slider.dispatchEvent(new Event("input", { bubbles: true }));

            expect(device.modulation.slots[0].amount).toBe(0.7);
            expect(deviceLibrary.saveDevice).not.toHaveBeenCalled();

            vi.advanceTimersByTime(99);
            expect(deviceLibrary.saveDevice).not.toHaveBeenCalled();

            vi.advanceTimersByTime(1);
            expect(deviceLibrary.saveDevice).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("pointer release flushes the final live-slider value and still records one undo step", () => {
        vi.useFakeTimers();
        try {
            const device = makeDevice();
            const { deviceLibrary, history, ui } = makeDeps(device);
            const container = mount(ui);
            const slider = container.querySelector<HTMLInputElement>("#mod-src-rate-slider-mod1")!;

            slider.value = "2";
            slider.dispatchEvent(new Event("input", { bubbles: true }));
            slider.value = "5";
            slider.dispatchEvent(new Event("input", { bubbles: true }));
            expect(device.modulation.sources[0].rateHz).toBe(5);
            expect(deviceLibrary.saveDevice).not.toHaveBeenCalled();

            slider.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
            expect(deviceLibrary.saveDevice).toHaveBeenCalledTimes(1);
            expect(history.canUndoOnCurrentDevice).toBe(true);

            vi.advanceTimersByTime(200);
            expect(deviceLibrary.saveDevice).toHaveBeenCalledTimes(1);

            slider.dispatchEvent(new Event("change", { bubbles: true }));
            expect(deviceLibrary.saveDevice).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("render flushes a pending live-slider matrix save before rebuilding", () => {
        vi.useFakeTimers();
        try {
            const device = makeDevice();
            const { deviceLibrary, ui } = makeDeps(device);
            const container = mount(ui);
            const slider = container.querySelector<HTMLInputElement>("#mod-slot-amount-slider-slot1")!;

            slider.value = "35";
            slider.dispatchEvent(new Event("input", { bubbles: true }));
            expect(deviceLibrary.saveDevice).not.toHaveBeenCalled();

            ui.render();
            expect(deviceLibrary.saveDevice).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("commitLiveEdit does not clobber a separate refresh() rebuild", () => {
        const device = makeDevice();
        const { history, ui } = makeDeps(device);
        const container = mount(ui);
        const slider = container.querySelector<HTMLInputElement>("#mod-slot-amount-slider-slot1")!;

        slider.value = "25";
        slider.dispatchEvent(new Event("input", { bubbles: true }));
        slider.dispatchEvent(new Event("change", { bubbles: true }));
        expect(history.canUndoOnCurrentDevice).toBe(true);
        expect(device.modulation.slots[0].amount).toBe(0.25);

        ui.refresh(); // rebuild (control create/delete/rename path) after a gesture
        const freshSlider = container.querySelector<HTMLInputElement>("#mod-slot-amount-slider-slot1")!;
        freshSlider.value = "-20";
        freshSlider.dispatchEvent(new Event("input", { bubbles: true }));
        expect(device.modulation.slots[0].amount).toBe(-0.2);
        freshSlider.dispatchEvent(new Event("change", { bubbles: true }));
        expect(history.canUndoOnCurrentDevice).toBe(true); // still exactly one per gesture
    });

    it("Bug 3 — der Matrix-Debounce-Save wird nach einem Device-Wechsel dem GEMERKTEN Device zugespeichert", () => {
        const deviceA = makeDevice();
        const lib = new DeviceLibrary();
        lib.currentDevice = deviceA;
        const saveSpy = vi.spyOn(lib, "saveDevice");
        const ui = new ModMatrixUI({
            deviceLibrary: lib,
            bindingManager: new BindingManager(deviceA),
            nexusAdapter: new NexusAdapter(),
            history: new DeviceHistory(lib),
        });
        const container = mount(ui);

        const slider = container.querySelector<HTMLInputElement>("#mod-slot-amount-slider-slot1")!;
        slider.value = "37";
        slider.dispatchEvent(new Event("input", { bubbles: true }));
        expect(deviceA.modulation.slots[0].amount).toBeCloseTo(0.37, 5);
        expect(saveSpy).not.toHaveBeenCalled(); // debounced — noch nichts geschrieben

        // Gerätewechsel VOR dem Debounce-Flush: der gemerkte pendingMatrixSave
        // gehört weiterhin deviceA und MUSS unter dessen Id persistiert werden.
        lib.currentDevice = new Device("ModMatrixB");
        ui.flushMatrixSave();

        expect(saveSpy).toHaveBeenCalledTimes(1);
        expect(saveSpy).toHaveBeenCalledWith(deviceA);
        expect(Storage.loadDevice(deviceA.id)!.modulation.slots[0].amount).toBeCloseTo(0.37, 5);
        expect(Storage.loadDevice(lib.currentDevice.id)).toBeUndefined();
    });
});
