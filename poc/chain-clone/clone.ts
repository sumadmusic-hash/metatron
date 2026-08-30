/**
 * Re-export shim — production single source of truth: `src/nexus/ChainClone`
 * (engine) plus `src/nexus/ChainPath` (`resolveFieldByPath`).
 *
 * PoC tests keep importing this path so they continuously verify the SAME
 * implementation production ships.
 */
export * from "../../src/nexus/ChainClone";
export type * from "../../src/nexus/ChainClone";
export { resolveFieldByPath } from "../../src/nexus/ChainPath";