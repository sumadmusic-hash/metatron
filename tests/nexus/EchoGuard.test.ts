import { describe, it, expect, vi, beforeEach } from "vitest";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { BindingManager } from "../../src/core/BindingManager";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import type { NexusValueMapping } from "../../src/nexus/NexusValueMapping";

/**
 * Phase 2 (FIX 1) — Echo-Guard tests.
 *
 * The adapter must suppress its own write's echo (the round-trip event
 * triggered by Nexus document.modify) while still forwarding genuine
 * remote changes.
 *
 * Verifies: Wertvergleich (round-trip mapping), Fenster (windowMs),
 * Ablauf (expiry after window), mismatch (different value passes through).
 */

/* ---------- fake document (same shape as DeviceSwitchSubscriptions) ---------- */

function fakeDocument(initialValue = 0) {
    const listeners = new Set<(v: number) => void>();
    const field = { value: initialValue, mutable: true };
    return {
        field,
        events: {
            onUpdate: (_f: unknown, cb: (v: number) => void) => {
                listeners.add(cb);
                return { terminate: () => listeners.delete(cb) };
            },
        },
        fire(v: number) {
            listeners.forEach((cb) => cb(v));
        },
        listenerCount: () => listeners.size,
    };
}

/* -------- helpers -------- */

const LINEAR_01: NexusValueMapping = { kind: "linear", min: 0, max: 1 };

function makeDeviceAndControl(controlId = "cutoff") {
    const device = new Device("Echo");
    const control = new Control("knob", "Cutoff", { x: 0, y: 0 }, controlId);
    device.addControl(control);
    return { device, control };
}

function bind(doc: ReturnType<typeof fakeDocument>, control: Control, mapping: NexusValueMapping = LINEAR_01) {
    const device = new Device("E");
    // BindManager expects a device; we discard it and set via casting
    const manager = new BindingManager(makeDeviceAndControl(control.id).device);
    manager.setBinding(control.id, "entity1", "cutoff", "Cutoff", doc.field, "cutoff", mapping);
    return manager;
}

function makeAdapter(
    doc: ReturnType<typeof fakeDocument>,
    manager: BindingManager,
): NexusAdapter {
    const adapter = new NexusAdapter();
    (adapter as any).document = doc;
    (adapter as any).bindingManager = manager;
    return adapter;
}

beforeEach(() => {
    vi.restoreAllMocks();
});

/* ========================= TESTS ========================= */

describe("Echo-Guard — Wertvergleich (round-trip mapping)", () => {
    it("own write's echo is suppressed when round-trip value matches guard", () => {
        const doc = fakeDocument();
        const { device, control } = makeDeviceAndControl();
        const manager = bind(doc, control);
        const adapter = makeAdapter(doc, manager);

        const received: number[] = [];
        adapter.onNexusValueChanged = (_id, v) => received.push(v);
        adapter.subscribeBoundControl(control.id);

        // Register a guard at normalized value 0.5
        adapter.beginSuppressEcho(control.id, 0.5);

        // Document fires back the same normalized value → must be consumed
        doc.fire(0.5);
        expect(received).toEqual([]);
        expect(doc.listenerCount()).toBe(1); // listener still registered
    });

    it("non-matching echo (different value) is forwarded to onNexusValueChanged", () => {
        const doc = fakeDocument();
        const { device, control } = makeDeviceAndControl();
        const manager = bind(doc, control);
        const adapter = makeAdapter(doc, manager);

        const received: number[] = [];
        adapter.onNexusValueChanged = (_id, v) => received.push(v);
        adapter.subscribeBoundControl(control.id);

        adapter.beginSuppressEcho(control.id, 0.5);
        doc.fire(0.8); // different value → not our echo
        expect(received).toEqual([0.8]);
    });

    it("no guard → any event reaches the UI", () => {
        const doc = fakeDocument();
        const { device, control } = makeDeviceAndControl();
        const manager = bind(doc, control);
        const adapter = makeAdapter(doc, manager);

        const received: number[] = [];
        adapter.onNexusValueChanged = (_id, v) => received.push(v);
        adapter.subscribeBoundControl(control.id);

        doc.fire(0.3);
        expect(received).toEqual([0.3]);
    });
});

