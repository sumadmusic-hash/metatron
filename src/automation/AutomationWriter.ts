/**
 * M21.2 — WRITE-TO-AUDIOTOOL: recordings → real Audiotool automation.
 *
 * Turns a recorded {@link AutomationRecording} into genuine Audiotool
 * entities, using EXACTLY the entity structure proven by the M21.1.1 PoC
 * (`poc/chain-clone/automation-offline-poc.test.ts`):
 *
 *   AutomationTrack (automatedParameter = binding field location)
 *     → AutomationCollection
 *       → AutomationEvent(s)   (collection-local ticks, deduped by tick)
 *     → AutomationRegion       (region.positionTicks = recording.startTick)
 *
 * All entities for ONE write are created inside a SINGLE `document.modify(...)`
 * transaction (atomic — either all succeed or nothing is created).
 *
 * Binding resolution reuses the existing Metatron binding infrastructure:
 * the writer never guesses Audiotool entities/fields itself. Per recorded
 * control it validates (in order): binding present → entity present →
 * field present → field mutable → field schema is `AutomatableParameter`.
 * A track that fails validation is SKIPPED with an explicit failure record
 * (partial success is allowed); the remaining tracks are still written.
 */

import { secondsToTicks } from "@audiotool/nexus/utils";
import { TargetType, getSchemaLocationDetails } from "@audiotool/nexus/document";
import type { SyncedDocument } from "@audiotool/nexus";
import type { BindingManager } from "../core/BindingManager";
import type { AutomationRecording, AutomationSample } from "./AutomationRecording";
import { resolveFieldByPath } from "../nexus/ChainPath";
import { getTaper, linearToAutomation, taperKey as buildTaperKey } from "../nexus/CurveRegistry";
import { getParameterUICurve, uiToNexusNorm } from "../nexus/ParameterUICurve";
import type { TaperDef } from "../nexus/CurveRegistry";

export type AutomationWriteFailureReason =
    | "no-samples"
    | "no-binding"
    | "entity-not-found"
    | "field-not-found"
    | "field-immutable"
    | "not-automatable"
    | "transaction-failed";

export type AutomationTrackWriteResult =
    | {
          controlId: string;
          ok: true;
          trackId: string;
          collectionId: string;
          regionId: string;
          eventCount: number;
      }
    | { controlId: string; ok: false; reason: AutomationWriteFailureReason };

export interface AutomationWriteResult {
    /** false only when the whole `modify(...)` transaction failed (atomic). */
    ok: boolean;
    error?: string;
    perTrack: AutomationTrackWriteResult[];
    createdTracks: number;
}

export interface WriteEvent {
    positionTicks: number;
    value: number;
}

/** Mindestens ein fehlgeschlagener `document.modify(...)` leakt im
 *  @audiotool/nexus SDK dauerhaft den Document-Transaction-Lock
 *  (`modify` = `await createTransaction(); await fn(tx); tx.send()` — OHNE
 *  try/finally; wirft der Callback oder sendet der Gateway-Fehler, wird der
 *  Lock nie freigegeben). Folge: ALLE weiteren `modify`/`createTransaction`
 *  Aufrufe — Parameter-Writes, Re-Learn, sogar `document.stop()` beim
 *  Reconnect — blockieren für immer. Hier wird ein als wedged erkanntes
 *  Dokument markiert, damit die App statt eines stillen Einfrierens schnell
 *  und sichtbar refusiert (Recovery = Seiten-Reload, da das SDK kein
 *  Abort-Ohne-Send-API bietet). */
const wedgedDocuments = new WeakSet<object>();

/** True, wenn dieses Dokument nach einem fehlgeschlagenen Transaction-Write
 *  als unbenutzbar (Socket-Lock geleakt) markiert wurde. */
export function isDocumentWedged(document: object | null | undefined): boolean {
    return !!document && wedgedDocuments.has(document);
}

/** Prüft, ob der Document-Transaction-Lock noch reagiert: ein No-op-`modify`
 *  muss innerhalb des Timeouts aufgelöst sein, sonst ist der Lock geleakt
 *  (jeder weitere Write würde für immer hängen). Nur im Fehlerpfad aufgerufen. */
async function probeDocumentLock(document: object, timeoutMs = 400): Promise<boolean> {
    try {
        const responds = await Promise.race([
            (document as any).modify(() => {}).then(
                () => true,
                () => true // Reject (z.B. "Document stopped") = Lock war frei/sichtbar — kein Hang
            ),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
        ]);
        return responds;
    } catch {
        return true;
    }
}

/** Markiert ein Dokument nach einem gemeldeten Transaction-Fehler, falls sein
 *  Lock tatsächlich nicht mehr freikommt. */
