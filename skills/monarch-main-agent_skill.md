---
name: monarch-main-agent
description: Regeln für Chats über monarch (VS-Code-Chatfenster für awork-Agenten) aus Sicht des Hauptagenten - ORCA-Befehle (spawn, send, cancel, wait, inspect, commit, stopzilla, notes), die Marker [monarch context], [monarch relay] und [monarch notes], Dateien nach /workspace/output/, Repo-Snapshot und Diffs im Relay, Delegation an Co-Agenten (Taskliste .monarch/tasks.md, Briefing, Review-Stufen, Sachprüfung, Übernahme), Robuste Abläufe und pytest-Testweg. Immer laden, wenn eine Nachricht einen dieser Marker enthält oder Co-Agenten beauftragt, geprüft oder Dateien übernommen werden sollen.
---

# Monarch: Hauptagent

## Arbeiten über monarch

monarch ist ein VS-Code-Chatfenster für awork-Agenten. Es verbindet Dich mit dem geöffneten Repo des Nutzers, startet Co-Agenten für Dich und schreibt Dateien ins lokale Repo. Du arbeitest nur dann über monarch, wenn der Chat eine `[monarch context]`-Zeile enthält.

### Repo-Kontext

- Die Zeile `[monarch context] "this repo" = …` steht am Ende der ersten Nachricht eines Chats und erneut, wenn sie sich ändert (anderes Repo, Link oder Branch, lokale Änderungen kommen oder gehen). Bis dahin gilt die letzte. „Dieses Repo“ ist das dort genannte, in VS Code geöffnete Repo.
- Lies das Repo über den angegebenen Link, soweit Dir ein Lesezugriff zur Verfügung steht; der Link zeigt nur den gepushten Stand. Angehängte Dateien haben Vorrang vor dem Link: Lies sie aus den Uploads, nicht aus dem Repo.
- Steht dort „not online“, sage dem Nutzer, dass er das Repo zuerst hochladen muss. Weicht der lokale Stand ab (Hinweis auf lokale Änderungen oder nicht gepushte Commits), bitte bei Bedarf um die betroffenen Dateien als Anhang.

### Notizen

- Am Ende einer Nachricht kann ein Block `[monarch notes] … [/monarch notes]` stehen: der Notizzettel des Nutzers zu diesem Chat (nicht im Repo). Er kommt nur, wenn sich die Notizen seit Deiner letzten Nachricht geändert haben. Nutze ihn als Kontext.
- Mit `### ORCA: notes` ersetzt Du den gesamten Notizzettel durch den darauf folgenden vollständigen Text (leer = löschen). Übernimm bestehende Einträge unverändert, sofern der Nutzer sie nicht ändern lassen will.
- Hat der Nutzer die Notizen nach Deiner letzten Nachricht geändert, wird der Befehl abgelehnt und Du erhältst seine aktuelle Fassung.
- `notes` darf mit jedem anderen Befehl kombiniert werden und weckt keinen Co-Agenten.

### Dateien ins Repo schreiben

- Speichere jede Datei für das Repo vollständig mit ihrem Repo-Pfad in `/workspace/output/`, z. B. `/workspace/output/src/app.py` für `src/app.py`.
- monarch lädt nach jeder Antwort alle in diesem Lauf neu erstellten oder geänderten Dateien herunter und schreibt sie in den ersten geöffneten Workspace-Ordner; vorhandene Dateien werden überschrieben. Geschrieben werden nur Pfade innerhalb des Repos (keine absoluten Pfade, kein `..`, nichts in `.git`), Python-Caches nie.
- Überarbeite Repo-Dateien unter demselben Pfad. Lege keine Entwürfe, Zwischenstände oder `-1`-Kopien in `output/` ab, weil jede dort geänderte Datei im Repo landet. Arbeitsdateien gehören nach `scratch/`.
- Liefere niemals `.pyc`-Dateien. Schreibe keine Dateiinhalte zusätzlich in die Antwort ab.
- Meldet monarch eine Datei als `not downloaded` oder `not written`, nenne sie dem Nutzer als offenen Punkt. Eigene Dateien sind nach Deiner Antwort bereits im Repo, wenn monarch anschließend Deine ORCA-Befehle ausführt.

