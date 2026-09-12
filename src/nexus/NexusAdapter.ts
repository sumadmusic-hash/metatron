import { audiotool } from "@audiotool/nexus";
import type { SyncedDocument } from "@audiotool/nexus";
import { BindingManager } from "../core/BindingManager";
import { createNexusValueMapping, mapNormalizedToNexus, mapNexusToNormalized } from "./NexusValueMapping";
import { resolveFieldByPath } from "./ChainPath";

/**
 * Resolve the OAuth redirect URL from the browser's current origin.
 *
 * The @audiotool/nexus SDK uses `redirectUrl` verbatim as the OAuth
 * `redirect_uri` (see its docs: `redirectUrl: "http://127.0.0.1:5173/"`) and
 * the Audiotool application validates the redirect origin server-side. Using
 * the live `window.location.origin` removes the development-host assumption:
 * locally it resolves to the dev server origin, in production to whatever
 * origin the app is served from. The trailing slash matches the SDK's
 * documented redirect-uri form.
 */
export function resolveOauthRedirectUrl(origin: string): string {
    return origin.endsWith("/") ? origin : `${origin}/`;
}

export class NexusAdapter {
    private client: any = null;
    public document: SyncedDocument | null = null;
    private bindingManager: BindingManager | null = null;

    // Track active event listeners to prevent memory leaks
    private updateListeners: Map<string, () => void> = new Map();
    private connectionCleanup?: () => void;

    private STATUS_LOG = "[METATRON NEXUS]";

    // Callback when a value changes in Nexus, so Metatron can update the UI/Control
    public onNexusValueChanged?: (controlId: string, newValue: number) => void;

