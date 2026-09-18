// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { BindingManager } from "../../src/core/BindingManager";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { AppUI } from "../../src/ui/AppUI";

/**
 * R1 — der explizite Login-Aktionspfad, den B6 im Kommentar versprochen, aber
 * nie geliefert hat: ein Sign-in-Auslöser im Header, solange keine Session
 * authentifiziert ist, und ein Connect-Guard, der openProject() in dem Zustand
 * nicht mehr anwirft.
 */

const mockLogin = vi.fn();
vi.mock("@audiotool/nexus", () => ({
    audiotool: vi.fn(async () => ({ status: "unauthenticated", login: mockLogin })),
}));

function mountGuest(): { root: HTMLElement; adapter: NexusAdapter; app: AppUI } {
    const adapter = new NexusAdapter();
    const device = new Device("Guest");
    device.addControl(new Control("knob", "Gain", undefined, "gain"));
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    lib.saveCurrentDevice();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const app = new AppUI(root, lib, adapter, new MidiAccess(), new BindingManager(device));
    app.render();
    return { root, adapter, app };
}

function connectButton(root: HTMLElement): HTMLButtonElement {
    const btn = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.innerText === "Connect");
    expect(btn).toBeTruthy();
    return btn!;
}

describe("R1 — Login-Aktionspfad (Sign-in-Button + Connect-Guard)", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
        localStorage.clear();
        mockLogin.mockClear();
    });

    it("unauthenticated → Header zeigt den Sign-in-Auslöser; ein Klick ruft client.login() genau einmal", async () => {
        const { root, adapter } = mountGuest();
        // Produktionspfad: launchAuth() hat beim Boot bereits einen Client
        // gebaut (passiv, ohne Redirect). Der Explizit-Login gibt dafür die
        // Nutzeraktion im Header.
        await adapter.authenticate("test-client-id");
        expect(adapter.isAuthenticated()).toBe(false);

        const btn = root.querySelector<HTMLButtonElement>("#sign-in-btn");
        expect(btn).toBeTruthy();
        expect(btn!.innerText).toBe("Sign in");

        btn!.click();
        await vi.waitFor(() => expect(mockLogin).toHaveBeenCalledTimes(1));
        expect((adapter as any).client.login).toBe(mockLogin);
    });

    it("Connect-Klick im Gast-Zustand ruft openProject() NICHT auf", async () => {
        const { root, adapter } = mountGuest();
        const urlInput = root.querySelector<HTMLInputElement>("input[placeholder='Audiotool Project URL...']")!;
        urlInput.value = "https://audiotool.com/project/123";

        const openSpy = vi.spyOn(adapter, "openProject");
        await connectButton(root).onclick!({} as any);

        expect(openSpy).not.toHaveBeenCalled();
        expect(root.querySelector<HTMLElement>(".conn-chip")!.innerText).not.toBe("Connected");
    });

    it("authentifizierte Session → kein Sign-in-Auslöser im Header, stattdessen User-Badge", () => {
        const adapter = new NexusAdapter();
        (adapter as any).client = { status: "authenticated" };
        (adapter as any).currentUser = { username: "alice" } as never;
        const device = new Device("Guest");
        const lib = new DeviceLibrary();
        lib.currentDevice = device;
        lib.saveCurrentDevice();
        const root = document.createElement("div");
        document.body.appendChild(root);
        const app = new AppUI(root, lib, adapter, new MidiAccess(), new BindingManager(device));
        app.render();
        expect(root.querySelector("#sign-in-btn")).toBeNull();
        expect(root.querySelector(".user-badge")).toBeTruthy();
    });
});