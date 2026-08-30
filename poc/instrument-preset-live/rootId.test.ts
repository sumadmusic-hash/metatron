/**
 * LIVE/UI — regression test for the pure TARGET-root derivation.
 *
 * The successful live import produced a valid source→target idMap; this test
 * pins the deterministic SOURCE root → idMap → TARGET root mapping and the
 * clean handling of a missing SOURCE root / missing mapping (no artificial
 * root is ever created).
 */

import { describe, it, expect } from "vitest";
import { resolveTargetRootId } from "./rootId";
import { normalizeEntityId } from "../chain-discovery/discovery";

describe("resolveTargetRootId — SOURCE root → idMap → TARGET root", () => {
    it("returns the TARGET root when the SOURCE root is present in the idMap", () => {
        const idMap: Record<string, string> = {};
        idMap[normalizeEntityId("source-root")] = "target-root";
        expect(resolveTargetRootId("source-root", idMap)).toBe("target-root");
    });

    it("matches idMap keys exactly like the clone idMap (keys are already normalized)", () => {
        const idMap: Record<string, string> = { "source-root": "target-root" };
        expect(resolveTargetRootId("source-root", idMap)).toBe("target-root");
    });

    it("handles Map-based idMaps as produced by the clone engine", () => {
        const idMap = new Map<string, string>([[normalizeEntityId("source-root"), "target-root"]]);
        expect(resolveTargetRootId("source-root", idMap)).toBe("target-root");
    });

    it("returns undefined when the SOURCE root id is missing (no artificial root)", () => {
        expect(resolveTargetRootId(undefined, {})).toBeUndefined();
        expect(resolveTargetRootId("", {})).toBeUndefined();
    });

    it("returns undefined when the SOURCE root is not mapped (device not cloned)", () => {
        expect(resolveTargetRootId("unmapped-root", {})).toBeUndefined();
    });
});