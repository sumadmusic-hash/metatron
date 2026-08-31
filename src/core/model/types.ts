export type Position = { x: number; y: number };
export type Size = { width: number; height: number };

export type ControlType = "knob" | "switch";

export type BindingState = "UNCONFIGURED" | "DISCONNECTED" | "CONNECTED";

/** 
 * Unique ID generator for stable references.
 * We use randomUUID but slice it short for readability as per spec.
 */
export function generateId(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

export interface VisualDefinition {
    backgroundColor?: string;
    /** Color of the rectangular visual background area around the control (spec §13). */
    color?: string;
    // Future visual properties can be added here
}

export interface NexusBindingDefinition {
    // Project-independent definition of the binding
    // In a real scenario, this might store entity type and parameter name
    // to aid the user, but the actual binding is project-specific.
    targetName?: string;
}

export interface MidiBindingDefinition {
    channel?: number;
    cc?: number;
    /**
     * Optional scaling of incoming CC values (0..127) into the control's
     * normalized value range 0..1 (C2). Every field is optional: a mapping
     * without scaling fields keeps the legacy identity behavior
     * `clamp(raw / 127, 0, 1)`. Number defaults/guards are applied by
     * `sanitizeMidiScaling` in src/midi/MidiScaling.ts.
     */
    /** Lower output bound (clamped to 0..1; default 0). */
    min?: number;
    /** Upper output bound (clamped to 0..1; default 1). */
    max?: number;
    /** Mirror the raw position 0↔127 before the curve is applied. */
    flip?: boolean;
    /** Power curve exponent (> 0; default 1). */
    exponent?: number;
}
