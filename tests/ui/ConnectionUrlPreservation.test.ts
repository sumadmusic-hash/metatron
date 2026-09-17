// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Device } from "../../src/core/model/Device";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { BindingManager } from "../../src/core/BindingManager";
import { AppUI } from "../../src/ui/AppUI";

class TestNexusAdapter extends NexusAdapter {
    public openCalls = 0;
    public lastUrl = "";
    public failNext = false;
    public subscribers: ((connected: boolean) => void)[] = [];

    public override async openProject(url: string, _bindingManager?: any): Promise<void> {
        this.openCalls++;
        this.lastUrl = url;
        if (this.failNext) {
            this.failNext = false;
            throw new Error("boom");
        }
        this.document = { connected: { subscribe: vi.fn(), getValue: () => true } } as any;
    }

    public override isDocumentConnected(): boolean {
        return this.document !== null;
    }

    public override onDocumentConnectedChanged(callback: (connected: boolean) => void): () => void {
        this.subscribers.push(callback);
        callback(this.document !== null);
        return () => {
            this.subscribers = this.subscribers.filter((s) => s !== callback);
        };
    }

    public emitConnected(connected: boolean) {
        for (const sub of [...this.subscribers]) {
            sub(connected);
        }
    }
}

function mount(adapter: TestNexusAdapter): { root: HTMLElement; adapter: TestNexusAdapter; app: AppUI } {
    const device = new Device("ConnTest");
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    lib.saveCurrentDevice();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const app = new AppUI(root, lib, adapter, new MidiAccess(), new BindingManager(device));
    app.render();
    return { root, adapter, app };
}

function getUrlInput(root: HTMLElement): HTMLInputElement {
    return root.querySelector<HTMLInputElement>("input.conn-input")!;
}

function getStatusEl(root: HTMLElement): HTMLElement {
    return root.querySelector<HTMLElement>(".conn-chip")!;
}

function getButton(root: HTMLElement, labelPrefix: string): HTMLButtonElement {
    if (labelPrefix === "USE" || labelPrefix === "EDIT") {
        return [...root.querySelectorAll<HTMLButtonElement>("button")].find(
            (b) => b.id === "mode-toggle-btn",
        )!;
    }
    return [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        b.innerText.startsWith(labelPrefix) || b.innerText.includes(labelPrefix),
    )!;
}

function typeUrl(root: HTMLElement, url: string): HTMLInputElement {
    const input = getUrlInput(root);
    input.value = url;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return input;
}

const URL_A = "https://audiotool.com/project/123";
const URL_B = "https://audiotool.com/project/456";

