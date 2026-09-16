-- HotelOS — Fase 0 (Plataforma): licencias, límites de plan y feature flags.
--
-- Decisión de modelo (ver CLAUDE.md, sección "Plataforma: licencias y features"):
--   * El plan y el status comercial del hotel YA viven en public.hotels
--     (columns plan/status desde 0002). Eso no se duplica.
--   * hotel_licenses guarda lo que el plan implica: límites (rooms_max,
--     users_max) y vigencia (starts_at/expires_at). NULL en un límite =
--     sin límite (los hoteles existentes quedan "grandfathered" con NULL).
--   * plan_features es el catálogo plan -> feature habilitada. Nunca un
--     condicional en código con strings sueltos: has_feature() lo consulta.
--   * hotel_feature_overrides permite a plataforma encender/apagar una
--     feature puntual para un hotel (override gana sobre el plan).
--
-- Suspensión de hotel: hotels.status = 'suspended' + desactivación de las
-- membresías (user_hotel_roles.is_active = false marcadas con
-- deactivated_by_suspension). Así el bloqueo queda enforcementado por RLS
-- (user_hotel_ids() queda vacío => todo lo demás queda denegado), no sólo
-- por la interfaz. La reactivación sólo reactiva las filas marcadas.

-- ── hotel_licenses ──────────────────────────────────────────────────────
create table public.hotel_licenses (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null unique references public.hotels (id) on delete cascade,

  -- NULL = sin límite. Se aplican en los puntos de alta (habitación,
  -- personal) vía hotel_limit_usage(), nunca como un chequeo en el cliente.
  rooms_max integer check (rooms_max is null or rooms_max > 0),
  users_max integer check (users_max is null or users_max > 0),

  starts_at timestamptz not null default now(),
  expires_at timestamptz, -- NULL = sin vencimiento
  notes text,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);

comment on table public.hotel_licenses is
  'Licencia operativa del hotel: límites de plan y vigencia. El plan/status comercial vive en hotels; esto es lo que el plan implica.';

create trigger trg_hotel_licenses_audit
  before insert or update on public.hotel_licenses
  for each row execute function public.set_audit_fields();

alter table public.hotel_licenses enable row level security;

-- Hoteles existentes: licencia sin límites ni vencimiento. No se rompe nada
-- de lo ya operando; los límites empiezan a aplicar a hoteles nuevos o cuando
-- plataforma los configure explícitamente.
insert into public.hotel_licenses (hotel_id, rooms_max, users_max)
select id, null, null from public.hotels
on conflict (hotel_id) do nothing;

-- ── marcador de suspensión en membresías ────────────────────────────────
alter table public.user_hotel_roles
  add column deactivated_by_suspension boolean not null default false;

comment on column public.user_hotel_roles.deactivated_by_suspension is
  'true sólo cuando la desactivación la hizo la suspensión del hotel (ver 0039). La reactivación del hotel sólo reactiva filas con este marcador, para no resucitar membresías que el hotel desactivó a propósito.';

-- ── plan_features (catálogo) ────────────────────────────────────────────
create table public.plan_features (
  feature_key text not null,
  plan text not null check (plan in ('basico', 'plus', 'pro')),
  enabled boolean not null default false,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),

  primary key (feature_key, plan)
);

comment on table public.plan_features is
  'Catálogo plan -> feature. Un cambio de qué incluye cada plan es un UPDATE aquí, nunca un deploy.';

create trigger trg_plan_features_audit
  before insert or update on public.plan_features
  for each row execute function public.set_audit_fields();

alter table public.plan_features enable row level security;

-- Catálogo inicial. Los módulos construidos hoy están en todos los planes
-- (el hotel piloto es 'basico' y debe seguir operando igual); las features
-- futuras diferencian los planes. 'module.mi_hotel_hoy' se habilita en todos
-- los planes desde su lanzamiento (es la pantalla que vende); la
-- diferenciación comercial de planes se ajusta después con datos reales.
insert into public.plan_features (feature_key, plan, enabled) values
  ('module.reservaciones',  'basico', true),
  ('module.recepcion',      'basico', true),
  ('module.rack',           'basico', true),
  ('module.configuracion',  'basico', true),
  ('module.mi_hotel_hoy',   'basico', true),
  ('module.caja',           'basico', false),
  ('module.housekeeping',   'basico', false),
  ('module.mantenimiento',  'basico', false),
  ('module.crm',            'basico', false),
  ('module.tarifas',        'basico', false),
  ('module.radar_360',      'basico', false),

  ('module.reservaciones',  'plus', true),
  ('module.recepcion',      'plus', true),
  ('module.rack',           'plus', true),
  ('module.configuracion',  'plus', true),
  ('module.mi_hotel_hoy',   'plus', true),
  ('module.caja',           'plus', true),
  ('module.housekeeping',   'plus', true),
  ('module.mantenimiento',  'plus', false),
  ('module.crm',            'plus', false),
  ('module.tarifas',        'plus', true),
  ('module.radar_360',      'plus', false),

  ('module.reservaciones',  'pro', true),
  ('module.recepcion',      'pro', true),
  ('module.rack',           'pro', true),
  ('module.configuracion',  'pro', true),
  ('module.mi_hotel_hoy',   'pro', true),
  ('module.caja',           'pro', true),
  ('module.housekeeping',   'pro', true),
  ('module.mantenimiento',  'pro', true),
  ('module.crm',            'pro', true),
  ('module.tarifas',        'pro', true),
  ('module.radar_360',      'pro', true)
