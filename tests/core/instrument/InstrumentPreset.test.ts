import { describe, it, expect } from "vitest";
import {
    InstrumentPresetError,
    INSTRUMENT_PRESET_VERSION,
    parseInstrumentPreset,
    serializeInstrumentPreset,
    validateInstrumentPreset,
} from "../../../src/core/instrument/InstrumentPreset";
import type { InstrumentPreset, InstrumentPresetBinding } from "../../../src/core/instrument/InstrumentPreset";

/**
 * PHASE A — pure InstrumentPreset v0.1 model.
 * All fixtures are plain data (no Nexus, no DOM, no storage).
 */

function snapshotFixture() {
    return {
        version: 1,
        devices: [
            {
                sourceEntityId: "934d92a5-a56b-43dc-b1ba-daac1782c72d",
                entityType: "pulverisateur",
                displayName: "Pulverisateur",
                schemaTargetType: "pulverisateur",
                fields: [
                    { path: "gain", value: 1, primitiveType: "number", scalarType: 2, range: { min: 0, max: 1 }, defaultValue: 0.7079460024833679, mutable: true },
                    { path: "filter.cutoffFrequencyHz", value: 9353.8779296875, primitiveType: "number", scalarType: 2, range: { min: 18, max: 15500 }, defaultValue: 15500, mutable: true },
                    { path: "filter.resonance", value: 0.5097485780715942, primitiveType: "number", scalarType: 2, range: { min: 0, max: 1 }, defaultValue: 0, mutable: true },
                    { path: "isActive", value: true, primitiveType: "boolean", scalarType: 8, defaultValue: true, mutable: true },
                ],
            },
            {
                sourceEntityId: "37715c5a-8d12-4f0a-93fa-8fcb71d0b6ab",
                entityType: "mixerChannel",
                displayName: "mixerChannel",
                schemaTargetType: "mixerChannel",
                fields: [
                    { path: "preGain", value: 0.39810699224472046, primitiveType: "number", scalarType: 2, range: { min: 0, max: 7.943282127380371 }, defaultValue: 0.39810699224472046, mutable: true },
                    { path: "doesPhaseReverse", value: false, primitiveType: "boolean", scalarType: 8, defaultValue: false, mutable: true },
                ],
            },
        ],
        connections: [
            {
                fromEntityId: "934d92a5-a56b-43dc-b1ba-daac1782c72d",
                fromSocket: "audioOutput",
                fromSocketPath: "pulverisateur/audioOutput",
                toEntityId: "37715c5a-8d12-4f0a-93fa-8fcb71d0b6ab",
                toSocket: "audioInput",
                toSocketPath: "mixerChannel/audioInput",
            },
        ],
        rootCandidates: ["934d92a5-a56b-43dc-b1ba-daac1782c72d"],
    };
}

function presetFixture(): InstrumentPreset {
    return {
        version: "0.1",
        name: "Crunch Lead",
        metatron: {
            deviceId: "dev_1a2b3c4d",
            presetId: "pst_9f8e7d6c",
            controlValues: {
                ctl_cutoff: 0.73,
                ctl_resonance: 0.41,
                ctl_active: 0,
            },
        },
        chain: {
            snapshot: snapshotFixture() as any,
        },
        bindings: [
            {
                controlId: "ctl_cutoff",
                sourceEntityIndex: 0,
                fieldPath: "filter.cutoffFrequencyHz",
                valueMapping: { kind: "linear", min: 18, max: 15500, isInteger: false, typeLabel: "number" },
            },
            {
                controlId: "ctl_resonance",
                sourceEntityIndex: 0,
                fieldPath: "filter.resonance",
                valueMapping: { kind: "linear", min: 0, max: 1, isInteger: false, typeLabel: "number" },
            },
            {
                controlId: "ctl_active",
                sourceEntityIndex: 1,
                fieldPath: "doesPhaseReverse",
                valueMapping: { kind: "boolean", typeLabel: "boolean" },
            },
        ],
    };
}

function validResult() {
    return validateInstrumentPreset(presetFixture());
}

describe("InstrumentPreset v0.1 — A. Roundtrip", () => {
    it("serialize → parse is semantically identical", () => {
        const preset = presetFixture();
        const restored = parseInstrumentPreset(serializeInstrumentPreset(preset));
        expect(restored).toEqual(preset);
    });

    it("parse returns a plain, Nexus-free object (no class instance)", () => {
        const restored = parseInstrumentPreset(serializeInstrumentPreset(presetFixture()));
        expect(restored.constructor).toBe(Object);
        expect(restored.chain.snapshot.constructor).toBe(Object);
    });
});