## Co-Agenten steuern (ORCA-Befehle)

Der Delegationsweg besteht nur, wenn monarch mit `coAgentId` konfiguriert ist. Sonst behaupte keine gestarteten Co-Agenten, gib keine ausführbaren ORCA-Aufträge aus und benenne dem Nutzer die fehlende Verbindung. Starte, befrage oder ändere Co-Agenten nie über eigene Agenten-API-Aufrufe.

**Format:** ORCA-Blöcke stehen nach sämtlichem Text für den Nutzer am Ende Deiner Antwort. Ein Block beginnt mit einer Header-Zeile `### ORCA: <befehl> [ziel]` und endet am nächsten Header oder am Ende der Antwort. Setze aktive Blöcke nicht in Code-Fences; Beispiele in Dokumentationen gehören in Code-Fences und werden nicht ausgeführt. Eine Antwort ohne ORCA-Block beendet Deinen Zug.

| Header | Inhalt | Wirkung |
|---|---|---|
| `### ORCA: spawn` | vollständiger Auftrag; optional mehrere `AFTER:`- und `ATTACH:`-Zeilen | Reserviert `<co_agent_name>_N` sofort und startet nach erfolgreichen Abhängigkeiten |
| `### ORCA: send <co_agent_name>_N` | Antwort oder gebündelte Korrekturen, bei Bedarf `ATTACH:` | Nachricht an einen Co-Agenten |
| `### ORCA: cancel <co_agent_name>_N` | keiner | Stoppt diesen Co-Agenten (auch einen wartenden Spawn) und gibt seinen Platz frei |
| `### ORCA: wait` | keiner | Wartet weiter auf arbeitende oder wartende Co-Agenten, etwa nach einem Relay-Timeout |
| `### ORCA: inspect` | eine oder mehrere `ATTACH:`-Zeilen | Nur für Sonderfälle (die Diffs im Relay ersetzen es im Normalfall): sendet Dir sofort die angegebenen Dateien als Anhänge; weckt keinen Co-Agenten, schreibt nichts ins Repo |
| `### ORCA: commit` | keiner | Schreibt alle bereitgehaltenen Co-Agent-Dateien ins lokale Repo; fehlgeschlagene bleiben bereitgehalten |
| `### ORCA: stopzilla` | keiner | Stoppt alle Co-Agenten und schließt den Job |
| `### ORCA: notes` | vollständiger neuer Text des Notizzettels | Ersetzt die Notizen dieses Chats (siehe „Notizen“) |

**Abhängigkeiten und Anhänge:**
- `AFTER: <co_agent_name>_N` bezeichnet einen vorhandenen Co-Agenten, `AFTER: spawn_K` den K-ten Spawn-Block derselben Antwort (ab 1). Mehrere `AFTER:`-Zeilen bedeuten: alle müssen erfolgreich antworten. Eine Abhängigkeit mit `STATUS: question`, `blocked` oder `plan` oder ein Abbruch verhindert den Start und weckt Dich. Gib deshalb bei `plan-first` keinen Spawn mit `AFTER:` auf diesen Co-Agenten in derselben Antwort aus.
- `ATTACH: <repo-pfad>` hängt die bereitgehaltene Version der Datei an, sonst die lokale Repo-Datei. `ATTACH: <co_agent_name>_N` hängt alle bereitgehaltenen Dateien dieses Co-Agenten an. `ATTACH: spawn_K` hängt beim Start die Dateien des K-ten Spawn-Blocks derselben Antwort an.
- `ATTACH: repo-snapshot` (nur in `spawn` und `send`, nicht in `inspect`) hängt `repo-snapshot.zip` an: alle getrackten und nicht ignorierten Dateien des lokalen Repos inklusive lokaler, nicht gepushter Änderungen, darüber alle bereitgehaltenen Dateien, ohne `.git`, `.monarch/` und Python-Caches, dazu `SNAPSHOT.md` (Branch, HEAD, lokal geänderte, überlagerte und gelöschte Dateien; gelöschte fehlen im Archiv). Die Befehlszeile zeigt `repo-snapshot.zip = <branch>@<sha7> + <n> staged`. Mit `autoSnapshot: "spawn"` hängt monarch ihn an jeden `spawn` genau einmal an. Überschreitet er `maxSnapshotMB` (Standard 20), wird der Befehl mit den 5 größten Ordnern abgelehnt.
- Maximal 20 Anhänge pro Nachricht (der Snapshot zählt als einer), je Datei höchstens `maxFolderMB` (Standard 20 MB). Unsichere Pfade werden abgelehnt.
- In `inspect` hängt `ATTACH: repo:<repo-pfad>` die lokale Repo-Version an (z. B. als Basisstand einer bereitgehaltenen Datei). Die Antwort kommt als `[monarch relay] inspect` mit den Anhängen und einer Zuordnung `<Dateiname> = <Repo-Pfad>, <Quelle>` (`staged by <id>` oder `local repo`; gleiche Namen erhalten `-2`, `-3`, …). `inspect` steht nicht zusammen mit `spawn`, `send`, `wait`, `commit` oder `stopzilla` in einer Antwort; bei mehr als 20 Dateien mehrere Runden.

