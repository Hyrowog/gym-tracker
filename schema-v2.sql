-- =====================================================================
-- Gym-Tracker V2 – Datenbank-Schema mit Konten (Supabase)
-- Einmal im Supabase SQL Editor ausführen (New query → einfügen → Run).
-- Das Skript kann gefahrlos mehrmals ausgeführt werden.
-- =====================================================================
--
-- Design:
--   * Login über Supabase Auth (E-Mail + Passwort).
--   * Registrieren geht nur mit gültigem Einladungscode. Das prüft die
--     Datenbank selbst (Trigger auf auth.users), nicht nur die Webseite.
--   * Pro Konto eine Zeile in tracker_data (Trainingsdaten als JSON,
--     gleiches Format wie V1).
--   * Die Tabellen sind für die App NICHT direkt lesbar (RLS an, keine
--     Policies). Die App greift nur über Funktionen zu, und jede Funktion
--     arbeitet mit auth.uid() = dem angemeldeten Konto. Fremde Daten kann
--     man so nicht lesen. Ausnahme: Admins dürfen alle Daten LESEN.
-- =====================================================================


-- ---------------------------------------------------------------------
-- Tabellen
-- ---------------------------------------------------------------------

-- Einstellungen (genau eine Zeile): aktueller Einladungscode
create table if not exists public.app_settings (
  id          int primary key default 1 check (id = 1),
  invite_code text not null
);
insert into public.app_settings (id, invite_code)
values (1, substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
on conflict (id) do nothing;

-- Wer Admin ist (nur lesen auf alle Konten)
create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);

-- Profil pro Konto (für die Admin-Liste)
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text not null,
  display_name text not null default '',
  created_at   timestamptz not null default now()
);

