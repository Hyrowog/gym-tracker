# Gym-Tracker

Schlanker Trainings-Tracker fürs Handy: Sätze direkt nach dem Satz eintragen, Fortschritt über Monate sehen. Gleiche Daten auf Handy und PC.

- Plain HTML/CSS/JavaScript, kein Framework, kein Build-Schritt
- Daten: localStorage (schnell, offline) + Supabase (Sync zwischen Geräten)
- Zugang über privaten Link mit geheimem Schlüssel (`?k=…`), kein Login
- Diagramme mit Chart.js 4.4.1

**Einrichtung:** siehe [SETUP.md](SETUP.md).

## Code-Aufbau

`app.js` ist in nummerierte Abschnitte gegliedert (Konstanten, Hilfsfunktionen, Datenmodell, Sync, Link/Startbildschirm, Ansichten, Diagramme, Aktionen, Start). Neue Funktionen wie Pausen-Timer oder PWA passen als eigene Abschnitte bzw. Dateien (`manifest.json`, `sw.js`) dazu, ohne den Rest umzubauen.
