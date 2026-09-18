// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { Device } from "../../src/core/model/Device";
import { DeviceLibrary } from "../../src/core/DeviceLibrary";
import { NexusAdapter } from "../../src/nexus/NexusAdapter";
import { MidiAccess } from "../../src/midi/MidiAccess";
import { BindingManager } from "../../src/core/BindingManager";
import { AppUI } from "../../src/ui/AppUI";

/**
 * B10 — die temporären PHASE-5-POC-Einstiegspunkte sind aus der Produktion
 * entfernt: der DevTools-Probe-Hook (__METATRON_PROBE__) in AppUI und die
 * POC-Pages im vite-Build. Die Kurven-Messung war ein einmaliger Runbook-
 * Vorgang; der Hook hatte einen "nach erfolgreichem Messen wieder entfernen"-
 * Kommentar und gehörte nicht in den Produktions-Bundle.
 */

beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
});

function mountAppUI() {
    const device = new Device("B10");
    const lib = new DeviceLibrary();
    lib.currentDevice = device;
    const root = document.createElement("div");
    document.body.appendChild(root);
    const app = new AppUI(root, lib, new NexusAdapter(), new MidiAccess(), new BindingManager(device));
    app.render();
    return { app };
}

describe("B10 — keine POC-Hooks mehr im Produktions-Pfad", () => {
    it("AppUI installiert keinen __METATRON_PROBE__-Hook mehr auf window", () => {
        const before = (window as any).__METATRON_PROBE__;
        mountAppUI();
        expect((window as any).__METATRON_PROBE__).toBeUndefined();
        expect(before).toBeUndefined();
    });
});