import { describe, it, expect, beforeEach } from 'vitest';
import { Device } from '../../src/core/model/Device';
import { Control } from '../../src/core/model/Control';
import { Group } from '../../src/core/model/Group';

describe('Group model (Phase A)', () => {
    let device: Device;

    beforeEach(() => {
        device = new Device('Test Device');
    });

    it('creates a Group with a stable ID, name and default color', () => {
        const group = new Group('Filter', { x: 10, y: 20 }, { width: 200, height: 150 });
        device.addGroup(group);

        const id = group.id;
        expect(id).toMatch(/^grp_/);
        expect(device.getGroup(id)?.id).toBe(id);
        expect(device.getGroup(id)?.name).toBe('Filter');
        expect(device.getGroup(id)?.color).toBe('#333333');
        expect(device.getGroup(id)?.position).toEqual({ x: 10, y: 20 });
    });

    it('renames a Group and changes its color', () => {
        const group = new Group('Old Name');
        device.addGroup(group);

        group.name = 'New Name';
        group.color = '#ff0000';

        expect(device.getGroup(group.id)?.name).toBe('New Name');
        expect(device.getGroup(group.id)?.color).toBe('#ff0000');
        expect(device.getGroup(group.id)?.id).toBe(group.id); // stable ID
    });

    it('assigns a Control to a Group (I4: zero or one group)', () => {
        const group = new Group('Filter');
        device.addGroup(group);
        const knob = new Control('knob', 'Cutoff');
        device.addControl(knob);

        expect(device.setControlGroup(knob.id, group.id)).toBe(true);
        expect(device.getControl(knob.id)?.groupId).toBe(group.id);
        expect(device.getGroupControls(group.id).map((c) => c.id)).toContain(knob.id);

        // Moving control to another group replaces the old membership
        const group2 = new Group('Drive');
        device.addGroup(group2);
        expect(device.setControlGroup(knob.id, group2.id)).toBe(true);
        expect(device.getControl(knob.id)?.groupId).toBe(group2.id);
        expect(device.getGroupControls(group.id)).toHaveLength(0);
        expect(device.getGroupControls(group2.id)).toHaveLength(1);
    });

    it('rejects assigning to a non-existent group', () => {
        const knob = new Control('knob', 'Cutoff');
        device.addControl(knob);
        expect(device.setControlGroup(knob.id, 'grp_missing')).toBe(false);
        expect(device.getControl(knob.id)?.groupId).toBeUndefined();

        // Removing membership (undefined) works
        const group = new Group('G');
        device.addGroup(group);
        device.setControlGroup(knob.id, group.id);
        expect(device.setControlGroup(knob.id, undefined)).toBe(true);
        expect(device.getControl(knob.id)?.groupId).toBeUndefined();
    });

    it('moving a Group moves its member Controls and preserves relative positions (§17)', () => {
        const group = new Group('Filter', { x: 50, y: 50 }, { width: 200, height: 150 });
        device.addGroup(group);

        const cutoff = new Control('knob', 'Cutoff', { x: 60, y: 70 });
        const resonance = new Control('knob', 'Resonance', { x: 130, y: 70 });
        device.addControl(cutoff);
        device.addControl(resonance);
        device.setControlGroup(cutoff.id, group.id);
        device.setControlGroup(resonance.id, group.id);

        const relA = { x: cutoff.position.x - group.position.x, y: cutoff.position.y - group.position.y };
        const relB = { x: resonance.position.x - group.position.x, y: resonance.position.y - group.position.y };

        device.moveGroup(group.id, 25, 40);

        expect(group.position).toEqual({ x: 75, y: 90 });
        expect(cutoff.position.x - group.position.x).toBe(relA.x);
        expect(cutoff.position.y - group.position.y).toBe(relA.y);
        expect(resonance.position.x - group.position.x).toBe(relB.x);
        expect(resonance.position.y - group.position.y).toBe(relB.y);

        // Movement never goes negative
        device.moveGroup(group.id, -9999, -9999);
        expect(group.position.x).toBe(0);
        expect(group.position.y).toBe(0);
        expect(cutoff.position.x).toBe(0);
        expect(cutoff.position.y).toBe(0);
    });

    it('moving a group leaves orphaned controls in place', () => {
        const group = new Group('G', { x: 10, y: 10 });
        device.addGroup(group);
        const member = new Control('knob', 'Member', { x: 20, y: 20 });
        const orphan = new Control('knob', 'Orphan', { x: 90, y: 90 });
        device.addControl(member);
        device.addControl(orphan);
        device.setControlGroup(member.id, group.id);

        device.moveGroup(group.id, 5, 5);

        expect(member.position).toEqual({ x: 25, y: 25 });
        expect(orphan.position).toEqual({ x: 90, y: 90 });
    });

    it('resizes a Group', () => {
        const group = new Group('G', { x: 0, y: 0 }, { width: 100, height: 100 });
        device.addGroup(group);
        device.resizeGroup(group.id, 300, 120);
        expect(group.size).toEqual({ width: 300, height: 120 });
    });

    it('removing a group orphans its controls (I4)', () => {
        const group = new Group('G');
        device.addGroup(group);
        const knob = new Control('knob', 'K', { x: 5, y: 5 });
        device.addControl(knob);
        device.setControlGroup(knob.id, group.id);

        device.removeGroup(group.id);
        expect(device.getGroup(group.id)).toBeUndefined();
        expect(knob.groupId).toBeUndefined();
    });

    it('group survives device serialization round-trip', () => {
        const group = new Group('Filter', { x: 10, y: 10 }, { width: 200, height: 150 });
        group.color = '#00ff00';
        device.addGroup(group);
        const knob = new Control('knob', 'Cutoff', { x: 30, y: 40 });
        device.addControl(knob);
        device.setControlGroup(knob.id, group.id);

        const restored = Device.deserialize(device.serialize());
        expect(restored.getGroup(group.id)?.name).toBe('Filter');
        expect(restored.getGroup(group.id)?.color).toBe('#00ff00');
        expect(restored.getGroupControls(group.id).map((c) => c.id)).toEqual([knob.id]);
    });
});