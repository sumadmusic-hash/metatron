/**
 * ParameterUICurve — per-field Audiotool-Knob-Position ↔ Metatron-UI-Position.
 *
 * Metatron ist ein Controller für Audiotool-Parameter. Wenn der Nutzer in
 * Audiotool einen Knob bei 50 % sieht, soll der Metatron-Knob ebenfalls
 * ungefähr 50 % anzeigen — unabhängig davon, ob der darunterliegende
 * Nexus-Rohwert linear, logarithmisch, dB-basiert oder anderweitig skaliert
 * ist.
 *
 * Die KONKRETE Übertragungsfunktion wird aus Messdaten abgeleitet
 * (source: "measured") — NICHT aus Parameternamen oder einer globalen
 * Annahme. Fehlt ein gemessener Eintrag → Identity (bisheriges lineares
 * Verhalten, kein Regression).
 *
 * Dieses Modul ist VÖLLIG GETRENNT von:
 *   - NexusValueMapping (raw ↔ nexus-normalized, lineare Schema-Skala)
 *   - CurveRegistry (Automation-Taper für Audiotool-Playback, B68)
 *
 * Es repräsentiert das dritte, unabhängige Mapping:
 *
 *   Metatron UI 0..1 (knob position)
 *       ↕  (this module — piecewise-linear from measured data)
 *   Nexus normalized 0..1 (field position over linear schema range)
 *       ↕  NexusValueMapping (linear mapNormalizedToNexus / mapNexusToNormalized)
 *   Nexus raw (Hz, dB, etc.)
 *
 * Write:  uiNorm → uiToNexusNorm → nexusNorm → mapNormalizedToNexus → raw
 * Read:   raw → mapNexusToNormalized → nexusNorm → nexusNormToUi → uiNorm
 *
 * Keine Heuristik, kein Fall-back auf Logarithmus, keine Name-basierte
 * Aktivierung. Nur explizit registrierte Messdaten.
 */

export { taperKey } from "./CurveRegistry";

export interface UICurvePoint {
    /** Metatron UI normalized 0..1 — Audiotool-Knob-Position. */
    ui: number;
    /** Nexus normalized 0..1 — Feldposition über dem linearen Schema-Range. */
    nexus: number;
}

export interface ParameterUICurve {
    source: "measured";
    measuredAt: string;
    /** Control points sorted by `ui` ascending; endpoints 0/1 enforced
     *  (sanitize()). At least 2 points required for interpolation. */
    points: UICurvePoint[];
}

// ── Registry (global, in-memory) ────────────────────────────────────────

const UI_REGISTRY = new Map<string, ParameterUICurve>();

/** Registriert eine parametrische UI-Kurve (sanitized). Eine nicht
 *  invertierbare (nicht-monotone) Kurve wird ABGELEHNT und NICHT
 *  registriert — weder unter einem neuen noch unter einem bestehenden Key
 *  (ein undefined-Overwrite würde eine gesunde Messkurve still löschen).
 *  Abwesenheit im Registry = Identity-Fallback. */
export function registerParameterUICurve(key: string, curve: ParameterUICurve): void {
    const clean = sanitize(curve);
    if (!clean) {
        console.warn(`[METATRON UI CURVE] non-monotonic curve rejected for "${key}" — identity fallback, existing curve (falls vorhanden) bleibt`);
        return;
    }
    UI_REGISTRY.set(key, clean);
}

export function getParameterUICurve(key: string): ParameterUICurve | undefined {
    return UI_REGISTRY.get(key);
}

export function unregisterParameterUICurve(key: string): void {
    UI_REGISTRY.delete(key);
}

// ── Documented BUILT-IN curves (measured, no heuristics) ────────────────
//
// Wird beim App-Start via installBuiltinUICurves() (src/main.ts) installiert,
// damit nach Page-Reload KEIN Konsolen-Einzeiler mehr nötig ist.
//
// Hinzufügungsregel (§ keinerlei Heuristik):
//   - NUR echte Messdaten (source:"measured") aus der pacedSweep-Probe.
//   - Jede Kurve ist hier dokumentiert UND in
//     tests/nexus/ParameterUICurve.test.ts als Fixture gepinnt.
//   - NIEMALS aus Parameternamen / globalen Taper-Annahmen abgeleitet.

/** Pulverisateur Cutoff 18..15500 Hz — gemessen per pacedSweep (B73),
 *  17 Punkte aus drei Sitzungen (2026-09-17):
 *   unten dicht (custom targets) + Mitte re-gemessen + oberer Sweep.
 *   {ui: Audiotool-Knob, nexus: Metatron/nexus-normalized}. */
