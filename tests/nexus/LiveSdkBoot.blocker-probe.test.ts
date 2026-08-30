import { describe, it, expect } from "vitest";
import { audiotool } from "@audiotool/nexus";

// Documents WHY the LIVE test cannot run headlessly:
// the `audiotool()` client bootstrap requires a browser `window` object
// (@audiotool/nexus dist/index.js:1997). OAuth login + a real Audiotool
// project MUST therefore be verified manually in a browser (poc/learn-poc.ts).
describe("LIVE SDK BOOT — browser-only constraint is documented, not a bug", () => {
    it("live client construction is impossible in Node: it rejects on missing `window`", async () => {
        await expect(
            audiotool({
                clientId: "e498c930-864a-4ef0-8d57-b8a176bee096",
                redirectUrl: "http://127.0.0.1:5175/",
                scope: "project:write"
            })
        ).rejects.toThrow(/window/);
    });
});