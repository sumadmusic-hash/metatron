import { describe, it, expect, vi } from "vitest";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { BindingManager } from "../../src/core/BindingManager";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import type { NexusValueMapping } from "../../src/nexus/NexusValueMapping";

const NORMALIZED_MAPPING: NexusValueMapping = { kind: "linear", min: 0, max: 1 };

/**
 * §40 — RECONNECT vs. NEW PROJECT (NexusAdapter.openProject).
 *
 * Re-opening the SAME project URL must keep the user's active bindings
 * (no re-learn required), while switching to a different project URL must
 * hard-reset them to DISCONNECTED — exactly the behavior onProjectLoaded
 * provides today.
 */
describe("NexusAdapter — reconnect to the SAME project URL keeps active bindings (§40)", () => {
    function makeDoc(fieldValue = 0) {
        const listeners = new Set<(v: number) => void>();
        const field = { value: fieldValue, mutable: true, location: "L" };
        const entity = {
            id: "e1",
            fields: { cutoff: field },
        };
        return {
            field,
            entity,
            events: {
                onUpdate: (f: unknown, cb: (v: number) => void) => {
                    listeners.add(cb);
                    return {
                        terminate: () => {
                            listeners.delete(cb);
                        },
                    };
                },
            },
            queryEntities: {
                getEntity: (id: string) => (id === entity.id ? entity : undefined),
            },
            stop: vi.fn(async () => {}),
            start: vi.fn(async () => {}),
            listenerCount: () => listeners.size,
            fire: (v: number) => listeners.forEach((cb) => cb(v)),
        };
    }

    function authenticatedAdapter(openedDocs: any[]): NexusAdapter {
        const adapter = new NexusAdapter();
        (adapter as any).client = {
            status: "authenticated",
            open: vi.fn(async () => openedDocs.shift()!),
        };
        return adapter;
    }

    it("same-URL reconnect keeps the active binding, re-resolves its field and re-subscribes", async () => {
        const doc1 = makeDoc(0.4);
        const doc2 = makeDoc(0.6);
        const adapter = authenticatedAdapter([doc1, doc2]);
        const device = new Device("A");
        const control = new Control("knob", "Cutoff", { x: 0, y: 0 }, "cutoff");
        device.addControl(control);
        const manager = new BindingManager(device);

        const URL = "https://audiotool.com/project/123";

        // 1. First connect (no bindings yet — hard path runs harmlessly).
        await adapter.openProject(URL, manager);

        // 2. User learns the control against the connected project.
        manager.setBinding(control.id, "e1", "cutoff", "Cutoff", doc1.field, "cutoff", NORMALIZED_MAPPING);
        adapter.subscribeBoundControl(control.id);
        expect(control.activeBindingState).toBe("CONNECTED");
        expect(manager.getActiveBinding(control.id)!.field).toBe(doc1.field);
        expect(doc1.listenerCount()).toBe(1);

        // 3. Reconnect with the very same URL after a drop.
        await adapter.openProject(URL, manager);

        expect(manager.getActiveBinding(control.id)).toBeDefined();
        expect(manager.getActiveBinding(control.id)!.entityId).toBe("e1");
        expect(manager.getActiveBinding(control.id)!.fieldName).toBe("cutoff");
        // The stored live reference was re-resolved against the NEW document.
        expect(manager.getActiveBinding(control.id)!.field).toBe(doc2.field);
        expect(control.activeBindingState).toBe("CONNECTED");
        // The parameter subscription was re-established on the new document.
        expect(doc1.listenerCount()).toBe(0);
        expect(doc2.listenerCount()).toBe(1);

        // Remote values on the RE-opened document still flow.
        const received: number[] = [];
        adapter.onNexusValueChanged = (_id, v) => received.push(v);
        doc2.fire(0.85);
        expect(received).toEqual([0.85]);

        // 4. A genuinely different project URL hard-resets the bindings.
        const doc3 = makeDoc(0.1);
        (adapter as any).client.open.mockResolvedValueOnce(doc3);
        await adapter.openProject("https://audiotool.com/project/456", manager);
        expect(manager.getActiveBinding(control.id)).toBeUndefined();
        expect(control.activeBindingState).toBe("DISCONNECTED");
        expect(doc2.listenerCount()).toBe(0);
    });

    it("first connect also runs the hard path (no bindings survive an initial open)", async () => {
        const doc = makeDoc();
        const adapter = authenticatedAdapter([doc]);
        const device = new Device("A");
        const control = new Control("knob", "Cutoff", { x: 0, y: 0 }, "cutoff");
        device.addControl(control);
        const manager = new BindingManager(device);
        manager.setBinding(control.id, "e1", "cutoff", "Cutoff", doc.field, "cutoff", NORMALIZED_MAPPING);

        await adapter.openProject("https://audiotool.com/project/123", manager);

        expect(manager.getActiveBinding(control.id)).toBeUndefined();
        expect(control.activeBindingState).toBe("DISCONNECTED");
    });
});

