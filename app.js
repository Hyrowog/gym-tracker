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
  prefs: { theme: 'dark', range: '3m', lastSecret: null },
  view: 'training',
  statsExerciseId: null,
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

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const ICON_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>';
const ICON_CHEV = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

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
  commit();
  render();
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
    <div>
      <h1>Gym-Tracker</h1>
    </div>
    <p>Dieser Tracker hat kein Login. Deine Daten gehören zu einem geheimen Schlüssel, der im Link steckt
      (<span class="num-tab">…/?k=…</span>). Wer den Link hat, sieht die Daten – also gut aufbewahren und nicht teilen.</p>
    ${errorText ? `<p class="error">${esc(errorText)}</p>` : ''}
    <div class="gate-actions">
      ${saved ? '<button class="btn btn-primary btn-block" data-action="gate-saved">Mit gespeichertem Link weiter</button>' : ''}
      <button class="btn ${saved ? 'btn-secondary' : 'btn-primary'} btn-block" data-action="gate-new">Neuen Tracker erstellen</button>
    </div>
    <div class="divider">oder</div>
    <form class="gate-actions" data-form="gate-open">
      <label class="field">Bestehenden Link oder Schlüssel einfügen
        <input class="input" name="link" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://…/?k=…">
      </label>
      <button class="btn btn-secondary btn-block" type="submit">Öffnen</button>
    </form>
    <p class="small muted">Tipp: Den Link nach dem Erstellen als Lesezeichen speichern und auf Handy und PC öffnen.</p>`;
  $('#app').hidden = true;
  gate.hidden = false;
}

/* ---------------------------------------------------------------------
   6. Ansichten
   --------------------------------------------------------------------- */
function render() {
  destroyCharts();
  document.querySelectorAll('.tab').forEach((t) => {
    if (t.dataset.view === state.view) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
  const view = $('#view');
  if (state.view === 'history') view.innerHTML = renderHistory();
  else if (state.view === 'stats') view.innerHTML = renderStats();
  else if (state.view === 'settings') view.innerHTML = renderSettings();
  else view.innerHTML = renderTraining();

  if (state.view === 'stats') drawStats();
}

function setView(name) {
  state.view = name;
  render();
  window.scrollTo(0, 0);
}

/* --- Training --- */
function renderTraining() {
  const active = state.meta.activeWorkoutId && getWorkout(state.meta.activeWorkoutId);
  if (active) return renderWorkoutEditor(active);

  const last = sortedWorkouts().find((w) => w.entries.length > 0);
  const recent = sortedWorkouts().slice(0, 3);
  const lastInfo = last
    ? `${relativeDay(last.date)} · ${last.entries.length} ${last.entries.length === 1 ? 'Übung' : 'Übungen'}`
    : 'Noch kein Training';

  return `
  <section class="view">
    <div class="view-head">
      <div>
        <h1 class="view-title">Training</h1>
        <p class="view-sub">${esc(formatDate(todayISO()))}</p>
      </div>
    </div>
    ${linkHintHtml()}
    ${syncNoticeHtml()}
    <div class="start-grid">
      <button class="btn ${last ? 'btn-primary' : 'btn-secondary'} btn-lg" data-action="start-repeat" ${last ? '' : 'disabled'}>
        Letztes Training wiederholen<small>${esc(lastInfo)}</small>
      </button>
      <button class="btn ${last ? 'btn-secondary' : 'btn-primary'} btn-lg" data-action="start-empty">
        Leeres Training<small>Übungen selbst wählen</small>
      </button>
    </div>
    ${recent.length ? `
      <h2 class="section-title">Zuletzt</h2>
      <div class="card"><div class="list">${recent.map(workoutListItem).join('')}</div></div>` : ''}
  </section>`;
}

function linkHintHtml() {
  if (!state.meta.showLinkHint) return '';
  return `
    <div class="notice">
      <strong>Neuer Tracker erstellt.</strong>
      <span>Speichere diesen Link als Lesezeichen. Ohne ihn kommst du auf einem anderen Gerät nicht an deine Daten.</span>
      <div class="row">
        <button class="btn btn-primary btn-sm" data-action="copy-link">Link kopieren</button>
        <button class="btn btn-secondary btn-sm" data-action="dismiss-link-hint">Erledigt</button>
      </div>
    </div>`;
}

function syncNoticeHtml() {
  if (state.sync.configured) return '';
  return `
    <div class="notice">
      <strong>Sync nicht eingerichtet</strong>
      <span class="small">Deine Daten werden nur in diesem Browser gespeichert. Für Handy + PC: Supabase einrichten (siehe SETUP.md).</span>
    </div>`;
}

function workoutListItem(w) {
  const names = w.entries.map((e) => (getExercise(e.exerciseId) || {}).name).filter(Boolean);
  const sets = w.entries.reduce((sum, e) => sum + validSets(e).length, 0);
  return `
    <button class="list-item" data-action="open-workout" data-id="${esc(w.id)}">
      <div class="grow">
        <div class="title">${esc(formatDate(w.date, 'weekday'))}</div>
        <div class="sub">${names.length ? esc(names.join(', ')) : 'Keine Übungen'}${w.note ? ' · ' + esc(w.note.slice(0, 60)) : ''}</div>
      </div>
      <span class="meta">${sets} ${sets === 1 ? 'Satz' : 'Sätze'}</span>
      ${ICON_CHEV}
    </button>`;
}

function renderWorkoutEditor(w) {
  const usedIds = new Set(w.entries.map((e) => e.exerciseId));
  const available = exercisesByRecency().filter((e) => !usedIds.has(e.id));

  return `
  <section class="view" data-workout="${esc(w.id)}">
    <div class="view-head">
      <div>
        <h1 class="view-title">${w.date === todayISO() ? 'Heutiges Training' : 'Training'}</h1>
        <p class="view-sub">${esc(formatDate(w.date))}</p>
      </div>
    </div>
    ${linkHintHtml()}

    <div class="workout-meta">
      <label class="field">Datum
        <input class="input" type="date" data-field="workout-date" value="${esc(w.date)}" max="${todayISO()}">
      </label>
      <label class="field">Notiz
        <input class="input" data-field="workout-note" value="${esc(w.note)}" placeholder="optional, z.B. «müde» oder «neues Programm»" maxlength="2000">
      </label>
    </div>

    ${w.entries.map((entry) => renderEntry(w, entry)).join('')}

    <div class="card">
      <h3>Übung hinzufügen</h3>
      ${available.length ? `<div class="chips">${available.map((e) =>
        `<button class="chip" data-action="add-existing" data-id="${esc(e.id)}">${esc(e.name)}</button>`).join('')}</div>` : ''}
      <form class="new-ex-form" data-form="new-exercise">
        <input class="input" name="name" placeholder="Neue Übung, z.B. Bankdrücken" maxlength="80" autocomplete="off" required>
        <div class="segmented" role="radiogroup" aria-label="Typ">
          <label><input type="radio" name="type" value="weight" checked><span>Gewicht</span></label>
          <label><input type="radio" name="type" value="bodyweight"><span>Körpergewicht</span></label>
        </div>
        <button class="btn btn-secondary" type="submit">Hinzufügen</button>
      </form>
    </div>

    <div class="workout-actions">
      <button class="btn btn-primary btn-block" data-action="finish-workout">Training abschliessen</button>
      <button class="btn btn-danger btn-block" data-action="delete-workout" data-id="${esc(w.id)}">Training löschen</button>
    </div>
  </section>`;
}

function renderEntry(w, entry) {
  const ex = getExercise(entry.exerciseId);
  if (!ex) return '';
  const isBw = ex.type === 'bodyweight';
  const last = lastEntryFor(ex.id, w.id);
  const lastText = last ? `Letztes Mal (${formatDate(last.workout.date, 'short')}): ${setsSummary(ex, last.entry)}` : '';

  return `
  <div class="card entry" data-entry="${esc(entry.id)}">
    <div class="entry-head">
      <h3>${esc(ex.name)}</h3>
      <span class="tag">${TYPE_LABELS[ex.type]}</span>
      <button class="icon-btn" data-action="remove-entry" data-entry="${esc(entry.id)}" aria-label="Übung entfernen">${ICON_X}</button>
    </div>
    ${lastText ? `<p class="last-hint">${esc(lastText)}</p>` : ''}
    ${isBw ? `<input class="input" data-field="entry-variant" data-entry="${esc(entry.id)}" value="${esc(entry.variant)}"
        placeholder="Variante, z.B. Stufe 2 oder assistiert" maxlength="60">` : ''}
    <div class="set-grid">
      <div class="set-labels"><span></span><span>${isBw ? 'Zusatzgewicht (kg)' : 'Gewicht (kg)'}</span><span>Wdh.</span><span></span></div>
      ${entry.sets.map((s, i) => renderSetRow(entry, s, i, isBw)).join('')}
    </div>
    <button class="btn btn-ghost btn-block" data-action="add-set" data-entry="${esc(entry.id)}">+ Satz hinzufügen</button>
  </div>`;
}

function renderSetRow(entry, set, i, isBw) {
  const e = esc(entry.id);
  return `
    <div class="set-row" data-set="${i}">
      <span class="set-no">${i + 1}</span>
      <div class="stepper">
        <button type="button" data-action="w-dec" data-entry="${e}" data-set="${i}" aria-label="Gewicht minus ${WEIGHT_STEP}">−</button>
        <input class="num" data-field="set-weight" data-entry="${e}" data-set="${i}" inputmode="decimal" autocomplete="off"
          value="${esc(fmtNum(set.weight))}" placeholder="${isBw ? '0' : 'kg'}" aria-label="Gewicht Satz ${i + 1}">
        <button type="button" data-action="w-inc" data-entry="${e}" data-set="${i}" aria-label="Gewicht plus ${WEIGHT_STEP}">+</button>
      </div>
      <div class="num-box">
        <input class="num" data-field="set-reps" data-entry="${e}" data-set="${i}" inputmode="numeric" pattern="[0-9]*" autocomplete="off"
          value="${esc(fmtNum(set.reps, 0))}" placeholder="–" aria-label="Wiederholungen Satz ${i + 1}">
      </div>
      <button class="icon-btn" data-action="remove-set" data-entry="${e}" data-set="${i}" aria-label="Satz ${i + 1} entfernen">${ICON_X}</button>
    </div>`;
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
function renderHistory() {
  const workouts = sortedWorkouts();
  let html = `
  <section class="view">
    <div class="view-head"><h1 class="view-title">Verlauf</h1><span class="view-sub">${workouts.length} Trainings</span></div>`;
  if (!workouts.length) {
    return html + '<div class="card"><p class="empty">Noch keine Trainings. Starte eines unter «Training».</p></div></section>';
  }
  // Nach Monat gruppieren
  let currentMonth = '';
  let group = [];
  const flush = () => {
    if (group.length) html += `<div class="card"><div class="list">${group.join('')}</div></div>`;
    group = [];
  };
  for (const w of workouts) {
    const month = parseISODate(w.date).toLocaleDateString('de-CH', { month: 'long', year: 'numeric' });
    if (month !== currentMonth) {
      flush();
      currentMonth = month;
      html += `<h2 class="month-label">${esc(month)}</h2>`;
    }
    group.push(workoutListItem(w));
  }
  flush();
  return html + '</section>';
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

function renderStats() {
  const inRange = workoutsInRange();
  const days = new Set(inRange.map((w) => w.date));
  const sets = inRange.reduce((s, w) => s + w.entries.reduce((a, e) => a + validSets(e).length, 0), 0);

  // Durchschnitt pro Woche
  const r = RANGES[state.prefs.range];
  let spanDays = r.days;
  if (!spanDays) {
    const first = [...days].sort()[0];
    spanDays = first ? Math.max(28, Math.round((parseISODate(todayISO()) - parseISODate(first)) / 86400000) + 1) : 7;
  }
  const perWeek = days.size / (spanDays / 7);

  const exercises = exercisesByRecency().filter((e) => exerciseUseCount(e.id) > 0);
  if (!state.statsExerciseId || !exercises.some((e) => e.id === state.statsExerciseId)) {
    state.statsExerciseId = exercises[0] ? exercises[0].id : null;
  }
  const ex = state.statsExerciseId ? getExercise(state.statsExerciseId) : null;
  const bwSorted = [...state.data.bodyweight].sort((a, b) => b.date.localeCompare(a.date));

  return `
  <section class="view">
    <div class="view-head"><h1 class="view-title">Fortschritt</h1></div>
    <div class="segmented" role="group" aria-label="Zeitraum">
      ${Object.entries(RANGES).map(([key, v]) =>
        `<button data-action="set-range" data-range="${key}" aria-pressed="${state.prefs.range === key}">${v.label}</button>`).join('')}
    </div>
    <div class="kpis">
      <div class="kpi"><div class="kpi-value">${days.size}</div><div class="kpi-label">Trainingstage</div></div>
      <div class="kpi"><div class="kpi-value">${fmtNum(perWeek, 1)}</div><div class="kpi-label">pro Woche</div></div>
      <div class="kpi"><div class="kpi-value">${sets}</div><div class="kpi-label">Sätze</div></div>
    </div>

    <div class="stats-grid">
      <div class="card span-2">
        <div class="card-head"><h2>Übung</h2></div>
        ${exercises.length ? `
          <select class="select" data-field="stats-exercise" aria-label="Übung wählen">
            ${exercises.map((e) => `<option value="${esc(e.id)}" ${e.id === state.statsExerciseId ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}
          </select>
          <div class="best" id="exBest"></div>
          <div class="chart-box"><canvas id="exChart" aria-label="Fortschritt der Übung"></canvas></div>
          <p class="chart-note">${ex && ex.type === 'bodyweight'
            ? 'Linie: meiste Wiederholungen in einem Satz pro Tag. Gestrichelt: Wiederholungen total.'
            : 'Linie: geschätztes 1RM (Epley: Gewicht × (1 + Wdh. / 30)), bester Satz pro Tag. Gestrichelt: schwerstes Gewicht.'}</p>`
        : '<p class="empty">Sobald du Sätze mit Wiederholungen einträgst, erscheint hier deine Kurve.</p>'}
      </div>

      <div class="card">
        <div class="card-head"><h2>Trainingstage</h2></div>
        <div class="heatmap-wrap" id="heatmapWrap"></div>
        <div class="hm-legend">weniger
          <span class="hm-cell" data-l="0"></span><span class="hm-cell" data-l="1"></span><span class="hm-cell" data-l="2"></span>
          <span class="hm-cell" data-l="3"></span><span class="hm-cell" data-l="4"></span> mehr Sätze</div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Körpergewicht</h2></div>
        <form class="bw-form" data-form="bodyweight">
          <input class="input" type="date" name="date" value="${todayISO()}" max="${todayISO()}" aria-label="Datum">
          <input class="input num-tab" name="kg" inputmode="decimal" placeholder="kg, z.B. 78.5" aria-label="Körpergewicht in kg" required>
          <button class="btn btn-primary" type="submit">Speichern</button>
        </form>
        ${state.data.bodyweight.length
          ? `<div class="chart-box"><canvas id="bwChart" aria-label="Körpergewicht"></canvas></div>
             <div class="list bw-list">${bwSorted.slice(0, 5).map((b) => `
               <div class="list-item">
                 <span class="grow">${esc(formatDate(b.date, 'weekday'))}</span>
                 <span class="num-tab"><strong>${esc(fmtNum(b.kg, 1))}</strong> kg</span>
                 <button class="icon-btn" data-action="bw-delete" data-id="${esc(b.id)}" aria-label="Eintrag löschen">${ICON_X}</button>
               </div>`).join('')}</div>`
          : '<p class="empty">Noch keine Einträge.</p>'}
      </div>
    </div>
  </section>`;
}

