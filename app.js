/* =====================================================================
   Gym-Tracker – App-Logik (ohne Framework)

   Aufbau dieser Datei:
     1. Konstanten & Zustand
     2. Hilfsfunktionen (Datum, Zahlen, HTML)
     3. Datenmodell & lokaler Speicher (localStorage)
     4. Sync mit Supabase
     5. Schlüssel im Link (?k=...) & Startbildschirm
     6. Ansichten (Training, Verlauf, Fortschritt, Mehr)
     7. Diagramme & Heatmap
     8. Aktionen (Klicks, Eingaben)
     9. Start

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

const state = {
  secret: null,
  data: null,                 // synchronisierte Daten (siehe Format oben)
  meta: {                     // nur lokal (pro Gerät), wird nicht synchronisiert
    dirty: false,             // true = lokale Änderungen noch nicht auf dem Server
    lastSyncedAt: null,
    activeWorkoutId: null,    // Training, das gerade bearbeitet wird
    showLinkHint: false,      // Hinweis "Link speichern" nach dem Erstellen
  },
  prefs: { theme: 'dark', palette: 'stahl', range: '3m', lastSecret: null },
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

/** Zufälliger, URL-tauglicher Schlüssel (32 Zeichen, 192 Bit). */
function randomSecret() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

function cacheKey() { return STORAGE_PREFIX + 'data:' + state.secret; }

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
function initSync() {
  const cfg = window.GYM_CONFIG || {};
  const urlOk = typeof cfg.supabaseUrl === 'string' && /^https:\/\/[^\s]+$/.test(cfg.supabaseUrl);
  const keyOk = typeof cfg.supabaseAnonKey === 'string' && cfg.supabaseAnonKey.length > 20 && !cfg.supabaseAnonKey.startsWith('DEIN');
  const libOk = !!(window.supabase && window.supabase.createClient);

  state.sync.configured = urlOk && keyOk && libOk;
  if (state.sync.configured) {
    state.sync.client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    setSyncStatus(state.meta.dirty ? 'syncing' : 'synced');
  } else {
    if (urlOk && keyOk && !libOk) console.warn('Supabase-Bibliothek nicht geladen (offline?)');
    setSyncStatus('local');
  }
}

function setSyncStatus(status) {
  state.sync.status = status;
  const pill = $('#syncPill');
  if (!pill) return;
  pill.dataset.status = status;
  $('.sync-label', pill).textContent = SYNC_LABELS[status] || status;
  pill.title = status === 'local'
    ? 'Daten liegen nur in diesem Browser. Siehe SETUP.md.'
    : (state.meta.lastSyncedAt ? 'Zuletzt synchronisiert: ' + new Date(state.meta.lastSyncedAt).toLocaleString('de-CH') : '');
  if (state.view === 'settings') {
    const s = $('#syncStatusText');
    if (s) s.textContent = SYNC_LABELS[status];
  }
}

