-- =====================================================================
-- Gym-Tracker – Datenbank-Schema für Supabase
-- Einmal im Supabase SQL Editor ausführen (New query → einfügen → Run).
-- Das Skript kann gefahrlos mehrmals ausgeführt werden.
-- =====================================================================
--
-- Design:
--   * Eine Tabelle, eine Zeile pro Tracker. Die Zeile wird über einen
--     langen, zufälligen Schlüssel ("secret") aus dem Link gefunden.
--   * Die Tabelle selbst ist für die App NICHT direkt lesbar (RLS an,
--     keine Policies). Die App greift nur über zwei Funktionen zu:
--       get_gym_data(secret)        → liefert die Daten zu genau diesem Schlüssel
--       save_gym_data(secret, data) → speichert die Daten zu genau diesem Schlüssel
--   * Vorteil gegenüber direkten Tabellen-Policies: Niemand kann mit dem
--     öffentlichen Key alle Zeilen auflisten. Man muss den Schlüssel kennen.

create table if not exists public.gym_data (
  secret     text primary key check (char_length(secret) >= 20),
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

-- Row Level Security einschalten, ohne Policies:
-- direkter Zugriff auf die Tabelle ist damit für anon/authenticated gesperrt.
alter table public.gym_data enable row level security;
revoke all on table public.gym_data from anon, authenticated;

-- ---------------------------------------------------------------------
-- Daten lesen: gibt {"data": ..., "updated_at": ...} oder null zurück
-- ---------------------------------------------------------------------
create or replace function public.get_gym_data(p_secret text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('data', g.data, 'updated_at', g.updated_at)
  from public.gym_data g
  where g.secret = p_secret
    and char_length(p_secret) >= 20;
$$;

-- ---------------------------------------------------------------------
-- Daten speichern (anlegen oder überschreiben, "last write wins")
-- ---------------------------------------------------------------------
create or replace function public.save_gym_data(p_secret text, p_data jsonb)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ts timestamptz;
begin
  if p_secret is null or char_length(p_secret) < 20 then
    raise exception 'secret too short';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'invalid data';
  end if;
  -- Schutz gegen Missbrauch: max. ca. 5 MB pro Tracker
  if pg_column_size(p_data) > 5000000 then
    raise exception 'data too large';
  end if;

  insert into public.gym_data (secret, data, updated_at)
  values (p_secret, p_data, now())
  on conflict (secret) do update
    set data = excluded.data,
        updated_at = now()
  returning updated_at into v_ts;

  return v_ts;
end;
$$;

-- Nur diese zwei Funktionen dürfen von der App (Rolle anon) aufgerufen werden.
revoke all on function public.get_gym_data(text) from public;
revoke all on function public.save_gym_data(text, jsonb) from public;
grant execute on function public.get_gym_data(text) to anon, authenticated;
grant execute on function public.save_gym_data(text, jsonb) to anon, authenticated;