describe("InstrumentPreset v0.1 — B. Version guard", () => {
    it("accepts exactly version \"0.1\"", () => {
        expect(validResult().valid).toBe(true);
        expect(INSTRUMENT_PRESET_VERSION).toBe("0.1");
    });

    it("rejects an unknown future version", () => {
        const preset = presetFixture();
        (preset as any).version = "0.2";
        const result = validateInstrumentPreset(preset);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes("version"))).toBe(true);
    });

    it("rejects a missing version", () => {
        const preset = presetFixture() as any;
        delete preset.version;
        expect(validateInstrumentPreset(preset).valid).toBe(false);
    });

    it("rejects a non-string version", () => {
        const preset = presetFixture() as any;
        preset.version = 0.1;
        expect(validateInstrumentPreset(preset).valid).toBe(false);
    });

    it("parse throws for unsupported and missing versions", () => {
        const withFuture = { ...presetFixture(), version: "2.0" };
        expect(() => parseInstrumentPreset(JSON.stringify(withFuture))).toThrow(InstrumentPresetError);

        const withoutVersion = { ...presetFixture() } as any;
        delete withoutVersion.version;
        expect(() => parseInstrumentPreset(JSON.stringify(withoutVersion))).toThrow(InstrumentPresetError);
    });
});

describe("InstrumentPreset v0.1 — C. Control values (normalized 0..1)", () => {
    function withControlValues(values: Record<string, number>): InstrumentPreset {
        const preset = presetFixture();
        preset.metatron.controlValues = values;
        return preset;
    }

    it.each([0, 0.5, 1])("accepts normalized value %s", (value) => {
        expect(validateInstrumentPreset(withControlValues({ ctl_x: value })).valid).toBe(true);
    });

    it.each([-0.01, 1.01])("rejects out-of-range value %s — no silent clamping", (value) => {
        const result = validateInstrumentPreset(withControlValues({ ctl_x: value }));
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes("controlValues"))).toBe(true);
    });

    it("rejects non-finite and non-number values", () => {
        expect(validateInstrumentPreset(withControlValues({ ctl_x: NaN })).valid).toBe(false);
        expect(validateInstrumentPreset(withControlValues({ ctl_x: Infinity })).valid).toBe(false);
        expect(validateInstrumentPreset(withControlValues({ ctl_x: "0.5" as any })).valid).toBe(false);
    });
});

describe("InstrumentPreset v0.1 — D. Binding sourceEntityIndex", () => {
    function bindingWithIndex(index: number): InstrumentPresetBinding {
        return {
            controlId: "ctl_x",
            sourceEntityIndex: index,
            fieldPath: "gain",
            valueMapping: { kind: "linear", min: 0, max: 1 },
        };
    }

    it("accepts index 0 (first device)", () => {
        const preset = presetFixture();
        preset.bindings = [bindingWithIndex(0)];
        expect(validateInstrumentPreset(preset).valid).toBe(true);
    });

    it("accepts the last index (devices.length - 1)", () => {
        const preset = presetFixture();
        const lastIndex = preset.chain.snapshot.devices.length - 1;
        const binding = bindingWithIndex(lastIndex);
        binding.fieldPath = "preGain"; // exists on mixerChannel (device[1])
        preset.bindings = [binding];
        expect(validateInstrumentPreset(preset).valid).toBe(true);
    });

    it("rejects -1", () => {
        const preset = presetFixture();
        preset.bindings = [bindingWithIndex(-1)];
        expect(validateInstrumentPreset(preset).valid).toBe(false);
    });

    it("rejects devices.length (out of range)", () => {
        const preset = presetFixture();
        preset.bindings = [bindingWithIndex(preset.chain.snapshot.devices.length)];
        expect(validateInstrumentPreset(preset).valid).toBe(false);
    });

    it("rejects non-integer indices", () => {
        const preset = presetFixture();
        preset.bindings = [bindingWithIndex(0.5)];
        expect(validateInstrumentPreset(preset).valid).toBe(false);
    });
});

