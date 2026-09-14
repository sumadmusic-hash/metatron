// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Control } from "../../src/core/model/Control";
import { NexusLearnFlow } from "../../src/nexus/NexusLearnFlow";
import { Toast } from "../../src/ui/Toast";
import type { LearnResult } from "../../src/nexus/NexusLearn";

/**
 * P3.2 — the EditorUI and SurfaceUI previously ran byte-identical copies of
 * the per-control Nexus Learn flow. All of them now delegate to the SINGLE
 * NexusLearnFlow module; these unit tests pin the shared semantics so a
 * future UI change cannot silently diverge the two hosts again.
 */

const harness = vi.hoisted(() => {
    const created: { startLearn: any; cancelLearn: any }[] = [];
    let result: any = {};
    let gate: { promise: Promise<any>; resolve: (v: any) => void; reject: (e: unknown) => void } | null = null;

    class LearnTimeoutError extends Error {
        override name = "LearnTimeoutError";
    }
    class LearnCancelledError extends Error {
        override name = "LearnCancelledError";
    }

    return { created, result, gate, LearnTimeoutError, LearnCancelledError };
});

vi.mock("../../src/nexus/NexusLearn", () => {
    class MockNexusLearn {
        startLearn = vi.fn(() =>
            harness.gate ? harness.gate.promise : Promise.resolve(harness.result),
        );
        cancelLearn = vi.fn();
        constructor(_document: any) {
            harness.created.push(this);
        }
    }
    return {
        NexusLearn: MockNexusLearn,
        LearnTimeoutError: harness.LearnTimeoutError,
        LearnCancelledError: harness.LearnCancelledError,
    };
});

function makeGate() {
    let resolve: (v: any) => void = () => {};
    let reject: (e: unknown) => void = () => {};
    const promise = new Promise<any>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function makeResult(): LearnResult {
    return {
        entityId: "E1",
        entityType: "pulverisateur",
        fieldName: "cutoff",
        fieldPath: "filter.cutoff",
        value: 0.6,
        valueMapping: { kind: "linear", min: 0, max: 1 },
        targetName: "pulverisateur filter.cutoff",
        field: {},
    } as unknown as LearnResult;
}

function makeDeps() {
    return {
        getDocument: vi.fn(() => ({ queryEntities: { getEntity: () => undefined } })),
        subscribeBoundControl: vi.fn(),
        applyLearnResult: vi.fn(),
        saveCurrentDevice: vi.fn(),
        reflectValue: vi.fn(),
        onStateChanged: vi.fn(),
    };
}

describe("NexusLearnFlow — shared learn flow (P3.2)", () => {
    let toastSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        harness.created.length = 0;
        harness.result = {};
        harness.gate = null;
        // The static Toast container survives DOM resets, so assert on the spy.
        toastSpy = vi.spyOn(Toast, "show").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("success: applies the binding, names, resubscribes, persists and reflects the value", async () => {
        const deps = makeDeps();
        const flow = new NexusLearnFlow(deps);
        const control = new Control("knob", "Cutoff");
        harness.result = makeResult();

        await flow.learn(control);

        expect(harness.created).toHaveLength(1);
        expect(deps.getDocument).toHaveBeenCalledOnce();
        expect(deps.applyLearnResult).toHaveBeenCalledWith(control.id, expect.objectContaining({ entityId: "E1" }));
        expect(deps.subscribeBoundControl).toHaveBeenCalledWith(control.id);
        expect(deps.saveCurrentDevice).toHaveBeenCalledTimes(1);
        // value 0.6 on a 0..1 linear map → normalized 0.6
        expect(deps.reflectValue).toHaveBeenCalledWith(control.id, 0.6);
        // M4 auto-naming: fieldPath last segment assigned when not manual.
        expect(control.name).toBe("Cutoff");
        expect(control.nameSource).toBe("auto");
        expect(flow.isActive).toBe(false);
        expect(deps.onStateChanged).toHaveBeenCalled();
    });

    it("no document: shows the connect-first error and creates no NexusLearn", async () => {
        const deps = makeDeps();
        deps.getDocument.mockReturnValue(null);
        const flow = new NexusLearnFlow(deps);

        await flow.learn(new Control("knob", "A"));

        expect(harness.created).toHaveLength(0);
        expect(deps.onStateChanged).not.toHaveBeenCalled();
        expect(toastSpy).toHaveBeenCalledWith("Connect to an Audiotool project first.", "error");
    });

    it("re-click while learning toggles the learn OFF (result is dropped)", async () => {
        const deps = makeDeps();
        const flow = new NexusLearnFlow(deps);
        const control = new Control("knob", "A");
        harness.result = makeResult();
        harness.gate = makeGate();

        const inFlight = flow.learn(control);
        await Promise.resolve();
        expect(flow.isActive).toBe(true);

        flow.learn(control);   // second click toggles off
        expect(flow.isActive).toBe(false);

        // The stale learn eventually resolves → activeControlId is no longer
        // this control → its result must be thrown away.
        harness.gate.resolve(harness.result);
        await inFlight;

        expect(deps.applyLearnResult).not.toHaveBeenCalled();
        expect(deps.subscribeBoundControl).not.toHaveBeenCalled();
        expect(deps.reflectValue).not.toHaveBeenCalled();
    });

    it("cancel(): cancels the in-flight NexusLearn and resets the overlay state", async () => {
        const deps = makeDeps();
        const flow = new NexusLearnFlow(deps);
        const control = new Control("knob", "A");
        harness.result = makeResult();
        harness.gate = makeGate();

        const inFlight = flow.learn(control);
        await Promise.resolve();
        const instance = harness.created[0];
        expect(instance.cancelLearn).not.toHaveBeenCalled();

        flow.cancel();
        expect(instance.cancelLearn).toHaveBeenCalledTimes(1);
        expect(flow.isActive).toBe(false);

        harness.gate.resolve(harness.result); // late result → dropped, not applied
        await inFlight;
        expect(deps.applyLearnResult).not.toHaveBeenCalled();
        expect(deps.saveCurrentDevice).not.toHaveBeenCalled();
    });

    it("timeout: shows an error toast and resets the flow without applying anything", async () => {
        const deps = makeDeps();
        const flow = new NexusLearnFlow(deps);
        const control = new Control("knob", "A");
        harness.gate = makeGate();

        const inFlight = flow.learn(control);
        await Promise.resolve();

        harness.gate.reject(new harness.LearnTimeoutError());
        await inFlight;

        expect(flow.isActive).toBe(false);
        expect(deps.applyLearnResult).not.toHaveBeenCalled();
        expect(deps.saveCurrentDevice).not.toHaveBeenCalled();
        expect(toastSpy).toHaveBeenCalledWith("Learn timed out (60s). No change was captured.", "error");
    });

    it("cancelled: shows the info toast and never creates a binding", async () => {
        const deps = makeDeps();
        const flow = new NexusLearnFlow(deps);
        const control = new Control("knob", "A");
        harness.gate = makeGate();

        const inFlight = flow.learn(control);
        await Promise.resolve();

        harness.gate.reject(new harness.LearnCancelledError());
        await inFlight;

        expect(flow.isActive).toBe(false);
        expect(deps.applyLearnResult).not.toHaveBeenCalled();
        expect(toastSpy).toHaveBeenCalledWith("Learn cancelled. No binding was created.", "info");
    });
});