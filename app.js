/* =====================================================================
   Gym-Tracker – App-Logik (ohne Framework)

   Aufbau dieser Datei:
     1. Konstanten & Zustand
     2. Hilfsfunktionen (Datum, Zahlen, HTML)
     3. Datenmodell & lokaler Speicher (localStorage)
     4. Sync mit Supabase (pro Konto)
     5. Login, Registrierung & Startbildschirm (Supabase Auth)
     6. Ansichten (Training, Verlauf, Fortschritt, Mehr, Admin)
     7. Diagramme & Heatmap
     8. Aktionen (Klicks, Eingaben)
     9. Start

   Version 2: Login mit eigenem Konto (E-Mail + Passwort). Registrieren nur
   über einen Einladungslink (?invite=CODE). Jedes Konto sieht nur seine
   eigenen Daten; Admins können alle Konten lesend ansehen.

   Datenformat (wird 1:1 als JSON gespeichert und synchronisiert):
   {
     version: 1,
     updatedAt: "2026-11-02T18:00:00.000Z",
     exercises:  [{ id, name, type: "weight" | "bodyweight", variant }],
     workouts:   [{ id, date: "YYYY-MM-DD", note, createdAt,
                    entries: [{ id, exerciseId, variant,
                                sets: [{ weight: number|null, reps: number|null }] }] }],
     bodyweight: [{ id, date: "YYYY-MM-DD", kg }]
   }
   ===================================================================== */
'use strict';

/* ---------------------------------------------------------------------
   1. Konstanten & Zustand
   --------------------------------------------------------------------- */
const STORAGE_PREFIX = 'gymtracker:';
const PREFS_KEY = STORAGE_PREFIX + 'prefs';
const SECRET_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
const WEIGHT_STEP = 2.5;
const DEFAULT_SET_COUNT = 3;
const SYNC_DEBOUNCE_MS = 800;
const SYNC_RETRY_MS = 30000;

const RANGES = {
  '4w': { label: '4 Wochen', days: 28 },
  '3m': { label: '3 Monate', days: 91 },
  all: { label: 'Alles', days: null },
};

const TYPE_LABELS = { weight: 'Gewicht', bodyweight: 'Körpergewicht' };

/* Farbwelten aus dem Redesign (nur Darstellung, pro Gerät in prefs gespeichert) */
const PALETTES = [
  ['stahl', 'Stahl', 'Kühl und sachlich, wirkt wie ein Werkzeug.'],
  ['messing', 'Messing', 'Warmes Amber, ruhig und mit viel Kontrast.'],
  ['tartan', 'Tartan', 'Das Rot der Laufbahn. Am energiegeladensten.'],
  ['rasen', 'Rasen', 'Grün wie die Schlittenbahn. Akzent und «erledigt» fallen zusammen.'],
  ['magnesia', 'Magnesia', 'Fast nur Schwarz und Weiss. Farbe bleibt für Status und Rekorde.'],
  ['indigo', 'Indigo', 'Violett-Blau, etwas verspielter.'],
];

const SYNC_LABELS = {
  local: 'Sync nicht eingerichtet',
  syncing: 'Speichert …',
  synced: 'Synchronisiert',
  offline: 'Offline · lokal gespeichert',
};

const INVITE_KEY = STORAGE_PREFIX + 'invite';      // Einladungscode aus dem Link (sessionStorage)
const INVITE_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;
const MIN_PASSWORD = 8;

/* Aktionen, die beim Ansehen eines fremden Kontos (Admin, nur lesen) erlaubt sind */
const READONLY_ACTIONS = new Set(['nav', 'stats-ex', 'set-range', 'admin-exit', 'set-theme', 'set-palette']);

const state = {
  userId: null,               // angemeldetes Konto (Supabase-User-ID)
  data: null,                 // synchronisierte Daten (siehe Format oben)
  meta: {                     // nur lokal (pro Gerät), wird nicht synchronisiert
    dirty: false,             // true = lokale Änderungen noch nicht auf dem Server
    lastSyncedAt: null,
    activeWorkoutId: null,    // Training, das gerade bearbeitet wird
    profile: null,            // { email, display_name, is_admin } (Kopie für offline)
  },
  prefs: { theme: 'dark', palette: 'stahl', range: '3m', lastSecret: null, lastUserId: null },
  auth: {
    client: null,
    recovery: false,          // true = über «Passwort vergessen»-Link gekommen
    gateMode: 'login',        // login | register | registered | forgot | forgot-sent | reset | offline
    gateEmail: '',
    gateName: '',
    busy: false,
    pendingError: '',         // Fehler aus einem Mail-Link, wird im Login angezeigt
    checkingSession: false,
  },
  admin: {
    users: null,              // Liste aller Konten (nur Admin)
    inviteCode: null,
    viewAs: null,             // { id, name } = fremdes Konto wird angesehen (nur lesen)
    ownData: null,            // eigene Daten, solange ein fremdes Konto angezeigt wird
  },
  view: 'training',
  statsExerciseId: null,
  focus: null,                // aktueller Satz im Training { entry, set } (nur Anzeige)
  summary: null,              // Zusammenfassung nach «Fertig» (nur Anzeige)
  charts: {},                 // aktive Chart.js-Instanzen
  sync: {
    configured: false,
    client: null,
    status: 'local',
    serverChecked: false,     // true, sobald der Server einmal erfolgreich gelesen wurde
    serverHadData: false,
    pulling: false,
    pushing: false,
    pushAgain: false,
    pushTimer: null,
    allowEmptyOnce: false,
  },
};

/* ---------------------------------------------------------------------
   2. Hilfsfunktionen
   --------------------------------------------------------------------- */
const $ = (sel, root = document) => root.querySelector(sel);

/** Text sicher für innerHTML machen. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/** Date → "YYYY-MM-DD" (lokale Zeit, nicht UTC). */
function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function todayISO() { return toISODate(new Date()); }
function parseISODate(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }
function isValidISODate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !isNaN(parseISODate(s)); }

