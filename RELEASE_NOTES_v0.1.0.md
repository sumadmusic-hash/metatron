# Metatron v0.1.0 — Initial Stable Release


## Overview
Metatron is a browser-based controller and macro editor for [Audiotool](https://www.audiotool.com/). It connects to an Audiotool project through the Nexus API and lets you design reusable controller layouts — virtual controls that map onto the parameters of any device chain — then save, share, and recall them as instrument presets.


## Key Features
- **Device Library**: Create, manage, and persist controller layouts (knobs, switches, groups)
- **Chain Clone**: Clone an Audiotool device chain from the live project into a new location, with structure verification
- **Instrument Presets**: Export a device with its control bindings and referenced chain as a versioned preset (.json)
- **MIDI Integration**: Full Web MIDI support for hardware controllers, including Learn workflow and value scaling
- **Automation Recording**: Record control gestures as Audiotool automation and write them back into the live project
- **Undo/Redo**: Complete undo history for every device edit (session-scoped, 100 actions)
- **Preset Morphing**: Smoothly blend between two presets with a single Morph slider


## Critical Fixes in v0.1.0
- **Bootstrap Stability**: Fixed a critical crash where corrupted localStorage would cause a white-screen-of-death on app start. The app now gracefully handles storage errors and starts with an empty state.
- **History Stability**: Fixed a crash in the Undo/Redo system when loading corrupted device snapshots. Corrupted devices are now skipped during history capture, preserving the rest of the session.


## Architecture
- Mutable Object Graph + Constructor Injection + Callback-DI
- No UI framework, no state-management library, no event bus
- TypeScript ~6.0.2, Vite ^8.2.2, Vitest ^4.1.11
- 837 tests across 74 files


## Known Issues (Planned for v0.2.0)
- ~~Reconnecting to the same project clears all active bindings (no same-URL check).~~ **Fixed** (`22981ed`)
- ~~Async import race: Device switch during import may persist state to the wrong device.~~ **Fixed** (`f09d0c6`)
- ~~Preset library data loss: Corrupted localStorage entries are silently discarded.~~ **Fixed** (`e0923ee`)


## Installation
```bash
git clone https://github.com/sumadmusic-hash/metatron.git
cd metatron
npm install
npm run dev
```