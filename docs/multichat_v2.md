# monarch 0.24.0 – Mehrere Chats in der Seitenleiste

Grundlage für die Umsetzung in einem neuen Chat. Basis: Repo-Stand `f9bf5a8` (0.23.0).

## 1 Ziel

- Alle Chats eines Fensters liegen in der monarch-Ansicht der Seitenleiste, untereinander in geteilten Bereichen. Es gibt keine Chat-Editor-Tabs mehr.
- Globale Bedienelemente stehen einmal in einer oberen Leiste. Ein Chatbereich enthält nur, was zu ihm gehört.
- Die Agentenauswahl liegt im Modellmenü. Jeder Chat hat seinen eigenen Agenten.
- Credits und Co-Agenten werden nur angezeigt. monarch begrenzt sie nicht mehr.
- Es gibt keine Auf-/Zuklapp-Pfeile. Größen ändert man an den Trennlinien.
- Optional: Ein gewähltes, nicht geöffnetes Repo wird dem Arbeitsbereich hinzugefügt.

## 2 UI-Aufbau

```text
MONARCH: CHAT                                      (Titel von VS Code)
──────────────────────────────────────────────────────────────────────
                                 [Notizen] [Verlauf] [+]   ← obere Leiste
──────────────┬───────────────────────────────────────────────────────
● repoA       │ Nachrichten Chat 1
Notizen 1     │ ───────────────────────────────────── ← Eingabehöhe
              │ [+] Chat 120  Co-Credits 40    [CodeZilla · GPT-5 · High]
              │ Message … (Enter = send, Shift+Enter = new line)
══════════════│ [● repoA] [>_] [×]                              [Send]
● repoB       ├══════════════════════════════════════ ← Splitter
Notizen 2     │ Nachrichten Chat 2 …
              │ [● repoB] [>_] [×]                              [Send]
```

**Obere Leiste (einmal, rechtsbündig):** Notizen, Verlauf, „+“.
- **Notizen:** blendet den Notizbereich ein oder aus. Der Zustand gilt global wie bisher.
- **Verlauf:** zeigt die Chats des Agenten im aktiven Bereich. Ein Klick öffnet den Chat im aktiven Bereich. Ist er schon in einem anderen Bereich offen, wird dieser aktiv. ✕ entfernt wie bisher.
- **„+“:** öffnet das Menü **New chat here** (aktiver Bereich) | **New chat below** (neuer Bereich ganz unten, mit Repo und Agent des aktiven Bereichs; bei 4 Bereichen deaktiviert). Strg/Cmd+Klick übernimmt wie bisher einen Chat aus awork, in den aktiven Bereich.

**Chatbereich (je Chat):** Nachrichten mit Hinweis auf neue Antworten, Splitter für die Eingabehöhe, Werkzeugzeile (Anhang-„+“, Anzeigen, Modellknopf), Anhänge, Eingabe und darunter die untere Zeile.
- **Untere Zeile:** links der Repo-Knopf (Punkt und Name; das Repo-Menü mit Filter öffnet nach oben), Terminal und Schließen „ד; rechts Send bzw. Stop. Der Tastaturhinweis wandert in den Platzhalter der Eingabe.
- **Schließen „ד:** nur bei mindestens 2 Bereichen sichtbar und nur aktiv, wenn der Agent nicht arbeitet, keine Co-Agenten arbeiten oder warten und keine Dateien bereitgehalten sind (`can_change` wie beim Repo-Wechsel). Der Chat bleibt im Verlauf.
- **Aktiver Bereich:** der zuletzt fokussierte oder angeklickte Bereich. Bei mindestens 2 Bereichen ist er markiert.

**Modellmenü:** Ganz oben stehen der Kopf `Agent` und eine Zeile mit den Agenten-Avataren in der jetzigen Größe. Die Zeile bricht bei Bedarf um, der gewählte Agent ist markiert, der Name erscheint als Tooltip. Darunter folgen unverändert Agent default, Reasoning und AI models.
- Text des Modellknopfs: `<Agent> · <Modell>[ · <Stufe>]`, ohne Pfeil.

