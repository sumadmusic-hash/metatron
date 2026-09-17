import { describe, it, expect } from "vitest";
import { decodeJwtPayload, resolveCurrentUser } from "../../src/nexus/CurrentUser";

const jwt = (claims: Record<string, unknown>) =>
    ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");

describe("CurrentUser", () => {
    it("decodes a UTF-8 JWT payload", () => {
        expect(decodeJwtPayload(jwt({ preferred_username: "Zöe" }))?.preferred_username).toBe("Zöe");
    });
    it("rejects malformed tokens", () => {
        expect(decodeJwtPayload("abc")).toBeUndefined();
        expect(decodeJwtPayload("a.!!!.c")).toBeUndefined();
    });
    it("unauthenticated client yields undefined", () => {
        expect(resolveCurrentUser({ status: "unauthenticated" }, () => undefined)).toBeUndefined();
    });
    it("prefers SDK-native name (userName string, discovery path A)", () => {
        expect(resolveCurrentUser({ status: "authenticated", userName: "ada" }, () => undefined)?.username).toBe("ada");
    });
    it("prefers SDK-native name (string user)", () => {
        expect(resolveCurrentUser({ status: "authenticated", user: "ada" }, () => undefined)?.username).toBe("ada");
    });
    it("prefers SDK-native name (object profile)", () => {
        expect(resolveCurrentUser({ status: "authenticated", profile: { username: "ada" } }, () => undefined)?.username).toBe("ada");
    });
    it("reads preferred_username from the ID token", () => {
        const u = resolveCurrentUser({ status: "authenticated" }, () => jwt({ preferred_username: "ada" }));
        expect(u).toEqual({ username: "ada", source: "id-token" });
    });
    it("expired token yields undefined", () => {
        expect(resolveCurrentUser({ status: "authenticated" }, () => jwt({ preferred_username: "ada", exp: 1 }))).toBeUndefined();
    });
    it("sub-only token yields undefined (B74)", () => {
        expect(resolveCurrentUser({ status: "authenticated" }, () => jwt({ sub: "42" }))).toBeUndefined();
    });
    it("missing token yields undefined", () => {
        expect(resolveCurrentUser({ status: "authenticated" }, () => undefined)).toBeUndefined();
    });
});