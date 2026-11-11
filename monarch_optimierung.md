# monarch: weniger Credits beim Hauptagenten

**Ziel:** Der Hauptagent wird seltener geweckt und liest pro Runde weniger. Co-Agenten bauen und testen selbst.
**Umfang:** Punkte 1–4. Reihenfolge der Umsetzung: 2 → 1 → 3 → 4 (4 setzt 1 voraus).
**Erfolg:** Bei einem Job wie Marathon-Release 2.0.x (10 Pakete) entfallen alle `inspect`-Runden für Standardpakete, es gibt keine `-1`-Dateien mehr, und der Hauptagent führt selbst keine Builds/Tests mehr aus, außer in Stufe B.

---

## 1. Repo-Stand für Co-Agenten (`ATTACH: repo-snapshot`)

**Problem:** Co-Agenten haben nur bis zu 20 Einzeldateien. Kein Build, keine Tests → der Hauptagent prüft alles selbst.

**Verhalten**
- Neue Anhangsform `ATTACH: repo-snapshot` in `spawn` und `send` (nicht in `inspect`).
- Optionale Config `autoSnapshot: "off" | "spawn"` (Standard `"off"`). Bei `"spawn"` hängt monarch den Snapshot an jeden `spawn` an.
- Inhalt des Archivs `repo-snapshot.zip`:
  - alle Dateien aus `git ls-files -co --exclude-standard` im Workspace-Root (also getrackt + nicht ignoriert, inklusive lokaler, nicht gepushter Änderungen)
  - darüber gelegt: alle bereitgehaltenen Dateien (je Pfad die zuletzt gelieferte Version)
  - nie: `.git`, `.monarch/`, Python-Caches, `*.pyc`
  - Datei `SNAPSHOT.md` im Archiv-Root: Branch, HEAD-SHA, Liste lokal geänderter Dateien, Liste der überlagerten bereitgehaltenen Dateien mit Quelle (`staged by <id>`)
- Zählt als 1 der 20 Anhänge. Grenze `maxSnapshotMB` (Standard 20). Wird sie überschritten → Befehl ablehnen, die 5 größten Verzeichnisse nennen.
- Die Relay-Zuordnung zeigt `repo-snapshot.zip = <branch>@<sha7> + <n> staged`.
- Gelöschte Dateien kann der Snapshot nicht abbilden; in `SNAPSHOT.md` als „nicht enthalten“ vermerken, falls monarch Löschungen kennt.

**Offene Prüfung vor der Umsetzung (blockiert nicht)**
- Haben Co-Agenten Internet? Testlauf mit einem Co-Agenten: `curl -sI https://nodejs.org` und `pip download pytest`. Ohne Internet laufen Projekt-Setups wie `python build.py` (lädt Node/PostgreSQL) nicht; dann bleibt nur pytest ohne DB bzw. reiner Code-Review. Ergebnis in der README von monarch festhalten.
- Bekannte Falle: `git clone` direkt nach `/workspace/...` scheitert in der Sandbox (`chmod on .git/config.lock`); entpacken/klonen nach `/tmp` funktioniert.

**Tests (monarch)**
- Snapshot enthält getrackte und neue nicht-ignorierte Dateien, keine ignorierten (`.venv`, `node_modules`, `.data`).
- Bereitgehaltene Datei überschreibt die Repo-Version im Archiv; `SNAPSHOT.md` listet sie.
- Größer als `maxSnapshotMB` → Ablehnung mit Meldung, kein Spawn.
- `autoSnapshot: "spawn"` hängt genau einmal an, auch wenn der Auftrag zusätzlich `ATTACH: repo-snapshot` enthält.

---

## 2. Keine Suffix-Kopien (`-1`, `-2` …)

**Problem:** Co-Agenten folgen der Plattformregel „vorhandene Ausgabedateien nie überschreiben“ und liefern Korrekturen als `pfad-1.ext`. Das kostet pro Korrektur zusätzliche Runden und landet als falsche Datei im Repo.

**Verhalten in monarch**
1. **Fester Vorspann** vor jedem `spawn` und `send` an einen Co-Agenten (von monarch eingefügt, nicht vom Hauptagenten):
   ```text
   [monarch files] Liefere jede Datei vollständig unter /workspace/output/<repo-pfad>, mit LF-Zeilenenden. Vorhandene Dateien dort überschreibst Du unter demselben Pfad. Keine Kopien mit Suffix (-1, -2, …).
   ```
