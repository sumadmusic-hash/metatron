import { Device } from "../model/Device";
import { Control } from "../model/Control";
import { Group } from "../model/Group";
import { Preset } from "../model/Preset";
import { DeviceLibrary } from "../DeviceLibrary";
import { Storage } from "../../persistence/Storage";
import {
    HISTORY_LIMIT,
    patchesEqual,
    type ControlStatePatch,
    type DeviceStatePatch,
    type GroupStatePatch,
    type HistoryAction,
    type LibraryStatePatch,
    type PresetStatePatch,
} from "./HistoryAction";

/**
 * METATRON HISTORY — the single session-scoped undo/redo layer (C1).
 *
 * DESIGN
 * -----
 * Every undoable UI mutation records a BEFORE/AFTER structural snapshot of the
 * affected state via `DeviceHistory.captureDeviceState` / `captureLibraryState`.
 * The snapshot is plain in-memory data (never persisted, never JSON-rounded).
 *
 * - "device" actions are applied IN PLACE onto the live Device objects
 *   (`restoreDeviceState`). Object identity is preserved, so live Bearings such
 *   as Nexus subscriptions and the BindingManager keep working. `undo()`/`redo()`
 *   persist through the existing `DeviceLibrary.saveCurrentDevice()` path.
 * - "library" actions (device create/delete) restore the whole device list +
 *   active device through the existing `DeviceLibrary`/`Storage` engines.
 *
 * Explicitly NOT undoable (per spec C1): Nexus Learn, MIDI Learn,
 * connection/disconnect, ActiveBindings, and any other transient state.
 */
export function captureDeviceState(device: Device): DeviceStatePatch {
    const controls: Record<string, ControlStatePatch> = {};
    device.controls.forEach((c) => {
        controls[c.id] = {
            id: c.id,
            type: c.type,
            name: c.name,
            position: { x: c.position.x, y: c.position.y },
            size: { width: c.size.width, height: c.size.height },
            groupId: c.groupId,
            value: c.value,
            defaultValue: c.defaultValue,
            visualDefinition: c.visualDefinition ? { ...c.visualDefinition } : {},
            audiotoolBindingDefinition: c.audiotoolBindingDefinition,
            midiBindingDefinition: c.midiBindingDefinition,
            archived: c.archived,
            layoutVersion: c.layoutVersion,
        };
    });

    const groups: Record<string, GroupStatePatch> = {};
    device.groups.forEach((g) => {
        groups[g.id] = {
            id: g.id,
            name: g.name,
            color: g.color,
            position: { x: g.position.x, y: g.position.y },
            size: { width: g.size.width, height: g.size.height },
        };
    });

    const presets: Record<string, PresetStatePatch> = {};
    device.presets.forEach((p) => {
        presets[p.id] = {
            id: p.id,
            name: p.name,
            deviceId: p.deviceId,
            controlValues: { ...p.controlValues },
        };
    });

    return { name: device.name, controls, groups, presets };
}

/**
 * Apply a captured device state onto a LIVE Device in place. Object identity
 * is preserved for controls/groups/presets that still exist; entries that are
 * missing are reconstructed through the model's own deserializers; entries no
 * longer present in the patch are removed. Transient fields
 * (`activeBindingState`, `migratedFromLegacy`) are deliberately NEVER touched.
 */
