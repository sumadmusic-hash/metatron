// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Device } from "../../src/core/model/Device";
import { Group } from "../../src/core/model/Group";
import { Control } from "../../src/core/model/Control";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { DeviceHistory } from "../../src/core/history/DeviceHistory";
import { EditorUI } from "../../src/ui/editor/EditorUI";
import { Toast } from "../../src/ui/Toast";

let clipText = "";

/** Browser-API seam for navigator.clipboard (happy-dom has none) — the real
 *  production code paths (copyHex / pasteHex) run unchanged against it. */
function installClipboardSeam(readMode: "ok" | "reject" = "ok") {
    try {
        delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    } catch {
        // ignore — no prior own property
    }
    Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
            writeText: async (text: string) => {
                clipText = text;
            },
            readText: async () => {
                if (readMode === "reject") throw new Error("NotAllowedError");
                return clipText;
            },
        },
    });
}

function mount(): { host: HTMLElement; device: Device; library: DeviceLibrary; ui: EditorUI; history: DeviceHistory; control: Control; group: Group } {
    const device = new Device("Colors");
    const group = new Group("FILTER", { x: 100, y: 100 }, { width: 240, height: 180 });
    group.color = "#00FF88";
    device.addGroup(group);
    const control = new Control("knob", "CUTOFF", { x: 140, y: 140 });
    control.visualDefinition.color = "#7B61FF";
    device.addControl(control);

    const library = new DeviceLibrary();
    library.currentDevice = device;
    const history = new DeviceHistory(library);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const ui = new EditorUI(library, undefined, undefined, undefined, undefined, undefined, history);
    ui.render(host);
    return { host, device, library, ui, history, control, group };
}

function findBtn(scope: HTMLElement, text: string): HTMLButtonElement {
    const btn = Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === text);
    if (!btn) throw new Error(`button "${text}" not found`);
    return btn;
}

