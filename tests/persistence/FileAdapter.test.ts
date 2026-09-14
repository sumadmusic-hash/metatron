// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    exportMultiplePresetsToFile,
    exportPresetToFile,
    importPresetFromFile,
} from "../../src/persistence/FileAdapter";
import {
    InstrumentPresetError,
    serializeInstrumentPreset,
} from "../../src/core/instrument/InstrumentPreset";
import type { InstrumentPreset } from "../../src/core/instrument/InstrumentPreset";

/**
 * FILE ADAPTER — browser File-API bridge (D1 file side).
 * Stubbed browser surface (happy-dom lacks FileReader/URL.createObjectURL):
 *   - Blob            → FakeBlob capturing parts/type.
 *   - URL             → createObjectURL/revokeObjectURL spies.
 *   - FileReader      → FakeFileReader dispatching onload/onerror.
 *   - anchor.click()  → capture the created element (append/remove recorded).
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

function presetFixture(name: string): InstrumentPreset {
    return {
        version: "0.1",
        name,
        metatron: {
            deviceId: "dev_1a2b3c4d",
            presetId: "pst_9f8e7d6c",
            controlValues: {
                ctl_cutoff: 0.73,
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
        ],
    };
}

function makeFile(payload?: string, fail = false): File {
    return { name: "preset.metatron-preset.json", __payload: payload, __error: fail } as unknown as File;
}

class FakeFileReader {
    result: string | ArrayBuffer | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;

    readAsText(file: File): void {
        const f = file as unknown as { __payload?: string; __error?: boolean };
        if (f.__error) {
            this.onerror?.();
            return;
        }
        this.result = f.__payload ?? "";
        this.onload?.();
    }
}

let urlCreate: ReturnType<typeof vi.fn>;
let urlRevoke: ReturnType<typeof vi.fn>;
let clickedAnchor: HTMLAnchorElement | null = null;
let removedAnchor = false;
let lastBlob: { content: string; type?: string } | null = null;

const NativeURL = globalThis.URL;
const origAnchorRemove = HTMLAnchorElement.prototype.remove;

class FakeBlob {
    constructor(parts: string[], options?: { type?: string }) {
        lastBlob = { content: parts.join(""), type: options?.type };
    }
}

beforeEach(() => {
    clickedAnchor = null;
    removedAnchor = false;
    lastBlob = null;

    urlCreate = vi.fn(() => "blob:metatron-mock");
    urlRevoke = vi.fn();
    Object.assign(NativeURL, { createObjectURL: urlCreate, revokeObjectURL: urlRevoke });
    vi.stubGlobal("Blob", FakeBlob as unknown as typeof Blob);
    vi.stubGlobal("FileReader", FakeFileReader as unknown as typeof FileReader);

    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
        clickedAnchor = this;
    });
    vi.spyOn(HTMLAnchorElement.prototype, "remove").mockImplementation(function (this: HTMLAnchorElement) {
        removedAnchor = true;
        return origAnchorRemove.call(this);
    });

    // P3.4 — revokeObjectURL is DEFERRED (macrotask fallback timer), so the
    // export paths schedule timers. Fake timers keep that deterministic and
    // guarantee no cleanup callback fires after the test has finished.
    vi.useFakeTimers();
});

afterEach(() => {
    delete (NativeURL as { createObjectURL?: unknown }).createObjectURL;
    delete (NativeURL as { revokeObjectURL?: unknown }).revokeObjectURL;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("exportPresetToFile", () => {
    it("downloads the envelope with the default filename (spaces → underscores)", () => {
        exportPresetToFile(presetFixture("Crunch Lead"));

        expect(clickedAnchor).not.toBeNull();
        expect(clickedAnchor!.download).toBe("Crunch_Lead.metatron-preset.json");
        expect(clickedAnchor!.href).toBe("blob:metatron-mock");
        expect(urlCreate).toHaveBeenCalledOnce();
        // P3.4 — the revoke is deferred: nothing is cleaned up synchronously
        // right after click() (that could abort the blob fetch mid-download).
        expect(urlRevoke).not.toHaveBeenCalled();
        expect(removedAnchor).toBe(true);
        expect(lastBlob?.type).toBe("application/json");
        expect(lastBlob?.content).toBe(serializeInstrumentPreset(presetFixture("Crunch Lead")));

        // Once the fallback cleanup window elapses, the URL IS revoked.
        vi.advanceTimersByTime(1000);
        expect(urlRevoke).toHaveBeenCalledOnce();
        expect(urlRevoke).toHaveBeenCalledWith("blob:metatron-mock");
    });

    it("honors an explicit filename", () => {
        exportPresetToFile(presetFixture("Crunch Lead"), "MyCustomPreset.json");
        expect(clickedAnchor!.download).toBe("MyCustomPreset.json");
    });

    it("falls back to 'preset' when the name is empty/whitespace", () => {
        exportPresetToFile(presetFixture("   "));
        expect(clickedAnchor!.download).toBe("preset.metatron-preset.json");
    });
});

describe("exportMultiplePresetsToFile", () => {
    it("writes all envelopes as one JSON array with the bundle filename", () => {
        const first = presetFixture("Crunch Lead");
        const second = presetFixture("Ambient Pad");
        exportMultiplePresetsToFile([first, second]);

        expect(clickedAnchor!.download).toBe("metatron-presets-bundle.json");
        expect(lastBlob?.type).toBe("application/json");
        const parsed = JSON.parse(lastBlob!.content) as InstrumentPreset[];
        expect(parsed).toHaveLength(2);
        expect(parsed[0].name).toBe("Crunch Lead");
        expect(parsed[1].name).toBe("Ambient Pad");
        expect(parsed[0].metatron.deviceId).toBe(first.metatron.deviceId);
    });
});

describe("importPresetFromFile", () => {
    it("resolves a validated preset from a serialized file", async () => {
        const preset = presetFixture("From File");
        const imported = await importPresetFromFile(makeFile(serializeInstrumentPreset(preset)));
        expect(imported).toEqual(preset);
    });

    it("rejects with InstrumentPresetError on invalid JSON content", async () => {
        await expect(importPresetFromFile(makeFile("{ this is not json }"))).rejects.toBeInstanceOf(InstrumentPresetError);
    });

    it("rejects with Error('File read failed') when the FileReader errors", async () => {
        await expect(importPresetFromFile(makeFile("", true))).rejects.toThrow("File read failed");
    });
});