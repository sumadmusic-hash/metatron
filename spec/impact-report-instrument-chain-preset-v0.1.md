# SPEC IMPACT REPORT — Metatron Instrument + Chain + Preset v0.1

Datum: 2026-08-30
Status des Auftrags: **Analyse ohne Produktivcode-Änderungen** (`src/` unverändert).

Basis für dieses Urteil:

- **Live-Nachweis Chain-Clone:** `CHAIN CLONE: PASS` (echtes SOURCE-Projekt
  `38e6b0b9-1888-4148-9f3b-c8e86510f140` → TARGET `77c45a2f-2f2b-4b09-b874-77f740b8e503`,
  4 Devices, 93 Parameterwerte, 3 Cables, Topologie verifiziert, `failures: []`).
- **Productive Metatron-Modelle:** `src/core/model/*`, `src/nexus/*`, `src/core/BindingManager.ts`.
- **POCs:** `poc/chain-clone`, `poc/chain-clone-live`, `poc/chain-discovery`.

---

## 1. Welche Teile existieren bereits?

| Spec-Teil | Vorhanden? | Wo |
| --- | --- | --- |
| `ChainSnapshot` | **Ja (bewiesen, serialisierbar)** | `poc/chain-clone/types.ts:60` (Typ), `poc/chain-clone/snapshot.ts` (`createSnapshot`, `serializeSnapshot`, `parseSnapshot`). Verwendet in Chain-Discovery. Real Live-PASS. |
| Chain-Engine (Entities/Parameter/Cables/Topologie) | **Ja (bewiesen)** | `poc/chain-clone/clone.ts` (`cloneChainFromSnapshot` Zeile 479, `cloneChainToDoc`), pure Planung `planning.ts`, Verifikation `verify.ts` (`buildTargetDigest` :46, `compareSnapshotWithTarget` :70). |
| Source→Target Mapping | **Ja** | `CloneResult.idMap` (`clone.ts`/`clone.offline.test.ts`), keine Wiederverwendung von Source-IDs (`idMapUsesNoSourceIds`, offline getestet). |
| Capability-Gate (§7 vor jeder Mutation) | **Ja** | `poc/chain-clone-live/report.ts` (`assessRequiredCapabilities`), `poc/chain-clone/api-capabilities.ts`, Evidenz `creatable-types.ts` + `creatable-probe.test.ts` (42/42). |
| MetatronDevice (Controls/Groups/Layout/Visual/Control-Namen) | **Ja** | `src/core/model/Device.ts`, `Control.ts`, `Group.ts`, `types.ts` (`VisualDefinition`, `Position/Size`). Serialisierung vorhanden; Persistenz `src/persistence/Storage.ts` (localStorage `metatron_devices`). |
| MetatronPreset (Name + Control-Werte) | **Ja** | `src/core/model/Preset.ts` (`controlValues: Record<controlId, number>`). |
| Binding-Definitionen (projektunabhängig, persistent) | **Teilweise** | Nur `Control.audiotoolBindingDefinition` (`targetName?`, `types.ts:23`). Die **logische** Referenz (Entity-Index + `fieldPath`) fehlt. |
| Active Bindings (projektspezifisch, Laufzeit) | **Ja** | `src/core/BindingManager.ts:6` `ActiveBinding` (`entityId/fieldName/fieldPath/valueMapping/field`) — bewusst transient. |
| `NexusValueMapping` (§5/§6) | **Ja, 1:1 passend** | `src/nexus/NexusValueMapping.ts` (`kind: "linear"|"boolean"`, `min/max/isInteger`) + `mapNormalizedToNexus`/`mapNexusToNormalized`. |
| Werteschreiben 0..1 → Nexus (§6) ohne Learn | **Ja** | `NexusAdapter.updateBoundControl` + `resolveField` (Dot-Path/Nested/Array, `NexusAdapter.ts:149`). |
| „Kein erneutes Learn“-Ersetzung | **Machbar** | `BindingManager.setBinding(controlId, entityId, fieldName, targetName?, field, fieldPath?, valueMapping?)` ist exakt der Pfad, den auch `applyLearnResult` nutzt. |

## 2. Welche vorhandenen Modelle können wiederverwendet werden?

