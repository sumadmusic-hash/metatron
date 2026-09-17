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

export function registerParameterUICurve(key: string, curve: ParameterUICurve): void {
    UI_REGISTRY.set(key, sanitize(curve));
}

export function getParameterUICurve(key: string): ParameterUICurve | undefined {
    return UI_REGISTRY.get(key);
}

export function unregisterParameterUICurve(key: string): void {
    UI_REGISTRY.delete(key);
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

function sanitize(curve: ParameterUICurve): ParameterUICurve {
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
            return undefined as unknown as ParameterUICurve;
        }
    }

    return { ...curve, points: deduped };
}