export const PULVERISATEUR_CUTOFF_UI_CURVE: ParameterUICurve = {
    source: "measured",
    measuredAt: "2026-09-17T00:00:00.000Z",
    points: [
        { ui: 0,     nexus: 0 },
        { ui: 0.37,  nexus: 0.01 },
        { ui: 0.45,  nexus: 0.025 },
        { ui: 0.51,  nexus: 0.04 },
        { ui: 0.59,  nexus: 0.06 },
        { ui: 0.61,  nexus: 0.08 },
        { ui: 0.625, nexus: 0.12 },
        { ui: 0.68,  nexus: 0.16 },
        { ui: 0.73,  nexus: 0.2 },
        { ui: 0.75,  nexus: 0.25 },
        { ui: 0.76,  nexus: 0.3 },
        { ui: 0.85,  nexus: 0.4 },
        { ui: 0.87,  nexus: 0.5 },
        { ui: 0.88,  nexus: 0.6 },
        { ui: 0.9,   nexus: 0.7 },
        { ui: 0.999, nexus: 0.9 },
        { ui: 1,     nexus: 1 },
    ],
};

/** Kanonische Liste der beim Start zu installierenden Kurven. */
export const BUILTIN_UI_CURVES: ReadonlyArray<{ key: string; curve: ParameterUICurve }> = [
    { key: "pulverisateur:filter.cutoffFrequencyHz", curve: PULVERISATEUR_CUTOFF_UI_CURVE },
];

/** Installiert alle dokumentierten Built-in-Kurven (idempotent).
 *  Aufgerufen aus src/main.ts beim Bootstrap. */
export function installBuiltinUICurves(): void {
    for (const { key, curve } of BUILTIN_UI_CURVES) {
        registerParameterUICurve(key, curve);
    }
}

// ── Conversion (piecewise-linear) ───────────────────────────────────────

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Metatron UI normalized → Nexus normalized. Without a measured curve:
 *  identity (Metatron 50 % → Nexus normalized 50 %, i.e. current behavior). */
export function uiToNexusNorm(curve: ParameterUICurve | undefined, ui: number): number {
    const c = clamp01(ui);
    const pts = curve?.points;
    if (!pts || pts.length < 2) return c;
    // Binary search: find segment [pts[i], pts[i+1]] enclosing c.
    if (c <= pts[0].ui) return pts[0].nexus;
    if (c >= pts[pts.length - 1].ui) return pts[pts.length - 1].nexus;
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (pts[mid].ui <= c) lo = mid; else hi = mid;
    }
    const a = pts[lo], b = pts[hi];
    if (b.ui <= a.ui) return a.nexus;
    const t = (c - a.ui) / (b.ui - a.ui);
    return a.nexus + t * (b.nexus - a.nexus);
}

/** Nexus normalized → Metatron UI normalized. Inverse of uiToNexusNorm. */
export function nexusNormToUi(curve: ParameterUICurve | undefined, nexus: number): number {
    const c = clamp01(nexus);
    const pts = curve?.points;
    if (!pts || pts.length < 2) return c;
    if (c <= pts[0].nexus) return pts[0].ui;
    if (c >= pts[pts.length - 1].nexus) return pts[pts.length - 1].ui;
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (pts[mid].nexus <= c) lo = mid; else hi = mid;
    }
    const a = pts[lo], b = pts[hi];
    if (b.nexus <= a.nexus) return a.ui;
    const t = (c - a.nexus) / (b.nexus - a.nexus);
    return a.ui + t * (b.ui - a.ui);
}

// ── Sanitize (sort, dedup, enforce endpoints, reject non-monotonic) ────

/** Sanitized curve, or undefined when the points are not invertible
 *  (non-monotonic nexus) — the caller must then NOT register anything.
 *  Identity (kein Eintrag) ist der dokumentierte Fallback. */
function sanitize(curve: ParameterUICurve): ParameterUICurve | undefined {
    const sorted = [...curve.points]
        .map((p) => ({ ui: clamp01(p.ui), nexus: clamp01(p.nexus) }))
        .sort((a, b) => a.ui - b.ui || a.nexus - b.nexus);

    // Dedup same-ui points (keep last).
    const deduped: UICurvePoint[] = [];
    for (const p of sorted) {
        const last = deduped[deduped.length - 1];
        if (last && last.ui === p.ui) {
            deduped[deduped.length - 1] = p;
        } else {
            deduped.push(p);
        }
    }

    // Enforce endpoints (0 → 0, 1 → 1) — ensures roundtrip at boundaries.
    if (deduped.length === 0 || deduped[0].ui > 0) deduped.unshift({ ui: 0, nexus: 0 });
    if (deduped[deduped.length - 1].ui < 1) deduped.push({ ui: 1, nexus: 1 });

    // Reject non-monotonic nexus values (a UI curve must be monotone to be invertible).
    for (let i = 1; i < deduped.length; i++) {
        if (deduped[i].nexus < deduped[i - 1].nexus) {
            console.warn(
                `[METATRON UI CURVE] rejected non-monotonic nexus at ui=${deduped[i].ui} ` +
                    `(${deduped[i - 1].nexus} → ${deduped[i].nexus}), falling back to identity`
            );
            return undefined;
        }
    }

    return { ...curve, points: deduped };
}