async function markDocumentIfWedged(document: object): Promise<void> {
    if (wedgedDocuments.has(document)) return;
    if (!(await probeDocumentLock(document))) {
        wedgedDocuments.add(document);
        console.error(
            "[METATRON AUTOMATION WRITE] SDK transaction lock leaked after failed write — " +
                "document wedged, further writes refused until reload/reconnect"
        );
    }
}

/** Reads the project BPM from the document's Config entity (documented field
 *  `Config.tempoBpm`); returns undefined when unavailable or malformed. */
export function readTempoBpm(document: SyncedDocument | null | undefined): number | undefined {
    try {
        if (!document) return undefined;
        const configs = (document as any).queryEntities?.ofTypes?.("config").get?.() ?? [];
        for (const c of configs as any[]) {
            const v = c?.fields?.tempoBpm?.value;
            if (typeof v === "number" && Number.isFinite(v)) return v;
        }
    } catch {
        return undefined;
    }
    return undefined;
}

/** Same canonical AutomatableParameter predicate the Learn pipeline uses
 *  (schema targetTypes from `getSchemaLocationDetails`). Falls back to "yes"
 *  when the metadata is unavailable, mirroring NexusLearn. */
function isAutomatableField(field: any): boolean {
    try {
        const details = getSchemaLocationDetails(field.location);
        if (details && details.type === "primitive") {
            const targetTypes = (details as any).targetTypes as string[] | undefined;
            const automatableKey = TargetType[TargetType.AutomatableParameter];
            if (targetTypes && !targetTypes.includes(automatableKey)) {
                return false;
            }
        }
        return true;
    } catch {
        return true;
    }
}

/** Samples (time-ordered) → unique ticks. Samples that resolve to the same
 *  tick as the previous one are collapsed: the LATEST value wins, so no
 *  invalid same-tick double event is ever produced (M21.2 §8).
 *  B68/F5 — korrekte Pipeline für Automation-Event-Werte:
 *    Metatron UI normalized (Sample-Wert)
 *        ↓ (falls UI-Kurve registriert)
 *    ParameterUICurve.uiToNexusNorm() → Nexus normalized / lineare Schema-Position
 *        ↓ (falls Automation-Taper registriert)
 *    CurveRegistry.linearToAutomation() → Audiotool automationEvent.value
 *
 *  Ohne UI-Kurve: Sample-Wert ist bereits Metatron-linear (Nexus-normalisiert
 *  über lineares Schema-Range) → direkt linearToAutomation() falls Taper da.
 *  Ohne Taper: Identity (bisheriges Verhalten).
 *  Switch/Boolean: nie Log-Taper (Registry trägt nur log für echte Continuous).
 *  F9 — `secondsToTicks` liefert Floats; vor der Same-Tick-Deduplizierung wird
 *  der Tick auf den nächsten Integer gerundet. */
export function samplesToEvents(
    samples: AutomationSample[],
    bpm: number,
    taper?: TaperDef,
    curveKey?: string
): WriteEvent[] {
    const ordered = [...samples].sort((a, b) => a.timeSeconds - b.timeSeconds);
    const events: WriteEvent[] = [];
    let lastTick: number | undefined;

    const uiCurve = curveKey ? getParameterUICurve(curveKey) : undefined;

    for (const s of ordered) {
        const tick = Math.round(secondsToTicks(s.timeSeconds, bpm));
        let value = s.normalizedValue;

        if (uiCurve) {
            value = uiToNexusNorm(uiCurve, value);
        }

        if (taper) {
            value = linearToAutomation(taper, value);
        }

        if (lastTick !== undefined && tick === lastTick) {
            events[events.length - 1].value = value;
        } else {
            events.push({ positionTicks: tick, value });
            lastTick = tick;
        }
    }
    return events;
}

/** The documented `orderAmongTracks` rule (M21.1.1 audit): unique across all
 *  track types, max(existing orderAmongTracks) + 1, then +1 per additional
 *  track. Reads every entity that exposes `orderAmongTracks`, so it never
 *  needs to hardcode track-type keys. */
function maxOrderAmongTracks(entities: any): number {
    let max = 0;
    try {
        for (const entity of entities.get()) {
            const v = entity?.fields?.orderAmongTracks?.value;
            if (typeof v === "number" && v > max) max = v;
        }
    } catch {
        // keep 0
    }
    return max;
}