/** Server lesen und mit lokalem Stand abgleichen. */
async function pullFromServer() {
  if (!state.sync.configured || state.sync.pulling) return;
  state.sync.pulling = true;
  setSyncStatus('syncing');
  try {
    const { data: row, error } = await state.sync.client.rpc('get_gym_data', { p_secret: state.secret });
    if (error) throw error;
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
  if (!state.sync.configured) return;
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
    const { error } = await state.sync.client.rpc('save_gym_data', { p_secret: state.secret, p_data: state.data });
    if (error) throw error;
    state.sync.allowEmptyOnce = false;
    state.sync.serverHadData = !isEmptyData(state.data);
    if (state.data.updatedAt === snapshotTime) state.meta.dirty = false;
    state.meta.lastSyncedAt = new Date().toISOString();
    saveCache();
    setSyncStatus(state.meta.dirty ? 'syncing' : 'synced');
  } catch (err) {
    console.warn('Speichern auf Server fehlgeschlagen', err);
    setSyncStatus('offline');
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
  if (!state.sync.configured) return;
  if (state.meta.dirty && state.sync.serverChecked) pushToServer();
  else pullFromServer();
}

/* ---------------------------------------------------------------------
   5. Schlüssel im Link & Startbildschirm
   --------------------------------------------------------------------- */
function getSecretFromUrl() {
  const k = new URLSearchParams(location.search).get('k');
  return k && SECRET_PATTERN.test(k) ? k : (k ? false : null); // false = ungültig
}

function personalLink() {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('k', state.secret);
  return url.toString();
}

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

function openWithSecret(secret, isNew = false) {
  const url = new URL(location.href);
  url.searchParams.set('k', secret);
  history.replaceState(null, '', url.toString());
  startApp(secret, isNew);
}

function renderGate(errorText = '') {
  const gate = $('#gate');
  const saved = state.prefs.lastSecret && SECRET_PATTERN.test(state.prefs.lastSecret);
  gate.innerHTML = `
    <div class="gate-brand">
      <span class="logo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6M7 7v10M17 7v10M20 9v6M7 12h10"/></svg></span>
      <h1 class="title">Gym-Tracker</h1>
    </div>
    <p>Dieser Tracker hat kein Login. Deine Daten gehören zu einem geheimen Schlüssel, der im Link steckt
      (<span class="num-tab">…/?k=…</span>). Wer den Link hat, sieht die Daten – also gut aufbewahren und nicht teilen.</p>
    ${errorText ? `<p class="error">${esc(errorText)}</p>` : ''}
    <div class="gate-actions">
      ${saved ? '<button class="btn btn-p block" data-action="gate-saved">Mit gespeichertem Link weiter</button>' : ''}
      <button class="btn ${saved ? 'btn-s' : 'btn-p'} block" data-action="gate-new">Neuen Tracker erstellen</button>
    </div>
    <div class="divider">oder</div>
    <form class="gate-actions card" data-form="gate-open">
      <label class="field">Bestehenden Link oder Schlüssel einfügen
        <input class="input" name="link" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://…/?k=…">
      </label>
      <button class="btn btn-s block" type="submit">Öffnen</button>
    </form>
    <p class="small muted">Tipp: Den Link nach dem Erstellen als Lesezeichen speichern und auf Handy und PC öffnen.</p>`;
  $('#app').hidden = true;
  gate.hidden = false;
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
    if (t.dataset.view === state.view) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
  const view = $('#view');
  if (state.view === 'history') view.innerHTML = renderHistory();
  else if (state.view === 'stats') view.innerHTML = renderStats();
  else if (state.view === 'settings') view.innerHTML = renderSettings();
  else view.innerHTML = renderTraining();

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
    <div class="head"><div><h1 class="title">Training</h1><p class="sub">${esc(formatDate(todayISO()))}</p></div></div>
    ${linkHintHtml()}
    ${syncNoticeHtml()}
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

function linkHintHtml() {
  if (!state.meta.showLinkHint) return '';
  return `
    <div class="notice">
      <strong>Neuer Tracker erstellt.</strong>
      <span>Speichere diesen Link als Lesezeichen. Ohne ihn kommst du auf einem anderen Gerät nicht an deine Daten.</span>
      <div class="row">
        <button class="btn btn-p btn-sm" data-action="copy-link">Link kopieren</button>
        <button class="btn btn-s btn-sm" data-action="dismiss-link-hint">Erledigt</button>
      </div>
    </div>`;
}

function syncNoticeHtml() {
  if (state.sync.configured) return '';
  return `
    <div class="notice">
      <strong>Sync nicht eingerichtet</strong>
      <span>Deine Daten werden nur in diesem Browser gespeichert. Für Handy + PC: Supabase einrichten (siehe SETUP.md).</span>
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
      <button class="btn btn-s" data-action="open-workout" data-id="${esc(w.id)}">Bearbeiten</button>
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
    ${linkHintHtml()}
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
    return head + '<div class="card"><p class="empty">Noch keine Trainings. Starte eines unter «Training».</p></div>';
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
        <form class="bw-form" data-form="bodyweight">
          <input class="input tnum" type="date" name="date" value="${todayISO()}" max="${todayISO()}" aria-label="Datum">
          <input class="input tnum" name="kg" inputmode="decimal" placeholder="kg heute" aria-label="Körpergewicht in kg" required>
          <button class="btn btn-s" type="submit">Speichern</button>
        </form>
        ${bwInRange.length
          ? '<div class="chart chart-bw"><canvas id="bwChart" role="img" aria-label="Körpergewicht"></canvas></div>'
          : `<p class="muted">${bwAll.length ? `Keine Einträge im Zeitraum «${esc(r.label)}».` : 'Noch keine Einträge.'}</p>`}
        ${bwAll.length ? `<div class="bw-list">${bwAll.slice(0, 5).map((b) => `
          <div class="side-row"><span>${esc(formatDate(b.date, 'weekday'))}</span><b>${esc(fmtNum(b.kg, 1))} kg</b>
            <button class="x" data-action="bw-delete" data-id="${esc(b.id)}" aria-label="Eintrag löschen">${ICON_X}</button></div>`).join('')}</div>` : ''}
      </div>
    </div>`;
}

/* --- Mehr / Einstellungen --- */
function renderSettings() {
  const exercises = [...state.data.exercises].sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const lastSync = state.meta.lastSyncedAt ? new Date(state.meta.lastSyncedAt).toLocaleString('de-CH') : '–';
  const palette = state.prefs.palette || 'stahl';

  return `
    <div class="head"><div><h1 class="title">Mehr</h1></div></div>

    <div class="card">
      <h2>Dein Link</h2>
      <p class="small muted">Mit diesem Link öffnest du deine Daten auf Handy und PC. Nicht teilen – wer ihn hat, sieht und ändert deine Daten.</p>
      <div class="link-box" id="linkBox">${esc(personalLink())}</div>
      <button class="btn btn-s" data-action="copy-link">Link kopieren</button>
    </div>

    <div class="card">
      <div class="card-head"><h2>Sync</h2><span class="small muted" id="syncStatusText">${SYNC_LABELS[state.sync.status]}</span></div>
      ${state.sync.configured
        ? `<p class="small muted">Zuletzt synchronisiert: ${esc(lastSync)}</p>
           <button class="btn btn-s" data-action="sync-now">Jetzt synchronisieren</button>`
        : '<p class="small muted">In config.js sind noch keine Supabase-Daten eingetragen. Die App speichert deshalb nur in diesem Browser. Anleitung: SETUP.md.</p>'}
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

  'copy-link': () => copyText(personalLink()),
  'dismiss-link-hint': () => { state.meta.showLinkHint = false; saveCache(); render(); },
  'sync-now': () => { pullFromServer(); },

  export: () => exportData(),
  import: () => $('#importFile').click(),

  'set-theme': (el) => {
    state.prefs.theme = el.dataset.theme;
    savePrefs();
    applyTheme();
    render();
  },

  'gate-new': () => {
    const secret = randomSecret();
    openWithSecret(secret, true);
  },
  'gate-saved': () => openWithSecret(state.prefs.lastSecret),
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

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link kopiert');
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

  'gate-open': (form) => {
    const secret = extractSecret(form.link.value);
    if (!secret) { renderGate('Das sieht nicht nach einem gültigen Link oder Schlüssel aus.'); return; }
    openWithSecret(secret);
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
    const fn = forms[form.dataset.form];
    if (fn) fn(form);
  });

  document.addEventListener('input', (e) => {
    if (e.target.dataset && e.target.dataset.field) onFieldInput(e.target);
  });
  document.addEventListener('change', (e) => {
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

function startApp(secret, isNew = false) {
  state.secret = secret;
  state.prefs.lastSecret = secret;
  savePrefs();

  const cached = loadCache();
  state.data = cached ? cached.data : emptyData();
  Object.assign(state.meta, cached ? cached.meta : {});
  if (isNew) state.meta.showLinkHint = true;
  if (state.meta.activeWorkoutId && !getWorkout(state.meta.activeWorkoutId)) state.meta.activeWorkoutId = null;

  $('#gate').hidden = true;
  $('#app').hidden = false;
  initSync();
  render();
  pullFromServer();
}

function init() {
  loadPrefs();
  applyTheme();
  bindEvents();

  const secret = getSecretFromUrl();
  if (secret) startApp(secret);
  else renderGate(secret === false ? 'Der Schlüssel im Link ist ungültig.' : '');
}

init();
