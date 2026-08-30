/**
 * CREATABLE ENTITY TYPES — evidence-based, probe-driven (production).
 *
 * The list below is NOT assumed: every entry was created successfully in a
 * real `@audiotool/nexus` v0.0.17 offline document with NO constructor args
 * (`t.create(type, {})` on a `validated:true` document). The probe runs again
 * in `poc/chain-clone/creatable-probe.test.ts` (kept live via the PoC
 * re-export) and asserts that the committed list below is EXACTLY the set
 * that still creates — so any SDK behavior change is caught.
 *
 * `PROBE_DEVICE_SLUGS` is derived from the SDK's own device-preset registry
 * (built-in `PRESET_DEVICE_TYPE_*` keys in `node_modules/@audiotool/nexus/dist`,
 * `index.js` `ke` map) plus the mixer infrastructure types observed in real
 * chains. Enumeration is manual because the SDK does not export a public
 * entity-type registry.
 *
 * Provenance: this module is the productive twin of `poc/chain-clone/creatable-types.ts`.
 * The PoC module re-exports from here so PoC tests keep running against the
 * same single source of truth.
 */

/** Device slugs every real chain can contain (probed, not guessed). */
export const PROBE_DEVICE_SLUGS: string[] = [
    // instruments / effects advertised by the SDK preset registry
    "autoFilter",
    "bandSplitter",
    "bassline",
    "beatbox8",
    "beatbox9",
    "crossfader",
    "curve",
    "exciter",
    "graphicalEQ",
    "gravity",
    "heisenberg",
    "helmholtz",
    "machiniste",
    "matrixArpeggiator",
    "gakki",
    "noteSplitter",
    "panorama",
    "pulsar",
    "pulverisateur",
    "quantum",
    "quasar",
    "rasselbock",
    "space",
    "stereoEnhancer",
    "stompboxChorus",
    "stompboxCompressor",
    "stompboxCrusher",
    "stompboxDelay",
    "stompboxFlanger",
    "stompboxGate",
    "stompboxParametricEqualizer",
    "stompboxPhaser",
    "stompboxPitchDelay",
    "stompboxReverb",
    "stompboxSlope",
    "stompboxStereoDetune",
    "stompboxTube",
    "tonematrix",
    "waveshaper",
    // previously probed additions
    "audioDevice",
    "centroid",
    "mixerChannel",
];

/** Entity types proven CREATABLE with default args (kept in sync by the probe test). */
export const KNOWN_CREATABLE_TYPES: ReadonlySet<string> = new Set([
    "autoFilter",
    "bandSplitter",
    "bassline",
    "beatbox8",
    "beatbox9",
    "crossfader",
    "curve",
    "exciter",
    "graphicalEQ",
    "gravity",
    "heisenberg",
    "helmholtz",
    "machiniste",
    "matrixArpeggiator",
    "gakki",
    "noteSplitter",
    "panorama",
    "pulsar",
    "pulverisateur",
    "quantum",
    "quasar",
    "rasselbock",
    "space",
    "stereoEnhancer",
    "stompboxChorus",
    "stompboxCompressor",
    "stompboxCrusher",
    "stompboxDelay",
    "stompboxFlanger",
    "stompboxGate",
    "stompboxParametricEqualizer",
    "stompboxPhaser",
    "stompboxPitchDelay",
    "stompboxReverb",
    "stompboxSlope",
    "stompboxStereoDetune",
    "stompboxTube",
    "tonematrix",
    "waveshaper",
    "audioDevice",
    "centroid",
    "mixerChannel",
]);