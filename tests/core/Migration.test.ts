import { describe, it, expect } from 'vitest';
import {
    computeControlLayout,
    defaultControlSize,
    DEFAULT_CONTROL_SIZE,
    CURRENT_LAYOUT_VERSION,
    LEGACY_MAX_SIZE_BEFORE_MIGRATION,
    controlNeedsLegacyMigration,
    GROUP_PADDING,
    migratedGroupRect,
    groupMemberBounds,
    rectContainsRect,
    inflatedRect,
    unionRect,
} from '../../src/ui/geometry';
import { Control } from '../../src/core/model/Control';
import { Device } from '../../src/core/model/Device';
import { Group } from '../../src/core/model/Group';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Simulate the shape of data as it would be stored in localStorage before
 *  the geometry repair — no layoutVersion field, old 60×60 default size. */
function legacyControlData(overrides: Record<string, any> = {}): any {
    return {
        id: "ctl_legacy1",
        type: "knob",
        name: "Cutoff",
        position: { x: 80, y: 100 },
        size: { width: 60, height: 60 },
        groupId: undefined,
        defaultValue: 0,
        visualDefinition: { color: "#ff8800" },
        audiotoolBindingDefinition: { targetName: "Filter.Cutoff" },
        midiBindingDefinition: { channel: 0, cc: 14 },
        archived: false,
        ...overrides,
    };
}

/** A Control that was already migrated in a previous pass. */
function migratedControlData(overrides: Record<string, any> = {}): any {
    return {
        ...legacyControlData({ size: { width: 120, height: 120 } }),
        layoutVersion: CURRENT_LAYOUT_VERSION,
        ...overrides,
    };
}