1. `ChainSnapshot` 1:1 als `chain.snapshot` (Envelope §3).
2. `CloneResult.idMap` für Schritt 8 der Import-Reihenfolge (§7) und §4.
3. `Device`/`Control`/`Group`/`Preset` inkl. Serialisierung für die Metatron-Seite.
4. `NexusValueMapping` als `valueMapping` der Bindings (§5) und für Preset-Anwendung + Verifikation (§6).
5. `ActiveBinding`/`BindingManager.setBinding` + `NexusAdapter.resolveField`/`updateBoundControl`/`subscribeBoundControl` für „Bindings auf Target-Entities auflösen“ + „Preset anwenden“.
6. `CAPABILITY_TABLE` + Gate + `creatable-probe` für Schritt 3 und die finale Verifikation.
7. CSV/Bericht-Aufbau aus `poc/chain-clone-live/report.ts` für die neue `INSTRUMENT IMPORT:`-Verdict-Familie.

## 3. Welche Änderungen wären für `InstrumentPreset` notwendig?

- **Neues, reines, serialisierbares Envelope-Modell** (kein Klassen-Umbau):

  ```ts
  interface InstrumentPreset {
    version: "0.1";
    name: string;
    metatron: {
      deviceId: string;          // Metatron-lokal (device.id), KEINE Audiotool-Entity-ID
      presetId: string;          // Metatron-lokal (Preset.id)
      controlValues: Record<string, number>; // controlId → 0..1 (siehe Präzisierung 3)
    };
    chain: { snapshot: ChainSnapshot };
    bindings: Array<{
      controlId: string;
      sourceEntityIndex: number; // Index in snapshot.devices (logische Reihenfolge)
      fieldPath: string;         // z. B. "filter.cutoffFrequencyHz"
      valueMapping: NexusValueMapping;
    }>;
  }
  ```

- **Wohin gehören die bindings?** Zwei Optionen, beide konsistent; Empfehlung **Envelope**:
  - **Empfohlen: Envelope-Ebene (§3).** `Control.audiotoolBindingDefinition` bleibt unangetastet
    (projektunabhängige *Display*-Metadaten mit `targetName`). Keine Verschachtelung der
    Device-Serialisierung mit Chain-Wissen; keine Berührung der Layout-Versions-Migration.
  - Alternativ: `NexusBindingDefinition` erweitern (`sourceEntityIndex?`, `fieldPath?`).
    Maximiert Wiederverwendung, zieht aber Chain-Snapshots in `Device.serialize` — mehr
    Migrationsfläche, weniger sauber. Unter „das Projekt darf die Struktur anpassen“ ist die
    Envelope-Variante die geringere Änderung.
- **`presetId`/`deviceId` = Metatron-IDs** (nicht Audiotool). Passt zu §4 (Audiotool-IDs sind
  niemals Identität).
- **Neue Verdict-Familie** `INSTRUMENT IMPORT: PASS|PARTIAL|BLOCKED` + Bericht-Sektionen
  `Bindings` und `Preset Values` (§8) — analog zum bestehenden Clonereport.

## 4. Wie kann das bestehende `ChainSnapshot` verwendet werden?

- Als **Datenquelle und spätere Import-Fabrik**: `chain.snapshot` wird direkt an
  `cloneChainFromSnapshot(snapshot, targetDoc, …)` übergeben (Schritte 4–8 der Reifenfolge).
- `devices[]` ist **geordnet** (`discoverChainLive`-Reihenfolge) → `sourceEntityIndex` =
  Position in `devices[]`. Das muss als Definition festgeschrieben werden (Präzisierung 1).
- `rootCandidates` dient der Root-Validierung beim Import.
- `serializeSnapshot`/`parseSnapshot` sind vorhanden → Preset-Persistenz ist JSON-Roundtrip.
- Source-IDs in `sourceEntityId` werden ausschließlich für den Rückweg über `idMap` genutzt,
  nie als Ziel-IDs (live bewiesen).

## 5. Wie werden bestehende `ActiveBinding`-Definitionen integriert?

- `ActiveBinding` ist **bewusst transient** (projektspezifisch, `BindingManager.onProjectLoaded`
  setzt Bindings beim Projektwechsel zurück → `DISCONNECTED`). Das bleibt so.
- Die **persistente, logische** Referenz trägt der neue `bindings[]` im Envelope
  (`controlId → sourceEntityIndex → fieldPath → valueMapping`).
