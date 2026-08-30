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