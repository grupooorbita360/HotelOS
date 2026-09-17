-- HotelOS — Fase 0 (Plataforma): guard de membresía en las funciones de
-- licencias/features de la migración 0039.
--
-- Problema: has_feature(), hotel_enabled_features() y hotel_limit_usage()
-- son SECURITY DEFINER y reciben p_hotel_id libre, sin validar que el
-- llamador pertenezca a ese hotel. Cualquier usuario autenticado podía
-- invocarlas por REST con el hotel_id de OTRO tenant y leer: features
-- encendidas, uso vs límites de licencia (habitaciones y usuarios). Las
-- RLS de las tablas sí estaban acotadas por membresía, pero estas
-- funciones se las saltan al ser SECURITY DEFINER y no reponer el check.
--
-- Corrección (no se edita 0039, ya aplicada):
--   1. assert_hotel_member(p_hotel_id): helper plpgsql compartido. Pasa si
--      el llamador es miembro activo del hotel o es platform_admin; si no,
--      PERMISSION_DENIED con errcode 42501. VOLATILE a propósito (default):
--      así Postgres garantiza ejecutarla y no la elide por optimización
--      aunque la invoquen funciones language sql.
--   2. Las tres funciones de 0039 se recrean idénticas (mismo contrato,
--      mismo security definer, mismo search_path) con una sola línea
--      nueva al inicio: select public.assert_hotel_member(p_hotel_id);
--
-- Casos legítimos preservados: un usuario normal consulta su propio hotel
-- (menú de navegación, límite al dar de alta habitación/personal) igual que
-- antes; platform_admin sigue pudiendo consultar cualquier hotel.

-- ── helper ──────────────────────────────────────────────────────────────
create or replace function public.assert_hotel_member(p_hotel_id uuid)
returns void
language plpgsql
set search_path = public
as $$
begin
  if not (
    p_hotel_id in (select public.user_hotel_ids())
    or public.is_platform_admin()
  ) then
    raise exception 'PERMISSION_DENIED: not a member of this hotel'
      using errcode = '42501';
  end if;
end;
$$;

comment on function public.assert_hotel_member(uuid) is
  'Lanza PERMISSION_DENIED (42501) si el llamador no es miembro activo del hotel ni platform_admin. Guard compartido de has_feature/hotel_enabled_features/hotel_limit_usage.';

grant execute on function public.assert_hotel_member(uuid) to authenticated;

-- ── has_feature (0039 + guard) ──────────────────────────────────────────
create or replace function public.has_feature(p_hotel_id uuid, p_feature_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.assert_hotel_member(p_hotel_id);
  select coalesce(
    (select o.enabled
       from public.hotel_feature_overrides o
      where o.hotel_id = p_hotel_id
        and o.feature_key = p_feature_key),
    (select pf.enabled
       from public.plan_features pf
       join public.hotels h on h.plan = pf.plan
      where h.id = p_hotel_id
        and pf.feature_key = p_feature_key),
    false
  );
$$;

comment on function public.has_feature(uuid, text) is
  'true si el hotel tiene la feature habilitada (override > plan). Usar en RLS y en server actions para gatear módulos. Sólo miembros del hotel o platform_admin.';

-- ── hotel_enabled_features (0039 + guard) ───────────────────────────────
create or replace function public.hotel_enabled_features(p_hotel_id uuid)
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select public.assert_hotel_member(p_hotel_id);
  select feature_key from (
    select pf.feature_key
      from public.plan_features pf
      join public.hotels h on h.plan = pf.plan
     where h.id = p_hotel_id and pf.enabled
    union
    select o.feature_key
      from public.hotel_feature_overrides o
     where o.hotel_id = p_hotel_id and o.enabled
    except
    select o.feature_key
      from public.hotel_feature_overrides o
     where o.hotel_id = p_hotel_id and not o.enabled
  ) enabled_features;
$$;

comment on function public.hotel_enabled_features(uuid) is
  'Features habilitadas para el hotel: unión de las del plan menos las apagadas por override, más las encendidas por override. Sólo miembros del hotel o platform_admin.';

-- ── hotel_limit_usage (0039 + guard) ────────────────────────────────────
create or replace function public.hotel_limit_usage(p_hotel_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select public.assert_hotel_member(p_hotel_id);
  select jsonb_build_object(
    'rooms_active', (select count(*) from public.rooms
                      where hotel_id = p_hotel_id and is_active),
    'rooms_max',    (select l.rooms_max from public.hotel_licenses l
                      where l.hotel_id = p_hotel_id),
    'users_active', (select count(distinct user_id) from public.user_hotel_roles
                      where hotel_id = p_hotel_id and is_active),
    'users_max',    (select l.users_max from public.hotel_licenses l
                      where l.hotel_id = p_hotel_id)
  );
$$;

comment on function public.hotel_limit_usage(uuid) is
  'Uso actual vs límites de licencia del hotel: {rooms_active, rooms_max, users_active, users_max}. NULL en un max = sin límite. Sólo miembros del hotel o platform_admin.';
