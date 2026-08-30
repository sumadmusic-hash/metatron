import type { 
    ControlType, 
    Position, 
    Size, 
    VisualDefinition, 
    NexusBindingDefinition, 
    MidiBindingDefinition, 
    BindingState
} from "./types";
import { generateId } from "./types";
import { CURRENT_LAYOUT_VERSION, DEFAULT_CONTROL_SIZE, controlNeedsLegacyMigration } from "../../ui/geometry";

export class Control {
    public readonly id: string;
    public type: ControlType;
    public name: string;
    
    public position: Position;
    public size: Size;
    
    public groupId?: string;
    
    public value: number;
    public defaultValue: number;
    
    public visualDefinition: VisualDefinition;
    public audiotoolBindingDefinition?: NexusBindingDefinition;
    public midiBindingDefinition?: MidiBindingDefinition;

    /**
     * Tracks which layout generation this Control's geometry belongs to.
     * `undefined` or `1` means the Control was created before the geometry
     * repair (legacy 60×60 default). `2` (CURRENT_LAYOUT_VERSION) means the
     * Control is already compatible with the post-repair geometry.
     * This field is serialized and survives save/load round-trips.
     */
    public layoutVersion?: number;

    /**
     * Transient flag, set during this deserialize pass when the Control was
     * just migrated from a legacy size. Not serialized. Used by
     * Device.deserialize to expand legacy Groups in the same one-time pass.
     */
    public migratedFromLegacy: boolean = false;

    // Transient state: not serialized as part of the core definition
    public activeBindingState: BindingState = "UNCONFIGURED";
    public archived: boolean = false;

    constructor(
        type: ControlType, 
        name: string, 
        position: Position = { x: 0, y: 0 },
        id?: string
    ) {
        this.id = id ?? generateId("ctl");
        this.type = type;
        this.name = name;
        this.position = position;
        // Default Control size: room for the visual area + label/status footer.
        // The stored size is preserved on deserialize (user geometry is kept).
        this.size = { ...DEFAULT_CONTROL_SIZE };
        this.value = 0;
        this.defaultValue = 0;
        this.visualDefinition = {};
        this.layoutVersion = CURRENT_LAYOUT_VERSION;
    }

    public softDelete() {
        this.archived = true;
    }

    // Convert to plain object for serialization
    public serialize(): object {
        return {
            id: this.id,
            type: this.type,
            name: this.name,
            position: this.position,
            size: this.size,
            groupId: this.groupId,
            defaultValue: this.defaultValue,
            visualDefinition: this.visualDefinition,
            audiotoolBindingDefinition: this.audiotoolBindingDefinition,
            midiBindingDefinition: this.midiBindingDefinition,
            archived: this.archived,
            layoutVersion: this.layoutVersion
        };
    }

    public static deserialize(data: any): Control {
        const c = new Control(data.type, data.name, data.position, data.id);
        c.size = data.size;
        c.groupId = data.groupId;
        c.defaultValue = data.defaultValue;
        c.value = data.defaultValue; // Will be overridden if preset is loaded
        c.visualDefinition = data.visualDefinition || {};
        c.audiotoolBindingDefinition = data.audiotoolBindingDefinition;
        c.midiBindingDefinition = data.midiBindingDefinition;
        c.archived = data.archived || false;
        c.activeBindingState = data.audiotoolBindingDefinition ? "DISCONNECTED" : "UNCONFIGURED";

        // ── One-time legacy layout migration ──────────────────────────────
        // If this Control was created before the geometry repair AND its
        // stored size matches the old small default, migrate it to the
        // current layout geometry. The migration is idempotent: after the
        // first pass, layoutVersion is set to CURRENT_LAYOUT_VERSION and
        // subsequent deserializations skip the migration entirely.
        c.layoutVersion = data.layoutVersion;
        c.migratedFromLegacy = controlNeedsLegacyMigration(data);
        if (c.migratedFromLegacy) {
            c.size = { ...DEFAULT_CONTROL_SIZE };
            c.layoutVersion = CURRENT_LAYOUT_VERSION;
        }

        return c;
    }
}
