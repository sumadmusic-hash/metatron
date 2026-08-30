import type { SyncedDocument } from "@audiotool/nexus";
import { TargetType, getSchemaLocationDetails } from "@audiotool/nexus/document";
import type { NexusValueMapping } from "./NexusValueMapping";
import { createNexusValueMapping } from "./NexusValueMapping";

/** Result of a successful Learn detection. */
export interface LearnResult {
    entityId: string;
    entityType: string;
    /** Top-level key of the entity's `fields` object (kept for backwards compat). */
    fieldName: string;
    /** Full dot path of the detected field, e.g. "oscillatorA.channel.isActive".
     *  For top-level fields this equals `fieldName`. */
    fieldPath: string;
    /** The new value the field received (raw Nexus value). */
    value: any;
    /** Value mapping derived from the real schema of the captured field. */
    valueMapping?: NexusValueMapping;
    /** Human readable target description like "stompboxDelay / feedbackFactor". */
    targetName: string;
    /** Live reference to the Nexus field object, used for writes and subscriptions. */
    field: any;
}

export interface NexusLearnOptions {
    /**
     * Only listen to fields whose schema marks them as AutomatableParameter.
     * Defaults to true. This prevents desktop position moves, display name edits,
     * cable re-wires etc. from being captured as a "parameter".
     */
    filterToAutomatableParameters?: boolean;
    /** Time in ms after which Learn fails with a LearnTimeoutError. No timeout when unset. */
    timeoutMs?: number;
    /**
     * Human readable description of the project/entity context used to ignore
     * changes that originate from Metatron itself, if a mechanism is needed.
     * Reserved for v0.1; not used yet.
     */
    ignoreOwnChanges?: boolean;
}

/** Thrown when Learn times out. */
export class LearnTimeoutError extends Error {
    constructor() {
        super("Learn timed out");
        this.name = "LearnTimeoutError";
    }
}

/** Thrown when Learn is cancelled by the user before a change was captured. */
export class LearnCancelledError extends Error {
    constructor() {
        super("Learn cancelled");
        this.name = "LearnCancelledError";
    }
}

/**
 * Implements the Audiotool Learn mechanism.
 *
 * Semantics (spec §23): "First valid parameter change wins."
 * - All AutomatableParameter fields of all entities are subscribed to —
 *   including fields nested inside NexusObject fields and ArrayField items
 *   (the AUDIOTOOL LIVE LEARN FIX: previously only top-level entity fields
 *   were scanned, so e.g. a pulverisateur's oscillator/filter/envelope knobs
 *   were never observable and Learn silently timed out).
 * - `onCreate("*")` additionally re-scans entities that appear in the document
 *   while Learn is armed, so parameters added after Learn started are captured.
 * - Subscriptions use `initialTrigger: false`, because `onUpdate` in
 *   @audiotool/nexus fires the callback immediately with the current value
 *   when `initialTrigger` is the default (true). Without this, Learn would
 *   resolve instantly with the first field's current value instead of waiting
 *   for an actual user parameter change.
 * - The first real update that arrives wins, then all subscriptions are torn down.
 */
export class NexusLearn {
    private document: SyncedDocument;
    private isLearning: boolean = false;
    private cleanupFns: Array<() => void> = [];
    private createTerminable?: () => void;
    private activeReject?: (reason: any) => void;
    private activeTimeout?: ReturnType<typeof setTimeout>;
    private subscribedLocations: Set<string> = new Set();

    constructor(document: SyncedDocument) {
        this.document = document;
    }

    /**
     * Arms the Learn mode. Resolves with the first valid parameter change detected.
     */
    public startLearn(options: NexusLearnOptions = {}): Promise<LearnResult> {
        const filterAutomatable = options.filterToAutomatableParameters ?? true;
        const timeoutMs = options.timeoutMs;

        if (this.isLearning) {
            this.cancelLearn();
        }

        this.isLearning = true;
        this.cleanupFns = [];
        this.subscribedLocations.clear();

        const log = this.log;
        log("state=LEARNING");

        return new Promise((resolve, reject) => {
            this.activeReject = reject;

            if (timeoutMs !== undefined) {
                this.activeTimeout = setTimeout(() => {
                    log("NO NEXUS VALUE EVENTS RECEIVED");
                    log("reason=timed_out — check: backend attached (doc.connected)? subscriptions armed?");
                    this.finishLearning();
                    this.activeReject?.(new LearnTimeoutError());
                }, timeoutMs);
            }

            const clearTimeoutTimer = () => {
                if (this.activeTimeout !== undefined) {
                    clearTimeout(this.activeTimeout);
                    this.activeTimeout = undefined;
                }
            };

            const armEntity = (entity: any): { subscribed: number; skipped: number } => {
                let subscribed = 0;
                let skipped = 0;
                const visit = (obj: any, basePath: string, topKey: string) => {
                    for (const name in obj) {
                        const f = (obj as Record<string, any>)[name];
                        if (!f || typeof f !== "object") continue;

                        const isPrimitive = "location" in f && "value" in f;
                        if (isPrimitive) {
                            const path = basePath ? `${basePath}.${name}` : name;
                            if (this.armPrimitive(f, path, topKey || name, entity, filterAutomatable, resolve)) {
                                subscribed++;
                            } else {
                                skipped++;
                            }
                            continue;
                        }

                        if ("fields" in f) {
                            visit(f.fields, basePath ? `${basePath}.${name}` : name, topKey || name);
                        }
                        if ("array" in f) {
                            (f.array as any[]).forEach((el: any, i: number) => {
                                const arrayPath = `${basePath ? `${basePath}.` : ""}${name}[${i}]`;
                                if (el && typeof el === "object" && "fields" in el) {
                                    visit(el.fields, arrayPath, topKey || name);
                                } else if (el && typeof el === "object" && "value" in el && "location" in el) {
                                    if (this.armPrimitive(el, arrayPath, topKey || name, entity, filterAutomatable, resolve)) {
                                        subscribed++;
                                    } else {
                                        skipped++;
                                    }
                                }
                            });
                        }
                    }
                };
                visit(entity.fields, "", "");
                return { subscribed, skipped };
            };

            try {
                const allEntities = this.document.queryEntities.get();
                let totalSubscribed = 0;
                let totalSkipped = 0;
                for (const entity of allEntities) {
                    const s = armEntity(entity);
                    totalSubscribed += s.subscribed;
                    totalSkipped += s.skipped;
                }

                // Re-scan entities that appear while Learn is armed.
                const onCreateCleanup = this.document.events.onCreate("*", (created: any) => {
                    if (!this.isLearning) return;
                    log("onCreate re-scan", `entity=${(created as any).entityType as string || "unknown"} id=${(created as any).id as string}`);
                    armEntity(created);
                });
                if (typeof onCreateCleanup === "function") {
                    this.createTerminable = onCreateCleanup;
                } else if (onCreateCleanup && typeof onCreateCleanup.terminate === "function") {
                    this.createTerminable = () => onCreateCleanup.terminate();
                }

                log(`armed: subscribed=${totalSubscribed} automatable fields across ${allEntities.length} entities (+${totalSkipped} skipped non-parameter/immutable)`);
            } catch (e) {
                this.finishLearning();
                clearTimeoutTimer();
                reject(e);
            }
        });
    }