function clickBtn(btn: HTMLButtonElement) {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function flush() {
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function toastText(): string {
    return Array.from(document.body.querySelectorAll("div"))
        .map((d) => d.innerText ?? "")
        .join("\n");
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    vi.restoreAllMocks();
    clipText = "";
    const toastContainer = (Toast as unknown as { container: HTMLElement | null }).container;
    if (toastContainer) document.body.appendChild(toastContainer);
});

describe("Hex color copy/paste", () => {

    it("Test 1 — Control Copy writes the current hex value into the clipboard", async () => {
        installClipboardSeam();
        const { host, control } = mount();
        const tools = host.querySelector<HTMLElement>(`[data-ctl-id="${control.id}"] .control-tools`)!;

        clickBtn(findBtn(tools, "Copy"));
        await flush();

        expect(clipText).toBe("#7B61FF");
    });

    it("Test 2 — Group Copy writes the current hex value into the clipboard", async () => {
        installClipboardSeam();
        const { host, group } = mount();
        const toolbox = host.querySelector<HTMLElement>(`[data-grp-tools-for="${group.id}"]`)!;

        clickBtn(findBtn(toolbox, "Copy"));
        await flush();

        expect(clipText).toBe("#00FF88");
    });

    it("Test 3 — Control Paste #RRGGBB applies through the existing pipeline with exactly one control.color entry and undo", async () => {
        clipText = "#AABBCC";
        installClipboardSeam();
        const { host, library, history, control } = mount();
        const saveSpy = vi.spyOn(library, "saveCurrentDevice");
        const recordSpy = vi.spyOn(history, "record");
        const tools = host.querySelector<HTMLElement>(`[data-ctl-id="${control.id}"] .control-tools`)!;

        clickBtn(findBtn(tools, "Paste"));
        await flush();

        // Model changed
        expect(control.visualDefinition.color).toBe("#AABBCC");
        // DOM changed
        const visualArea = host.querySelector<HTMLElement>(`[data-ctl-id="${control.id}"] .control-visual-area`)!;
        expect(visualArea.style.background).toBe("#AABBCC");
        expect(tools.querySelector<HTMLElement>(".color-hex-label")!.textContent).toBe("#AABBCC");
        // `<input type=color>` always normalizes to lowercase (browser behavior).
        expect((tools.querySelector<HTMLInputElement>("input")!).value).toBe("#aabbcc");
        // Persistence through the real save path, exactly once
        expect(saveSpy).toHaveBeenCalledTimes(1);
        // Exactly one control.color history action
        expect(recordSpy).toHaveBeenCalledTimes(1);
        expect(recordSpy.mock.calls[0][0].type).toBe("control.color");
        expect(history.undoLength).toBe(1);
        // Undo restores the original color
        expect(history.undo()).toBe(true);
        expect(control.visualDefinition.color).toBe("#7B61FF");
    });

    it("Test 4 — Group Paste #RRGGBB applies with exactly one group.color entry and undo", async () => {
        clipText = "#123456";
        installClipboardSeam();
        const { host, library, history, group } = mount();
        const saveSpy = vi.spyOn(library, "saveCurrentDevice");
        const recordSpy = vi.spyOn(history, "record");
        const box = host.querySelector<HTMLElement>(`[data-grp-id="${group.id}"]`)!;
        const tools = host.querySelector<HTMLElement>(`[data-grp-tools-for="${group.id}"]`)!;

        clickBtn(findBtn(tools, "Paste"));
        await flush();

        expect(group.color).toBe("#123456");
        expect(box.querySelector<HTMLElement>(".group-header")!.style.background).toContain("rgba(18, 52, 86, 0.14)");
        expect(tools.querySelector<HTMLElement>(".group-hex-row .color-hex-label")!.textContent).toBe("#123456");
        expect((tools.querySelector<HTMLInputElement>(".group-color-input")!).value).toBe("#123456");
        expect(saveSpy).toHaveBeenCalledTimes(1);
        expect(recordSpy).toHaveBeenCalledTimes(1);
        expect(recordSpy.mock.calls[0][0].type).toBe("group.color");
        expect(history.undoLength).toBe(1);
        expect(history.undo()).toBe(true);
        expect(group.color).toBe("#00FF88");
    });

    it("Test 5 — Paste normalizes #RGB by expansion to #RRGGBB", async () => {
        clipText = "#abc";
        installClipboardSeam();
        const { host, control } = mount();
        const tools = host.querySelector<HTMLElement>(`[data-ctl-id="${control.id}"] .control-tools`)!;

        clickBtn(findBtn(tools, "Paste"));
        await flush();

        expect(control.visualDefinition.color).toBe("#AABBCC");
        expect(tools.querySelector<HTMLElement>(".color-hex-label")!.textContent).toBe("#AABBCC");
    });

    it("Test 6 — Paste normalizes mixed-case hex deterministically", async () => {
        clipText = "#7B61ff";
        installClipboardSeam();
        const { host, control } = mount();
        const tools = host.querySelector<HTMLElement>(`[data-ctl-id="${control.id}"] .control-tools`)!;

        clickBtn(findBtn(tools, "Paste"));
        await flush();

        expect(control.visualDefinition.color).toBe("#7B61FF");
        expect(tools.querySelector<HTMLElement>(".color-hex-label")!.textContent).toBe("#7B61FF");
    });

    it("Test 7 — Invalid hex values change nothing and raise an error toast", async () => {
        const { host, library, history, control } = mount();
        const saveSpy = vi.spyOn(library, "saveCurrentDevice");

        for (const bad of ["red", "rgb(255,0,0)", "#12", "#1234", "123456", "#gggggg", ""]) {
            clipText = bad;
            installClipboardSeam();
            const tools = host.querySelector<HTMLElement>(`[data-ctl-id="${control.id}"] .control-tools`)!;
            clickBtn(findBtn(tools, "Paste"));
            await flush();

            expect(control.visualDefinition.color, `model unchanged for "${bad}"`).toBe("#7B61FF");
            expect(saveSpy).not.toHaveBeenCalled();
            expect(history.undoLength).toBe(0);
            expect(toastText()).toContain("Invalid hex color");
        }
    });

    it("Test 8 — readText() rejection surfaces an error toast and changes nothing", async () => {
        installClipboardSeam("reject");
        const { host, library, history, control } = mount();
        const saveSpy = vi.spyOn(library, "saveCurrentDevice");
        const tools = host.querySelector<HTMLElement>(`[data-ctl-id="${control.id}"] .control-tools`)!;

        clickBtn(findBtn(tools, "Paste"));
        await flush();

        expect(control.visualDefinition.color).toBe("#7B61FF");
        expect(saveSpy).not.toHaveBeenCalled();
        expect(history.undoLength).toBe(0);
        expect(toastText()).toContain("Clipboard unavailable");
    });

    it("Test 9 — regression: a multi-input picker gesture still produces exactly one history entry", () => {
        installClipboardSeam();
        const { host, history, control } = mount();
        const swatch = host.querySelector<HTMLInputElement>(`[data-ctl-id="${control.id}"] input.color-swatch`)!;
        const tools = host.querySelector<HTMLElement>(`[data-ctl-id="${control.id}"] .control-tools`)!;

        swatch.value = "#112233";
        swatch.dispatchEvent(new Event("input", { bubbles: true }));
        swatch.value = "#445566";
        swatch.dispatchEvent(new Event("input", { bubbles: true }));
        swatch.dispatchEvent(new Event("change", { bubbles: true }));

        expect(control.visualDefinition.color).toBe("#445566");
        expect(tools.querySelector<HTMLElement>(".color-hex-label")!.textContent).toBe("#445566");
        expect(history.undoLength).toBe(1);
        expect(history.undo()).toBe(true);
        expect(control.visualDefinition.color).toBe("#7B61FF");
    });
});