**Anzeigen:** `Chat 120`, `Co-Credits 340`, `Co-Agenten 2 · 1 working`. Nicht lesbare Werte erscheinen als `?`. Es gibt kein −/+, kein Limit und keine Warnfarbe.

**Notizbereich:** liegt links oder rechts neben allen Chats (`monarch.notesPosition`), über die volle Höhe unter der oberen Leiste. Die Breite lässt sich wie bisher ziehen.
- Bei 1 Chat gibt es nur das Textfeld.
- Ab 2 Chats hat jeder Chat eine Gruppe mit Kopf (Punkt, Repo, Titel; kein Pfeil, keine Klickfunktion). Zwischen den Gruppen liegen Splitter. Die Reihenfolge entspricht den Bereichen.

**Splitter:** liegen zwischen den Chatbereichen und zwischen den Notizgruppen.
- Ziehen ändert nur die beiden Nachbarn. Mindesthöhen: Chatbereich 160 px, Notizgruppe 60 px.
- Beim Öffnen oder Schließen eines Chats werden Bereiche und Gruppen gleichmäßig aufgeteilt.
- Die Größen werden nicht über die Lebensdauer der Ansicht hinaus gespeichert.

## 3 Architektur

### 3.1 Varianten

| | A: mehrere Webview-Ansichten (`monarch.chat`, `monarch.chat2` … per `setContext`) | B: eine Webview-Ansicht mit mehreren Chatbereichen |
|---|---|---|
| Globale Leiste über allen Chats | nein: jede Ansicht ist eine eigene Webview; native Titelaktionen erscheinen bei mehreren Ansichten je Ansicht | ja |
| Pfeile | VS Code zeigt je Ansicht einen Abschnittskopf mit Auf-/Zuklapp-Pfeil; nicht entfernbar | keine |
| Trennlinien | nativ | eigene Splitter |
| Anzahl Chats | fest durch package.json | Konstante |
| Isolation | eigene Webview je Chat | ein DOM für alle Chats |
| Ausblenden | „Hide“ im Kontextmenü verwirft die Webview eines Chats | nur die ganze Ansicht |
| Aufwand | gering (ChatView bleibt) | hoch (das Webview-Skript muss mehrfach instanziierbar werden) |
| package.json | N Ansichten, `when`-Klauseln, Schließen-Aktionen | nur Befehl und Einstellungen |

**Empfehlung: B.** Nur B erfüllt die globale Leiste und „keine Pfeile“. Zwei Maßnahmen senken das Umbaurisiko: Ein Port-Adapter lässt `ChatView` fast unverändert. `chat.js` wird erst mechanisch umgebaut, dann folgen die UI-Änderungen.

### 3.2 Aufbau

**Extension**

`ChatPanels` (`src/chat_panels.js`) wird neu geschrieben, der Name bleibt:
- ist der `WebviewViewProvider` für `monarch.chat`;
- verwaltet `entries = [{ chat, port }]`, den aktiven Chat und höchstens 4 Chats (`max_areas = 4`);
- schreibt das HTML über `src/chat_html.js`;
- verteilt Webview-Nachrichten per `chat_id` und behandelt die globalen Nachrichten;
- sendet die Notizgruppen einmal an die Webview, mit Generationszähler wie bisher.

Der **Port** ersetzt für jede `ChatView` die Webview:

```js
port = {
  webview: {
    postMessage(message),         // ergänzt chat_id; wirkungslos, solange die Ansicht nicht aufgelöst ist
    onDidReceiveMessage(listener) // → { dispose }; nur Nachrichten mit dieser chat_id
  },
  get visible(),                  // = view.visible
  onDidChangeVisibility(listener) // → { dispose }
}
```

