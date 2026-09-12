import { describe, it, expect, beforeEach } from "vitest";
import {
    AutomationRecorder,
    MIN_SAMPLE_INTERVAL_MS,
    DEFAULT_TEMPO_BPM,
} from "../../src/automation/AutomationRecording";

/** Deterministic monotonic clock for the recorder. */
function fakeClock() {
    let now = 0;
    return {
        advance: (ms: number) => {
            now += ms;
        },
        clock: () => now,
    };
}

let clock: ReturnType<typeof fakeClock>;
let recorder: AutomationRecorder;

/** REC + capture helper on a fresh recorder null provider. */
function startRecord(overrides?: { bpmProvider?: () => number | undefined; startTick?: number }) {
    recorder = new AutomationRecorder(overrides?.bpmProvider ?? (() => 125), clock.clock);
    recorder.arm();
    recorder.record(overrides?.startTick);
    return recorder;
}

beforeEach(() => {
    clock = fakeClock();
});

describe("M21.2 — AutomationRecorder state machine", () => {
    it("IDLE → ARM → RECORD → STOP flows and guards invalid transitions", () => {
        const r = new AutomationRecorder(undefined, clock.clock);
        expect(r.currentState).toBe("IDLE");

        expect(r.arm()).toBe("ARMED");
        expect(r.currentState).toBe("ARMED");

        expect(r.record()).toBe("RECORDING");
        expect(r.currentState).toBe("RECORDING");

        // While recording, re-arm must not abort the take.
        expect(r.arm()).toBe("RECORDING");
        expect(r.record(0)).toBe("RECORDING");

        expect(r.stop().durationSeconds).toBe(0);
        expect(r.currentState).toBe("STOPPED");
    });

    it("record() from IDLE implicitly arms", () => {
        const r = new AutomationRecorder(undefined, clock.clock);
        expect(r.record()).toBe("RECORDING");
    });

    it("arm() after STOPPED starts a fresh take", () => {
        const r = new AutomationRecorder(undefined, clock.clock);
        r.arm();
        r.record();
        clock.advance(1000);
        r.capture("c1", 0.5);
        r.capture("c1", 1.0);
        clock.advance(100);
        r.stop();
        expect(r.recording.tracks).toHaveLength(1);

        r.arm();
        expect(r.record()).toBe("RECORDING");
        expect(r.recording.tracks).toHaveLength(0);
    });

    it("reset() discards the pending take back to IDLE", () => {
        const r = new AutomationRecorder(undefined, clock.clock);
        r.arm();
        r.record();
        clock.advance(500);
        r.capture("c1", 0.5);
        r.reset();
        expect(r.currentState).toBe("IDLE");
        expect(r.recording.tracks).toHaveLength(0);
    });
});

