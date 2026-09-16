# Bedienungsanleitung – Metatron

Metatron ist eine MIDI-/Controller-Oberfläche im Browser für Audiotool. Du baust
virtuelle Geräte mit Reglern und Schaltern, verbindest sie mit einem Audiotool-Projekt
und steuerst dort live Parameter.

---

## 1. Überblick

- **Edit-Modus:** Du baust und gestaltest dein Gerät (Regler, Schalter, Gruppen, Farben).
- **Use-Modus:** Du bedienst dein Gerät live.
- **Gerätebibliothek:** Verwalte mehrere Geräte, Presets und Instrument-Presets.
- **Modulationsmatrix:** Extrahiere LFO/Macro/Random-Modulation auf deine Regler.
- **Automation:** Zeichne Parameter-Gesten auf und schreibe sie als Automation nach Audiotool.
- **Morph:** Blende weich zwischen zwei Presets um (A ↔ B).

---

## 2. Erste Schritte

1. Öffne die App. Die Kopfzeile zeigt **EDIT MODE** (aktives Modus-Badge) und den Button `USE`.
2. Erstelle dein erstes Gerät: **Device Library → `+ New Device`** („My Device").
3. Füge Regler hinzu: Edit-Toolbar → `+ Knob`, `+ Switch`, `+ Group`.
4. Starte die Live-Bedienung über `USE` (der Button schaltet in den Use-Modus).

> Tipp: In welchem Modus du bist, siehst du immer am Badge in der Kopfzeile
> (blau = **EDIT MODE**, grün = **USE MODE**).

---

## 3. Kopfzeile (Toolbar)

| Element | Funktion |
|---|---|
| Titel + Device-Name | Zeigt das am umgebenden Device |
| Mode-Badge | Dauerhaft sichtbarer Hinweis auf den aktiven Modus |
| `Library` | Blendet die Gerätebibliothek ein/aus |
| URL-Feld + `Connect` | Verbindet mit einem Audiotool-Projekt |
| Status | „Connected", „Disconnected", „Connecting…", „Error", „Sync lost…" |
| `Undo` / `Redo` | Macht Aktionen rückgängig / wiederholt sie (Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z) |
| `MOD` | Öffnet/schließt die Modulationsmatrix |
| `USE`/`EDIT` | Schaltet den Modus um (zeigt das Ziel, nicht den aktuellen Modus) |

Unter der Kopfzeile liegt die **Automationsleiste** (`ARM`, `REC`, `STOP`, `APPLY TO AUDIOTOOL`, `CLEAR`), siehe Kapitel 8.

---

## 4. Edit-Modus – Geräte bauen

### 4.1 Regler und Schalter

- **`+ Knob`** fügt einen Drehregler hinzu (`Control-Typ knob`).
- **`+ Switch`** fügt einen Schalter hinzu (`Control-Typ switch`).
- **`+ Group`** legt eine beschriftete Gruppe als Fläche an.
- Max. **32 aktive Regler/Schalter** pro Gerät.

### 4.2 Bewegen & Größen ändern

- Klicken eines Controls wählt es aus (Zieh-Handles erscheinen im Edit-Modus).
- Ziehen verschiebt; an den Ecken gezogen ändert sich die Größe.
- **Snap:** Der Button `Snap: ON`/`Snap: OFF` schaltet ein 20‑Pixel‑Raster um.
- **Escape** bricht eine laufende Zieh-Geste ab (kein History-Eintrag).

### 4.3 Parameter eines ausgewählten Controls

Zwei Zeilen oberhalb des Cursors bei Auswahl:

- **Zeile 1:** `Learn` (Bind an Audiotool), `Forget`, `MIDI` (Lernen eines Hardware-CC), Gruppen-Zuordnung (`— no group —` oder Gruppennamen).
- **Zeile 2:** Farbwähler (`<input type="color">`), Hex-Label, `Copy`/`Paste` (Hex/Wischen), `✕` Löschen.

### 4.4 Löschen

- Ausgewählten Regler löschen: **Entf/Backspace** (Archivierung – Preset-Verweise bleiben gültig) oder die `✕` im Parameter-Panel.
- Gruppen löschen: nur über `Delete Selected` in der Werkzeugleiste oder das `✕` der Gruppe (Entf gilt nur für Regler).
- Löschen/Schalter im Use-Modus nicht verfügbar.

> In Textfeldern (Eingaben) löschen Tasten normal, nicht Controls!

---

## 5. Use-Modus – live bedienen

- **Regler (Knob):** Senkrecht nach oben/unten ziehen (direkt auf dem Regler).
- **Schalter (Switch):** Klicken schaltet zwischen 0/1 um.
- **Gruppen** sind im Use-Modus rein dekorativ (keine Interaktion).
- Bei Auswahl eines Controls erscheint eine Aktionleiste mit:
  - `Learn` – Parameter-Bindung an Audiotool (wie im Edit-Modus),
  - `MIDI` – MIDI-Learn,
  - MIDI-Anzeige (`Unmapped` oder `Ch N / CC N`) + `Unmap`,
  - Skalierung: `min`, `max`, `flip` und `exp` (Exponent).

---

## 6. Gerätebibliothek & Presets

### 6.1 Geräte

- `+ New Device` legt „My Device" bzw. „My Device N" an.
- Klick auf ein Gerät der Liste öffnet es (das aktuelle Gerät wird vorher gespeichert).
- Aktionen des aktiven Geräts: `Save`, `Rename` (Inline-Eingabe; Enter=übernehmen, Escape=verwerfen).
- Löschen: `✕` → Bestätigung „Delete device "…"? This cannot be undone." → `Delete`/`Cancel`.
- Beim Start wird das **zuletzt benutzte** Gerät wiederhergestellt.

### 6.2 Presets (Regler-Zustände)

- Name eingeben → `Save` speichert einen Preset-Zustand des Geräts.
- Jeder Preset hat: `A`/`B` (Morph-Zuordnung), `✎` Umbenennen, `Load`, `✕` Löschen.

### 6.3 Morph (A ↔ B)

- Weise je einen Preset auf `A` und `B` zu (erneutes Klicken hebt die Zuordnung auf).
- Statuszeile: `A: <Name>  B: <Name>` – ist keine Zuweisung vorhanden, steht **Not set**.
- Der Slider (0–100 %) blendet zwischen A und B. Regler in beiden Presets werden interpoliert, Schalter quantisiert (0/1).
- **Wichtig:** Der Morph-Zustand ist flüchtig (nicht gespeichert) und wird beim Gerätewechsel zurückgesetzt.

### 6.4 Instrument-Presets (Audiotool)

- Erfordert eine **verbundene** Audiotool-Projektverbindung (siehe Kapitel 7). Das verbundene Projekt ist **Quelle** beim Export und **Ziel** beim Import.
- `Export` überträgt die Projekt-Kette + gebundene Regler in die Bibliothek.
- `Export .json` lädt zusätzlich eine JSON-Datei herunter (Name: `<name>.metatron-preset.json`).
- `Import .json` übernimmt zuvor exportierte Dateien. Vor dem Import fragt die App nach: „Import "…" into the connected project? This creates devices and cables there."

---

## 7. Verbindung zu Audiotool

1. Kopiere die Projekt-URL in das Feld **„Audiotool Project URL…"**.
2. Drücke `Connect` – die App autorisiert per OAuth (`project:write`) und synchronisiert per WebSocket.
3. Der Status zeigt `Connected` (grün), während der Verbindung `Connecting…` (gelb), bei Fehlern `Error`/`Sync lost – reconnect project`.

**Was synchronisiert wird:**
- Wenn du einen Regler bewegst, wird der gebundene Audiotool-Parameter live geschrieben.
- Fremde Parameteränderungen im Projekt fließen zurück und bewegen den Regler.
- `Learn` bindet einen Audiotool-Parameter an ein Control; `Forget` hebt die Bindung auf.

> MIDI läuft **lokal** (Web MIDI, keine SysEx) und unabhängig von der Audiotool-Verbindung.

---

## 8. Modulationsmatrix (`MOD`)

Die Matrix hat zwei Spalten: **Sources** (Quellen) und **Routing** (Zuordnungen).

### 8.1 Quellen (max. 10)

Jede Quelle ist ein `lfo`-, `macro`- oder `random`-Typ (Anzeige `mod1 · LFO` usw.):

- **LFO:** Wellenform `sine`/`triangle`/`saw`/`square`/`sampleHold`/`smoothRandom`, Modus `Free`/`Sync` (Sync: Notenwerte `1/1` … `1/32`), Frequenz bzw. Divisionswert, Phasen-Offset, `Enable`.
- **Macro:** `Source` = ein Regler des Geräts (`— none —` = keiner), `Enable`.
- **Random:** `Smooth` (ms), `Drift`, `Enable`.

### 8.2 Routings (max. 20)

Pro Slot: Quellen-Wahl → `→` Ziel-Wahl (ein Control deines Geräts) → `Amount` (%-Slider −100…+100) → `On` (Aktivierung).

- **Spalten-Highlight:** Ist ein Routing aktiv oder angewählt/gehovered, wird die zugehörige Quellzeile links hervorgehoben.
- **Zeilenhöhe:** Die Routing-Zeilen gleichen ihre Höhe automatisch an die Quellzeilen an.

### 8.3 Bake

`Bake` öffnet einen Dialog (`Bars`, `Grid` 1/16 oder 1/32). Er rendert die Matrix offline als Automation und schreibt sie über die Audiotool-Verbindung ins Projekt (`Baked N track(s) into automation (…s).`).

---

## 9. Automation – Aufnahme

1. `ARM` armiert einen Take („Armed – press REC to record").
2. `REC` startet die Aufnahme (Anzeige `RECORDING` + Zeitmesser `● 0.0s`).
3. `STOP` finalisiert den Take (Übersicht: `Take: N Controls · Dauer`).
4. `APPLY TO AUDIOTOOL` schreibt die Aufnahme als echte Automation ins Projekt (nur bei verbundener Verbindung aktiv).
5. `CLEAR` verwirft den Take lokal – es wird **nichts** aus Audiotool entfernt.

**Erfasst wird:** alle Änderungen am Control-Wert – Use-Modus-Ziehbewegungen, MIDI-Eingang, Audiotool-Fernänderungen und Morph. Die Aufnahme speichert normalisierte Werte (0–1) mit min. 40 ms Abstand (~25 Hz).

> Hinweis während der Aufnahme: „Audiotool and Metatron must remain visible at the same time for live sound feedback."

---

## 10. Undo / Redo

- Bis zu **100 Aktionen** pro Session (Älteste werden verdrängt).
- Erfasst werden strukturelle Aktionen (Control hinzufügen/verschieben/färben/archivieren, Gruppen, Presets, Renames, Matrix-Änderungen, Geräte-Erstellen/Löschen, Imports).
- **Nicht** erfasst: reine Wertänderungen (Regler-Ziehbewegungen, MIDI, Morph-Amount), zu kleine Zieh-Gesten, unveränderte Renames.
- **Wichtig:** Der Verlauf ist sessionsbezogen und übersteht **keinen Reload**.

---

## 11. Tastatur-Shortcuts

| Taste | Aktion |
|---|---|
| Cmd/Ctrl+Z | Undo |
| Shift+Cmd/Ctrl+Z | Redo |
| Ctrl+Y | Redo |
| Entf / Backspace | Ausgewählten Regler archivieren (Edit-Modus) |
| Escape | Aktives Learn abbrechen; Drag-Geste abbrechen; Rename-Prompt verwerfen |
| Enter | Rename-Prompt übernehmen |

Shortcuts greifen nicht, wenn ein Textfeld fokussiert ist.

---

## 12. Speichern

- Geräte, Presets und die Modulationsmatrix liegen im **localStorage** des Browsers.
- Disk-Export/Import geschieht über `Export .json` / `Import .json` (Instrument-Presets).
- Das Verbinden trennt Geräte-Persistenz von der Audiotool-Synchronisation: Deine Geräte bleiben in Metatron, die Projekt-Kette bleibt in Audiotool.

---

## 13. Grenzen & Konstanten

| Größe | Wert |
|---|---|
| Regler/Schalter pro Gerät | 32 (aktiv) |
| Modulations-Quellen | 10 |
| Modulations-Routings | 20 |
| History | 100 Aktionen/Session |
| Snap-Raster | 20 px |
| Drag-Schwelle | 4 px |
| Automations-Sampling | min. 40 ms Abstand |
| MIDI-Learn-Timeout | 60 s |

---

## 14. Häufige Fragen

**Ich sehe keine Bedienelemente, wo kann ich Regler hinzufügen?**
Du bist vermutlich im Use-Modus. Das Badge prüfen (blau = EDIT MODE) und mit dem
Toolbar-Button `EDIT` umschalten. Erst im Edit-Modus erscheinen `+ Knob`, `+ Switch`, `+ Group`.

**Warum bleibt der Export-Button ohne Wirkung?**
Für Instrument-Export/-Import muss eine Audiotool-Projektverbindung bestehen –
das verbundene Projekt ist SOURCE für den Export und TARGET für den Import.

**Warum kann ich eine Gruppe nicht mit Entf löschen?**
Entf/Backspace archivert nur Regler. Gruppen löscht du über `Delete Selected` oder das kleine `✕` der Gruppe.

**Steuern lässt sich manches am Audiotool-Cluster nicht?**
Nur gebundene Controls (per `Learn`) schreiben nach Audiotool; ein Control ohne Bindung verhält sich rein lokal.

**Morph: Wo bleibt mein Zustand nach dem Neuladen?**
Morph-A/B und -Amount sind flüchtig und werden beim Gerätewechsel zurückgesetzt – niemals persistiert. Verwende Presets für beständige Zustände.