describe("Echo-Guard — Fenster (windowMs)", () => {
    it("guard expires after windowMs, subsequent echo passes through", () => {
        vi.useFakeTimers();
        const doc = fakeDocument();
        const { device, control } = makeDeviceAndControl();
        const manager = bind(doc, control);
        const adapter = makeAdapter(doc, manager);

        const received: number[] = [];
        adapter.onNexusValueChanged = (_id, v) => received.push(v);
        adapter.subscribeBoundControl(control.id);

        // Guard with a 50 ms window
        adapter.beginSuppressEcho(control.id, 0.5, 50);

        // Within the window → consumed
        doc.fire(0.5);
        expect(received).toEqual([]);

        // Second guard with a new window
        adapter.beginSuppressEcho(control.id, 0.5, 50);
        vi.advanceTimersByTime(80); // past the window

        // Now the same value should pass through (guard expired)
        doc.fire(0.5);
        expect(received).toEqual([0.5]);

        vi.useRealTimers();
    });
});

describe("Echo-Guard — Ablauf (expiry)", () => {
    it("expired guard entry is cleaned up and never blocks a later remote change", () => {
        vi.useFakeTimers();
        const doc = fakeDocument();
        const { device, control } = makeDeviceAndControl();
        const manager = bind(doc, control);
        const adapter = makeAdapter(doc, manager);

        const received: number[] = [];
        adapter.onNexusValueChanged = (_id, v) => received.push(v);
        adapter.subscribeBoundControl(control.id);

        adapter.beginSuppressEcho(control.id, 0.5, 10);
        vi.advanceTimersByTime(20); // expired

        // Remote change with a completely different value → must pass through
        doc.fire(0.9);
        expect(received).toEqual([0.9]);

        vi.useRealTimers();
    });
});

describe("Echo-Guard — delayed/offset echoes (B12 ring)", () => {
    it("echo of write N arriving after guard-set of write N+1 is still suppressed", () => {
        const doc = fakeDocument();
        const { device, control } = makeDeviceAndControl();
        const manager = bind(doc, control);
        const adapter = makeAdapter(doc, manager);

        const received: number[] = [];
        adapter.onNexusValueChanged = (_id, v) => received.push(v);
        adapter.subscribeBoundControl(control.id);

        // Write N = 0.3, then write N+1 = 0.8 (guard overwritten per control,
        // but the ring keeps the older expected echo too).
        adapter.beginSuppressEcho(control.id, 0.3);
        adapter.beginSuppressEcho(control.id, 0.8);

        // The delayed echo of write N arrives AFTER N+1's guard-set.
        doc.fire(0.3);
        expect(received).toEqual([]); // matched against the ring → consumed

        // A foreign value is never consumed.
        doc.fire(0.5);
        expect(received).toEqual([0.5]);
    });

    it("echo matching a still-live guard is consumed, but only once per entry", () => {
        const doc = fakeDocument();
        const { device, control } = makeDeviceAndControl();
        const manager = bind(doc, control);
        const adapter = makeAdapter(doc, manager);

        const received: number[] = [];
        adapter.onNexusValueChanged = (_id, v) => received.push(v);
        adapter.subscribeBoundControl(control.id);

        adapter.beginSuppressEcho(control.id, 0.4);
        doc.fire(0.4); // consumed
        expect(received).toEqual([]);

        // Guard entry was removed on the match → a second identical event is
        // a NEW remote change, not our echo.
        doc.fire(0.4);
        expect(received).toEqual([0.4]);
    });

    it("expired ring entries are pruned and never block later remote changes", () => {
        vi.useFakeTimers();
        const doc = fakeDocument();
        const { device, control } = makeDeviceAndControl();
        const manager = bind(doc, control);
        const adapter = makeAdapter(doc, manager);

        const received: number[] = [];
        adapter.onNexusValueChanged = (_id, v) => received.push(v);
        adapter.subscribeBoundControl(control.id);

        adapter.beginSuppressEcho(control.id, 0.6, 20);
        adapter.beginSuppressEcho(control.id, 0.9, 20);
        vi.advanceTimersByTime(40); // past both windows

        doc.fire(0.6); // expired + non-live ring → forwarded
        expect(received).toEqual([0.6]);

        vi.useRealTimers();
    });
});
