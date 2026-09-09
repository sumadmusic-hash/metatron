// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveOauthRedirectUrl } from "../../src/nexus/NexusAdapter";

describe("OAuth redirect URL is origin-derived (no development-host hardcode)", () => {

    it("local development origin produces the SDK's trailing-slash redirect URL", () => {
        expect(resolveOauthRedirectUrl("http://127.0.0.1:5175")).toBe("http://127.0.0.1:5175/");
    });

    it("production-style origin produces the trailing-slash redirect URL", () => {
        expect(resolveOauthRedirectUrl("https://metatron-example.vercel.app")).toBe("https://metatron-example.vercel.app/");
    });

    it("an origin that already carries a trailing slash is left unchanged", () => {
        expect(resolveOauthRedirectUrl("https://metatron-example.vercel.app/")).toBe("https://metatron-example.vercel.app/");
    });

    it("production implementation derives the redirect from window.location.origin", () => {
        const src = readFileSync(resolve("src/nexus/NexusAdapter.ts"), "utf8");
        const redirectLine = src.split("\n").find((l) => l.trim().startsWith("redirectUrl:"));
        expect(redirectLine).toBeTruthy();
        expect(redirectLine).toMatch(/resolveOauthRedirectUrl\(window\.location\.origin\)/);
        expect(redirectLine).not.toMatch(/127\.0\.0\.1/);
    });
});