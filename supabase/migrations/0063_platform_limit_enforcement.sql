-- HotelOS — Plataforma: enforcement de límites de licencia EN LA BASE DE DATOS.
--
-- Contexto (revisión de auditoría externa, secciones 16–17 y hallazgo de
-- concurrencia): hoy los límites se chequean en el servidor vía
-- hotel_limit_usage() ANTES de insertar. Eso es correcto como UX, pero no
-- cierra la race condition: dos altas concurrentes de habitación leen el
-- mismo uso (15/16), ambas pasan, y el hotel queda con 17/16. La regla de
-- negocio "nunca bloquear datos existentes, solo bloquear lo nuevo" debe
-- vivir en la BD, no en el cliente ni en la API.
--
-- Decisión: triggers BEFORE INSERT OR UPDATE OF is_active que:
--   1. Toman un advisory lock por hotel (pg_advisory_xact_lock) para
--      serializar altas concurrentes del mismo hotel. El lock es de
--      transacción: se libera al commit/rollback, sin tabla extra.
--   2. Cuentan lo activo EXISTENTE y rechazan solo si excede el máximo.
--      Nada se borra ni se desactiva: lo ya operando sigue operando.
--   3. NULL en el máximo = sin límite (igual que 0039).
--   4. Plataforma (is_platform_admin) tiene bypass: Órbita 360 puede arreglar
--      datos de un hotel sin mover límites a mano.
--
-- El error sube con código estable (ROOMS_LIMIT_EXCEEDED /
-- USERS_LIMIT_EXCEEDED) y mensaje legible; la app lo atrapa y lo muestra
-- tal cual ("Tu plan permite máximo 16 habitaciones").

-- ── habitaciones ─────────────────────────────────────────────────────────
create or replace function public.assert_room_plan_limit()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_max integer;
  v_active integer;
begin
  -- Bypass plataforma: mantenimiento de datos no se frena por el plan.
  if public.is_platform_admin() then
    return new;
  end if;

  -- Solo importa al ACTIVAR una habitación. Update que no cambia nada
  -- (ya activa o desactivándose) no consume cupo.
  if tg_op = 'UPDATE' and (old.is_active or not new.is_active) then
    return new;
  end if;
  if not new.is_active then
    return new;
  end if;

  select l.rooms_max into v_max
    from public.hotel_licenses l
   where l.hotel_id = new.hotel_id;

  if v_max is null then
    return new; -- sin límite
  end if;

  -- Serializar altas por hotel: la segunda transacción concurrente espera
  -- a que la primera haga commit y entonces ve el count ya incrementado.
  perform pg_advisory_xact_lock(hashtext(new.hotel_id::text));

  select count(*) into v_active
    from public.rooms
   where hotel_id = new.hotel_id and is_active;

  if v_active + 1 > v_max then
    raise exception 'ROOMS_LIMIT_EXCEEDED: Tu plan permite máximo % habitaciones. Actualiza tu plan o desactiva habitaciones para crear más.', v_max
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.assert_room_plan_limit() is
  'Trigger guard: bloquea activar/insertar habitación que exceda rooms_max de la licencia. No toca lo existente. Bypass para platform_admin.';

create trigger trg_rooms_plan_limit
  before insert or update of is_active on public.rooms
  for each row execute function public.assert_room_plan_limit();

-- ── usuarios ─────────────────────────────────────────────────────────────
create or replace function public.assert_user_plan_limit_trigger()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_max integer;
  v_active integer;
  v_already_member boolean;
begin
  if public.is_platform_admin() then
    return new;
  end if;

  -- Solo importa al ACTIVAR una membresía.
  if tg_op = 'UPDATE' and (old.is_active or not new.is_active) then
    return new;
  end if;
  if not new.is_active then
    return new;
  end if;

  select l.users_max into v_max
    from public.hotel_licenses l
   where l.hotel_id = new.hotel_id;

  if v_max is null then
    return new;
  end if;

  -- Si el usuario ya era miembro activo (p.ej. tenía otro rol en el mismo
  -- hotel), reactivar/duplicar no consume cupo extra.
  select exists (
    select 1 from public.user_hotel_roles
     where hotel_id = new.hotel_id
       and user_id = new.user_id
       and is_active
  ) into v_already_member;

  if v_already_member then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext(new.hotel_id::text));

  select count(distinct user_id) into v_active
    from public.user_hotel_roles
   where hotel_id = new.hotel_id and is_active;

  if v_active + 1 > v_max then
    raise exception 'USERS_LIMIT_EXCEEDED: Tu plan permite máximo % usuarios. Actualiza tu plan o desactiva usuarios para invitar más.', v_max
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.assert_user_plan_limit_trigger() is
  'Trigger guard: bloquea activar/insertar membresía que exceda users_max de la licencia. Un mismo usuario con varios roles cuenta una sola vez. Bypass para platform_admin.';

create trigger trg_user_hotel_roles_plan_limit
  before insert or update of is_active on public.user_hotel_roles
  for each row execute function public.assert_user_plan_limit_trigger();
