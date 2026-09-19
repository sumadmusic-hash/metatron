// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { BindingManager } from "../../src/core/BindingManager";
import { AppUI } from "../../src/ui/AppUI";
import { createDefaultMatrix } from "../../src/core/modulation/ModulationTypes";

/**
 * B55 — the runner must only run when the matrix can actually produce
 * destinations. It is NOT enough for a slot to be enabled: a slot whose
 * sourceId dangles (no matching ModSource in sources[]) evaluates to an empty
 * destination map every frame (ModulationEngine.evaluateDestinations skips
 * those slots) — an idle rAF loop. matrixRunnable() requires an enabled slot
 * routing an EXISTING source.
 */

class CapturingMidi extends MidiAccess {
    public override setMessageHandler(_cb: (channel: number, cc: number, value: number) => void) {}
}

class SilentAdapter extends NexusAdapter {
    public override updateBoundControl(_id: string, _v: number): Promise<boolean> {
        return Promise.resolve(true);
    }
}

function makeDevice(): { device: Device; ctrl: Control } {
    const device = new Device("B55");
    const ctrl = new Control("knob", "k", { x: 0, y: 0 }, "k1");
    ctrl.value = 0.5;
    device.addControl(ctrl);
    device.modulation = createDefaultMatrix();
    return { device, ctrl };
}

