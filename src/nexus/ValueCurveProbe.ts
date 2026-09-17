/**
 * METATRON VALUE-CURVE PROBE (Phase 5, Schritt 1) — misst die Geräte-Transferfunktion
 * raw-normalized → displayed/physikalisch für EIN Nexus-Feld. Die pure Mathematik ist
 * separat exportiert, damit Unit-Tests und Manual-Tabellen exakt dieselben Fits nutzen.
 * Schreibt keine Registry-Einträge (Schritt 2 bleibt gate-basiert).
 *
 * IST-Anpassungen an der Schritt-1-Skizze (belegt aus dem SDK):
 *   - `getSchemaLocationDetails` ist ein Modul-Export aus "@audiotool/nexus/document"
 *     (NexusValueMapping.ts:1), kein Global — Import statt `globalThis`.
 *   - `NexusValueMapping` trägt KEIN fieldPath — der Curve-Key kommt als Parameter.
 *   - fitPower braucht den B53-Guard auf den ORIGINAL-Displaywerten (eine bipolar über 0
 *     kreuzende Achse ist keine Power-Law-Domäne), nicht erst auf der normalisierten d-Achse.
 *
 * EXKLUSIV-OPERATION (B60): Während einer Messung darf NIEMAND den geprobten Parameter
 * anfassen (UI, MIDI, LFO, Autopilot-Flows): ein nebenläufiger Write geht durch den
 * Pflicht-Restore in genau EINEM Store verloren (Nexus überschreibt initialRaw, Echo setzt
 * lokal einen anderen Stand — oder umgekehrt). Probes laufen nur auf IDLE-Projekten.
 */
import type { SyncedDocument } from "@audiotool/nexus";
import { getSchemaLocationDetails } from "@audiotool/nexus/document";
import { createNexusValueMapping, mapNormalizedToNexus } from "./NexusValueMapping";

export interface CurveSample {
    n: number;
    raw: number;
    displayed: number | null;
}

export interface CurveFit {
    kind: "exp" | "power" | "piecewise";
    exponent?: number;
    residualNeper: number;
}

export interface ProbeReport {
    curveKey: string;
    schemaMin: number;
    schemaMax: number;
    schemaDump: string;
    samples: CurveSample[];
    rawLinear: boolean;
    identityTransfer: boolean;
    fits: CurveFit[];
    winner: CurveFit | null;
    /** Set, wenn der Pflicht-Restore fehlgeschlagen ist — der Parameter steht
     *  dann möglicherweise noch auf dem letzten Probewert (B59). */
    restoreError?: string;
    note?: string;
}

export interface ProbeHooks {
    /** Vor jedem Probe-Write aufgerufen (normalisierter Probewert). Bei
     *  gebundenem Feld hier `nexusAdapter.beginSuppressEcho(controlId, n)`
     *  verdrahten, damit Probe-Echos die lokale Control-Basis nicht fressen. */
    onBeforeWrite?: (normalized: number) => void;
}

const SETTLE_MS = 120;
const ACCEPT_NEPER = 0.01; // ≈1 % auf der Display-Skala
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** exp: y = y0 * (y1/y0)^r; Residuum in Neper auf y. */
function fitExp(r: number[], y: number[], y0: number, y1: number): CurveFit | null {
    if (!y.every((v) => v > 0) || y0 <= 0 || y1 <= 0) return null; // B53-Guard: bipolar → kein exp
    const ratio = y1 / y0;
    if (!Number.isFinite(ratio) || ratio === 1) return null;
    let res = 0;
    for (let i = 0; i < r.length; i++) {
        const pred = y0 * Math.pow(ratio, r[i]);
        res = Math.max(res, Math.abs(Math.log(pred / y[i])));
    }
    return { kind: "exp", residualNeper: res };
}

/** power: d = r^k (Least Squares in log-log); nur monotone gleichsignige Achsen (B53-Guard):
 *  die ORIGINAL-Displaywerte dürfen die 0 nur EINSEITIG berühren (nur ≥0 oder nur ≤0) —
 *  ein echter Vorzeichenwechsel (bipolar, beide Vorzeichen vorhanden) ist keine Power-Domäne. */
function fitPower(r: number[], d: number[], y: number[]): CurveFit | null {
    const hasPositive = y.some((v) => v > 0);
    const hasNegative = y.some((v) => v < 0);
    if (hasPositive && hasNegative) return null; // B53: bipolar → verworfen
    const pts = r.map((rv, i) => ({ rv, di: d[i] })).filter((p) => p.rv > 0 && p.di > 0);
    if (pts.length < 3) return null;
    let num = 0;
    let den = 0;
    for (const p of pts) {
        num += Math.log(p.rv) * Math.log(p.di);
        den += Math.log(p.rv) ** 2;
    }
    if (den === 0) return null;
    const k = num / den;
    if (!(k > 0)) return null;
    let res = 0;
    for (const p of pts) res = Math.max(res, Math.abs(Math.log(Math.pow(p.rv, k) / p.di)));
    return { kind: "power", exponent: k, residualNeper: res };
}