describe("InstrumentPreset v0.1 — E. Field path against snapshot", () => {
    function bindingFor(path: string): InstrumentPresetBinding {
        return {
            controlId: "ctl_x",
            sourceEntityIndex: 0,
            fieldPath: path,
            valueMapping: { kind: "linear", min: 18, max: 15500 },
        };
    }

    it("accepts an existing nested path", () => {
        const preset = presetFixture();
        preset.bindings = [bindingFor("filter.cutoffFrequencyHz")];
        expect(validateInstrumentPreset(preset).valid).toBe(true);
    });

    it("rejects a non-existing path on the indexed device", () => {
        const preset = presetFixture();
        preset.bindings = [bindingFor("filter.doesNotExist")];
        const result = validateInstrumentPreset(preset);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes("filter.doesNotExist"))).toBe(true);
    });

    it("rejects an empty path", () => {
        const preset = presetFixture();
        preset.bindings = [bindingFor("")];
        expect(validateInstrumentPreset(preset).valid).toBe(false);
    });

    it("rejects a path that exists on another device than the indexed one", () => {
        // "preGain" lives on devices[1], not on devices[0] → invalid at index 0.
        const preset = presetFixture();
        preset.bindings = [bindingFor("preGain")];
        expect(validateInstrumentPreset(preset).valid).toBe(false);
    });
});

describe("InstrumentPreset v0.1 — F. Value mapping", () => {
    function bindingFor(kind: string, extra: Record<string, unknown> = {}): InstrumentPresetBinding {
        return {
            controlId: "ctl_x",
            sourceEntityIndex: 0,
            fieldPath: "gain",
            valueMapping: { kind, ...extra } as any,
        };
    }

    it("accepts linear, boolean and integer (linear + isInteger) mappings", () => {
        const linear = presetFixture(); linear.bindings = [bindingFor("linear", { min: 0, max: 1 })];
        const boolean = presetFixture(); boolean.bindings = [bindingFor("boolean")];
        const integer = presetFixture(); integer.bindings = [bindingFor("linear", { min: 1, max: 2, isInteger: true })];
        expect(validateInstrumentPreset(linear).valid).toBe(true);
        expect(validateInstrumentPreset(boolean).valid).toBe(true);
        expect(validateInstrumentPreset(integer).valid).toBe(true);
    });

    it("rejects a missing valueMapping", () => {
        const preset = presetFixture();
        const binding = preset.bindings[0] as any;
        delete binding.valueMapping;
        expect(validateInstrumentPreset(preset).valid).toBe(false);
    });

    it("rejects an unknown mapping kind", () => {
        const preset = presetFixture();
        preset.bindings = [bindingFor("smoothed")];
        expect(validateInstrumentPreset(preset).valid).toBe(false);
    });

    it("rejects a linear mapping without numeric min/max", () => {
        const preset = presetFixture();
        preset.bindings = [bindingFor("linear", {})];
        expect(validateInstrumentPreset(preset).valid).toBe(false);
    });

    it("rejects a linear mapping with min > max", () => {
        const preset = presetFixture();
        preset.bindings = [bindingFor("linear", { min: 5, max: 1 })];
        expect(validateInstrumentPreset(preset).valid).toBe(false);
    });
});

describe("InstrumentPreset v0.1 — G. M23.2 OPTIONAL control descriptors", () => {
    function bindingWith(
        extra: Record<string, unknown>,
        base: InstrumentPresetBinding = presetFixture().bindings[0],
    ): InstrumentPresetBinding {
        return { ...base, ...extra };
    }

    it("accepts a binding with the full optional descriptor (additive)", () => {
        const preset = presetFixture();
        preset.bindings = [bindingWith({ controlName: "Cutoff", controlType: "knob", controlNameSource: "auto" })];
        expect(validateInstrumentPreset(preset).valid).toBe(true);
    });

    it("accepts a binding with only some descriptor fields (still legacy-valid)", () => {
        const preset = presetFixture();
        preset.bindings = [bindingWith({ controlName: "Cutoff" })];
        expect(validateInstrumentPreset(preset).valid).toBe(true);
    });

    it("accepts controlNameSource manual", () => {
        const preset = presetFixture();
        preset.bindings = [bindingWith({ controlName: "Cutoff", controlType: "switch", controlNameSource: "manual" })];
        expect(validateInstrumentPreset(preset).valid).toBe(true);
    });

    it("rejects a non-empty-string controlName when present", () => {
        const empty = presetFixture(); empty.bindings = [bindingWith({ controlName: "" })];
        expect(validateInstrumentPreset(empty).valid).toBe(false);
    });

    it("rejects an unknown controlType when present", () => {
        const preset = presetFixture();
        preset.bindings = [bindingWith({ controlType: "rotary" })];
        expect(validateInstrumentPreset(preset).valid).toBe(false);
    });

    it("rejects an unknown controlNameSource when present", () => {
        const preset = presetFixture();
        preset.bindings = [bindingWith({ controlNameSource: "derived" })];
        expect(validateInstrumentPreset(preset).valid).toBe(false);
    });
});

