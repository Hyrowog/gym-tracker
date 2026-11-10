# Gym-Tracker

Schlanker Trainings-Tracker fürs Handy: Sätze direkt nach dem Satz eintragen, Fortschritt über Monate sehen. Gleiche Daten auf Handy und PC.

- Plain HTML/CSS/JavaScript, kein Framework, kein Build-Schritt
- **Version 2:** Login mit eigenem Konto (Supabase Auth, E-Mail + Passwort)
- Registrieren nur über Einladungslink (`?invite=CODE`), von der Datenbank geprüft
- Jedes Konto sieht nur seine Daten; Admins können alle Konten lesend ansehen
- Daten: localStorage (schnell, offline) + Supabase (Sync zwischen Geräten)
- Diagramme mit Chart.js 4.4.1

- **Version 3:** Trainingsnamen (z.B. Push), Wiederholen pro Name, neues Logo und Farben, Testumgebung unter `/test/` (Branch `dev`, nur Admins, eigene Testdaten)

**Einrichtung:** siehe [SETUP.md](SETUP.md) (V2) und [SETUP-V3.md](SETUP-V3.md) (Testumgebung, neue Versionen veröffentlichen).

## Code-Aufbau

`app.js` ist in nummerierte Abschnitte gegliedert (Konstanten, Hilfsfunktionen, Datenmodell, Sync, Login/Startbildschirm, Ansichten inkl. Admin, Diagramme, Aktionen, Start). Die Datenbank-Logik steht in `schema-v2.sql`: Die App greift nur über Funktionen zu, die mit `auth.uid()` arbeiten.