interface WriteAttempt {
    controlId: string;
    controlType?: string;
    samples: AutomationSample[];
    field: any;
    /** B68 — gemessener Automation-Taper dieses Felds (Registry-Lookup beim
     *  Attempt-Aufbau); undefined = Identity (bisheriges Verhalten). */
    taper?: TaperDef;
    /** F5 — Key für die ParameterUICurve (identisch zum Taper-Key), damit der
     *  Writer erst uiToNexusNorm und DANN linearToAutomation anwenden kann. */
    curveKey?: string;
}

/**
 * Writes a recording as real Audiotool automation. One transaction for all
 * tracks; per-track validation failures are reported explicitly, never
 * silently skipped (partial success is allowed, M21.2 §10).
 */
export async function writeAutomationRecording(
    recording: AutomationRecording,
    document: SyncedDocument,
    bindings: BindingManager
): Promise<AutomationWriteResult> {
    const failures: { controlId: string; reason: AutomationWriteFailureReason }[] = [];
    const attempts: WriteAttempt[] = [];

    for (const track of recording.tracks) {
        const fail = (reason: AutomationWriteFailureReason) => failures.push({ controlId: track.controlId, reason });

        if (track.samples.length === 0) {
            fail("no-samples");
            continue;
        }
        const binding = bindings.getActiveBinding(track.controlId);
        if (!binding) {
            fail("no-binding");
            continue;
        }
        const entity = document.queryEntities.getEntity(binding.entityId);
        if (!entity) {
            fail("entity-not-found");
            continue;
        }

        const path = binding.fieldPath ?? binding.fieldName;
        const resolvedFromEntity = path ? resolveFieldByPath(entity.fields, path) : undefined;
        const field =
            resolvedFromEntity !== undefined && resolvedFromEntity !== null
                ? resolvedFromEntity
                : binding.field;
        if (!field || typeof field !== "object" || !("value" in field) || !("location" in field)) {
            fail("field-not-found");
            continue;
        }
        if (field.mutable === false) {
            fail("field-immutable");
            continue;
        }
        if (!isAutomatableField(field)) {
            fail("not-automatable");
            continue;
        }
        // B68 — Registry-Lookup pro Attempt. Key muss EXAKT der Probe-Kennung
        // (curveKey) entsprechen: targetName stammt — wie in der Probe — aus
        // control.audiotoolBindingDefinition (ActiveBinding trägt selbst kein
        // targetName). Ohne Eintrag = Identity.
        const targetName = bindings.deviceRef.controls.get(track.controlId)?.audiotoolBindingDefinition?.targetName;
        const curveKey = buildTaperKey(targetName, path);
        const taper = getTaper(curveKey);
        const hasUICurve = getParameterUICurve(curveKey) !== undefined;

        attempts.push({
            controlId: track.controlId,
            controlType: track.controlType,
            samples: track.samples,
            field,
            taper,
            curveKey: hasUICurve ? curveKey : undefined,
        });
    }

    if (attempts.length === 0) {
        return {
            ok: true,
            perTrack: failures.map((f) => ({ controlId: f.controlId, ok: false, reason: f.reason })),
            createdTracks: 0,
        };
    }

    // M23.0 — Nach einem fehlgeschlagenen Write kann der SDK-Transaction-Lock
    // geleakt sein (siehe wedgedDocuments). Ein weiterer Write würde sonst
    // für immer hängen — hier schnell und sichtbar refusieren.
    if (isDocumentWedged(document)) {
        return {
            ok: false,
            error: "Transaction lock leaked — document is wedged (connect again / reload the page to recover)",
            perTrack: attempts.map((a) => ({ controlId: a.controlId, ok: false, reason: "transaction-failed" })),
            createdTracks: 0,
        };
    }

    const created: { controlId: string; trackId: string; collectionId: string; regionId: string; eventCount: number }[] = [];
    // M22.0 — shared region duration for all tracks in this take.
    // For Bake: exact takeTicks (no extra beat). For Live Recording with
    // an event exactly at durationSeconds: minimal 1-tick headroom.
    // M23.0 — `secondsToTicks` liefert Floats; die Region-Tick-Felder sind im
    // Schema uint32. Ein Bruchteil wie `durationTicks: 191.73` wuerde die
    // Validierung kippen ("invalid uint 32") und via SDK-Lock-Leak alle
    // Folge-Writes blockieren (Live-Takes haben reale, nicht-takt-aligned
    // Dauer-Sekunden). Deshalb: aufgerundet auf den naechsten Integer.
    const rawTicks = secondsToTicks(recording.durationSeconds, recording.projectBpm);
    const takeTicks = Math.max(0, Math.ceil(Number.isFinite(rawTicks) ? rawTicks : 0));

    // Check if any track has a sample exactly at durationSeconds (Live Recording end event)
    const hasEndEvent = recording.tracks.some((track) =>
        track.samples.some((s) => s.timeSeconds === recording.durationSeconds)
    );
    const regionTicks = hasEndEvent
        ? Math.max(1, takeTicks + 1) // minimal 1-tick headroom for end event
        : Math.max(1, takeTicks); // exact duration for Bake

    // Check document connection before starting transaction. `document.connected`
    // ist im SDK ein reaktiver Wert (mit getValue()), kein roher Boolean — die
    // alte `!document.connected`-Prufung griff nie. Wenn der Gateway blockiert
    // ist, haelt das SDK selbst den Lock; ohne diese Prufung wuerde `modify`
    // dann rueckstandslos haengen.
    const connectedValue = (document as any)?.connected?.getValue?.();
    if (connectedValue === false) {
        return {
            ok: false,
            error: "Document not connected",
            perTrack: attempts.map((a) => ({ controlId: a.controlId, ok: false, reason: "transaction-failed" })),
            createdTracks: 0,
        };
    }

    try {
        await document.modify((t: any) => {
            const orderBase = maxOrderAmongTracks(t.entities);
            for (let i = 0; i < attempts.length; i++) {
                const a = attempts[i];
                // B68/F5 — korrekte Pipeline: UI-Kurve (falls vorhanden) → Nexus-normiert → Automation-Taper.
                const events = samplesToEvents(a.samples, recording.projectBpm, a.taper, a.curveKey);
                // Switches are stepped; every other control is sloped (M21.2 §8).
                const interpolation = a.controlType === "switch" ? 1 : 2;

                const track = t.create("automationTrack", {
                    automatedParameter: a.field.location,
                    orderAmongTracks: orderBase + 1 + i,
                });
                const collection = t.create("automationCollection", {});
                for (const ev of events) {
                    t.create("automationEvent", {
                        collection: collection.location,
                        positionTicks: ev.positionTicks,
                        value: ev.value,
                        interpolation,
                        slope: 0,
                    });
                }
                // M22.0 — region duration matches takeTicks for Bake (exact).
                // Only if a Live Recording has an event exactly at durationSeconds
                // we add minimal 1-tick headroom so the end event sits strictly inside.
                const region = t.create("automationRegion", {
                    region: {
                        // M23.0 — startTick defensiv auf uint32 gerundet
                        // (recorder floor-t bereits; Reste aus anderen Pfaden koennen fluessig sein).
                        positionTicks: Math.max(0, Math.floor(recording.startTick)),
                        durationTicks: regionTicks,
                        collectionOffsetTicks: 0,
                        loopOffsetTicks: 0,
                        // regionTicks = takeTicks for Bake (exact duration).
                        // If Live Recording has an event exactly at durationSeconds:
                        // minimal 1-tick headroom so the end event sits strictly inside.
                        loopDurationTicks: regionTicks,
                    },
                    track: track.location,
                    collection: collection.location,
                });
                created.push({
                    controlId: a.controlId,
                    trackId: track.id,
                    collectionId: collection.id,
                    regionId: region.id,
                    eventCount: events.length,
                });
                console.log(
                    `[METATRON AUTOMATION WRITE] control=${a.controlId} track=${track.id} ` +
                        `orderAmongTracks=${orderBase + 1 + i} events=${events.length} ` +
                        `startTick=${recording.startTick} regionTicks=${regionTicks}`
                );
            }
        });
    } catch (e) {
        // M23.0 — Das SDK laesst den Transaction-Lock auf jedem fehlgeschlagenen
        // Write liegen (kein try/finally in `modify`). Nach dem Fehler pruefen,
        // ob der Lock noch reagiert, und das Dokument als wedged markieren,
        // damit nachfolgende Writes schnell scheitern statt fuer immer zu haengen.
        await markDocumentIfWedged(document);
        return {
            ok: false,
            error: e instanceof Error ? e.message : String(e),
            perTrack: attempts.map((a) => ({ controlId: a.controlId, ok: false, reason: "transaction-failed" })),
            createdTracks: 0,
        };
    }

    const byControl = new Map<string, (typeof created)[number]>();
    for (const c of created) byControl.set(c.controlId, c);
    const perTrack: AutomationTrackWriteResult[] = recording.tracks.map((track) => {
        const ok = byControl.get(track.controlId);
        if (ok) {
            return {
                controlId: track.controlId,
                ok: true,
                trackId: ok.trackId,
                collectionId: ok.collectionId,
                regionId: ok.regionId,
                eventCount: ok.eventCount,
            };
        }
        const failure = failures.find((f) => f.controlId === track.controlId);
        return { controlId: track.controlId, ok: false, reason: failure?.reason ?? "transaction-failed" };
    });

    return { ok: true, perTrack, createdTracks: created.length };
}