export function restoreDeviceState(device: Device, patch: DeviceStatePatch): void {
    // Groups first: control groupId references must resolve to a Group.
    for (const [id, data] of Object.entries(patch.groups)) {
        const group = device.groups.get(id);
        if (group) {
            group.name = data.name;
            group.color = data.color;
            group.position = { x: data.position.x, y: data.position.y };
            group.size = { width: data.size.width, height: data.size.height };
        } else {
            device.groups.set(id, Group.deserialize(data));
        }
    }
    for (const id of Array.from(device.groups.keys())) {
        if (!(id in patch.groups)) device.removeGroup(id);
    }

    for (const [id, data] of Object.entries(patch.controls)) {
        const control = device.controls.get(id);
        if (control) {
            control.type = data.type;
            control.name = data.name;
            control.position = { x: data.position.x, y: data.position.y };
            control.size = { width: data.size.width, height: data.size.height };
            control.groupId = data.groupId;
            control.value = data.value;
            control.defaultValue = data.defaultValue;
            control.visualDefinition = data.visualDefinition ? { ...data.visualDefinition } : {};
            control.audiotoolBindingDefinition = data.audiotoolBindingDefinition;
            control.midiBindingDefinition = data.midiBindingDefinition;
            control.archived = data.archived;
            control.layoutVersion = data.layoutVersion;
        } else {
            const fresh = Control.deserialize(data);
            fresh.value = data.value;
            fresh.migratedFromLegacy = false;
            if (!device.addControl(fresh)) {
                // Only reachable for an impossible before-state (I1 breach).
                console.error(`[METATRON HISTORY] refusing to restore control ${id}: max active controls reached`);
            }
        }
    }
    for (const id of Array.from(device.controls.keys())) {
        if (!(id in patch.controls)) device.removeControl(id, true);
    }

    for (const [id, data] of Object.entries(patch.presets)) {
        const preset = device.presets.get(id);
        if (preset) {
            preset.name = data.name;
            preset.controlValues = { ...data.controlValues };
        } else {
            device.presets.set(id, Preset.deserialize(data));
        }
    }
    for (const id of Array.from(device.presets.keys())) {
        if (!(id in patch.presets)) device.deletePreset(id);
    }

    device.name = patch.name;
}

/** Reconstruct a full Device from a captured library-level patch. */
function realizeDevice(id: string, patch: DeviceStatePatch): Device {
    const device = Device.deserialize({
        id,
        name: patch.name,
        schemaVersion: 1,
        controls: Object.values(patch.controls),
        groups: Object.values(patch.groups),
        presets: Object.values(patch.presets),
    });
    for (const [controlId, controlPatch] of Object.entries(patch.controls)) {
        const control = device.getControl(controlId);
        if (control) control.value = controlPatch.value;
    }
    return device;
}

export class DeviceHistory {
    /** Fired after every successful record/undo/redo (used by the UI to sync
     *  the undo/redo button enable state without a full re-render). */
    public onChange?: () => void;

    private readonly library: DeviceLibrary;
    private undoStack: HistoryAction[] = [];
    private redoStack: HistoryAction[] = [];

    constructor(library: DeviceLibrary) {
        this.library = library;
    }

    public get canUndo(): boolean {
        return this.undoStack.length > 0;
    }

    public get canRedo(): boolean {
        return this.redoStack.length > 0;
    }

    /** Whether the top undo action could be APPLIED to the CURRENT active
     *  device. Library-scope actions are always runnable; a device-scope
     *  action is only runnable while its target device is active. Used by the
     *  UI so it never suggests an undo/redo that `undo()`/`redo()` would
     *  refuse on the active device (mismatch guard). */
    public get canUndoOnCurrentDevice(): boolean {
        return this.isRunnableOnCurrent(this.undoStack[this.undoStack.length - 1]);
    }

    public get canRedoOnCurrentDevice(): boolean {
        return this.isRunnableOnCurrent(this.redoStack[this.redoStack.length - 1]);
    }

    private isRunnableOnCurrent(action: HistoryAction | undefined): boolean {
        if (!action) return false;
        if (action.scope === "library") return true;
        const device = this.library.currentDevice;
        return !!device && action.deviceId === device.id;
    }

    public get undoLength(): number {
        return this.undoStack.length;
    }

    public get redoLength(): number {
        return this.redoStack.length;
    }

    public captureDeviceState(device: Device): DeviceStatePatch {
        return captureDeviceState(device);
    }