- `ChatView.attach(port)` ersetzt `resolveWebviewView`, ohne HTML-Teil. Das Terminal öffnet immer im Panel.
- Der erste Chat entsteht wie bisher im Konstruktor von `ChatPanels` und wird beim Auflösen der Ansicht angehängt.
- Verwirft VS Code die Ansicht, laufen die Chats weiter und die Ports bleiben wirkungslos. Beim erneuten Auflösen entsteht das HTML neu, für jeden Eintrag folgt `add_area`, jeder Bereich meldet `ready` und `ChatView.refresh()` läuft.

**Webview**

`media/chat_host.js` (neu) ruft als einzige Datei `acquireVsCodeApi()` auf. Es enthält:
- obere Leiste, Verlaufsmenü und „+“-Menü;
- den Bereichscontainer mit Splittern;
- den Notizbereich mit Gruppen und Splittern;
- den aktiven Bereich und Strg/Cmd+C (einmal global);
- die Verteilung der Nachrichten.

`media/chat.js` wird eine Fabrik:

```js
window.monarch_chat.create({ root, chat_id, post, input_height }) // → { on_message(data), focus(), dispose() }
```

- `root` ist eine Kopie von `<template id="area_template">`. Die Elemente tragen `data-el="<bisherige id>"`, und `element(name)` sucht nur in `root`.
- Listener an `document` oder `window` reagieren nur auf eigene Elemente und werden in `dispose()` entfernt.
- Ein Klick außerhalb des eigenen Menüs schließt es, auch in einem anderen Bereich oder in der oberen Leiste.

`media/chat_layout.js` (neu) enthält reine Funktionen wie `chat_scroll.js` und ist in Node testbar:
- `equal_sizes(count) → number[]`: Anteile mit Summe 1.
- `drag_split(sizes, index, delta_px, total_px, min_px) → number[]`: nur `index` und `index + 1` ändern sich, beide bleiben ≥ `min_px`.
- `next_active(ids, removed_id, active_id) → id`: Wird der aktive Bereich geschlossen, wird der darüber aktiv, sonst der erste.

### 3.3 Nachrichten

Webview → Extension

| Typ | Felder | Behandlung |
|---|---|---|
| `host_ready` | – | `host_init`, dann `add_area` je Eintrag |
| `focus_area` | `chat_id` | setzt den aktiven Chat für Befehle, Verlauf und „+“ |
| `new_chat_below` | – | `open(repo, agent_id)` des aktiven Chats; ab 4 Chats Notice `Max. 4 chats open.` |
| `close_area` | `chat_id` | nur bei ≥ 2 Chats und `can_change`, sonst Notice; `ChatView.dispose()`, `remove_area` |
| `notes_visible`, `notes_width` | wie bisher | globalState wie bisher |
| `set_notes` | `chat_id, text, rev` | `ChatPanels.set_notes` |
| alle übrigen bisherigen | + `chat_id` | Port → `ChatView._on_message` |

- Es entfallen `adjust` und `new_chat_beside`.
- Nachrichten mit unbekannter `chat_id` (z. B. verspätet nach dem Schließen) werden ignoriert.

Extension → Webview

| Typ | Felder | Ziel |
|---|---|---|
| `host_init` | `notes_visible, notes_width, notes_position, max_areas` | Host |
| `add_area`, `remove_area`, `focus_area` | `chat_id` | Host |
| `notes_groups` | `groups` (ohne `self`) | Host |
| `notes_position` | `position` | Host |
| `error` ohne `chat_id` | `text, transient` | aktiver Bereich |
| bisherige Typen der ChatView | + `chat_id` (Port) | Bereich; `notes` und `chats` nur an den Host |

`init` enthält keine Notizfelder mehr.

### 3.4 Agent je Chat

- `ChatView` erhält die Option `agent_id` (Standard: workspaceState `monarch.agent`). `_agent()` nutzt `this.agent_id`.
- `select_agent` ändert nur diesen Chat und speichert die Wahl als Vorgabe für neue Fenster. Während der Agent arbeitet, kommt die Notice `Stop the agent first.`
- Ein neuer Bereich übernimmt den Agenten des aktiven Chats.

