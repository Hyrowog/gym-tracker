-- =====================================================================
-- Gym-Tracker – V1 endgültig entfernen
-- ERST ausführen, wenn du in V2 eingeloggt bist und deine alten Daten
-- unter «Mehr → Daten aus Version 1» übernommen hast (und ein JSON-Backup
-- gemacht hast). Danach gibt es die V1-Daten nicht mehr.
-- =====================================================================
drop function if exists public.get_gym_data(text);
drop function if exists public.save_gym_data(text, jsonb);
drop table if exists public.gym_data;
