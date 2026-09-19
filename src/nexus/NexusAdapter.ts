import { audiotool } from "@audiotool/nexus";
import type { SyncedDocument } from "@audiotool/nexus";
import { BindingManager } from "../core/BindingManager";
import { createNexusValueMapping, mapNormalizedToNexus, mapNexusToNormalized } from "./NexusValueMapping";
import { resolveFieldByPath } from "./ChainPath";
import { taperKey } from "./CurveRegistry";
import { getParameterUICurve, uiToNexusNorm, nexusNormToUi } from "./ParameterUICurve";
import { resolveCurrentUser, type CurrentUser } from "./CurrentUser";

/** B9 — Verbose-Gate für die Hot-Path-Logs. Jeder erfolgreiche Modulations-
 *  Write feuert hier den Write-Log UND — weil der Write per onUpdate als
 *  Eigen-Echo zurückkommt und erst NACH dem Log konsumiert (consumeEcho) wird —
 *  wenig später den Event-Log desselben Werts: ein modulierter Wertwechsel =
 *  zwei console.log. Bei bis zu 4 Writes/Tick × ~30 Hz rattert das schnell.
 *  Die vier Log-Zweige (CURVE/kein-Curve, je Write+Event) hängen alle hinter
 *  diesem Schalter. Fehlerzustände (console.warn-Refusals, console.error-Catch)
 *  bleiben bewusst immer sichtbar. */