### 3.5 Limits entfernen (`src/session.js`)

- **Entfernen:** `max_credits()`, `max_co_credits()`, `max_co_agents()`, `_credit_step()`, `_can_less*()`, `_adjust()`, `adjust_credits()`, `adjust_co_credits()`, `adjust_co_agents()` und `_check_budget()`. Dazu die Zustandsfelder `extra_credits`, `extra_co_credits` und `extra_co_agents`; alte Werte werden ignoriert.
- **`send()`:** Statt `await this._check_budget(true)` steht nur `this.refresh_credits()`, ohne darauf zu warten.
- **`_tick()`:** liest die Credits für die Anzeige im Hintergrund, höchstens eine Abfrage gleichzeitig. Das stoppt nie und verzögert das Warten nie.
- **`_limit_error()` → `_co_agent_error()`:** meldet nur noch `no coAgentId configured for <agent>`; `spawn` und `send` nutzen es.
- **`status()`:** ohne `max_*`, `credit_step`, `can_less_*` und `can_more_*`.
- **Relay-Zeile:** `credits: agent <n>, co-agents <n>`; nicht lesbare Werte als `unknown`.
- **`ChatView._limits()`:** ohne die vier Schlüssel.

### 3.6 Optional: Repo zum Arbeitsbereich hinzufügen

Das ist machbar mit `vscode.workspace.updateWorkspaceFolders(anzahl_ordner, 0, { uri })` in `select_repo`: nach dem Repo-Wechsel und nur, wenn das Repo nicht offen ist.
- Der Ordner wird immer am Ende angefügt. Der erste Ordner ändert sich nie.
- **Multi-Root-Fenster** (`workspace.workspaceFile` gesetzt): direkt hinzufügen.
- **Einzelordner- oder leeres Fenster:** Das Fenster wird zu einem unbenannten Multi-Root-Arbeitsbereich. VS Code kann dabei die Erweiterungen neu starten, laufende Sessions brechen dann ab (nicht verifiziert). Deshalb wird nur hinzugefügt, wenn kein Chat des Fensters arbeitet, aktive Co-Agenten hat oder Dateien bereithält, und erst nach der modalen Rückfrage `Add <repo> to the workspace? This window becomes an untitled multi-root workspace and VS Code may restart the extensions.` [Add]. Sonst bleibt es beim Repo-Wechsel mit dem Hinweis `Repo selected. Add it with File → Add Folder to Workspace… when no agent is running.`
- Gibt der Aufruf `false` zurück, kommt die Notice `Folder not added.`
- **Nutzen:** Explorer, Quellcodeverwaltung und Ordner-Anhänge für das Repo. Der Repo-Wechsel selbst funktioniert schon heute ohne Hinzufügen.

## 4 Betroffene Dateien

| Datei | Änderung |
|---|---|
| `vscode/src/chat_panels.js` | neu geschrieben (3.2, 3.3); keine Editor-Panels mehr |
| `vscode/src/chat_html.js` | NEU: HTML der Ansicht (obere Leiste, Notizbereich, Bereichscontainer, `area_template`); Skripte in der Reihenfolge `markdown.js, chat_time.js, chat_scroll.js, chat_layout.js, chat.js, chat_host.js`; CSP unverändert |
| `vscode/src/chat_view.js` | `attach(port)` statt `resolveWebviewView`, HTML entfernt; Agent je Chat (3.4); `adjust` und `new_chat_beside` entfernt; `set_notes`, `notes_visible`, `notes_width` und `post_notes_groups` wandern nach `ChatPanels`; `_limits()`; `summary()` mit `agent_id`; optional 3.6 |
| `vscode/src/extension.js` | Provider für `monarch.chat` ist `ChatPanels`; `monarch.openChatInEditor` → `monarch.newChatBelow`; `notesPosition` geht an `ChatPanels` |
| `vscode/src/session.js` | 3.5 |
| `vscode/media/chat.js` | Fabrik; ohne Kopfzeile, Agenten im Kopf, Notizen, Verlauf, „+“-Menü und Strg/Cmd+C; Modellmenü mit Agenten; Anzeigen ohne −/+; untere Zeile; keine Pfeile |
| `vscode/media/chat_host.js` | NEU (3.2) |
| `vscode/media/chat_layout.js` | NEU (3.2) |
| `vscode/media/chat.css` | Layout für obere Leiste, Bereiche, Splitter und Notizgruppen; `#id`-Selektoren → Klassen oder `[data-el]`; `.adjust-*`, `.notes-group-arrow` und `.expanded` entfernt |
| `vscode/package.json` | manuell (Abschnitt 5) |
| `vscode/test/` | NEU: `chat_layout_test.js`, `session_limits_test.js`. Anpassen: `chat_panels_test.js`, `extension_panels_test.js`, `chat_view_*_test.js`, `notes_test.js`. `webview_notes_test.js` (jsdom) auf den Host umstellen |
| `README.md` | Chatfenster, mehrere Chats, Einstellungen, Befehle, Relay-Beispiel |
| `skills/monarch-main-agent_skill.md` | Absatz „Limits“ ersetzen (E20); danach in awork aktualisieren |

