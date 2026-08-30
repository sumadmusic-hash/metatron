import type { Position, Size } from "./types";
import { generateId } from "./types";

export class Group {
    public readonly id: string;
    public name: string;
    public color: string;
    
    public position: Position;
    public size: Size;
    
    // Derived property, calculated from controls that reference this group ID
    // We don't store an explicit array of control IDs to avoid state duplication (I4)
    // The Control's groupId is the source of truth.

    constructor(
        name: string,
        position: Position = { x: 0, y: 0 },
        size: Size = { width: 200, height: 200 },
        id?: string
    ) {
        this.id = id ?? generateId("grp");
        this.name = name;
        this.color = "#333333"; // Default color
        this.position = position;
        this.size = size;
    }

    public serialize(): object {
        return {
            id: this.id,
            name: this.name,
            color: this.color,
            position: this.position,
            size: this.size
        };
    }

    public static deserialize(data: any): Group {
        const g = new Group(data.name, data.position, data.size, data.id);
        g.color = data.color || "#333333";
        return g;
    }
}