    public cancelLearn() {
        if (this.isLearning) {
            this.finishLearning();
            this.activeReject?.(new LearnCancelledError());
            this.activeReject = undefined;
        }
    }

    public isActive(): boolean {
        return this.isLearning;
    }

    /** Subscribes one primitive field for a maximum of one value change.
     *  Returns true when a new subscription was created. Deduplicates by field
     *  location so re-scans (onCreate) never double-subscribe. */
    private armPrimitive(
        f: any,
        path: string,
        topKey: string,
        entity: any,
        filterAutomatable: boolean,
        resolve: (r: LearnResult) => void
    ): boolean {
        if (f.mutable === false) return false;
        if (filterAutomatable && !this.isAutomatableParameter(f)) return false;

        let locationKey: string;
        try {
            locationKey = f.location.toString();
        } catch (e) {
            return false;
        }
        if (this.subscribedLocations.has(locationKey)) return false;
        this.subscribedLocations.add(locationKey);

        const cleanup = this.document.events.onUpdate(f as any, (newValue: any) => {
            this.log("NEXUS EVENT",
                `[METATRON NEXUS EVENT] entityId=${entity.id as string} fieldName=${path} value=${newValue}`);
            if (this.isLearning) {
                this.finishLearning();

                const targetName = `${(entity as any).entityType || "unknown"} / ${path}`;
                this.log("SUCCESS",
                    `[METATRON LEARN SUCCESS] entityId=${entity.id as string} fieldName=${path} value=${newValue} targetName=${targetName}`);
                resolve({
                    entityId: entity.id,
                    entityType: (entity as any).entityType || "unknown",
                    fieldName: topKey || path,
                    fieldPath: path,
                    value: newValue,
                    valueMapping: createNexusValueMapping(f),
                    targetName: targetName,
                    field: f
                });
            } else {
                this.log("ignored event",
                    `[METATRON LEARN] ignored event reason=learn already settled (first-change-wins) entityId=${entity.id as string} fieldName=${path} value=${newValue}`);
            }
        }, false);

        if (typeof cleanup === "function") {
            this.cleanupFns.push(cleanup);
        } else if (cleanup && typeof cleanup.terminate === "function") {
            this.cleanupFns.push(() => cleanup.terminate());
        } else {
            this.cleanupFns.push(() => {});
        }
        return true;
    }

    /** Determines whether the field is a parameter worth learning, using the
     * canonical schema metadata. Falls back to "assume parameter" if the schema
     * lookup fails, so Learn can never be blocked by missing metadata. */
    private isAutomatableParameter(field: any): boolean {
        try {
            const details = getSchemaLocationDetails(field.location);
            if (details && details.type === "primitive") {
                const targetTypes = (details as any).targetTypes as string[] | undefined;
                // TargetType is a numeric proto enum; targetTypes from schema details are strings.
                const automatableKey = TargetType[TargetType.AutomatableParameter];
                if (targetTypes && !targetTypes.includes(automatableKey)) {
                    return false;
                }
            }
            return true;
        } catch (e) {
            return true;
        }
    }

    private log(tag: string, message?: unknown) {
        if (message !== undefined) {
            console.log(`[METATRON LEARN]`, tag, message);
        } else {
            console.log(`[METATRON LEARN]`, tag);
        }
    }

    private finishLearning() {
        this.isLearning = false;
        this.cleanupFns.forEach(fn => fn());
        this.cleanupFns = [];
        this.createTerminable?.();
        this.createTerminable = undefined;
        if (this.activeTimeout !== undefined) {
            clearTimeout(this.activeTimeout);
            this.activeTimeout = undefined;
        }
    }
}