**Relay:** monarch wartet auf die Co-Agenten, ohne dass Du läufst (keine Agent-Credits beim Warten), und weckt Dich mit `[monarch relay]`:
- wenn alle arbeitenden Co-Agenten geantwortet haben,
- sofort bei einer Antwort mit `STATUS: question`, `blocked` oder `plan`, auch wenn andere noch arbeiten,
- nach `relayTimeout` (Standard 600 s). Die Meldung enthält dann `progress (working co-agents):` mit Schrittzahl und den letzten drei Schritten jedes arbeitenden Co-Agenten (oder `steps not readable`).

Die Meldung listet die bereitgehaltenen Dateien je Co-Agent (`files (staged, not in the repo yet): …`), Download-Warnungen und die Credits getrennt (`credits: agent …, co-agents …`). Für jede seit dem letzten Relay neu bereitgehaltene Datei folgt im Abschnitt des Co-Agenten ein Block `diffs:` mit unified diff (3 Kontextzeilen) und Kopfzeile `--- <pfad> (staged by <id>, <art>, +<a> -<d>)`; Art `delta to previous staged` (Pfad war schon bereitgehalten), `vs local repo` oder `new file`; Binärdateien nur als `binary <pfad> changed (<größe>)`. Übersteigen die Diffs zusammen `relayDiffMaxKB` (Standard 40), kommen die größten als Anhang `<name>.diff` (`diff for <pfad> attached (too large)`, Zuordnung unter `attachments (file name = repo path, source):`). Direkt vor den Diffs stehen die Warnungen `<X-n.ext> mapped to <X.ext>` (Suffix-Kopie auf den Originalpfad abgebildet) und `CRLF in <pfad>`.

**Bereitgehaltene Dateien:** Dateien von Co-Agenten schreibt monarch nicht direkt ins Repo. Es hält sie außerhalb des Repos bereit (je Pfad die zuletzt gelieferte Version), bis Du `commit` ausführst. `commit` schreibt immer alle bereitgehaltenen Dateien. Ein neuer Chat verwirft alle bereitgehaltenen Dateien. monarch stellt jeder Nachricht an einen Co-Agenten den Vorspann `[monarch files]` voran: Lieferung unter demselben Repo-Pfad, LF-Zeilenenden, keine Suffix-Kopien.

**Limits:** Credits und Co-Agent-Zahl sind je Chat begrenzt (`maxCredits`, `maxCoAgentCredits`, `maxCoAgents`). Das Erreichen einer Credit-Grenze stoppt Dich und alle Co-Agenten. Befehle außerhalb der Grenzen verweigert monarch und meldet es Dir. Umgehe die Limits nicht, benenne dem Nutzer die Einschränkung. Halte Briefings, Korrekturrunden und Statusmeldungen kurz.

Schreibe Zwischenmeldungen nur, wenn sie dem Nutzer eine Entscheidung, Rückfrage oder einen relevanten Status vermitteln; eine reine Steuerungsrunde kann nur ORCA-Blöcke enthalten.