describe("M21.2 — control capture (density rule)", () => {
    it("recording only captures while RECORDING (nothing outside)", () => {
        const r = new AutomationRecorder(undefined, clock.clock);
        r.capture("c1", 0.5); // IDLE
        expect(r.recording.tracks).toHaveLength(0);

        r.arm();
        r.capture("c1", 0.6); // ARMED
        r.record();
        clock.advance(50);
        r.capture("c2", 0.7); // RECORDING
        r.stop();
        r.capture("c3", 0.9); // STOPPED
        r.capture("c1", 0.9); // STOPPED

        const rec = r.recording;
        expect(rec.tracks.map((t) => t.controlId)).toEqual(["c2"]);
        expect(rec.tracks[0].samples).toHaveLength(1);
    });

    it("first value always stored; unchanged values are skipped", () => {
        const r = startRecord();
        clock.advance(10);
        r.capture("c1", 0.25);
        clock.advance(100);
        r.capture("c1", 0.25); // unchanged
        clock.advance(100);
        r.capture("c1", 0.25); // unchanged
        r.stop();

        const track = r.recording.tracks[0];
        expect(track.samples.map((s) => s.normalizedValue)).toEqual([0.25]);
    });

    it("changed values need the minimum time distance; final catch-up at STOP", () => {
        const r = startRecord();
        clock.advance(1);
        r.capture("c1", 0.2); // first — stored
        clock.advance(5);
        r.capture("c1", 0.5); // change but < MIN_SAMPLE_INTERVAL_MS → skipped
        clock.advance(10);
        r.capture("c1", 0.7); // still < MIN → skipped
        clock.advance(MIN_SAMPLE_INTERVAL_MS + 1);
        r.capture("c1", 0.8); // now ≥ MIN → stored
        clock.advance(1);
        r.capture("c1", 0.9); // < MIN → skipped, but lastSeen=0.9
        r.stop();             // forced final sample with 0.9

        const s = r.recording.tracks[0].samples;
        expect(s.map((x) => x.normalizedValue)).toEqual([0.2, 0.8, 0.9]);
        // final sample carries the very last observed value and a later time
        expect(s[2].timeSeconds).toBeGreaterThan(s[1].timeSeconds);
    });

    it("final value is stored at STOP (last value always present)", () => {
        const r = startRecord();
        clock.advance(10);
        r.capture("c1", 0.3);
        clock.advance(2000);
        r.capture("c1", 0.85);
        clock.advance(5);
        r.capture("c1", 0.86); // skipped (too close)
        clock.advance(5);
        r.capture("c1", 0.87); // skipped
        r.stop();

        const s = r.recording.tracks[0].samples;
        expect(s[s.length - 1].normalizedValue).toBe(0.87);
        expect(s[s.length - 1].timeSeconds).toBeGreaterThanOrEqual(1);
    });

    it("values are clamped into 0..1", () => {
        const r = startRecord();
        clock.advance(1);
        r.capture("c1", 1.5);
        clock.advance(MIN_SAMPLE_INTERVAL_MS + 1);
        r.capture("c1", -0.4);
        r.stop();
        const s = r.recording.tracks[0].samples;
        expect(s[0].normalizedValue).toBe(1);
        expect(s[1].normalizedValue).toBe(0);
    });

    it("sample times are monotonic (local clock, seconds since start)", () => {
        const r = startRecord();
        const steps: [number, number][] = [
            [10, 0.2],
            [60, 0.4],
            [2000, 0.6],
            [50, 0.8],
            [900, 1.0],
        ];
        let prev = -1;
        for (const [ms, value] of steps) {
            clock.advance(ms);
            r.capture("c1", value);
        }
        r.stop();
        for (const s of r.recording.tracks[0].samples) {
            expect(s.timeSeconds).toBeGreaterThanOrEqual(0);
            expect(s.timeSeconds).toBeGreaterThanOrEqual(prev);
            prev = s.timeSeconds;
        }
        expect(r.recording.durationSeconds).toBeGreaterThanOrEqual(prev);
    });
});

describe("M21.2 — multi-control tracks, BPM, startTick", () => {
    it("several controls produce separate tracks", () => {
        const r = startRecord();
        for (let i = 0; i < 3; i++) {
            clock.advance(50);
            r.capture(`ctl-${i + 1}`, 0.2 * (i + 1));
        }
        r.stop();
        expect(r.recording.tracks.map((t) => t.controlId)).toEqual(["ctl-1", "ctl-2", "ctl-3"]);
        expect(r.recording.tracks.every((t) => t.samples.length >= 1)).toBe(true);
    });

    it("projectBpm is read once at RECORD start; fallen back to the documented default", () => {
        let reads = 0;
        recorder = new AutomationRecorder(() => {
            reads++;
            return 180;
        }, clock.clock);
        recorder.arm();
        recorder.record();
        clock.advance(500);
        recorder.capture("c1", 0.5);
        recorder.stop();
        expect(recorder.projectBpm).toBe(180);
        expect(recorder.recording.projectBpm).toBe(180);
        expect(reads).toBe(1); // no live re-read during the take

        recorder.arm();
        recorder.record();
        expect(recorder.projectBpm).toBe(180);
    });

    it("falls back to DEFAULT_TEMPO_BPM when no provider documents BPM", () => {
        const r = new AutomationRecorder(() => undefined, clock.clock);
        r.arm();
        r.record();
        expect(r.projectBpm).toBe(DEFAULT_TEMPO_BPM);
        expect(r.recording.projectBpm).toBe(DEFAULT_TEMPO_BPM);
    });

    it("startTick is snapshotted into the recording (default 0)", () => {
        const r = startRecord({ startTick: 30720 });
        r.stop();
        expect(r.recording.startTick).toBe(30720);
        expect(r.startTick).toBe(30720);

        const r2 = new AutomationRecorder(undefined, clock.clock);
        r2.arm();
        r2.record();
        expect(r2.recording.startTick).toBe(0);
    });
});