describe("Project URL survives AppUI re-renders without auto-connecting", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
        localStorage.clear();
    });

    it("1. Entering a URL mirrors it into runtime state", () => {
        const { root, app } = mount(new TestNexusAdapter());
        typeUrl(root, URL_A);
        expect((app as any).connectionUrl).toBe(URL_A);
        expect(getUrlInput(root).value).toBe(URL_A);
    });

    it("2+5+7. URL survives every known re-render without auto-connecting", () => {
        const { root, adapter, app } = mount(new TestNexusAdapter());
        typeUrl(root, URL_A);
        expect(adapter.openCalls).toBe(0);

        // render() represents the rebuilds triggered by device changes, preset
        // operations and automation ARM/REC/STOP/CLEAR/APPLY.
        app.render();
        expect(getUrlInput(root).value).toBe(URL_A);

        // Library open/close toggle rebuild.
        getButton(root, "Library").click();
        expect(getUrlInput(root).value).toBe(URL_A);
        getButton(root, "Library").click();
        expect(getUrlInput(root).value).toBe(URL_A);

        // EDIT -> USE -> EDIT rebuilds.
        getButton(root, "USE").click();
        expect(getUrlInput(root).value).toBe(URL_A);
        getButton(root, "EDIT").click();
        expect(getUrlInput(root).value).toBe(URL_A);

        // Undo/Redo rebuilds (via + Knob / Undo / Redo).
        getButton(root, "+ Knob").click();
        root.querySelector<HTMLButtonElement>("#history-undo")!.click();
        expect(getUrlInput(root).value).toBe(URL_A);
        root.querySelector<HTMLButtonElement>("#history-redo")!.click();
        expect(getUrlInput(root).value).toBe(URL_A);

        // None of the rebuilds attempted a connection on their own.
        expect(adapter.openCalls).toBe(0);
        expect(adapter.document).toBeNull();
    });

    it("3. USE -> EDIT keeps the URL", () => {
        const { root } = mount(new TestNexusAdapter());
        typeUrl(root, URL_A);
        getButton(root, "USE").click();
        getButton(root, "EDIT").click();
        expect(getUrlInput(root).value).toBe(URL_A);
    });

    it("4. Library toggle keeps the URL", () => {
        const { root } = mount(new TestNexusAdapter());
        typeUrl(root, URL_A);
        getButton(root, "Library").click();
        expect(getUrlInput(root).value).toBe(URL_A);
    });

    it("8. Restoring the URL never auto-connects", () => {
        const { root, adapter } = mount(new TestNexusAdapter());
        typeUrl(root, URL_A);
        for (let i = 0; i < 3; i++) {
            getButton(root, "Library").click();
        }
        getButton(root, "USE").click();
        getButton(root, "EDIT").click();
        expect(adapter.openCalls).toBe(0);
        expect(adapter.document).toBeNull();
    });

    it("9+10. Connect uses the current input value and replaces the stored URL", async () => {
        const { root, adapter, app } = mount(new TestNexusAdapter());
        typeUrl(root, URL_A);
        app.render();
        typeUrl(root, URL_B);
        app.render();
        await getButton(root, "Connect").onclick!({} as any);

        expect(adapter.lastUrl).toBe(URL_B);
        expect(adapter.openCalls).toBe(1);
        // The connected project's URL is now the stored runtime value.
        app.render();
        expect(getUrlInput(root).value).toBe(URL_B);
    });

    it("11. Connection failure keeps the URL available for retry", async () => {
        const { root, adapter, app } = mount(new TestNexusAdapter());
        typeUrl(root, URL_A);
        adapter.failNext = true;

        await getButton(root, "Connect").onclick!({} as any);
        expect(getStatusEl(root).innerText).toBe("Error");
        expect(adapter.openCalls).toBe(1);

        // URL still present in the live input and restored after a rebuild.
        expect(getUrlInput(root).value).toBe(URL_A);
        app.render();
        expect(getUrlInput(root).value).toBe(URL_A);

        // Retry with the very same URL now succeeds.
        await getButton(root, "Connect").onclick!({} as any);
        expect(getStatusEl(root).innerText).toBe("Connected");
        expect(adapter.lastUrl).toBe(URL_A);
    });

    it("12. Connection status behavior stays intact", async () => {
        const { root, adapter } = mount(new TestNexusAdapter());
        expect(getStatusEl(root).innerText).toBe("Disconnected");

        typeUrl(root, URL_A);
        await getButton(root, "Connect").onclick!({} as any);
        expect(getStatusEl(root).innerText).toBe("Connected");
        expect(getStatusEl(root).title).toBe("Connected");

        adapter.emitConnected(false);
        expect(getStatusEl(root).innerText).toBe("Sync lost — reconnect project");
        expect(getStatusEl(root).title).toBe("Sync lost — reconnect project");

        getButton(root, "USE").click();
        expect(getStatusEl(root).innerText).toBe("Sync lost — reconnect project");
        adapter.emitConnected(true);
        expect(getStatusEl(root).innerText).toBe("Connected");
        expect(adapter.subscribers.length).toBe(1);
    });

    it("13. URL input carries the compact-width class and CSS rules", () => {
        const { root } = mount(new TestNexusAdapter());
        expect(getUrlInput(root).className).toContain("conn-input");

        const css = readFileSync(resolve("src/ui/styles.css"), "utf8");
        expect(css).toMatch(/\.conn-field\s*{[^}]*flex:\s*0\s+1\s+260px[^}]*}/);
        expect(css).toMatch(/\.conn-input\s*{[^}]*min-width:\s*80px[^}]*}/);
        expect(css).toMatch(/\.conn-input\s*{[^}]*flex:\s*1[^}]*}/);
    });

    it("14. Connection status cannot expand the header indefinitely (CSS)", () => {
        const css = readFileSync(resolve("src/ui/styles.css"), "utf8");
        expect(css).toMatch(
            /\.conn-chip\s*{[^}]*max-width:\s*220px[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap[^}]*}/,
        );
    });
});