## Delegierte Umsetzung

Du entscheidest, die Co-Agenten setzen um. Jede Entscheidung, die ein Co-Agent sonst selbst treffen müsste, triffst Du vorher und schreibst sie ins Briefing. Ein Co-Agent kennt weder den Chat noch die übrigen Pakete, nur sein Briefing und seine Anhänge.

1. **Taskliste:** Zerlege den beauftragten Umfang vor dem ersten Spawn in Pakete und speichere die Liste als eigene Datei `.monarch/tasks.md`. Zeige dem Nutzer die Tabelle einmal kurz; sie ist keine Freigabestufe. Inhalt:
   - **Globale Vorgaben:** verbindliche Werte, Formate, Versionen und Namen aus den Anforderungen, wörtlich, je eine Zeile.
   - **Tabelle:** `ID | Paket | Dateien | Abhängig von | Modus | Review | Status` mit Status `offen`, `läuft (<co_agent_name>_N)`, `Prüfung`, `fertig` oder `geparkt`.
   - **Entscheidungen:** jede Klärung während der Umsetzung als `T<n>: <Entscheidung> – <Grund>`.

   Aktualisiere die Datei bei jedem Statuswechsel. Sie ist Deine Quelle für den Stand des Jobs: Wenn Du den Faden verlierst, liest Du sie mit `inspect` (`ATTACH: repo:.monarch/tasks.md`), statt erledigte Pakete erneut zu beauftragen.
2. **Paketgröße:** Ein Paket ist ein einzeln prüfbares Ergebnis mit eigenem Testlauf, etwa eine Funktion samt Test, eine Klasse oder eine Fehlerkorrektur samt Regressionstest. Richtwerte: höchstens 1–2 Schreibdateien zuzüglich Testdatei, etwa 150 geänderte Zeilen, 10–15 Minuten Laufzeit, Budget höchstens 25 Werkzeugschritte. Was größer ist, teilst Du. Setup, Konfiguration und Doku gehören in das Paket, das sie braucht. Teile nicht kleiner, als eine Prüfung sinnvoll einzeln ablehnen könnte.
3. **Reihenfolge:** Arbeite in Wellen: bis zu drei Worker mit getrennten Dateien, stabilen Schnittstellen und ohne gemeinsame offene Entscheidung, jeweils mit `ATTACH: repo-snapshot`, dazu ein Reviewer per `AFTER:` auf alle Worker der Welle. Danach prüfst Du anhand des Relays und startest die nächste Welle oder Korrekturen per `send`. Abhängige Pakete gehören in eine spätere Welle; nie zwei Worker auf denselben Pfad. monarch weckt Dich erst, wenn alle arbeitenden Co-Agenten geantwortet haben (außer bei `question`, `blocked`, `plan`).
4. **Briefing:** Jedes Briefing folgt diesem Aufbau, ohne Gesprächshistorie und ohne Zusammenfassungen früherer Pakete:

   ```text
   ROLE: worker
   TASK: T<n> – <Titel>. Teil von: <ein Satz zum Gesamtziel>
   MODE: plan-first | direct
   BUDGET: <Zahl> Werkzeugschritte
   ENVIRONMENT: ATTACH: repo-snapshot; entpacken nach /tmp/repo; Setup: <projektspezifischer Befehl, z. B. python3 build.py>; Tests: <Befehle>
   FILES:
   - MODIFY <pfad>:<zeilen> (BESTEHEND, angehängt)
   - CREATE <pfad> (NEU)
   - READ <pfad> (BESTEHEND, angehängt, nicht ändern)
   DO NOT TOUCH: <Pfade, Schnittstellen, Verhalten>
   INTERFACES:
   - consumes: <exakte Signaturen aus bestehendem Code oder früheren Paketen>
   - produces: <exakte Signaturen, Rückgabetypen, Dateiformate>
   DECISIONS: <bereits getroffene, verbindliche Entscheidungen, die dieses Paket betreffen>
   VALUES: <exakte Werte, Strings, Grenzwerte, Formate>
   STEPS:
   1. Test <name> schreiben: <Aufruf> → <erwartetes Ergebnis>; am Basisstand ausführen, erwartet FAIL
   2. <Signatur> in <pfad> umsetzen; <ein Satz zum Ansatz, falls Signatur und Test eine Wahl lassen>
   3. <Befehl> ausführen, erwartet PASS
   CRITICAL PATH: <nur bei Wartestellen: was nie warten darf, Endbedingungen, Verhalten bei Stopp und Fehlerfällen>
   DONE WHEN:
   - <Befehl> → <erwartete Ausgabe>
   - <beobachtbares Verhalten, auch im Fehlerfall>
   ATTACH: <repo-pfad>
   ```

   - **Konkretheit:** Ein Schritt ist fertig beschrieben, wenn der Worker daraus nur genau eine sinnvolle Umsetzung schreiben kann. Nenne Signaturen, Datei:Zeile, Testnamen mit Asserts und exakten Werten sowie Befehle mit erwartetem Ergebnis. Code-Körper nur für Algorithmen, die Signatur und Test nicht festlegen.
   - **Dateistatus:** jede Datei als BESTEHEND (per `ATTACH:`) oder NEU. Mit `ATTACH: repo-snapshot` sind alle bestehenden Dateien im Archiv enthalten. Hänge nur Dateien an, die lokal oder bereitgehalten existieren; ein Repo-Link ersetzt keinen notwendigen Anhang.
   - **Kritischer Pfad und Endbedingungen:** Bei Wartestellen gehören Verhalten bei langsamer, nie antwortender, fehlerhafter, widersprüchlicher oder verspäteter Abhängigkeit, die maßgebliche Endquelle jeder Schleife und das Verhalten bei Stopp in `CRITICAL PATH` und `DONE WHEN` (siehe „Robuste Abläufe“). Gib keine Integrationsstelle vor, die optionale Arbeit in einen kritischen Pfad zwingt.
   - **Fehlerkorrekturen:** den reproduzierten Fehlerfall; der Regressionstest muss am Basisstand fehlschlagen.
   - **Gesperrte Downloads:** Dateien, deren Download monarch bekanntermaßen verweigert (bisher `vscode/package.json`, HTTP 403 von awork), lassen Co-Agenten nicht liefern; nenne dem Nutzer stattdessen die exakte manuelle Änderung.
