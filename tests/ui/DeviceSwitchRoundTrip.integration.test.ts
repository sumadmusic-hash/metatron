// @vitest-environment happy-dom
/**
 * ROUND TRIP A → B → A — REGRESSION FOR THE CONFIRMED PRODUCT SEMANTICS.
 *
 * A learned+subscribed control on Device A must NOT keep working after the
 * user switches to Device B and back to A:
 *
 *   Device A
 *   → Learn + Live Subscription
 *   → Device B
 *   → Device A
 *
 * After returning to A the old live Nexus connection is deliberately gone:
 * the rehydrated control is DISCONNECTED, remote events must NOT reach it and
 * outgoing writes must be refused (no active binding). A manual re-learn is the
 * only way to connect A again — mirroring what the Surface/Editor Learn flows
 * do (SurfaceUI.ts:553-554 / EditorUI.ts:1182-1183).
 *
 * The test runs the REAL @audiotool/nexus offline document through the REAL
 * AppUI device-switch path (openDevice → onDeviceChanged) so the id-compared
 * subscription clear (AppUI.ts:499-501) and BindingManager.setDevice
 * (BindingManager.ts:37-43) are exercised end-to-end.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createOfflineDocument } from "@audiotool/nexus/node";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { BindingManager } from "../../src/core/BindingManager";
import { AppUI } from "../../src/ui/AppUI";

const settle = (ms = 60) => new Promise<void>((r) => setTimeout(r, ms));

const tick = () => settle();

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

describe("Device switch round trip A→B→A — no automatic Nexus reconnection (confirmed semantics)", () => {
    let doc: any;
    let entity: any;
    let field: any;

    beforeEach(async () => {
        doc = await createOfflineDocument({ validated: true });
        await doc.modify((t: any) => {
            t.create("stompboxDelay", { displayName: "ROUND", feedbackFactor: 0.2 });
        });
        entity = doc.queryEntities.get().find((e: any) => e.fields.displayName.value === "ROUND");
        field = entity.fields.feedbackFactor;
    });

    /** Mirrors a Nexus Learn success result for `stompboxDelay.feedbackFactor`. */
    function learnResult(value: number) {
        return {
            entityId: entity.id,
            entityType: "stompboxDelay",
            fieldName: "feedbackFactor",
            fieldPath: "feedbackFactor",
            value,
            targetName: "stompboxDelay / feedbackFactor",
            field,
        };
    }

    /** Two persisted devices A and B; A is active (rehydrated fresh). */
    function mount(): { lib: DeviceLibrary; adapter: NexusAdapter; manager: BindingManager; active: Device; control: Control; root: HTMLElement } {
        const lib = new DeviceLibrary();
        const a = new Device("A");
        a.addControl(new Control("knob", "Cutoff", { x: 10, y: 10 }, "cutoff"));
        const b = new Device("B");
        b.addControl(new Control("switch", "Bypass", { x: 0, y: 0 }, "sw"));

        lib.currentDevice = a;
        lib.saveCurrentDevice();
        lib.currentDevice = b;
        lib.saveCurrentDevice();
        lib.loadDevice(a.id); // active device is a fresh rehydration of A

        const active = lib.currentDevice!;
        const control = active.getControl("cutoff")!;
        const adapter = new NexusAdapter();
        (adapter as any).document = doc;
        const manager = new BindingManager(active);
        // Mirrors NexusAdapter.openProject (AppUI.ts:615): the adapter reads
        // and writes the app's BindingManager instance.
        (adapter as any).bindingManager = manager;
        const root = document.createElement("div");
        document.body.appendChild(root);
        new AppUI(root, lib, adapter, new MidiAccess(), manager).render();
        return { lib, adapter, manager, active, control, root };
    }

    function row(root: HTMLElement, name: string): HTMLElement {
        return [...root.querySelectorAll<HTMLElement>(".device-list-item")].find((r) =>
            r.textContent?.includes(name),
        )!;
    }

    function click(el: HTMLElement) {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }

    function liveListenerCount(adapter: NexusAdapter): number {
        return (adapter as any).updateListeners.size;
    }

    it("A→B→A: the old live connection does NOT auto-return; re-learn restores it", async () => {
        const { lib, adapter, manager, active, control, root } = mount();

        // 1. Device A active. 2. Learn + subscribe for A.
        manager.applyLearnResult(control.id, learnResult(control.value));
        lib.saveCurrentDevice(); // persist the definition so a reload yields DISCONNECTED
        adapter.subscribeBoundControl(control.id);

        // 3. Connected + live subscription.
        expect(control.activeBindingState).toBe("CONNECTED");
        expect(liveListenerCount(adapter)).toBe(1);
        expect(manager.getActiveBinding(control.id)).toBeDefined();

        // Sanity: while A is active, a remote change reaches the control.
        await doc.modify((t: any) => { t.update(field, 0.61); });
        await tick();
        expect(control.value).toBeCloseTo(0.61, 5);

        // 4. Switch to Device B (real library click → openDevice → onDeviceChanged).
        click(row(root, "B"));

        // 5. A's subscription is gone, A is no longer actively bound.
        expect(lib.currentDevice!.name).toBe("B");
        expect(liveListenerCount(adapter)).toBe(0);
        expect(manager.getActiveBinding(control.id)).toBeUndefined();
        expect(manager.deviceRef.name).toBe("B");

        // 6. Switch back to Device A (fresh rehydration from Storage).
        click(row(root, "A"));
        const activeBack = lib.currentDevice!;
        const controlBack = activeBack.getControl(control.id)!;

        // 7. Fresh/deserialized instance, control is DISCONNECTED, no live binding.
        expect(activeBack).not.toBe(active);
        expect(controlBack).not.toBe(control);
        expect(controlBack.activeBindingState).toBe("DISCONNECTED");
        expect(liveListenerCount(adapter)).toBe(0);
        expect(manager.getActiveBinding(control.id)).toBeUndefined();
        expect(manager.deviceRef.name).toBe("A");

        // 8–9. A simulated remote event of the ORIGINAL field must NOT reach A.
        const beforeEvent = controlBack.value;
        await doc.modify((t: any) => { t.update(field, 0.77); });
        await tick();
        expect(controlBack.value).toBe(beforeEvent);

        // 10–11. Outgoing write is refused: no active binding exists.
        expect(await adapter.updateBoundControl(control.id, 0.4)).toBe(false);

        // 12. Manual re-learn connects A again.
        manager.applyLearnResult(controlBack.id, learnResult(controlBack.value));
        adapter.subscribeBoundControl(controlBack.id);

        // 13. Live subscription + CONNECTED + remote events work again.
        expect(liveListenerCount(adapter)).toBe(1);
        expect(controlBack.activeBindingState).toBe("CONNECTED");
        expect(manager.getActiveBinding(controlBack.id)).toBeDefined();

        await doc.modify((t: any) => { t.update(field, 0.88); });
        await tick();
        expect(controlBack.value).toBeCloseTo(0.88, 5);

        // Writes pass again once re-bound.
        expect(await adapter.updateBoundControl(controlBack.id, 0.33)).toBe(true);
    });

    it("same-device reload does NOT tear down the live subscription (id-guard, not an A→B→A switch)", async () => {
        const { lib, adapter, manager, control, root } = mount();

        manager.applyLearnResult(control.id, learnResult(control.value));
        adapter.subscribeBoundControl(control.id);
        expect(liveListenerCount(adapter)).toBe(1);
        expect(control.activeBindingState).toBe("CONNECTED");

        // Re-opening the ACTIVE device keeps the same device id: the semantics
        // are "same-device refresh", so the live subscription must survive.
        click(row(root, "A"));

        expect(liveListenerCount(adapter)).toBe(1);
        // Remote values still flow after the same-id reload.
        await doc.modify((t: any) => { t.update(field, 0.5); });
        await tick();
        expect(lib.currentDevice!.getControl(control.id)!.value).toBeCloseTo(0.5, 5);
    });
});