on conflict (feature_key, plan) do nothing;

-- ── hotel_feature_overrides ─────────────────────────────────────────────
create table public.hotel_feature_overrides (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  feature_key text not null,
  enabled boolean not null,
  reason text, -- por qué plataforma se salta el plan para este hotel

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),

  unique (hotel_id, feature_key)
);

comment on table public.hotel_feature_overrides is
  'Override puntual de una feature para un hotel (gana sobre plan_features). Sólo plataforma lo escribe.';

create trigger trg_hotel_feature_overrides_audit
  before insert or update on public.hotel_feature_overrides
  for each row execute function public.set_audit_fields();

alter table public.hotel_feature_overrides enable row level security;

-- ── funciones ───────────────────────────────────────────────────────────
-- has_feature: override del hotel gana; si no hay override, lo dice el plan;
-- default false (fail-closed: una feature desconocida está apagada).
create or replace function public.has_feature(p_hotel_id uuid, p_feature_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
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
  'true si el hotel tiene la feature habilitada (override > plan). Usar en RLS y en server actions para gatear módulos.';

-- hotel_enabled_features: todas las features activas de un hotel, para no
-- hacer N llamadas a has_feature() al armar el menú de navegación.
create or replace function public.hotel_enabled_features(p_hotel_id uuid)
returns setof text
language sql
stable
security definer
set search_path = public
as $$
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
  'Features habilitadas para el hotel: unión de las del plan menos las apagadas por override, más las encendidas por override.';

-- hotel_limit_usage: uso actual vs límites de la licencia. Se consulta en
-- los puntos de alta (habitación, personal) ANTES de insertar.
create or replace function public.hotel_limit_usage(p_hotel_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
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
  'Uso actual vs límites de licencia del hotel: {rooms_active, rooms_max, users_active, users_max}. NULL en un max = sin límite.';

-- user_has_suspended_membership: se usa en el login para distinguir "no
-- tengo hotel" de "mi hotel está suspendido" y mandar a la pantalla correcta.
create or replace function public.user_has_suspended_membership()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.user_hotel_roles uhr
      join public.hotels h on h.id = uhr.hotel_id
     where uhr.user_id = auth.uid()
       and h.status in ('suspended', 'canceled')
  );
$$;

comment on function public.user_has_suspended_membership() is
  'true si el usuario tiene (o tuvo) membresía en un hotel suspendido/cancelado. Usado en login para mostrar la pantalla de suspensión en vez del "sin hotel".';

grant execute on function public.has_feature(uuid, text) to authenticated;
grant execute on function public.hotel_enabled_features(uuid) to authenticated;
grant execute on function public.hotel_limit_usage(uuid) to authenticated;
grant execute on function public.user_has_suspended_membership() to authenticated;

-- ── RLS ─────────────────────────────────────────────────────────────────
-- hotel_licenses: el hotel la lee (sus límites no son secreto: ya salen en
-- los mensajes de error al dar de alta habitaciones/personal); escribir
-- sólo plataforma. Sin DELETE: la licencia se mantiene siempre.
create policy "hotel_licenses_select_member_or_platform_admin"
  on public.hotel_licenses for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());

create policy "hotel_licenses_insert_platform_admin_only"
  on public.hotel_licenses for insert
  to authenticated
  with check (public.is_platform_admin());

create policy "hotel_licenses_update_platform_admin_only"
  on public.hotel_licenses for update
  to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

-- plan_features: catálogo legible por cualquier usuario autenticado (el menú
-- lo consulta); escribir sólo plataforma.
create policy "plan_features_select_authenticated"
  on public.plan_features for select
  to authenticated
  using (true);

create policy "plan_features_insert_platform_admin_only"
  on public.plan_features for insert
  to authenticated
  with check (public.is_platform_admin());

create policy "plan_features_update_platform_admin_only"
  on public.plan_features for update
  to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

-- hotel_feature_overrides: igual que licencias (el hotel puede ver sus
-- overrides; escribir sólo plataforma).
create policy "hotel_feature_overrides_select_member_or_platform_admin"
  on public.hotel_feature_overrides for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());

create policy "hotel_feature_overrides_insert_platform_admin_only"
  on public.hotel_feature_overrides for insert
  to authenticated
  with check (public.is_platform_admin());

create policy "hotel_feature_overrides_update_platform_admin_only"
  on public.hotel_feature_overrides for update
  to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

-- DELETE sólo para quitar un override (volver al comportamiento del plan).
-- Es la única tabla del proyecto con política de DELETE: un override es
-- configuración derivada, no dato de negocio, y "quitarlo" es su forma
-- natural de deshacerse (las tablas operativas siguen sin DELETE).
create policy "hotel_feature_overrides_delete_platform_admin_only"
  on public.hotel_feature_overrides for delete
  to authenticated
  using (public.is_platform_admin());
