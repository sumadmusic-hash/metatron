import { describe, it, expect, beforeEach } from "vitest";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { MidiLearn, MidiLearnCancelError, MidiLearnTimeoutError } from "../../src/midi/MidiLearn";

/** Minimal fake MidiAccess that exposes the installed handler for testing. */
class FakeMidiAccess extends MidiAccess {
    public installedHandler: ((channel: number, cc: number, value: number) => void) | null = null;

    public override setMessageHandler(callback: (channel: number, cc: number, value: number) => void) {
        this.installedHandler = callback;
    }

    public trigger(channel: number, cc: number, value: number) {
        this.installedHandler?.(channel, cc, value);
    }
}

const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe("MidiLearn state machine — every path settles the promise (§25-27)", () => {
    let access: FakeMidiAccess;
    let learn: MidiLearn;

    beforeEach(() => {
        access = new FakeMidiAccess();
        learn = new MidiLearn(access);
    });

    it("IDLE → LEARNING → SUCCESS: first CC resolves, handler restored", async () => {
        const original = (_c: number, _cc: number, _v: number) => { /* app pipeline */ };
        const p = learn.startLearn(original, { timeoutMs: 5000 });
        expect(learn.currentState).toBe("LEARNING");
        expect(learn.isActive()).toBe(true);

        access.trigger(1, 20, 100);
        await expect(p).resolves.toEqual({ channel: 1, cc: 20 });
        expect(learn.currentState).toBe("IDLE");
        // The app's normal CC pipeline is re-installed.
        expect(access.installedHandler).toBe(original);
    });

    it("IDLE → LEARNING → CANCEL: cancelLearn rejects with MidiLearnCancelError and restores", async () => {
        const original = (_c: number, _cc: number, _v: number) => {};
        const p = learn.startLearn(original, { timeoutMs: 5000 });
        let rejection: any = null;
        p.catch((e) => { rejection = e; });

        learn.cancelLearn();
        await settle();
        expect(rejection).toBeInstanceOf(MidiLearnCancelError);
        expect(learn.currentState).toBe("IDLE");
        expect(learn.isActive()).toBe(false);
        expect(access.installedHandler).toBe(original);

        // A CC arriving after cancel must NOT resolve the dead promise or re-bind.
        access.trigger(1, 30, 64);
        await settle();
        expect(rejection).toBeInstanceOf(MidiLearnCancelError);
        expect(learn.currentState).toBe("IDLE");
    });

    it("IDLE → LEARNING → TIMEOUT: rejects with MidiLearnTimeoutError and restores", async () => {
        const original = (_c: number, _cc: number, _v: number) => {};
        const p = learn.startLearn(original, { timeoutMs: 20 });
        await expect(p).rejects.toThrowError(MidiLearnTimeoutError);
        expect(learn.currentState).toBe("IDLE");
        expect(access.installedHandler).toBe(original);
    });

    it("cancelLearn when IDLE is a no-op (state machine guard)", () => {
        learn.cancelLearn();
        expect(learn.currentState).toBe("IDLE");
        expect(access.installedHandler).toBeNull();
    });

    it("a second startLearn cancels the first so no promise dangles", async () => {
        const first = learn.startLearn(undefined, { timeoutMs: 5000 });
        let firstRejection: any = null;
        first.catch((e) => { firstRejection = e; });

        const second = learn.startLearn(undefined, { timeoutMs: 5000 });
        await settle();

        // First promise settled as CANCEL, second is LEARNING and live.
        expect(firstRejection).toBeInstanceOf(MidiLearnCancelError);
        expect(learn.currentState).toBe("LEARNING");
        expect(learn.isActive()).toBe(true);

        access.trigger(2, 44, 77);
        await expect(second).resolves.toEqual({ channel: 2, cc: 44 });
    });
});