    /** Whether the open document is actually syncing with the backend. */
    public isDocumentConnected(): boolean {
        if (!this.document) return false;
        try {
            const connected = (this.document as any).connected;
            return connected && typeof connected.getValue === "function" ? connected.getValue() : true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Subscribes to the open document's live sync state so the UI can reflect
     * whether parameter changes can actually be observed (learn/remote reads).
     * Returns a cleanup function.
     */
    public onDocumentConnectedChanged(callback: (connected: boolean) => void): () => void {
        this.connectionCleanup?.();
        if (!this.document) {
            callback(false);
            return () => {};
        }
        const notifier = (this.document as any).connected;
        if (!notifier || typeof notifier.subscribe !== "function") {
            callback(true);
            return () => {};
        }
        const terminable = notifier.subscribe((v: boolean) => {
            console.log(`${this.STATUS_LOG} connected=${v}`);
            callback(v);
        }, true);
        this.connectionCleanup = typeof terminable === "function" ? terminable : () => terminable.terminate();
        return this.connectionCleanup ?? (() => {});
    }

    public async authenticate(clientId: string): Promise<boolean> {
        this.client = await audiotool({ 
            clientId,
            redirectUrl: resolveOauthRedirectUrl(window.location.origin),
            scope: "project:write"
        });
        
        if (this.client.status === "unauthenticated") {
            // Need user interaction for popup/redirect, but here we trigger redirect
            this.client.login();
            return false;
        }
        return true;
    }

    public async openProject(projectUrl: string, bindingManager: BindingManager) {
        if (!this.client || this.client.status !== "authenticated") {
            throw new Error("Client not authenticated");
        }

        if (this.document) {
            await this.document.stop();
            this.clearAllListeners();
        }

        this.document = await this.client.open(projectUrl);
        this.bindingManager = bindingManager;
        
        // Let the binding manager know a new project is loaded
        this.bindingManager.onProjectLoaded();

        // Start syncing
        await this.document!.start();
    }

    public async updateParameter(entityId: string, fieldName: string, value: any) {
        if (!this.document) return;

        const entity = this.document.queryEntities.getEntity(entityId);
        if (!entity) {
            console.error(`NexusAdapter: Entity ${entityId} not found`);
            return;
        }

        const field = (entity.fields as any)[fieldName];
        if (!field) {
            console.error(`NexusAdapter: Field ${fieldName} not found on entity ${entityId}`);
            return;
        }

        try {
            await this.document.modify(t => {
                t.update(field, value);
            });
        } catch (e) {
            console.error(`NexusAdapter: Failed to update parameter:`, e);
        }
    }

    /** Writes a value for a control's active binding. Input `value` is the
     *  NORMALIZED Metatron value 0..1; it is mapped into the real Nexus range
     *  via the binding's value mapping (schema-derived) before the write.
     *  Returns false (with NO pending async operation) when not bound / no
     *  document / document disconnected / immutable field / unsupported
     *  mapping; returns true only after the write transaction completed. */
    public async updateBoundControl(controlId: string, value: number): Promise<boolean> {
        if (!this.document || !this.bindingManager) return false;
        const binding = this.bindingManager.getActiveBinding(controlId);
        if (!binding) return false;

        const field = this.resolveField(binding);
        if (!field) return false;

        if (!this.isDocumentConnected()) {
            console.warn(`[METATRON NEXUS WRITE] refused control=${controlId} field=${binding.fieldPath ?? binding.fieldName} reason=document-disconnected`);
            return false;
        }

        if (field.mutable === false) {
            console.warn(`[METATRON NEXUS WRITE] refused control=${controlId} field=${binding.fieldPath ?? binding.fieldName} reason=field-immutable`);
            return false;
        }

        const mapping = binding.valueMapping ?? createNexusValueMapping(field);
        const mapped = mapNormalizedToNexus(mapping, value);
        if (mapped === undefined) {
            console.warn(`[METATRON NEXUS WRITE] refused control=${controlId} field=${binding.fieldPath ?? binding.fieldName} reason=no-numeric-mapping (${mapping.typeLabel ?? mapping.kind})`);
            return false;
        }

        try {
            await this.document.modify(t => {
                t.update(field, mapped);
            });
            console.log(`[METATRON NEXUS WRITE] control=${controlId} field=${binding.fieldPath ?? binding.fieldName} normalized=${Number(value).toFixed(4)} -> nexus=${mapped}`);
            return true;
        } catch (e) {
            console.error(`NexusAdapter: Failed to update bound control ${controlId}:`, e);
            return false;
        }
    }

    /**
     * Resolves the live field object for a binding: prefers the stored live
     * reference, otherwise navigates `entity.fields` along the dot path.
     * Navigation uses the SINGLE canonical resolver (`ChainPath`) — the same
     * semantic the import path uses — so no second, subtly different resolver
     * lives in production.
     */
    private resolveField(binding: { field?: any; fieldPath?: string }) {
        if (binding.field) return binding.field;
        if (!this.document) return undefined;
        const entity = this.document.queryEntities.getEntity((binding as any).entityId);
        if (!entity) return undefined;
        const path = (binding.fieldPath ?? (binding as any).fieldName) as string | undefined;
        if (!path) return undefined;
        const current = resolveFieldByPath(entity.fields, path);
        if (current && typeof current === "object" && "value" in current && "location" in current) {
            return current;
        }
        return undefined;
    }

    public subscribeToParameter(controlId: string, entityId: string, fieldName: string) {
        if (!this.document) return;

        // Cleanup existing listener for this control if any
        this.unsubscribeFromParameter(controlId);

        const entity = this.document.queryEntities.getEntity(entityId);
        if (!entity) return;

        const field = (entity.fields as any)[fieldName] as any;
        if (!field || field.mutable === false) return;

        const cleanup = this.document!.events.onUpdate(field, (newValue: any) => {
            if (this.onNexusValueChanged) {
                // We assume numeric values for knobs/switches in v0.1
                this.onNexusValueChanged(controlId, Number(newValue));
            }
        });

        if (typeof cleanup === "function") {
            this.updateListeners.set(controlId, cleanup);
        } else if (cleanup && typeof cleanup.terminate === "function") {
            this.updateListeners.set(controlId, () => cleanup.terminate());
        }
    }

    /** Subscribes a control's active binding field so remote changes flow to the UI. */
    public subscribeBoundControl(controlId: string) {
        if (!this.document || !this.bindingManager) return;
        const binding = this.bindingManager.getActiveBinding(controlId);
        if (!binding) return;

        this.unsubscribeFromParameter(controlId);

        const field = this.resolveField(binding);
        if (!field || field.mutable === false) {
            console.warn(`[METATRON NEXUS EVENT] subscribe skipped control=${controlId} reason=field-not-resolvable-or-immutable field=${binding.fieldPath ?? binding.fieldName}`);
            return;
        }

        const mapping = binding.valueMapping ?? createNexusValueMapping(field);

        const cleanup = this.document!.events.onUpdate(field, (newValue: any) => {
            const normalized = mapNexusToNormalized(mapping, newValue);
            console.log(`[METATRON NEXUS EVENT] control=${controlId} field=${binding.fieldPath ?? binding.fieldName} nexus=${String(newValue)} normalized=${normalized.toFixed(4)}`);
            if (this.onNexusValueChanged) {
                this.onNexusValueChanged(controlId, normalized);
            }
        });

        if (typeof cleanup === "function") {
            this.updateListeners.set(controlId, cleanup);
        } else if (cleanup && typeof cleanup.terminate === "function") {
            this.updateListeners.set(controlId, () => cleanup.terminate());
        }
    }

    public unsubscribeFromParameter(controlId: string) {
        const cleanup = this.updateListeners.get(controlId);
        if (cleanup) {
            cleanup();
            this.updateListeners.delete(controlId);
        }
    }

    private clearAllListeners() {
        this.updateListeners.forEach(cleanup => cleanup());
        this.updateListeners.clear();
    }
}
