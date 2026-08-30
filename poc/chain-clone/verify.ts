/**
 * Re-export shim — production single source of truth: `src/nexus/ChainVerify`.
 *
 * PoC tests keep importing this path so they continuously verify the SAME
 * implementation production ships.
 */
export * from "../../src/nexus/ChainVerify";
export type * from "../../src/nexus/ChainVerify";