-- Trainingsdaten pro Konto
create table if not exists public.tracker_data (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

-- Direkter Zugriff für die App gesperrt (nur über die Funktionen unten)
alter table public.app_settings enable row level security;
alter table public.admins       enable row level security;
alter table public.profiles     enable row level security;
alter table public.tracker_data enable row level security;
revoke all on table public.app_settings, public.admins, public.profiles, public.tracker_data
  from anon, authenticated;


-- ---------------------------------------------------------------------
-- Hilfsfunktionen
-- ---------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

create or replace function public.require_user()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  return auth.uid();
end;
$$;


-- ---------------------------------------------------------------------
-- Registrierung: Einladungscode prüfen + Profil anlegen
-- ---------------------------------------------------------------------

-- Vorab-Prüfung für eine verständliche Fehlermeldung auf der Webseite
create or replace function public.check_invite(p_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.app_settings
    where id = 1 and p_code is not null and invite_code = p_code
  );
$$;

-- Die eigentliche Sperre: ohne gültigen Code wird kein Konto angelegt
create or replace function public.enforce_invite_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.check_invite(new.raw_user_meta_data ->> 'invite_code') then
    raise exception 'invalid invite code';
  end if;
  return new;
end;
$$;

drop trigger if exists gym_enforce_invite_code on auth.users;
create trigger gym_enforce_invite_code
  before insert on auth.users
  for each row execute function public.enforce_invite_code();

create or replace function public.create_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    coalesce(new.email, ''),
    left(coalesce(trim(new.raw_user_meta_data ->> 'name'), ''), 60)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists gym_create_profile on auth.users;
create trigger gym_create_profile
  after insert on auth.users
  for each row execute function public.create_profile();

-- E-Mail-Änderung im Profil nachführen
create or replace function public.sync_profile_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles set email = coalesce(new.email, '') where id = new.id;
  return new;
end;
$$;

drop trigger if exists gym_sync_profile_email on auth.users;
create trigger gym_sync_profile_email
  after update of email on auth.users
  for each row execute function public.sync_profile_email();


-- ---------------------------------------------------------------------
-- Eigenes Konto: Profil und Trainingsdaten
-- ---------------------------------------------------------------------
create or replace function public.get_my_profile()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_user();
  v_out jsonb;
begin
  select jsonb_build_object(
           'email', p.email,
           'display_name', p.display_name,
           'is_admin', public.is_admin())
    into v_out
  from public.profiles p
  where p.id = v_uid;

  -- Falls das Profil fehlt (z.B. Konto vor dem Schema erstellt): anlegen
  if v_out is null then
    insert into public.profiles (id, email)
    select id, coalesce(email, '') from auth.users where id = v_uid
    on conflict (id) do nothing;
    select jsonb_build_object('email', p.email, 'display_name', p.display_name, 'is_admin', public.is_admin())
      into v_out from public.profiles p where p.id = v_uid;
  end if;
  return v_out;
end;
$$;

create or replace function public.update_my_name(p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_user();
begin
  update public.profiles
     set display_name = left(coalesce(trim(p_name), ''), 60)
   where id = v_uid;
end;
$$;

create or replace function public.get_my_data()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('data', t.data, 'updated_at', t.updated_at)
  from public.tracker_data t
  where t.user_id = public.require_user();
$$;

create or replace function public.save_my_data(p_data jsonb)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_user();
  v_ts  timestamptz;
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'invalid data';
  end if;
  -- Schutz gegen Missbrauch: max. ca. 5 MB pro Konto
  if pg_column_size(p_data) > 5000000 then
    raise exception 'data too large';
  end if;

  insert into public.tracker_data (user_id, data, updated_at)
  values (v_uid, p_data, now())
  on conflict (user_id) do update
    set data = excluded.data,
        updated_at = now()
  returning updated_at into v_ts;

  return v_ts;
end;
$$;


-- ---------------------------------------------------------------------
-- Admin: alle Konten ansehen (nur lesen) und Einladungscode verwalten
-- ---------------------------------------------------------------------
create or replace function public.admin_list_users()
returns table (
  id           uuid,
  email        text,
  display_name text,
  created_at   timestamptz,
  workouts     int,
  last_workout text,
  updated_at   timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not allowed';
  end if;
  return query
    select p.id, p.email, p.display_name, p.created_at,
           coalesce(jsonb_array_length(t.data -> 'workouts'), 0)::int,
           (select max(w ->> 'date') from jsonb_array_elements(coalesce(t.data -> 'workouts', '[]'::jsonb)) w),
           t.updated_at
    from public.profiles p
    left join public.tracker_data t on t.user_id = p.id
    order by p.created_at;
end;
$$;

create or replace function public.admin_get_user_data(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_out jsonb;
begin
  if not public.is_admin() then
    raise exception 'not allowed';
  end if;
  select jsonb_build_object('data', t.data, 'updated_at', t.updated_at)
    into v_out
  from public.tracker_data t
  where t.user_id = p_user;
  return v_out;
end;
$$;

create or replace function public.admin_get_invite_code()
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not allowed';
  end if;
  return (select invite_code from public.app_settings where id = 1);
end;
$$;

-- p_code leer/null → neuer Zufallscode. Der alte Einladungslink gilt danach nicht mehr.
create or replace function public.admin_set_invite_code(p_code text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := nullif(trim(coalesce(p_code, '')), '');
begin
  if not public.is_admin() then
    raise exception 'not allowed';
  end if;
  if v_code is null then
    v_code := substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
  elsif v_code !~ '^[A-Za-z0-9_-]{6,64}$' then
    raise exception 'invalid code';
  end if;
  update public.app_settings set invite_code = v_code where id = 1;
  return v_code;
end;
$$;


-- ---------------------------------------------------------------------
-- Übernahme der Daten aus V1 (geheimer Link ?k=...)
-- Kopiert die V1-Daten ins angemeldete Konto und löscht den V1-Eintrag.
-- Funktioniert nur, wenn die V1-Tabelle gym_data existiert.
-- ---------------------------------------------------------------------
create or replace function public.claim_v1_data(p_secret text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := public.require_user();
  v_data jsonb;
begin
  if to_regclass('public.gym_data') is null then
    raise exception 'v1 not found';
  end if;
  if p_secret is null or char_length(p_secret) < 20 then
    raise exception 'v1 not found';
  end if;

  execute 'select data from public.gym_data where secret = $1' into v_data using p_secret;
  if v_data is null then
    raise exception 'v1 not found';
  end if;

  insert into public.tracker_data (user_id, data, updated_at)
  values (v_uid, v_data, now())
  on conflict (user_id) do update set data = excluded.data, updated_at = now();

  execute 'delete from public.gym_data where secret = $1' using p_secret;

  return jsonb_build_object('data', v_data, 'updated_at', now());
end;
$$;


-- ---------------------------------------------------------------------
-- Rechte: was die App aufrufen darf
-- ---------------------------------------------------------------------
revoke all on function public.is_admin()                    from public;
revoke all on function public.require_user()                from public;
revoke all on function public.check_invite(text)            from public;
revoke all on function public.enforce_invite_code()         from public;
revoke all on function public.create_profile()              from public;
revoke all on function public.sync_profile_email()          from public;
revoke all on function public.get_my_profile()              from public;
revoke all on function public.update_my_name(text)          from public;
revoke all on function public.get_my_data()                 from public;
revoke all on function public.save_my_data(jsonb)           from public;
revoke all on function public.admin_list_users()            from public;
revoke all on function public.admin_get_user_data(uuid)     from public;
revoke all on function public.admin_get_invite_code()       from public;
revoke all on function public.admin_set_invite_code(text)   from public;
revoke all on function public.claim_v1_data(text)           from public;

-- Vor dem Login (Registrierung): nur Code prüfen
grant execute on function public.check_invite(text) to anon, authenticated;
-- Nach dem Login
grant execute on function public.get_my_profile()            to authenticated;
grant execute on function public.update_my_name(text)        to authenticated;
grant execute on function public.get_my_data()               to authenticated;
grant execute on function public.save_my_data(jsonb)         to authenticated;
grant execute on function public.admin_list_users()          to authenticated;
grant execute on function public.admin_get_user_data(uuid)   to authenticated;
grant execute on function public.admin_get_invite_code()     to authenticated;
grant execute on function public.admin_set_invite_code(text) to authenticated;
grant execute on function public.claim_v1_data(text)         to authenticated;


-- ---------------------------------------------------------------------
-- V1-Link abschalten: der alte Zugang über ?k=... funktioniert ab jetzt
-- nicht mehr. Die V1-Daten bleiben in gym_data, bis sie übernommen sind.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.get_gym_data(text)') is not null then
    revoke execute on function public.get_gym_data(text) from anon, authenticated;
  end if;
  if to_regprocedure('public.save_gym_data(text, jsonb)') is not null then
    revoke execute on function public.save_gym_data(text, jsonb) from anon, authenticated;
  end if;
end;
$$;
