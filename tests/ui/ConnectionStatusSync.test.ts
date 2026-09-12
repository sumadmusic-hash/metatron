// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Device } from "../../src/core/model/Device";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { BindingManager } from "../../src/core/BindingManager";
import { AppUI } from "../../src/ui/AppUI";

class TestNexusAdapter extends NexusAdapter {
    public subscribers: ((connected: boolean) => void)[] = [];

    public override async openProject(_url: string, _bindingManager?: any): Promise<void> {
        this.document = { connected: { subscribe: vi.fn(), getValue: () => true } } as any;
    }

    public override isDocumentConnected(): boolean {
        return this.document !== null;
    }

    public override onDocumentConnectedChanged(callback: (connected: boolean) => void): () => void {
        this.subscribers.push(callback);
        callback(true);
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

function getStatusEl(root: HTMLElement): HTMLElement {
    return root.querySelector<HTMLElement>(".connection-status")!;
}

function getButton(root: HTMLElement, labelPrefix: string): HTMLButtonElement {
    return [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        b.innerText.startsWith(labelPrefix) || b.innerText.includes(labelPrefix),
    )!;
}

describe("Connection status updates target the currently mounted DOM element", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
        localStorage.clear();
    });

    it("1. Initial connection status renders correctly as Disconnected", () => {
        const { root } = mount(new TestNexusAdapter());
        const el = getStatusEl(root);
        expect(el).toBeTruthy();
        expect(el.innerText).toBe("Disconnected");
    });

    it("2. After connecting, the visible status shows the connected state", async () => {
        const { root, adapter } = mount(new TestNexusAdapter());
        const urlInput = root.querySelector<HTMLInputElement>("input[placeholder='Audiotool Project URL...']")!;
        urlInput.value = "https://audiotool.com/project/123";

        const connectBtn = getButton(root, "Connect");
        await connectBtn.onclick!({} as any);

        const el = getStatusEl(root);
        expect(el.innerText).toBe("Connected");
        expect(adapter.subscribers.length).toBe(1);
    });

    it("3-5. Header rebuild (EDIT → USE) retains connection and updates visible status on connection loss", async () => {
        const { root, adapter } = mount(new TestNexusAdapter());
        const urlInput = root.querySelector<HTMLInputElement>("input[placeholder='Audiotool Project URL...']")!;
        urlInput.value = "https://audiotool.com/project/123";
        await getButton(root, "Connect").onclick!({} as any);

        // 3. Rebuild header by switching EDIT → USE
        getButton(root, "USE").click();

        // Active element in USE mode shows Connected
        const elUse = getStatusEl(root);
        expect(elUse.innerText).toBe("Connected");

        // 4. Emit connection-loss event
        adapter.emitConnected(false);

        // 5. The currently visible status element changes to the sync-loss text
        expect(getStatusEl(root).innerText).toBe("Sync lost — reconnect project");
    });

    it("6. Rebuild header again (USE → EDIT) preserves state and continues updating on reconnect", async () => {
        const { root, adapter } = mount(new TestNexusAdapter());
        const urlInput = root.querySelector<HTMLInputElement>("input[placeholder='Audiotool Project URL...']")!;
        urlInput.value = "https://audiotool.com/project/123";
        await getButton(root, "Connect").onclick!({} as any);

        getButton(root, "USE").click();
        adapter.emitConnected(false);
        expect(getStatusEl(root).innerText).toBe("Sync lost — reconnect project");

        // Rebuild header again (USE → EDIT)
        getButton(root, "EDIT").click();
        const elEdit = getStatusEl(root);
        expect(elEdit.innerText).toBe("Sync lost — reconnect project");

        // Subsequent reconnect updates the newly mounted element
        adapter.emitConnected(true);
        expect(getStatusEl(root).innerText).toBe("Connected");
    });

    it("7. Repeated renders do not create duplicate visible updates or duplicate listeners", async () => {
        const { root, adapter } = mount(new TestNexusAdapter());
        const urlInput = root.querySelector<HTMLInputElement>("input[placeholder='Audiotool Project URL...']")!;
        urlInput.value = "https://audiotool.com/project/123";
        await getButton(root, "Connect").onclick!({} as any);

        expect(adapter.subscribers.length).toBe(1);

        // Repeated renders via Library toggle and mode switches
        for (let i = 0; i < 4; i++) {
            getButton(root, "Library").click();
        }
        getButton(root, "USE").click();
        getButton(root, "EDIT").click();

        // Exactly one listener remains subscribed on the adapter
        expect(adapter.subscribers.length).toBe(1);

        adapter.emitConnected(false);
        expect(getStatusEl(root).innerText).toBe("Sync lost — reconnect project");

        adapter.emitConnected(true);
        expect(getStatusEl(root).innerText).toBe("Connected");
    });
});