const NEXUS_VERBOSE_LOGGING = false;

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
    /** R1 — der zuletzt verwendete ClientId (für einen späteren login(), der
     *  ohne neuen authenticate()-Durchlauf auskommt). */
    private clientId?: string;
    public document: SyncedDocument | null = null;
    private bindingManager: BindingManager | null = null;

    /** In-memory only (B72): display name of the authenticated session user.
     *  Re-resolved on every successful authenticate()/openProject(); never
     *  persisted to any device/preset/history/storage export. */
    private currentUser?: CurrentUser;

    /** Read-only, defensive ID-token lookup. ID_TOKEN_STORAGE_KEYS stays EMPTY
     *  unless Schritt-0-Discovery names the real key; an opaque/absent token
     *  degrades to "no chip", never to a guess. (Current discovery: the
     *  AuthenticatedClient exposes `userName` directly — Path A — so no
     *  storage key is needed.) */
    private static readonly ID_TOKEN_STORAGE_KEYS: string[] = [];
    private lookupIdToken(): string | undefined {
        try {
            const c: any = this.client;
            const direct = c?.idToken ?? c?.tokens?.id ?? c?.tokens?.idToken ?? c?.session?.idToken;
            if (typeof direct === "string" && direct !== "") return direct;
            for (const k of NexusAdapter.ID_TOKEN_STORAGE_KEYS) {
                const v = localStorage.getItem(k);
                if (typeof v === "string" && v !== "") return v;
            }
        } catch {
            return undefined;
        }
        return undefined;
    }

    public getCurrentUser(): CurrentUser | undefined {
        return this.currentUser;
    }

    // Track active event listeners to prevent memory leaks
    private updateListeners: Map<string, () => void> = new Map();
    private connectionCleanup?: () => void;

    /** Phase 2 (FIX 1) — echo guard: expected normalized round-trip values of
     *  our own recent Nexus writes per control, each with its expiry window. A
     *  remote echo matching ANY guard entry is consumed in
     *  `subscribeBoundControl` and never re-applied to the UI. Ring of the
     *  last 8 writes absorbs late/offset echoes (sync latency) instead of a
     *  single slot (B12). */
    private echoGuard = new Map<string, { value: number; expiresAt: number }[]>();

    /** URL of the last SUCCESSFULLY opened project (set after `client.open`).
     *  Used to distinguish a same-URL RECONNECT from a genuinely new project:
     *  reconnect must keep the user's active bindings (§40). */
    private lastProjectUrl?: string;

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
            // B5 — Frühabbruch bereinigt auch die Property: ein verwaister
            // Cleanup des VORHERIGEN Dokuments darf nicht als "ererbt"
            // weiterleben, und der Aufrufer bekommt einen echten No-op.
            this.connectionCleanup = undefined;
            callback(false);
            return () => {};
        }
        const notifier = (this.document as any).connected;
        if (!notifier || typeof notifier.subscribe !== "function") {
            this.connectionCleanup = undefined;
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

    /** R1 — idempotente Client-Fabrik. Sowohl authenticate() (passiv,
     *  Zustandsbericht beim Boot) als auch login() (explizit, per Nutzeraktion
     *  im Header) brauchen einen konstruierten Client; login() muss auch OHNE
     *  vorigen authenticate()-Durchlauf funktionieren. Einmal gebaut bleibt
     *  der Client erhalten — keine Neu-Konstruktion pro Aufruf. */
    private async ensureClient(clientId?: string): Promise<any> {
        if (this.client) return this.client;
        const id = clientId ?? this.clientId;
        if (!id) throw new Error("No client id");
        this.client = await audiotool({
            clientId: id,
            redirectUrl: resolveOauthRedirectUrl(window.location.origin),
            scope: "project:write"
        });
        this.clientId = id;
        return this.client;
    }

    public async authenticate(clientId: string): Promise<boolean> {
        this.client = await this.ensureClient(clientId);

        if (this.client.status === "unauthenticated") {
            // B6 — KEIN impliziter login()-Redirect beim Laden der App: ein
            // OAuth-Wechsel würde die gerade gebaute Oberfläche sofort wieder
            // wegwerfen. authenticate() ist reiner passiver Zustandsbericht;
            // eine explizite Anmeldung erfolgt über den Login-Aktionspfad (R1).
            console.log(`[METATRON NEXUS] unauthenticated — no implicit login redirect (B6)`);
            return false;
        }
        this.currentUser = resolveCurrentUser(this.client, () => this.lookupIdToken());
        return true;
    }

    /** R1 — explizite Anmeldung per Nutzeraktion (Sign-in-Button im Header).
     *  Löst den OAuth-Redirect des Clients aus; Fehler landen im Log, die
     *  Seite wird im Erfolgsfall vom Provider ohnehin neu geladen. */
    public async login(): Promise<void> {
        try {
            const client = await this.ensureClient();
            if (client.status === "authenticated") return;
            await client.login();
        } catch (e) {
            console.error("[METATRON NEXUS] login() failed:", e);
        }
    }

    /** R1 — öffentlicher Statusgeber: authentifizierte Session ja/nein.
     *  Treibt den Sign-in-Button (Header) und den Connect-Guard. */
    public isAuthenticated(): boolean {
        return !!this.client && this.client.status === "authenticated";
    }

    public async openProject(projectUrl: string, bindingManager: BindingManager) {
        if (!this.client || this.client.status !== "authenticated") {
            throw new Error("Client not authenticated");
        }
        this.currentUser = resolveCurrentUser(this.client, () => this.lookupIdToken());

        // §40 — reconnecting to the SAME project URL (e.g. after a short sync
        // drop) is NOT a new project. Hard-resetting every binding
        // (onProjectLoaded) would force the user to re-learn every control;
        // a soft reconnect keeps the active bindings instead.
        const sameProject = this.lastProjectUrl !== undefined && projectUrl === this.lastProjectUrl;

        // B5 — während des asynchronen open() darf weder das alte (gestoppte)
        // Dokument noch der alte BindingManager sichtbar bleiben: parallele
        // Aufrufe (updateBoundControl/subscribeBoundControl) würden sonst
        // Bindings des VORHERIGEN Projekts gegen einen toten Document
        // re-resolven. Erst nach erfolgreichem open werden beide frisch
        // gesetzt — document zuerst, dann der neue bindingManager.
        if (this.document) {
            await this.document.stop();
            this.clearAllListeners();
        }
        this.document = null;
        this.bindingManager = null;

        this.document = await this.client.open(projectUrl);
        this.bindingManager = bindingManager;

        if (sameProject) {
            // Soft reconnect: keep the active bindings, re-resolve each live
            // field reference against the freshly opened document (same project
            // → same entity ids, but NEW field wrapper objects) and re-own the
            // parameter subscriptions so the reconnect is transparent.
            this.bindingManager.rehydrateActiveBindings((entityId, fieldPath) =>
                this.resolveFieldByEntityPath(entityId, fieldPath)
            );
            for (const controlId of this.bindingManager.getActiveBindingControlIds()) {
                this.subscribeBoundControl(controlId);
            }
        } else {
            // New project URL (or first connect): every configured control
            // becomes DISCONNECTED until it is re-learned against this project.
            this.bindingManager.onProjectLoaded();
        }

        await this.document!.start();

        this.lastProjectUrl = projectUrl;
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
        if (mapping.kind === "unsupported") {
            console.warn(`[METATRON NEXUS WRITE] refused control=${controlId} field=${binding.fieldPath ?? binding.fieldName} reason=no-numeric-mapping (${mapping.typeLabel ?? mapping.kind})`);
            return false;
        }
        // UI-Kurve: Metatron UI 0..1 → Nexus-normalized 0..1 über der gemessenen
        // Audiotool-Knob-Transferfunktion. Ohne gemessenen Eintrag = Identity.
        const path = binding.fieldPath ?? binding.fieldName ?? "";
        const targetName = this.bindingManager.deviceRef.controls.get(controlId)?.audiotoolBindingDefinition?.targetName;
        const uiCurve = getParameterUICurve(taperKey(targetName, path));
        const nexusNorm = uiToNexusNorm(uiCurve, value);
        const mapped = mapNormalizedToNexus(mapping, nexusNorm);
        if (mapped === undefined) {
            console.warn(`[METATRON NEXUS WRITE] refused control=${controlId} field=${binding.fieldPath ?? binding.fieldName} reason=mapNormalizedToNexus returned undefined`);
            return false;
        }

        try {
            await this.document.modify(t => {
                t.update(field, mapped);
            });
            // B9 — beide Log-Zweige hinter dem Verbose-Gate (Hit-Pfad: jeder
            // modulierte Write loggt hier UND als Eigen-Echo im onUpdate).
            if (NEXUS_VERBOSE_LOGGING) {
                if (uiCurve) {
                    console.log(
                        `[METATRON CURVE] control=${controlId} field=${path} ` +
                            `ui=${Number(value).toFixed(4)} → nexusNorm=${nexusNorm.toFixed(4)} → raw=${mapped} ` +
                            `curve=${uiCurve.points.length}pts (source:${uiCurve.source})`
                    );
                } else {
                    console.log(`[METATRON NEXUS WRITE] control=${controlId} field=${path} normalized=${Number(value).toFixed(4)} -> nexus=${mapped}`);
                }
            }
            return true;
        } catch (e) {
            console.error(`NexusAdapter: Failed to update bound control ${controlId}:`, e);
            return false;
        }
    }

    /** Phase 2 (FIX 1) — register the expected echo-guard value for a control
     *  about to be written to Nexus. The guard value is computed through the
     *  SAME mapping round-trip the write and the event use — integer fields
     *  round on write, so comparing against the raw written value would
     *  wrongly fail the echo match. Guards are kept as a ring of the last 8
     *  writes (B12): at 30 Hz writes a late echo of write N may arrive after
     *  the guard-set of write N+1. */
    public beginSuppressEcho(controlId: string, writtenNormalized: number, windowMs = 200): void {
        if (!this.bindingManager) return;
        const binding = this.bindingManager.getActiveBinding(controlId);
        if (!binding) return;
        const field = this.resolveField(binding);
        const mapping = binding.valueMapping ?? (field ? createNexusValueMapping(field) : undefined);
        if (!mapping) return;
        // UI-Kurve: writtenNormalized = Metatron UI 0..1; der Echo-Kreislauf
        // muss denselben Wert zurückvergleichen wie subscribeBoundControl
        // produziert (uiNorm), nicht den Nexus-normalisierten.
        const path = binding.fieldPath ?? binding.fieldName ?? "";
        const targetName = this.bindingManager.deviceRef.controls.get(controlId)?.audiotoolBindingDefinition?.targetName;
        const uiCurve = getParameterUICurve(taperKey(targetName, path));
        const nexusNorm = uiToNexusNorm(uiCurve, writtenNormalized);
        const mapped = mapNormalizedToNexus(mapping, nexusNorm);
        if (mapped === undefined) return;
        const expectedNexusNorm = mapNexusToNormalized(mapping, mapped);
        const expectedUi = nexusNormToUi(uiCurve, expectedNexusNorm);
        const list = this.echoGuard.get(controlId) ?? [];
        list.push({ value: expectedUi, expiresAt: Date.now() + windowMs });
        while (list.length > 8) list.shift();
        this.echoGuard.set(controlId, list);
    }

    /** Phase 2 (FIX 1) — absorb one incoming Nexus event that is the
     *  round-trip echo of our own write. Consumes (removes) the matching
     *  guard entry, so the same guard never blocks a second real remote
     *  change. */
    private consumeEcho(controlId: string, incoming: number): boolean {
        const list = this.echoGuard.get(controlId);
        if (!list || list.length === 0) return false;
        const now = Date.now();
        const live = list.filter((g) => now <= g.expiresAt);
        if (live.length === 0) {
            this.echoGuard.delete(controlId);
            return false;
        }
        const idx = live.findIndex((g) => Math.abs(incoming - g.value) <= 1e-6);
        if (idx === -1) {
            this.echoGuard.set(controlId, live);
            return false;
        }
        live.splice(idx, 1);
        if (live.length === 0) this.echoGuard.delete(controlId);
        else this.echoGuard.set(controlId, live);
        return true;
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
        return this.resolveFieldByEntityPath((binding as any).entityId, binding.fieldPath ?? (binding as any).fieldName);
    }

    /** Navigate `entity.fields` along `fieldPath` on the CURRENT document —
     *  no stored (possibly stale) live reference involved. Used to re-resolve
     *  field wrappers after a same-URL project reconnect. */
    private resolveFieldByEntityPath(entityId: string, fieldPath: string | undefined): any {
        if (!this.document || !fieldPath) return undefined;
        const entity = this.document.queryEntities.getEntity(entityId);
        if (!entity) return undefined;
        const current = resolveFieldByPath(entity.fields, fieldPath);
        if (current && typeof current === "object" && "value" in current && "location" in current) {
            return current;
        }
        return undefined;
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

        // UI-Kurve für den Read-Pfad: NICHT beim Subscribe fixieren, sondern
        // pro Event frisch auflösen — die Kurve kann NACH dem Subscribe
        // registriert worden sein (pacedSweep/registerUICurve); eine
        // Closure-captured uiCurve wäre dann dauerhaft undefined und der
        // Read-Pfad bliebe ewig linear (B73 B-Fix).
        const path = binding.fieldPath ?? binding.fieldName ?? "";
        const targetName = this.bindingManager.deviceRef.controls.get(controlId)?.audiotoolBindingDefinition?.targetName;

        const cleanup = this.document!.events.onUpdate(field, (newValue: any) => {
            const uiCurve = getParameterUICurve(taperKey(targetName, path));
            const nexusNorm = mapNexusToNormalized(mapping, newValue);
            // Nexus-normalized → Metatron UI 0..1 (gemessene Audiotool-Knob-Position).
            const uiNorm = nexusNormToUi(uiCurve, nexusNorm);
            // B9 — beide Log-Zweige hinter dem Verbose-Gate: dieser Callback
            // empfängt JEDEN eigenen Write als Echo (der consumeEcho-Guard
            // liegt erst NACH dem Log), sonst doppelt sich jeder Wertwechsel.
            if (NEXUS_VERBOSE_LOGGING) {
                if (uiCurve) {
                    console.log(
                        `[METATRON CURVE] control=${controlId} field=${path} ` +
                            `raw=${String(newValue)} → nexusNorm=${nexusNorm.toFixed(4)} → ui=${uiNorm.toFixed(4)} ` +
                            `curve=${uiCurve.points.length}pts (source:${uiCurve.source})`
                    );
                } else {
                    console.log(`[METATRON NEXUS EVENT] control=${controlId} field=${path} nexus=${String(newValue)} normalized=${nexusNorm.toFixed(4)}`);
                }
            }
            // FIX 1 (Phase 2) — absorb our own write's echo BEFORE it is
            // re-applied to the UI: the round-trip value matches the guard,
            // so the event is ours, not a remote change.
            if (this.consumeEcho(controlId, uiNorm)) return;
            if (this.onNexusValueChanged) {
                this.onNexusValueChanged(controlId, uiNorm);
            }
        });

        if (typeof cleanup === "function") {
            this.updateListeners.set(controlId, cleanup);
        } else if (cleanup && typeof cleanup.terminate === "function") {
            this.updateListeners.set(controlId, () => cleanup.terminate());
        }

        // R3 — Backup-Cleanup auf dem Binding hinterlegen, damit der
        // BindingManager eine überholte Subscription (Control beim Rehydrieren
        // verschwunden) abräumen kann, ohne NexusAdapter-Interna zu kennen.
        binding.unsubscribe = () => this.unsubscribeFromParameter(controlId);
    }

    public unsubscribeFromParameter(controlId: string) {
        const cleanup = this.updateListeners.get(controlId);
        if (cleanup) {
            cleanup();
            this.updateListeners.delete(controlId);
        }
    }

    /** Drop EVERY live parameter subscription. Called on a real device switch:
     *  once the previous device's active bindings are gone (BindingManager
     *  semantics), its field listeners must not outlive it — a stale Nexus
     *  event for an old control id must never bleed into the newly active
     *  device (or leak listener closures). */
    public clearBoundControlSubscriptions(): void {
        this.clearAllListeners();
    }

    private clearAllListeners() {
        this.updateListeners.forEach(cleanup => cleanup());
        this.updateListeners.clear();
        // FIX 10 — the full cleanup must also drop the echo-guard ring. Every
        // suppress-guard entry is a stale expected-echo of a write made for a
        // previous device's binding; leaving it behind lets a later Nexus
        // round-trip be wrongly consumed as "our own echo" (§archivierte Listener
        // ≠ hörbar, Reflection: echoGuard is per-subscription state). Guard
        // entries expire on their own only if they were never written again, so
        // a device switch must clear them deterministically, not rely on expiry.
        this.echoGuard.clear();
    }
}