## 5 package.json (manuell)

monarch kann `vscode/package.json` nicht liefern. Diese Änderungen sind von Hand nötig:

```jsonc
// Version
"version": "0.24.0",

// contributes.commands: diesen Eintrag
{ "command": "monarch.openChatInEditor", "title": "monarch: New chat in editor" }
// ersetzen durch
{ "command": "monarch.newChatBelow", "title": "monarch: New chat below" }

// contributes.configuration.properties: diese Schlüssel löschen
"monarch.maxCredits", "monarch.maxCoAgentCredits", "monarch.maxCoAgents", "monarch.creditStep"

// contributes.configuration.properties["monarch.notesPosition"]: Texte anpassen
"enumDescriptions": ["Notes left of the chats", "Notes right of the chats"],
"description": "Side of the notes pane next to the chats; show or hide it with the notes button in the top bar."
```

`viewsContainers` und `views` bleiben unverändert (nur `monarch.chat`).

## 6 Entscheidungen

- **E1:** Variante B: eine Ansicht `monarch.chat` mit mehreren Chatbereichen.
- **E2:** Die obere Leiste liegt in der Webview, nicht als native Titelaktionen. Die Menüs bleiben, package.json braucht keine Menüs.
- **E3:** Reihenfolge oben: Notizen, Verlauf, „+“.
- **E4:** „+“-Menü: `New chat here` | `New chat below`; Strg/Cmd+Klick wie bisher.
- **E5:** Ein neuer Bereich kommt ganz nach unten, mit Repo und Agent des aktiven Chats. Höchstens 4 Bereiche.
- **E6:** Aktiver Bereich = zuletzt fokussiert oder angeklickt. Markierung ab 2 Bereichen: `box-shadow: inset 2px 0 0 var(--vscode-focusBorder)`.
- **E7:** Der Verlauf zeigt die Chats des Agenten im aktiven Bereich und öffnet sie dort.
- **E8:** Schließen „ד nach 2 und 3.3. Tooltips: `Close this chat (it stays in History)` bzw. `Close the chat when the agent has finished and no files are staged.`
- **E9:** Untere Zeile: Repo, Terminal und Schließen links, Send/Stop rechts. Platzhalter: `Message … (Enter = send, Shift+Enter = new line)`.
- **E10:** Der Agent gilt je Chat. workspaceState `monarch.agent` ist nur noch die Vorgabe.
- **E11:** Modellknopf `<Agent> · <Modell>[ · <Stufe>]`. Die Agentenzeile oben im Modellmenü bricht um. Der Ersatz per Dropdown (`select#agent`) entfällt.
- **E12:** Anzeigen ohne Limit; unbekannte Werte als `?`; keine Warnfarbe.
- **E13:** Splitter: 4 px Griff, Cursor `ns-resize`, beim Überfahren und Ziehen `--vscode-sash-hoverBorder`. Mindesthöhen 160 px (Chat) und 60 px (Notizgruppe). Beim Öffnen und Schließen gleichmäßig aufgeteilt, nicht gespeichert.
- **E14:** Notizgruppen haben keinen Pfeil und keine Klickfunktion. Bei 1 Chat gibt es keinen Kopf.
- **E15:** Eingabehöhe: Ziehen wirkt nur auf den eigenen Bereich. Der letzte Wert wird wie bisher gespeichert und gilt für neue Bereiche.
- **E16:** Globale Fehler ohne `chat_id` erscheinen im aktiven Bereich.
- **E17:** Bereiche werden nach einem Neustart nicht wiederhergestellt; ein neues Fenster beginnt wie bisher mit einem neuen Chat.
- **E18:** Die Limits entfallen ganz (3.5). Es gibt keine Migration alter Zustandsfelder.
- **E19:** Der Befehl `monarch.openChatInEditor` wird zu `monarch.newChatBelow`.
- **E20:** Skill, neuer Absatz statt „Limits“: „**Credits:** monarch zeigt Credits und Co-Agenten je Chat nur an und begrenzt sie nicht. Halte Briefings, Korrekturrunden und Statusmeldungen kurz.“
- **E21:** Neue Dateien: `src/chat_html.js`, `media/chat_host.js`, `media/chat_layout.js`. `chat_panels.js` und `ChatPanels` behalten ihren Namen.
- **E22:** 3.6 wird als eigenes, letztes Paket umgesetzt.
- **E23:** Version 0.24.0.

