# Integrierte Agentenschritt-Anzeige

## Installation

Im Repository `cd vscode` ausführen und anschließend `python build_vsix.py` starten. Die erzeugte VSIX in VS Code über **Extensions → … → Install from VSIX** installieren und VS Code neu laden.

## Nutzung

Agent auswählen und Nachricht senden. Während der Ausführung zeigt Monarch die jeweils neueste Aktion in einer wechselnden einzeiligen Anzeige. Ein Klick öffnet den Verlauf; jede einzelne Aktion lässt sich aufklappen und zeigt bereinigte Parameter, Ergebnis und Status. Aktionen werden nicht dupliziert, und der Verlauf bleibt nach Abschluss aufklappbar. Fehlende Details werden nicht ergänzt oder erfunden.

## Konfiguration

Ausschließlich die bestehende Einstellung `monarch.pollInterval` steuert den Abrufintervall in Sekunden; der Standardwert ist `3`.

## Verfügbarkeit und Datenschutz

Der Ereigniszugriff verwendet Monarchs eigene Anmeldung. Fehlt dieser Zugriff, dienen Nachrichten-Werkzeugaufrufe als möglicherweise verzögerter oder unvollständiger Ersatz. Sind keine Aktivitätsdaten verfügbar, bleibt die normale Warteanzeige sichtbar. Eine Browserberechtigung gilt nicht automatisch als Monarchberechtigung.

Die Anzeige enthält keine internen Gedankengänge oder Zugangsdaten. Fragekarten, Stoppen und Relay bleiben unverändert; Monarchs eigene Aktionen werden weiterhin getrennt angezeigt.
