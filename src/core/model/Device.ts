import { Control } from "./Control";
import { Group } from "./Group";
import { Preset } from "./Preset";
import { generateId } from "./types";
import { GROUP_PADDING, migratedGroupRect } from "../../ui/geometry";

export class Device {
    public readonly id: string;
    public name: string;
    public schemaVersion: number = 1; // I13
    
    public controls: Map<string, Control> = new Map();
    public groups: Map<string, Group> = new Map();
    public presets: Map<string, Preset> = new Map();

    public readonly MAX_ACTIVE_CONTROLS = 32; // I1

    constructor(name: string, id?: string) {
        this.id = id ?? generateId("dev");
        this.name = name;
    }

    // --- CONTROLS ---

    public addControl(control: Control): boolean {
        // Enforce I1
        if (!control.archived && this.getActiveControlCount() >= this.MAX_ACTIVE_CONTROLS) {
            console.error(`Cannot add more than ${this.MAX_ACTIVE_CONTROLS} active controls.`);
            return false;
        }
        
        this.controls.set(control.id, control);
        return true;
    }

    public getControl(id: string): Control | undefined {
        return this.controls.get(id);
    }

    public getActiveControlCount(): number {
        let count = 0;
        this.controls.forEach(c => {
            if (!c.archived) count++;
        });
        return count;
    }

    public removeControl(id: string, hardDelete: boolean = false) {
        const c = this.controls.get(id);
        if (!c) return;

        if (hardDelete) {
            this.controls.delete(id);
        } else {
            c.softDelete();
        }
    }

    // --- GROUPS ---

    public addGroup(group: Group) {
        this.groups.set(group.id, group);
    }

    public getGroup(id: string): Group | undefined {
        return this.groups.get(id);
    }

    public removeGroup(id: string) {
        this.groups.delete(id);
        // Orphan any controls in this group
        this.controls.forEach(c => {
            if (c.groupId === id) {
                c.groupId = undefined;
            }
        });
    }

    /** All non-archived controls that belong to a group (spec §16). */
    public getGroupControls(groupId: string): Control[] {
        const result: Control[] = [];
        this.controls.forEach(c => {
            if (c.groupId === groupId && !c.archived) {
                result.push(c);
            }
        });
        return result;
    }

    /** Assign a control to at most one group (invariant I4).
     * Passing `undefined` removes the control from its current group.
     * Returns false if the target group does not exist. */
    public setControlGroup(controlId: string, groupId: string | undefined): boolean {
        const control = this.controls.get(controlId);
        if (!control) return false;
        if (control.archived) return false;
        if (groupId !== undefined && !this.groups.has(groupId)) return false;
        control.groupId = groupId;
        return true;
    }

    /** Move a group and all its member controls by (dx, dy).
     * Each member keeps its relative position within the group (spec §17). */
    public moveGroup(groupId: string, dx: number, dy: number) {
        const group = this.groups.get(groupId);
        if (!group) return;

        group.position.x = Math.max(0, group.position.x + dx);
        group.position.y = Math.max(0, group.position.y + dy);

        this.controls.forEach(c => {
            if (c.groupId === groupId) {
                c.position.x = Math.max(0, c.position.x + dx);
                c.position.y = Math.max(0, c.position.y + dy);
            }
        });
    }

    /** Resize a group without touching member control positions. */
    public resizeGroup(groupId: string, width: number, height: number) {
        const group = this.groups.get(groupId);
        if (!group) return;
        group.size = { width: Math.max(1, width), height: Math.max(1, height) };
    }

    // --- PRESETS ---

    public addPreset(preset: Preset) {
        if (preset.deviceId !== this.id) {
            console.error("Preset does not belong to this device.");
            return;
        }
        this.presets.set(preset.id, preset);
    }

    public loadPreset(presetId: string) {
        const preset = this.presets.get(presetId);
        if (!preset) return;

        // Apply values to controls
        this.controls.forEach(control => {
            if (!control.archived) {
                if (preset.controlValues[control.id] !== undefined) {
                    control.value = preset.controlValues[control.id];
                } else {
                    // Control didn't exist when preset was saved, use default
                    control.value = control.defaultValue;
                }
            }
        });
    }

    public savePreset(presetName: string): Preset {
        const preset = new Preset(presetName, this.id);
        this.controls.forEach(control => {
            if (!control.archived) {
                preset.controlValues[control.id] = control.value;
            }
        });
        this.addPreset(preset);
        return preset;
    }

    public deletePreset(presetId: string) {
        this.presets.delete(presetId);
    }

    // --- SERIALIZATION ---

    public serialize(): object {
        const serializedControls = Array.from(this.controls.values()).map(c => c.serialize());
        const serializedGroups = Array.from(this.groups.values()).map(g => g.serialize());
        const serializedPresets = Array.from(this.presets.values()).map(p => p.serialize());

        return {
            id: this.id,
            name: this.name,
            schemaVersion: this.schemaVersion,
            controls: serializedControls,
            groups: serializedGroups,
            presets: serializedPresets
        };
    }

    public static deserialize(data: any): Device {
        const d = new Device(data.name, data.id);
        d.schemaVersion = data.schemaVersion || 1;

        if (data.controls) {
            data.controls.forEach((cData: any) => {
                d.controls.set(cData.id, Control.deserialize(cData));
            });
        }

        if (data.groups) {
            data.groups.forEach((gData: any) => {
                const g = Group.deserialize(gData);

                // ── One-time legacy Group migration ──────────────────────
                // If any member Control was just migrated to the current
                // geometry in this pass, expand this Group so it fully
                // contains all of its members plus padding. Idempotent: once
                // the Groups fit, no further control migrates and no Group is
                // touched on subsequent loads.
                const members = d.getGroupControls(g.id);
                if (members.some((c) => c.migratedFromLegacy)) {
                    const rect = migratedGroupRect(g, members, GROUP_PADDING);
                    g.position = { x: rect.x, y: rect.y };
                    g.size = { width: rect.width, height: rect.height };
                }

                d.groups.set(g.id, g);
            });
        }

        if (data.presets) {
            data.presets.forEach((pData: any) => {
                d.presets.set(pData.id, Preset.deserialize(pData));
            });
        }

        return d;
    }
}