describe("NexusAdapter — B5 Transition-Reinheit in openProject / onDocumentConnectedChanged", () => {
    function makeDoc(fieldValue = 0) {
        const listeners = new Set<(v: number) => void>();
        const field = { value: fieldValue, mutable: true, location: "L" };
        const entity = { id: "e1", fields: { cutoff: field } };
        return {
            field,
            entity,
            events: {
                onUpdate: (_f: unknown, cb: (v: number) => void) => {
                    listeners.add(cb);
                    return { terminate: () => listeners.delete(cb) };
                },
            },
            queryEntities: { getEntity: (id: string) => (id === entity.id ? entity : undefined) },
            stop: vi.fn(async () => {}),
            start: vi.fn(async () => {}),
        };
    }

    it("während des asynchronen open() sind document und bindingManager null", async () => {
        const doc1 = makeDoc(0.4);
        const doc2 = makeDoc(0.6);
        let resolveOpen!: (d: any) => void;
        let duringOpen: { document: unknown; bm: unknown } | undefined;
        const gate = new Promise<any>((r) => (resolveOpen = r));

        const adapter = new NexusAdapter();
        const pending = [doc1];
        (adapter as any).client = {
            status: "authenticated",
            open: vi.fn((_url: string) => {
                // Synchron beim Aufruf erfassen, was dieser Axe der Adapter
                // gerade preisgibt — Microtask-Flush unten umreißt den Punkt
                // nach document.stop() und klar vor resolveOpen.
                duringOpen = { document: adapter.document, bm: (adapter as any).bindingManager };
                if (pending.length) return Promise.resolve(pending.shift()!);
                return gate.then(() => doc2); // zweiter open hängt, bis entriegelt
            }),
        };
        const manager = new BindingManager(new Device("A"));

        // Erstconnect → konkreter Ausgangszustand (document != null).
        await adapter.openProject("https://audiotool.com/project/1", manager);
        expect(adapter.document).toBe(doc1);

        const opening = adapter.openProject("https://audiotool.com/project/2", manager);
        // Mikrotask-Flush: läuft durch await stop() + nullung + open()-Aufruf.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(duringOpen!.document).toBeNull(); // kein gestopptes Alt-Dokument
        expect(duringOpen!.bm).toBeNull(); // kein BindingManager des Vorgängers

        resolveOpen(doc2);
        await opening;
        expect(adapter.document).toBe(doc2);
        expect((adapter as any).bindingManager).toBe(manager);
    });

    it("Frühabbruch von onDocumentConnectedChanged räumt connectionCleanup", () => {
        const adapter = new NexusAdapter();
        const unsub = vi.fn();
        (adapter as any).document = { connected: { subscribe: () => unsub } };

        adapter.onDocumentConnectedChanged(vi.fn());
        expect((adapter as any).connectionCleanup).toBe(unsub);

        // Document weg (Verbindung gekappt) → Frühabbruch-Pfad.
        adapter.document = null;
        adapter.onDocumentConnectedChanged(vi.fn());
        // Vor B5 blieb der verwaiste Cleanup des alten Dokuments im Zustand.
        expect((adapter as any).connectionCleanup).toBeUndefined();
    });
});

describe("NexusAdapter — R5 konkurrierende openProject(): nur der NEUESTE Request übernimmt", () => {
    function makeDoc(fieldValue = 0) {
        const listeners = new Set<(v: number) => void>();
        const field = { value: fieldValue, mutable: true, location: "L" };
        const entity = { id: "e1", fields: { cutoff: field } };
        return {
            field,
            entity,
            events: {
                onUpdate: (_f: unknown, cb: (v: number) => void) => {
                    listeners.add(cb);
                    return { terminate: () => listeners.delete(cb) };
                },
            },
            queryEntities: { getEntity: (id: string) => (id === entity.id ? entity : undefined) },
            stop: vi.fn(async () => {}),
            start: vi.fn(async () => {}),
        };
    }

    it("ein langsamer, VERALTETER open()-Request überschreibt das frisch geöffnete Projekt des neueren Requests nicht", async () => {
        const docA = makeDoc(0.4);
        const docB = makeDoc(0.6);
        let resolveSlowOpen!: (d: any) => void;
        const gate = new Promise<any>((r) => (resolveSlowOpen = r));

        const adapter = new NexusAdapter();
        (adapter as any).client = {
            status: "authenticated",
            open: vi.fn((url: string) => (url === "B" ? Promise.resolve(docB) : gate.then(() => docA))),
        };
        const manager = new BindingManager(new Device("A"));

        // Request 1 (Projekt A) startet und hängt im asynchronen open() …
        const openingA = adapter.openProject("A", manager);
        // … bevor Request 2 (Projekt B) schnell durchläuft und den State übernimmt.
        await adapter.openProject("B", manager);
        expect(adapter.document).toBe(docB);
        expect((adapter as any).bindingManager).toBe(manager);

        // Der VERALTETE Request darf Identität und Manager nicht mehr anfassen:
        resolveSlowOpen(docA);
        await openingA;

        expect(adapter.document).toBe(docB); // B bleibt das aktive Projekt
        expect((adapter as any).bindingManager).toBe(manager);
        expect(docA.stop).toHaveBeenCalled(); // A wurde entsorgt, nicht installiert
        expect(docB.stop).not.toHaveBeenCalled();
    });
});