    public restoreDeviceState(device: Device, patch: DeviceStatePatch): void {
        restoreDeviceState(device, patch);
    }

    /** Library-scope snapshot: every stored device + the active device id. */
    public captureLibraryState(): LibraryStatePatch {
        const devices: Record<string, DeviceStatePatch> = {};
        const current = this.library.currentDevice;
        for (const meta of this.library.listDevices()) {
            const id = meta.id;
            const live = current?.id === id ? current : Storage.loadDevice(id);
            if (live) devices[id] = captureDeviceState(live);
        }
        return { devices, activeDeviceId: current?.id ?? null };
    }

    /** Library-scope restore: reconcile the device list + active device. */
    public restoreLibraryState(patch: LibraryStatePatch): void {
        const activeId = patch.activeDeviceId;

        // Remove devices that must not exist in the target state.
        for (const meta of this.library.listDevices()) {
            if (!(meta.id in patch.devices)) this.library.deleteDevice(meta.id);
        }

        // (Re)write every device present in the target state.
        for (const [id, devicePatch] of Object.entries(patch.devices)) {
            this.library.currentDevice = realizeDevice(id, devicePatch);
            if (id !== activeId) this.library.saveCurrentDevice();
        }

        // Activate the recorded active device (values kept in memory).
        if (activeId && patch.devices[activeId]) {
            this.library.currentDevice = realizeDevice(activeId, patch.devices[activeId]);
            this.library.saveCurrentDevice();
        } else {
            this.library.currentDevice = undefined;
        }
    }

    /** Record one completed action. Clears the redo stack (standard LIFO
     *  semantics) and enforces the `HISTORY_LIMIT` cap (oldest evicted). */
    public record(action: HistoryAction): void {
        this.redoStack.length = 0;
        this.undoStack.push(action);
        if (this.undoStack.length > HISTORY_LIMIT) {
            this.undoStack.shift();
        }
        this.onChange?.();
    }

    /** Device-scope record used by the async import path. The device captured
     *  at the START of the mutating operation is passed in explicitly: the
     *  action is committed ONLY while that device is still active. If the user
     *  switched devices while the mutation was in flight, the action is
     *  discarded — the state of device X is NEVER tagged as an action for
     *  device Y. No heuristics: a strict identity check. */
    public recordDeviceAction(
        type: string,
        device: Device,
        before: DeviceStatePatch | null,
        after: DeviceStatePatch | null,
    ): void {
        if (!before || !after || patchesEqual(before, after)) return;
        if (this.library.currentDevice?.id !== device.id) return;
        this.record({ type, scope: "device", deviceId: device.id, before, after });
    }

    public undo(): boolean {
        const action = this.undoStack.pop();
        if (!action) return false;
        if (!this.apply(action, "before")) {
            this.undoStack.push(action);
            return false;
        }
        this.redoStack.push(action);
        this.onChange?.();
        return true;
    }

    public redo(): boolean {
        const action = this.redoStack.pop();
        if (!action) return false;
        if (!this.apply(action, "after")) {
            this.redoStack.push(action);
            return false;
        }
        this.undoStack.push(action);
        this.onChange?.();
        return true;
    }

    private apply(action: HistoryAction, which: "before" | "after"): boolean {
        if (action.scope === "library") {
            this.restoreLibraryState(action[which] as LibraryStatePatch);
            return true;
        }

        const device = this.library.currentDevice;
        if (!device || action.deviceId !== device.id) {
            // Deterministic guard: never write the captured state onto a
            // different device. The action stays on the stack.
            console.warn(
                `[METATRON HISTORY] "${action.type}" targets device "${action.deviceId ?? "?"}" but the active device is "${device?.id ?? "none"}" — action kept.`,
            );
            return false;
        }
        restoreDeviceState(device, action[which] as DeviceStatePatch);
        this.library.saveCurrentDevice();
        return true;
    }
}

export { patchesEqual };