/** A Control intentionally resized to a small size under the current layout. */
function intentionallySmallControlData(): any {
    return {
        ...legacyControlData({ size: { width: 50, height: 50 } }),
        layoutVersion: CURRENT_LAYOUT_VERSION,
    };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Legacy layout migration', () => {

    // ─── 1. Legacy Control migration ────────────────────────────────────────

    it('migrates a legacy 60×60 Control to 120×120', () => {
        const c = Control.deserialize(legacyControlData());
        expect(c.size).toEqual({ width: 120, height: 120 });
    });

    it('migrates a legacy switch to 120×120', () => {
        const c = Control.deserialize(legacyControlData({ type: "switch", size: { width: 40, height: 40 } }));
        expect(c.size).toEqual({ width: 120, height: 120 });
    });

    // ─── 2. Migration is idempotent ─────────────────────────────────────────

    it('is idempotent: deserialize twice produces the same result', () => {
        const first = Control.deserialize(legacyControlData());
        const second = Control.deserialize(first.serialize());
        expect(second.size).toEqual({ width: 120, height: 120 });
        expect(second.layoutVersion).toBe(CURRENT_LAYOUT_VERSION);
    });

    it('does not re-migrate an already migrated Control', () => {
        const data = migratedControlData({ size: { width: 120, height: 120 } });
        const c = Control.deserialize(data);
        expect(c.size).toEqual({ width: 120, height: 120 });
        expect(c.layoutVersion).toBe(CURRENT_LAYOUT_VERSION);
    });

    // ─── 3. Stable Control ID survives migration ────────────────────────────

    it('preserves the Control ID through migration', () => {
        const data = legacyControlData({ id: "ctl_abc12345" });
        const c = Control.deserialize(data);
        expect(c.id).toBe("ctl_abc12345");
    });

    // ─── 4. Name survives migration ─────────────────────────────────────────

    it('preserves the Control name through migration', () => {
        const c = Control.deserialize(legacyControlData({ name: "Resonance" }));
        expect(c.name).toBe("Resonance");
    });

    // ─── 5. Group membership survives migration ─────────────────────────────

    it('preserves group membership through migration', () => {
        const c = Control.deserialize(legacyControlData({ groupId: "grp_filter" }));
        expect(c.groupId).toBe("grp_filter");
    });

    // ─── 6. Binding survives migration ──────────────────────────────────────

    it('preserves Audiotool binding through migration', () => {
        const c = Control.deserialize(legacyControlData());
        expect(c.audiotoolBindingDefinition?.targetName).toBe("Filter.Cutoff");
    });

    it('preserves MIDI binding through migration', () => {
        const c = Control.deserialize(legacyControlData());
        expect(c.midiBindingDefinition).toEqual({ channel: 0, cc: 14 });
    });

    // ─── 7. Preset references survive migration ─────────────────────────────

    it('preserves preset values when loaded after migration', () => {
        const device = new Device("Test");
        const c = Control.deserialize(legacyControlData({ id: "ctl_x" }));
        device.addControl(c);
        const preset = device.savePreset("Before Migration");
        expect(preset.controlValues["ctl_x"]).toBe(0);

        // Simulate: reload from serialized device
        const serialized = device.serialize();
        const restored = Device.deserialize(serialized);
        const rc = restored.getControl("ctl_x");
        expect(rc).toBeDefined();
        expect(rc!.size).toEqual({ width: 120, height: 120 });
        restored.loadPreset(preset.id);
        expect(rc!.value).toBe(0);
    });

    // ─── 8. Intentionally resized current Controls are NOT overwritten ──────

    it('does NOT migrate a small Control that already has a current layoutVersion', () => {
        const c = Control.deserialize(intentionallySmallControlData());
        expect(c.size).toEqual({ width: 50, height: 50 });
        expect(c.layoutVersion).toBe(CURRENT_LAYOUT_VERSION);
    });

    it('does NOT migrate a large legacy-looking Control without layoutVersion', () => {
        // A Control at 200×200 with no layoutVersion — clearly not a 60×60 default
        const c = Control.deserialize(legacyControlData({ size: { width: 200, height: 200 } }));
        expect(c.size).toEqual({ width: 200, height: 200 });
        // No layoutVersion was set (it was not migrated)
        expect(c.layoutVersion).toBeUndefined();
    });

    it('migrates only Controls ≤80px on both axes when layoutVersion is missing', () => {
        // Exactly at the boundary
        const atBoundary = Control.deserialize(
            legacyControlData({ size: { width: LEGACY_MAX_SIZE_BEFORE_MIGRATION, height: LEGACY_MAX_SIZE_BEFORE_MIGRATION } })
        );
        expect(atBoundary.size).toEqual({ width: 120, height: 120 });

        // One pixel over → not migrated
        const overBoundary = Control.deserialize(
            legacyControlData({ size: { width: LEGACY_MAX_SIZE_BEFORE_MIGRATION + 1, height: LEGACY_MAX_SIZE_BEFORE_MIGRATION } })
        );
        expect(overBoundary.size).toEqual({ width: LEGACY_MAX_SIZE_BEFORE_MIGRATION + 1, height: LEGACY_MAX_SIZE_BEFORE_MIGRATION });
    });

    // ─── 9. New Controls use current default geometry ───────────────────────

    it('new Controls created via constructor use 120×120 default', () => {
        const c = new Control("knob", "Knob");
        expect(c.size).toEqual({ width: 120, height: 120 });
        expect(c.layoutVersion).toBe(CURRENT_LAYOUT_VERSION);
    });

    it('deserialized new Controls have layoutVersion CURRENT', () => {
        const c = new Control("switch", "Switch");
        const data = c.serialize() as any;
        const restored = Control.deserialize(data);
        expect(restored.layoutVersion).toBe(CURRENT_LAYOUT_VERSION);
        expect(restored.size).toEqual({ width: 120, height: 120 });
    });

    // ─── 10. Knob remains square/circular after migration ───────────────────

    it('knob is square after migration from 60×60 to 120×120', () => {
        const c = Control.deserialize(legacyControlData());
        const layout = computeControlLayout(c.size, c.type);
        expect(layout.widgetWidth).toBe(layout.widgetHeight);
        expect(layout.widgetWidth).toBeGreaterThan(24);
    });

    it('knob is square for migrated switch layout too', () => {
        const c = Control.deserialize(legacyControlData({ type: "switch" }));
        const layout = computeControlLayout(c.size, c.type);
        // switch rail is rectangular but toggle stays round
        expect(layout.widgetWidth).toBeGreaterThan(0);
        expect(layout.widgetHeight).toBeGreaterThan(0);
    });
});

