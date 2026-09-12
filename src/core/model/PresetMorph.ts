import type { Preset } from "./Preset";
import type { ControlType } from "./types";

function finite(v: number | undefined): number {
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * M9 — pure preset morphing.
 *
 * Returns a NEW value map (controlId → normalized 0..1) interpolating between
 * two presets. Never mutates its inputs. Values are deterministic and finite.
 *
 * Policy:
 * - amount is clamped to 0..1
 * - control in both presets: A + amount * (B - A)
 * - control only in A: keep A's value
 * - control only in B: keep B's value
 * - live switch controls (via `controlTypes`) quantize at the 0.5 boundary
 *
 * This is calculation only — no Nexus writes, no UI, no binding inspection.
 */
export function morphControlValues(
    presetA: Readonly<Pick<Preset, "controlValues">>,
    presetB: Readonly<Pick<Preset, "controlValues">>,
    amount: number,
    controlTypes: Readonly<Record<string, ControlType>> = {},
): Record<string, number> {
    const t = Number.isFinite(amount) ? Math.min(1, Math.max(0, amount)) : 0;

    const ids = new Set<string>([
        ...Object.keys(presetA.controlValues),
        ...Object.keys(presetB.controlValues),
    ]);

    const result: Record<string, number> = {};
    for (const id of ids) {
        const inA = id in presetA.controlValues;
        const inB = id in presetB.controlValues;

        let value: number;
        if (inA && inB) {
            const a = finite(presetA.controlValues[id]);
            const b = finite(presetB.controlValues[id]);
            value = a + t * (b - a);
        } else if (inA) {
            value = finite(presetA.controlValues[id]);
        } else {
            value = finite(presetB.controlValues[id]);
        }

        result[id] = controlTypes[id] === "switch" ? (value >= 0.5 ? 1 : 0) : value;
    }
    return result;
}