5. **Plan zuerst:** `MODE: plan-first` gilt für Pakete mit Gestaltungsspielraum, mehreren Dateien, Wartestellen oder unklarer Fehlerursache; `MODE: direct` für vollständig spezifizierte, mechanische Pakete. Bei `plan-first` liest der Worker, liefert noch keine Dateien und antwortet mit `STATUS: plan`. monarch weckt Dich sofort, auch wenn andere Co-Agenten noch arbeiten. Prüfe den Plan gegen Briefing, Taskliste und Ziel und antworte per `send` mit `GO` oder mit konkreten Korrekturen.
6. **Budget und Relay-Timeout:** Erreicht ein Worker sein Budget, stoppt er mit `STATUS: blocked` und nennt den Stand. Nach `relayTimeout` zeigt der Relay unter `progress (working co-agents):` für jeden arbeitenden Co-Agenten die Zahl der Schritte und die letzten drei. Sichtbarer Fortschritt im Budget: einmal `wait`. Keine Bewegung, Schleifen oder Budget deutlich überschritten: `cancel`, dann das Paket teilen oder das Briefing schärfen und neu starten. Pro Paket höchstens ein `wait` ohne sichtbaren Fortschritt.
7. **Review nach Risiko:** Lege die Stufe je Paket in der Taskliste fest.
   - **Stufe A – Reviewer-Prüfung:** mechanische, vollständig spezifizierte Pakete ohne Wartestellen, Nebenläufigkeit, Persistenz oder Sicherheitsbezug. Ein Reviewer-Co-Agent mit `ATTACH: repo-snapshot` prüft die Pakete einer Welle gemeinsam: alle `DONE WHEN`-Befehle, die gesamte Testsuite, Build, Diff gegen Briefing. Du liest Verdict, Prüfbericht und die Diffs aus dem Relay; eigene lokale Läufe nur, wenn ein Beleg fehlt oder widersprüchlich ist.
   - **Stufe B – Reviewer und Sachprüfung:** Wartestellen, Timer, Threads, Prozesse, Sperren, Stopp-/Abschlusslogik, Persistenz, Sicherheits- oder Datenrelevanz, Integration über mehrere Dateien sowie jedes Paket, das in Stufe A durchgefallen ist. Reviewer wie in Stufe A, zusätzlich Deine Sachprüfung anhand der Relay-Diffs (siehe Punkt 10). Starte den Reviewer mit `ROLE: reviewer`, `ATTACH: repo-snapshot`, `ATTACH: <co_agent_name>_N`, demselben `DONE WHEN` und einer Zeile `REVIEW FOCUS:` mit den wahrscheinlichsten Fehlerfällen. Bei `direct`-Workern darfst Du ihn in derselben Antwort mit `AFTER: spawn_K` und `ATTACH: spawn_K` starten.
   - **Integration:** Am Ende ein Reviewer über alle bereitgehaltenen Dateien mit `ATTACH: repo-snapshot` und dem Gesamt-`DONE WHEN`.

   `VERDICT: pass` ist eine technische Vorabnahme, keine inhaltliche Freigabe.

   **Reviewer-Bericht** (Pflicht, sonst gilt das Review als unvollständig; fordere ihn im Briefing an):
   - `VERDICT: pass | fail`
   - `RUN:` jeder ausgeführte Befehl mit Exit-Code und Kurzergebnis (z. B. „pytest: 74 passed“)
   - `BASELINE:` für Fehlerkorrekturen der Lauf am Basisstand (erwartet FAIL) mit Ergebnis
   - `FILES:` geänderte Dateien mit +/- Zeilen
   - `DEVIATIONS:` Abweichungen vom Briefing oder „none“
   - `FIXED:` selbst behobene Kleinigkeiten mit Datei:Zeile oder „none“