- **Import-Schritt 9** ruft exakt die vorhandene Stelle auf, die sonst `applyLearnResult`
  benutzt: `BindingManager.setBinding(controlId, idMap.get(index), topLevelFieldName,
  targetName?, field, fieldPath, valueMapping)` → `activeBindingState = CONNECTED`,
  danach `NexusAdapter.subscribeBoundControl(controlId)`. Kein neues Learn, kein neuer
  Verdrahtungsweg. `ActiveBinding` selbst muss **nicht** verändert werden.

## 6. Wie wird das bestehende `NexusValueMapping` verwendet?

- 1:1 als `valueMapping` jeder Binding (§5) und für die Preset-Werte (§6).
- **Export:** Mapping aus der Snapshot-Schema-Metadaten (bereits in `FieldSnapshot`:
  `range`, `scalarType`, `defaultValue`) ableiten → serialisierbar ohne Live-Feld.
  Achtung: `createNexusValueMapping(field)` braucht ein Live-Feldobjekt; für den Export
  muss entweder am SOURCE-Dokument gecaptured oder ein reiner Builder
  `(range, scalarType) → NexusValueMapping` ergänzt werden (kleiner, reiner Zusatz).
- **Import (§10):** `mapNormalizedToNexus` für die Werteschreibung, `mapNexusToNormalized`
  für die Re-Lese-Verifikation (§8 „Preset Values PASS“). `unsupported`-Mappings → Write
  verweigern (gleiche Regel wie `updateBoundControl`) → ehrlich `PARTIAL`/`BLOCKED`.
- **Konsistenzquelle:** Parameter-`range` ist typ-/schema-schlüsselgebunden; LIVE-Beweis
  zeigt gleiche Ranges auf SOURCE und TARGET. Ein Guard beim Import (Schema-Primitivtyp +
  Range-Abstand gleich) stellt Drift fest, statt zu raten.

## 7. Welche Teile des Chain-Clone-POCs können produktiv übernommen werden?

| Modul | Übernahme |
| --- | --- |
| `poc/chain-clone/snapshot.ts` (`createSnapshot`, `captureFields`) | Ja — als Import-Datenbasis (read-only). |
| `poc/chain-clone/clone.ts` (`cloneChainFromSnapshot`, `CloneResult.idMap`) | Ja — Menüsteuerung des Imports; bereits additiv exportiert. |
| `poc/chain-clone/planning.ts` (pure Planung + Ranges/immutable) | Ja — übernehmen (gleiche Semantik). |
| `poc/chain-clone/verify.ts` (`buildTargetDigest`, `compareSnapshotWithTarget`) | Ja — erweitern um Bindings/Preset-Werte (§8). |
| `poc/chain-clone/api-capabilities.ts` + `creatable-probe.test.ts` + Gate (`chain-clone-live/report.ts`) | Ja — Gate-Modul für Schritt 3 + finale Verifikation. |
| `poc/chain-clone-live/main.ts` (Phasen-Orchestrierung, OAuth) | Modell für den Import-Flow; Reihenfolge §7 strikt einhalten. |
| POCs selbst | Werden **eingefroren** als Beweismaterial; nur die obenstehende Minimalfläche wandert nach `src/`. |

## 8. Risiken / Architekturkonflikte

Kein **Konflikt** gefunden. Verbleibende Punkte (alle adressierbar, keine Revision):

1. **`sourceEntityIndex` muss definiert werden** = Index in `ChainSnapshot.devices`
   (Reihenfolge der Discovery). Absicherung durch Bounds-Check + Root-Fixierung (v0.1:
   genau eine Chain/Root pro Preset). *Kein Konflikt, benötigt Festschreibung.*
2. **`controlValues`:** `Preset.controlValues` ist `Record<string, number>`; Spec erlaubt
   `number | boolean`. Metatron speichert Switch-Werte bereits als 0/1-Zahl →
   **Präzisierung:** Booleans werden als 0/1 normalisiert — keine Strukturbruch, kein Umbau.
3. **Mapping-Herkunft:** Export braucht Mapping ohne Live-Feld (s. §6). Kleines reines Builder
   ergänzen oder am SOURCE capturen. Kein Konflikt, kleiner Zusatz.
4. **Wohin mit den Bindings** (Envelope vs. `Control.audiotoolBindingDefinition`): Envelope
   empfohlen, um Device-Migration/`serialize` nicht anzutasten. Entscheidung dieser Spec.
