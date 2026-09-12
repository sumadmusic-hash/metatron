import { describe, it, expect, beforeEach } from 'vitest';
import { Device } from '../../src/core/model/Device';
import { Control } from '../../src/core/model/Control';
import { BindingManager } from '../../src/core/BindingManager';

function makeResult(overrides: Partial<any> = {}) {
    return {
        entityId: 'entity-1',
        entityType: 'stompbox',
        fieldName: 'feedbackFactor',
        value: 0.42,
        targetName: 'stompbox / feedbackFactor',
        field: { location: 'L1' },
        ...overrides
    };
}

describe('BindingManager — live field bindings (Phase C/D pipeline)', () => {
    let device: Device;
    let manager: BindingManager;

    beforeEach(() => {
        device = new Device('Test');
        manager = new BindingManager(device);
    });

    it('stores the live Nexus field with the binding (not just entityId/fieldName)', () => {
        const c = new Control('knob', 'Cutoff');
        device.addControl(c);

        manager.applyLearnResult(c.id, makeResult());
        const binding = manager.getActiveBinding(c.id);
        expect(binding).toEqual({ entityId: 'entity-1', fieldName: 'feedbackFactor', fieldPath: 'feedbackFactor', field: { location: 'L1' } });
        expect(c.activeBindingState).toBe('CONNECTED');
        expect(c.audiotoolBindingDefinition?.targetName).toBe('stompbox / feedbackFactor');
    });

    it('clearBinding detaches the binding and resets the control state', () => {
        const c = new Control('knob', 'Cutoff');
        device.addControl(c);
        manager.applyLearnResult(c.id, makeResult());
        manager.clearBinding(c.id);
        expect(manager.getActiveBinding(c.id)).toBeUndefined();
        expect(c.activeBindingState).toBe('UNCONFIGURED');
        expect(c.audiotoolBindingDefinition).toBeUndefined();
    });

    it('re-pointing at another device drops all active bindings (device switch)', () => {
        const c = new Control('knob', 'Cutoff');
        device.addControl(c);
        manager.applyLearnResult(c.id, makeResult());

        const other = new Device('Other');
        other.addControl(new Control('switch', 'Bypass'));
        manager.setDevice(other);
        expect(manager.getActiveBinding(c.id)).toBeUndefined();
    });

    it('setDevice with the SAME instance preserves the active binding (M22.1)', () => {
        const c = new Control('knob', 'Cutoff');
        device.addControl(c);
        manager.applyLearnResult(c.id, makeResult());
        const before = manager.getActiveBinding(c.id);
        expect(before).toBeDefined();

        manager.setDevice(device);

        expect(manager.getActiveBinding(c.id)).toBe(before);
        expect(c.activeBindingState).toBe('CONNECTED');
    });

    it('setDevice with a DIFFERENT instance clears active bindings and re-points the device', () => {
        const c = new Control('knob', 'Cutoff');
        device.addControl(c);
        manager.applyLearnResult(c.id, makeResult());

        const other = new Device('Other');
        other.addControl(new Control('switch', 'Bypass'));
        manager.setDevice(other);

        expect(manager.deviceRef).toBe(other);
        expect(manager.getActiveBinding(c.id)).toBeUndefined();
    });

    it('learn-created binding survives a same-instance refresh and is cleared on a real switch', () => {
        const c = new Control('knob', 'Cutoff');
        device.addControl(c);
        manager.applyLearnResult(c.id, makeResult());
        const learnResult = manager.getActiveBinding(c.id);
        expect(c.activeBindingState).toBe('CONNECTED');

        manager.setDevice(device);
        expect(manager.getActiveBinding(c.id)).toBe(learnResult);
        expect(c.activeBindingState).toBe('CONNECTED');

        const other = new Device('Other');
        manager.setDevice(other);
        expect(manager.getActiveBinding(c.id)).toBeUndefined();
    });

    it('a loaded preset (mutates only control.value) never invalidates the binding, even after same-device refresh', () => {
        const c = new Control('knob', 'Cutoff');
        device.addControl(c);
        manager.applyLearnResult(c.id, makeResult());
        const original = manager.getActiveBinding(c.id);

        c.value = 0.33;
        const preset = device.savePreset('Snapshot');
        c.value = 0.99;
        device.loadPreset(preset.id);
        expect(c.value).toBe(0.33);

        // Full preset-load UI sequence ends with onDeviceChanged → setDevice(same).
        manager.setDevice(device);
        expect(manager.getActiveBinding(c.id)).toBe(original);
        expect(manager.getActiveBinding(c.id)).toEqual({
            entityId: 'entity-1',
            fieldName: 'feedbackFactor',
            fieldPath: 'feedbackFactor',
            field: { location: 'L1' }
        });
    });

    it('onProjectLoaded marks configured controls DISCONNECTED, others UNCONFIGURED (§39)', () => {
        const bound = new Control('knob', 'Bound');
        const free = new Control('knob', 'Free');
        device.addControl(bound);
        device.addControl(free);

        manager.applyLearnResult(bound.id, makeResult());
        manager.onProjectLoaded();

        expect(bound.activeBindingState).toBe('DISCONNECTED');
        expect(free.activeBindingState).toBe('UNCONFIGURED');
        expect(manager.getActiveBinding(bound.id)).toBeUndefined();
    });
});