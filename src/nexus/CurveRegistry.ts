/**
 * B68 — Per-field AUTOMATION TAPER, aus der Live-Messung (Phase-5-Probe).
 *
 * Es existieren ZWEI verschiedene normalisierte Räume (B65/Dokumentation):
 *   - Metatron-linear:  n ∈ 0..1 ↔ Feld-RAW linear über dem Schema-Range
 *     (Live-Pfad via `mapNormalizedToNexus` → t.update(field, Hz)).
 *   - Audiotool-Automation: automationEvent.value ∈ 0..1 wird beim Playback
 *     im GETAPERTEN Normalraum interpretiert — für logarithmische Parameter
 *     (z. B. Cutoff) als  raw ≈ min · (max/min)^v. Schriebe der Writer 0.5
 *     direkt hinein, ergäbe das ≈528 Hz statt 7759 Hz → „hörbar tiefer".
 *
 * Der Writer bildet deshalb Metatron-linear → Automation-Raum via
 * `linearToAutomation` (bzw. zurück via `automationToLinear`), ABER NUR wenn
 * ein gemessener `log`-Taper-Eintrag registriert ist. Fehlender Eintrag =
 * Identity (das bisherige Verhalten) — es wird NIEMALS eine Name-/Heuristik-
 * basierte Kennlinie erfunden (§6).
 *
 * B69 (Doc): Die Abweichung der Metatron-Knob-Position von der Audiotool-
 * Knob-Position ist ein FUNKTIONSBEDÜRFNIS, kein erwarteter Fehler. Ohne
 * gemessene UI-Kurve (ParameterUICurve) zeigt Metatron die Nexus-normierte
 * lineare Skala, die visuell NICHT mit dem getaperten Audiotool-Knob
 * übereinstimmt. Sobald eine UI-Kurve registriert ist, spiegelt Metatron
 * exakt die Audiotool-Knob-Position. Die Automation-Taper (hier) bleiben
 * davon unberührt.
 */

/** Only registered entries are applied. `measured` entries come from the
 *  automation probe (source:"measured", agent-verified pairs (v, raw)). */
export type TaperKind = "log";

export interface TaperDef {
    kind: TaperKind;
    min: number;
    max: number;
    source: "measured";
    measuredAt: string;
}

const REGISTRY = new Map<string, TaperDef>();

export function registerTaper(key: string, def: TaperDef): void {
    REGISTRY.set(key, def);
}

/** Test-/Revokation-Hygiene (Registry ist global): entfernt einen Eintrag. */
export function unregisterTaper(key: string): void {
    REGISTRY.delete(key);
}

export function getTaper(key: string): TaperDef | undefined {
    return REGISTRY.get(key);
}

/** B68/B66 — KANONISCHER Registry-Key, IDENTISCH zur Probe-Kennung (`curveKey`):
 *  Entitäts-Head (targetName minus FieldPath-Suffix) slugifiziert + ":" +
 *  fieldPath → "pulverisateur:filter.cutoffFrequencyHz". Probe (Registrierung)
 *  UND Writer (Lookup) MÜSSEN denselben Key bauen, sonst ist ein gemessener
 *  Taper still nie angewandt. */
export function taperKey(targetName: string | undefined, fieldPath: string): string {
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const rawTarget = (targetName ?? fieldPath).trim();
    const head = rawTarget.endsWith(fieldPath)
        ? rawTarget.slice(0, rawTarget.length - fieldPath.length)
        : rawTarget;
    return `${slug(head || rawTarget)}:${fieldPath}`;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Nur messbare, nicht-degenerierte Log-Taper sind anwendbar (min > 0 und
 *  max > min). Alles andere → Identity (kein NaN, kein 0/0). */
function usable(t: TaperDef | undefined): t is TaperDef {
    return !!t && t.kind === "log" && t.min > 0 && t.max > t.min;
}

/** Metatron-linear (raw-Hz-linear) → Audiotool-Automation-Normalraum.
 *  Invers zur Playback-Gleichung raw = min·(max/min)^v:
 *  v = ln(1 + n·(ratio − 1)) / ln(ratio), ratio = max/min. */
export function linearToAutomation(t: TaperDef | undefined, n: number): number {
    const c = clamp01(n);
    if (!usable(t)) return c;
    const ratio = t.max / t.min;
    return Math.log(1 + c * (ratio - 1)) / Math.log(ratio);
}

/** Inverse Richtung (Automation-Wert → Metatron-linear). */
export function automationToLinear(t: TaperDef | undefined, v: number): number {
    const c = clamp01(v);
    if (!usable(t)) return c;
    const ratio = t.max / t.min;
    return (Math.pow(ratio, c) - 1) / (ratio - 1);
}