## 7 Offene Punkte und Risiken

Offene Fragen gibt es keine. Die folgenden Risiken sind bekannt:
- **Umbau von `chat.js`:** Die Datei hat 54 KB und ist das größte Risiko (Scrollen, Menüs, Tastatur, Kopieren). Deshalb zuerst der mechanische Umbau zur Fabrik ohne UI-Änderung.
- **Kein jsdom:** In der Co-Agent-Umgebung gibt es kein jsdom. Dort prüfen Tests nur die reinen Helfer. `webview_notes_test.js` läuft nur mit jsdom, den Rest prüft der Handtest (Abschnitt 8).
- **Ein DOM für alle Chats:** Ein Skriptfehler trifft alle Bereiche. Viele lange Verläufe kosten Speicher.
- **Ansicht verworfen:** Verwirft VS Code die Ansicht, fehlen laufende Zwischenschritte eines Chats bis zur nächsten Meldung, weil der Verlauf aus awork neu geladen wird.
- **Keine Limits:** monarch stoppt ausufernde Läufe nicht mehr selbst. Schutz gibt es nur noch über Stop und awork. Alte Einstellungen in `settings.json` zeigt VS Code als unbekannt an.
- **3.6:** Das Neustartverhalten ist nicht verifiziert. Ein unbenannter Arbeitsbereich hat einen eigenen workspaceState, die Agent-Vorgabe beginnt dort neu.
- **package.json:** Die Datei muss vor `build_vsix.py` von Hand geändert werden. Sonst trägt das Paket 0.23.0 und die alten Einstellungen.

## 8 Erfolgskriterien

**Automatisch** (in `vscode/`):
- `for f in test/*_test.js; do grep -q "require('jsdom')" "$f" && { echo "SKIP $f (jsdom)"; continue; }; node "$f" || echo "FAIL $f"; done; python3 build_vsix.py` → keine `FAIL`-Zeile, VSIX gebaut.
- `grep -rnE "maxCredits|maxCoAgentCredits|maxCoAgents|creditStep|adjust_|max_co_agents" src media` → keine Treffer.
- `grep -rnE "createWebviewPanel|openChatInEditor|new_chat_beside|open_beside|ViewColumn.Beside" src media` → keine Treffer.
- `grep -rn "[▾▸]" media` → keine Treffer.
- `grep -rl "acquireVsCodeApi()" media` → nur `media/chat_host.js`.
- `chat_layout_test.js`: Anteile, Mindesthöhe, nächster aktiver Bereich.
- `chat_panels_test.js`:
  - Nachrichten gehen nur an den eigenen Chat; eine unbekannte `chat_id` wird ignoriert.
  - Höchstens 4 Chats.
  - Schließen nur mit `can_change` und bei ≥ 2 Chats; danach stimmt der aktive Chat.
  - Notizgruppen gehen einmal je Änderung raus.
  - Erneutes Auflösen baut alle Bereiche neu.