/* --- Mehr / Einstellungen --- */
function renderSettings() {
  const exercises = [...state.data.exercises].sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const lastSync = state.meta.lastSyncedAt ? new Date(state.meta.lastSyncedAt).toLocaleString('de-CH') : '–';

  return `
  <section class="view">
    <div class="view-head"><h1 class="view-title">Mehr</h1></div>

    <div class="card">
      <h2>Dein Link</h2>
      <p class="small muted">Mit diesem Link öffnest du deine Daten auf Handy und PC. Nicht teilen – wer ihn hat, sieht und ändert deine Daten.</p>
      <div class="link-box" id="linkBox">${esc(personalLink())}</div>
      <button class="btn btn-secondary" data-action="copy-link">Link kopieren</button>
    </div>

    <div class="card">
      <div class="card-head"><h2>Sync</h2><span class="small muted" id="syncStatusText">${SYNC_LABELS[state.sync.status]}</span></div>
      ${state.sync.configured
        ? `<p class="small muted">Zuletzt synchronisiert: ${esc(lastSync)}</p>
           <button class="btn btn-secondary" data-action="sync-now">Jetzt synchronisieren</button>`
        : '<p class="small muted">In config.js sind noch keine Supabase-Daten eingetragen. Die App speichert deshalb nur in diesem Browser. Anleitung: SETUP.md.</p>'}
    </div>

    <div class="card">
      <h2>Übungen</h2>
      ${exercises.length ? `<div>${exercises.map((e) => `
        <div class="ex-row">
          <div class="ex-row-top">
            <span class="grow">${esc(e.name)}</span>
            <span class="small muted">${exerciseUseCount(e.id)}×</span>
          </div>
          <div class="ex-row-actions">
            <select class="select" data-field="ex-type" data-id="${esc(e.id)}" aria-label="Typ von ${esc(e.name)}">
              <option value="weight" ${e.type === 'weight' ? 'selected' : ''}>Gewicht</option>
              <option value="bodyweight" ${e.type === 'bodyweight' ? 'selected' : ''}>Körpergewicht</option>
            </select>
            <button class="btn btn-secondary btn-sm" data-action="ex-rename" data-id="${esc(e.id)}">Umbenennen</button>
            <button class="btn btn-danger btn-sm" data-action="ex-delete" data-id="${esc(e.id)}">Löschen</button>
          </div>
        </div>`).join('')}</div>`
      : '<p class="empty">Noch keine Übungen. Du legst sie beim Training an.</p>'}
    </div>

    <div class="card">
      <h2>Backup</h2>
      <p class="small muted">Exportiert alle Trainings, Übungen und Körpergewichte als JSON-Datei. Beim Import werden die aktuellen Daten ersetzt.</p>
      <div class="row-2">
        <button class="btn btn-secondary" data-action="export">Exportieren</button>
        <button class="btn btn-secondary" data-action="import">Importieren</button>
      </div>
    </div>

    <div class="card">
      <h2>Darstellung</h2>
      <div class="segmented" role="group" aria-label="Design">
        ${[['dark', 'Dunkel'], ['light', 'Hell'], ['system', 'System']].map(([k, l]) =>
          `<button data-action="set-theme" data-theme="${k}" aria-pressed="${state.prefs.theme === k}">${l}</button>`).join('')}
      </div>
    </div>
  </section>`;
}

