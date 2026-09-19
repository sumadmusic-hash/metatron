// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { BindingManager } from "../../src/core/BindingManager";
import { AppUI } from "../../src/ui/AppUI";
import { evaluateDestinations } from "../../src/core/modulation/ModulationEngine";
import type { AutomationRecorder } from "../../src/automation/AutomationRecording";
import type { ModulationRunner } from "../../src/modulation/ModulationRunner";

/**
 * §13 — REC/Automation-Integration auf AppUI-Ebene (Reflection auf die
 * privaten Runner/Recorder, wie in den bestehenden AppUI-Harness-Tests):
 *
 *  1. Eine AKTIVE Route startet den Runner beim render() (syncModulationRunner)
 *     und der Runner-Write trägt in RECORDING den MODULIERTEN Wert in die
 *     Automation ein (Capture-Arbitration / FIX 2) — NICHT den Basiswert.
 *  2. Ein lokaler Zugriff (applyValueToDevice) auf ein moduliertes Ziel wird
 *     NICHT doppelt aufgezeichnet (isModulated-Guard).
 *  3. Wird die letzte Route per Matrix-UI deaktiviert, stoppt der Runner
 *     (LFO-Phase reset reserviert für echte Start/Stop-Änderungen) und es
 *     kommt keine weitere Aufnahme dazu.
 */

class CapturingMidi extends MidiAccess {
    public installedHandler: ((channel: number, cc: number, value: number) => void) | null = null;
    public override setMessageHandler(callback: (channel: number, cc: number, value: number) => void) {
        this.installedHandler = callback;
    }
    public trigger(channel: number, cc: number, value: number) {
        this.installedHandler?.(channel, cc, value);
    }
}

class CapturingAdapter extends NexusAdapter {
    public writes: Array<{ controlId: string; value: number }> = [];
    public override updateBoundControl(controlId: string, value: number): Promise<boolean> {
        this.writes.push({ controlId, value });
        return Promise.resolve(true);
    }
}

interface Mounted {
    device: Device;
    lib: DeviceLibrary;
    app: AppUI;
    adapter: CapturingAdapter;
    root: HTMLElement;
    bm: BindingManager;
}

function mount(device: Device): Mounted {
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    lib.saveCurrentDevice();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const bm = new BindingManager(device);
    for (const ctrl of device.controls.values()) {
        bm.setBinding(ctrl.id, "p1", "f1");
    }
    const midi = new CapturingMidi();
    const adapter = new CapturingAdapter();
    const app = new AppUI(root, lib, adapter, midi, bm);
    app.render();
    return { device, lib, app, adapter, root, bm };
}

