# Gym-Tracker einrichten

Diese Anleitung bringt den Tracker in ca. 20 Minuten online: Daten in **Supabase** (kostenlose Datenbank), Webseite auf **GitHub Pages** (kostenloses Hosting). Danach hast du auf Handy und PC dieselben Daten.

> **Sofort ausprobieren ohne Einrichtung:** Öffne `index.html` direkt im Browser (Doppelklick). Die App läuft dann nur lokal in diesem Browser und zeigt oben «Sync nicht eingerichtet». Für ernsthaftes Tracken solltest du Schritt 1–3 machen.

---

## Übersicht der Dateien

| Datei | Wofür |
|---|---|
| `index.html` | Grundgerüst der Seite |
| `styles.css` | Aussehen (Farben ganz oben als Variablen) |
| `app.js` | Die ganze Logik (Training, Diagramme, Sync) |
| `config.js` | **Hier trägst du deine Supabase-Daten ein** |
| `schema.sql` | Datenbank-Tabelle für Supabase (einmal ausführen) |

---

## Schritt 1: Supabase-Projekt erstellen

1. Gehe auf <https://supabase.com> → **Start your project** → mit GitHub-Account anmelden (oder E-Mail).
2. **New project** klicken:
   - *Name:* z.B. `gym-tracker`
   - *Database Password:* ein sicheres Passwort generieren lassen und im Passwortmanager speichern (brauchst du für die App nicht, aber für Notfälle).
   - *Region:* **Central EU (Frankfurt)** oder **Zurich**, falls angeboten – nah = schnell.
   - Plan: **Free**.
3. Warten, bis das Projekt bereit ist (1–2 Minuten).

## Schritt 2: Datenbank-Tabelle anlegen

1. Im Supabase-Projekt links auf **SQL Editor** klicken.
2. **New query** (bzw. «+»).
3. Den kompletten Inhalt von `schema.sql` hineinkopieren.
4. **Run** klicken. Unten sollte «Success. No rows returned» stehen.

Kontrolle: Links unter **Table Editor** gibt es jetzt die Tabelle `gym_data` (leer).

## Schritt 3: URL und Key in `config.js` eintragen

1. Im Supabase-Projekt: **Project Settings** (Zahnrad) → **API Keys** bzw. **Data API**.
2. Du brauchst zwei Werte:
   - **Project URL**, z.B. `https://abcdefghijkl.supabase.co` (unter *Data API* oder auf der Projekt-Startseite)
   - den **öffentlichen Key**: entweder der *Publishable key* (beginnt mit `sb_publishable_…`) oder unter *Legacy API Keys* der **anon public** Key (beginnt mit `eyJ…`). Beide funktionieren. Falls einer Probleme macht, nimm den anderen.
3. **Niemals** den `service_role`- oder `secret`-Key verwenden! Der hat Vollzugriff und gehört nicht auf eine Webseite.
4. `config.js` in einem Texteditor öffnen (z.B. VS Code oder Notepad++) und die Platzhalter ersetzen:

```js
window.GYM_CONFIG = {
  supabaseUrl: 'https://abcdefghijkl.supabase.co',
  supabaseAnonKey: 'sb_publishable_xxxxxxxxxxxxxxxx',
};
```

5. Speichern. Wenn du jetzt `index.html` lokal öffnest, sollte oben nach kurzer Zeit **«Synchronisiert»** mit grünem Punkt stehen.

## Schritt 4: GitHub-Repository erstellen und Dateien hochladen

1. Auf <https://github.com> anmelden (oder kostenlos registrieren).
2. Oben rechts **+** → **New repository**:
   - *Repository name:* z.B. `gym-tracker`
   - *Public* (für GitHub Pages im Gratis-Plan nötig – siehe Sicherheitshinweis unten, das ist ok)
   - Rest leer lassen → **Create repository**.
3. Auf der neuen Seite: **uploading an existing file** anklicken.
4. Diese Dateien hineinziehen: `index.html`, `styles.css`, `app.js`, `config.js`, `schema.sql`, `SETUP.md`, `README.md`.
5. Unten **Commit changes** klicken.

## Schritt 5: GitHub Pages einschalten

1. Im Repository: **Settings** → links **Pages**.
2. Bei *Build and deployment* → *Source*: **Deploy from a branch**.
3. *Branch*: **main**, Ordner **/ (root)** → **Save**.
4. 1–2 Minuten warten, Seite neu laden. Oben erscheint: *Your site is live at* `https://<dein-name>.github.io/gym-tracker/`.

## Schritt 6: Deinen privaten Link erstellen

1. Die GitHub-Pages-Adresse am **PC** öffnen.
2. **Neuen Tracker erstellen** klicken. Die Adresse ändert sich zu
   `https://<dein-name>.github.io/gym-tracker/?k=AbCd…` – das `k=…` ist dein geheimer Schlüssel.
3. **Diesen kompletten Link speichern:** als Lesezeichen *und* im Passwortmanager. Unter **Mehr → Dein Link** kannst du ihn jederzeit kopieren.
4. Den Link aufs **Handy** schicken (z.B. per Signal an dich selbst, oder per QR-Code) und dort öffnen. Fertig – beide Geräte zeigen dieselben Daten.