function mount(device: Device): { app: AppUI } {
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    lib.saveCurrentDevice();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const adapter = new SilentAdapter();
    const bm = new BindingManager(device);
    const app = new AppUI(root, lib, adapter, new CapturingMidi(), bm);
    app.render();
    return { app };
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

describe("B55 — runner start-guard requires an enabled slot routing an EXISTING source", () => {
    it("matrixRunnable → false with NO enabled slot (default matrix)", () => {
        const { app } = mount(makeDevice().device);
        expect((app as any).matrixRunnable((app as any).deviceLibrary.currentDevice)).toBe(false);
    });

    it("matrixRunnable → false when the enabled slot has a DANGLING sourceId", () => {
        const { device, ctrl } = makeDevice();
        device.modulation.slots[0].enabled = true;
        device.modulation.slots[0].destControlId = ctrl.id;
        device.modulation.slots[0].sourceId = "ghost-source";
        const { app } = mount(device);
        expect((app as any).matrixRunnable(device)).toBe(false);
    });

    it("matrixRunnable → true when an enabled slot routes an existing source", () => {
        const { device, ctrl } = makeDevice();
        device.modulation.slots[0].enabled = true;
        device.modulation.slots[0].destControlId = ctrl.id;
        device.modulation.slots[0].sourceId = device.modulation.sources[0].id;
        const { app } = mount(device);
        expect((app as any).matrixRunnable(device)).toBe(true);
    });

    it("render startet/stoppt den Runner nur bei Zustandswechsel (§12), nicht bei jedem render", () => {
        const { device, ctrl } = makeDevice();
        device.modulation.slots[0].enabled = true;
        device.modulation.slots[0].destControlId = ctrl.id;
        device.modulation.slots[0].sourceId = "ghost-source";
        const { app } = mount(device);

        const runner = (app as any).modRunner;
        const stopSpy = vi.spyOn(runner, "stop");
        const startSpy = vi.spyOn(runner, "start");

        // Nicht-lauffähig ZUSTAND unverändert → render ruft weder start noch stop.
        app.render();
        expect(startSpy).not.toHaveBeenCalled();
        expect(stopSpy).not.toHaveBeenCalled();

        // Quelle aufgelöst → Zustandswechsel → genau EIN Start.
        device.modulation.slots[0].sourceId = device.modulation.sources[0].id;
        app.render();
        expect(startSpy).toHaveBeenCalledTimes(1);
        expect(stopSpy).not.toHaveBeenCalled();

        // Runner läuft tatsächlich (rAF aktiv).
        const rafId = (runner as any).rafId as number | null;
        expect(rafId).not.toBeNull();

        // Rückbau → Zustandswechsel → genau EIN Stopp.
        device.modulation.slots[0].sourceId = "ghost-source";
        app.render();
        expect(stopSpy).toHaveBeenCalledTimes(1);

        // Stabiler nicht-lauffähiger Zustand → weiterer render bleibt ein No-Op.
        app.render();
        expect(stopSpy).toHaveBeenCalledTimes(1);
        vi.restoreAllMocks();
    });

    it("Matrix bleibt runnable → kein unnötiger restart (LFO-Phase und rAF bleiben aktiv)", () => {
        const { device, ctrl } = makeDevice();
        device.modulation.slots[0].enabled = true;
        device.modulation.slots[0].destControlId = ctrl.id;
        device.modulation.slots[0].sourceId = device.modulation.sources[0].id;
        const { app } = mount(device);

        const runner = (app as any).modRunner;
        const startSpy = vi.spyOn(runner, "start");
        const stopSpy = vi.spyOn(runner, "stop");

        // Matrix is already running
        expect((app as any).modRunnerState).toBe(true);

        // Edits that keep the matrix runnable
        device.modulation.slots[0].amount = 0.8;
        app.render();
        device.modulation.sources[0].rateHz = 7;
        (app as any).syncModulationRunner();
        device.modulation.sources[0].waveform = "saw";
        (app as any).syncModulationRunner();

        // Runner must NOT have been restarted (0 extra start calls, 0 stop calls)
        expect(startSpy).not.toHaveBeenCalled();
        expect(stopSpy).not.toHaveBeenCalled();
        expect((app as any).modRunnerState).toBe(true);

        // Only transitioning to not-runnable stops it
        device.modulation.slots.forEach((s) => { s.enabled = false; });
        (app as any).syncModulationRunner();
        expect(stopSpy).toHaveBeenCalledTimes(1);
        expect((app as any).modRunnerState).toBe(false);

        // Only transitioning to runnable starts it
        device.modulation.slots[0].enabled = true;
        (app as any).syncModulationRunner();
        expect(startSpy).toHaveBeenCalledTimes(1);
        expect((app as any).modRunnerState).toBe(true);

        vi.restoreAllMocks();
    });

    it("§12 — Same-ID-Rehydrierung (Preset-Load / Undo / Rename) startet Runner NICHT neu, solange Matrix runnable bleibt", () => {
        const { device, ctrl } = makeDevice();
        device.modulation.slots[0].enabled = true;
        device.modulation.slots[0].destControlId = ctrl.id;
        device.modulation.slots[0].sourceId = device.modulation.sources[0].id;
        const { app } = mount(device);

        const runner = (app as any).modRunner;
        const startSpy = vi.spyOn(runner, "start");
        const stopSpy = vi.spyOn(runner, "stop");

        // Runner is running
        expect((app as any).modRunnerState).toBe(true);
        const initialStartTimeSec = (runner as any).startTimeSec;

        // Simulate Same-ID-Rehydrierung: gleiche Device-ID, aber neue Instanz
        // (wie Preset-Load, Undo, Redo, Rename)
        // onDeviceChanged() darf modRunnerState NICHT auf false setzen
        // → syncModulationRunner() darf NICHT stop()/start() aufrufen
        (app as any).onDeviceChanged();

        // Runner darf NICHT neu gestartet werden
        expect(startSpy).not.toHaveBeenCalled();
        expect(stopSpy).not.toHaveBeenCalled();
        // LFO-Zeitbasis (startTimeSec) muss erhalten bleiben
        expect((runner as any).startTimeSec).toBe(initialStartTimeSec);
        expect((app as any).modRunnerState).toBe(true);

        // Aber: tatsächlicher runnable → non-runnable Wechsel stoppt den Runner noch
        device.modulation.slots.forEach((s) => { s.enabled = false; });
        (app as any).onDeviceChanged(); // geht durch onDeviceChanged → syncModulationRunner
        expect(stopSpy).toHaveBeenCalledTimes(1);
        expect((app as any).modRunnerState).toBe(false);

        // Und: non-runnable → runnable startet den Runner wieder
        device.modulation.slots[0].enabled = true;
        (app as any).onDeviceChanged();
        expect(startSpy).toHaveBeenCalledTimes(1);
        expect((app as any).modRunnerState).toBe(true);

        vi.restoreAllMocks();
    });

    it("Device-Wechsel: alter Runner wird hard-reset (ohne Snap-back), neuer startet sauber", () => {
        // Device A: runnable, runner läuft
        const { device: deviceA, ctrl: ctrlA } = makeDevice();
        deviceA.modulation.slots[0].enabled = true;
        deviceA.modulation.slots[0].destControlId = ctrlA.id;
        deviceA.modulation.slots[0].sourceId = deviceA.modulation.sources[0].id;
        const { app } = mount(deviceA);

        const runner = (app as any).modRunner;
        const startSpy = vi.spyOn(runner, "start");
        const stopSpy = vi.spyOn(runner, "stop");
        const resetSpy = vi.spyOn(runner, "resetForDeviceChange");

        // Runner is running on Device A
        expect((app as any).modRunnerState).toBe(true);
        const startTimeSecA = (runner as any).startTimeSec;

        // Create Device B (different ID, also runnable)
        const { device: deviceB, ctrl: ctrlB } = makeDevice();
        deviceB.name = "Device B"; // different name, will get different ID on load
        deviceB.modulation.slots[0].enabled = true;
        deviceB.modulation.slots[0].destControlId = ctrlB.id;
        deviceB.modulation.slots[0].sourceId = deviceB.modulation.sources[0].id;

        // Simulate device switch: load Device B into library
        // This simulates what DeviceLibrary.loadDevice does - new instance, different ID
        (app as any).deviceLibrary.currentDevice = deviceB;
        (app as any).deviceLibrary.saveCurrentDevice();

        // Call onDeviceChanged - should hard-reset old runner, then start new
        (app as any).onDeviceChanged();

        // resetForDeviceChange should have been called (hard reset without snap-back)
        expect(resetSpy).toHaveBeenCalledTimes(1);
        
        // Old runner's startTimeSec should be replaced (new timebase)
        expect((runner as any).startTimeSec).not.toBe(startTimeSecA);
        expect((runner as any).startTimeSec).toBeGreaterThan(startTimeSecA);
        
        // Runner should be running on new device
        expect((app as any).modRunnerState).toBe(true);
        
        // stop() should NOT have been called (resetForDeviceChange is used instead)
        expect(stopSpy).not.toHaveBeenCalled();
        
        // But start() should have been called for the new device
        expect(startSpy).toHaveBeenCalledTimes(1);

        vi.restoreAllMocks();
    });
});