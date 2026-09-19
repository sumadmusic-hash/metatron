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
     *  from the real field schema at Learn time. Transient: NOT part of the
     *  project-independent Device definition (§2 — mapping belongs to Binding). */
    valueMapping?: NexusValueMapping;
    /** Live reference to the Nexus field object so values can be written and observed. */
    field: any;
    /** R3 — pro Binding gespeichertes Cleanup: räumt die zugehörige
     *  Nexus-Subscription ab (NexusAdapter.subscribeBoundControl hinterlegt es).
     *  BindingManager ruft es beim Rehydrieren verwaister Bindings auf, ohne
     *  NexusAdapter-Interna zu kennen. */
    unsubscribe?: () => void;
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
     *  destroy the current project's live bindings.
     *
     *  B1 — EINHEITLICHER Wechsel-Begriff (ID, nicht Referenz), abgestimmt mit
     *  `AppUI.onDeviceChanged` (AppUI.ts:948): "gleiche ID, neue Instanz" (z. B.
     *  Undo/Redo einer Library-Aktion über `realizeDevice`, DeviceLibrary-Import)
     *  ist eine REHYDRIERUNG, kein Wechsel — `activeBindings` bleiben erhalten
     *  und werden auf die neuen Control-Instanzen übertragen ("CONNECTED" neu
     *  gepinnt; `Control.deserialize` setzt das Flag sonst auf "DISCONNECTED").
     *  Nur bei abweichender ID wird geleert. Damit stimmen `getActiveBinding`
     *  und `control.activeBindingState` nach dem Undo nie auseinander. */
    public setDevice(device: Device) {
        if (device === this.device) {
            return;
        }
        const sameDeviceId = device.id === this.device.id;
        this.device = device;
        if (sameDeviceId) {
            // Rehydrierung: bestehende Bindings auf die neuen Control-Instanzen
            // übertragen ("CONNECTED" neu pinnen — Control.deserialize setzt das
            // Flag bei der Neurealisierung sonst auf "DISCONNECTED"). Die
            // Live-Feld-Referenzen bleiben gültig: das Nexus-Dokument hat sich
            // nicht geändert, nur die Device-Wrapper-Objekte sind neu.
            for (const [controlId, binding] of this.activeBindings) {
                const control = this.device.getControl(controlId);
                if (control) {
                    control.activeBindingState = "CONNECTED";
                } else {
                    // R3 — verwaistes Binding: die gebundenen Controls wurden
                    // durch das Undo/Redo entfernt. Eintrag samt seiner
                    // Nexus-Subscription abräumen — sonst lebt der Listener
                    // weiter und die Map wächst über jeden Zyklus.
                    binding.unsubscribe?.();
                    this.activeBindings.delete(controlId);
                }
            }
            return;
        }
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

    /** Ids of every control that currently carries an active binding (used by
     *  NexusAdapter to re-establish subscriptions after a same-URL reconnect). */
    public getActiveBindingControlIds(): string[] {
        return Array.from(this.activeBindings.keys());
    }

    /**
     * SOFT reconnect to the same project URL (§40). Unlike onProjectLoaded this
     * keeps ALL active bindings; it only re-resolves each binding's live field
     * reference against the freshly opened document (same project → same entity
     * ids, but new field wrapper objects). `resolveField` returns the new field
     * for an entity id + field path, or undefined when unresolvable.
     * Unresolvable bindings are treated as orphaned: their old field reference
     * is cleared, subscriptions are cleaned up, and the binding is removed.
     */
    public rehydrateActiveBindings(resolveField: (entityId: string, fieldPath: string) => any) {
        const toDelete: string[] = [];
        this.activeBindings.forEach((binding, controlId) => {
            const field = resolveField(binding.entityId, binding.fieldPath ?? binding.fieldName);
            if (field) {
                binding.field = field;
            } else {
                // Unresolvable → orphaned binding: clear subscription and remove
                binding.unsubscribe?.();
                toDelete.push(controlId);
            }
        });
        for (const controlId of toDelete) {
            this.activeBindings.delete(controlId);
            const control = this.device.getControl(controlId);
            if (control) control.activeBindingState = "DISCONNECTED";
        }
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
     * When `targetDevice` is provided, the binding definition is written onto
     * THAT device's control instead of the manager's current device — the
     * async instrument-import pins its target device BEFORE the first `await`,
     * so the pin survives a device switch mid-import (I19.2).
     */
    public setBinding(controlId: string, entityId: string, fieldName: string, targetName?: string, field?: any, fieldPath?: string, valueMapping?: NexusValueMapping, targetDevice?: Device) {
        const device = targetDevice ?? this.device;
        const control = device.getControl(controlId);
        if (!control) return;

        // Live active bindings are transient manager state scoped to the
        // CURRENT device. Writing a binding for a DIFFERENT (pinned, no longer
        // active) device must not pollute the manager's map — the CONNECTED
        // state and the persistent binding definition still get recorded on
        // the target control below.
        if (device === this.device) {
            this.activeBindings.set(controlId, { entityId, fieldName, field, fieldPath: fieldPath ?? fieldName, valueMapping });
        }
        
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

    /** Re-maps all active bindings to the CURRENT device's Control instances.
     *  Call after an undo/redo that may have replaced Control instances with new
     *  ones (same ID, new object). Preserves binding state (field refs, subscriptions)
     *  while updating the Control reference. */
    public rehydrateToCurrentDevice(): void {
        for (const [controlId, binding] of this.activeBindings) {
            const control = this.device.getControl(controlId);
            if (control) {
                control.activeBindingState = "CONNECTED";
            } else {
                // Control no longer exists — clean up orphaned binding
                binding.unsubscribe?.();
                this.activeBindings.delete(controlId);
            }
        }
    }
}