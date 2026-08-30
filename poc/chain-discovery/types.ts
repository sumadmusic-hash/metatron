/**
 * Re-export shim — production single source of truth: `src/nexus/ChainDiscovery`.
 *
 * PoC tooling keeps importing this path so it continuously uses the SAME types
 * production ships — no second type source.
 *
 * `MetatronBinding` stays PoC-local: it describes the persisted device-binding
 * state read by `poc/chain-discovery/bindings.ts` (localStorage read tooling)
 * and has no production counterpart.
 */

import type { Provenance } from "../../src/nexus/ChainDiscovery";
export type * from "../../src/nexus/ChainDiscovery";

/** One captured device binding, read from Metatron's persisted devices only. */
export interface MetatronBinding {
    deviceName: string;
    controlLabel: string;
    targetName?: string;
    state: "UNCONFIGURED" | "DISCONNECTED" | "CONNECTED";
    provenance: Provenance;
}