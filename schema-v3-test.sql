-- =====================================================================
-- Gym-Tracker V3 – Testumgebung (Supabase)
-- Einmal im Supabase SQL Editor ausführen (New query → einfügen → Run).
-- Kann gefahrlos mehrmals ausgeführt werden. Ändert nichts an den echten Daten.
-- =====================================================================
--
-- Die Testumgebung (…/gym-tracker/test/) speichert in einer eigenen
-- Tabelle. Beim ersten Öffnen wird eine KOPIE deiner echten Daten angelegt.
-- Was du dort einträgst oder kaputt machst, betrifft den echten Tracker nie.
-- Nur Admins dürfen die Testumgebung benutzen.
-- =====================================================================

create table if not exists public.tracker_data_test (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.tracker_data_test enable row level security;
revoke all on table public.tracker_data_test from anon, authenticated;


-- Hilfsfunktion: nur Admins
create or replace function public.require_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_user();
begin
  if not public.is_admin() then
    raise exception 'not allowed';
  end if;
  return v_uid;
end;
$$;


-- Testdaten lesen. Gibt es noch keine, wird eine Kopie der echten Daten angelegt.
create or replace function public.get_my_test_data()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_admin();
begin
  if not exists (select 1 from public.tracker_data_test where user_id = v_uid) then
    insert into public.tracker_data_test (user_id, data, updated_at)
    select user_id, data, now() from public.tracker_data where user_id = v_uid
    on conflict (user_id) do nothing;
  end if;
  return (
    select jsonb_build_object('data', t.data, 'updated_at', t.updated_at)
    from public.tracker_data_test t
    where t.user_id = v_uid
  );
end;
$$;


-- Testdaten speichern (gleiche Prüfungen wie save_my_data)
create or replace function public.save_my_test_data(p_data jsonb)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_admin();
  v_ts  timestamptz;
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'invalid data';
  end if;
  if pg_column_size(p_data) > 5000000 then
    raise exception 'data too large';
  end if;

  insert into public.tracker_data_test (user_id, data, updated_at)
  values (v_uid, p_data, now())
  on conflict (user_id) do update
    set data = excluded.data,
        updated_at = now()
  returning updated_at into v_ts;

  return v_ts;
end;
$$;


-- Testdaten verwerfen und die echten Daten frisch kopieren
create or replace function public.reset_my_test_data()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_admin();
begin
  delete from public.tracker_data_test where user_id = v_uid;
  return public.get_my_test_data();
end;
$$;


-- Rechte
revoke all on function public.require_admin()              from public;
revoke all on function public.get_my_test_data()           from public;
revoke all on function public.save_my_test_data(jsonb)     from public;
revoke all on function public.reset_my_test_data()         from public;

grant execute on function public.get_my_test_data()        to authenticated;
grant execute on function public.save_my_test_data(jsonb)  to authenticated;
grant execute on function public.reset_my_test_data()      to authenticated;
