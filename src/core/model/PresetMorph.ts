import type { Preset } from "./Preset";
import type { ControlType } from "./types";

function finite(v: number | undefined): number {
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function quantize(id: string, value: number, controlTypes: Readonly<Record<string, ControlType>>): number {
    return controlTypes[id] === "switch" ? (value >= 0.5 ? 1 : 0) : value;
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
    const kvA = presetA.controlValues;
    const kvB = presetB.controlValues;

    const result: Record<string, number> = {};

    for (const id of Object.keys(kvA)) {
        const a = finite(kvA[id]);
        const value = id in kvB ? a + t * (finite(kvB[id]) - a) : a;
        result[id] = quantize(id, value, controlTypes);
    }

    for (const id of Object.keys(kvB)) {
        if (!(id in kvA)) {
            result[id] = quantize(id, finite(kvB[id]), controlTypes);
        }
    }

    return result;
}