- `session_limits_test.js`:
  - `spawn` mit 12 aktiven Co-Agenten wird nicht abgelehnt.
  - Hohe Credits stoppen nicht.
  - Eine nie antwortende Credit-Abfrage verzögert weder `send` noch `_tick`.
  - Relay-Zeile `credits: agent 120, co-agents unknown`.
- `chat_view_*_test.js`: Zwei Chats wählen ihre Agenten unabhängig. Ein Wechsel während der Arbeit wird abgelehnt.

**Handtest** (Martin):
1. „New chat below“ öffnet einen zweiten Bereich in derselben Seitenleiste und keinen Editor-Tab. Bei 4 Bereichen ist der Eintrag deaktiviert.
2. Notizen, Verlauf und „+“ stehen einmal oben. Repo, Terminal und „ד stehen je Chat unten.
3. Der Modellknopf zeigt `CodeZilla · <Modell> · <Stufe>`. Ein Agentenwechsel in Bereich 2 ändert Bereich 1 nicht.
4. Die Anzeigen haben kein −/+. Ein Lauf über die alten Limitwerte hinaus wird nicht gestoppt, und `spawn` wird nicht wegen der Anzahl abgelehnt.
5. Nirgends erscheint ▾ oder ▸. Die Trennlinien zwischen Bereichen und zwischen Notizgruppen lassen sich ziehen, die Mindesthöhen greifen.
6. Bei nur einem Bereich fehlt „ד. Arbeitet der Agent oder sind Dateien bereitgehalten, ist es deaktiviert. Ein geschlossener Chat steht im Verlauf.
7. Der Verlauf öffnet im aktiven Bereich. Ein schon offener Chat aktiviert seinen Bereich.
8. Optional: Ein nicht geöffnetes Repo erscheint in einem Multi-Root-Fenster im Explorer. Im Einzelordner-Fenster kommt es erst nach Rückfrage dazu und nur, wenn nichts läuft.

## 9 Vorschlag Pakete

| ID | Paket | Dateien | Abhängig von | Review |
|---|---|---|---|---|
| T1 | Limits entfernen | `src/session.js`, `test/session_limits_test.js`, `test/notes_test.js` | – | B |
| T2 | Layout-Helfer | `media/chat_layout.js`, `test/chat_layout_test.js` | – | A |
| T3 | `chat.js` als Fabrik, ohne UI-Änderung | `media/chat.js`, `media/chat.css` | – | B |
| T4 | ChatView: Port, Agent je Chat, Limits | `src/chat_view.js`, `test/chat_view_*_test.js` | T1 | B |
| T5 | Host, Extension-Seite | `src/chat_panels.js`, `src/chat_html.js`, `src/extension.js`, `test/chat_panels_test.js`, `test/extension_panels_test.js` | T4 | B |
| T6 | Host, Webview-Seite: Leiste, Bereiche, Notizen | `media/chat_host.js`, `media/chat.css`, `test/webview_notes_test.js` | T2, T3 | B |
| T7 | Chat-UI: Modellmenü mit Agenten, Anzeigen, untere Zeile | `media/chat.js`, `media/chat.css` | T6 | B |
| T8 | README und Skill | `README.md`, `skills/monarch-main-agent_skill.md` | T1–T7 | A |
| T9 | optional: Repo zum Arbeitsbereich | `src/chat_view.js`, `src/chat_panels.js`, Test | T5 | B |

Wellen: T1, T2, T3 → T4, T6 → T5, T7 → T8 → T9.
