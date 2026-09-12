import { describe, it, expect } from "vitest";
import { shortenParameterName, MAX_DISPLAY_LENGTH } from "../../src/nexus/ParameterShortener";

describe("shortenParameterName (M4.4)", () => {

    it("required examples from the fieldPath tests", () => {
        expect(shortenParameterName("filter.resonance")).toBe("Resonance");
        expect(shortenParameterName("filter.cutoffFrequency")).toBe("Cutoff");
        expect(shortenParameterName("envelope.attackTime")).toBe("Attack");
        expect(shortenParameterName("envelope.releaseTime")).toBe("Release");
        expect(shortenParameterName("delay.feedbackAmount")).toBe("Feedback");
        expect(shortenParameterName("inputGain")).toBe("Input Gain");
        expect(shortenParameterName("outputGain")).toBe("Output Gain");
        expect(shortenParameterName("dryWetMix")).toBe("Mix");
        expect(shortenParameterName("frequencyHz")).toBe("Frequency");
        expect(shortenParameterName("feedbackFactor")).toBe("Feedback Factor");
    });

    it("known semantic patterns are recognized (with and without containers)", () => {
        expect(shortenParameterName("cutoffFrequency")).toBe("Cutoff");
        expect(shortenParameterName("filterCutoffFrequency")).toBe("Cutoff");
        expect(shortenParameterName("resonanceAmount")).toBe("Resonance");
        expect(shortenParameterName("filterResonance")).toBe("Resonance");
        expect(shortenParameterName("attackTime")).toBe("Attack");
        expect(shortenParameterName("envelopeAttackTime")).toBe("Attack");
        expect(shortenParameterName("decayTime")).toBe("Decay");
        expect(shortenParameterName("envelopeDecayTime")).toBe("Decay");
        expect(shortenParameterName("releaseTime")).toBe("Release");
        expect(shortenParameterName("envelopeReleaseTime")).toBe("Release");
        expect(shortenParameterName("feedbackAmount")).toBe("Feedback");
        expect(shortenParameterName("delayFeedbackAmount")).toBe("Feedback");
        expect(shortenParameterName("wetDryMix")).toBe("Mix");
        expect(shortenParameterName("timeSeconds")).toBe("Time");
        expect(shortenParameterName("levelDb")).toBe("Level");
    });

    it("snake_case is normalized", () => {
        expect(shortenParameterName("cutoff_frequency")).toBe("Cutoff");
        expect(shortenParameterName("dry_wet_mix")).toBe("Mix");
        expect(shortenParameterName("output_gain")).toBe("Output Gain");
        expect(shortenParameterName("input_gain")).toBe("Input Gain");
    });

    it("kebab-case is normalized", () => {
        expect(shortenParameterName("cutoff-frequency")).toBe("Cutoff");
        expect(shortenParameterName("dry-wet-mix")).toBe("Mix");
    });

    it("spaces are treated as separators", () => {
        expect(shortenParameterName("cutoff frequency")).toBe("Cutoff");
        expect(shortenParameterName("dry wet mix")).toBe("Mix");
        expect(shortenParameterName("  output gain  ")).toBe("Output Gain");
    });

    it("already-short names stay readable", () => {
        expect(shortenParameterName("pitch")).toBe("Pitch");
        expect(shortenParameterName("cutoff")).toBe("Cutoff");
        expect(shortenParameterName("gain")).toBe("Gain");
        expect(shortenParameterName("mix")).toBe("Mix");
        expect(shortenParameterName("sustain")).toBe("Sustain");
        expect(shortenParameterName("threshold")).toBe("Threshold");
    });

    it("unknown names preserve their readable form and are not semantically mangled", () => {
        expect(shortenParameterName("customShape")).toBe("Custom Shape");
        expect(shortenParameterName("customEnvelopeShape")).not.toBe("Shape");
        expect(shortenParameterName("customEnvelopeShape")).toContain("Custom");
        expect(shortenParameterName("weirdParam")).toBe("Weird Param");
        expect(shortenParameterName("filterSaturation")).not.toBe("Saturation");
        expect(shortenParameterName("filterSaturation")).toContain("Filter");
        expect(shortenParameterName("delayTime")).toBe("Delay Time");
    });

    it("redundant trailing words are dropped", () => {
        expect(shortenParameterName("gainValue")).toBe("Gain");
        expect(shortenParameterName("cutoffFrequencyParameter")).toBe("Cutoff");
        expect(shortenParameterName("attackTimeSetting")).toBe("Attack");
        expect(shortenParameterName("value")).toBe("Value");
    });

    it("collision-sensitive names stay distinct", () => {
        expect(shortenParameterName("inputGain")).not.toBe(shortenParameterName("outputGain"));
        expect(shortenParameterName("inputLevel")).toBe("Input Level");
        expect(shortenParameterName("outputLevel")).toBe("Output Level");
    });

    it("intentional collapses are deterministic and consistent", () => {
        for (let i = 0; i < 3; i++) {
            expect(shortenParameterName("cutoffFrequency")).toBe("Cutoff");
            expect(shortenParameterName("filterCutoffFrequency")).toBe("Cutoff");
        }
    });

    it("empty and whitespace-only input produces an empty label", () => {
        expect(shortenParameterName("")).toBe("");
        expect(shortenParameterName("   ")).toBe("");
    });

    it("very long unknown names are truncated with an ellipsis", () => {
        const long = shortenParameterName("someReallyLongUnknownParameterNameIndeed");
        expect(long.length).toBeLessThanOrEqual(MAX_DISPLAY_LENGTH);
        expect(long.endsWith("\u2026")).toBe(true);

        const single = shortenParameterName("supercalifragilisticexpialidocious");
        expect(single.length).toBe(MAX_DISPLAY_LENGTH);
        expect(single.endsWith("\u2026")).toBe(true);
    });

    it("letter/digit transitions are kept as separate tokens", () => {
        expect(shortenParameterName("send3Level")).toBe("Send 3 Level");
        expect(shortenParameterName("band2Gain")).toBe("Band 2 Gain");
    });

    it("the pipeline is deterministic for repeated equal inputs", () => {
        const inputs = ["filter.cutoffFrequency", "output_gain", "dry wet mix", "inputGain", "customEnvelopeShape"];
        for (const input of inputs) {
            expect(shortenParameterName(input)).toBe(shortenParameterName(input));
        }
    });
});