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
}