describe('controlNeedsLegacyMigration — detection logic', () => {

    it('detects legacy Control (no layoutVersion, small size)', () => {
        expect(controlNeedsLegacyMigration({ size: { width: 60, height: 60 } })).toBe(true);
    });

    it('rejects Control with current layoutVersion', () => {
        expect(controlNeedsLegacyMigration({ size: { width: 60, height: 60 }, layoutVersion: CURRENT_LAYOUT_VERSION })).toBe(false);
    });

    it('rejects Control that is too large to be legacy', () => {
        expect(controlNeedsLegacyMigration({ size: { width: 200, height: 200 } })).toBe(false);
    });

    it('rejects Control that is only large on one axis', () => {
        expect(controlNeedsLegacyMigration({ size: { width: 60, height: 200 } })).toBe(false);
    });

    it('rejects Control with missing size', () => {
        expect(controlNeedsLegacyMigration({})).toBe(false);
    });

    it('detects legacy Control with layoutVersion: 1 (older than current)', () => {
        expect(controlNeedsLegacyMigration({ size: { width: 60, height: 60 }, layoutVersion: 1 })).toBe(true);
    });

    it('rejects Control with layoutVersion: CURRENT_LAYOUT_VERSION + 1', () => {
        expect(controlNeedsLegacyMigration({ size: { width: 60, height: 60 }, layoutVersion: CURRENT_LAYOUT_VERSION + 1 })).toBe(false);
    });
});

describe('Device-level migration — backward compatibility', () => {

    it('Device.deserialize migrates all legacy Controls', () => {
        const device = new Device("Test");
        // Add legacy-sized controls
        const c1 = Control.deserialize(legacyControlData({ id: "ctl_a" }));
        const c2 = Control.deserialize(legacyControlData({ id: "ctl_b", type: "switch", size: { width: 40, height: 40 } }));
        device.addControl(c1);
        device.addControl(c2);

        // Serialize and re-deserialize — migration happens in Control.deserialize
        const data = device.serialize();
        const restored = Device.deserialize(data);

        expect(restored.getControl("ctl_a")?.size).toEqual({ width: 120, height: 120 });
        expect(restored.getControl("ctl_b")?.size).toEqual({ width: 120, height: 120 });
    });

    it('preserves Groups and Presets through Device round-trip with migration', () => {
        const device = new Device("Synth");
        const c = Control.deserialize(legacyControlData({ id: "ctl_migrate" }));
        device.addControl(c);

        const group = new Group("Filter", { x: 10, y: 10 }, { width: 200, height: 200 });
        device.addGroup(group);
        device.setControlGroup("ctl_migrate", group.id);

        device.addPreset(device.savePreset("Preset1"));

        const data = device.serialize();
        const restored = Device.deserialize(data);

        // Control migrated
        expect(restored.getControl("ctl_migrate")?.size).toEqual({ width: 120, height: 120 });
        // Group preserved
        expect(restored.groups.size).toBe(1);
        expect(restored.getGroup(group.id)?.name).toBe("Filter");
        // Membership preserved
        expect(restored.getControl("ctl_migrate")?.groupId).toBe(group.id);
        // Preset preserved
        expect(restored.presets.size).toBe(1);
    });
});

// ── Legacy Group migration ───────────────────────────────────────────────────

/** A Device exactly as it would be stored before the geometry repair:
 *  legacy Controls AND a legacy Group sized for the old 60×60 Controls. */
