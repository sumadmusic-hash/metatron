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

import { secondsToTicks, Ticks } from "@audiotool/nexus/utils";
import { TargetType, getSchemaLocationDetails } from "@audiotool/nexus/document";
import type { SyncedDocument } from "@audiotool/nexus";
import type { BindingManager } from "../core/BindingManager";
import type { AutomationRecording, AutomationSample } from "./AutomationRecording";
import { resolveFieldByPath } from "../nexus/ChainPath";
import { getTaper, linearToAutomation, taperKey as buildTaperKey } from "../nexus/CurveRegistry";
import { getParameterUICurve } from "../nexus/ParameterUICurve";
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
 *  B68 — Event-Werte liegen im AUDIOTOOL-Getaperten-Automation-Raum, nicht im
 *  Metatron-linear-normalisierten Raum: `linearToAutomation` rechnet den
 *  Sample-Wert um (Log-Taper gemäß Registry). Ohne registrierten Taper
 *  (Identity) bleibt alles beim bisherigen Verhalten.
 *  F5 — sobald für den Feld-Key eine gemessene ParameterUICurve registriert
 *  ist, hat der Live-Pfad den Sample-Wert bereits in den Zielraum (Audiotool-
 *  Knob-Position) gemappt: Ein zusätzlicher Taper wäre "Double-Tapering" und
 *  ist dann ein Fehler — der Wert wird unverändert (Identity) durchgereicht.
 *  F9 — `secondsToTicks` liefert Floats; vor der Same-Tick-Deduplizierung wird
 *  der Tick auf den nächsten Integer gerundet, damit µs-Jitter innerhalb des
 *  Samples nicht zwei Events auf (fast) denselben Tick erzeugt. */
export function samplesToEvents(
    samples: AutomationSample[],
    bpm: number,
    taper?: TaperDef,
    hasUICurve: boolean = false
): WriteEvent[] {
    const ordered = [...samples].sort((a, b) => a.timeSeconds - b.timeSeconds);
    const events: WriteEvent[] = [];
    let lastTick: number | undefined;
    // B9 — Warnung EINMAL vor der Schleife statt pro Sample: bei langen Takes
    // (hunderte Samples) wäre dasselbe Double-Tapering sonst als Tornado im
    // Log (der Zustand ändert sich pro Sample nicht).
    if (hasUICurve && taper) {
        console.warn(
            `[METATRON AUTOMATION] double-taper guard active for key — UI curve exists, ` +
                `registered taper ignored (value is already in the target space).`
        );
    }
    for (const s of ordered) {
        // F9 — round BEFORE the dedup comparison (float ticks would never
        // match exactly, so near-identical sample times kept creating both
        // a duplicate event and an invalid same-tick double event).
        const tick = Math.round(secondsToTicks(s.timeSeconds, bpm));
        let value = s.normalizedValue;

        if (!hasUICurve && taper) {
            // Nur anwenden, wenn KEINE UI-Kurve existiert, aber ein Taper
            // registriert ist (der Live-Pfad hat den Wert sonst schon gemappt).
            value = linearToAutomation(taper, s.normalizedValue);
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
function maxOrderAmongTracks(document: any): number {
    let max = 0;
    try {
        for (const entity of document.queryEntities.get()) {
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
    /** F5 — explizites Flag: existiert für diesen Feld-Key eine ParameterUICurve,
     *  ist der Live-Pfad den Sample-Wert bereits in den Zielraum gemappt;
     *  ein zusätzliches Taper-Anwenden wäre Double-Tapering ( Regel 0.3 ). */
    hasUICurve: boolean;
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
        const taper = getTaper(buildTaperKey(targetName, path));
        // F5 — hat dieser Feld-Key eine gemessene ParameterUICurve, ist der
        // aufgenommene Sample-Wert bereits im Audiotool-Zielraum (der
        // Live-Pfad hat beim RECORDING uiToNexusNorm-Mapping angewendet).
        // Dann darf kein weiterer Taper angewendet werden (Double-Tapering).
        const curveKey = buildTaperKey(targetName, path);
        const hasUICurve = getParameterUICurve(curveKey) !== undefined;

        attempts.push({
            controlId: track.controlId,
            controlType: track.controlType,
            samples: track.samples,
            field,
            taper,
            hasUICurve,
        });
    }

    if (attempts.length === 0) {
        return {
            ok: true,
            perTrack: failures.map((f) => ({ controlId: f.controlId, ok: false, reason: f.reason })),
            createdTracks: 0,
        };
    }

    const orderBase = maxOrderAmongTracks(document);
    const created: { controlId: string; trackId: string; collectionId: string; regionId: string; eventCount: number }[] = [];
    // M22.0 — shared region duration for all tracks in this take: derived
    // from the common `recording.durationSeconds` (set once at STOP) so every
    // AutomationRegion gets the same length regardless of where the last
    // event of an individual control lands.
    const takeTicks = Math.max(0, secondsToTicks(recording.durationSeconds, recording.projectBpm));
    const regionTicks = Math.max(1, takeTicks + Ticks.Beat);

    try {
        await document.modify((t: any) => {
            for (let i = 0; i < attempts.length; i++) {
                const a = attempts[i];
                // B68 — Taper wird beim Event-Berechnen angewandt (Identity wenn
                // keiner registriert); Switch-/Boolean-Tracks bleiben unverändert,
                // da für sie nie ein Log-Taper registriert wird.
                const events = samplesToEvents(a.samples, recording.projectBpm, a.taper, a.hasUICurve);
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
                // M22.0 — region duration is the shared take length (computed
                // once above); the per-control last event only determines the
                // events written into the collection, never the region window.
                // regionTicks sticks out one beat beyond the take end so a
                // final event at exactly durationSeconds sits strictly inside.
                const region = t.create("automationRegion", {
                    region: {
                        positionTicks: recording.startTick,
                        durationTicks: regionTicks,
                        collectionOffsetTicks: 0,
                        loopOffsetTicks: 0,
                        // Deliberately coupled to durationTicks — matches the
                        // pre-M22.0 writer behavior (loop over the same span).
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