import { generateId } from "./types";
import { parseModulationMatrix } from "../modulation/ModulationMatrix";
import { cloneModulationMatrix } from "../modulation/ModulationTypes";
import type { ModulationMatrixConfig } from "../modulation/ModulationTypes";

export class Preset {
    public readonly id: string;
    public name: string;
    public readonly deviceId: string;
    
    // Map of Control ID -> Value
    public controlValues: Record<string, number> = {};

    /** Modulation-matrix snapshot, captured with the preset (§10). Present only
     *  for presets that captured a matrix; `undefined` marks a LEGACY preset —
     *  loading it leaves the device's current matrix untouched. */
    public modulation?: ModulationMatrixConfig;

    constructor(name: string, deviceId: string, id?: string) {
        this.id = id ?? generateId("pst");
        this.name = name;
        this.deviceId = deviceId;
    }

    public serialize(): object {
        const out: {
            id: string;
            name: string;
            deviceId: string;
            controlValues: Record<string, number>;
            modulation?: unknown;
        } = {
            id: this.id,
            name: this.name,
            deviceId: this.deviceId,
            controlValues: this.controlValues
        };
        // §10 — a clone so the stored JSON can never alias the live matrix.
        if (this.modulation !== undefined) {
            out.modulation = cloneModulationMatrix(this.modulation);
        }
        return out;
    }

    public static deserialize(data: any): Preset {
        const p = new Preset(data.name, data.deviceId, data.id);
        p.controlValues = data.controlValues || {};
        // §10 — legacy payload (no `modulation` key) stays snapshot-less; the
        // device keeps its current matrix. A structurally invalid snapshot is
        // sanitized back to the default matrix instead of breaking the load.
        if (data.modulation !== undefined) {
            try {
                p.modulation = parseModulationMatrix(data.modulation);
            } catch (e) {
                console.warn("[METATRON PRESET] invalid preset modulation payload — snapshot ignored.", e);
            }
        }
        return p;
    }
}