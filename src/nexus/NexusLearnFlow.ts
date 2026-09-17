import { NexusLearn, LearnTimeoutError, LearnCancelledError } from "./NexusLearn";
import { applyLearnedControlName, buildLearnedControlName, resolveEntityDisplayName } from "./ControlNaming";
import { createNexusValueMapping, mapNexusToNormalized } from "./NexusValueMapping";
import { Toast } from "../ui/Toast";
import type { LearnResult } from "./NexusLearn";
import type { Control } from "../core/model/Control";
import { taperKey } from "./CurveRegistry";
import { getParameterUICurve, nexusNormToUi } from "./ParameterUICurve";

/**
 * Dependencies the shared Nexus-Learn flow needs from its host UI (P3.2:
 * EditorUI and SurfaceUI previously carried byte-identical copies of this
 * flow). Every reference that changes over time is read via a method/getter
 * so the flow never caches a stale snapshot.
 */
export interface NexusLearnFlowDeps {
    /** Live project document; read via a getter because the adapter's
     *  document property changes when the project is switched. */
    getDocument(): any | null;
    /** Re-establish the live subscription for a control after a successful learn. */
    subscribeBoundControl(controlId: string): void;
    /** Create/overwrite a nexus binding for the control (BindingManager). */
    applyLearnResult(controlId: string, result: LearnResult): void;
    /** Persist the current device after a successful learn. */
    saveCurrentDevice(): void;
    /** Reflect the captured value onto the model/UI (normalized 0..1). */
    reflectValue(controlId: string, normalized: number): void;
    /** Host re-render after the learning state changed (or the flow ended). */
    onStateChanged(): void;
}

/**
 * Single shared implementation of the per-control Nexus Learn flow.
 *
 * Handles: connect-check, toggle-off-on-re-click, mid-flight target switch
 * guard, success (apply result + auto-naming + resubscribe + persist +
 * value reflection + toast), timeout/cancel/failure toasts, and cancel.
 * Both EditorUI and SurfaceUI delegate the exact same steps here (P3.2).
 */
export class NexusLearnFlow {
    private readonly deps: NexusLearnFlowDeps;
    private activeLearn: NexusLearn | null = null;
    private activeControlId: string | null = null;

    constructor(deps: NexusLearnFlowDeps) {
        this.deps = deps;
    }

    /** True while a learn is in progress (drives the overlay bar). */
    public get isActive(): boolean {
        return this.activeControlId !== null;
    }

    public get learningControlId(): string | null {
        return this.activeControlId;
    }

    /**
     * Start learn for `control`. If a learn is already running for another
     * control, it is toggled OFF first (same behaviour as before). Returns
     * immediately when no project document is connected.
     */
    public async learn(control: Control): Promise<void> {
        if (this.isActive) {
            this.cancel();
            return;
        }
        const document = this.deps.getDocument();
        if (!document) {
            Toast.show("Connect to an Audiotool project first.", "error");
            return;
        }

        this.activeLearn = new NexusLearn(document);
        this.activeControlId = control.id;
        this.deps.onStateChanged();

        try {
            const result = await this.activeLearn.startLearn({ timeoutMs: 60000 });
            if (this.activeControlId !== control.id) {
                // User switched target mid-learning; drop this result.
                this.activeLearn = null;
                this.deps.onStateChanged();
                return;
            }
            this.activeLearn = null;
            this.activeControlId = null;
            this.deps.applyLearnResult(control.id, result);
            // Automatic naming (M4): manual-named controls are never overwritten.
            applyLearnedControlName(
                control,
                buildLearnedControlName(
                    resolveEntityDisplayName(document, result.entityId),
                    result.entityType,
                    result.fieldPath,
                ),
            );
            this.deps.subscribeBoundControl(control.id);
            this.deps.saveCurrentDevice();
            console.log(`[METATRON LEARN SUCCESS] controlId=${control.id} entityId=${result.entityId} fieldName=${result.fieldPath} value=${result.value}`);
            // Reflect the learned value immediately (normalized 0..1 → UI-normalized).
            const mapping = result.valueMapping ?? createNexusValueMapping(result.field);
            const nexusNorm = mapNexusToNormalized(mapping, result.value);
            // UI-Kurve: nexus-normalized → Metatron UI 0..1 (Audiotool-Knob-Position).
            const targetName = control.audiotoolBindingDefinition?.targetName;
            const uiCurve = getParameterUICurve(taperKey(targetName, result.fieldPath));
            this.deps.reflectValue(control.id, nexusNormToUi(uiCurve, nexusNorm));
            Toast.show(`Learned → ${result.targetName}`, "success");
        } catch (e) {
            this.activeLearn = null;
            this.activeControlId = null;
            if (e instanceof LearnTimeoutError) {
                Toast.show("Learn timed out (60s). No change was captured.", "error");
            } else if (e instanceof LearnCancelledError) {
                Toast.show("Learn cancelled. No binding was created.", "info");
            } else {
                Toast.show(`Learn failed: ${e instanceof Error ? e.message : String(e)}`, "error");
            }
        }
        this.deps.onStateChanged();
    }

    /** Cancel an in-progress learn (if any) and reset the overlay state. */
    public cancel(): void {
        this.activeLearn?.cancelLearn();
        this.activeLearn = null;
        this.activeControlId = null;
        this.deps.onStateChanged();
    }
}
