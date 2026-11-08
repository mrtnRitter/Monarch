# Taskliste – Facelift 0.20.0

## Globale Vorgaben
- Version: 0.20.0 (vscode/package.json, README)
- Kein Element bleibt oben im Fenster außer Kopfzeile (Agenten, Verlauf, Neuer Chat); die Statusleiste `statusbar` oben entfällt.
- Zeile über dem Eingabefeld (`id="statusbar"`, Klasse `input-toolbar`), Reihenfolge: `+` (`id="attach"`, Menü `id="attach_menu"`) · Badges `credits`, `co_credits`, `co_agents` (inkl. Hover-Buttons − / +) · Modell (`id="model"`, Menü `id="model_menu"`)
- `+`-Menü: „Current file“, „Files“, „Folder“; sendet `{type: 'attach', kind: 'current'|'files'|'folder'}`
- Files und Folder: beim Senden zusammen als genau eine `attachments.zip`, Pfade relativ zum Repo; Current file wie bisher als Einzeldatei
- Zeile unter dem Eingabefeld: Hinweis + `send`; während `status.busy` ist `send` ausgeblendet und `stop` (Label `labels.stop`) steht an seiner Stelle
- Meldung „<agent> is working …“ (`id="working"`) entfällt; Spinner + Laufzeit (`format_duration(Date.now() - status.phase_since)`, rechts neben dem Spinner) stehen hinter der letzten Statusmeldung
- Zähler „+ N Steps“ ist im aufgeklappten Zustand ausgeblendet
- Agent-Schritt in der Anzeige: `Agent step: <intent>`, ohne Toolnamen; ohne Intent keine Zeile. Relay-Fortschritt an den Agenten unverändert (`<intent> · <tool>`)

## Pakete
| ID | Paket | Dateien | Abhängig von | Modus | Review | Status |
|---|---|---|---|---|---|---|
| T1 | Agent-Schritte ohne Toolnamen | vscode/src/session.js, vscode/test/steps_test.js | – | direct | A | fertig (Sachprüfung bestanden) |
| T2 | HTML-Layout, ZIP-Bündel, Version | vscode/src/chat_view.js, vscode/package.json, vscode/test/chat_view_test.js | – | direct | A | fertig (Sachprüfung bestanden; package.json HTTP 403, Martin trägt Version ein) |
| T3 | Eingabezeile: +-Menü, Menüs nach oben, Send/Stop | vscode/media/chat.js, vscode/media/chat.css, vscode/test/webview_test.js | – | direct | A | fertig (Sachprüfung bestanden, CSS-Korrekturen in T4 enthalten) |
| T4 | Spinner + Laufzeit in Statusmeldungen, Zähler beim Aufklappen | vscode/media/chat.js, vscode/media/chat.css, vscode/test/webview_test.js | T3 | plan-first | B | fertig (Sachprüfung bestanden, VERDICT: pass minizilla_5) |
| T5 | Integrations-Review | alle bereitgehaltenen Dateien | T1–T4 | – | B | fertig (VERDICT: pass minizilla_5) |

## Entscheidungen
- T2: Files und Folder als eine `attachments.zip` mit Repo-Pfaden – Martins Vorgabe „immer als Zip“, ein Archiv hält die Struktur zusammen
- T2: Dateien außerhalb des Repos liegen in der ZIP unter ihrem Dateinamen – ein Pfad außerhalb des Repos ist kein sicherer relativer Pfad
- T3: Stop nur sichtbar, solange der Agent arbeitet – Martins Vorgabe; Stopp im Leerlauf über den Befehl `monarch: Stop agent and co-agents`
- T4: Ohne Statusmeldung steht der Spinner in einer eigenen Statuszeile am Chat-Ende – damit Arbeit immer sichtbar ist
- T1: Relay-Fortschritt an den Agenten behält den Toolnamen – betrifft nur die Chat-Anzeige
- Vorbestehende Testfehler am Basisstand (nicht Teil dieses Jobs): test/test.js 2 Relay-Tests, test/extension_smoke.js veraltet (bricht in Zeile 9 ab)
- Neustart T1–T4 nach Rechnerabsturz: erster Auftrag lief nie (Co-Credits 0) – keine Doppelarbeit
- T3: CSS-Korrekturen (Stop so groß wie Send, Höhe und Ausrichtung von + und Modell-Button) gehen an minizilla_4 – gleiche Dateien, kein zweiter Schreiber
- T2: Keine Zeitlimits für lokale Dateilesezugriffe – Verhalten unverändert gegenüber 0.19.2, nicht Teil des Facelifts
- T4/T5: Ein Reviewer prüft T4 (Stufe B) und die Integration aller Pakete gemeinsam – gleiche Dateien, spart einen Durchlauf
- test/test.js hängt schon am Basisstand im Test „budget: unreadable credits …“ – Ergebnis vorher/nachher identisch (10 ok, 2 bekannte FAIL)
- Abschluss: commit aller bereitgehaltenen Dateien, stopzilla; offen: vscode/package.json Version 0.20.0 (HTTP 403), .monarch/base/ kann gelöscht werden
