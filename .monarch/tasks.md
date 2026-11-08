# Taskliste – Facelift 0.20.0, Nachbesserung

## Globale Vorgaben
- Version bleibt 0.20.0
- Zeile über dem Eingabefeld: `+` links, Badges `credits`, `co_credits`, `co_agents` mittig, Modell rechts – unabhängig von der Breite
- Modellmenü öffnet über dem Modell-Button, rechtsbündig zu ihm
- `+`-Menü: so breit wie sein Inhalt, rechts neben `+`, erster Eintrag „Current file“ auf Höhe von `+`, darf Badges und Eingabe überdecken
- Anhang-Chips: Hintergrund `--vscode-button-background`, Text `--vscode-button-foreground` (wie Send)

## Pakete
| ID | Paket | Dateien | Abhängig von | Modus | Review | Status |
|---|---|---|---|---|---|---|
| N1 | Layout der Eingabezeile, Menüpositionen, Chip-Farbe | vscode/src/chat_view.js, vscode/media/chat.css, vscode/test/chat_view_test.js | – | direct | A | fertig (Sachprüfung bestanden, im Browser nachgemessen) |

## Entscheidungen
- N1: Badges in eigenem Container `.toolbar-status`, Zeile als Grid `1fr auto 1fr` – nur so bleiben sie mittig, auch wenn + und Modell unterschiedlich breit sind
- N1: +-Menü öffnet nach rechts unten neben `+` – dann steht „Current file“ als erster Eintrag auf Höhe von `+`
- N1: Häkchen-Spalte im +-Menü ausgeblendet – das Menü hat keine Auswahlzustände, die Spalte macht es nur breiter
- N1: Spalten `minmax(max-content, 1fr) minmax(0, auto) minmax(max-content, 1fr)`, Modell max. 45vw – mit `1fr auto 1fr` wurde das Modell bei 420px auf 40px gequetscht; so bleibt es lesbar, und die Badges sind ab ca. 560px exakt mittig, darunter mittig zwischen + und Modell und umbrechend (im Browser gemessen bei 300/420/560/700px)