2. **Rückabbildung beim Download** (Config `normalizeSuffixCopies: true`, Standard `true`). Liefert ein Co-Agent `X-<n>.<ext>` (n ≥ 1) und existiert `X.<ext>` im Repo oder ist bereitgehalten, wird die Datei als `X.<ext>` bereitgehalten. Gibt es in derselben Lieferung mehrere Suffixe, gilt das höchste n. Im Relay erscheint die Zeile `warning: <X-n.ext> mapped to <X.ext>`.
3. **Zeilenenden prüfen:** Enthält eine gelieferte Textdatei CRLF, die Repo-Version aber LF (oder sie ist neu und `.gitattributes`/Repo-Mehrheit ist LF), dann im Relay `warning: CRLF in <pfad>`. Optional `normalizeLineEndings: true` → automatisch auf LF umstellen.

**Änderung in den MiniZilla-Anweisungen (awork-Agent-Konfiguration)**
Im Abschnitt zur Dateiausgabe ergänzen:
```text
Im monarch-Betrieb (Nachricht enthält [monarch files]) überschreibst Du Repo-Dateien in /workspace/output/ unter demselben Pfad. Die allgemeine Regel, vorhandene Ausgabedateien nicht zu überschreiben und Suffixe wie -1 anzuhängen, gilt dort nicht.
```

**Tests (monarch)**
- `tests/test_run-1.py` bei vorhandenem `tests/test_run.py` → bereitgehalten als `tests/test_run.py`, Warnung im Relay.
- `foo-1.py` ohne vorhandenes `foo.py` → bleibt `foo-1.py`.
- CRLF-Datei → Warnung bzw. LF bei `normalizeLineEndings: true`.

---

## 3. Diffs direkt im Relay statt eigener `inspect`-Runde

**Problem:** Für jede Sachprüfung braucht es eine eigene Runde (`inspect`). In ihr liest der Hauptagent den gesamten Kontext erneut, nur um die Dateien zu bekommen.

**Verhalten**
- Config `relayDiff: "inline" | "attach" | "off"` (Standard `"inline"`), `relayDiffMaxKB` (Standard 40).
- Für jede Datei, die seit dem letzten Relay neu bereitgehalten wurde, erzeugt monarch einen unified diff mit 3 Kontextzeilen:
  - Pfad war vorher schon bereitgehalten → Diff gegen die **vorige bereitgehaltene Version** (Kopfzeile `diff (delta to previous staged)`)
  - sonst → Diff gegen die **lokale Repo-Version** bzw. vollständiger Inhalt bei neuen Dateien (Kopfzeile `diff (vs local repo)` / `new file`)
- Block im Relay:
  ```text
  diffs:
  --- <pfad> (staged by <id>, vs local repo, +<a> -<d>)
  <unified diff>
  ```
- Summe über `relayDiffMaxKB` → die größten Diffs werden stattdessen als Anhänge mitgeschickt (wie bei `inspect`, inklusive der Zuordnungszeilen). Im Text steht `diff for <pfad> attached (too large)`.
- `relayDiff: "attach"` → immer als Anhang `<name>.diff` statt inline.
- Die Warnungen aus Punkt 2 (Suffix, CRLF) stehen direkt vor den Diffs.
- `inspect` bleibt für Sonderfälle erhalten.

**Tests (monarch)**
- Erste Lieferung einer Datei → Diff gegen Repo; Korrektur derselben Datei → nur Delta zur vorigen Version.
- Überschreiten von `relayDiffMaxKB` → Anhang statt inline, Hinweiszeile vorhanden.
- Binärdatei → nur Zeile `binary <pfad> changed (<größe>)`.

---

## 4. Prüfung durch einen Reviewer-Co-Agenten statt durch den Hauptagenten

**Voraussetzung:** Punkt 1, also ein Reviewer mit vollständigem Repo-Stand und lauffähigen Tests.

### Änderungen im Skill `skills/monarch-main-agent/SKILL.md`

