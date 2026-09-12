import { describe, it, expect } from "vitest";
import { resolveControlForBinding } from "../../../src/core/instrument/InstrumentPresetImport";
import type {
    BindingMatchableControl,
    BindingMatchableDevice,
} from "../../../src/core/instrument/InstrumentPresetImport";

/**
 * M23.2 — unit tests for the PURE destination-control matcher.
 * No Nexus, no Device, no BindingManager: plain structural doubles only.
 * (Vitest/oxc note: plain `function` declarations, none after a describe.)
 */

function control(
    partial: Partial<BindingMatchableControl> & { id: string; name: string; type: "knob" | "switch" },
): BindingMatchableControl {
    return { nameSource: undefined, archived: false, ...partial };
}

function makeDevice(controls: BindingMatchableControl[]): BindingMatchableDevice {
    return {
        id: "dev_fresh",
        controls: new Map(controls.map((c) => [c.id, c])),
        getControl: (id: string) => controls.find((c) => c.id === id),
    };
}

function bindingWith(
    partial: Partial<Parameters<typeof resolveControlForBinding>[0]> = {},
): Parameters<typeof resolveControlForBinding>[0] {
    return {
        controlId: "ctl_source_1234",
        controlName: undefined,
        controlType: undefined,
        controlNameSource: undefined,
        ...partial,
    };
}

describe("resolveControlForBinding — M23.2 step 1: exact controlId", () => {
    it("same id → matchedBy: id (deterministic, same-device import)", () => {
        const dest = control({ id: "ctl_dest_abcd", name: "Cutoff", type: "knob" });
        const result = resolveControlForBinding(bindingWith({ controlId: dest.id }), makeDevice([dest]));
        expect(result).toEqual({ ok: true, controlId: dest.id, matchedBy: "id" });
    });

    it("exact id wins even when a signature would also match", () => {
        const a = control({ id: "ctl_same_1", name: "Cutoff", type: "knob" });
        const b = control({ id: "ctl_same_2", name: "OTHER", type: "knob" });
        const result = resolveControlForBinding(bindingWith({ controlId: a.id, controlName: "OTHER", controlType: "knob" }), makeDevice([a, b]));
        expect(result).toEqual({ ok: true, controlId: a.id, matchedBy: "id" });
    });
});

describe("resolveControlForBinding — M23.2 step 3: signature fallback", () => {
    it("id missing + UNIQUE name+type match → matchedBy: signature", () => {
        const dest = control({ id: "ctl_dest_abcd", name: "Cutoff", type: "knob" });
        const result = resolveControlForBinding(
            bindingWith({ controlName: "Cutoff", controlType: "knob" }),
            makeDevice([dest]),
        );
        expect(result).toEqual({ ok: true, controlId: dest.id, matchedBy: "signature" });
    });

    it("two identical signatures → ambiguous (no guess)", () => {
        const a = control({ id: "ctl_dup_1", name: "Cutoff", type: "knob" });
        const b = control({ id: "ctl_dup_2", name: "Cutoff", type: "knob" });
        const result = resolveControlForBinding(
            bindingWith({ controlName: "Cutoff", controlType: "knob" }),
            makeDevice([a, b]),
        );
        expect(result).toEqual({ ok: false, reason: "ambiguous" });
    });

    it("no candidate at all → missing", () => {
        const dest = control({ id: "ctl_dest_abcd", name: "Resonance", type: "knob" });
        const result = resolveControlForBinding(
            bindingWith({ controlName: "Cutoff", controlType: "knob" }),
            makeDevice([dest]),
        );
        expect(result).toEqual({ ok: false, reason: "missing" });
    });

    it("unique name with the WRONG control type → type-mismatch", () => {
        const dest = control({ id: "ctl_dest_abcd", name: "Cutoff", type: "switch" });
        const result = resolveControlForBinding(
            bindingWith({ controlName: "Cutoff", controlType: "knob" }),
            makeDevice([dest]),
        );
        expect(result).toEqual({ ok: false, reason: "type-mismatch" });
    });

    it("extra type-correct candidates are UNRESOLVED even if one is the most likely — never best guess", () => {
        const a = control({ id: "ctl_d1", name: "Cutoff", type: "knob" });
        const b = control({ id: "ctl_d2", name: "Cutoff", type: "switch" });
        const result = resolveControlForBinding(
            bindingWith({ controlName: "Cutoff", controlType: "knob" }),
            makeDevice([a, b]),
        );
        // exactly one knob candidate → signature match (the switch one is a
        // type mismatch, not a competing signature)
        expect(result).toEqual({ ok: true, controlId: a.id, matchedBy: "signature" });
    });

    it("binding controlNameSource manual → NEVER a signature match", () => {
        const dest = control({ id: "ctl_dest_abcd", name: "Cutoff", type: "knob" });
        const result = resolveControlForBinding(
            bindingWith({ controlName: "Cutoff", controlType: "knob", controlNameSource: "manual" }),
            makeDevice([dest]),
        );
        expect(result).toEqual({ ok: false, reason: "missing" });
    });

    it("a manual-renamed control is never matched by signature", () => {
        const dest = control({ id: "ctl_dest_abcd", name: "Cutoff", type: "knob", nameSource: "manual" });
        const result = resolveControlForBinding(
            bindingWith({ controlName: "Cutoff", controlType: "knob" }),
            makeDevice([dest]),
        );
        expect(result).toEqual({ ok: false, reason: "missing" });
    });

    it("an archived control is never matched by signature", () => {
        const dest = control({ id: "ctl_dest_abcd", name: "Cutoff", type: "knob", archived: true });
        const result = resolveControlForBinding(
            bindingWith({ controlName: "Cutoff", controlType: "knob" }),
            makeDevice([dest]),
        );
        expect(result).toEqual({ ok: false, reason: "missing" });
    });

    it("legacy binding without descriptor fields → missing, never signature", () => {
        const dest = control({ id: "ctl_dest_abcd", name: "Cutoff", type: "knob" });
        const result = resolveControlForBinding(bindingWith(), makeDevice([dest]));
        expect(result).toEqual({ ok: false, reason: "missing" });
    });

    it("targetName is NEVER consulted — different name stays unresolved", () => {
        // A control whose audiotoolBindingDefinition.targetName matches the
        // binding's fieldPath exactly (the M23.1 step-2 heuristic): the pure
        // resolver must IGNORE it and report missing, not a match.
        const dest: BindingMatchableControl = control({
            id: "ctl_dest_abcd",
            name: "Filter",
            type: "knob",
        });
        Object.assign(dest, { audiotoolBindingDefinition: { targetName: "pulverisateur / filter.cutoffFrequencyHz" } });
        const result = resolveControlForBinding(
            bindingWith({ controlName: "Cutoff", controlType: "knob" }),
            makeDevice([dest]),
        );
        expect(result).toEqual({ ok: false, reason: "missing" });
    });
});