# Gym-Tracker V2 einrichten (Login mit Konten)

Diese Anleitung bringt dich von V1 (Geheim-Link) auf V2 (eigene Konten mit E-Mail + Passwort). Dauer: ca. 30 Minuten. Deine Trainingsdaten aus V1 werden übernommen.

**Was V2 kann:**
- Jede Person hat ein eigenes Konto und sieht nur ihre eigenen Daten.
- Registrieren geht nur über deinen **Einladungslink**. Den Code kannst du jederzeit austauschen.
- Du als **Admin** siehst alle Konten mit Verlauf und Fortschritt (nur lesen).
- Bestätigungsmail und «Passwort vergessen» per E-Mail (Versand über Brevo, ohne eigene Domain).

---

## Übersicht der Dateien

| Datei | Wofür |
|---|---|
| `index.html`, `styles.css`, `desktop.css`, `app.js` | Die App |
| `config.js` | Supabase-URL und öffentlicher Key (unverändert aus V1) |
| `schema-v2.sql` | **Neu:** Datenbank für Konten (einmal ausführen) |
| `cleanup-v1.sql` | Entfernt die alten V1-Daten (ganz am Schluss) |
| `schema.sql` | Altes V1-Schema, nur noch zur Referenz |

---

## Schritt 0: Backup aus V1 (2 Minuten)

1. Den alten Tracker (Link mit `?k=…`) öffnen. Oben muss **«Synchronisiert»** stehen.
2. **Mehr → Backup → Exportieren**. Die Datei gut aufbewahren. Falls etwas schiefgeht, kannst du sie in V2 wieder importieren.

## Schritt 1: Datenbank erweitern

1. Supabase → dein Projekt → **SQL Editor** → **New query**.
2. Den kompletten Inhalt von `schema-v2.sql` einfügen → **Run**. Erwartet: «Success. No rows returned».
3. Ab jetzt funktioniert der alte `?k=…`-Link nicht mehr. Die Daten liegen aber noch sicher in der Datenbank, bis du sie in Schritt 7 übernimmst.

## Schritt 2: Login in Supabase einstellen

1. **Authentication → Sign In / Providers → Email**:
   - *Enable Email provider*: an
   - *Confirm email*: **an**
   - *Minimum password length*: **8**
   - Speichern.
2. **Authentication → URL Configuration**:
   - *Site URL*: `https://hyrowog.github.io/gym-tracker/`
   - *Redirect URLs* → **Add URL**: `https://hyrowog.github.io/gym-tracker/`
   - Speichern. Ohne diesen Schritt führen die Links in den Mails ins Leere.

## Schritt 3: E-Mail-Versand mit Brevo einrichten (wichtig!)

Supabase verschickt ohne eigene Einstellung nur **2 Mails pro Stunde** und **nur an Mitglieder deines Supabase-Teams**. Deine Freunde bekämen also keine Bestätigungsmail. Darum laufen die Mails über **Brevo** (gratis, 300 Mails pro Tag).

> **Ohne eigene Domain (V2):** Brevo ersetzt deine Absenderadresse automatisch durch eine eigene, z.B. `gymtracker@123456.t-sender-sib.com`. Das funktioniert, aber die Mails landen eher im Spam. Sag deinen Freunden: «Mail kommt evtl. im Spam an». Mit eigener Domain (geplant für V3) fällt das weg.

### 3a. Brevo-Konto erstellen
1. <https://www.brevo.com> → **Sign up free** → mit deiner E-Mail registrieren und bestätigen.
2. Die Fragen beim Start (Firma, Website) kurz ausfüllen. Bei *Website* kannst du `https://hyrowog.github.io/gym-tracker/` angeben. Brevo prüft neue Konten manchmal von Hand; das kann ein paar Stunden dauern.

### 3b. Absender hinzufügen
1. Oben rechts auf deinen Namen → **Senders, Domains & Dedicated IPs** → Tab **Senders** → **Add sender**.
2. *From name*: `Gym-Tracker`
3. *From email*: eine **Gmail-Adresse** (am besten ein eigenes Konto nur für den Tracker, z.B. `gymtracker.dein-name@gmail.com`).
   **Nicht** Proton, Outlook, Yahoo o.ä.: Diese Anbieter haben eine strenge DMARC-Regel, und Brevo lehnt sie als Absender ab («Deine Domain wurde nicht authentifiziert»). Gmail geht ohne eigene Domain.
