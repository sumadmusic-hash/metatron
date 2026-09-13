<div align="center">

# Metatron

**Configurable Controller and Macro Editor for Audiotool**

[![Build](https://img.shields.io/badge/build-tsc%20%2B%20vite-ok-success)](https://github.com/sumadmusic-hash/metatron)
[![Tests](https://img.shields.io/badge/tests-837%20passing%20%7C%2074%20files-2ea44f)](https://github.com/sumadmusic-hash/metatron)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178c6)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-8.2-646cff)](https://vite.dev/)
[![Vitest](https://img.shields.io/badge/Vitest-4.1-fcc72b)](https://vitest.dev/)
[![Nexus](https://img.shields.io/badge/%40audiotool%2Fnexus-0.0.17-444444)](https://www.npmjs.com/package/@audiotool/nexus)
[![License](https://img.shields.io/github/license/sumadmusic-hash/metatron)](https://github.com/sumadmusic-hash/metatron)

</div>

---

## Overview

Metatron is a browser-based **controller and macro editor** for [Audiotool](https://www.audiotool.com/). It connects to an Audiotool project through the Nexus API and lets you design reusable controller layouts — virtual controls that map onto the parameters of any device chain — then save, share, and recall them as *instrument presets*.

It turns your DAW-in-a-browser into a patchable instrument. If you build Audiotool tracks, use a hardware MIDI controller, or want to morph between sounds, Metatron gives you a device-centric workspace: create a device, capture the connected chain, bind controls to any parameter, and recall the whole setup later.

> **Live Demo:** [https://metatron-lake.vercel.app](https://metatron-lake.vercel.app)

## Features

- **Device Library** — create, manage, and persist controller layouts. Each device is a named set of controls (sliders, knobs, buttons) that stays local to your browser.
- **Chain Clone** — clone an Audiotool device chain (e.g. `Synth → FX → FX`) from the live project into a new location, with structure verification after the clone.
- **Instrument Presets** — export a device together with its control bindings and the referenced chain as a versioned preset. Presets are stored locally and can be downloaded/imported as `.json` files.
- **MIDI Integration** — full [Web MIDI](https://developer.mozilla.org/en-US/docs/Web/API/Web_MIDI_API) support for hardware controllers, including a MIDI cloning ["Learn"](https://developer.mozilla.org/en-US/docs/Web/API/MIDIMessageEvent) workflow and value scaling.
- **Automation Recording** — record your control gestures as Audiotool automation and write them back into the live project.
- **Undo/Redo** — complete undo history for every device edit, with device-scoped snapshots (`payload-undo` / `payload-redo`).
- **Preset Morphing** — smoothly blend between the values of two presets with a single Morph amount slider.

## Quick Start

### Prerequisites

- **Node.js** `^20.19.0` or `>=22.12.0` (Vite 8 requirement)
- **npm** `10+`

### Installation

```bash
git clone https://github.com/sumadmusic-hash/metatron.git
cd metatron
npm install
```

### Development

```bash
npm run dev
```

Vite serves the app locally; open the printed URL (default `http://localhost:5173`).

### Build

```bash
npm run build
```

Runs `tsc` for type-checking and bundles the production assets with Vite into `dist/`.

### Test

```bash
npm test
```

Runs the full Vitest suite (~837 tests in 74 files). See [Testing](#testing).

### Preview

```bash
npm run preview
```

Serves the production build from `dist/` for a local smoke test.

## Environment Variables

| Variable | Description |
| --- | --- |
| `VITE_AUDIOTOOL_CLIENT_ID` | Your Audiotool OAuth client ID (secret is never used client-side). |

Copy [`.env.example`](.env.example) to `.env.local` and adjust if you use your own OAuth client:

```bash
cp .env.example .env.local
```

If unset, the app falls back to the shared development client id used by the Metatron PoC. The app's origin must be registered as a redirect origin for the chosen client.

## Architecture Overview

Metatron is a plain **TypeScript** application with a **mutable object graph** at its core: there is no reactive framework, no event bus, and no global state container. Components receive their dependencies via *constructor injection*, and data flows upward through *callback dependency injection* (e.g. `DeviceLibraryUI → AppUI.onDeviceChanged`). The UI is rendered by rebuilding the DOM (`render-by-rebuild`), which keeps every view a pure function of the current model state.

The codebase is split into layered, dependency-tested modules: `core` (pure model, history, preset engines), `nexus` (Audiotool Nexus SDK bridge: live chain discovery, snapshots, cloning, value mapping), `midi` (Web MIDI + scaling), `automation` (gesture recording), `persistence` (localStorage libraries + the file bridge), and `integration` (thin orchestration that wires core engines to the live document). See [`spec/impact-report-instrument-chain-preset-v0.1.md`](spec/impact-report-instrument-chain-preset-v0.1.md) for a deep dive into the instrument-preset pipeline.

## Project Structure

```
src/
├── main.ts              # Entry point
├── core/                # Pure model: Device, DeviceLibrary, BindingManager,
│                        #   history (undo/redo), Preset, PresetMorph,
│                        #   instrument/ (envelope model, export, import)
├── ui/                  # App shell + sidebar: AppUI, DeviceLibraryUI,
│                        #   surface/ + editor/ (canvas editors), Toast
├── nexus/               # Audiotool Nexus bridge: NexusAdapter, live chain
│                        #   discovery, ChainSnapshot, ChainClone, verification,
│                        #   value mapping + Learn workflow
├── midi/                # Web MIDI: MidiAccess, MidiLearn, MidiMapping, scaling
├── automation/          # Recording of control gestures + automation writer
├── persistence/         # localStorage libraries (Storage, InstrumentPresetLibrary)
│                        #   and the browser FileAdapter (.json import/export)
└── integration/         # Orchestration between core, nexus and persistence
                        #   (InstrumentPresetIntegration, PresetMorphIntegration)
```

A `poc/` folder contains the working proofs-of-concept (chain discovery, chain clone live, instrument preset live) that migrated into the production modules.

## Testing

Run the whole suite:

```bash
npm test
```

- **837 tests across 74 files** — all passing
- Tests are colocated under `tests/`, mirroring `src/`
- UI tests run inside `happy-dom` (per-file `@vitest-environment happy-dom`), architecture/persistence tests keep pure Node environments

```bash
# Single file, watch mode
npx vitest run tests/persistence/FileAdapter.test.ts
```

## Deployment

Metatron is a static Vite build deployed on **Vercel**.

```bash
npm run build
vercel --prod
```

The current live build is available at [https://metatron-lake.vercel.app](https://metatron-lake.vercel.app).

## License

This project is **not licensed** — no `LICENSE` file is present. All rights reserved by the author. Contact the repository owner before reusing any part of the codebase.

## Acknowledgments

- The **Audiotool team** for building the open [Nexus API](https://www.npmjs.com/package/@audiotool/nexus) that makes the live-project bridge possible.
- Contributors and testers who helped harden the chain cloning, instrument-preset, and MIDI workflows.