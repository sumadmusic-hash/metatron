// Type imports removed since they are unused
import { Device } from "./model/Device";
import type { LearnResult } from "../nexus/NexusLearn";
import type { NexusValueMapping } from "../nexus/NexusValueMapping";

export interface ActiveBinding {
    entityId: string;
    fieldName: string;
    /** Full dot path of the field (e.g. "oscillatorA.channel.isActive"); equals
     * fieldName for top-level fields. Used to resolve the live field object. */
    fieldPath?: string;
    /** Project-specific value mapping (normalized 0..1 ↔ Nexus range), derived
     * from the real field schema at Learn time. Transient: NOT part of the
     * project-independent Device definition (§2 — mapping belongs to Binding). */
    valueMapping?: NexusValueMapping;
    /** Live reference to the Nexus field object so values can be written and observed. */
    field: any;
}

export class BindingManager {
    private device: Device;
    
    // In-memory mapping of Control ID to actual Nexus Entity and Field IDs for the current project
    private activeBindings: Map<string, ActiveBinding> = new Map();

    constructor(device: Device) {
        this.device = device;
    }

    public get deviceRef(): Device {
        return this.device;
    }

    /** Re-point the manager at another Device (device switching, Phase B).
     *  Same-instance refreshes (preset load, undo/redo, rename) must NOT
     *  destroy the current project's live bindings. */
    public setDevice(device: Device) {
        if (device === this.device) {
            return;
        }
        this.device = device;
        this.activeBindings.clear();
    }

    /**
     * Called when a new project is loaded.
     * All existing binding definitions become DISCONNECTED because active bindings are project-specific.
     */
    public onProjectLoaded() {
        this.activeBindings.clear();
        
        this.device.controls.forEach(control => {
            if (control.audiotoolBindingDefinition) {
                control.activeBindingState = "DISCONNECTED";
            } else {
                control.activeBindingState = "UNCONFIGURED";
            }
        });
    }

    /**
     * Create an active binding for the current project from a Learn result.
     * The live field object is stored so NexusAdapter can subscribe + write.
     */
    public applyLearnResult(controlId: string, result: LearnResult) {
        this.setBinding(controlId, result.entityId, result.fieldName, result.targetName, result.field, result.fieldPath, result.valueMapping);
    }

    /**
     * Create an active binding for the current project.
     */
    public setBinding(controlId: string, entityId: string, fieldName: string, targetName?: string, field?: any, fieldPath?: string, valueMapping?: NexusValueMapping) {
        const control = this.device.getControl(controlId);
        if (!control) return;

        this.activeBindings.set(controlId, { entityId, fieldName, field, fieldPath: fieldPath ?? fieldName, valueMapping });
        
        // Update or create the persistent project-independent binding definition
        if (!control.audiotoolBindingDefinition) {
            control.audiotoolBindingDefinition = {};
        }
        
        if (targetName) {
            control.audiotoolBindingDefinition.targetName = targetName;
        }

        control.activeBindingState = "CONNECTED";
    }

    /**
     * Clears a binding completely from a control.
     */
    public clearBinding(controlId: string) {
        const control = this.device.getControl(controlId);
        if (!control) return;

        this.activeBindings.delete(controlId);
        control.audiotoolBindingDefinition = undefined;
        control.activeBindingState = "UNCONFIGURED";
    }

    public getActiveBinding(controlId: string): ActiveBinding | undefined {
        return this.activeBindings.get(controlId);
    }
}