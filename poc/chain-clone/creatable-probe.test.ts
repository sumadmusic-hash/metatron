/**
 * CREATABLE-TYPES PROBE — reproduzierbarer Beweis für KNOWN_CREATABLE_TYPES.
 *
 * Für JEDEN Kandidaten in `PROBE_DEVICE_SLUGS` wird in einer echten
 * `@audiotool/nexus` v0.0.17 Offline-Document erzeugt. Nur Typen ohne
 * Konstruktor-Argumente, die wirklich existieren, gehören zur Menge.
 * Der Test schlägt fehl, wenn die committete Menge von der real erprobten
 * abweicht (SDK-Änderung → bewusst neu entscheiden, nicht stillschweigend).
 */

import { describe, it, expect } from "vitest";
import { createOfflineDocument } from "@audiotool/nexus/node";
import { KNOWN_CREATABLE_TYPES, PROBE_DEVICE_SLUGS } from "./creatable-types";

describe("CREATABLE TYPES PROBE (real offline SDK)", () => {
    it("probes every candidate type and the committed KNOWN set matches exactly", async () => {
        const probed = new Set<string>();
        const errors: Record<string, string> = {};

        for (const type of PROBE_DEVICE_SLUGS) {
            const doc = await createOfflineDocument({ validated: true });
            try {
                await doc.modify((t: any) => {
                    t.create(type as any, {});
                });
                const created = doc.queryEntities.get().find((e: any) => e.entityType === type);
                if (created) {
                    probed.add(type);
                    console.log(`PROBE ${type}: OK id=${created.id} entityCount=${doc.queryEntities.get().length}`);
                } else {
                    errors[type] = "created no entity of that type";
                }
            } catch (error) {
                errors[type] = String((error as Error).message ?? error);
            }
        }

        console.log(`PROBE RESULT: creatable=${probed.size}/${PROBE_DEVICE_SLUGS.length}`);
        for (const t of PROBE_DEVICE_SLUGS) {
            if (!probed.has(t)) console.log(`PROBE ${t}: ERROR ${errors[t]}`);
        }

        expect(probed).toEqual(KNOWN_CREATABLE_TYPES);
        expect(probed.has("mixerChannel")).toBe(true);
    });
});