// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Toast } from "../../src/ui/Toast";

/**
 * OPT — die Toast-Spalte darf nie unbegrenzt anwachsen. Eine lange Fail-Serie
 * (z. B. Storage off) wurde sonst zu einer ewig steigenden Meldungsspalte;
 * die jüngste Meldung muss sichtbar bleiben, die ältesten fallen raus.
 */

function toastContainer(): HTMLElement {
    const c = (Toast as unknown as { container: HTMLElement | null }).container;
    if (!c) throw new Error("no toast container");
    return c;
}

beforeEach(() => {
    document.body.innerHTML = "";
    (Toast as unknown as { container: HTMLElement | null }).container = null;
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("Toast — stacking cap", () => {
    it("keeps at most 3 concurrent toasts and drops the oldest ones", () => {
        Toast.show("a", "info");
        Toast.show("b", "info");
        Toast.show("c", "info");
        expect(toastContainer().children.length).toBe(3);

        Toast.show("d", "info");
        Toast.show("e", "info");

        const children = Array.from(toastContainer().children);
        expect(children.length).toBeLessThanOrEqual(3);
        const texts = children.map((el) => el.textContent);
        expect(texts).toContain("d");
        expect(texts).toContain("e");
        expect(texts).not.toContain("a");
        expect(texts).not.toContain("b");
    });
});