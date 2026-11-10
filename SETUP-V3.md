# Gym-Tracker V3 einrichten (Testumgebung + neues Design)

Ab V3 gibt es zwei Adressen:

| Adresse | Branch | Wer |
|---|---|---|
| `https://hyrowog.github.io/gym-tracker/` | `main` | alle |
| `https://hyrowog.github.io/gym-tracker/test/` | `dev` | nur Admins |

Neue Versionen kommen zuerst in `dev`. Du schaust sie unter `/test/` an. Erst wenn alles passt, übernimmst du sie nach `main`, und alle sehen sie.

Die Testumgebung hat **eigene Daten** (beim ersten Öffnen eine Kopie deiner echten Daten). Was du dort einträgst, löschst oder kaputt machst, betrifft den echten Tracker nie. Du meldest dich dort einmal separat an.

Dauer der Einrichtung: ca. 20 Minuten, nur einmal.

---

## Schritt 1: Datenbank für die Testumgebung (3 Minuten)

1. Supabase → dein Projekt → **SQL Editor** → **New query**.
2. Den kompletten Inhalt von `schema-v3-test.sql` einfügen → **Run**. Erwartet: «Success. No rows returned».

Das legt nur eine neue Tabelle an. Deine echten Daten werden nicht verändert.

## Schritt 2: GitHub Pages auf «GitHub Actions» umstellen (2 Minuten)

1. Repository `gym-tracker` → **Settings** → links **Pages**.
2. Bei *Build and deployment* → *Source*: **GitHub Actions** wählen.

Die Seite bleibt erreichbar, sie wird ab jetzt nur anders veröffentlicht.

## Schritt 3: Veröffentlichungs-Skript in `main` anlegen (3 Minuten)

1. Im Repository auf **Code** → oben muss Branch **main** stehen.
2. **Add file → Create new file**.
3. Als Dateiname genau das eintippen (die Schrägstriche erzeugen die Ordner):
   `.github/workflows/pages.yml`
4. Den Inhalt der Datei `pages.yml` aus dem ZIP einfügen → **Commit changes** → *Commit directly to the main branch* → **Commit changes**.
5. Oben auf **Actions** klicken. Dort läuft jetzt «Seite veröffentlichen». Nach 1–2 Minuten grüner Haken = deine normale Seite läuft wie vorher.

## Schritt 4: Branch `dev` zum Veröffentlichen freigeben (2 Minuten)

GitHub erlaubt das Veröffentlichen sonst nur von `main` aus.

1. **Settings** → links **Environments** → **github-pages**.
2. Bei *Deployment branches and tags* → **Add deployment branch or tag rule**.
3. Name: `dev` → **Add rule**.

## Schritt 5: Branch `dev` erstellen (1 Minute)

1. **Code** → Branch-Knopf oben links (zeigt «main») anklicken.
2. `dev` eintippen → **Create branch dev from main**.

## Schritt 6: V3 in `dev` hochladen (3 Minuten)

1. Branch-Knopf auf **dev** stellen (wichtig!).
2. **Add file → Upload files**.
3. Diese Dateien aus dem ZIP hineinziehen: `index.html`, `app.js`, `styles.css`, `desktop.css`, `schema-v3-test.sql`, `SETUP-V3.md`, `README.md`.
4. Unten muss **Commit directly to the dev branch** stehen → **Commit changes**.
5. Unter **Actions** warten, bis der Lauf grün ist.

## Schritt 7: Testen

1. `https://hyrowog.github.io/gym-tracker/test/` öffnen (am besten am Handy).
2. Mit deinem normalen Konto anmelden. Oben steht «Testumgebung».
3. Alles ausprobieren. Unter **Mehr → Testumgebung → Neu kopieren** holst du jederzeit wieder eine frische Kopie deiner echten Daten.

Wer kein Admin ist, sieht unter `/test/` nur «Nur für Admins».

## Schritt 8: Live schalten (wenn alles passt)

1. **Pull requests** → **New pull request**.
2. *base:* `main` ← *compare:* `dev` → **Create pull request** → nochmals **Create pull request**.
3. **Merge pull request** → **Confirm merge**.
4. Unter **Actions** warten, bis es grün ist. Jetzt sehen alle die neue Version.

Für jede künftige Version: Dateien in `dev` hochladen → unter `/test/` prüfen → Pull request → Merge. Schritte 1–5 sind dann nicht mehr nötig.

---

## Was in V3 neu ist

- **Logo:** Hantel, passt sich der gewählten Farbe an (auch das Symbol im Browser-Tab).
- **Farben:** neue Farbwelten Limette (Standard), Orange, Cyan, Violett. Die alten gibt es weiter. Wählen unter **Mehr → Farbwelten**.
- **Bewegung:** Haken springt beim Bestätigen, Tasten geben nach, Ansichten blenden kurz ein, «Training abgeschlossen» ist gross in der Akzentfarbe. Wer am Handy «Bewegung reduzieren» eingestellt hat, bekommt keine Animationen.
- **Trainingsname:** Bei «Fertig» fragt die App nach einem Namen (z.B. Push). Einmal eingegeben, steht er danach zum Antippen bereit. «Ohne Namen» geht auch. Ändern kannst du ihn beim Bearbeiten im Feld unten.
- **Wiederholen pro Name:** Auf der Startseite steht jedes Training mit Namen einzeln, z.B. «Push, vor 3 Tagen». Antippen = das letzte Push-Training mit seinen Übungen.
- **Verlauf:** Zugeklappt nur Datum und Name. Antippen klappt alle Übungen auf.

## Falls etwas nicht klappt

- **Actions-Lauf rot bei `dev`** mit «not allowed to deploy»: Schritt 4 fehlt.
- **`/test/` zeigt 404:** Der Lauf nach Schritt 6 ist noch nicht fertig, oder es war nicht der Branch `dev` ausgewählt.
- **`/test/` ist leer und der Punkt oben rechts ist rot:** Schritt 1 (SQL) fehlt oder ist fehlgeschlagen.
