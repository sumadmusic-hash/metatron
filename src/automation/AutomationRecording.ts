/**
 * M21.2 — METATRON INTERNAL AUTOMATION RECORDING
 *
 * Pure, Nexus-free recording model + a small state machine:
 *
 *      IDLE ──arm()──▶ ARMED ──record()──▶ RECORDING ──stop()──▶ STOPPED
 *             ▲                                                       │
 *             └──────────────── arm() ◀───────────────────────────────┘
 *
 * A recording is just a normalized 0..1 control trace captured against a
 * MONOTONIC local clock (`performance.now()` by default, injectable for
 * tests). It has no dependency on the Audiotool playhead, on any Nexus
 * document, or on any UI state.
 *
 * Event density (M21.2 §5, no curve fitting / DSP):
 *   - first value is always stored
 *   - a value is only stored when it changed vs. the last stored value
 *   - a minimum wall-clock distance (MIN_SAMPLE_INTERVAL_MS) prevents
 *     extreme event density; skipped "in-flight" changes are caught by the
 *     forced final sample at STOP
 *   - the final value is always stored at STOP (when it carries information)
 */

export type RecordingState = "IDLE" | "ARMED" | "RECORDING" | "STOPPED";

export interface AutomationSample {
    /** Seconds since the START of this recording (monotonic local clock). */
    timeSeconds: number;
    /** Metatron-normalized value, always clamped into [0, 1]. */
    normalizedValue: number;
}

export interface AutomationRecordingTrack {
    controlId: string;
    /** "knob" | "switch" captured at record time; drives interpolation
     *  in the Nexus writer (switch → stepped = 1, continuous → sloped = 2). */
    controlType?: string;
    samples: AutomationSample[];
}

export interface AutomationRecording {
    /** Project BPM, captured ONCE when RECORDING starts (M21.2 §7). */
    projectBpm: number;
    /** Global timeline position (ticks) the written AutomationRegion starts
     *  at. Written verbatim to `AutomationRegion.region.positionTicks`. */
    startTick: number;
    /** Recorded duration in seconds; final at STOP. */
    durationSeconds: number;
    tracks: AutomationRecordingTrack[];
}

/** Matches the @audiotool/nexus `Config.tempoBpm` documented default (125). */
export const DEFAULT_TEMPO_BPM = 125;

/** Density cap: at least this many ms between stored samples (≈25 Hz max).
 *  Deliberately simple and deterministic — no reduction/curve fitting. */
export const MIN_SAMPLE_INTERVAL_MS = 40;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

interface TrackBuffer {
    controlId: string;
    controlType?: string;
    samples: AutomationSample[];
    lastStoredValue?: number;
    lastStoredMs?: number;
    lastSeenValue?: number;
}

export class AutomationRecorder {
    private state: RecordingState = "IDLE";
    private startPerfMs = 0;
    private startTickValue = 0;
    private bpmValue = DEFAULT_TEMPO_BPM;
    private durationValue = 0;
    private buffers: TrackBuffer[] = [];
    private trackIndex = new Map<string, TrackBuffer>();
    private readonly getProjectBpm: () => number | undefined;
    private readonly clock: () => number;

    constructor(getProjectBpm?: () => number | undefined, clock?: () => number) {
        this.getProjectBpm = getProjectBpm ?? (() => undefined);
        this.clock = clock ?? (() => performance.now());
    }

    get currentState(): RecordingState {
        return this.state;
    }

    get startTick(): number {
        return this.startTickValue;
    }

    get projectBpm(): number {
        return this.bpmValue;
    }

    /** Snapshot of the current recording (idempotent; samples are copied). */
    get recording(): AutomationRecording {
        return {
            projectBpm: this.bpmValue,
            startTick: this.startTickValue,
            durationSeconds: this.durationValue,
            tracks: this.buffers
                .filter((b) => b.samples.length > 0)
                .map((b) => ({
                    controlId: b.controlId,
                    controlType: b.controlType,
                    samples: b.samples.map((s) => ({ ...s })),
                })),
        };
    }

