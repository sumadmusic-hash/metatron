import { MidiAccess } from "./MidiAccess";

/** Thrown when a MIDI Learn is cancelled before a CC message arrives. */
export class MidiLearnCancelError extends Error {
    constructor() {
        super("MIDI Learn cancelled");
        this.name = "MidiLearnCancelError";
    }
}

/** Thrown when a MIDI Learn times out before a CC message arrives. */
export class MidiLearnTimeoutError extends Error {
    constructor() {
        super("MIDI Learn timed out");
        this.name = "MidiLearnTimeoutError";
    }
}

export type MidiLearnState = "IDLE" | "LEARNING";

export interface MidiLearnOptions {
    /** Time in ms after which Learn rejects with MidiLearnTimeoutError. No timeout when unset. */
    timeoutMs?: number;
}

/**
 * MIDI Learn (§25-27) with a strict state machine:
 *
 *   IDLE ──startLearn()──▶ LEARNING ──first CC message──▶ SUCCESS (resolve + restore)
 *                             ├─cancelLearn()──▶ CANCEL  (reject)
 *                             ├─timeout──▶      TIMEOUT (reject)
 *                             └─swap failure──▶ ERROR    (reject)
 *
 * EVERY exit path settles the pending promise (resolve or reject) and restores
 * the previously installed MIDI message handler.
 */
export class MidiLearn {
    private state: MidiLearnState = "IDLE";
    private midiAccess: MidiAccess;
    private resolveFn?: (binding: { channel: number, cc: number }) => void;
    private rejectFn?: (reason: any) => void;
    private previousCallback?: (channel: number, cc: number, value: number) => void;
    private timeout?: ReturnType<typeof setTimeout>;

    constructor(midiAccess: MidiAccess) {
        this.midiAccess = midiAccess;
    }

    public get currentState(): MidiLearnState {
        return this.state;
    }

    public startLearn(
        currentCallback?: (channel: number, cc: number, value: number) => void,
        options: MidiLearnOptions = {}
    ): Promise<{ channel: number, cc: number }> {
        if (this.state === "LEARNING") {
            // A second Learn while one is active cancels the previous one so its
            // promise is settled (CANCEL), never dangling.
            this.cancelLearn();
        }

        this.state = "LEARNING";
        this.previousCallback = currentCallback;
        this.timeout = undefined;

        const timeoutMs = options.timeoutMs;
        return new Promise((resolve, reject) => {
            this.resolveFn = resolve;
            this.rejectFn = reject;

            if (timeoutMs !== undefined) {
                this.timeout = setTimeout(() => {
                    this.fail(new MidiLearnTimeoutError());
                }, timeoutMs);
            }

            try {
                this.midiAccess.setMessageHandler((channel, cc, _value) => {
                    if (this.state === "LEARNING" && this.resolveFn) {
                        this.state = "IDLE";
                        this.clearTimeoutTimer();
                        const result = { channel, cc };
                        this.resolveFn(result);
                        this.reset();
                    }
                });
            } catch (e) {
                this.fail(e instanceof Error ? e : new Error(String(e)));
            }
        });
    }

    public cancelLearn() {
        if (this.state !== "LEARNING") return;
        this.fail(new MidiLearnCancelError());
    }

    public isActive(): boolean {
        return this.state === "LEARNING";
    }

    private fail(reason: any) {
        if (this.state !== "LEARNING") return;
        this.state = "IDLE";
        this.clearTimeoutTimer();
        this.rejectFn?.(reason);
        this.reset();
    }

    private reset() {
        // Restore the handler that was active before this Learn hijacked it.
        if (this.previousCallback) {
            this.midiAccess.setMessageHandler(this.previousCallback);
        }
        this.previousCallback = undefined;
        this.resolveFn = undefined;
        this.rejectFn = undefined;
    }

    private clearTimeoutTimer() {
        if (this.timeout !== undefined) {
            clearTimeout(this.timeout);
            this.timeout = undefined;
        }
    }
}