function modulatedDestination(
    matrixConfig: Device["modulation"],
    base: number,
    tSec: number,
    macroValue: (id: string) => number = () => 0,
): number | undefined {
    return evaluateDestinations(matrixConfig, { cutoff: base }, tSec, 125, macroValue, (id) => !!id).get("cutoff");
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

describe("§13 — REC: der Runner trägt den modulierten Wert ein, ohne Doppel-Aufnahme", () => {
    it("aktive Route + RECORDING: Runner startet, Write + Capture tragen den MODULIERTEN Wert", () => {
        const device = new Device("Rec");
        const ctrl = new Control("knob", "Cutoff", { x: 0, y: 0 }, "cutoff");
        ctrl.value = 0.5;
        device.addControl(ctrl);
        const s = device.modulation.slots[0];
        s.enabled = true;
        s.sourceId = "mod1";
        s.destControlId = "cutoff";
        s.amount = 0.5;
        device.modulation.sources[0].waveform = "sine";
        device.modulation.sources[0].rateHz = 1;

        const { app, adapter } = mount(device);
        const runner = (app as unknown as { modRunner: ModulationRunner }).modRunner;
        const recorder = (app as unknown as { recorder: AutomationRecorder }).recorder;
        const runnerAny = runner as unknown as { rafId: number | null; tick: (now: number) => void; startTimeSec: number };

        // render() hat den Runner wegen der aktiven Route gestartet.
        expect(runnerAny.rafId).not.toBeNull();

        // Determinismus: rAF-Loop stoppen, Timeline manuell fahren.
        runner.stop();
        recorder.arm();
        recorder.record();

        runnerAny.startTimeSec = 0;
        runnerAny.tick(300);

        // Modulierter Wert lt. Engine (Basis 0.5 + Amt 0.5 * sin(0.3·2π)).
        const expected = modulatedDestination(device.modulation, 0.5, 0.3)!;
        expect(expected).not.toBeCloseTo(0.5, 6);

        // Der Runner-Write ging an Nexus — mit dem modulierten Wert, nicht dem Basiswert.
        const write = adapter.writes.find((w) => w.controlId === "cutoff");
        expect(write).toBeDefined();
        expect(write!.value).toBeCloseTo(expected, 5);

        // Capture-Arbitration (FIX 2): die Automation trägt den MODULIERTEN Wert.
        const track = recorder.recording.tracks.find((t) => t.controlId === "cutoff");
        expect(track).toBeDefined();
        expect(track!.samples.length).toBeGreaterThan(0);
        expect(track!.samples[0].normalizedValue).toBeCloseTo(expected, 5);
        expect(track!.samples[0].normalizedValue).not.toBeCloseTo(0.5, 6);
    });

    it("kein Doppel-Capture: lokaler Zugriff auf ein MODULIERTES Ziel erzeugt KEINE Automation", () => {
        const device = new Device("Rec2");
        const ctrl = new Control("knob", "Cutoff", { x: 0, y: 0 }, "cutoff");
        ctrl.value = 0.5;
        device.addControl(ctrl);
        const s = device.modulation.slots[0];
        s.enabled = true;
        s.sourceId = "mod1";
        s.destControlId = "cutoff";
        s.amount = 0.5;
        device.modulation.sources[0].rateHz = 1;

        const { app } = mount(device);
        const runner = (app as unknown as { modRunner: ModulationRunner }).modRunner;
        const recorder = (app as unknown as { recorder: AutomationRecorder }).recorder;
        const runnerAny = runner as unknown as { rafId: number | null; tick: (now: number) => void; startTimeSec: number };

        runner.stop();
        recorder.arm();
        recorder.record();
        runnerAny.startTimeSec = 0;
        runnerAny.tick(300);
        expect(runner.isModulated("cutoff")).toBe(true);
        const track = recorder.recording.tracks.find((t) => t.controlId === "cutoff");
        const sampleCount = track?.samples.length ?? 0;

        // Lokaler Move auf das modulierte Ziel: Wert ändert sich lokal, die
        // Automation bekommt KEINEN zusätzlichen Sample (Guard in
        // applyValueToDevice: modulated → nur der Runner captured).
        (app as unknown as { applyValueToDevice: (id: string, v: number) => void }).applyValueToDevice("cutoff", 0.9);
        const track2 = recorder.recording.tracks.find((t) => t.controlId === "cutoff");
        expect(track2?.samples.length ?? 0).toBe(sampleCount);
        expect(track2?.samples.every((x) => Math.abs(x.normalizedValue - 0.9) > 1e-6)).toBe(true);
        expect(ctrl.value).toBeCloseTo(0.9, 6);
    });

    it("letzte Route per Matrix-UI deaktiviert → Runner stoppt, kein weiteres Capture", () => {
        const device = new Device("Rec3");
        const ctrl = new Control("knob", "Cutoff", { x: 0, y: 0 }, "cutoff");
        ctrl.value = 0.5;
        device.addControl(ctrl);
        const s = device.modulation.slots[0];
        s.enabled = true;
        s.sourceId = "mod1";
        s.destControlId = "cutoff";
        s.amount = 0.5;
        device.modulation.sources[0].rateHz = 1;

        const { app, root } = mount(device);
        const runner = (app as unknown as { modRunner: ModulationRunner }).modRunner;
        const recorder = (app as unknown as { recorder: AutomationRecorder }).recorder;
        const runnerAny = runner as unknown as { rafId: number | null; tick: (now: number) => void; startTimeSec: number };
        expect(runnerAny.rafId).not.toBeNull();

        // EDIT-Mode rendert KEINE Surface (die Mod-Wash-Aktualisierung
        // refreshModulationStates bräuchte deren Container). In USE wechseln —
        // genau so ist Matrix-Bedienung in der App möglich; der Drawer bleibt
        // dabei offen (nur EDIT-Übergang schließt ihn).
        root.querySelector<HTMLButtonElement>("#mode-toggle-btn")!.click();
        expect(runnerAny.rafId).not.toBeNull();

        recorder.arm();
        recorder.record();
        const captureSpy = vi.spyOn(recorder, "capture");
        runner.stop();
        runnerAny.startTimeSec = 0;
        runnerAny.tick(300);
        expect(captureSpy).toHaveBeenCalledTimes(1);

        // Über die RICHTIGE UI (Checkbox) deaktivieren — nicht direkt am Objekt.
        const chk = root.querySelector<HTMLInputElement>("#mod-slot-enable-slot1")!;
        chk.checked = false;
        chk.dispatchEvent(new Event("change", { bubbles: true }));

        // syncModulationRunner erkennt die Zustandsänderung → Stopp.
        expect(runnerAny.rafId).toBeNull();
        expect(runner.isModulated("cutoff")).toBe(false);

        // Weitere Ticks liefern NICHTS mehr nach.
        captureSpy.mockClear();
        runnerAny.tick(500);
        runnerAny.tick(800);
        expect(captureSpy).not.toHaveBeenCalled();
    });
});