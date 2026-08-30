import type { InstrumentImportResult } from "../../core/instrument/InstrumentPresetImport";
import type { InstrumentExportOutcome, InstrumentImportOutcome } from "../../integration/InstrumentPresetIntegration";

/**
 * P3 — RESULT VIEW for the Instrument Preset integration.
 *
 * Renders the EXISTING engine results (`InstrumentPresetExportResult`,
 * `InstrumentImportResult`) as a readable report box. Introduces NO new verdict
 * logic: everything shown is read from the engine result objects. When
 * `ok === false` the box is clearly FAILED and never claims success.
 */

function resultBox(ok: boolean, lines: string[]): HTMLPreElement {
    const pre = document.createElement("pre");
    const border = ok ? "rgba(76,175,80,0.4)" : "rgba(244,67,54,0.5)";
    pre.style.cssText =
        `margin-top:10px;padding:8px 10px;background:rgba(0,0,0,0.25);border:1px solid ${border};` +
        "border-radius:6px;white-space:pre-wrap;font-family:monospace;font-size:11px;line-height:1.5;color:#dfe3ea;max-height:320px;overflow:auto;";
    pre.textContent = `${ok ? "OK" : "FAILED"}\n${lines.join("\n")}`;
    return pre;
}

/** Render an export outcome (engine result + library storage info). */
export function renderInstrumentExportOutcome(outcome: InstrumentExportOutcome): HTMLPreElement {
    const lines: string[] = ["INSTRUMENT PRESET EXPORT"];
    if (outcome.ok && outcome.preset && outcome.entry) {
        const values = Object.keys(outcome.preset.metatron.controlValues).length;
        lines.push(
            `name:           ${outcome.preset.name}`,
            `version:        ${outcome.preset.version}`,
            `deviceId:       ${outcome.preset.metatron.deviceId}`,
            `controls:       ${values}`,
            `bindings:       ${outcome.preset.bindings.length}`,
            `preset values:  ${values}`,
            `chain devices:  ${outcome.preset.chain.snapshot.devices.length}`,
            `chain cables:   ${outcome.preset.chain.snapshot.connections.length}`,
            `stored as:      ${outcome.entry.id}`,
        );
        if (outcome.warnings && outcome.warnings.length > 0) {
            outcome.warnings.forEach((w) => lines.push(`warning:        ${w}`));
        }
        lines.push("SOURCES NOT COPIED: source entity ids never travel in the envelope.");
    } else {
        (outcome.errors ?? []).forEach((e) => lines.push(`- ${e}`));
    }
    return resultBox(outcome.ok, lines);
}

/** Render an import outcome: full `InstrumentImportResult` sections plus any
 *  pre-engine errors. No invented verdicts; `ok === false` renders FAILED. */
export function renderInstrumentImportOutcome(outcome: InstrumentImportOutcome): HTMLPreElement {
    const lines: string[] = ["INSTRUMENT PRESET IMPORT"];
    if (outcome.errors && outcome.errors.length > 0 && !outcome.import) {
        outcome.errors.forEach((e) => lines.push(`- ${e}`));
        return resultBox(false, lines);
    }

    const result: InstrumentImportResult = outcome.import!;
    lines.push(
        `chain:          ${result.sections.chain.ok ? "OK" : "FAIL"} — ${result.sections.chain.detail}`,
        `clone verdict:  ${result.clone.report.finalVerdict}`,
        `devices cloned: ${Object.keys(result.idMap).length} (source→target, ids never reused)`,
        `cables:         ${result.sections.chain.ok ? "restored via chain clone (verified)" : "see failures"}`,
        `parameters:     ${result.sections.chain.ok ? "restored + verified" : "see failures"}`,
        `bindings:       ${result.sections.bindings.detail}`,
        `preset values:  ${result.sections.preset.detail}`,
        `verification:   ${result.verification.chainVerdict} · devices ${result.verification.chain.devices.matched}/${result.verification.chain.devices.expected}` +
            ` · params ${result.verification.chain.parameters.matched}/${result.verification.chain.parameters.expected}` +
            ` · conns ${result.verification.chain.connections.matched}/${result.verification.chain.connections.expected}` +
            ` · topology ${result.verification.chain.topology.equal ? "equal" : "DIFF"}`,
        `bindings readback: ${result.verification.bindings.ok ? "PASS" : "FAIL"}`,
        `preset readback:   ${result.verification.preset.ok ? "PASS" : "FAIL"}`,
        "device readback:   " + String(result.verification.chain.devices.matched),
    );
    if (result.failures.length > 0) {
        lines.push("FAILURE RECORDS:");
        result.failures.forEach((f) => lines.push(`- ${f}`));
    }
    return resultBox(result.ok, lines);
}