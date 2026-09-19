import { describe, it, expect, beforeEach } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { cloneModulationMatrix } from "../../src/core/modulation/ModulationTypes";
import { DeviceHistory } from "../../src/core/history/DeviceHistory";
import { patchesEqual } from "../../src/core/history/HistoryAction";
import type { DeviceStatePatch } from "../../src/core/history/HistoryAction";
import { Storage } from "../../src/persistence/Storage";

// Minimal localStorage shim so Storage can persist between calls in Node
// (DeviceHistory.undo/redo persist transactionally via Storage.saveDevice).
class FakeStorage implements Storage {
    private store = new Map<string, string>();
    get length(): number { return this.store.size; }
    clear(): void { this.store.clear(); }
    getItem(key: string): string | null { return this.store.get(key) ?? null; }
    key(index: number): string | null { return Array.from(this.store.keys())[index] ?? null; }
    removeItem(key: string): void { this.store.delete(key); }
    setItem(key: string, value: string): void { this.store.set(key, value); }
}

beforeEach(() => {
    (globalThis as any).localStorage = new FakeStorage();
    Storage.resetCache();
});

/** §11 — Modulations-Snapshot in Presets: speichern, laden, serialisieren,
 *  Legacy-Kompatibilität, History. Die Matrix eines Presets wird als Deep Copy
 *  gehalten; ein Laden ersetzt die Device-Matrix des Ziels vollständig. */
