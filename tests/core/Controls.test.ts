import { describe, it, expect, beforeEach } from 'vitest';
import { Device } from '../../src/core/model/Device';
import { Control } from '../../src/core/model/Control';

describe('Control model — move, resize, archive (Phase A)', () => {
    let device: Device;

    beforeEach(() => {
        device = new Device('Test Device');
    });

    it('can move a Control', () => {
        const c = new Control('knob', 'Cutoff', { x: 0, y: 0 });
        device.addControl(c);
        c.position = { x: 42, y: 24 };
        expect(device.getControl(c.id)?.position).toEqual({ x: 42, y: 24 });
    });

    it('can resize a Control', () => {
        const c = new Control('switch', 'Bypass', { x: 0, y: 0 });
        device.addControl(c);
        c.size = { width: 90, height: 90 };
        expect(device.getControl(c.id)?.size).toEqual({ width: 90, height: 90 });
    });

    it('soft-delete (archive) removes control from active count but keeps the ID for presets (§44)', () => {
        const c = new Control('knob', 'Cutoff');
        device.addControl(c);
        expect(device.getActiveControlCount()).toBe(1);

        device.removeControl(c.id); // soft delete
        expect(c.archived).toBe(true);
        expect(device.getActiveControlCount()).toBe(0);
        expect(device.getControl(c.id)).toBeDefined();
    });

    it('hard-delete removes the control entirely', () => {
        const c = new Control('knob', 'Cutoff');
        device.addControl(c);
        device.removeControl(c.id, true);
        expect(device.getControl(c.id)).toBeUndefined();
        expect(device.getActiveControlCount()).toBe(0);
    });

    it('archived controls are skipped when saving presets', () => {
        const a = new Control('knob', 'A');
        const b = new Control('knob', 'B');
        a.value = 0.5;
        b.value = 0.9;
        device.addControl(a);
        device.addControl(b);

        device.removeControl(a.id); // archive A
        const preset = device.savePreset('P');

        expect(preset.controlValues[b.id]).toBe(0.9);
        expect(preset.controlValues[a.id]).toBeUndefined();
    });

    it('archived controls still receive nothing when loading presets, but reappear with defaults after un-archiving', () => {
        const a = new Control('knob', 'A');
        a.defaultValue = 0.25;
        a.value = 0.5;
        device.addControl(a);
        const preset = device.savePreset('P'); // captures A = 0.5

        device.removeControl(a.id); // archive
        a.value = 0.1;
        device.loadPreset(preset.id);
        expect(a.value).toBe(0.1); // preserved while archived

        // Recover the control; its stored value returns from the preset
        a.archived = false;
        device.loadPreset(preset.id);
        expect(a.value).toBe(0.5);
    });

    it('visual area color is stored in visualDefinition and survives serialization (§13)', () => {
        const c = new Control('knob', 'Cutoff');
        c.visualDefinition.color = '#ff8800';
        device.addControl(c);

        const restored = Device.deserialize(device.serialize());
        expect(restored.getControl(c.id)?.visualDefinition?.color).toBe('#ff8800');
    });
});