Tipp fürs Handy: Im Browser-Menü «Zum Startbildschirm hinzufügen» legt schon jetzt ein Icon an, das den Link öffnet. (Eine richtige App-Installation/PWA kommt in einer späteren Version.)

> Du hast schon lokal getestet und Daten erfasst? Diese liegen nur in dem Browser, mit dem du getestet hast, unter dem damaligen Schlüssel. Am einfachsten: dort unter **Mehr → Backup → Exportieren**, dann auf der Online-Version **Importieren**.

---

## Backup und Wiederherstellen

- **Backup:** *Mehr → Backup → Exportieren*. Es wird eine Datei `gym-tracker-backup-JJJJ-MM-TT.json` heruntergeladen. Mach das z.B. einmal im Monat und leg die Datei in deine Cloud.
- **Wiederherstellen:** *Mehr → Backup → Importieren* und die JSON-Datei wählen. **Achtung:** Die aktuellen Daten werden komplett ersetzt (du wirst vorher gefragt). Danach wird automatisch auf den Server synchronisiert.

## Wie der Sync funktioniert (kurz)

- Jede Änderung wird sofort im Browser gespeichert und knapp eine Sekunde später auf den Server geladen.
- Beim Öffnen der App und wenn du wieder zur App wechselst, wird geprüft, ob der Server neuere Daten hat (z.B. vom anderen Gerät). Wenn ja, werden diese übernommen.
- Ohne Internet (z.B. im Keller-Gym) läuft alles weiter. Oben steht dann «Offline · lokal gespeichert»; sobald wieder Netz da ist, wird hochgeladen.
- Regel bei Konflikten: **die letzte Änderung gewinnt**. Wenn du also auf dem Handy offline trainierst *und gleichzeitig* am PC etwas änderst, gewinnt das Gerät, das zuletzt geändert hat. Bei einer Person mit zwei Geräten kommt das praktisch nie vor.
- Schutz: Leere Daten überschreiben nie volle Daten auf dem Server, und solange der Server nicht erreichbar war, wird nichts hochgeladen.

## Sicherheit in einfachen Worten

- Es gibt **kein Login**. Wer deinen Link (mit `?k=…`) hat, kann deine Trainingsdaten sehen und ändern. Behandle den Link wie ein Passwort: nicht teilen, nicht in Gruppen-Chats posten, keine Screenshots davon verschicken.
- Der Schlüssel ist 32 zufällige Zeichen lang – erraten ist praktisch unmöglich.
- Der Supabase-Key in `config.js` ist **öffentlich** gedacht und darf im (öffentlichen) GitHub-Repository stehen. Er erlaubt nur, die zwei Funktionen aus `schema.sql` aufzurufen: Daten *zu einem bekannten Schlüssel* lesen oder speichern. Eine Liste aller Schlüssel oder fremde Daten kann man damit nicht abrufen.
- Theoretisch könnte jemand mit dem öffentlichen Key eigene, neue Einträge in deiner Datenbank anlegen (mit einem selbst ausgedachten Schlüssel). Das stört deine Daten nicht und ist auf 5 MB pro Eintrag begrenzt. Für einen privaten Trainings-Tracker ist das ein vernünftiger Kompromiss.
- Gespeichert werden nur Trainingsdaten und Körpergewicht – keine Namen, keine E-Mail.
- Falls der Link doch mal in falsche Hände gerät: *Exportieren*, dann neuen Tracker erstellen (Startseite ohne `?k=` öffnen) und dort *Importieren*. Den alten Eintrag kannst du in Supabase unter *Table Editor → gym_data* löschen.

## Gut zu wissen

- **Supabase Free pausiert Projekte nach 7 Tagen ohne Nutzung.** Solange du regelmässig trainierst, passiert das nicht. Falls doch: Supabase-Dashboard öffnen → **Restore project**. In der Zwischenzeit läuft die App mit den lokal gespeicherten Daten weiter.
- Daten im Browser löschen (Cache/Websitedaten) ist kein Problem, solange der Sync eingerichtet ist – beim nächsten Öffnen kommt alles vom Server.
- Änderungen am Code: Datei auf GitHub bearbeiten oder neu hochladen → nach 1–2 Minuten ist die neue Version online (evtl. Seite neu laden).

## Probleme?

| Anzeige / Problem | Lösung |
|---|---|
| «Sync nicht eingerichtet» | `config.js` enthält noch die Platzhalter oder wurde nicht mit hochgeladen. |
| «Offline · lokal gespeichert», obwohl Internet da ist | URL/Key in `config.js` prüfen; `schema.sql` ausgeführt? Projekt pausiert? Im Browser F12 → Konsole zeigt die Fehlermeldung. |
| Handy zeigt andere Daten als PC | Prüfen, ob auf beiden Geräten **genau derselbe Link** (gleiches `k=…`) offen ist. |
| Diagramme fehlen | Chart.js wird aus dem Internet geladen; ohne Verbindung beim ersten Öffnen erscheinen keine Diagramme. Seite mit Internet neu laden. |