function legacyGroupDeviceData(): any {
    return {
        id: "dev_legacy",
        name: "Legacy Device",
        schemaVersion: 1,
        controls: [
            {
                id: "ctl_1", type: "knob", name: "Cutoff",
                position: { x: 100, y: 120 }, size: { width: 60, height: 60 },
                groupId: "grp_test", defaultValue: 0,
                visualDefinition: { color: "#ff8800" },
                audiotoolBindingDefinition: { targetName: "Filter.Cutoff" },
                midiBindingDefinition: { channel: 0, cc: 14 },
                archived: false,
            },
            {
                id: "ctl_2", type: "switch", name: "Bypass",
                position: { x: 220, y: 120 }, size: { width: 40, height: 40 },
                groupId: "grp_test", defaultValue: 0,
                visualDefinition: {},
                archived: false,
            },
        ],
        groups: [
            {
                id: "grp_test", name: "Test", color: "#ff8800",
                position: { x: 80, y: 100 }, size: { width: 200, height: 100 },
            },
        ],
        presets: [
            { id: "prs_1", name: "P1", deviceId: "dev_legacy", controlValues: { ctl_1: 0.5 } },
        ],
    };
}

function groupRect(g: { position: { x: number; y: number }; size: { width: number; height: number } }) {
    return { x: g.position.x, y: g.position.y, width: g.size.width, height: g.size.height };
}

describe('Legacy Group migration', () => {

    // 1. Legacy Controls migrate to current geometry (within the same pass)
    it('migrates legacy Controls inside a Group', () => {
        const d = Device.deserialize(legacyGroupDeviceData());
        expect(d.getControl("ctl_1")?.size).toEqual({ width: 120, height: 120 });
        expect(d.getControl("ctl_2")?.size).toEqual({ width: 120, height: 120 });
    });

    // 2. Group containing migrated Controls expands when necessary
    it('expands a Group whose bounds are too small for its migrated Controls', () => {
        const d = Device.deserialize(legacyGroupDeviceData());
        const g = d.getGroup("grp_test")!;
        // 200×100 was sized for 60×60 Controls; must now fit 120×120 Controls.
        expect(g.size.height).toBeGreaterThan(100);
        expect(g.size.width).toBeGreaterThan(200);
    });

    // 3. All member Controls are inside Group bounds after migration
    it('contains all member Controls after migration', () => {
        const d = Device.deserialize(legacyGroupDeviceData());
        const g = d.getGroup("grp_test")!;
        const gRect = groupRect(g);
        expect(rectContainsRect(gRect, { x: 100, y: 120, width: 120, height: 120 })).toBe(true);
        expect(rectContainsRect(gRect, { x: 220, y: 120, width: 120, height: 120 })).toBe(true);
    });

    // 4. Control positions remain unchanged
    it('does not move member Controls during Group expansion', () => {
        const d = Device.deserialize(legacyGroupDeviceData());
        expect(d.getControl("ctl_1")?.position).toEqual({ x: 100, y: 120 });
        expect(d.getControl("ctl_2")?.position).toEqual({ x: 220, y: 120 });
    });

    // 5. Group ID remains unchanged
    it('preserves the Group ID', () => {
        const d = Device.deserialize(legacyGroupDeviceData());
        expect(d.getGroup("grp_test")).toBeDefined();
        expect(d.groups.size).toBe(1);
    });

    // 6. Group membership remains unchanged
    it('preserves Group membership', () => {
        const d = Device.deserialize(legacyGroupDeviceData());
        expect(d.getControl("ctl_1")?.groupId).toBe("grp_test");
        expect(d.getControl("ctl_2")?.groupId).toBe("grp_test");
    });

    // 7. Group color remains unchanged
    it('preserves Group color', () => {
        const d = Device.deserialize(legacyGroupDeviceData());
        expect(d.getGroup("grp_test")?.color).toBe("#ff8800");
    });

    // 8. Presets remain valid
    it('keeps Presets loadable after Group migration', () => {
        const d = Device.deserialize(legacyGroupDeviceData());
        expect(d.presets.size).toBe(1);
        d.loadPreset("prs_1");
        expect(d.getControl("ctl_1")?.value).toBe(0.5);
    });

    // 9. Nexus + MIDI bindings remain valid
    it('preserves bindings through Group migration', () => {
        const d = Device.deserialize(legacyGroupDeviceData());
        expect(d.getControl("ctl_1")?.audiotoolBindingDefinition?.targetName).toBe("Filter.Cutoff");
        expect(d.getControl("ctl_1")?.midiBindingDefinition).toEqual({ channel: 0, cc: 14 });
    });

    // 10. Migration is idempotent
    it('is idempotent: reloading a migrated Device changes nothing further', () => {
        const first = Device.deserialize(legacyGroupDeviceData());
        const serialized = first.serialize();
        const second = Device.deserialize(serialized);

        const g1 = first.getGroup("grp_test")!;
        const g2 = second.getGroup("grp_test")!;
        expect(groupRect(g2)).toEqual(groupRect(g1));
        expect(second.getControl("ctl_1")?.size).toEqual({ width: 120, height: 120 });
        expect(second.getControl("ctl_1")?.position).toEqual({ x: 100, y: 120 });
        expect(second.getControl("ctl_1")?.groupId).toBe("grp_test");
    });

    it('does NOT touch a Group with no migrated members', () => {
        const device = new Device("OK");
        // Control deliberately resized small under the CURRENT layout version
        const c = new Control("knob", "Tiny", { x: 100, y: 100 });
        c.size = { width: 50, height: 50 };
        device.addControl(c);
        const g = new Group("Keep", { x: 80, y: 80 }, { width: 90, height: 90 });
        device.addGroup(g);
        device.setControlGroup(c.id, g.id);

        const restored = Device.deserialize(device.serialize());
        expect(restored.getGroup(g.id)?.size).toEqual({ width: 90, height: 90 });
        expect(restored.getGroup(g.id)?.position).toEqual({ x: 80, y: 80 });
    });
});

