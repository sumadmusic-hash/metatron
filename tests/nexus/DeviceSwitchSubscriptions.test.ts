import { describe, it, expect } from "vitest";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { BindingManager } from "../../src/core/BindingManager";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import type { NexusValueMapping } from "../../src/nexus/NexusValueMapping";

const NORMALIZED_MAPPING: NexusValueMapping = { kind: "linear", min: 0, max: 1 };

/** Minimal document stand-in: one field + a subscribable change stream whose
 *  terminate() really unregisters the callback. */
function fakeDocument() {
    const listeners = new Set<(v: number) => void>();
    const field = { value: 0, mutable: true };
    return {
        field,
        events: {
            onUpdate: (_f: unknown, cb: (v: number) => void) => {
                listeners.add(cb);
                return {
                    terminate: () => {
                        listeners.delete(cb);
                    },
                };
            },
        },
        fire(v: number) {
            listeners.forEach((cb) => cb(v));
        },
        listenerCount: () => listeners.size,
    } as { field: any; events: any; fire: (v: number) => void; listenerCount: () => number };
}

describe("NexusAdapter — device-switch subscription lifecycle (P3)", () => {

    it("clearBoundControlSubscriptions terminates listeners and blocks stale events", () => {
        const adapter = new NexusAdapter();
        const doc = fakeDocument();
        (adapter as any).document = doc;

        const device = new Device("A");
        const control = new Control("knob", "Cutoff", { x: 0, y: 0 }, "cutoff");
        device.addControl(control);
        const manager = new BindingManager(device);
        manager.setBinding(control.id, "e1", "cutoff", "Cutoff", doc.field, "cutoff", NORMALIZED_MAPPING);
        (adapter as any).bindingManager = manager;

        const received: number[] = [];
        adapter.onNexusValueChanged = (_controlId, v) => received.push(v);
        adapter.subscribeBoundControl(control.id);
        expect(doc.listenerCount()).toBe(1);

        doc.fire(0.25);
        expect(received).toEqual([0.25]);

        adapter.clearBoundControlSubscriptions();
        expect(doc.listenerCount()).toBe(0);

        // A stale event from the previous device must no longer reach the UI.
        doc.fire(0.75);
        expect(received).toEqual([0.25]);
    });

    it("clearBoundControlSubscriptions is a harmless no-op when nothing is subscribed", () => {
        const adapter = new NexusAdapter();
        expect(() => adapter.clearBoundControlSubscriptions()).not.toThrow();
    });
});