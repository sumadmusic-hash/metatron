// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveOauthRedirectUrl, NexusAdapter } from "../../src/nexus/NexusAdapter";

vi.mock("@audiotool/nexus", () => ({
    audiotool: vi.fn(async () => ({ status: "unauthenticated", login: vi.fn() })),
}));

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

describe("authenticate() — kein impliziter login()-Redirect beim Laden (B6)", () => {
    it("unauthenticated client → false, ohne client.login() zu feuern", async () => {
        const adapter = new NexusAdapter();
        const isAuthenticated = await adapter.authenticate("b6-client");
        expect(isAuthenticated).toBe(false);
        // B6: der Boot darf die Seite nicht per OAuth-Redirect wegwerfen; die
        // Anmeldung bleibt eine explizite Nutzeraktion.
        expect((adapter as any).client.login).not.toHaveBeenCalled();
    });
});