import {
    parseInstrumentPreset,
    serializeInstrumentPreset,
} from "../core/instrument/InstrumentPreset";
import type { InstrumentPreset } from "../core/instrument/InstrumentPreset";

/**
 * FILE ADAPTER — the missing browser File-API bridge (D1 file side).
 *
 * Exports an `InstrumentPreset` as a `.json` download and imports it back
 * from a picked file, reusing the PROVEN envelope logic
 * (`serializeInstrumentPreset` / `parseInstrumentPreset`). No repository,
 * no localStorage, no new serialization:
 *   - EXPORT: existing serialization → Blob → anchor download.
 *   - IMPORT: FileReader.readAsText → `parseInstrumentPreset` (its
 *     `InstrumentPresetError` propagates unchanged).
 *
 * Pure browser bridge: no Nexus, no document, no binding engine.
 */

function sanitizeFilenameName(name: string): string {
    const trimmed = name.trim().replace(/\s+/g, "_");
    return trimmed.length > 0 ? trimmed : "preset";
}

function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    link.remove();
}

/** Download one `InstrumentPreset` envelope as `{preset.name}.metatron-preset.json`
 *  (spaces → underscores), or a caller-chosen filename. */
export function exportPresetToFile(preset: InstrumentPreset, filename?: string): void {
    const json = serializeInstrumentPreset(preset);
    downloadBlob(
        new Blob([json], { type: "application/json" }),
        filename ?? `${sanitizeFilenameName(preset.name)}.metatron-preset.json`,
    );
}

/** Download multiple envelopes as one JSON array (`metatron-presets-bundle.json`).
 *  Each preset is serialized individually; the result is a valid JSON array. */
export function exportMultiplePresetsToFile(presets: InstrumentPreset[], filename?: string): void {
    const json = `[${presets.map((p) => serializeInstrumentPreset(p)).join(",")}]`;
    downloadBlob(new Blob([json], { type: "application/json" }), filename ?? "metatron-presets-bundle.json");
}

/** Parse a picked file back into an `InstrumentPreset`. Rejects with
 *  `new Error("File read failed")` on `FileReader.onerror`, and propagates
 *  the `InstrumentPresetError` thrown by `parseInstrumentPreset` unchanged. */
export function importPresetFromFile(file: File): Promise<InstrumentPreset> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            if (typeof reader.result !== "string") {
                reject(new Error("File read failed"));
                return;
            }
            try {
                resolve(parseInstrumentPreset(reader.result));
            } catch (e) {
                reject(e);
            }
        };
        reader.onerror = () => reject(new Error("File read failed"));
        reader.readAsText(file);
    });
}