**a) Abschnitt „Review nach Risiko“ (Punkt 7) ersetzen durch:**
```text
7. Review nach Risiko: Lege die Stufe je Paket in der Taskliste fest.
   - Stufe A – Reviewer-Prüfung: mechanische, vollständig spezifizierte Pakete ohne Wartestellen, Nebenläufigkeit, Persistenz oder Sicherheitsbezug. Ein Reviewer-Co-Agent mit ATTACH: repo-snapshot prüft die Pakete einer Welle gemeinsam: alle DONE-WHEN-Befehle, die gesamte Testsuite, Build, Diff gegen Briefing. Du liest Verdict, Prüfbericht und die Diffs aus dem Relay; eigene lokale Läufe nur, wenn ein Beleg fehlt oder widersprüchlich ist.
   - Stufe B – Reviewer und Sachprüfung: Wartestellen, Timer, Threads, Prozesse, Sperren, Stopp-/Abschlusslogik, Persistenz, Sicherheits- oder Datenrelevanz, Integration über mehrere Dateien sowie jedes Paket, das in Stufe A durchgefallen ist. Reviewer wie in Stufe A, zusätzlich Deine Sachprüfung anhand der Relay-Diffs (siehe Punkt 10).
   - Integration: Am Ende ein Reviewer über alle bereitgehaltenen Dateien mit ATTACH: repo-snapshot und dem Gesamt-DONE-WHEN.
   VERDICT: pass ist eine technische Vorabnahme, keine inhaltliche Freigabe.
```

**b) Abschnitt „Sachprüfung“ (Punkt 10) ersetzen durch:**
```text
10. Sachprüfung: Prüfe anhand der Diffs im Relay (kein inspect, solange die Diffs vollständig sind) inhaltlich und logisch, ob Paket und Ziel des Nutzers erreicht sind: Übereinstimmung mit Briefing und Taskliste, nichts Zusätzliches, jede geänderte Warte- oder Abschlussstelle, Endbedingungen und die Belege im Reviewer-Bericht. Lokale Tests führst Du nur in Stufe B oder bei fehlenden bzw. widersprüchlichen Belegen aus. Ohne bestandene Sachprüfung kein commit.
```

**c) Pflichtinhalt des Reviewer-Berichts (neu, nach Punkt 7 einfügen):**
```text
Reviewer-Bericht (Pflicht, sonst gilt das Review als unvollständig):
- VERDICT: pass | fail
- RUN: jeder ausgeführte Befehl mit Exit-Code und Kurzergebnis (z. B. „pytest: 74 passed“)
- BASELINE: für Fehlerkorrekturen der Lauf am Basisstand (erwartet FAIL) mit Ergebnis
- FILES: geänderte Dateien mit +/- Zeilen
- DEVIATIONS: Abweichungen vom Briefing oder „none“
- FIXED: selbst behobene Kleinigkeiten mit Datei:Zeile oder „none“
```

**d) Briefing-Vorlage (Punkt 4): Zeile ergänzen**
```text
ENVIRONMENT: ATTACH: repo-snapshot; entpacken nach /tmp/repo; Setup: <projektspezifischer Befehl, z. B. python3 build.py>; Tests: <Befehle>
```

### Änderung in den CodeZilla-Anweisungen (awork-Agent-Konfiguration)
Im Abschnitt „Rolle und Ziel“ den Satz
> „… prüfst deren Ergebnisse vor jeder Übernahme selbst inhaltlich und logisch gegen Martins Ziel.“

ergänzen um:
> „Grundlage der Prüfung sind die Diffs im Relay und der Bericht des Reviewer-Co-Agenten. Eigene lokale Tests nur in Stufe B oder bei fehlenden Belegen.“

### Erwarteter Ablauf nach der Umstellung
1. Taskliste, dann Welle mit bis zu 3 Workern (`ATTACH: repo-snapshot`), dazu ein Reviewer per `AFTER:` auf alle Worker der Welle
2. Ein Relay, nachdem der Reviewer fertig ist: Verdict, Bericht, Diffs
3. Hauptagent: Sachprüfung auf Basis der Diffs → nächste Welle oder Korrektur per `send`
4. Am Ende Integrations-Reviewer, `commit`, `stopzilla`

Statt rund 3 Hauptagent-Runden pro Paket (Relay, `inspect`, Prüfen) bleibt etwa 1 Runde pro Welle.

---

## Abnahme gesamt
- [ ] Ein Co-Agent mit `ATTACH: repo-snapshot` kann im Marathon-Repo `python3 build.py` und die gesamte pytest-Suite ausführen, oder es ist dokumentiert, warum nicht (Internet)
- [ ] Eine Korrektur an einer bereits gelieferten Datei landet unter demselben Pfad, ohne `-1`-Datei im Repo
- [ ] Ein Relay nach einer Worker-Lieferung enthält Diffs; für ein Standardpaket ist keine `inspect`-Runde nötig
- [ ] Skill und Agenten-Anweisungen sind wie oben angepasst; ein Testjob mit 3 Paketen braucht höchstens 5 Hauptagent-Runden