describe("InstrumentPreset v0.1 — structural consistency", () => {
    it("rejects duplicate bindings for the same controlId", () => {
        const preset = presetFixture();
        preset.bindings = [preset.bindings[0], preset.bindings[0]];
        expect(validateInstrumentPreset(preset).valid).toBe(false);
    });

    it("rejects a missing deviceId / presetId", () => {
        const noDevice = presetFixture(); (noDevice.metatron as any).deviceId = "";
        const noPreset = presetFixture(); (noPreset.metatron as any).presetId = undefined;
        expect(validateInstrumentPreset(noDevice).valid).toBe(false);
        expect(validateInstrumentPreset(noPreset).valid).toBe(false);
    });

    it("rejects control values object and bindings as non-array", () => {
        const noValues = presetFixture(); (noValues.metatron as any).controlValues = null;
        const noBindings = presetFixture(); (noBindings as any).bindings = {};
        expect(validateInstrumentPreset(noValues).valid).toBe(false);
        expect(validateInstrumentPreset(noBindings).valid).toBe(false);
    });
});

describe("InstrumentPreset v0.1 — G/H. Identity + snapshot preservation on roundtrip", () => {
    it("keeps every Metatron id and every binding id unchanged", () => {
        const preset = presetFixture();
        const restored = parseInstrumentPreset(serializeInstrumentPreset(preset));
        expect(restored.metatron.deviceId).toBe("dev_1a2b3c4d");
        expect(restored.metatron.presetId).toBe("pst_9f8e7d6c");
        expect(restored.bindings.map((b) => b.controlId)).toEqual(preset.bindings.map((b) => b.controlId));
        expect(Object.keys(restored.metatron.controlValues)).toEqual(
            Object.keys(preset.metatron.controlValues),
        );
    });

    it("keeps the complete chain.snapshot bytes-identical", () => {
        const preset = presetFixture();
        const restored = parseInstrumentPreset(serializeInstrumentPreset(preset));
        expect(JSON.stringify(restored.chain.snapshot)).toBe(JSON.stringify(preset.chain.snapshot));
    });

    it("serialization is deterministic", () => {
        const preset = presetFixture();
        expect(serializeInstrumentPreset(preset)).toBe(serializeInstrumentPreset(preset));
    });
});

describe("InstrumentPreset v0.1 — I. Immutability", () => {
    it("validation does not mutate a fully frozen valid preset", () => {
        const preset = presetFixture();
        const snapshot = JSON.stringify(preset);

        const deepFreeze = (o: any): any => {
            Object.keys(o).forEach((k) => {
                const v = o[k];
                if (v && typeof v === "object") deepFreeze(v);
            });
            return Object.freeze(o);
        };
        deepFreeze(preset);

        const result = validateInstrumentPreset(preset);
        expect(result.valid).toBe(true);
        expect(JSON.stringify(preset)).toBe(snapshot);
    });

    it("validation does not mutate on invalid input either", () => {
        const preset = presetFixture();
        preset.bindings = [preset.bindings[0], preset.bindings[0]]; // duplicate → invalid
        const snapshot = JSON.stringify(preset);
        validateInstrumentPreset(preset);
        expect(JSON.stringify(preset)).toBe(snapshot);
    });
});

describe("InstrumentPreset v0.1 — parse errors and non-object inputs", () => {
    it("parse throws on malformed JSON", () => {
        expect(() => parseInstrumentPreset("{not json")).toThrow(InstrumentPresetError);
    });

    it("parse throws when content is invalid (collects more than one problem)", () => {
        const invalid = { version: "9.9", name: "", metatron: {}, chain: {}, bindings: {} };
        expect(() => parseInstrumentPreset(JSON.stringify(invalid))).toThrow(InstrumentPresetError);
    });

    it("validate rejects null, scalars and arrays", () => {
        expect(validateInstrumentPreset(null).valid).toBe(false);
        expect(validateInstrumentPreset(42).valid).toBe(false);
        expect(validateInstrumentPreset("x").valid).toBe(false);
        expect(validateInstrumentPreset([]).valid).toBe(false);
    });
});