/** Pure Fits über bereits vorhandene Samples (Tests + Manual-Tabellen nutzen denselben Pfad). */
export function fitTransfer(
    samples: CurveSample[],
    schemaMin: number,
    schemaMax: number,
): { fits: CurveFit[]; winner: CurveFit | null } {
    const span = schemaMax - schemaMin || 1;
    const r = samples.map((s) => (s.raw - schemaMin) / span);
    const ys = samples.map((s) => s.displayed);
    if (ys.some((v) => v === null)) return { fits: [], winner: null };
    const y = ys as number[];
    const y0 = y[0];
    const y1 = y[y.length - 1];
    const d = y.map((v) => (v - y0) / (y1 - y0 || 1));
    const fits: CurveFit[] = [];
    const exp = fitExp(r, y, y0, y1);
    if (exp) fits.push(exp);
    const pow = fitPower(r, d, y);
    if (pow) fits.push(pow);
    fits.push({ kind: "piecewise", residualNeper: 0 });
    fits.sort((a, b) => a.residualNeper - b.residualNeper);
    const winner = fits.find((f) => f.kind !== "piecewise" && f.residualNeper <= ACCEPT_NEPER) ?? null;
    return { fits, winner };
}

/** DOM-Scrape-Helper: liest den UI-Readout eines Parameters als Zahl (Komma oder Punkt).
 *  Readouts MIT Einheit MÜSSEN einen Transform übergeben — der Default-Parse liest
 *  nur die erste nackte Zahl, "1.2 kHz" würde sonst als 1.2 (statt 1200) gelesen (B57). */
export function makeDisplayReader(
    root: ParentNode,
    selector: string,
    transform?: (text: string) => number | null,
): () => number | null {
    const parse = transform ?? defaultParse;
    return () => {
        const el = root.querySelector(selector);
        const text = el?.textContent ?? "";
        return parse(text);
    };
}

/** Default: erste nackte Zahl. Keine Einheiten-Auflösung. */
function defaultParse(text: string): number | null {
    const m = /-?\d+(?:[.,]\d+)?/.exec(text);
    if (!m) return null;
    const v = Number(m[0].replace(",", "."));
    return Number.isFinite(v) ? v : null;
}

/** Fertiger Transform für Frequenz-Readouts ("840 Hz", "1,2 kHz"). */
export function parseFrequencyText(text: string): number | null {
    const m = /^(-?\d+(?:[.,]\d+)?)\s*(hz|khz)?$/i.exec(text.trim());
    if (!m) return null;
    const v = Number(m[1].replace(",", "."));
    if (!Number.isFinite(v)) return null;
    const unit = (m[2] ?? "hz").toLowerCase();
    return unit === "khz" ? v * 1000 : v;
}

/** Misst ein Feld über steps+1 Stützstellen: schreibt linear gemappte raw-Werte,
 *  liest raw zurück und optional den Display-Wert.
 *  Side-Effect-Guard (B56): der Ausgangswert wird gemerkt und IMMER wiederhergestellt
 *  (auch bei Abbruch mitten in der Schleife) — eine Messung darf kein Nutzerprojekt
 *  mit Cutoff/Volume am Anschlag hinterlassen. */
export async function probeField(
    document: SyncedDocument,
    field: any,
    curveKey: string,
    readDisplayed: (() => number | null) | null,
    steps = 10,
    hooks: ProbeHooks = {},
): Promise<ProbeReport> {
    const mapping = createNexusValueMapping(field);
    if (mapping.kind !== "linear") throw new Error(`${curveKey}: not numeric-mappable`);
    const schemaMin = mapping.min as number;
    const schemaMax = mapping.max as number;
    let schemaDump = "null";
    try {
        schemaDump = JSON.stringify(getSchemaLocationDetails(field?.location) ?? null);
    } catch {
        schemaDump = "null";
    }
    const initialRaw = field.value;
    const samples: CurveSample[] = [];
    let restoreError: string | undefined;
    try {
        for (let i = 0; i <= steps; i++) {
            const n = i / steps;
            const target = mapNormalizedToNexus(mapping, n);
            if (target === undefined) throw new Error(`${curveKey}: mapping refused write`);
            hooks.onBeforeWrite?.(n);
            await document.modify((t: any) => t.update(field, target));
            await wait(SETTLE_MS);
            samples.push({ n, raw: field.value, displayed: readDisplayed ? readDisplayed() : null });
        }
    } finally {
        // Restore auch bei Abbruch mitten in der Schleife (Throw, Timeout).
        // B59: ein fehlschlagender Restore darf die Original-Exception NICHT
        // maskieren — abfangen, im Report markieren, weiterwerfen lassen.
        try {
            await document.modify((t: any) => t.update(field, initialRaw));
            await wait(SETTLE_MS);
        } catch (e) {
            restoreError = e instanceof Error ? e.message : String(e);
            console.error(
                `[METATRON CURVE-PROBE] restore failed for ${curveKey} — parameter may stay at last probe value; re-run probe or set it manually.`,
                e,
            );
        }
    }
    const span = schemaMax - schemaMin || 1;
    const rawLinear = samples.every((s) => Math.abs(s.raw - (schemaMin + s.n * span)) <= 1e-6);
    const ys = samples.map((s) => s.displayed);
    const hasDisplay = ys.every((v) => typeof v === "number" && Number.isFinite(v as number));
    const identityTransfer =
        hasDisplay && samples.every((s, i) => Math.abs((ys[i] as number) - s.raw) < 1e-6);
    const { fits, winner } =
        hasDisplay && !identityTransfer ? fitTransfer(samples, schemaMin, schemaMax) : { fits: [] as CurveFit[], winner: null };
    return {
        curveKey,
        schemaMin,
        schemaMax,
        schemaDump,
        samples,
        rawLinear,
        identityTransfer,
        fits,
        winner,
        restoreError,
        note: identityTransfer
            ? "identity transfer: raw IST Physik — jede Kurve wäre ein perzeptueller UX-Taper (Schicht C), keine gemessene Geräte-Transferfunktion"
            : undefined,
    };
}