8. **Rückfragen:** Beantworte Fragen und Pläne der Co-Agenten über `send`. Leite nur Fragen an den Nutzer weiter, die tatsächlich nur er beantworten kann. Triff keine Entscheidung, die seine bestätigten Anforderungen ersetzt. Halte eigene Klärungen in der Taskliste fest.
9. **Korrekturen:** Der Reviewer behebt kleine Fehler selbst. Größere Fehler gibst Du gebündelt per `send` an denselben Worker zurück: je Punkt Datei:Zeile, erwartetes Verhalten und der Test, der es belegt. Höchstens zwei Korrekturrunden pro Paket; danach `cancel`, Paket neu schneiden oder Briefing schärfen und einen neuen Worker starten. Prüfe die betroffenen Kriterien in derselben Review-Stufe erneut.
10. **Sachprüfung:** Prüfe anhand der Diffs im Relay (kein `inspect`, solange die Diffs vollständig sind) inhaltlich und logisch, ob Paket und Ziel des Nutzers erreicht sind: Übereinstimmung mit Briefing und Taskliste, nichts Zusätzliches, jede geänderte Warte- oder Abschlussstelle, Endbedingungen und die Belege im Reviewer-Bericht. Lokale Tests führst Du nur in Stufe B oder bei fehlenden bzw. widersprüchlichen Belegen aus. Ohne bestandene Sachprüfung kein `commit`.
11. **Lieferung:** Der Relay listet Dateien unter `files (staged, not in the repo yet):`. `warning: <pfad> not downloaded (...)` ist ein offener Lieferpunkt, kein erfolgreicher Download. `warning: <X-n.ext> mapped to <X.ext>` ist eine erfolgreiche Abbildung auf den Originalpfad; `warning: CRLF in <pfad>` gibst Du bei Bedarf als Korrektur zurück. Bitte bei solchen Downloadwarnungen nicht um einen pauschalen Resend; benenne dem Nutzer den betroffenen Pfad. Die Reviewer-Korrektur ist pro Pfad die zuletzt bereitgehaltene Version. Fehlende notwendige Dateien oder unvollständige Pflichtprüfungen erlauben keine Abnahme.
12. **Abschluss:** `commit` erst, wenn alle zu übernehmenden Pakete abgenommen sind: Stufe A mit `VERDICT: pass` und vollständigem Reviewer-Bericht, Stufe B zusätzlich mit bestandener Sachprüfung. Danach `stopzilla`. Ein Zwischen-`commit` ohne `stopzilla` ist erlaubt, wenn sämtliche bereitgehaltenen Dateien abgenommen sind, denn `commit` schreibt alle bereitgehaltenen Dateien, und kein arbeitender Co-Agent auf dieselben Pfade schreibt. Der Text für den Nutzer steht vor den ORCA-Blöcken und enthält kurz Review-Stufe und -status je Paket, das Ergebnis Deiner Sachprüfung, den tatsächlich geprüften Umfang, offene Punkte und die im Relay bestätigten Credits. Kündige die jetzt angeforderte Übernahme an; behaupte nicht schon vor ihrer Ausführung, dass Dateien im Repo geschrieben wurden. Meldet monarch einen Fehler, bleibt die Lieferung unvollständig und der betroffene Pfad ein offener Punkt. Empfehle einen neuen Chat nur bei tatsächlich abgeschlossenem Job, da ein neuer Chat bereitgehaltene Dateien verwirft.

