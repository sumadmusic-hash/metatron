/**
 * M4.4 — deterministic shortening of Audiotool parameter names.
 *
 * Produces the visible Metatron control label after a successful Learn.
 * The function is pure (no side effects) and never mutates binding data —
 * underlying identifiers (`fieldPath`, `targetName`, ...) are left untouched.
 */

export const MAX_DISPLAY_LENGTH = 15;
const ELLIPSIS = "\u2026";

const REDUNDANT_WORDS = new Set(["parameter", "control", "setting", "value"]);

const CONTAINER_WORDS = new Set(["filter", "envelope", "delay"]);

const SHORTENING_PATTERNS: ReadonlyArray<{
    readonly tokens: readonly string[];
    readonly label: string;
}> = [
    { tokens: ["cutoff", "frequency"], label: "Cutoff" },
    { tokens: ["resonance"], label: "Resonance" },
    { tokens: ["resonance", "amount"], label: "Resonance" },
    { tokens: ["attack", "time"], label: "Attack" },
    { tokens: ["decay", "time"], label: "Decay" },
    { tokens: ["release", "time"], label: "Release" },
    { tokens: ["feedback", "amount"], label: "Feedback" },
    { tokens: ["dry", "wet", "mix"], label: "Mix" },
    { tokens: ["wet", "dry", "mix"], label: "Mix" },
    { tokens: ["frequency", "hz"], label: "Frequency" },
    { tokens: ["time", "seconds"], label: "Time" },
    { tokens: ["level", "db"], label: "Level" },
];

/**
 * Splits a parameter name into lowercase semantic tokens.
 *
 * Handles camelCase/PascalCase, snake_case, kebab-case, spaces, dots and
 * letter/digit transitions. Unsupported separators are treated as breaks.
 */
function tokenize(name: string): string[] {
    const tokens: string[] = [];
    let current = "";

    const push = () => {
        if (current) tokens.push(current.toLowerCase());
        current = "";
    };

    for (const ch of name.trim()) {
        if (/[A-Za-z0-9]/.test(ch)) {
            const isUpper = /[A-Z]/.test(ch);
            const isDigit = /[0-9]/.test(ch);
            const currentIsWordy = /[a-z0-9]/.test(current);
            if ((currentIsWordy && isUpper) || (current && isDigit !== /[0-9]/.test(current))) {
                push();
            }
            current += ch;
        } else {
            push();
        }
    }
    push();
    return tokens;
}

/**
 * Removes trailing generic nouns that add no useful meaning
 * ("parameter", "control", "setting", "value").
 */
function dropRedundantWords(tokens: string[]): string[] {
    const retained = [...tokens];
    while (retained.length > 1 && REDUNDANT_WORDS.has(retained[retained.length - 1])) {
        retained.pop();
    }
    return retained;
}

/**
 * Applies the conservative semantic patterns. A leading container word
 * ("filter", "envelope", "delay") may be present and is dropped only when
 * the remaining tokens match a known pattern.
 */
function matchPattern(tokens: string[]): string | undefined {
    for (const pattern of SHORTENING_PATTERNS) {
        if (tokens.length === pattern.tokens.length) {
            let matches = true;
            for (let i = 0; i < pattern.tokens.length; i++) {
                if (tokens[i] !== pattern.tokens[i]) {
                    matches = false;
                    break;
                }
            }
            if (matches) return pattern.label;
        }
        if (
            tokens.length === pattern.tokens.length + 1 &&
            CONTAINER_WORDS.has(tokens[0])
        ) {
            let matches = true;
            for (let i = 0; i < pattern.tokens.length; i++) {
                if (tokens[i + 1] !== pattern.tokens[i]) {
                    matches = false;
                    break;
                }
            }
            if (matches) return pattern.label;
        }
    }
    return undefined;
}

/** Formats retained tokens as a concise title-style label. */
function formatTokens(tokens: string[]): string {
    return tokens.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(" ");
}

/**
 * Deterministically shortens a parameter name for display.
 *
 * Unknown names are preserved in readable title form; truncation with an
 * ellipsis is applied only as a final fallback when the result exceeds
 * `MAX_DISPLAY_LENGTH`. Empty input produces an empty label.
 */
export function shortenParameterName(name: string): string {
    const tokens = dropRedundantWords(tokenize(name));
    if (tokens.length === 0) return "";

    const label = matchPattern(tokens) ?? formatTokens(tokens);
    if (label.length <= MAX_DISPLAY_LENGTH) return label;
    return label.slice(0, MAX_DISPLAY_LENGTH - 1) + ELLIPSIS;
}