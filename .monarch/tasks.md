# Taskliste – Modellmenü 0.20.0

## Globale Vorgaben
- Version bleibt 0.20.0
- Reihenfolge im Modellmenü: „Agent default“ (Funktion unverändert) · Trenner · Kopf „Reasoning“ + Stufen in einer Zeile (nur wenn das gewählte Modell Stufen hat) · Trenner · Kopf „AI models“ · Modellliste
- Modellzeile: Häkchen | Modellname | Credit-Faktor `<faktor>×` | Hersteller; Faktoren stehen in einer Spalte genau untereinander; Tooltip `Credit factor <faktor>` bleibt
- Köpfe im bestehenden Stil `.menu-header`

## Pakete
| ID | Paket | Dateien | Abhängig von | Modus | Review | Status |
|---|---|---|---|---|---|---|
| M1 | Modellmenü neu aufgebaut, Faktor-Spalte | vscode/media/chat.js, vscode/media/chat.css, vscode/test/webview_test.js | – | direct | A | fertig (Sachprüfung bestanden, im Browser nachgemessen) |

## Entscheidungen
- M1: Modellliste als CSS-Tabelle (`display: table`/`table-row`/`table-cell`) – Spalten richten sich über alle Zeilen aus, ohne Messung per JS und ohne `subgrid` (fehlt in der Chromium-Version von VS Code 1.85)
- M1: Faktor als `3×`, rechtsbündig mit gleich breiten Ziffern; ohne Faktor bleibt die Zelle leer
- M1: Trenner zwischen den drei Abschnitten; das Menü darf bis 440px breit werden, damit alle Stufen in eine Zeile passen, sonst horizontal scrollbar
- M1: Platzhalter in der Häkchen-Spalte und `nowrap` für die Stufen – im Browser gemessen: Tabellen-Layout quetschte die leere Häkchen-Spalte (Modellnamen 14px links von „Agent default“), „Extra high“ brach bei 320px im Button um
- M1: minizilla_7 lieferte Runde 1 als `chat-1.css`; minizilla_8 legte sie bytegleich als `chat.css` ab. `chat-1.css` bleibt bei Monarch bereitgehalten und wird beim commit mitgeschrieben – Martin löscht sie
- M1: Platzhalter `::before` als `display: block; height: 0` statt `inline-block` – inline addierte er sich zum ✓ und verschob bei gewähltem Modell alle Namen um 9px (gemessen); Korrektur über frischen Worker, weil ein Worker mit vorhandener Datei sonst wieder `-1` anlegt
- Abschluss: commit, stopzilla; offen: vscode/media/chat-1.css löschen, vscode/package.json Version 0.20.0 prüfen
