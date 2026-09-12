import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * M21.9 — regression guards for audit findings G-01 / G-03:
 *  - .automation-hint keeps using var(--text-warning) AND --text-warning is defined
 *  - no user-visible string in the UI sources still carries an internal §-reference
 *  - the three audited messages stay readable and §-free
 */

const UI_FILES = [
    "src/ui/editor/EditorUI.ts",
    "src/ui/surface/SurfaceUI.ts",
    "src/ui/DeviceLibraryUI.ts",
    "src/ui/AppUI.ts",
    "src/ui/Toast.ts",
    "src/ui/styles.css",
];

const css = readFileSync(resolve("src/ui/styles.css"), "utf8");

describe("M21.9 — user-visible text regression (G-01, G-03)", () => {
    it("1. styles.css defines --text-warning and .automation-hint uses var(--text-warning)", () => {
        expect(css).toContain("--text-warning: #fbbf24;");
        const hintRule = css.match(/\.automation-hint\s*\{[^}]*\}/);
        expect(hintRule?.[0]).toMatch(/var\(--text-warning\)/);
    });

    it("2. no UI source carries §-references in non-comment (user-visible) strings", () => {
        const offenders: { file: string; line: string }[] = [];
        for (const file of UI_FILES) {
            const src = readFileSync(resolve(file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
            src.split("\n").forEach((raw) => {
                const code = raw.replace(/\/\/.*$/, "").trim();
                if (code.includes("§")) offenders.push({ file, line: raw.trim() });
            });
        }
        expect(offenders).toEqual([]);
    });

    it("3. the audited messages stay understandable and no Toast text carries §", () => {
        const ui = UI_FILES.filter((f) => f.endsWith(".ts"))
            .map((f) => readFileSync(resolve(f), "utf8"))
            .join("\n");
        expect(ui).toContain('Toast.show("Connect to an Audiotool project first.", "error");');
        expect(ui).toContain('Toast.show("New empty device created.", "success");');
        expect(ui).toContain('Toast.show("Control archived. Preset references remain valid.", "info");');
        const toasts = [...ui.matchAll(/Toast\.show\("[^"]*"/g)].map((m) => m[0]);
        expect(toasts.some((t) => t.includes("§"))).toBe(false);
    });
});