describe('Group bounds helpers', () => {

    it('groupMemberBounds covers all member rects', () => {
        const bounds = groupMemberBounds([
            { position: { x: 100, y: 120 }, size: { width: 120, height: 120 } },
            { position: { x: 220, y: 120 }, size: { width: 120, height: 120 } },
        ]);
        expect(bounds).toEqual({ x: 100, y: 120, width: 240, height: 120 });
    });

    it('groupMemberBounds returns null for no members', () => {
        expect(groupMemberBounds([])).toBeNull();
    });

    it('inflatedRect grows on all four edges', () => {
        expect(inflatedRect({ x: 10, y: 20, width: 50, height: 40 }, 16))
            .toEqual({ x: -6, y: 4, width: 82, height: 72 });
    });

    it('rectContainsRect is exact and symmetric to the migration logic', () => {
        expect(rectContainsRect({ x: 0, y: 0, width: 100, height: 100 }, { x: 10, y: 10, width: 50, height: 50 })).toBe(true);
        expect(rectContainsRect({ x: 0, y: 0, width: 100, height: 100 }, { x: 10, y: 10, width: 100, height: 50 })).toBe(false);
    });

    it('unionRect is the smallest rectangle covering both', () => {
        expect(unionRect({ x: 0, y: 0, width: 50, height: 50 }, { x: 40, y: 40, width: 50, height: 50 }))
            .toEqual({ x: 0, y: 0, width: 90, height: 90 });
    });

    it('migratedGroupRect leaves a sufficiently large Group untouched (idempotent)', () => {
        const group = { position: { x: 80, y: 100 }, size: { width: 400, height: 300 } };
        const members = [
            { position: { x: 100, y: 120 }, size: { width: 120, height: 120 } },
            { position: { x: 220, y: 120 }, size: { width: 120, height: 120 } },
        ];
        const rect = migratedGroupRect(group, members, GROUP_PADDING);
        expect(rect).toEqual({ x: 80, y: 100, width: 400, height: 300 });
    });
});
