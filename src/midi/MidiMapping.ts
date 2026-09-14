import { Device } from "../core/model/Device";
import type { MidiBindingDefinition } from "../core/model/types";

/** Outcome of a `setMapping` call (P3.1):
 *  `collision: true` reports that the new assignment DISPLACED another
 *  control's existing route — the caller is expected to surface that to
 *  the user instead of silently stealing the CC. */
export type SetMappingResult =
    | { collision: false }
    | { collision: true; displacedControlId: string };

export class MidiMapping {
    private device: Device;
    
    // Quick lookup: "channel:cc" -> controlId
    private ccMap: Map<string, string> = new Map();

    constructor(device: Device) {
        this.device = device;
        this.buildMap();
    }

    public updateDevice(device: Device) {
        this.device = device;
        this.buildMap();
    }

    private buildMap() {
        this.ccMap.clear();
        this.device.controls.forEach(control => {
            if (!control.archived && control.midiBindingDefinition) {
                const { channel, cc } = control.midiBindingDefinition;
                if (channel !== undefined && cc !== undefined) {
                    this.ccMap.set(`${channel}:${cc}`, control.id);
                }
            }
        });
    }

    public getControlIdForMessage(channel: number, cc: number): string | undefined {
        return this.ccMap.get(`${channel}:${cc}`);
    }

    /** Outcome of a `setMapping` call (P3.1):
     *  `collision: true` reports that the new assignment DISPLACED another
     *  control's existing route — the caller is expected to surface that to
     *  the user instead of silently stealing the CC. */
    public setMapping(controlId: string, channel: number, cc: number): SetMappingResult {
        const control = this.device.getControl(controlId);
        if (!control) return { collision: false };

        const existingControlId = this.ccMap.get(`${channel}:${cc}`);
        const collision = existingControlId !== undefined && existingControlId !== controlId;

        if (collision) {
            // The displaced control's stored definition must stay consistent
            // with the rebuilt map: the route now belongs to the NEW control,
            // so the old one is cleared (otherwise its model claims a route
            // that the map no longer routes to it).
            const displaced = this.device.getControl(existingControlId as string);
            if (displaced) displaced.midiBindingDefinition = undefined;
        }

        // C2: channel/cc are replaced; any existing scaling fields
        // (min/max/flip/exponent) are preserved as-is — no scaling defaults
        // are injected here. Without scaling the result is byte-identical
        // to the legacy `{ channel, cc }` shape.
        const current = control.midiBindingDefinition;
        control.midiBindingDefinition = { ...(current ?? {}), channel, cc };
        this.buildMap();

        return collision
            ? { collision: true, displacedControlId: existingControlId as string }
            : { collision: false };
    }

    /** Reverse lookup (C2 §7): the current MidiBindingDefinition of the given
     *  control, mirroring the forward-map semantics of `buildMap` exactly —
     *  `undefined` for unknown, archived, or incompletely mapped controls
     *  (channel or cc undefined). No second map, no persistence.
     *
     *  F-6 (deliberate): returns the LIVE stored definition, not a copy. The
     *  scaling editor and readout therefore always reflect the authoritative
     *  model value, and callers must treat the result as read-only — edits go
     *  through `setMapping` / a fresh `{ ...old, ...patch }` assignment, never
     *  in-place mutation (which would bypass `buildMap`). */
    public getMappingForControl(controlId: string): MidiBindingDefinition | undefined {
        const control = this.device.getControl(controlId);
        if (!control || control.archived) return undefined;
        const definition = control.midiBindingDefinition;
        if (!definition || definition.channel === undefined || definition.cc === undefined) {
            return undefined;
        }
        return definition;
    }

    public clearMapping(controlId: string) {
        const control = this.device.getControl(controlId);
        if (control) {
            control.midiBindingDefinition = undefined;
            this.buildMap();
        }
    }
}
