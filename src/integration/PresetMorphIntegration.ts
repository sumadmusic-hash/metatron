import type { Device } from "../core/model/Device";
import type { ControlType } from "../core/model/types";
import type { Preset } from "../core/model/Preset";
import { morphControlValues } from "../core/model/PresetMorph";

/**
 * M10 — apply a morph result to the current live Metatron controls.
 *
 * Pure calculation (`morphControlValues`) is connected to the live device:
 *   Preset A + Preset B + amount
 *     → morphControlValues(...)
 *     → live control.value updated
 *     → existing Nexus write path (for CONNECTED controls)
 *
 * No controls are created/deleted; nothing except `control.value` changes.
 * Nexus writes are delegated to the injected sink (the caller passes the
 * same `updateBoundControl` mechanism used by preset loading). If the sink
 * refuses (e.g. document disconnected), the local value stays — exactly like
 * existing preset load behavior. No queueing or retry.
 */

export interface MorphValueSink {
    updateBoundControl(controlId: string, value: number): Promise<boolean>;
}

const NOOP_SINK: MorphValueSink = {
    updateBoundControl: async () => true,
};

export function applyMorphToDevice(
    device: Device,
    presetA: Readonly<Pick<Preset, "controlValues">>,
    presetB: Readonly<Pick<Preset, "controlValues">>,
    amount: number,
    sink: MorphValueSink = NOOP_SINK,
): Record<string, number> {
    const controlTypes: Record<string, ControlType> = {};
    device.controls.forEach((control) => {
        controlTypes[control.id] = control.type;
    });

    const result = morphControlValues(presetA, presetB, amount, controlTypes);

    device.controls.forEach((control) => {
        if (control.archived) return;
        const morphed = result[control.id];
        if (morphed === undefined) return;

        control.value = morphed;
        if (control.activeBindingState === "CONNECTED") {
            sink.updateBoundControl(control.id, morphed).then(
                (ok) => {
                    if (!ok) {
                        console.warn(`[MORPH WRITE] control=${control.id} write refused — local value kept (${Number(morphed).toFixed(4)})`);
                    }
                },
                (e) => {
                    console.error(`[MORPH WRITE] control=${control.id} write error:`, e);
                },
            );
        }
    });

    return result;
}