4. Speichern. Brevo schickt dir einen **Code** an diese Adresse → eingeben → der Absender ist bestätigt.
5. Brevo zeigt einen Hinweis, dass Gratis-Adressen ersetzt werden. Das ist ok (siehe oben).

### 3c. SMTP-Schlüssel erzeugen
1. Zahnrad / **Settings** → **SMTP & API** → Tab **SMTP**.
2. Dort stehen **SMTP server**, **Port** und **Login**. Den **Login genau so abschreiben**, wie er dort steht (bei neuen Konten sieht er oft aus wie `8a1b2c001@smtp-brevo.com`, bei älteren ist es deine E-Mail).
3. **Generate a new SMTP key** → Name `Supabase` → den Schlüssel kopieren. **Er wird nur einmal angezeigt**, also gleich in den Passwortmanager.
   Wichtig: SMTP-Key, **nicht** API-Key.

### 3d. Brevo in Supabase eintragen
Supabase → **Authentication → Emails → SMTP Settings** → **Enable Custom SMTP** einschalten:

| Feld | Wert |
|---|---|
| Sender email | die Absenderadresse aus 3b (genau gleich geschrieben) |
| Sender name | `Gym-Tracker` |
| Host | `smtp-relay.brevo.com` |
| Port | `587` |
| Username | der **Login** aus 3c |
| Password | der **SMTP-Key** aus 3c |
| Minimum interval between emails | `30` (Sekunden, Standard lassen) |

**Save** klicken.

### 3e. Mail-Limit in Supabase erhöhen
Supabase → **Authentication → Rate Limits** → *Rate limit for sending emails* auf **100** pro Stunde setzen → Save. (Brevo erlaubt 300 pro Tag, das passt.)

### 3f. Mails auf Deutsch (empfohlen)
Unter **Authentication → Emails → Templates**:

*Confirm signup* – Betreff: `Bestätige dein Gym-Tracker-Konto`
```html
<h2>Willkommen beim Gym-Tracker</h2>
<p>Klicke auf den Link, um dein Konto zu bestätigen:</p>
<p><a href="{{ .ConfirmationURL }}">Konto bestätigen</a></p>
<p>Falls du dich nicht registriert hast, kannst du diese Mail ignorieren.</p>
```

*Reset Password* – Betreff: `Neues Passwort für den Gym-Tracker`
```html
<h2>Passwort zurücksetzen</h2>
<p>Klicke auf den Link, um ein neues Passwort zu setzen:</p>
<p><a href="{{ .ConfirmationURL }}">Neues Passwort setzen</a></p>
<p>Falls du das nicht warst, kannst du diese Mail ignorieren.</p>
```
Kurze, schlichte Mails ohne Bilder landen seltener im Spam.

### 3g. Testen
Supabase → **Authentication → Users** → **Add user → Send invitation** geht hier nicht (Einladungscode fehlt). Teste stattdessen direkt mit Schritt 5 (dein eigenes Konto). Kommt keine Mail:
- Spam-Ordner prüfen.
- Brevo → **Transactional → Logs**: Wurde die Mail verschickt oder abgelehnt?
- Supabase → **Logs → Auth**: Fehlermeldung zum SMTP.

## Schritt 4: Neue Dateien auf GitHub

1. Repository `gym-tracker` auf GitHub öffnen → **Add file → Upload files**.
2. Alle Dateien aus dem ZIP hineinziehen (bestehende werden ersetzt) → **Commit changes**.
3. 1–2 Minuten warten, dann `https://hyrowog.github.io/gym-tracker/` öffnen. Es erscheint der Login.

## Schritt 5: Dein eigenes Konto erstellen

Auch du brauchst beim ersten Mal den Einladungscode.

1. Supabase → **SQL Editor** → ausführen:
   ```sql
   select invite_code from public.app_settings;
   ```
2. Im Browser öffnen: `https://hyrowog.github.io/gym-tracker/?invite=DEIN-CODE`
3. Name, E-Mail, Passwort eingeben → **Konto erstellen** → Mail bestätigen → anmelden.

## Schritt 6: Dich zum Admin machen

