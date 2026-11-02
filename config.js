/*
 * Gym-Tracker – Konfiguration
 *
 * Trage hier die Werte aus deinem Supabase-Projekt ein
 * (Supabase Dashboard → Project Settings → API / API Keys).
 * Solange die Platzhalter drinstehen, läuft die App nur lokal
 * im Browser und zeigt "Sync nicht eingerichtet".
 *
 * Der Key ist der öffentliche "anon"/"publishable" Key – NICHT der
 * "service_role"/"secret" Key. Der öffentliche Key darf im Code stehen.
 */
window.GYM_CONFIG = {
  supabaseUrl: 'DEINE_SUPABASE_URL',         // z.B. 'https://abcdefghijkl.supabase.co'
  supabaseAnonKey: 'DEIN_SUPABASE_ANON_KEY', // beginnt mit 'eyJ...' oder 'sb_publishable_...'
};