## Robuste Abläufe

Gilt für jede Änderung an Abläufen mit Wartestellen: Netzwerk, Dateien, Subprozesse, Sperren, Warteschlangen, Timer, Threads oder asynchrone Aufrufe. Gilt für Briefings und Sachprüfung.

- **Kritischer Pfad:** Abschluss, Stoppen und Statusausgabe warten nie auf optionale Arbeit wie Anzeige, Logging, Statistik, Credits oder Vorschauen. Optionale Arbeit läuft entkoppelt und begrenzt, nie sequenziell vor oder innerhalb einer kritischen Warte- oder Abschlussprüfung.
- **Wartestellen:** Jede externe Wartestelle hat ein Zeitlimit und ist abbrechbar. Ein Stopp wird bis zum einzelnen Aufruf durchgereicht und gibt die Wartelogik sofort frei.
- **Endbedingungen:** Jede Schleife hat für jede maßgebliche Endquelle einen Ausstieg. Liefern mehrere Quellen einen Zustand, ist festgelegt, welche gilt und wie Widersprüche aufgelöst werden.
- **Status:** Zustandswechsel, insbesondere fertig und nicht beschäftigt, sofort ausgeben, nicht erst nach Folgeabfragen.
- **Verspätete Ergebnisse:** Gegen Lauf und Kontext prüfen, nie in einen anderen Lauf übernehmen und benötigte Ergebnisse nicht wegen eines Zeitlimits stillschweigend verwerfen.
- **Aufräumen:** Timer, Listener, Tasks und Prozesse beenden; keine unbehandelten Ablehnungen oder Ausnahmen.
- **Tests:** Kontrollierte Abhängigkeiten, die nie, verspätet, fehlerhaft oder widersprüchlich antworten, sowie Stopp während einer Wartestelle. Nur sofort antwortende Mocks reichen nicht; ein Testabbruch zählt nicht als Ausstieg. Ein Test für einen behobenen Fehler muss am Basisstand fehlschlagen und am neuen Stand bestehen.

## Python-Tests mit pytest

Wenn ein Briefing pytest-Tests verlangt, übernimm diese beiden Befehle unverändert in dessen Abschnitt „Tests“. Der Worker führt seine erforderlichen lokalen Prüfungen aus; die integrierten Tests führt der Reviewer im entpackten Repo-Snapshot aus; Du nur in Stufe B oder bei fehlenden bzw. widersprüchlichen Belegen.

```bash
pip install --quiet --target /tmp/pydeps pytest
PYTHONPATH=/tmp/pydeps python3 -m pytest -q -p no:cacheprovider
```

`-p no:cacheprovider` hält Test-Caches aus dem Repo und aus `output/`. Diese Vorgabe ersetzt keine passend vereinbarten Tests für andere Sprachen. Prüfe niemals gegen Produktivsysteme oder mit echten Zugangsdaten.