/* ---------------------------------------------------------------------
   7. Diagramme & Heatmap
   --------------------------------------------------------------------- */
function destroyCharts() {
  Object.values(state.charts).forEach((c) => c && c.destroy());
  state.charts = {};
}

function drawStats() {
  drawHeatmap();
  if (!window.Chart) {
    document.querySelectorAll('.chart-box').forEach((b) => {
      b.outerHTML = '<p class="empty">Diagramme konnten nicht geladen werden (offline?).</p>';
    });
    return;
  }
  drawExerciseChart();
  drawBodyweightChart();
}

/** Gemeinsame Chart.js-Optionen (Farben aus den CSS-Tokens). */
function baseChartOptions(unit) {
  const grid = cssVar('--border');
  const text = cssVar('--text-3');
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'nearest', axis: 'x', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: cssVar('--surface-2'),
        borderColor: grid,
        borderWidth: 1,
        titleColor: cssVar('--text'),
        bodyColor: cssVar('--text-2'),
        padding: 10,
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
        border: { color: grid },
        ticks: {
          color: text, maxRotation: 0, autoSkip: true, maxTicksLimit: 5,
          callback: (v) => new Date(v).toLocaleDateString('de-CH', { day: 'numeric', month: 'short' }),
        },
      },
      y: {
        grid: { color: grid },
        border: { display: false },
        ticks: { color: text, maxTicksLimit: 5, callback: (v) => fmtNum(v, 1) },
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
  const unit = isBw ? 'Wdh.' : 'kg';
  const primaryLabel = isBw ? 'Max. Wdh.' : 'Geschätztes 1RM';
  const secondaryLabel = isBw ? 'Wdh. total' : 'Schwerstes Gewicht';

  const best = $('#exBest');
  if (!series.length) {
    best.innerHTML = '';
    canvas.parentElement.outerHTML = `<p class="empty">Keine Sätze im Zeitraum «${RANGES[state.prefs.range].label}».</p>`;
    return;
  }
  const top = series.reduce((a, b) => (b.primary > a.primary ? b : a));
  const first = series[0].primary;
  const lastVal = series[series.length - 1].primary;
  const change = lastVal - first;
  best.innerHTML = `
    <span class="legend-line"><i></i>${primaryLabel}</span>
    <span class="legend-line"><i class="dashed"></i>${secondaryLabel}</span>
    <span>Bestwert: <strong>${fmtNum(top.primary, 1)} ${unit}</strong></span>
    ${series.length > 1 ? `<span>Veränderung: <strong>${change >= 0 ? '+' : ''}${fmtNum(change, 1)} ${unit}</strong></span>` : ''}`;

  const accent = cssVar('--accent');
  const options = baseChartOptions(unit);
  fitXAxis(options, series);
  state.charts.exercise = new Chart(canvas, {
    type: 'line',
    data: {
      datasets: [
        {
          label: primaryLabel,
          data: series.map((p) => ({ x: p.x, y: p.primary })),
          borderColor: accent, backgroundColor: accent,
          borderWidth: 2.5, pointRadius: 3, pointHoverRadius: 5, tension: 0.25,
        },
        {
          label: secondaryLabel,
          data: series.map((p) => ({ x: p.x, y: p.secondary })),
          borderColor: cssVar('--text-3'), backgroundColor: cssVar('--text-3'),
          borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, pointHoverRadius: 3, tension: 0.25,
        },
      ],
    },
    options,
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
  if (!points.length) {
    canvas.parentElement.outerHTML = `<p class="empty">Keine Einträge im Zeitraum «${RANGES[state.prefs.range].label}».</p>`;
    return;
  }
  const accent = cssVar('--accent');
  const options = baseChartOptions('kg');
  fitXAxis(options, points);
  state.charts.bodyweight = new Chart(canvas, {
    type: 'line',
    data: {
      datasets: [{
        label: 'Körpergewicht', data: points,
        borderColor: accent, backgroundColor: accent,
        borderWidth: 2.5, pointRadius: 3, pointHoverRadius: 5, tension: 0.25,
      }],
    },
    options,
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
  const r = RANGES[state.prefs.range];
  if (r.days) start = addDays(today, -(r.days - 1));
  else {
    const first = Object.keys(setsByDay).sort()[0];
    const minStart = addDays(today, -83);
    start = first && parseISODate(first) < minStart ? parseISODate(first) : minStart;
  }
  start = addDays(start, -((start.getDay() + 6) % 7));
  const weeks = Math.ceil((Math.round((today - start) / 86400000) + 1) / 7);

  // Zellgrösse an die verfügbare Breite anpassen (zu viele Wochen → horizontal scrollen im Kasten)
  const labelW = 22;
  const gap = 3;
  const avail = wrap.clientWidth - labelW - gap;
  const cell = Math.max(11, Math.min(26, Math.floor(avail / weeks) - gap));

  const level = (n) => (!n ? 0 : n < 8 ? 1 : n < 15 ? 2 : n < 22 ? 3 : 4);
  const todayIso = todayISO();
  const dayLabels = ['Mo', '', 'Mi', '', 'Fr', '', ''];
  let html = `<div class="heatmap" style="--cell:${cell}px; grid-template-columns:${labelW}px">`;
  html += '<span></span>' + dayLabels.map((l) => `<span class="hm-label">${l}</span>`).join('');

  let lastMonth = -1;
  for (let wk = 0; wk < weeks; wk++) {
    const monday = addDays(start, wk * 7);
    const showMonth = monday.getMonth() !== lastMonth && (cell >= 14 || wk % 2 === 0 || wk === 0);
    html += `<span class="hm-month">${showMonth ? monday.toLocaleDateString('de-CH', { month: 'short' }) : ''}</span>`;
    if (showMonth) lastMonth = monday.getMonth();
    for (let d = 0; d < 7; d++) {
      const iso = toISODate(addDays(monday, d));
      const n = setsByDay[iso] || 0;
      const cls = iso > todayIso ? ' future' : iso === todayIso ? ' today' : '';
      const title = iso > todayIso ? '' : `${formatDate(iso, 'weekday')}: ${n ? n + ' Sätze' : 'kein Training'}`;
      html += `<span class="hm-cell${cls}" data-l="${level(n)}" title="${esc(title)}"></span>`;
    }
  }
  html += '</div>';
  wrap.innerHTML = html;
  wrap.scrollLeft = wrap.scrollWidth; // neueste Wochen sichtbar
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
    saveCache();
    setView('training');
  },

  'finish-workout': () => {
    const w = activeWorkout();
    state.meta.activeWorkoutId = null;
    if (w && w.entries.length === 0) {
      // Leere Trainings nicht aufbewahren
      state.data.workouts = state.data.workouts.filter((x) => x.id !== w.id);
      commit();
    } else {
      saveCache();
      if (w) toast('Training gespeichert');
    }
    render();
  },

  'delete-workout': (el) => {
    if (!confirm('Dieses Training wirklich löschen?')) return;
    state.data.workouts = state.data.workouts.filter((w) => w.id !== el.dataset.id);
    state.meta.activeWorkoutId = null;
    commit();
    toast('Training gelöscht');
    render();
  },

  'add-existing': (el) => {
    const w = activeWorkout();
    const ex = getExercise(el.dataset.id);
    if (!w || !ex) return;
    addEntry(w, ex);
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
    commit();
    render();
    focusField(`[data-field="set-reps"][data-entry="${CSS.escape(entry.id)}"][data-set="${entry.sets.length - 1}"]`);
  },

  'remove-set': (el) => {
    const entry = findEntry(el.dataset.entry);
    if (!entry) return;
    entry.sets.splice(Number(el.dataset.set), 1);
    commit();
    render();
  },

  'w-inc': (el) => stepWeight(el, +WEIGHT_STEP),
  'w-dec': (el) => stepWeight(el, -WEIGHT_STEP),

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
    if (!el || el.disabled) return;
    const fn = actions[el.dataset.action];
    if (fn) { e.preventDefault(); fn(el); }
  });

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
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = cssVar('--bg') || '#111214';
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