function formatDate(iso, style = 'long') {
  const d = parseISODate(iso);
  if (style === 'short') return d.toLocaleDateString('de-CH', { day: 'numeric', month: 'short' });
  if (style === 'weekday') return d.toLocaleDateString('de-CH', { weekday: 'short', day: 'numeric', month: 'short' });
  return d.toLocaleDateString('de-CH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
function relativeDay(iso) {
  const diff = Math.round((parseISODate(todayISO()) - parseISODate(iso)) / 86400000);
  if (diff === 0) return 'Heute';
  if (diff === 1) return 'Gestern';
  if (diff > 1 && diff < 7) return `vor ${diff} Tagen`;
  return formatDate(iso, 'weekday');
}

/** "62,5" oder "62.5" → 62.5; leer/ungültig → null. */
function parseNum(str) {
  if (str === null || str === undefined || String(str).trim() === '') return null;
  const n = parseFloat(String(str).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
function fmtNum(n, digits = 2) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  const f = 10 ** digits;
  return String(Math.round(n * f) / f);
}
function roundHalf(n) { return Math.round(n * 2) / 2; }

let toastTimer = null;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/**
 * Farbe eines CSS-Tokens als "rgb(...)". Die Tokens nutzen light-dark() und
 * color-mix(), darum über ein unsichtbares Element auflösen lassen.
 */
let colorProbe = null;
function cssVar(name) {
  if (!colorProbe) {
    colorProbe = document.createElement('span');
    colorProbe.style.display = 'none';
    document.body.appendChild(colorProbe);
  }
  colorProbe.style.color = '';
  colorProbe.style.color = `var(${name})`;
  return getComputedStyle(colorProbe).color;
}
function cssFont() {
  return getComputedStyle(document.documentElement).getPropertyValue('--font').trim() || 'system-ui, sans-serif';
}

const ICON_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const ICON_STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.9 6.2 6.8.8-5 4.6 1.3 6.7-6-3.3-6 3.3 1.3-6.7-5-4.6 6.8-.8z"/></svg>';

/* ---------------------------------------------------------------------
   3. Datenmodell & lokaler Speicher
   --------------------------------------------------------------------- */
function emptyData() {
  return { version: 1, updatedAt: null, exercises: [], workouts: [], bodyweight: [] };
}

function isEmptyData(d) {
  return !d || (d.exercises.length === 0 && d.workouts.length === 0 && d.bodyweight.length === 0);
}

/**
 * Prüft und bereinigt Daten (z.B. aus Import, Server oder Cache).
 * Wirft einen Fehler, wenn die Struktur gar nicht passt.
 */
function normalizeData(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Keine gültigen Daten');
  if (!Array.isArray(raw.workouts) && !Array.isArray(raw.exercises)) throw new Error('Keine Trainingsdaten gefunden');

  const num = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  const exercises = (raw.exercises || [])
    .filter((e) => e && e.id && typeof e.name === 'string')
    .map((e) => ({
      id: String(e.id),
      name: e.name.trim().slice(0, 80) || 'Übung',
      type: e.type === 'bodyweight' ? 'bodyweight' : 'weight',
      variant: typeof e.variant === 'string' ? e.variant.slice(0, 60) : '',
    }));
  const exIds = new Set(exercises.map((e) => e.id));

  const workouts = (raw.workouts || [])
    .filter((w) => w && w.id && isValidISODate(w.date))
    .map((w) => ({
      id: String(w.id),
      date: w.date,
      note: typeof w.note === 'string' ? w.note.slice(0, 2000) : '',
      createdAt: w.createdAt || null,
      entries: (w.entries || [])
        .filter((en) => en && exIds.has(String(en.exerciseId)))
        .map((en) => ({
          id: String(en.id || uid()),
          exerciseId: String(en.exerciseId),
          variant: typeof en.variant === 'string' ? en.variant.slice(0, 60) : '',
          sets: (en.sets || []).map((s) => ({ weight: num(s && s.weight), reps: num(s && s.reps) })),
        })),
    }));

  const bodyweight = (raw.bodyweight || [])
    .filter((b) => b && isValidISODate(b.date) && Number.isFinite(Number(b.kg)))
    .map((b) => ({ id: String(b.id || uid()), date: b.date, kg: Number(b.kg) }));

  return { version: 1, updatedAt: raw.updatedAt || null, exercises, workouts, bodyweight };
}

function cacheKey(userId = state.userId) { return STORAGE_PREFIX + 'user:' + userId; }

function loadCache() {
  try {
    const raw = localStorage.getItem(cacheKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return { data: normalizeData(parsed.data), meta: parsed.meta || {} };
  } catch (err) {
    console.warn('Cache nicht lesbar', err);
    return null;
  }
}

function saveCache() {
  if (state.admin.viewAs || !state.userId) return; // fremde Daten nie lokal speichern
  try {
    localStorage.setItem(cacheKey(), JSON.stringify({ data: state.data, meta: state.meta }));
  } catch (err) {
    console.warn('Cache nicht speicherbar', err);
  }
}

function loadPrefs() {
  try { Object.assign(state.prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch { /* egal */ }
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)); } catch { /* egal */ }
}

/** Nach jeder Änderung an state.data aufrufen: speichert lokal und synchronisiert. */
function commit() {
  if (state.admin.viewAs) { toast('Nur ansehen – fremdes Konto'); return; }
  state.data.updatedAt = new Date().toISOString();
  state.meta.dirty = true;
  saveCache();
  scheduleSync();
}

/* --- Abfragen auf den Daten --- */
function getExercise(id) { return state.data.exercises.find((e) => e.id === id) || null; }
function getWorkout(id) { return state.data.workouts.find((w) => w.id === id) || null; }

function findExerciseByName(name) {
  const n = name.trim().toLowerCase();
  return state.data.exercises.find((e) => e.name.toLowerCase() === n) || null;
}

/** Trainings, neuestes zuerst. */
function sortedWorkouts() {
  return [...state.data.workouts].sort((a, b) =>
    b.date.localeCompare(a.date) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

/** Letzter Eintrag einer Übung (ausser im Training excludeId). */
function lastEntryFor(exerciseId, excludeWorkoutId = null) {
  for (const w of sortedWorkouts()) {
    if (w.id === excludeWorkoutId) continue;
    const entry = w.entries.find((e) => e.exerciseId === exerciseId);
    if (entry) return { workout: w, entry };
  }
  return null;
}

/** Übungen, zuletzt benutzte zuerst. */
function exercisesByRecency() {
  const lastUse = {};
  for (const w of state.data.workouts) {
    for (const e of w.entries) {
      if (!lastUse[e.exerciseId] || lastUse[e.exerciseId] < w.date) lastUse[e.exerciseId] = w.date;
    }
  }
  return [...state.data.exercises].sort((a, b) =>
    (lastUse[b.id] || '').localeCompare(lastUse[a.id] || '') || a.name.localeCompare(b.name, 'de'));
}

function exerciseUseCount(id) {
  return state.data.workouts.filter((w) => w.entries.some((e) => e.exerciseId === id)).length;
}

function validSets(entry) {
  return entry.sets.filter((s) => s.reps !== null && s.reps > 0);
}

/* --- Änderungen an Trainings --- */
function createWorkout(date = todayISO()) {
  const w = { id: uid(), date, note: '', createdAt: new Date().toISOString(), entries: [] };
  state.data.workouts.push(w);
  return w;
}

/** Sätze für eine Übung vorbereiten: vom letzten Mal übernehmen, sonst 3 leere. */
function startingSets(exerciseId, excludeWorkoutId) {
  const last = lastEntryFor(exerciseId, excludeWorkoutId);
  if (last && last.entry.sets.length) {
    return last.entry.sets.map((s) => ({ weight: s.weight, reps: s.reps }));
  }
  return Array.from({ length: DEFAULT_SET_COUNT }, () => ({ weight: null, reps: null }));
}

function addEntry(workout, exercise) {
  const last = lastEntryFor(exercise.id, workout.id);
  workout.entries.push({
    id: uid(),
    exerciseId: exercise.id,
    variant: exercise.type === 'bodyweight' ? (last ? last.entry.variant : exercise.variant || '') : '',
    sets: startingSets(exercise.id, workout.id),
  });
}

function startWorkout(mode) {
  const previous = sortedWorkouts().find((w) => w.entries.length > 0);
  const w = createWorkout();
  if (mode === 'repeat' && previous) {
    // Übungen vom letzten Training übernehmen, Werte als Startwerte
    w.entries = previous.entries.map((e) => ({
      id: uid(),
      exerciseId: e.exerciseId,
      variant: e.variant,
      sets: e.sets.map((s) => ({ weight: s.weight, reps: s.reps })),
    }));
  }
  state.meta.activeWorkoutId = w.id;
  state.meta.doneSets = { [w.id]: {} }; // Haken-Stand nur lokal: neues Training, noch nichts bestätigt
  state.focus = null;
  state.summary = null;
  commit();
  render();
  window.scrollTo(0, 0);
}

/* ---------------------------------------------------------------------
   4. Sync mit Supabase
   Ablauf:
     - Beim Start: lokale Daten sofort anzeigen, dann Server lesen.
     - Server neuer als lokal → Server übernehmen.
     - Lokal neuer und noch nicht hochgeladen → hochladen.
     - Jede Änderung → nach kurzer Pause hochladen ("last write wins").
     - Solange der Server nie erfolgreich gelesen wurde, wird NICHT
       hochgeladen (damit nie leere Daten den Server überschreiben).
   --------------------------------------------------------------------- */
/** Prüft config.js und ob die Supabase-Bibliothek geladen ist. */
function configCheck() {
  const cfg = window.GYM_CONFIG || {};
  const urlOk = typeof cfg.supabaseUrl === 'string' && /^https:\/\/[^\s]+$/.test(cfg.supabaseUrl);
  const keyOk = typeof cfg.supabaseAnonKey === 'string' && cfg.supabaseAnonKey.length > 20 && !cfg.supabaseAnonKey.startsWith('DEIN');
  const libOk = !!(window.supabase && window.supabase.createClient);
  return { cfg, configOk: urlOk && keyOk, libOk };
}

/** Sync für das angemeldete Konto einschalten (Client kommt aus dem Login). */
function initSync() {
  state.sync.client = state.auth.client;
  state.sync.configured = !!state.auth.client;
  state.sync.serverChecked = false;
  state.sync.serverHadData = false;
  if (state.sync.configured) setSyncStatus(state.meta.dirty ? 'syncing' : 'synced');
  else setSyncStatus('offline');
}

/** Fehler vom Server, die bedeuten: Sitzung abgelaufen → neu anmelden. */
function isAuthError(err) {
  const msg = String((err && (err.message || err.msg)) || '');
  return /not authenticated|JWT|jwt expired|invalid claim/i.test(msg) || (err && (err.status === 401 || err.code === 'PGRST301'));
}

function setSyncStatus(status) {
  state.sync.status = status;
  const pill = $('#syncPill');
  if (!pill) return;
  pill.dataset.status = status;
  $('.sync-label', pill).textContent = SYNC_LABELS[status] || status;
  pill.title = status === 'offline' && !state.sync.configured
    ? 'Keine Verbindung zum Server. Änderungen werden später hochgeladen.'
    : (state.meta.lastSyncedAt ? 'Zuletzt synchronisiert: ' + new Date(state.meta.lastSyncedAt).toLocaleString('de-CH') : '');
  if (state.view === 'settings') {
    const s = $('#syncStatusText');
    if (s) s.textContent = SYNC_LABELS[status];
  }
}

/** Server lesen und mit lokalem Stand abgleichen. */
async function pullFromServer() {
  if (!state.sync.configured || state.sync.pulling || state.admin.viewAs || !state.userId) return;
  const userAtStart = state.userId;
  state.sync.pulling = true;
  setSyncStatus('syncing');
  try {
    const { data: row, error } = await state.sync.client.rpc('get_my_data');
    if (error) throw error;
    // Während der Abfrage abgemeldet oder in ein fremdes Konto gewechselt → verwerfen
    if (state.userId !== userAtStart || state.admin.viewAs) return;
    state.sync.serverChecked = true;

    if (!row || !row.data) {
      // Noch nichts auf dem Server → lokale Daten hochladen (falls vorhanden)
      state.sync.serverHadData = false;
      if (!isEmptyData(state.data) || state.meta.dirty) {
        state.sync.pulling = false;
        await pushToServer();
      } else {
        setSyncStatus('synced');
      }
      return;
    }

    const server = normalizeData(row.data);
    state.sync.serverHadData = !isEmptyData(server);
    const localTime = Date.parse(state.data.updatedAt || 0) || 0;
    const serverTime = Date.parse(server.updatedAt || 0) || 0;

    if (!state.meta.lastSyncedAt && !isEmptyData(state.data) && state.sync.serverHadData) {
      // Dieses Gerät war noch nie synchronisiert (z.B. offline gestartet), hat aber
      // schon Einträge → zusammenführen statt Serverdaten zu überschreiben.
      state.data = mergeData(server, state.data);
      state.meta.dirty = true;
      saveCache();
      render();
      state.sync.pulling = false;
      await pushToServer();
    } else if (state.meta.dirty && localTime > serverTime) {
      // Lokal neuer → hochladen
      state.sync.pulling = false;
      await pushToServer();
    } else if (serverTime !== localTime) {
      // Server neuer (oder lokal ohne ungespeicherte Änderungen) → übernehmen
      state.data = server;
      state.meta.dirty = false;
      state.meta.lastSyncedAt = new Date().toISOString();
      if (state.meta.activeWorkoutId && !getWorkout(state.meta.activeWorkoutId)) state.meta.activeWorkoutId = null;
      saveCache();
      render();
      setSyncStatus('synced');
    } else {
      state.meta.dirty = false;
      state.meta.lastSyncedAt = new Date().toISOString();
      saveCache();
      setSyncStatus('synced');
    }
  } catch (err) {
    console.warn('Server nicht erreichbar', err);
    setSyncStatus('offline');
    if (isAuthError(err)) handleExpiredSession();
  } finally {
    state.sync.pulling = false;
  }
}

/**
 * Lokale Einträge zu den Serverdaten hinzufügen (nur für Geräte, die noch nie
 * synchronisiert waren). Übungen mit gleichem Namen werden zusammengelegt.
 */
function mergeData(server, local) {
  const out = normalizeData(JSON.parse(JSON.stringify(server)));
  const idMap = {};
  for (const ex of local.exercises) {
    const same = out.exercises.find((e) => e.id === ex.id)
      || out.exercises.find((e) => e.name.toLowerCase() === ex.name.toLowerCase());
    if (same) idMap[ex.id] = same.id;
    else { out.exercises.push({ ...ex }); idMap[ex.id] = ex.id; }
  }
  for (const w of local.workouts) {
    if (out.workouts.some((x) => x.id === w.id)) continue;
    out.workouts.push({ ...w, entries: w.entries.map((e) => ({ ...e, exerciseId: idMap[e.exerciseId] || e.exerciseId })) });
  }
  for (const b of local.bodyweight) {
    if (!out.bodyweight.some((x) => x.id === b.id || x.date === b.date)) out.bodyweight.push({ ...b });
  }
  out.updatedAt = new Date().toISOString();
  return out;
}

function scheduleSync() {
  if (!state.sync.configured) { setSyncStatus('local'); return; }
  setSyncStatus('syncing');
  clearTimeout(state.sync.pushTimer);
  state.sync.pushTimer = setTimeout(pushToServer, SYNC_DEBOUNCE_MS);
}

/** Lokale Daten auf den Server schreiben. */
async function pushToServer() {
  clearTimeout(state.sync.pushTimer);
  if (!state.sync.configured || state.admin.viewAs || !state.userId) return;
  if (!state.sync.serverChecked) {
    // Erst den Server lesen; pullFromServer lädt bei Bedarf selbst hoch.
    await pullFromServer();
    return;
  }
  if (state.sync.pushing) { state.sync.pushAgain = true; return; }

  // Sicherung: niemals einen leeren Datensatz über volle Serverdaten schreiben
  if (isEmptyData(state.data) && state.sync.serverHadData && !state.sync.allowEmptyOnce) {
    console.warn('Leere Daten werden nicht hochgeladen.');
    setSyncStatus('offline');
    return;
  }

  state.sync.pushing = true;
  setSyncStatus('syncing');
  const snapshotTime = state.data.updatedAt;
  try {
    const userAtStart = state.userId;
    const { error } = await state.sync.client.rpc('save_my_data', { p_data: state.data });
    if (error) throw error;
    if (state.userId !== userAtStart) return;
    state.sync.allowEmptyOnce = false;
    state.sync.serverHadData = !isEmptyData(state.data);
    if (state.data.updatedAt === snapshotTime) state.meta.dirty = false;
    state.meta.lastSyncedAt = new Date().toISOString();
    saveCache();
    setSyncStatus(state.meta.dirty ? 'syncing' : 'synced');
  } catch (err) {
    console.warn('Speichern auf Server fehlgeschlagen', err);
    setSyncStatus('offline');
    if (isAuthError(err)) handleExpiredSession();
  } finally {
    state.sync.pushing = false;
    if (state.sync.pushAgain || (state.meta.dirty && state.sync.status !== 'offline')) {
      state.sync.pushAgain = false;
      scheduleSync();
    }
  }
}

/** Abgleich bei Rückkehr in die App, Netzwerk wieder da oder periodisch. */
function syncNow() {
  if (!state.sync.configured || state.admin.viewAs || !state.userId) return;
  if (state.meta.dirty && state.sync.serverChecked) pushToServer();
  else pullFromServer();
}

/* ---------------------------------------------------------------------
   5. Login, Registrierung & Startbildschirm
   Supabase Auth mit E-Mail + Passwort. Die Sitzung bleibt im Browser
   gespeichert (man bleibt angemeldet). Registrieren nur mit Einladungscode
   aus dem Link ?invite=CODE; die Datenbank prüft den Code selbst.
   --------------------------------------------------------------------- */
function appUrl() {
  return location.origin + location.pathname;
}

function inviteLink(code) {
  const url = new URL(appUrl());
  url.searchParams.set('invite', code);
  return url.toString();
}

function getInvite() {
  try { return sessionStorage.getItem(INVITE_KEY) || ''; } catch { return ''; }
}
function setInvite(code) {
  try {
    if (code) sessionStorage.setItem(INVITE_KEY, code);
    else sessionStorage.removeItem(INVITE_KEY);
  } catch { /* egal */ }
}

/** ?invite=CODE aus der Adresse lesen, merken und aus der Adresse entfernen. */
function readInviteFromUrl() {
  const params = new URLSearchParams(location.search);
  const code = params.get('invite');
  if (code === null) return;
  if (INVITE_PATTERN.test(code)) {
    setInvite(code);
    state.auth.gateMode = 'register';
  }
  params.delete('invite');
  const q = params.toString();
  history.replaceState(null, '', appUrl() + (q ? '?' + q : '') + location.hash);
}

/** Fehler aus Mail-Links (z.B. abgelaufen) lesen: #error=...&error_code=... */
function readHashError() {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (!hash.get('error') && !hash.get('error_code')) return '';
  history.replaceState(null, '', location.pathname + location.search);
  const code = hash.get('error_code') || '';
  if (code === 'otp_expired') return 'Der Link ist abgelaufen oder wurde schon benutzt. Melde dich an oder fordere einen neuen Link an.';
  return 'Der Link hat nicht funktioniert. Bitte nochmals versuchen.';
}

/** Fehlermeldungen von Supabase Auth auf Deutsch. */
function authErrorText(err) {
  const code = (err && err.code) || '';
  const msg = String((err && err.message) || '');
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(msg)) return 'E-Mail oder Passwort ist falsch.';
  if (code === 'email_not_confirmed' || /email not confirmed/i.test(msg)) return 'Bitte bestätige zuerst deine E-Mail-Adresse (Link im Postfach).';
  if (code === 'user_already_exists' || /already registered/i.test(msg)) return 'Für diese E-Mail gibt es schon ein Konto. Melde dich an.';
  if (code === 'weak_password' || /password should be/i.test(msg)) return `Das Passwort ist zu schwach. Mindestens ${MIN_PASSWORD} Zeichen.`;
  if (/rate limit|over_email_send_rate_limit|too many/i.test(code + ' ' + msg)) return 'Zu viele Versuche in kurzer Zeit. Bitte in ein paar Minuten nochmals.';
  if (/Database error saving new user|invalid invite/i.test(msg)) return 'Der Einladungscode ist ungültig. Frag nach einem neuen Einladungslink.';
  if (/email address .* invalid|invalid email|validate email/i.test(msg)) return 'Diese E-Mail-Adresse ist ungültig.';
  if (/not authorized/i.test(msg)) return 'An diese Adresse kann der Server keine E-Mail schicken (E-Mail-Versand nicht eingerichtet).';
  if (/fetch|network|Failed to/i.test(msg)) return 'Keine Verbindung zum Server. Bist du online?';
  return 'Das hat nicht geklappt: ' + (msg || 'unbekannter Fehler');
}

function gateBrand() {
  return `
    <div class="gate-brand">
      <span class="logo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6M7 7v10M17 7v10M20 9v6M7 12h10"/></svg></span>
      <h1 class="title">Gym-Tracker</h1>
    </div>`;
}

function renderGate(errorText = '', infoText = '') {
  const gate = $('#gate');
  const a = state.auth;
  const invite = getInvite();
  const err = errorText ? `<p class="error" role="alert">${esc(errorText)}</p>` : '';
  const info = infoText ? `<p class="gate-info" role="status">${esc(infoText)}</p>` : '';
  const email = esc(a.gateEmail);
  const busy = a.busy ? 'disabled' : '';
  let body = '';

  if (a.gateMode === 'register' && invite) {
    body = `
      <p>Du wurdest eingeladen. Erstelle dein Konto, danach trackst du dein Training auf Handy und PC.</p>
      ${err}${info}
      <form class="gate-actions card" data-form="register" novalidate>
        <label class="field">Vorname oder Spitzname
          <input class="input" name="name" autocomplete="nickname" maxlength="60" value="${esc(a.gateName)}" required>
        </label>
        <label class="field">E-Mail
          <input class="input" name="email" type="email" autocomplete="email" autocapitalize="off" spellcheck="false" value="${email}" required>
        </label>
        <label class="field">Passwort (mind. ${MIN_PASSWORD} Zeichen)
          <input class="input" name="password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required>
        </label>
        <p class="small muted">Hinweis: Der Betreiber dieses Trackers kann deine Trainingsdaten einsehen (nur lesen). Andere Nutzer sehen nichts.</p>
        <button class="btn btn-p block" type="submit" ${busy}>${a.busy ? 'Einen Moment …' : 'Konto erstellen'}</button>
      </form>
      <p class="small muted">Schon ein Konto? <button class="link-btn" data-action="gate-mode" data-mode="login">Anmelden</button></p>`;
  } else if (a.gateMode === 'registered') {
    body = `
      <div class="card">
        <h2>Fast geschafft</h2>
        <p class="muted">Wir haben dir eine E-Mail an <b>${email}</b> geschickt. Klicke auf den Link darin, um dein Konto zu bestätigen. Danach kannst du dich anmelden.</p>
        <p class="small muted">Keine Mail? Schau im Spam-Ordner nach.</p>
        <div class="row-2">
          <button class="btn btn-s" data-action="resend-confirm" ${busy}>Nochmals senden</button>
          <button class="btn btn-p" data-action="gate-mode" data-mode="login">Zum Login</button>
        </div>
      </div>
      ${err}${info}`;
  } else if (a.gateMode === 'forgot') {
    body = `
      <p>Gib deine E-Mail ein. Du bekommst einen Link, mit dem du ein neues Passwort setzen kannst.</p>
      ${err}${info}
      <form class="gate-actions card" data-form="forgot" novalidate>
        <label class="field">E-Mail
          <input class="input" name="email" type="email" autocomplete="email" autocapitalize="off" spellcheck="false" value="${email}" required>
        </label>
        <button class="btn btn-p block" type="submit" ${busy}>${a.busy ? 'Einen Moment …' : 'Link senden'}</button>
      </form>
      <p class="small muted"><button class="link-btn" data-action="gate-mode" data-mode="login">Zurück zum Login</button></p>`;
  } else if (a.gateMode === 'forgot-sent') {
    body = `
      <div class="card">
        <h2>E-Mail ist unterwegs</h2>
        <p class="muted">Falls es ein Konto für <b>${email}</b> gibt, kommt gleich eine E-Mail mit einem Link zum Zurücksetzen. Den Link am besten auf dem Gerät öffnen, auf dem du das neue Passwort setzen willst.</p>
        <button class="btn btn-p" data-action="gate-mode" data-mode="login">Zum Login</button>
      </div>`;
  } else if (a.gateMode === 'reset') {
    body = `
      <p>Setze jetzt dein neues Passwort.</p>
      ${err}${info}
      <form class="gate-actions card" data-form="reset" novalidate>
        <label class="field">Neues Passwort (mind. ${MIN_PASSWORD} Zeichen)
          <input class="input" name="password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required>
        </label>
        <label class="field">Passwort wiederholen
          <input class="input" name="password2" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required>
        </label>
        <button class="btn btn-p block" type="submit" ${busy}>${a.busy ? 'Einen Moment …' : 'Passwort speichern'}</button>
      </form>`;
  } else if (a.gateMode === 'offline') {
    const canOffline = state.prefs.lastUserId && localStorage.getItem(cacheKey(state.prefs.lastUserId));
    body = `
      ${err || '<p class="error" role="alert">Keine Verbindung zum Server.</p>'}
      <p>Lade die Seite neu, sobald du wieder Internet hast.</p>
      <div class="gate-actions">
        <button class="btn btn-p block" data-action="reload">Neu laden</button>
        ${canOffline ? '<button class="btn btn-s block" data-action="gate-offline">Offline weiter (zuletzt angemeldetes Konto)</button>' : ''}
      </div>
      ${canOffline ? '<p class="small muted">Offline eingetragene Sätze werden hochgeladen, sobald du die Seite mit Internet neu lädst.</p>' : ''}`;
  } else {
    // Login
    body = `
      ${err}${info}
      <form class="gate-actions card" data-form="login" novalidate>
        <label class="field">E-Mail
          <input class="input" name="email" type="email" autocomplete="username" autocapitalize="off" spellcheck="false" value="${email}" required>
        </label>
        <label class="field">Passwort
          <input class="input" name="password" type="password" autocomplete="current-password" required>
        </label>
        <button class="btn btn-p block" type="submit" ${busy}>${a.busy ? 'Einen Moment …' : 'Anmelden'}</button>
        <button class="link-btn" type="button" data-action="gate-mode" data-mode="forgot">Passwort vergessen?</button>
      </form>
      ${invite
        ? '<p class="small muted">Neu hier? <button class="link-btn" data-action="gate-mode" data-mode="register">Konto erstellen</button></p>'
        : '<p class="small muted">Neu hier? Für ein Konto brauchst du einen Einladungslink.</p>'}`;
  }

  gate.innerHTML = gateBrand() + body;
  $('#app').hidden = true;
  gate.hidden = false;
  const first = gate.querySelector('input:not([value]), input[value=""]') || gate.querySelector('input');
  if (first && !a.busy && window.matchMedia('(min-width: 900px)').matches) first.focus();
}

function setGate(mode, errorText = '', infoText = '') {
  state.auth.gateMode = mode;
  renderGate(errorText, infoText);
}

/** Läuft eine Auth-Aktion: Knopf sperren, Fehler anzeigen. */
async function gateTask(fn) {
  if (state.auth.busy) return;
  state.auth.busy = true;
  renderGate();
  let errorText = '';
  let infoText = '';
  try {
    const res = await fn();
    if (res && res.info) infoText = res.info;
  } catch (err) {
    console.warn(err);
    errorText = err && err.userText ? err.userText : authErrorText(err);
  } finally {
    state.auth.busy = false;
  }
  if (!$('#gate').hidden) renderGate(errorText, infoText);
}

function userError(text) {
  const e = new Error(text);
  e.userText = text;
  return e;
}

/** Reaktion auf Login/Logout/Passwort-Link (von Supabase gemeldet). */
function handleAuthEvent(event, session) {
  if (event === 'PASSWORD_RECOVERY') {
    state.auth.recovery = true;
    history.replaceState(null, '', location.pathname + location.search);
    setGate('reset');
    return;
  }
  if (event === 'SIGNED_OUT') {
    if (state.userId) stopApp();
    setGate('login');
    return;
  }
  if (state.auth.recovery) return; // erst neues Passwort setzen
  if (session && session.user) {
    if (location.hash.includes('access_token')) history.replaceState(null, '', location.pathname + location.search);
    if (state.userId !== session.user.id) startApp(session.user);
  } else if (event === 'INITIAL_SESSION') {
    renderGate(state.auth.pendingError || '');
    state.auth.pendingError = '';
  }
}

/** Sitzung abgelaufen und nicht erneuerbar → zum Login, lokale Daten bleiben. */
async function handleExpiredSession() {
  if (!state.auth.client || state.auth.checkingSession) return;
  state.auth.checkingSession = true;
  try {
    const { data } = await state.auth.client.auth.getSession();
    if (!data || !data.session) {
      toast('Bitte melde dich neu an');
      if (state.userId) stopApp({ keepCache: true });
      setGate('login', 'Deine Sitzung ist abgelaufen. Bitte melde dich neu an.');
    }
  } catch { /* offline: einfach weiter */ } finally {
    state.auth.checkingSession = false;
  }
}

/** Profil (Name, Admin?) laden und lokal merken. */
async function loadProfile() {
  if (!state.auth.client) return;
  try {
    const { data, error } = await state.auth.client.rpc('get_my_profile');
    if (error) throw error;
    if (data) {
      state.meta.profile = { email: data.email || '', display_name: data.display_name || '', is_admin: !!data.is_admin };
      saveCache();
      if (!state.admin.viewAs && (state.view === 'settings' || state.view === 'training')) render();
    }
  } catch (err) {
    console.warn('Profil nicht geladen', err);
  }
}

function isAdmin() { return !!(state.meta.profile && state.meta.profile.is_admin); }
function myName() {
  const p = state.meta.profile;
  return (p && (p.display_name || p.email)) || '';
}

/* --- Admin: Konten ansehen (nur lesen) --- */
async function loadAdminUsers() {
  const { data, error } = await state.auth.client.rpc('admin_list_users');
  if (error) throw error;
  state.admin.users = data || [];
}

async function loadInviteCode() {
  const { data, error } = await state.auth.client.rpc('admin_get_invite_code');
  if (error) throw error;
  state.admin.inviteCode = data || null;
}

async function enterViewAs(user) {
  try {
    const { data: row, error } = await state.auth.client.rpc('admin_get_user_data', { p_user: user.id });
    if (error) throw error;
    const other = row && row.data ? normalizeData(row.data) : emptyData();
    if (state.meta.dirty) await pushToServer(); // eigene Änderungen vorher sichern
    state.admin.ownData = state.data;
    state.admin.viewAs = { id: user.id, name: user.display_name || user.email };
    state.data = other;
    state.statsExerciseId = null;
    document.body.classList.add('read-only');
    setView('history');
  } catch (err) {
    console.warn(err);
    toast('Konto konnte nicht geladen werden');
  }
}

function exitViewAs() {
  if (!state.admin.viewAs) return;
  state.data = state.admin.ownData || emptyData();
  state.admin.ownData = null;
  state.admin.viewAs = null;
  state.statsExerciseId = null;
  document.body.classList.remove('read-only');
  setView('admin');
  syncNow();
}

/* --- Übernahme aus Version 1 (geheimer Link ?k=...) --- */
/** Schlüssel aus eingefügtem Text holen (ganzer Link oder nur Schlüssel). */
function extractSecret(text) {
  const t = String(text || '').trim();
  if (SECRET_PATTERN.test(t)) return t;
  try {
    const k = new URL(t).searchParams.get('k');
    if (k && SECRET_PATTERN.test(k)) return k;
  } catch { /* kein Link */ }
  const m = t.match(/[?&]k=([A-Za-z0-9_-]{20,128})/);
  return m ? m[1] : null;
}

function v1SecretOnDevice() {
  const s = state.prefs.lastSecret;
  return s && SECRET_PATTERN.test(s) ? s : null;
}

async function claimV1(secret) {
  if (!secret) { toast('Kein gültiger V1-Link'); return; }
  if (!isEmptyData(state.data) && !confirm('Deine aktuellen Daten in diesem Konto werden durch die V1-Daten ersetzt. Weiter?')) return;
  try {
    const { data: row, error } = await state.auth.client.rpc('claim_v1_data', { p_secret: secret });
    if (error) throw error;
    state.data = normalizeData(row.data);
    state.meta.dirty = false;
    state.meta.lastSyncedAt = new Date().toISOString();
    state.meta.activeWorkoutId = null;
    state.sync.serverHadData = !isEmptyData(state.data);
    // V1-Spuren auf diesem Gerät entfernen
    try { localStorage.removeItem(STORAGE_PREFIX + 'data:' + secret); } catch { /* egal */ }
    if (state.prefs.lastSecret === secret) { state.prefs.lastSecret = null; savePrefs(); }
    saveCache();
    render();
    toast(`${state.data.workouts.length} Trainings übernommen`);
  } catch (err) {
    console.warn(err);
    if (/v1 not found/i.test(String(err && err.message))) {
      alert('Zu diesem Link wurden keine V1-Daten gefunden. Vielleicht wurden sie schon übernommen?');
      if (state.prefs.lastSecret === secret) { state.prefs.lastSecret = null; savePrefs(); render(); }
    } else {
      alert('Übernahme fehlgeschlagen. Bist du online? Falls es weiter nicht klappt: In V1 ein JSON-Backup exportieren und hier unter «Backup → Importieren» einlesen.');
    }
  }
}

function v1NoticeHtml() {
  if (state.admin.viewAs || !v1SecretOnDevice() || !state.sync.configured) return '';
  return `
    <div class="notice">
      <strong>Daten aus Version 1 gefunden</strong>
      <span>Auf diesem Gerät war der alte Tracker mit Geheim-Link offen. Willst du diese Trainings in dein Konto übernehmen?</span>
      <div class="row">
        <button class="btn btn-p btn-sm" data-action="v1-claim-device">Übernehmen</button>
        <button class="btn btn-s btn-sm" data-action="v1-dismiss">Nein, danke</button>
      </div>
    </div>`;
}

/* ---------------------------------------------------------------------
   6. Ansichten
   Aussehen nach dem Redesign: Satz-Zeilen mit Haken, Spalte «Zuletzt»,
   Plus/Minus beim aktuellen Satz, Kopfzeile mit Dauer/Volumen/Sätzen.
   --------------------------------------------------------------------- */
function render() {
  destroyCharts();
  document.body.dataset.view = state.view;
  document.querySelectorAll('.nav button').forEach((t) => {
    if (t.dataset.view === state.view || (state.view === 'admin' && t.dataset.view === 'settings')) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
  const view = $('#view');
  if (state.admin.viewAs && !['history', 'stats'].includes(state.view)) state.view = 'history';
  let html;
  if (state.view === 'history') html = renderHistory();
  else if (state.view === 'stats') html = renderStats();
  else if (state.view === 'settings') html = renderSettings();
  else if (state.view === 'admin') html = renderAdmin();
  else html = renderTraining();
  view.innerHTML = viewAsBannerHtml() + html;

  if (state.view === 'stats') drawStats();
  if (!activeWorkout()) hideRest();
  tick();
}

function setView(name) {
  state.view = name;
  render();
  window.scrollTo(0, 0);
}

/* --- Kennzahlen für die Anzeige (ändern keine Daten) --- */
function e1rmOf(s) { const w = s.weight || 0; return s.reps === 1 ? w : w * (1 + (s.reps || 0) / 30); }
function scoreOf(ex, s) { return ex.type === 'bodyweight' ? (s.reps || 0) : e1rmOf(s); }

/** Bester Wert pro Übung über alle Trainings ausser excludeId (für Rekorde). */
function bestScores(excludeId) {
  const best = {};
  for (const w of state.data.workouts) {
    if (w.id === excludeId) continue;
    for (const en of w.entries) {
      const ex = getExercise(en.exerciseId);
      if (!ex) continue;
      for (const s of validSets(en)) best[ex.id] = Math.max(best[ex.id] ?? 0, scoreOf(ex, s));
    }
  }
  return best;
}
/** Rekord = bestätigter Satz schlägt den bisherigen Bestwert (nur wenn es schon frühere Sätze gab). */
function isPR(ex, s, done, best) {
  return !!done && s.reps > 0 && best[ex.id] !== undefined && scoreOf(ex, s) > best[ex.id];
}

function setText(ex, s) {
  if (ex.type === 'bodyweight') return s.weight ? `+${fmtNum(s.weight)} × ${s.reps}` : `${s.reps} Wdh.`;
  return `${fmtNum(s.weight || 0)} × ${s.reps}`;
}
function thousand(n) { return Math.round(n).toLocaleString('de-CH'); }

/* --- Haken pro Satz: nur lokal auf diesem Gerät (state.meta.doneSets),
       das gespeicherte/synchronisierte Datenformat bleibt unverändert. --- */
function doneMap(w) {
  const all = state.meta.doneSets || (state.meta.doneSets = {});
  if (!all[w.id]) {
    // Training ohne Haken-Stand (z.B. aus dem Verlauf geöffnet): eingetragene Sätze gelten als erledigt
    all[w.id] = {};
    w.entries.forEach((en) => { all[w.id][en.id] = en.sets.map((s) => s.reps !== null && s.reps > 0); });
  }
  return all[w.id];
}
function isDone(w, en, i) { const m = doneMap(w); return !!(m[en.id] && m[en.id][i]); }
function setDone(w, en, i, v) { const m = doneMap(w); (m[en.id] || (m[en.id] = []))[i] = !!v; }

function sessionCounts(w) {
  let done = 0, all = 0, vol = 0;
  w.entries.forEach((en) => en.sets.forEach((s, i) => {
    all++;
    if (isDone(w, en, i)) { done++; vol += (s.weight || 0) * (s.reps || 0); }
  }));
  return { done, all, vol };
}

function nextOpen(w) {
  for (const en of w.entries) {
    const i = en.sets.findIndex((s, j) => !isDone(w, en, j));
    if (i >= 0) return { entry: en.id, set: i };
  }
  return null;
}

/* --- Training --- */
function renderTraining() {
  const active = state.meta.activeWorkoutId && getWorkout(state.meta.activeWorkoutId);
  if (active) return renderWorkoutEditor(active);
  if (state.summary) return renderSummary();

  const last = sortedWorkouts().find((w) => w.entries.length > 0);
  const recent = sortedWorkouts().filter((w) => w.entries.length).slice(0, 3);
  const lastInfo = last
    ? last.entries.map((e) => (getExercise(e.exerciseId) || {}).name).filter(Boolean).join(', ')
    : 'Noch kein Training';

  return `
    <div class="head"><div><h1 class="title">Training</h1><p class="sub">${myName() ? `Hallo ${esc(firstWord(myName()))} · ` : ''}${esc(formatDate(todayISO()))}</p></div></div>
    ${v1NoticeHtml()}
    <div class="start">
      <button class="btn ${last ? 'btn-p' : 'btn-s'}" data-action="start-repeat" ${last ? '' : 'disabled'}>
        <span>Letztes Training wiederholen</span><small>${esc(lastInfo)}</small></button>
      <button class="btn ${last ? 'btn-s' : 'btn-p'}" data-action="start-empty">
        <span>Leeres Training</span><small>Übungen selbst wählen</small></button>
    </div>
    <div class="card"><div class="eyebrow">Diese Woche</div>${weekStrip()}</div>
    ${recent.length ? `
      <div class="eyebrow">Zuletzt</div>
      <div class="card log">${recent.map((w) => logRow(w, 0)).join('')}</div>` : ''}`;
}

function weekStrip() {
  const now = parseISODate(todayISO());
  const mon = addDays(now, -((now.getDay() + 6) % 7));
  const days = new Set(state.data.workouts
    .filter((w) => w.id !== state.meta.activeWorkoutId && w.entries.some((e) => validSets(e).length))
    .map((w) => w.date));
  const today = todayISO();
  return `<div class="week">${['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((l, i) => {
    const iso = toISODate(addDays(mon, i));
    const on = days.has(iso);
    return `<div class="${on ? 'on' : ''} ${iso === today ? 'now' : ''}"><i>${on ? ICON_CHECK : ''}</i>${l}</div>`;
  }).join('')}</div>`;
}

function renderSummary() {
  const s = state.summary;
  return `
    <div class="card done-hero">
      <div class="eyebrow">Gespeichert</div>
      <h1 class="title">Training abgeschlossen</h1>
      <p class="muted">${esc(s.names)}</p>
    </div>
    <div class="stats">
      <div class="stat"><div class="v">${s.min === null ? '–' : s.min}</div><div class="l">Minuten</div></div>
      <div class="stat"><div class="v">${thousand(s.vol)}</div><div class="l">kg Volumen</div></div>
      <div class="stat"><div class="v">${s.sets}</div><div class="l">Sätze</div></div>
      <div class="stat"><div class="v">${s.prs.length}</div><div class="l">Rekorde</div></div>
    </div>
    ${s.prs.length ? `<div class="card"><div class="eyebrow">Neue Rekorde</div>${s.prs.map((p) => `
      <div class="side-row"><span>${esc(p.name)}</span><b>${esc(p.text)}</b></div>`).join('')}</div>` : ''}
    <button class="btn btn-p block" data-action="summary-close">Zur Übersicht</button>`;
}

/** Erstes Wort eines Namens (für die Begrüssung), E-Mail → Teil vor dem @. */
function firstWord(name) {
  return String(name).split('@')[0].trim().split(/\s+/)[0].slice(0, 30);
}

/** Leiste oben, solange der Admin ein fremdes Konto ansieht. */
function viewAsBannerHtml() {
  const v = state.admin.viewAs;
  if (!v) return '';
  return `
    <div class="viewas" role="status">
      <div><span class="eyebrow">Nur ansehen</span><b>${esc(v.name)}</b></div>
      <button class="btn btn-s btn-sm" data-action="admin-exit">Zurück zu mir</button>
    </div>`;
}

/** Zeile im Verlauf: aufklappbar, mit Sätzen und «Bearbeiten». */
function logRow(w, prCount) {
  const d = parseISODate(w.date);
  const names = w.entries.map((e) => (getExercise(e.exerciseId) || {}).name).filter(Boolean);
  const sets = w.entries.reduce((a, e) => a + validSets(e).length, 0);
  const vol = w.entries.reduce((a, e) => a + validSets(e).reduce((x, s) => x + (s.weight || 0) * s.reps, 0), 0);
  return `<details>
    <summary>
      <div class="date"><b>${d.getDate()}</b><span>${esc(d.toLocaleDateString('de-CH', { weekday: 'short' }).replace('.', ''))}</span></div>
      <div style="min-width:0"><div class="t">${names.length ? esc(names.join(', ')) : 'Keine Übungen'}</div><div class="s">${sets} ${sets === 1 ? 'Satz' : 'Sätze'} · ${thousand(vol)} kg</div></div>
      ${prCount > 0 ? `<span class="badge">${ICON_STAR}${prCount}</span>` : '<span></span>'}
    </summary>
    <div class="log-body">
      ${w.entries.map((en) => {
        const ex = getExercise(en.exerciseId);
        if (!ex) return '';
        const list = validSets(en).map((s) => esc(setText(ex, s))).join(', ') || '–';
        return `<div><span>${esc(ex.name)}${en.variant ? ` <small class="muted">(${esc(en.variant)})</small>` : ''}</span><span>${list}</span></div>`;
      }).join('')}
      ${w.note ? `<p class="log-note">${esc(w.note)}</p>` : ''}
      ${state.admin.viewAs ? '' : `<button class="btn btn-s" data-action="open-workout" data-id="${esc(w.id)}">Bearbeiten</button>`}
    </div>
  </details>`;
}

function renderWorkoutEditor(w) {
  const usedIds = new Set(w.entries.map((e) => e.exerciseId));
  const available = exercisesByRecency().filter((e) => !usedIds.has(e.id));
  if (state.focus && !w.entries.some((e) => e.id === state.focus.entry && e.sets[state.focus.set])) state.focus = null;
  const focus = state.focus || nextOpen(w);
  state.focus = focus;
  const c = sessionCounts(w);
  const best = bestScores(w.id);

  return `
    <div class="head"><div><h1 class="title">${w.date === todayISO() ? 'Heutiges Training' : 'Training'}</h1><p class="sub">${esc(formatDate(w.date))}</p></div></div>
    <div class="session" data-workout="${esc(w.id)}">
      <div><div class="v" id="dur">–</div><div class="l">Dauer</div></div>
      <div><div class="v" id="vol">${thousand(c.vol)}<small>kg</small></div><div class="l">Volumen</div></div>
      <div><div class="v" id="setCount">${c.done}<small>/${c.all}</small></div><div class="l">Sätze</div></div>
      <button class="btn btn-p" data-action="finish-workout">Fertig</button>
      <div class="bar"><i id="setBar" style="width:${c.all ? (c.done / c.all) * 100 : 0}%"></i></div>
    </div>
    <div class="wk">
      <div class="wk-col">
        ${w.entries.length ? w.entries.map((entry) => renderEntry(w, entry, focus, best)).join('') : '<div class="card muted">Wähle unten die erste Übung.</div>'}
        <div class="card">
          <h3 style="font-size:16px;font-weight:650">Übung hinzufügen</h3>
          ${available.length ? `<div class="chips">${available.map((e) =>
            `<button class="chip" data-action="add-existing" data-id="${esc(e.id)}">${esc(e.name)}</button>`).join('')}</div>` : ''}
          <form class="new-ex" data-form="new-exercise">
            <input class="input" name="name" placeholder="Neue Übung, z.B. Beinpresse" maxlength="80" autocomplete="off" aria-label="Name der neuen Übung" required>
            <select class="input" name="type" aria-label="Art der Übung"><option value="weight">Gewicht</option><option value="bodyweight">Körpergewicht</option></select>
            <button class="btn btn-s" type="submit">Hinzufügen</button>
          </form>
        </div>
        <div class="meta">
          <input class="input" type="date" data-field="workout-date" value="${esc(w.date)}" max="${todayISO()}" aria-label="Datum">
          <input class="input" data-field="workout-note" value="${esc(w.note)}" placeholder="Notiz, z.B. «müde»" maxlength="2000" aria-label="Notiz">
        </div>
        <button class="btn btn-d block" data-action="delete-workout" data-id="${esc(w.id)}">Training löschen</button>
      </div>
    </div>`;
}

function renderEntry(w, entry, focus, best) {
  const ex = getExercise(entry.exerciseId);
  if (!ex) return '';
  const isBw = ex.type === 'bodyweight';
  const last = lastEntryFor(ex.id, w.id);
  const done = entry.sets.filter((s, i) => isDone(w, entry, i)).length;
  const hasPR = entry.sets.some((s, i) => isPR(ex, s, isDone(w, entry, i), best));

  return `
    <section class="card ex grid entry" data-entry="${esc(entry.id)}">
      <div class="ex-h"><h3>${esc(ex.name)}</h3>${hasPR ? `<span class="badge">${ICON_STAR}REKORD</span>` : ''}<span class="ex-c">${done}/${entry.sets.length}</span>
        <button class="x" data-action="remove-entry" data-entry="${esc(entry.id)}" aria-label="${esc(ex.name)} entfernen">${ICON_X}</button></div>
      ${isBw ? `<div class="ex-variant"><input class="input" data-field="entry-variant" data-entry="${esc(entry.id)}" value="${esc(entry.variant)}"
        placeholder="Variante, z.B. Stufe 2 oder assistiert" maxlength="60" aria-label="Variante"></div>` : ''}
      <div>
        <div class="labels"><span>Satz</span><span>Zuletzt</span><span>${isBw ? '+ kg' : 'kg'}</span><span>Wdh.</span><span></span></div>
        ${entry.sets.map((s, i) => renderSetRow(w, entry, s, i, ex, last, focus, best)).join('')}
      </div>
      <button class="btn btn-g add-set" data-action="add-set" data-entry="${esc(entry.id)}">+ Satz hinzufügen</button>
    </section>`;
}

function renderSetRow(w, entry, set, i, ex, last, focus, best) {
  const e = esc(entry.id);
  const isBw = ex.type === 'bodyweight';
  const done = isDone(w, entry, i);
  const cur = focus && focus.entry === entry.id && focus.set === i;
  const pr = isPR(ex, set, done, best);
  const ps = last && last.entry.sets[i];
  const prev = ps && ps.reps ? setText(ex, ps).replace(' Wdh.', '') : '–';
  const a = `data-entry="${e}" data-set="${i}"`;
  return `
    <div class="set set-row ${done ? 'is-done' : ''} ${cur ? 'is-current' : ''} ${pr ? 'is-pr' : ''}" ${a}>
      <div class="set-main">
        <span class="set-no" title="${pr ? 'Neuer Rekord' : ''}">${pr ? `<span class="badge" style="padding:1px 3px">${ICON_STAR}</span>` : i + 1}</span>
        <span class="set-prev">${esc(prev)}</span>
        <input class="num" data-field="set-weight" ${a} inputmode="decimal" autocomplete="off"
          value="${esc(fmtNum(set.weight))}" placeholder="${isBw ? '+0' : 'kg'}" aria-label="Gewicht Satz ${i + 1}">
        <input class="num" data-field="set-reps" ${a} inputmode="numeric" pattern="[0-9]*" autocomplete="off"
          value="${esc(fmtNum(set.reps, 0))}" placeholder="–" aria-label="Wiederholungen Satz ${i + 1}">
        <button class="check" data-action="set-done" ${a} aria-pressed="${done}" aria-label="Satz ${i + 1} ${done ? 'wieder öffnen' : 'bestätigen'}">${ICON_CHECK}</button>
      </div>
      <div class="set-tools">
        <div class="nudge"><span>kg</span><button type="button" data-action="w-dec" ${a} aria-label="Gewicht minus ${WEIGHT_STEP}">−${WEIGHT_STEP}</button><button type="button" data-action="w-inc" ${a} aria-label="Gewicht plus ${WEIGHT_STEP}">+${WEIGHT_STEP}</button></div>
        <div class="nudge"><span>Wdh.</span><button type="button" data-action="r-dec" ${a} aria-label="Eine Wiederholung weniger">−1</button><button type="button" data-action="r-inc" ${a} aria-label="Eine Wiederholung mehr">+1</button></div>
        <button type="button" class="x set-del" data-action="remove-set" ${a} aria-label="Satz ${i + 1} entfernen" title="Satz entfernen">${ICON_X}</button>
      </div>
    </div>`;
}

/** Kopfzeile des Trainings ohne Neuzeichnen aktualisieren (Fokus bleibt im Feld). */
function refreshSession() {
  const w = activeWorkout();
  if (!w || !$('#vol')) return;
  const c = sessionCounts(w);
  $('#vol').innerHTML = `${thousand(c.vol)}<small>kg</small>`;
  $('#setCount').innerHTML = `${c.done}<small>/${c.all}</small>`;
  $('#setBar').style.width = (c.all ? (c.done / c.all) * 100 : 0) + '%';
}

/** Kurzform der Sätze, z.B. "60×8, 60×8, 62.5×6" oder "BW 12, +5 kg×8". */
function setsSummary(ex, entry) {
  const sets = validSets(entry);
  if (!sets.length) return '–';
  return sets.map((s) => {
    if (ex.type === 'bodyweight') return s.weight ? `+${fmtNum(s.weight)} kg×${s.reps}` : `${s.reps} Wdh.`;
    return `${fmtNum(s.weight) || 0}×${s.reps}`;
  }).join(', ') + (entry.variant ? ` (${entry.variant})` : '');
}

/* --- Verlauf --- */
/** Anzahl Rekorde pro Training, chronologisch gezählt (nur Anzeige, nichts wird gespeichert). */
function historicPRCounts() {
  const best = {};
  const counts = {};
  [...state.data.workouts].sort((a, b) => a.date.localeCompare(b.date) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
    .forEach((w) => {
      counts[w.id] = 0;
      for (const en of w.entries) {
        const ex = getExercise(en.exerciseId);
        const vs = validSets(en);
        if (!ex || !vs.length) continue;
        const top = Math.max(...vs.map((s) => scoreOf(ex, s)));
        if (best[ex.id] !== undefined && top > best[ex.id]) counts[w.id]++;
        best[ex.id] = Math.max(best[ex.id] ?? 0, top);
      }
    });
  return counts;
}

function renderHistory() {
  const workouts = sortedWorkouts();
  const head = `<div class="head"><div><h1 class="title">Verlauf</h1><p class="sub">${workouts.length} ${workouts.length === 1 ? 'Training' : 'Trainings'}</p></div></div>`;
  if (!workouts.length) {
    return head + `<div class="card"><p class="empty">${state.admin.viewAs ? 'Dieses Konto hat noch keine Trainings.' : 'Noch keine Trainings. Starte eines unter «Training».'}</p></div>`;
  }
  const prs = historicPRCounts();
  const groups = [];
  for (const w of workouts) {
    const m = parseISODate(w.date).toLocaleDateString('de-CH', { month: 'long', year: 'numeric' });
    if (!groups.length || groups[groups.length - 1].m !== m) groups.push({ m, items: [] });
    groups[groups.length - 1].items.push(w);
  }
  return head + groups.map((g) => `
    <div class="month"><span class="eyebrow">${esc(g.m)}</span><span class="small muted tnum">${g.items.length} ${g.items.length === 1 ? 'Training' : 'Trainings'}</span></div>
    <div class="card log">${g.items.map((w) => logRow(w, prs[w.id] || 0)).join('')}</div>`).join('');
}

/* --- Fortschritt --- */
function rangeStartISO() {
  const r = RANGES[state.prefs.range] || RANGES['3m'];
  if (!r.days) return '0000-00-00';
  return toISODate(addDays(new Date(), -(r.days - 1)));
}

function workoutsInRange() {
  const start = rangeStartISO();
  return state.data.workouts.filter((w) => w.date >= start && w.entries.some((e) => validSets(e).length));
}

function periodStats(from, to) {
  const ws = state.data.workouts.filter((w) => w.date >= from && w.date <= to && w.entries.some((e) => validSets(e).length));
  let sets = 0, vol = 0;
  ws.forEach((w) => w.entries.forEach((e) => validSets(e).forEach((s) => { sets++; vol += (s.weight || 0) * s.reps; })));
  return { days: new Set(ws.map((w) => w.date)).size, sets, vol };
}

function renderStats() {
  const r = RANGES[state.prefs.range] || RANGES['3m'];
  const inRange = workoutsInRange();
  const days = new Set(inRange.map((w) => w.date));

  // Durchschnitt pro Woche
  let spanDays = r.days;
  if (!spanDays) {
    const first = [...days].sort()[0];
    spanDays = first ? Math.max(28, Math.round((parseISODate(todayISO()) - parseISODate(first)) / 86400000) + 1) : 7;
  }
  const perWeek = days.size / (spanDays / 7);
  const cur = periodStats(rangeStartISO(), todayISO());
  const prev = r.days
    ? periodStats(toISODate(addDays(parseISODate(rangeStartISO()), -r.days)), toISODate(addDays(parseISODate(rangeStartISO()), -1)))
    : null;
  const delta = (a, b, f = (x) => x) => (prev ? `<div class="d">${a - b >= 0 ? '+' : '−'}${f(Math.abs(a - b))} zur Vorperiode</div>` : '');

  const exercises = exercisesByRecency().filter((e) => exerciseUseCount(e.id) > 0);
  if (!state.statsExerciseId || !exercises.some((e) => e.id === state.statsExerciseId)) {
    state.statsExerciseId = exercises[0] ? exercises[0].id : null;
  }
  const ex = state.statsExerciseId ? getExercise(state.statsExerciseId) : null;
  const isBw = ex && ex.type === 'bodyweight';
  const unit = isBw ? 'Wdh.' : 'kg';
  const series = ex ? exerciseSeries(ex) : [];
  const lastP = series.length ? series[series.length - 1] : null;
  const change = series.length > 1 ? lastP.primary - series[0].primary : null;

  // Bestwerte pro Übung (über alle Trainings)
  const bests = exercises.map((e) => {
    let top = null;
    for (const w of state.data.workouts) for (const en of w.entries) if (en.exerciseId === e.id) {
      for (const s of validSets(en)) if (!top || scoreOf(e, s) > scoreOf(e, top.s)) top = { s, date: w.date };
    }
    return { e, top };
  }).filter((b) => b.top);

  const bwAll = [...state.data.bodyweight].sort((a, b) => b.date.localeCompare(a.date));
  const bwInRange = bwAll.filter((b) => b.date >= rangeStartISO());

  return `
    <div class="head"><div><h1 class="title">Fortschritt</h1></div>
      <div class="seg" role="group" aria-label="Zeitraum">${Object.entries(RANGES).map(([key, v]) =>
        `<button data-action="set-range" data-range="${key}" aria-pressed="${state.prefs.range === key}">${v.label}</button>`).join('')}</div></div>
    <div class="stats">
      <div class="stat"><div class="v">${days.size}</div><div class="l">Trainingstage</div>${delta(cur.days, prev && prev.days)}</div>
      <div class="stat"><div class="v">${fmtNum(perWeek, 1)}</div><div class="l">pro Woche</div>${prev ? `<div class="d">Vorperiode ${fmtNum(prev.days / (spanDays / 7), 1)}</div>` : ''}</div>
      <div class="stat"><div class="v">${thousand(cur.sets)}</div><div class="l">Sätze</div>${delta(cur.sets, prev && prev.sets)}</div>
      <div class="stat"><div class="v">${fmtNum(cur.vol / 1000, 1)} t</div><div class="l">Volumen</div>${delta(cur.vol, prev && prev.vol, (x) => fmtNum(x / 1000, 1) + ' t')}</div>
    </div>
    <div class="st-grid">
      <div class="card span2">
        ${exercises.length ? `
          <div class="chips-scroll" role="group" aria-label="Übung wählen">${exercises.map((e) =>
            `<button class="chip" data-action="stats-ex" data-id="${esc(e.id)}" aria-pressed="${e.id === state.statsExerciseId}">${esc(e.name)}</button>`).join('')}</div>
          ${series.length ? `
            <div class="hero" id="exBest">
              <div><div class="eyebrow">${isBw ? 'Meiste Wiederholungen im Satz' : 'Geschätztes 1RM'}</div><div class="big">${fmtNum(lastP.primary, 1)}<small>${unit}</small></div></div>
              ${change !== null ? `<div class="delta ${change < 0 ? 'down' : ''}">${change >= 0 ? '+' : '−'}${fmtNum(Math.abs(change), 1)} ${unit} seit ${esc(formatDate(toISODate(new Date(series[0].x)), 'short'))}</div>` : ''}
            </div>
            <div class="legend"><span><i></i>${isBw ? 'Max. Wdh.' : 'Geschätztes 1RM'}</span><span><i class="dash"></i>${isBw ? 'Wdh. total' : 'Schwerstes Gewicht'}</span></div>
            <div class="chart"><canvas id="exChart" role="img" aria-label="Verlauf ${esc(ex.name)}"></canvas></div>
            <details class="tbl"><summary>Als Tabelle anzeigen</summary><div class="tbl-wrap"><table><thead><tr><th>Datum</th><th>${isBw ? 'Max. Wdh.' : '1RM (kg)'}</th><th>${isBw ? 'Total' : 'Schwerstes (kg)'}</th></tr></thead><tbody>
              ${[...series].reverse().map((p) => `<tr><td>${esc(formatDate(toISODate(new Date(p.x)), 'short'))}</td><td>${fmtNum(p.primary, 1)}</td><td>${fmtNum(p.secondary, 1)}</td></tr>`).join('')}</tbody></table></div></details>
            <p class="small muted">${isBw
              ? 'Linie: meiste Wiederholungen in einem Satz pro Tag. Gestrichelt: Wiederholungen total.'
              : 'Linie: geschätztes 1RM (Epley: Gewicht × (1 + Wdh. / 30)), bester Satz pro Tag. Gestrichelt: schwerstes Gewicht.'}</p>`
          : `<div id="exBest"></div><p class="muted">Keine Sätze im Zeitraum «${esc(r.label)}».</p>`}`
        : '<p class="empty">Sobald du Sätze mit Wiederholungen einträgst, erscheint hier deine Kurve.</p>'}
      </div>
      <div class="card">
        <div class="eyebrow">Trainingstage</div>
        <div class="hm-wrap" id="heatmapWrap"></div>
        <div class="hm-leg">weniger <span class="cell" data-l="0"></span><span class="cell" data-l="1"></span><span class="cell" data-l="2"></span><span class="cell" data-l="3"></span><span class="cell" data-l="4"></span> mehr Sätze</div>
      </div>
      ${bests.length ? `<div class="card">
        <div class="eyebrow">Bestwerte</div>
        <div>${bests.map((b) => `<button class="pr-row" data-action="stats-ex" data-id="${esc(b.e.id)}"><b>${esc(b.e.name)}</b><span class="kg">${esc(setText(b.e, b.top.s))}</span><small>${esc(formatDate(b.top.date, 'short'))}${b.e.type === 'bodyweight' ? '' : ` · 1RM ${fmtNum(e1rmOf(b.top.s), 1)} kg`}</small></button>`).join('')}</div>
      </div>` : ''}
      <div class="card span2">
        <div class="hero"><div><div class="eyebrow">Körpergewicht</div><div class="big">${bwAll.length ? esc(fmtNum(bwAll[0].kg, 1)) : '–'}<small>kg</small></div></div></div>
        ${state.admin.viewAs ? '' : `<form class="bw-form" data-form="bodyweight">
          <input class="input tnum" type="date" name="date" value="${todayISO()}" max="${todayISO()}" aria-label="Datum">
          <input class="input tnum" name="kg" inputmode="decimal" placeholder="kg heute" aria-label="Körpergewicht in kg" required>
          <button class="btn btn-s" type="submit">Speichern</button>
        </form>`}
        ${bwInRange.length
          ? '<div class="chart chart-bw"><canvas id="bwChart" role="img" aria-label="Körpergewicht"></canvas></div>'
          : `<p class="muted">${bwAll.length ? `Keine Einträge im Zeitraum «${esc(r.label)}».` : 'Noch keine Einträge.'}</p>`}
        ${bwAll.length ? `<div class="bw-list">${bwAll.slice(0, 5).map((b) => `
          <div class="side-row"><span>${esc(formatDate(b.date, 'weekday'))}</span><b>${esc(fmtNum(b.kg, 1))} kg</b>
            ${state.admin.viewAs ? '' : `<button class="x" data-action="bw-delete" data-id="${esc(b.id)}" aria-label="Eintrag löschen">${ICON_X}</button>`}</div>`).join('')}</div>` : ''}
      </div>
    </div>`;
}

/* --- Mehr / Einstellungen --- */
function renderSettings() {
  const exercises = [...state.data.exercises].sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const lastSync = state.meta.lastSyncedAt ? new Date(state.meta.lastSyncedAt).toLocaleString('de-CH') : '–';
  const palette = state.prefs.palette || 'stahl';
  const profile = state.meta.profile || {};
  if (isAdmin() && !state.admin.inviteCode && state.sync.configured && !state.admin.loadingInvite) {
    state.admin.loadingInvite = true;
    loadInviteCode().then(() => { if (state.view === 'settings') render(); })
      .catch((err) => console.warn(err)).finally(() => { state.admin.loadingInvite = false; });
  }

  return `
    <div class="head"><div><h1 class="title">Mehr</h1></div></div>

    <div class="card">
      <h2>Konto</h2>
      <form class="acc-form" data-form="account-name">
        <label class="field">Name
          <input class="input" name="name" value="${esc(profile.display_name || '')}" maxlength="60" autocomplete="nickname" placeholder="Vorname oder Spitzname">
        </label>
        <button class="btn btn-s" type="submit">Speichern</button>
      </form>
      <p class="small muted">Angemeldet als <b>${esc(profile.email || '–')}</b>${isAdmin() ? ' · Admin' : ''}</p>
      <details class="acc-pw">
        <summary>Passwort ändern</summary>
        <form class="gate-actions" data-form="account-password" novalidate>
          <label class="field">Neues Passwort (mind. ${MIN_PASSWORD} Zeichen)
            <input class="input" name="password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required>
          </label>
          <label class="field">Passwort wiederholen
            <input class="input" name="password2" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required>
          </label>
          <button class="btn btn-s" type="submit">Passwort speichern</button>
        </form>
      </details>
      <button class="btn btn-d" data-action="logout">Abmelden</button>
    </div>

    ${isAdmin() ? `<div class="card">
      <div class="card-head"><h2>Admin</h2><span class="badge-soft">nur lesen</span></div>
      <p class="small muted">Schick diesen Link an Leute, die den Tracker nutzen sollen. Wer ihn hat, kann ein Konto erstellen. Mit «Neuer Code» wird der alte Link ungültig (bestehende Konten bleiben).</p>
      <div class="link-box" id="inviteBox">${state.admin.inviteCode ? esc(inviteLink(state.admin.inviteCode)) : 'Wird geladen …'}</div>
      <div class="row-2">
        <button class="btn btn-p" data-action="copy-invite" ${state.admin.inviteCode ? '' : 'disabled'}>Link kopieren</button>
        <button class="btn btn-s" data-action="new-invite">Neuer Code</button>
      </div>
      <button class="btn btn-s" data-action="nav" data-view="admin">Alle Konten ansehen</button>
    </div>` : ''}

    ${v1SecretOnDevice() || isAdmin() ? `<div class="card">
      <h2>Daten aus Version 1</h2>
      <p class="small muted">Übernimmt die Trainings vom alten Tracker mit Geheim-Link (…/?k=…) in dieses Konto. Der alte Eintrag wird dabei gelöscht.</p>
      ${v1SecretOnDevice() ? '<button class="btn btn-p" data-action="v1-claim-device">Alten Tracker von diesem Gerät übernehmen</button>' : ''}
      <form class="inline-form" data-form="v1-claim">
        <input class="input" name="link" placeholder="Alten Link einfügen: https://…/?k=…" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Alter V1-Link">
        <button class="btn btn-s" type="submit">Übernehmen</button>
      </form>
    </div>` : ''}

    <div class="card">
      <div class="card-head"><h2>Sync</h2><span class="small muted" id="syncStatusText">${SYNC_LABELS[state.sync.status]}</span></div>
      ${state.sync.configured
        ? `<p class="small muted">Zuletzt synchronisiert: ${esc(lastSync)}</p>
           <button class="btn btn-s" data-action="sync-now">Jetzt synchronisieren</button>`
        : '<p class="small muted">Offline-Modus: Änderungen werden in diesem Browser gespeichert und hochgeladen, sobald du die Seite mit Internet neu lädst.</p>'}
    </div>

    <div class="card">
      <h2>Backup</h2>
      <p class="small muted">Exportiert alle Trainings, Übungen und Körpergewichte als JSON-Datei. Beim Import werden die aktuellen Daten ersetzt.</p>
      <div class="row-2">
        <button class="btn btn-s" data-action="export">Exportieren</button>
        <button class="btn btn-s" data-action="import">Importieren</button>
      </div>
    </div>

    <div class="card">
      <h2>Übungen</h2>
      ${exercises.length ? `<div>${exercises.map((e) => `
        <div class="ex-row">
          <div class="ex-row-top">
            <span class="grow">${esc(e.name)}</span>
            <span class="small muted tnum">${exerciseUseCount(e.id)}×</span>
          </div>
          <div class="ex-row-actions">
            <select class="input" data-field="ex-type" data-id="${esc(e.id)}" aria-label="Typ von ${esc(e.name)}">
              <option value="weight" ${e.type === 'weight' ? 'selected' : ''}>Gewicht</option>
              <option value="bodyweight" ${e.type === 'bodyweight' ? 'selected' : ''}>Körpergewicht</option>
            </select>
            <button class="btn btn-s btn-sm" data-action="ex-rename" data-id="${esc(e.id)}">Umbenennen</button>
            <button class="btn btn-d btn-sm" data-action="ex-delete" data-id="${esc(e.id)}">Löschen</button>
          </div>
        </div>`).join('')}</div>`
      : '<p class="empty">Noch keine Übungen. Du legst sie beim Training an.</p>'}
    </div>

    <div class="card">
      <h2>Darstellung</h2>
      <div class="seg" role="group" aria-label="Hell oder dunkel">
        ${[['system', 'Auto'], ['light', 'Hell'], ['dark', 'Dunkel']].map(([k, l]) =>
          `<button data-action="set-theme" data-theme="${k}" aria-pressed="${state.prefs.theme === k}">${l}</button>`).join('')}
      </div>
    </div>
    <div class="eyebrow">Farbwelten</div>
    <div class="tiles">${PALETTES.map(([k, n, d]) => `
      <button class="tile" data-action="set-palette" data-palette="${k}" aria-pressed="${palette === k}">
        <div class="tile-prev">
          <div class="tile-set d"><em>1</em><span>62.5 kg</span><span>8 Wdh.</span><u></u></div>
          <div class="tile-set o"><em>2</em><span>65 kg</span><span>8 Wdh.</span><u></u></div>
          <svg class="tile-spark" viewBox="0 0 200 34" preserveAspectRatio="none" aria-hidden="true"><path d="M0 28L30 25L60 26L90 19L120 17L150 12L200 5V34H0Z" fill="var(--accent-soft)"/><path d="M0 28L30 25L60 26L90 19L120 17L150 12L200 5" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>
          <span class="tile-btn">Satz bestätigen</span>
        </div>
        <div class="tile-info"><b>${esc(n)}</b><span>${esc(d)}</span></div>
      </button>`).join('')}</div>`;
}

/* --- Admin: alle Konten (nur lesen) --- */
function renderAdmin() {
  if (!isAdmin()) { state.view = 'settings'; return renderSettings(); }
  const users = state.admin.users;
  if (!users && state.sync.configured && !state.admin.loadingUsers) {
    state.admin.loadingUsers = true;
    loadAdminUsers().catch((err) => { console.warn(err); state.admin.usersError = true; })
      .finally(() => { state.admin.loadingUsers = false; if (state.view === 'admin') render(); });
  }
  const head = `<div class="head"><div><h1 class="title">Konten</h1><p class="sub">${users ? `${users.length} ${users.length === 1 ? 'Konto' : 'Konten'} · nur lesen` : 'Alle Konten · nur lesen'}</p></div>
    <button class="btn btn-s btn-sm" data-action="nav" data-view="settings">Zurück</button></div>`;
  if (!state.sync.configured) return head + '<div class="card"><p class="empty">Offline – Konten können nicht geladen werden.</p></div>';
  if (!users) {
    return head + `<div class="card"><p class="empty">${state.admin.usersError ? 'Konten konnten nicht geladen werden.' : 'Wird geladen …'}</p>
      ${state.admin.usersError ? '<button class="btn btn-s" data-action="admin-reload">Nochmals versuchen</button>' : ''}</div>`;
  }
  return head + `
    <div class="card log users">${users.map((u) => {
      const me = u.id === state.userId;
      const last = u.last_workout && isValidISODate(u.last_workout) ? relativeDay(u.last_workout) : 'noch nie';
      return `<button class="user-row" data-action="admin-view" data-id="${esc(u.id)}" ${me ? 'disabled' : ''}>
        <span class="user-av" aria-hidden="true">${esc((u.display_name || u.email || '?').trim().charAt(0).toUpperCase())}</span>
        <span class="user-main"><b>${esc(u.display_name || u.email)}${me ? ' <small class="muted">(du)</small>' : ''}</b>
          <small>${esc(u.email)} · seit ${esc(formatDate(toISODate(new Date(u.created_at)), 'short'))}</small></span>
        <span class="user-stat"><b class="tnum">${u.workouts}</b><small>Letztes: ${esc(last)}</small></span>
      </button>`;
    }).join('')}</div>
    <button class="btn btn-s" data-action="admin-reload">Aktualisieren</button>
    <p class="small muted">Tippe auf ein Konto, um Verlauf und Fortschritt anzusehen. Ändern ist dort nicht möglich.</p>`;
}

/* ---------------------------------------------------------------------
   7. Diagramme & Heatmap
   Chart.js, gestaltet wie im Redesign: eine y-Achse, feines Raster,
   Fläche unter der Hauptlinie, Bestwert markiert, letzter Punkt sichtbar.
   --------------------------------------------------------------------- */
function destroyCharts() {
  Object.values(state.charts).forEach((c) => c && c.destroy());
  state.charts = {};
}

function drawStats() {
  drawHeatmap();
  if (!window.Chart) {
    document.querySelectorAll('.chart').forEach((b) => {
      b.outerHTML = '<p class="empty">Diagramme konnten nicht geladen werden (offline?).</p>';
    });
    return;
  }
  drawExerciseChart();
  drawBodyweightChart();
}

/** "rgb(r, g, b)" → "rgba(r, g, b, a)". */
function withAlpha(color, a) {
  const m = String(color).match(/[\d.]+/g);
  return m && m.length >= 3 ? `rgba(${m[0]}, ${m[1]}, ${m[2]}, ${a})` : color;
}

/** Gemeinsame Chart.js-Optionen (Farben aus den CSS-Tokens). */
function baseChartOptions(unit, width) {
  const grid = cssVar('--line');
  const text = cssVar('--text-3');
  const font = { family: cssFont(), size: 11.5, weight: 500 };
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    layout: { padding: { top: 22, right: 10 } },
    interaction: { mode: 'nearest', axis: 'x', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: cssVar('--surface-2'),
        borderColor: grid,
        borderWidth: 1,
        titleColor: cssVar('--text'),
        bodyColor: cssVar('--text-2'),
        titleFont: { family: font.family, size: 12.5, weight: 650 },
        bodyFont: { family: font.family, size: 12.5 },
        padding: { x: 10, y: 7 },
        cornerRadius: 9,
        displayColors: false,
        callbacks: {
          title: (items) => (items.length ? formatDate(toISODate(new Date(items[0].parsed.x)), 'weekday') : ''),
          label: (item) => `${item.dataset.label}: ${fmtNum(item.parsed.y, 1)} ${unit}`,
        },
      },
    },
    scales: {
      x: {
        type: 'linear',
        grid: { display: false },
        border: { display: false },
        ticks: {
          color: text, font, maxRotation: 0, autoSkip: true, maxTicksLimit: width < 420 ? 3 : 5,
          callback: (v) => new Date(v).toLocaleDateString('de-CH', { day: 'numeric', month: 'short' }),
        },
      },
      y: {
        grid: { color: grid },
        border: { display: false },
        ticks: { color: text, font, maxTicksLimit: 5, callback: (v) => fmtNum(v, 1) },
      },
    },
  };
}

/** Bei nur einem Punkt einen sinnvollen Zeitbereich für die x-Achse setzen. */
function fitXAxis(options, points) {
  if (points.length === 1) {
    options.scales.x.min = points[0].x - 3 * 86400000;
    options.scales.x.max = points[0].x + 3 * 86400000;
  }
}

/** Hauptlinie im Redesign-Stil: Fläche mit Verlauf, Punkt nur beim Bestwert (Raute) und beim letzten Wert. */
function mainDataset(label, points, accent) {
  const pr = cssVar('--pr');
  const surface = cssVar('--surface');
  let topIdx = 0;
  points.forEach((p, i) => { if (p.y >= points[topIdx].y) topIdx = i; });
  const lastIdx = points.length - 1;
  const showTop = points.length > 1;
  return {
    topIdx: showTop ? topIdx : -1,
    dataset: {
      label, data: points,
      borderColor: accent, borderWidth: 2, tension: 0, borderJoinStyle: 'round', borderCapStyle: 'round',
      fill: 'start',
      backgroundColor: (ctx) => {
        const area = ctx.chart.chartArea;
        if (!area) return withAlpha(accent, 0.12);
        const g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
        g.addColorStop(0, withAlpha(accent, 0.24));
        g.addColorStop(1, withAlpha(accent, 0));
        return g;
      },
      pointRadius: points.map((p, i) => (showTop && i === topIdx ? 6 : i === lastIdx ? 4.5 : 0)),
      pointStyle: points.map((p, i) => (showTop && i === topIdx ? 'rectRot' : 'circle')),
      pointBackgroundColor: points.map((p, i) => (showTop && i === topIdx ? pr : accent)),
      pointBorderColor: surface, pointBorderWidth: 2,
      pointHoverRadius: 5, pointHoverBackgroundColor: accent, pointHoverBorderColor: surface, pointHoverBorderWidth: 2,
    },
  };
}

/** Beschriftung «Bestwert …» neben der Raute. */
function bestLabelPlugin(topIdx) {
  return {
    id: 'bestLabel',
    afterDatasetsDraw(chart) {
      if (topIdx < 0) return;
      const el = chart.getDatasetMeta(0).data[topIdx];
      const value = chart.data.datasets[0].data[topIdx];
      if (!el || !value) return;
      const c = chart.ctx;
      const near = el.x > chart.width - 90;
      c.save();
      c.font = `650 11.5px ${cssFont()}`;
      c.fillStyle = cssVar('--text-2');
      c.textAlign = near ? 'right' : 'left';
      c.fillText(`Bestwert ${fmtNum(value.y, 1)}`, near ? el.x - 10 : el.x + 10, Math.max(12, el.y - 8));
      c.restore();
    },
  };
}

/**
 * Werte pro Tag für eine Übung berechnen.
 * Gewicht: e1RM (Epley) und schwerstes Gewicht. Körpergewicht: max. und total Wiederholungen.
 */
function exerciseSeries(ex) {
  const start = rangeStartISO();
  const byDay = {};
  for (const w of state.data.workouts) {
    if (w.date < start) continue;
    for (const entry of w.entries) {
      if (entry.exerciseId !== ex.id) continue;
      for (const s of validSets(entry)) {
        const day = byDay[w.date] || (byDay[w.date] = { primary: 0, secondary: 0, extra: 0 });
        if (ex.type === 'bodyweight') {
          day.primary = Math.max(day.primary, s.reps);
          day.secondary += s.reps;
          day.extra = Math.max(day.extra, s.weight || 0);
        } else {
          const wgt = s.weight || 0;
          const e1rm = s.reps === 1 ? wgt : wgt * (1 + s.reps / 30);
          day.primary = Math.max(day.primary, e1rm);
          day.secondary = Math.max(day.secondary, wgt);
        }
      }
    }
  }
  return Object.keys(byDay).sort().map((d) => ({
    x: parseISODate(d).getTime(),
    primary: ex.type === 'bodyweight' ? byDay[d].primary : roundHalf(byDay[d].primary),
    secondary: byDay[d].secondary,
  }));
}

function drawExerciseChart() {
  const canvas = $('#exChart');
  const ex = state.statsExerciseId && getExercise(state.statsExerciseId);
  if (!canvas || !ex) return;

  const isBw = ex.type === 'bodyweight';
  const series = exerciseSeries(ex);
  if (!series.length) return;
  const unit = isBw ? 'Wdh.' : 'kg';
  const primaryLabel = isBw ? 'Max. Wdh.' : 'Geschätztes 1RM';
  const secondaryLabel = isBw ? 'Wdh. total' : 'Schwerstes Gewicht';

  const accent = cssVar('--accent');
  const options = baseChartOptions(unit, canvas.parentElement.clientWidth);
  fitXAxis(options, series);
  const main = mainDataset(primaryLabel, series.map((p) => ({ x: p.x, y: p.primary })), accent);
  state.charts.exercise = new Chart(canvas, {
    type: 'line',
    data: {
      datasets: [
        main.dataset,
        {
          label: secondaryLabel,
          data: series.map((p) => ({ x: p.x, y: p.secondary })),
          borderColor: cssVar('--text-3'), backgroundColor: cssVar('--text-3'),
          borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, pointHoverRadius: 0, tension: 0, fill: false,
        },
      ],
    },
    options,
    plugins: [bestLabelPlugin(main.topIdx)],
  });
}

function drawBodyweightChart() {
  const canvas = $('#bwChart');
  if (!canvas) return;
  const start = rangeStartISO();
  const points = state.data.bodyweight
    .filter((b) => b.date >= start)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((b) => ({ x: parseISODate(b.date).getTime(), y: b.kg }));
  if (!points.length) return;
  const accent = cssVar('--accent');
  const options = baseChartOptions('kg', canvas.parentElement.clientWidth);
  fitXAxis(options, points);
  const main = mainDataset('Körpergewicht', points, accent);
  state.charts.bodyweight = new Chart(canvas, {
    type: 'line',
    data: { datasets: [main.dataset] },
    options,
    plugins: [bestLabelPlugin(main.topIdx)],
  });
}

/** Kalender-Raster im GitHub-Stil: Spalten = Wochen (Mo–So), Farbe = Anzahl Sätze. */
function drawHeatmap() {
  const wrap = $('#heatmapWrap');
  if (!wrap) return;

  // Sätze pro Tag zählen
  const setsByDay = {};
  for (const w of state.data.workouts) {
    const n = w.entries.reduce((a, e) => a + validSets(e).length, 0);
    if (n) setsByDay[w.date] = (setsByDay[w.date] || 0) + n;
  }

  // Startdatum: Zeitraum-Beginn (bei "Alles" erstes Training, mind. 12 Wochen), auf Montag zurück
  const today = parseISODate(todayISO());
  let start;
  const r = RANGES[state.prefs.range] || RANGES['3m'];
  if (r.days) start = addDays(today, -(r.days - 1));
  else {
    const first = Object.keys(setsByDay).sort()[0];
    const minStart = addDays(today, -83);
    start = first && parseISODate(first) < minStart ? parseISODate(first) : minStart;
  }
  start = addDays(start, -((start.getDay() + 6) % 7));
  const weeks = Math.ceil((Math.round((today - start) / 86400000) + 1) / 7);

  // Zellgrösse an die verfügbare Breite anpassen (zu viele Wochen → horizontal scrollen im Kasten)
  const avail = wrap.clientWidth - 25;
  const cell = Math.max(11, Math.min(24, Math.floor(avail / weeks) - 3));

  const level = (n) => (!n ? 0 : n < 8 ? 1 : n < 15 ? 2 : n < 22 ? 3 : 4);
  const todayIso = todayISO();
  let html = `<div class="hm" style="--c:${cell}px;grid-template-columns:22px"><span></span>`
    + ['Mo', '', 'Mi', '', 'Fr', '', ''].map((l) => `<span>${l}</span>`).join('');

  let lastMonth = -1;
  for (let wk = 0; wk < weeks; wk++) {
    const monday = addDays(start, wk * 7);
    const showMonth = monday.getMonth() !== lastMonth && (cell >= 14 || wk % 2 === 0 || wk === 0);
    html += `<span class="m">${showMonth ? monday.toLocaleDateString('de-CH', { month: 'short' }).replace('.', '') : ''}</span>`;
    if (showMonth) lastMonth = monday.getMonth();
    for (let d = 0; d < 7; d++) {
      const iso = toISODate(addDays(monday, d));
      const n = setsByDay[iso] || 0;
      const cls = iso > todayIso ? ' future' : iso === todayIso ? ' today' : '';
      const title = iso > todayIso ? '' : `${formatDate(iso, 'weekday')}: ${n ? n + ' Sätze' : 'kein Training'}`;
      html += `<div class="cell${cls}" data-l="${level(n)}" title="${esc(title)}"></div>`;
    }
  }
  html += '</div>';
  wrap.innerHTML = html;
  wrap.scrollLeft = wrap.scrollWidth; // neueste Wochen sichtbar
}

/* --- Pausen-Timer (rechnet mit Endzeit, läuft also auch bei kurz gesperrtem Handy weiter) --- */
const rest = { end: 0, total: 90, label: '' };
function startRest(sec, label) {
  rest.end = Date.now() + sec * 1000;
  rest.total = sec;
  rest.label = label;
  $('#rest').hidden = false;
  tick();
}
function hideRest() { const r = $('#rest'); if (r) r.hidden = true; }
function restSecondsFor(ex) { return /kniebeuge|kreuzheben|squat|deadlift/i.test(ex.name) ? 150 : 90; }

function tick() {
  if (!state.data) return;
  const w = activeWorkout();
  const dur = $('#dur');
  if (w && dur) {
    const started = Date.parse(w.createdAt || '');
    const mins = Math.floor((Date.now() - started) / 60000);
    // Dauer nur für heute gestartete Trainings (alte Trainings aus dem Verlauf zeigen «–»)
    dur.textContent = Number.isFinite(mins) && mins >= 0 && mins < 12 * 60 && w.date === todayISO()
      ? `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}` : '–';
  }
  const box = $('#rest');
  if (!box || box.hidden) return;
  const left = Math.max(0, Math.ceil((rest.end - Date.now()) / 1000));
  $('#restTime').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  $('#restLabel').textContent = left ? `Pause nach ${rest.label}` : 'Bereit für den nächsten Satz';
  $('#restBar').style.width = (rest.total ? (left / rest.total) * 100 : 0) + '%';
}

/* ---------------------------------------------------------------------
   8. Aktionen
   --------------------------------------------------------------------- */
function activeWorkout() { return getWorkout(state.meta.activeWorkoutId); }
function findEntry(entryId) {
  const w = activeWorkout();
  return w ? w.entries.find((e) => e.id === entryId) : null;
}

/** Fokus nach dem Neuzeichnen wieder setzen. */
function focusField(selector) {
  const el = $(selector);
  if (el) { el.focus({ preventScroll: false }); el.select && el.select(); }
}

const actions = {
  nav: (el) => setView(el.dataset.view),

  'start-repeat': () => startWorkout('repeat'),
  'start-empty': () => startWorkout('empty'),

  'open-workout': (el) => {
    state.meta.activeWorkoutId = el.dataset.id;
    state.meta.doneSets = {}; // Haken-Stand wird aus den eingetragenen Sätzen neu aufgebaut
    state.focus = null;
    state.summary = null;
    saveCache();
    setView('training');
  },

  'finish-workout': () => {
    const w = activeWorkout();
    state.summary = w && w.entries.length ? workoutSummary(w) : null;
    state.meta.activeWorkoutId = null;
    state.meta.doneSets = {};
    state.focus = null;
    hideRest();
    if (w && w.entries.length === 0) {
      // Leere Trainings nicht aufbewahren
      state.data.workouts = state.data.workouts.filter((x) => x.id !== w.id);
      commit();
    } else {
      saveCache();
      if (w) toast('Training gespeichert');
    }
    render();
    window.scrollTo(0, 0);
  },

  'delete-workout': (el) => {
    if (!confirm('Dieses Training wirklich löschen?')) return;
    state.data.workouts = state.data.workouts.filter((w) => w.id !== el.dataset.id);
    state.meta.activeWorkoutId = null;
    state.meta.doneSets = {};
    state.focus = null;
    hideRest();
    commit();
    toast('Training gelöscht');
    render();
  },

  'add-existing': (el) => {
    const w = activeWorkout();
    const ex = getExercise(el.dataset.id);
    if (!w || !ex) return;
    addEntry(w, ex);
    state.focus = { entry: w.entries[w.entries.length - 1].id, set: 0 };
    commit();
    render();
    const lastEntry = w.entries[w.entries.length - 1];
    $(`[data-entry="${CSS.escape(lastEntry.id)}"].entry`)?.scrollIntoView({ block: 'center' });
  },

  'remove-entry': (el) => {
    const w = activeWorkout();
    const entry = findEntry(el.dataset.entry);
    if (!w || !entry) return;
    const ex = getExercise(entry.exerciseId);
    if (validSets(entry).length && !confirm(`«${ex ? ex.name : 'Übung'}» aus diesem Training entfernen?`)) return;
    w.entries = w.entries.filter((e) => e.id !== entry.id);
    commit();
    render();
  },

  'add-set': (el) => {
    const entry = findEntry(el.dataset.entry);
    if (!entry) return;
    const last = entry.sets[entry.sets.length - 1];
    entry.sets.push(last ? { weight: last.weight, reps: last.reps } : { weight: null, reps: null });
    state.focus = { entry: entry.id, set: entry.sets.length - 1 };
    commit();
    render();
    focusField(`[data-field="set-reps"][data-entry="${CSS.escape(entry.id)}"][data-set="${entry.sets.length - 1}"]`);
  },

  'remove-set': (el) => {
    const entry = findEntry(el.dataset.entry);
    if (!entry) return;
    entry.sets.splice(Number(el.dataset.set), 1);
    const w = activeWorkout();
    const marks = w && doneMap(w)[entry.id];
    if (marks) marks.splice(Number(el.dataset.set), 1);
    state.focus = null;
    commit();
    render();
  },

  'w-inc': (el) => stepWeight(el, +WEIGHT_STEP),
  'w-dec': (el) => stepWeight(el, -WEIGHT_STEP),
  'r-inc': (el) => stepReps(el, +1),
  'r-dec': (el) => stepReps(el, -1),

  /* Haken: Satz bestätigen / wieder öffnen (nur lokal), startet den Pausen-Timer */
  'set-done': (el) => {
    const w = activeWorkout();
    const entry = findEntry(el.dataset.entry);
    const i = Number(el.dataset.set);
    if (!w || !entry || !entry.sets[i]) return;
    const ex = getExercise(entry.exerciseId);
    const done = !isDone(w, entry, i);
    setDone(w, entry, i, done);
    state.focus = null;
    saveCache();
    if (done && ex) {
      const set = entry.sets[i];
      if (isPR(ex, set, true, bestScores(w.id))) toast(`Neuer Rekord: ${ex.name} ${setText(ex, set)}`);
      startRest(restSecondsFor(ex), `Satz ${i + 1}`);
    }
    render();
  },
  'rest-add': (el) => {
    rest.end = Math.max(Date.now(), rest.end) + Number(el.dataset.sec) * 1000;
    rest.total = Math.max(rest.total, Math.ceil((rest.end - Date.now()) / 1000));
    tick();
  },
  'rest-skip': () => hideRest(),
  'summary-close': () => { state.summary = null; render(); },

  'stats-ex': (el) => {
    state.statsExerciseId = el.dataset.id;
    render();
  },
  'set-palette': (el) => {
    state.prefs.palette = el.dataset.palette;
    savePrefs();
    applyTheme();
    render();
  },

  'set-range': (el) => {
    state.prefs.range = el.dataset.range;
    savePrefs();
    render();
  },

  'bw-delete': (el) => {
    state.data.bodyweight = state.data.bodyweight.filter((b) => b.id !== el.dataset.id);
    commit();
    render();
  },

  'ex-rename': (el) => {
    const ex = getExercise(el.dataset.id);
    if (!ex) return;
    const name = prompt('Neuer Name für die Übung:', ex.name);
    if (name === null) return;
    const clean = name.trim().slice(0, 80);
    if (!clean) return;
    const other = findExerciseByName(clean);
    if (other && other.id !== ex.id) { alert('Eine Übung mit diesem Namen gibt es schon.'); return; }
    ex.name = clean;
    commit();
    render();
  },

  'ex-delete': (el) => {
    const ex = getExercise(el.dataset.id);
    if (!ex) return;
    const uses = exerciseUseCount(ex.id);
    const msg = uses
      ? `«${ex.name}» löschen? Die Übung wird auch aus ${uses} ${uses === 1 ? 'Training' : 'Trainings'} entfernt.`
      : `«${ex.name}» löschen?`;
    if (!confirm(msg)) return;
    state.data.exercises = state.data.exercises.filter((e) => e.id !== ex.id);
    state.data.workouts.forEach((w) => { w.entries = w.entries.filter((e) => e.exerciseId !== ex.id); });
    commit();
    render();
  },

  'sync-now': () => { pullFromServer(); },

  /* Konto & Admin */
  logout: () => logout(),
  'copy-invite': () => { if (state.admin.inviteCode) copyText(inviteLink(state.admin.inviteCode), 'Einladungslink kopiert'); },
  'new-invite': async () => {
    if (!confirm('Neuen Einladungscode erzeugen? Der bisherige Einladungslink funktioniert danach nicht mehr.')) return;
    try {
      const { data, error } = await state.auth.client.rpc('admin_set_invite_code', { p_code: null });
      if (error) throw error;
      state.admin.inviteCode = data;
      render();
      toast('Neuer Einladungslink erstellt');
    } catch (err) {
      console.warn(err);
      toast('Hat nicht geklappt (offline?)');
    }
  },
  'admin-view': (el) => {
    const user = (state.admin.users || []).find((u) => u.id === el.dataset.id);
    if (user) enterViewAs(user);
  },
  'admin-exit': () => exitViewAs(),
  'admin-reload': () => { state.admin.users = null; state.admin.usersError = false; render(); },
  'v1-claim-device': () => claimV1(v1SecretOnDevice()),
  'v1-dismiss': () => { state.prefs.lastSecret = null; savePrefs(); render(); },

  export: () => exportData(),
  import: () => $('#importFile').click(),

  'set-theme': (el) => {
    state.prefs.theme = el.dataset.theme;
    savePrefs();
    applyTheme();
    render();
  },

  /* Startbildschirm */
  'gate-mode': (el) => {
    const form = $('#gate form');
    if (form && form.email && form.email.value) state.auth.gateEmail = form.email.value.trim();
    setGate(el.dataset.mode);
  },
  'resend-confirm': () => gateTask(async () => {
    const { error } = await state.auth.client.auth.resend({
      type: 'signup', email: state.auth.gateEmail, options: { emailRedirectTo: appUrl() },
    });
    if (error) throw error;
    return { info: 'E-Mail wurde nochmals gesendet.' };
  }),
  reload: () => location.reload(),
  'gate-offline': () => startOffline(),
};

function stepWeight(el, delta) {
  const entry = findEntry(el.dataset.entry);
  const i = Number(el.dataset.set);
  if (!entry || !entry.sets[i]) return;
  const current = entry.sets[i].weight || 0;
  const next = Math.max(0, Math.round((current + delta) * 100) / 100);
  entry.sets[i].weight = next;
  const input = $(`[data-field="set-weight"][data-entry="${CSS.escape(entry.id)}"][data-set="${i}"]`);
  if (input) input.value = fmtNum(next);
  commit();
  refreshSession();
}

function stepReps(el, delta) {
  const entry = findEntry(el.dataset.entry);
  const i = Number(el.dataset.set);
  if (!entry || !entry.sets[i]) return;
  const next = Math.max(0, Math.round((entry.sets[i].reps || 0) + delta));
  entry.sets[i].reps = next;
  const input = $(`[data-field="set-reps"][data-entry="${CSS.escape(entry.id)}"][data-set="${i}"]`);
  if (input) input.value = fmtNum(next, 0);
  commit();
  refreshSession();
}

/** Zusammenfassung nach «Fertig» (zählt die gespeicherten Sätze, ändert nichts). */
function workoutSummary(w) {
  const best = bestScores(w.id);
  let sets = 0, vol = 0;
  const prs = [];
  for (const en of w.entries) {
    const ex = getExercise(en.exerciseId);
    if (!ex) continue;
    const vs = validSets(en);
    sets += vs.length;
    vs.forEach((s) => { vol += (s.weight || 0) * s.reps; });
    const top = vs.filter((s) => isPR(ex, s, true, best)).sort((a, b) => scoreOf(ex, b) - scoreOf(ex, a))[0];
    if (top) prs.push({ name: ex.name, text: setText(ex, top) });
  }
  const started = Date.parse(w.createdAt || '');
  const mins = Math.round((Date.now() - started) / 60000);
  return {
    names: w.entries.map((e) => (getExercise(e.exerciseId) || {}).name).filter(Boolean).join(', '),
    min: w.date === todayISO() && Number.isFinite(mins) && mins >= 0 && mins < 12 * 60 ? mins : null,
    vol, sets, prs,
  };
}

/** Aktuellen Satz markieren, ohne neu zu zeichnen (Plus/Minus erscheinen). */
function setFocusRow(row) {
  document.querySelectorAll('.set.is-current').forEach((r) => r.classList.remove('is-current'));
  row.classList.add('is-current');
  state.focus = { entry: row.dataset.entry, set: Number(row.dataset.set) };
}

async function copyText(text, message = 'Link kopiert') {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    prompt('Link kopieren:', text);
  }
}

function exportData() {
  const payload = { app: 'gym-tracker', exportedAt: new Date().toISOString(), data: state.data };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `gym-tracker-backup-${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Backup exportiert');
}

async function importData(file) {
  try {
    const parsed = JSON.parse(await file.text());
    const data = normalizeData(parsed && parsed.data ? parsed.data : parsed);
    const summary = `${data.workouts.length} Trainings, ${data.exercises.length} Übungen, ${data.bodyweight.length} Körpergewichte`;
    if (!confirm(`Backup importieren (${summary})?\nDie aktuellen Daten werden ersetzt.`)) return;
    state.data = data;
    state.meta.activeWorkoutId = null;
    state.sync.allowEmptyOnce = true; // bewusster Import darf auch leer sein
    commit();
    render();
    toast('Backup importiert');
  } catch (err) {
    console.warn(err);
    alert('Diese Datei konnte nicht importiert werden. Ist es ein Gym-Tracker-Backup (.json)?');
  }
}

/* --- Formulare --- */
const forms = {
  'new-exercise': (form) => {
    const w = activeWorkout();
    const name = form.name.value.trim().slice(0, 80);
    if (!w || !name) return;
    let ex = findExerciseByName(name);
    if (!ex) {
      ex = { id: uid(), name, type: form.type.value === 'bodyweight' ? 'bodyweight' : 'weight', variant: '' };
      state.data.exercises.push(ex);
    }
    if (w.entries.some((e) => e.exerciseId === ex.id)) { toast('Ist schon im Training'); return; }
    addEntry(w, ex);
    state.focus = { entry: w.entries[w.entries.length - 1].id, set: 0 };
    commit();
    render();
    const lastEntry = w.entries[w.entries.length - 1];
    focusField(`[data-field="set-weight"][data-entry="${CSS.escape(lastEntry.id)}"][data-set="0"]`);
  },

  bodyweight: (form) => {
    const kg = parseNum(form.kg.value);
    const date = form.date.value || todayISO();
    if (kg === null || kg <= 0 || kg > 500 || !isValidISODate(date)) { toast('Bitte gültiges Gewicht eingeben'); return; }
    const existing = state.data.bodyweight.find((b) => b.date === date);
    if (existing) existing.kg = kg;
    else state.data.bodyweight.push({ id: uid(), date, kg });
    commit();
    render();
    toast('Körpergewicht gespeichert');
  },

  /* Startbildschirm */
  login: (form) => {
    const email = form.email.value.trim();
    const password = form.password.value;
    state.auth.gateEmail = email;
    if (!email || !password) { renderGate('Bitte E-Mail und Passwort eingeben.'); return; }
    gateTask(async () => {
      const { error } = await state.auth.client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      // Weiter geht es über onAuthStateChange (SIGNED_IN)
    });
  },

  register: (form) => {
    const name = form.name.value.trim().slice(0, 60);
    const email = form.email.value.trim();
    const password = form.password.value;
    const invite = getInvite();
    state.auth.gateEmail = email;
    state.auth.gateName = name;
    if (!name) { renderGate('Bitte gib einen Namen ein.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { renderGate('Bitte gib eine gültige E-Mail-Adresse ein.'); return; }
    if (password.length < MIN_PASSWORD) { renderGate(`Das Passwort braucht mindestens ${MIN_PASSWORD} Zeichen.`); return; }
    gateTask(async () => {
      const { data: ok, error: checkError } = await state.auth.client.rpc('check_invite', { p_code: invite });
      if (checkError) throw checkError;
      if (!ok) throw userError('Dieser Einladungslink ist nicht mehr gültig. Frag nach einem neuen Link.');
      const { data, error } = await state.auth.client.auth.signUp({
        email, password,
        options: { data: { invite_code: invite, name }, emailRedirectTo: appUrl() },
      });
      if (error) throw error;
      setInvite('');
      if (!data.session) state.auth.gateMode = 'registered'; // Bestätigungsmail nötig
      // Mit Session (Bestätigung ausgeschaltet) startet die App über onAuthStateChange
    });
  },

  forgot: (form) => {
    const email = form.email.value.trim();
    state.auth.gateEmail = email;
    if (!email) { renderGate('Bitte gib deine E-Mail ein.'); return; }
    gateTask(async () => {
      const { error } = await state.auth.client.auth.resetPasswordForEmail(email, { redirectTo: appUrl() });
      if (error) throw error;
      state.auth.gateMode = 'forgot-sent';
    });
  },

  reset: (form) => {
    const password = form.password.value;
    if (password.length < MIN_PASSWORD) { renderGate(`Das Passwort braucht mindestens ${MIN_PASSWORD} Zeichen.`); return; }
    if (password !== form.password2.value) { renderGate('Die beiden Passwörter sind nicht gleich.'); return; }
    gateTask(async () => {
      const { data, error } = await state.auth.client.auth.updateUser({ password });
      if (error) throw error;
      state.auth.recovery = false;
      toast('Neues Passwort gespeichert');
      const { data: s } = await state.auth.client.auth.getSession();
      const user = (s && s.session && s.session.user) || (data && data.user);
      if (user && !state.userId) startApp(user);
      else if (!user) state.auth.gateMode = 'login';
    });
  },

  /* Konto */
  'account-name': async (form) => {
    const name = form.name.value.trim().slice(0, 60);
    try {
      const { error } = await state.auth.client.rpc('update_my_name', { p_name: name });
      if (error) throw error;
      state.meta.profile = { ...(state.meta.profile || {}), display_name: name };
      saveCache();
      state.admin.users = null;
      toast('Name gespeichert');
    } catch (err) {
      console.warn(err);
      toast('Hat nicht geklappt (offline?)');
    }
  },

  'account-password': async (form) => {
    const password = form.password.value;
    if (password.length < MIN_PASSWORD) { toast(`Mindestens ${MIN_PASSWORD} Zeichen`); return; }
    if (password !== form.password2.value) { toast('Die Passwörter sind nicht gleich'); return; }
    try {
      const { error } = await state.auth.client.auth.updateUser({ password });
      if (error) throw error;
      form.reset();
      form.closest('details').open = false;
      toast('Passwort geändert');
    } catch (err) {
      console.warn(err);
      alert(authErrorText(err));
    }
  },

  'v1-claim': (form) => {
    const secret = extractSecret(form.link.value);
    if (!secret) { toast('Das sieht nicht nach einem V1-Link aus'); return; }
    claimV1(secret);
  },
};

/* --- Eingabefelder (ohne Neuzeichnen, damit der Fokus bleibt) --- */
function onFieldInput(el) {
  const field = el.dataset.field;
  const w = activeWorkout();

  if (field === 'set-weight' || field === 'set-reps') {
    const entry = findEntry(el.dataset.entry);
    const set = entry && entry.sets[Number(el.dataset.set)];
    if (!set) return;
    let value = parseNum(el.value);
    if (value !== null && value < 0) value = 0;
    if (field === 'set-reps' && value !== null) value = Math.round(value);
    set[field === 'set-weight' ? 'weight' : 'reps'] = value;
    commit();
    refreshSession();
  } else if (field === 'workout-note' && w) {
    w.note = el.value.slice(0, 2000);
    commit();
  } else if (field === 'entry-variant') {
    const entry = findEntry(el.dataset.entry);
    if (!entry) return;
    entry.variant = el.value.slice(0, 60);
    const ex = getExercise(entry.exerciseId);
    if (ex) ex.variant = entry.variant; // als Vorschlag fürs nächste Mal merken
    commit();
  }
}

function onFieldChange(el) {
  const field = el.dataset.field;
  if (field === 'workout-date') {
    const w = activeWorkout();
    if (w && isValidISODate(el.value)) { w.date = el.value; commit(); render(); }
  } else if (field === 'stats-exercise') {
    state.statsExerciseId = el.value;
    render();
  } else if (field === 'ex-type') {
    const ex = getExercise(el.dataset.id);
    if (ex) { ex.type = el.value === 'bodyweight' ? 'bodyweight' : 'weight'; commit(); }
  }
}

function bindEvents() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) {
      // Tippen auf eine Satz-Zeile macht sie zum aktuellen Satz
      const row = e.target.closest('.set');
      if (row && !row.classList.contains('is-current')) setFocusRow(row);
      return;
    }
    if (el.disabled) return;
    if (state.admin.viewAs && !READONLY_ACTIONS.has(el.dataset.action)) return;
    if (state.admin.viewAs && el.dataset.action === 'nav' && !['history', 'stats'].includes(el.dataset.view)) return;
    const fn = actions[el.dataset.action];
    if (fn) { e.preventDefault(); fn(el); }
  });
  document.addEventListener('focusin', (e) => {
    if (!e.target.classList || !e.target.classList.contains('num')) return;
    const row = e.target.closest('.set');
    if (row && !row.classList.contains('is-current')) setFocusRow(row);
  });
  setInterval(tick, 500);

  document.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-form]');
    if (!form) return;
    e.preventDefault();
    if (state.admin.viewAs) return;
    const fn = forms[form.dataset.form];
    if (fn) fn(form);
  });

  document.addEventListener('input', (e) => {
    if (state.admin.viewAs) return;
    if (e.target.dataset && e.target.dataset.field) onFieldInput(e.target);
  });
  document.addEventListener('change', (e) => {
    if (state.admin.viewAs) return;
    if (e.target.dataset && e.target.dataset.field) onFieldChange(e.target);
  });

  // Enter im Wdh.-Feld → zum nächsten Feld springen (schnelles Eintippen)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.classList || !e.target.classList.contains('num')) return;
    e.preventDefault();
    const inputs = [...document.querySelectorAll('.num')];
    const next = inputs[inputs.indexOf(e.target) + 1];
    if (next) next.focus(); else e.target.blur();
  });

  $('#importFile').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) importData(file);
    e.target.value = '';
  });

  // Sync bei Rückkehr in die App, bei Netz-Rückkehr und periodisch
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncNow();
    else if (state.meta.dirty) pushToServer();
  });
  window.addEventListener('online', syncNow);
  setInterval(() => { if (state.meta.dirty) syncNow(); }, SYNC_RETRY_MS);

  // Heatmap-Grösse bei Grössenänderung neu berechnen
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.view === 'stats') drawHeatmap(); }, 150);
  });
}

/* ---------------------------------------------------------------------
   9. Start
   --------------------------------------------------------------------- */
function applyTheme() {
  document.documentElement.dataset.theme = state.prefs.theme || 'dark';
  const palette = PALETTES.some(([k]) => k === state.prefs.palette) ? state.prefs.palette : 'stahl';
  document.documentElement.dataset.palette = palette;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = cssVar('--bg') || '#0e1217';
}

/** App für ein angemeldetes Konto starten (user = Supabase-User). */
function startApp(user, { offline = false } = {}) {
  if (state.userId && state.userId !== user.id) stopApp({ keepCache: true });
  state.userId = user.id;
  state.prefs.lastUserId = user.id;
  savePrefs();

  const cached = loadCache();
  state.data = cached ? cached.data : emptyData();
  state.meta = {
    dirty: false, lastSyncedAt: null, activeWorkoutId: null, profile: null,
    ...(cached ? cached.meta : {}),
  };
  if (user.email && !state.meta.profile) state.meta.profile = { email: user.email, display_name: '', is_admin: false };
  if (state.meta.activeWorkoutId && !getWorkout(state.meta.activeWorkoutId)) state.meta.activeWorkoutId = null;
  state.admin = { users: null, inviteCode: null, viewAs: null, ownData: null };
  state.view = 'training';
  state.summary = null;
  state.focus = null;
  document.body.classList.remove('read-only');

  $('#gate').hidden = true;
  $('#app').hidden = false;
  if (offline) {
    state.sync.configured = false;
    setSyncStatus('offline');
  } else {
    initSync();
  }
  render();
  if (!offline) {
    pullFromServer();
    loadProfile();
  }
}

/** Offline mit dem zuletzt angemeldeten Konto weiterarbeiten (Supabase nicht geladen). */
function startOffline() {
  const id = state.prefs.lastUserId;
  if (!id) return;
  startApp({ id, email: '' }, { offline: true });
}

/** App beenden (Logout). Lokale Kopie wird entfernt, ausser keepCache. */
function stopApp({ keepCache = false } = {}) {
  clearTimeout(state.sync.pushTimer);
  if (!keepCache && state.userId) {
    try { localStorage.removeItem(cacheKey(state.userId)); } catch { /* egal */ }
  }
  if (!keepCache) { state.prefs.lastUserId = null; savePrefs(); }
  destroyCharts();
  hideRest();
  state.userId = null;
  state.data = null;
  state.meta = { dirty: false, lastSyncedAt: null, activeWorkoutId: null, profile: null };
  state.admin = { users: null, inviteCode: null, viewAs: null, ownData: null };
  state.sync.serverChecked = false;
  state.sync.serverHadData = false;
  document.body.classList.remove('read-only');
  $('#view').innerHTML = '';
}

async function logout() {
  if (state.admin.viewAs) exitViewAs();
  if (state.meta.dirty) {
    await pushToServer();
    if (state.meta.dirty && !confirm('Einige Änderungen sind noch nicht auf dem Server (offline?). Trotzdem abmelden? Sie gehen dann verloren.')) return;
  }
  state.auth.gateEmail = (state.meta.profile && state.meta.profile.email) || '';
  stopApp();
  setGate('login');
  try { await state.auth.client.auth.signOut(); } catch (err) { console.warn(err); }
}

function init() {
  loadPrefs();
  applyTheme();
  bindEvents();
  readInviteFromUrl();
  const hashError = readHashError();
  if (/type=recovery/.test(location.hash)) state.auth.recovery = true;

  const { cfg, configOk, libOk } = configCheck();
  if (!configOk) {
    $('#gate').innerHTML = gateBrand() + '<p class="error">In config.js fehlen die Supabase-Daten. Siehe SETUP.md.</p>';
    $('#gate').hidden = false;
    return;
  }
  if (!libOk) {
    console.warn('Supabase-Bibliothek nicht geladen (offline?)');
    setGate('offline');
    return;
  }

  state.auth.client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: STORAGE_PREFIX + 'auth' },
  });
  state.auth.pendingError = hashError;
  // Supabase empfiehlt: im Callback keine weiteren Supabase-Aufrufe direkt abwarten → entkoppeln
  state.auth.client.auth.onAuthStateChange((event, session) => {
    setTimeout(() => handleAuthEvent(event, session), 0);
  });
}

init();
