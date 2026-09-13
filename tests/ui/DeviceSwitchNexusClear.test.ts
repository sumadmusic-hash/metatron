// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Device } from "../../src/core/model/Device";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { BindingManager } from "../../src/core/BindingManager";
import { AppUI } from "../../src/ui/AppUI";

/** Two persisted devices; A is active in the app instance. */
function mount(active: Device, other: Device): { root: HTMLElement; adapter: NexusAdapter } {
    const lib = new DeviceLibrary();
    lib.currentDevice = active;
    lib.saveCurrentDevice();
    lib.currentDevice = other;
    lib.saveCurrentDevice();
    lib.loadDevice(active.id);

    const root = document.createElement("div");
    document.body.appendChild(root);
    const adapter = new NexusAdapter();
    new AppUI(root, lib, adapter, new MidiAccess(), new BindingManager(active)).render();
    return { root, adapter };
}

function row(root: HTMLElement, name: string): HTMLElement {
    return [...root.querySelectorAll<HTMLElement>(".device-list-item")].find((r) =>
        r.textContent?.includes(name),
    )!;
}

function click(el: HTMLElement) {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

describe("Nexus lifecycle on device switch (P3)", () => {

    it("switching to another device drops the previous device's Nexus subscriptions", () => {
        const { root, adapter } = mount(new Device("A"), new Device("B"));
        const clearSpy = vi.spyOn(adapter, "clearBoundControlSubscriptions");

        click(row(root, "B"));

        expect(clearSpy).toHaveBeenCalledTimes(1);
    });

    it("re-opening the SAME device (reload) keeps live subscriptions", () => {
        const { root, adapter } = mount(new Device("A"), new Device("B"));
        const clearSpy = vi.spyOn(adapter, "clearBoundControlSubscriptions");

        click(row(root, "A"));

        expect(clearSpy).not.toHaveBeenCalled();
    });
});