describe("Preset modulation snapshot (§10/§11)", () => {
    function host(): Device {
        const d = new Device("Mod Snap Host");
        const a = new Control("knob", "A");
        a.value = 0.3;
        d.addControl(a);
        const slot = d.modulation.slots[0];
        slot.enabled = true;
        slot.sourceId = "mod1";
        slot.destControlId = a.id;
        slot.amount = 0.75;
        const src = d.modulation.sources[0];
        src.waveform = "saw";
        src.rateHz = 4.2;
        src.phase = 0.5;
        src.bpmSync = true;
        src.noteDivision = 8;
        return d;
    }

    it("savePreset snapshots the CURRENT matrix as a deep copy", () => {
        const d = host();
        d.modulation.slots[0].amount = 0.75;
        const p = d.savePreset("Snap");
        expect(p.modulation).toBeDefined();
        expect(p.modulation!.slots[0].amount).toBe(0.75);
        expect(p.modulation!.sources[0].waveform).toBe("saw");

        // Aliasing: mutating the DEVICE after save must not leak into the preset…
        d.modulation.slots[0].amount = 0.1;
        d.modulation.sources[0].waveform = "sine";
        expect(p.modulation!.slots[0].amount).toBe(0.75);
        expect(p.modulation!.sources[0].waveform).toBe("saw");
        // …und die gespeicherte Kopie beeinflusst die Device-Matrix nicht.
        p.modulation!.slots[0].amount = -1;
        expect(d.modulation.slots[0].amount).toBe(0.1);
    });

    it("loadPreset replaces the device matrix with the snapshot (whole swap)", () => {
        const d = host();
        const ctrl = Array.from(d.controls.values())[0];
        const p = d.savePreset("Snap");
        d.modulation.slots[0].amount = 0.1;
        d.modulation.sources[0].waveform = "sine";

        d.loadPreset(p.id);
        expect(ctrl.value).toBeCloseTo(0.3, 6);
        expect(d.modulation.slots[0].amount).toBe(0.75);
        expect(d.modulation.sources[0].waveform).toBe("saw");
        // Die ersetzte Matrix ist eine eigene Kopie, kein Alias auf das Preset.
        d.modulation.slots[0].amount = 0.99;
        expect(p.modulation!.slots[0].amount).toBe(0.75);
    });

    it("serialize -> deserialize keeps the matrix snapshot in the preset", () => {
        const d = host();
        const p = d.savePreset("Snap");
        const restored = Device.deserialize(d.serialize());
        const rp = restored.presets.get(p.id);
        expect(rp?.modulation).toBeDefined();
        expect(rp!.modulation!.slots[0].amount).toBe(0.75);
        expect(rp!.modulation!.sources[0].waveform).toBe("saw");

        // Und damit funktioniert der volle Zyklus: Restore-Datei → laden.
        const target = Device.deserialize(restored.serialize());
        target.modulation.slots[0].amount = -0.5;
        target.loadPreset(rp!.id);
        expect(target.modulation.slots[0].amount).toBe(0.75);
    });

    it("legacy presets (kein modulation-Schlüssel) lassen die Matrix unangetastet", () => {
        const d = host();
        const p = d.savePreset("New Style");
        const legacyData = p.serialize() as { modulation?: unknown };
        // Legacy-Payload: key genuinely absent (pre-snapshot era).
        delete legacyData.modulation;
        const restored = Device.deserialize({ ...d.serialize(), presets: [legacyData] });
        const legacyPreset = restored.presets.get(p.id);
        expect(legacyPreset?.modulation).toBeUndefined();

        // Vor dem Laden hat das Ziel eine eigene Matrix-Konfiguration.
        restored.modulation.slots[0].amount = 0.25;
        restored.loadPreset(p.id);
        expect(restored.modulation.slots[0].amount).toBe(0.25);
    });

    it("a structurally corrupt snapshot is sanitized, not fatal", () => {
        const p = (new Device("X")).savePreset("P");
        const restored = Device.deserialize({
            id: "dev1",
            name: "X",
            schemaVersion: 1,
            controls: [],
            groups: [],
            presets: [
                { ...p.serialize(), modulation: { sources: Array(50).fill({}), slots: [] } },
            ],
        } as never);
        const rp = restored.presets.get(p.id);
        // parseModulationMatrix wirft auf Caps; Preset.deserialize fängt ab →
        // Snapshot verworfen, Preset bleibt nutzbar.
        expect(rp?.modulation).toBeUndefined();
        expect(restored.loadPreset(rp!.id)).toBeUndefined();
    });

    it("history: preset.load undo/redo restores control values AND the matrix", () => {
        const d = host();
        const p = d.savePreset("Snap");
        d.modulation.slots[0].amount = 0.1;
        d.modulation.sources[0].waveform = "sine";

        const lib = { currentDevice: d, saveCurrentDevice: () => {} };
        const history = new DeviceHistory(lib as never);
        const before: DeviceStatePatch = history.captureDeviceState(d);
        d.loadPreset(p.id);
        const after: DeviceStatePatch = history.captureDeviceState(d);
        history.record({ type: "preset.load", scope: "device", deviceId: d.id, before, after });

        expect(history.canUndoOnCurrentDevice).toBe(true);
        history.undo();
        expect(d.modulation.slots[0].amount).toBe(0.1);
        expect(d.modulation.sources[0].waveform).toBe("sine");
        history.redo();
        expect(d.modulation.slots[0].amount).toBe(0.75);
        expect(d.modulation.sources[0].waveform).toBe("saw");
    });

    it("patchesEqual distinguishes preset matrices (equal state → no action)", () => {
        const d = host();
        d.savePreset("Snap"); // Snapshot erst anlegen, DANN vergleichen.
        const before = (() => { const h = new DeviceHistory({ currentDevice: d } as never); return h.captureDeviceState(d); })();
        const after = (() => { const h = new DeviceHistory({ currentDevice: d } as never); return h.captureDeviceState(d); })();
        // Matrix unverändert → beide Snapshots identisch (keine Flut an Actions).
        expect(patchesEqual(before, after)).toBe(true);

        d.modulation.slots[0].amount = 0.4;
        const changed = (() => { const h = new DeviceHistory({ currentDevice: d } as never); return h.captureDeviceState(d); })();
        expect(patchesEqual(before, changed)).toBe(false);

        // Modulations-Referenzkette im Patch bleibt ein Deep Copy: eine
        // Mutation am Patch schlägt NICHT auf das Live-Gerät durch.
        d.modulation.slots[0].amount = 0.4;
        const fresh = (() => { const h = new DeviceHistory({ currentDevice: d } as never); return h.captureDeviceState(d); })();
        changed.modulation.slots[0].amount = 0.9;
        expect(d.modulation.slots[0].amount).toBe(0.4);
        expect(patchesEqual(fresh, (() => { const h = new DeviceHistory({ currentDevice: d } as never); return h.captureDeviceState(d); })())).toBe(true);
        expect(patchesEqual(changed, fresh)).toBe(false);
    });
});