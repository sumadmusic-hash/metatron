import { describe, it, expect, beforeEach } from 'vitest';
import { Device } from '../../src/core/model/Device';
import { Control } from '../../src/core/model/Control';
import { Group } from '../../src/core/model/Group';

describe('Core Data Model Invariants', () => {
    let device: Device;

    beforeEach(() => {
        device = new Device('Test Device');
    });

    it('creates a new Device with no controls (AC01)', () => {
        expect(device.getActiveControlCount()).toBe(0);
        expect(device.controls.size).toBe(0);
    });

    it('can create Knobs and Switches (AC02)', () => {
        const knob = new Control('knob', 'Cutoff');
        const sw = new Control('switch', 'Bypass');
        
        device.addControl(knob);
        device.addControl(sw);
        
        expect(device.getActiveControlCount()).toBe(2);
        expect(device.getControl(knob.id)?.type).toBe('knob');
        expect(device.getControl(sw.id)?.type).toBe('switch');
    });

    it('enforces the 32-Control limit (AC03)', () => {
        // Add 32 controls
        for (let i = 0; i < 32; i++) {
            const added = device.addControl(new Control('knob', `Knob ${i}`));
            expect(added).toBe(true);
        }
        
        expect(device.getActiveControlCount()).toBe(32);
        
        // Try to add 33rd
        const added33 = device.addControl(new Control('knob', 'Overflow'));
        expect(added33).toBe(false);
        expect(device.getActiveControlCount()).toBe(32);
    });

    it('gives controls stable IDs (AC05) and allows renaming (AC04)', () => {
        const c = new Control('knob', 'Original Name');
        device.addControl(c);
        
        const id = c.id;
        expect(id).toBeDefined();
        
        c.name = 'New Name';
        expect(c.id).toBe(id); // ID shouldn't change
        expect(device.getControl(id)?.name).toBe('New Name');
    });

    it('supports Groups containing Controls (AC08, AC09, AC10)', () => {
        const group = new Group('Filter Section');
        group.color = '#ff0000';
        device.addGroup(group);
        
        const c1 = new Control('knob', 'Cutoff');
        c1.groupId = group.id;
        
        device.addControl(c1);
        
        expect(device.getGroup(group.id)?.name).toBe('Filter Section');
        expect(device.getGroup(group.id)?.color).toBe('#ff0000');
        expect(device.getControl(c1.id)?.groupId).toBe(group.id);
    });

    it('can serialize and deserialize the Device (AC11)', () => {
        const knob = new Control('knob', 'Test Knob');
        knob.defaultValue = 0.5;
        device.addControl(knob);
        
        const serialized = device.serialize();
        const deserialized = Device.deserialize(serialized);
        
        expect(deserialized.id).toBe(device.id);
        expect(deserialized.name).toBe(device.name);
        expect(deserialized.getActiveControlCount()).toBe(1);
        
        const loadedKnob = deserialized.getControl(knob.id);
        expect(loadedKnob).toBeDefined();
        expect(loadedKnob?.defaultValue).toBe(0.5);
        expect(loadedKnob?.value).toBe(0.5); // Deserialization sets value to defaultValue initially
    });

    it('supports multiple Presets and loading them (AC12, AC13)', () => {
        const knob = new Control('knob', 'Cutoff');
        device.addControl(knob);
        
        // State 1
        knob.value = 0.1;
        device.savePreset('Dark');
        
        // State 2
        knob.value = 0.9;
        const presetBright = device.savePreset('Bright');
        
        expect(device.presets.size).toBe(2);
        
        // Load State 1
        device.loadPreset(Array.from(device.presets.values())[0].id);
        expect(knob.value).toBe(0.1);
        
        // Load State 2
        device.loadPreset(presetBright.id);
        expect(knob.value).toBe(0.9);
    });

    it('renaming a Control does not break Presets (AC14)', () => {
        const knob = new Control('knob', 'Old Name');
        device.addControl(knob);
        
        knob.value = 0.5;
        const preset = device.savePreset('My Preset');
        
        knob.name = 'New Name';
        knob.value = 0.1;
        
        device.loadPreset(preset.id);
        expect(knob.value).toBe(0.5); // Successfully loaded value via ID
    });

    it('adding a Control does not invalidate existing Presets (AC15)', () => {
        const knob1 = new Control('knob', 'Knob 1');
        knob1.defaultValue = 0;
        device.addControl(knob1);
        
        knob1.value = 0.5;
        const preset = device.savePreset('Preset 1');
        
        // Later, user adds another control
        const knob2 = new Control('knob', 'Knob 2');
        knob2.defaultValue = 0.8;
        device.addControl(knob2);
        
        // Load the old preset
        device.loadPreset(preset.id);
        
        expect(knob1.value).toBe(0.5); // Old control gets saved value
        expect(knob2.value).toBe(0.8); // New control gets its default value
    });
});