Supabase → **SQL Editor** → deine E-Mail einsetzen und ausführen:
```sql
insert into public.admins (user_id)
select id from auth.users where email = 'DEINE-EMAIL@example.com'
on conflict do nothing;
```
Danach die App neu laden. Unter **Mehr** erscheint jetzt der Bereich **Admin**.

## Schritt 7: V1-Daten übernehmen

- **Am einfachsten:** Die App auf dem Gerät öffnen, auf dem du V1 benutzt hast. Nach dem Login erscheint «Daten aus Version 1 gefunden» → **Übernehmen**.
- **Alternative:** **Mehr → Daten aus Version 1** → alten Link (`…/?k=…`) einfügen → **Übernehmen**.
- **Notfall:** **Mehr → Backup → Importieren** mit der Datei aus Schritt 0.

Kontrolle: Unter **Verlauf** sind alle alten Trainings da.

## Schritt 8: Freunde einladen

**Mehr → Admin → Link kopieren** und per WhatsApp/Signal verschicken. Wer den Link öffnet, kann ein Konto erstellen.

- Link ist in falsche Hände geraten? **Neuer Code** → alter Link ist sofort ungültig, bestehende Konten bleiben.
- **Alle Konten ansehen**: Liste mit Anzahl Trainings und letztem Training. Antippen zeigt Verlauf und Fortschritt dieser Person (nur lesen). Mit **Zurück zu mir** kommst du zu deinen Daten zurück.

## Schritt 9: Aufräumen (nach ein paar Tagen)

Wenn alles läuft und deine Daten in V2 sind: `cleanup-v1.sql` im SQL Editor ausführen. Damit verschwinden die alten V1-Daten endgültig.

---

## Sicherheit in einfachen Worten

- Passwörter liegen nur bei Supabase (verschlüsselt). Die App sieht sie nie.
- Die Datenbank prüft selbst, wer was darf. Auch wer den öffentlichen Key aus `config.js` nimmt und die Webseite umgeht, kommt nur an die Daten des **eigenen** Kontos.
- Registrieren ohne gültigen Einladungscode lehnt die Datenbank ab (nicht nur die Webseite).
- Admins können fremde Daten nur **lesen**, nicht ändern.
- Bei der Registrierung steht ein Hinweis, dass der Betreiber die Trainingsdaten sehen kann. Sag es deinen Freunden trotzdem kurz.
- Nach dem Abmelden wird die lokale Kopie im Browser gelöscht. Auf fremden Geräten also immer abmelden.

## Gut zu wissen

- **Konten im Supabase-Dashboard anlegen** («Add user») geht nicht, weil dort kein Einladungscode mitkommt. Leute registrieren sich immer über den Einladungslink.
- **Konto löschen:** Supabase → **Authentication → Users** → Konto → *Delete user*. Profil und Trainingsdaten werden automatisch mitgelöscht.
- **Offline im Gym:** Wer angemeldet ist, kann ohne Netz weiter eintragen. Hochgeladen wird, sobald wieder Internet da ist.
- **Supabase Free pausiert nach 7 Tagen ohne Nutzung.** Dann im Dashboard **Restore project**.

## Probleme?

| Problem | Lösung |
|---|---|
| «Der Einladungscode ist ungültig» | Code mit `select invite_code from public.app_settings;` prüfen, oder in der App neuen Link kopieren. |
| Keine Bestätigungsmail | Spam-Ordner prüfen. Brevo → **Transactional → Logs** und Supabase → **Logs → Auth** ansehen. |
| «Die E-Mail konnte nicht verschickt werden» | SMTP-Daten in Supabase falsch: Login und SMTP-Key aus Brevo nochmals kopieren (nicht den API-Key!). Brevo-Konto evtl. noch in Prüfung. |
| «An diese Adresse kann der Server keine E-Mail schicken» | SMTP ist nicht eingerichtet (Schritt 3). |
| Link in der Mail führt auf eine falsche Seite | Schritt 2: *Site URL* und *Redirect URLs* prüfen. |
| «Der Link ist abgelaufen» | Mail-Links gelten nur kurz und nur einmal. Neu anmelden oder «Passwort vergessen» nochmals. |
| Kein «Admin»-Bereich | Schritt 6 ausgeführt? Danach App neu laden. |
| «Keine V1-Daten gefunden» | Wurden schon übernommen, oder der Link ist falsch. Notfall: Backup importieren. |