5. **Bestehende Definitions schützen:** Import darf vorhandene `audiotoolBindingDefinition`
   nicht überschreiben (nur Envelope-Bindings neu anlegen). Sonst Verlust von Layout-Metadaten.
6. **`onProjectLoaded`** leert `activeBindings` → Import muss rebinden + resubscriben
   (unterstützt, s. §5).
7. **I1 (max. 32 aktive Controls):** Preset-Import in ein bestehendes Device kann an die
   Grenze stoßen → Guard + ehrlicher Verdict (skip/block), kein Workaround.
8. **`unsupported`-Mapping/immutable-Feld** → Write verweigern (bestehende Regel), Verdict
   ehrlich.

## 9. Welche Tests müssen ergänzt werden?

Alle **offline zuerst** (vor Produktivcode), dann Live-Capability-Test:

- **Pur (ohne Nexus):** Envelope-Roundtrip (`serialize`/`parse`), `version`-Guard,
  Validierung (Index in Bounds, `fieldPath` existiert in `snapshot.devices[i].fields`,
  Mapping-`kind` gesetzt).
- **Export-Builder:** SOURCE (real offline) → `InstrumentPreset`: controlValues
  normalisiert 0..1; Bindings aus Controls mit Binding-Definition; Mapping aus Schema.
- **Import (offline, via `cloneChainToDoc`):** Snapshot klonen → `idMap` → Bindings auf
  Target-Felder auflösen → `setBinding` (CONNECTED) → Preset anwenden (`mapNormalizedToNexus`)
  → erwartete Nexus-Werte lesen. Fälle: linear, integer, boolean, `unsupported` → BLOCKED.
- **Verifikation erweitert:** `bindings.equal` PASS (jede Binding löst auf Live-Feld auf);
  `presetValues.equal` PASS (Re-Lesen → `mapNexusToNormalized` → normalized == Preset-Wert
  innerhalb float32-Toleranz).
- **Regression:** neue Module dürfen die 255 bestehenden Tests nicht brechen.
- **Live-Capability-Test (neues POC oder Erweiterung `chain-clone-live`):** Import in ein
  zweites echtes Projekt → `INSTRUMENT IMPORT: PASS` (alle 6 Sektionen PASS, echte Mutation,
  keine UI-Behauptung).

## 10. Implementierungsreihenfolge (erst nach Freigabe)

- **A – Pure Modelle:** Envelope `InstrumentPreset` + Serialisierung + Validierung, Tests. *(kein Nexus)*
- **B – Export:** SOURCE-Dokument → `InstrumentPreset` (reuse `createSnapshot`/`captureFields`),
  Mapping-Ableitung.
- **C – Import-Engine (offline):** `cloneChainFromSnapshot` + `idMap` + Bindings-Auflösung
  + Preset-Anwendung + erweitertes `verify`. Offline-Suite.
- **D – Live-Capability-Test:** Import-Schritt im Live-Flow reproduzieren → `INSTRUMENT IMPORT:`-Verdict.
- **E – Produktintegration (NUR wenn D PASS + Freigabe):** Minimalfläche nach `src/`
  (z. B. `src/core/instrument/` o. ä.), `Storage`-Persistenz, UI-Trigger, Verdrahtung
  `BindingManager`/`NexusAdapter`. Ausschlüsse aus §9 der Spec bleiben außerhalb v0.1.

---

# URTEIL

```
SPEC v0.1: CONSISTENT
```

**Begründung:** Das Spec-Datenmodell bildet sich 1:1 auf vorhandene, einzeln getestete
Bausteine ab (`ChainSnapshot`, Clone-Engine + `idMap`, `Preset`, `NexusValueMapping`,
`ActiveBinding`/`setBinding`, Capability-Gate). Der Live-Beweis der Chain-Übertragung deckt
die Schritte 1–8 der Import-Reihenfolge bereits ab. Es existiert **kein architektonischer
Widerspruch**; Änderungen sind rein additiv und kompatibel (`INSTRUMENT IMPORT`-Verdict,
`bindings[]` im Envelope, erweitertes Verify). Vier Punkte müssen **festschreibend
präzisiert** werden (keine Revision): (1) `sourceEntityIndex` ≡ Index in `snapshot.devices`,
(2) `controlValues` als 0/1-Zahlen, (3) Mapping-Ableitung beim Export, (4) Bindings im
Envelope statt in `Control.audiotoolBindingDefinition`. Implementierung erst nach Freigabe.