/**
 * Display-only resolution of the LOCAL authenticated Audiotool session user.
 *
 * SECURITY (B72/B73/B74): resolved name is kept IN MEMORY ONLY; tokens are
 * never logged, transmitted or returned; only a decoded display claim is
 * exposed; no OAuth scope extension. Unsupported-SDK-internals access is
 * defensive: any SDK update that moves the token storage degrades to
 * `undefined` (no chip) instead of throwing or guessing.
 */
export interface CurrentUser {
    username: string;
    source: "sdk" | "id-token";
}

const USERNAME_CLAIMS = ["preferred_username", "username", "name"] as const;

/** UTF-8-safe base64url decode of a JWT payload segment. Returns undefined on
 *  any malformed input — never throws, never exposes the token string. */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
    try {
        const payload = token.split(".")[1];
        if (!payload) return undefined;
        const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
        const binary = atob(b64);
        const json = decodeURIComponent(
            binary.split("").map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)).join("")
        );
        const obj = JSON.parse(json);
        return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
}

function claimUsername(claims: Record<string, unknown>): string | undefined {
    for (const key of USERNAME_CLAIMS) {
        const v = claims[key];
        if (typeof v === "string" && v.trim() !== "") return v.trim();
    }
    return undefined; // B74: bare `sub` is an account ID, not a display name.
}

function isExpired(claims: Record<string, unknown>): boolean {
    const exp = claims["exp"];
    if (typeof exp !== "number" || !Number.isFinite(exp)) return false;
    return exp * 1000 < Date.now();
}

/** `client` = raw object from `audiotool(...)`; `tokenLookup` yields the ID
 *  token from wherever the installed SDK keeps it (Discovery, Schritt 0). */
export function resolveCurrentUser(
    client: any,
    tokenLookup: () => string | undefined
): CurrentUser | undefined {
    if (!client || client.status !== "authenticated") return undefined;
    // Path A — SDK-native, only when the installed build actually exposes it.
    // Discovery (B72): the installed @audiotool/nexus AuthenticatedClient
    // exposes a `userName` string field directly (browser-auth.d.ts:36);
    // `user`/`profile` are kept as fallbacks across future SDK shapes.
    const sdkUser: unknown = client.userName ?? client.user ?? client.profile ?? undefined;
    const sdkName =
        typeof sdkUser === "string"
            ? sdkUser
            : (sdkUser as any)?.username ?? (sdkUser as any)?.name;
    if (typeof sdkName === "string" && sdkName.trim() !== "") {
        return { username: sdkName.trim(), source: "sdk" };
    }
    // Path B — OAuth ID-token payload, decoded in memory only.
    const token = tokenLookup();
    if (typeof token !== "string" || token === "") return undefined;
    const claims = decodeJwtPayload(token);
    if (!claims || isExpired(claims)) return undefined;
    const username = claimUsername(claims);
    return username ? { username, source: "id-token" } : undefined;
}