    /** arming begins a fresh candidate recording (IDLE or STOPPED → ARMED). */
    arm(): RecordingState {
        if (this.state === "RECORDING") return this.state;
        this.beginPending();
        this.state = "ARMED";
        return this.state;
    }

    /** RECORD — only an explicit activation starts the clock (M21.2 §3).
     *  Reads the project BPM once and snapshots the given startTick. */
    record(startTick = 0): RecordingState {
        if (this.state === "RECORDING") return this.state;
        if (this.state !== "ARMED") this.beginPending();
        const bpm = this.getProjectBpm();
        this.bpmValue = bpm !== undefined && bpm >= 30 && bpm <= 1000 ? bpm : DEFAULT_TEMPO_BPM;
        this.startTickValue = Math.max(0, Math.floor(startTick));
        this.startPerfMs = this.clock();
        this.durationValue = 0;
        this.state = "RECORDING";
        return this.state;
    }

    /** STOP — finalizes the last values and returns the finished recording. */
    stop(): AutomationRecording {
        if (this.state === "RECORDING") {
            const finalMs = this.clock();
            this.durationValue = Math.max(0, (finalMs - this.startPerfMs) / 1000);
            for (const b of this.buffers) {
                this.storeFinalSample(b, finalMs);
            }
        }
        this.state = "STOPPED";
        return this.recording;
    }

    /** Back to IDLE; the pending recording is discarded. */
    reset(): RecordingState {
        this.beginPending();
        this.state = "IDLE";
        return this.state;
    }

    /**
     * Observed control move. This is the recorder acting as an ADDITIONAL
     * observer of the normal Metatron control-value change path: it never
     * writes to Nexus itself and never alters the control value.
     */
    capture(controlId: string, normalizedValue: number, controlType?: string): void {
        if (this.state !== "RECORDING") return;
        const value = clamp01(normalizedValue);

        let b = this.trackIndex.get(controlId);
        if (!b) {
            b = { controlId, controlType, samples: [] };
            this.buffers.push(b);
            this.trackIndex.set(controlId, b);
        } else if (controlType) {
            b.controlType = controlType;
        }

        const nowMs = this.clock();
        const elapsedSec = (this.startPerfMs > 0 ? (nowMs - this.startPerfMs) / 1000 : 0);
        b.lastSeenValue = value;

        // First value is always stored (M21.2 §5).
        if (b.lastStoredValue === undefined) {
            b.samples.push({ timeSeconds: elapsedSec, normalizedValue: value });
            b.lastStoredValue = value;
            b.lastStoredMs = nowMs;
            return;
        }

        // Unchanged value → no event.
        if (value === b.lastStoredValue) return;
        // Minimum distance → prevents extreme event density.
        if (nowMs - (b.lastStoredMs ?? 0) < MIN_SAMPLE_INTERVAL_MS) return;

        b.samples.push({ timeSeconds: elapsedSec, normalizedValue: value });
        b.lastStoredValue = value;
        b.lastStoredMs = nowMs;
    }

    private storeFinalSample(b: TrackBuffer, finalMs: number): void {
        if (b.samples.length === 0 || b.lastSeenValue === undefined) return;
        // Only values that changed but were suppressed by the min-distance rule
        // are pending; an unchanged value is already represented by the last
        // stored sample, so no duplicate tail point is added.
        if (b.lastSeenValue === b.lastStoredValue) return;
        b.samples.push({ timeSeconds: (finalMs - this.startPerfMs) / 1000, normalizedValue: b.lastSeenValue });
        b.lastStoredValue = b.lastSeenValue;
        b.lastStoredMs = finalMs;
    }

    private beginPending(): void {
        this.buffers = [];
        this.trackIndex.clear();
        this.startTickValue = 0;
        this.bpmValue = DEFAULT_TEMPO_BPM;
        this.durationValue = 0;
        this.startPerfMs = 0;
    }
}