-- HotelOS / Habitaciones (Módulo 06): completa el dominio que Rack,
-- Reservaciones y Recepción ya consumen parcialmente vía room_types/rooms.
--
-- Auditoría previa (contra el esquema real, no supuesto): room_types ya
-- tiene name/code/capacity_adults/capacity_children/accepts_pets/base_rate
-- (0010, 0029); rooms ya tiene code/room_type_id/is_clean/building/bed_type
-- (0010, 0021, 0029). Ningún campo de esta migración duplica lo anterior:
-- "zona" ya existe como rooms.building, así que del pedido original sólo
-- "piso" es realmente nuevo. capacity_adults/capacity_children/accepts_pets
-- NO se renombran ni se borran (Reservaciones -- availability.ts,
-- confirm.ts -- los lee hoy; tocar eso está fuera de alcance de esta
-- sesión): esta migración es puramente aditiva, mismo patrón que
-- 0029/0033/0034. Los campos explícitos que pide esta tarea
-- (base_adults/max_adults/max_children/max_pets) se agregan como columnas
-- nuevas, backfilleadas desde las existentes para arrancar consistentes;
-- reconciliarlos con Reservaciones (que hoy sólo conoce
-- capacity_adults/capacity_children/accepts_pets) es evolución futura, no
-- de esta tarea -- igual que base_rate (0029) estuvo "sin conectar" varias
-- sesiones hasta que Reservaciones lo necesitó de verdad.
--
-- Nota sobre dos referencias que la tarea asumía y no existen en el
-- código real (verificado por grep antes de escribir esto, no adivinado):
--   1) No hay un catálogo normalizado de activos ("CAT_ACTIVOS_ENTREGA")
--      con id propio -- lo que existe es hotel_policies.checkin_assets
--      (jsonb, catálogo de nombres) y delivered_assets.asset_name (texto
--      libre contra ese catálogo, sin FK -- ver 0025). TipoHabitacionActivo/
--      excepciones de activo por habitación aquí siguen exactamente ese
--      mismo patrón (asset_name text, sin FK a una tabla que no existe),
--      en vez de inventar una tabla de catálogo nueva que duplicaría
--      hotel_policies.checkin_assets.
--   2) No existe una tabla genérica "HistorialCambio" en el proyecto. La
--      auditoría de negocio existente es public.timeline_events (ver
--      CLAUDE.md, patrón transversal) -- se usa esa para registrar
--      reclasificación de tipo/desactivación, no se crea una tabla nueva.

-- ============================================================
-- 1) room_types: capacidad explícita + campos comerciales (aditivo)
-- ============================================================
alter table public.room_types add column description text;
alter table public.room_types add column orden_comercial integer not null default 0;
alter table public.room_types add column photos text[] not null default '{}'::text[];

alter table public.room_types add column base_adults integer;
update public.room_types set base_adults = 1;
alter table public.room_types alter column base_adults set not null;
alter table public.room_types add constraint room_types_base_adults_check check (base_adults >= 1);

alter table public.room_types add column max_adults integer;
update public.room_types set max_adults = capacity_adults;
alter table public.room_types alter column max_adults set not null;
alter table public.room_types add constraint room_types_max_adults_check check (max_adults >= 1);

alter table public.room_types add column max_children integer;
update public.room_types set max_children = capacity_children;
alter table public.room_types alter column max_children set not null;
alter table public.room_types add constraint room_types_max_children_check check (max_children >= 0);

alter table public.room_types add column max_pets integer;
update public.room_types set max_pets = case when accepts_pets then 1 else 0 end;
alter table public.room_types alter column max_pets set not null;
alter table public.room_types add constraint room_types_max_pets_check check (max_pets >= 0);

comment on column public.room_types.base_adults is
  'Adultos incluidos en la tarifa base (antes de cargo por persona extra). Concepto nuevo -- ningún cálculo lo usa todavía (motor de tarifas es evolución futura).';
comment on column public.room_types.max_adults is
  'Capacidad máxima explícita de adultos. Backfilleada desde capacity_adults al crear esta columna; Reservaciones sigue leyendo capacity_adults hoy (reconciliar es evolución futura, no de esta migración).';
comment on column public.room_types.max_children is
  'Igual que max_adults pero para niños -- backfilleada desde capacity_children.';
comment on column public.room_types.max_pets is
  'Cupo explícito de mascotas (antes sólo accepts_pets boolean). Backfilleada: accepts_pets=true -> 1, false -> 0.';

-- ============================================================
-- 2) rooms: piso + desactivación con motivo obligatorio + fotos (aditivo)
-- ============================================================
alter table public.rooms add column floor text;
alter table public.rooms add column motivo_inactivacion text;
alter table public.rooms add column inactive_at timestamptz;
alter table public.rooms add column inactive_by uuid references auth.users (id);
alter table public.rooms add column photos text[] not null default '{}'::text[];

comment on column public.rooms.floor is
  'Piso, texto libre (igual que building/zona, 0029) -- sin catálogo cerrado, es evolución futura.';
comment on column public.rooms.motivo_inactivacion is
  'Obligatorio al desactivar -- lo fija deactivate_room() (abajo), nunca se escribe a mano. NULL mientras la habitación esté activa.';

-- ============================================================
-- 3) Catálogo de amenidades + herencia con excepción (3 estados)
-- ============================================================
-- HEREDA = no hay fila de excepción para esa habitación (toma lo del
-- tipo). AGREGA/EXCLUYE = fila explícita en *_excepcion. La resolución
-- (tipo + excepciones) vive en TypeScript (resolveRoomAmenities()), nunca
-- en una vista materializada -- MVP simple, sin infraestructura nueva.
create table public.catalogo_amenidades (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  name text not null,
  es_promesa_comercial boolean not null default false,
  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),

  unique (hotel_id, name)
);

comment on table public.catalogo_amenidades is
  'Catálogo de amenidades por hotel. es_promesa_comercial determina cuáles se congelan en snapshot_comercial_habitacion al confirmar una reserva.';

create trigger trg_catalogo_amenidades_audit
  before insert or update on public.catalogo_amenidades
  for each row execute function public.set_audit_fields();

create table public.tipo_habitacion_amenidad (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  room_type_id uuid not null references public.room_types (id) on delete cascade,
  amenidad_id uuid not null references public.catalogo_amenidades (id) on delete cascade,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),

  unique (room_type_id, amenidad_id)
);

comment on table public.tipo_habitacion_amenidad is
  'Amenidades base de un TipoHabitacion (el "HEREDA" por defecto de cualquier Habitacion de ese tipo).';

create trigger trg_tipo_habitacion_amenidad_audit
  before insert or update on public.tipo_habitacion_amenidad
  for each row execute function public.set_audit_fields();

create table public.habitacion_amenidad_excepcion (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  amenidad_id uuid not null references public.catalogo_amenidades (id) on delete cascade,
  tipo_excepcion text not null check (tipo_excepcion in ('AGREGA', 'EXCLUYE')),

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),

  unique (room_id, amenidad_id)
);

comment on table public.habitacion_amenidad_excepcion is
  'Excepción de una Habitacion concreta sobre las amenidades de su TipoHabitacion. AGREGA = esta habitación tiene algo que el tipo no tiene; EXCLUYE = esta habitación NO tiene algo que el tipo sí tiene. Sin fila = HEREDA.';

create trigger trg_habitacion_amenidad_excepcion_audit
  before insert or update on public.habitacion_amenidad_excepcion
  for each row execute function public.set_audit_fields();

-- ============================================================
-- 4) Activos a nivel TipoHabitacion + excepción por Habitacion
-- ============================================================
-- Mismo patrón que delivered_assets (0025): asset_name es texto libre
-- contra hotel_policies.checkin_assets, sin FK -- no existe una tabla de
-- catálogo normalizada de activos en este proyecto (ver nota al inicio).
create table public.tipo_habitacion_activo (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  room_type_id uuid not null references public.room_types (id) on delete cascade,
  asset_name text not null,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),

  unique (room_type_id, asset_name)
);

comment on table public.tipo_habitacion_activo is
  'Activos base de un TipoHabitacion (mismo catálogo de nombres que hotel_policies.checkin_assets -- sin tabla de catálogo normalizada, igual que delivered_assets desde 0025).';

create trigger trg_tipo_habitacion_activo_audit
  before insert or update on public.tipo_habitacion_activo
  for each row execute function public.set_audit_fields();

create table public.habitacion_activo_excepcion (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  asset_name text not null,
  tipo_excepcion text not null check (tipo_excepcion in ('AGREGA', 'EXCLUYE')),

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),

  unique (room_id, asset_name)
);

comment on table public.habitacion_activo_excepcion is
  'Misma herencia con excepción que habitacion_amenidad_excepcion, para activos entregables (nombres, no FK -- ver nota al inicio de esta migración).';

create trigger trg_habitacion_activo_excepcion_audit
  before insert or update on public.habitacion_activo_excepcion
  for each row execute function public.set_audit_fields();

-- ============================================================
-- 5) SnapshotComercialHabitacion: una vez por reserva, al confirmarse
-- ============================================================
create table public.snapshot_comercial_habitacion (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  reservation_id uuid not null references public.reservations (id) on delete cascade,
  room_type_id uuid not null references public.room_types (id),
  -- room_id nullable a propósito: al confirmarse una reserva todavía no
  -- hay habitación física asignada (reservation_stays.room_id nunca se
  -- escribe hoy -- ver CLAUDE.md, sección Rack). Se congela lo comercial
  -- (tipo), lo físico es Recepción.
  room_id uuid references public.rooms (id),

  base_adults integer not null,
  max_adults integer not null,
  max_children integer not null,
  max_pets integer not null,

  -- Snapshot compacto (spec: "JSON compacto, no tabla normalizada") --
  -- sólo amenidades con es_promesa_comercial=true al momento de confirmar.
  amenidades_prometidas jsonb not null default '[]'::jsonb,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),

  unique (reservation_id)
);

comment on table public.snapshot_comercial_habitacion is
  'Congelamiento comercial de una reserva al confirmarse (una fila por reserva, no por noche). Inmutable -- sin trigger de auditoría de update porque no se actualiza nunca (igual que quotes/quote_options).';

-- ============================================================
-- RLS
-- ============================================================
alter table public.catalogo_amenidades enable row level security;
alter table public.tipo_habitacion_amenidad enable row level security;
alter table public.habitacion_amenidad_excepcion enable row level security;
alter table public.tipo_habitacion_activo enable row level security;
alter table public.habitacion_activo_excepcion enable row level security;
alter table public.snapshot_comercial_habitacion enable row level security;

-- Catálogo y asignaciones/excepciones: mismo permiso que ya gobierna
-- room_types/rooms (hotel.settings.manage, 0010) -- es configuración del
-- catálogo de habitaciones, no una operación distinta.
create policy "catalogo_amenidades_select_member_or_platform_admin"
  on public.catalogo_amenidades for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());
create policy "catalogo_amenidades_write_settings_manager_or_platform_admin"
  on public.catalogo_amenidades for all
  to authenticated
  using (public.is_platform_admin() or public.has_permission(hotel_id, 'hotel.settings.manage'))
  with check (public.is_platform_admin() or public.has_permission(hotel_id, 'hotel.settings.manage'));

create policy "tipo_habitacion_amenidad_select_member_or_platform_admin"
  on public.tipo_habitacion_amenidad for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());
create policy "tipo_habitacion_amenidad_write_settings_manager_or_platform_admin"
  on public.tipo_habitacion_amenidad for all
  to authenticated
  using (public.is_platform_admin() or public.has_permission(hotel_id, 'hotel.settings.manage'))
  with check (public.is_platform_admin() or public.has_permission(hotel_id, 'hotel.settings.manage'));

create policy "habitacion_amenidad_excepcion_select_member_or_platform_admin"
  on public.habitacion_amenidad_excepcion for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());
create policy "habitacion_amenidad_excepcion_write_settings_manager_or_platform_admin"
  on public.habitacion_amenidad_excepcion for all
  to authenticated
  using (public.is_platform_admin() or public.has_permission(hotel_id, 'hotel.settings.manage'))
  with check (public.is_platform_admin() or public.has_permission(hotel_id, 'hotel.settings.manage'));

create policy "tipo_habitacion_activo_select_member_or_platform_admin"
  on public.tipo_habitacion_activo for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());
create policy "tipo_habitacion_activo_write_settings_manager_or_platform_admin"
  on public.tipo_habitacion_activo for all
  to authenticated
  using (public.is_platform_admin() or public.has_permission(hotel_id, 'hotel.settings.manage'))
  with check (public.is_platform_admin() or public.has_permission(hotel_id, 'hotel.settings.manage'));

create policy "habitacion_activo_excepcion_select_member_or_platform_admin"
  on public.habitacion_activo_excepcion for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());
create policy "habitacion_activo_excepcion_write_settings_manager_or_platform_admin"
  on public.habitacion_activo_excepcion for all
  to authenticated
  using (public.is_platform_admin() or public.has_permission(hotel_id, 'hotel.settings.manage'))
  with check (public.is_platform_admin() or public.has_permission(hotel_id, 'hotel.settings.manage'));

-- snapshot_comercial_habitacion: sólo lectura por membresía; sin
-- INSERT/UPDATE/DELETE de cliente -- el único camino de escritura es
-- congelar_configuracion_comercial() (SECURITY DEFINER, abajo), mismo
-- patrón que hotel_priorities/inventory_blocks.
create policy "snapshot_comercial_habitacion_select_member_or_platform_admin"
  on public.snapshot_comercial_habitacion for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());

-- ============================================================
-- Funciones SECURITY DEFINER
-- ============================================================

-- Congela la configuración comercial de una reserva ya confirmada.
-- Invocada desde Reservaciones (modules/reservaciones/actions/confirm.ts)
-- justo después de confirm_reservation_from_hold() -- Habitaciones sigue
-- siendo dueño de QUÉ se congela, Reservaciones sólo dispara el momento.
-- Idempotente (on conflict do nothing): un reintento del mismo confirm no
-- genera una segunda fila.
create or replace function public.congelar_configuracion_comercial(p_reservation_id uuid)
returns public.snapshot_comercial_habitacion
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation public.reservations;
  v_stay public.reservation_stays;
  v_room_type public.room_types;
  v_amenidades jsonb;
  v_snapshot public.snapshot_comercial_habitacion;
begin
  select * into v_reservation from public.reservations where id = p_reservation_id;
  if not found then raise exception 'RESERVATION_NOT_FOUND'; end if;

  if not public.has_permission(v_reservation.hotel_id, 'reservations.create') then
    raise exception 'PERMISSION_DENIED: reservations.create required' using errcode = '42501';
  end if;

  -- El modelo soporta 1:N ReservationStay pero la interfaz de esta sesión
  -- limita a una Estancia por Reserva (ver CLAUDE.md, decisión ADR-02
  -- heredada) -- se toma la más antigua, consistente con "una vez por
  -- reserva, no por noche".
  select * into v_stay from public.reservation_stays
  where reservation_id = p_reservation_id
  order by check_in asc
  limit 1;
  if not found then raise exception 'RESERVATION_STAY_NOT_FOUND'; end if;

  select * into v_room_type from public.room_types where id = v_stay.room_type_id;
  if not found then raise exception 'ROOM_TYPE_NOT_FOUND'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('name', ca.name) order by ca.name), '[]'::jsonb)
    into v_amenidades
  from public.tipo_habitacion_amenidad tha
  join public.catalogo_amenidades ca on ca.id = tha.amenidad_id
  where tha.room_type_id = v_room_type.id and ca.es_promesa_comercial = true and ca.is_active = true;

  insert into public.snapshot_comercial_habitacion (
    hotel_id, reservation_id, room_type_id, room_id,
    base_adults, max_adults, max_children, max_pets, amenidades_prometidas
  ) values (
    v_reservation.hotel_id, p_reservation_id, v_room_type.id, v_stay.room_id,
    v_room_type.base_adults, v_room_type.max_adults, v_room_type.max_children, v_room_type.max_pets,
    v_amenidades
  )
  on conflict (reservation_id) do nothing;

  select * into v_snapshot from public.snapshot_comercial_habitacion where reservation_id = p_reservation_id;
  return v_snapshot;
end;
$$;

comment on function public.congelar_configuracion_comercial(uuid) is
  'Único camino de escritura de snapshot_comercial_habitacion. Se llama una vez por reserva al confirmarse (nunca por noche). Idempotente vía ON CONFLICT (reservation_id).';

grant execute on function public.congelar_configuracion_comercial(uuid) to authenticated;

-- ImpactAnalysis simplificado (SAFE/BLOQUEANTE, sin nivel intermedio) +
-- desactivación de una Habitacion física. BLOQUEANTE = hay una asignación
-- física activa (room_assignments.released_at is null) sobre esta
-- habitación -- significa que una Estancia real (actual o futura) depende
-- de esta unidad concreta. No mira reservation_stays.room_id porque nada
-- lo escribe hoy (ver nota inicial de esta migración / CLAUDE.md Rack).
create or replace function public.deactivate_room(p_room_id uuid, p_reason text)
returns public.rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_blocking_count integer;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if not public.has_permission(v_room.hotel_id, 'hotel.settings.manage') then
    raise exception 'PERMISSION_DENIED: hotel.settings.manage required' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'DEACTIVATION_REASON_REQUIRED: desactivar una habitación requiere un motivo';
  end if;
  if not v_room.is_active then
    raise exception 'INVALID_TRANSITION: la habitación ya está inactiva';
  end if;

  select count(*) into v_blocking_count
  from public.room_assignments
  where room_id = p_room_id and released_at is null;

  if v_blocking_count > 0 then
    raise exception 'IMPACT_BLOCKING: % asignación(es) activa(s) dependen de esta habitación -- resuélvelas antes de desactivar', v_blocking_count;
  end if;

  update public.rooms
  set is_active = false, motivo_inactivacion = p_reason, inactive_at = now(), inactive_by = auth.uid()
  where id = p_room_id
  returning * into v_room;

  return v_room;
end;
$$;

comment on function public.deactivate_room(uuid, text) is
  'Desactiva una Habitacion tras ImpactAnalysis simplificado (SAFE/BLOQUEANTE): rechaza si hay una asignación física activa (room_assignments) dependiendo de ella. Motivo obligatorio, fijado siempre por esta función -- nunca a mano.';

create or replace function public.reactivate_room(p_room_id uuid)
returns public.rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if not public.has_permission(v_room.hotel_id, 'hotel.settings.manage') then
    raise exception 'PERMISSION_DENIED: hotel.settings.manage required' using errcode = '42501';
  end if;
  if v_room.is_active then
    raise exception 'INVALID_TRANSITION: la habitación ya está activa';
  end if;

  update public.rooms
  set is_active = true, motivo_inactivacion = null, inactive_at = null, inactive_by = null
  where id = p_room_id
  returning * into v_room;

  return v_room;
end;
$$;

comment on function public.reactivate_room(uuid) is
  'Reactivar nunca requiere ImpactAnalysis (siempre SAFE) -- limpia motivo_inactivacion/inactive_at/inactive_by.';

grant execute on function public.deactivate_room(uuid, text) to authenticated;
grant execute on function public.reactivate_room(uuid) to authenticated;

-- ImpactAnalysis simplificado para reducir capacidad de un TipoHabitacion:
-- BLOQUEANTE si existe una reserva futura/actual CONFIRMADA vendida bajo
-- este tipo cuya ocupación ya no cabría en la capacidad nueva. "Futura/
-- actual" = check_out todavía no pasó según la fecha operativa del hotel
-- (mismo patrón que mark_no_show, 0035: nunca current_date de la sesión).
create or replace function public.update_room_type_capacity(
  p_room_type_id uuid,
  p_base_adults integer,
  p_max_adults integer,
  p_max_children integer,
  p_max_pets integer
)
returns public.room_types
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_type public.room_types;
  v_hotel_timezone text;
  v_hotel_today date;
  v_blocking_count integer;
begin
  select * into v_room_type from public.room_types where id = p_room_type_id for update;
  if not found then raise exception 'ROOM_TYPE_NOT_FOUND'; end if;
  if not public.has_permission(v_room_type.hotel_id, 'hotel.settings.manage') then
    raise exception 'PERMISSION_DENIED: hotel.settings.manage required' using errcode = '42501';
  end if;

  select h.timezone into v_hotel_timezone from public.hotels h where h.id = v_room_type.hotel_id;
  if v_hotel_timezone is null then
    raise exception 'HOTEL_TIMEZONE_MISSING: el hotel % no tiene timezone configurado', v_room_type.hotel_id;
  end if;
  v_hotel_today := (now() AT TIME ZONE v_hotel_timezone)::date;

  select count(*) into v_blocking_count
  from public.reservation_stays rs
  join public.reservations r on r.id = rs.reservation_id
  where rs.room_type_id = p_room_type_id
    and r.status = 'confirmed'
    and rs.check_out > v_hotel_today
    and (
      rs.adults > p_max_adults
      or rs.children > p_max_children
      or (rs.has_pets and p_max_pets = 0)
    );

  if v_blocking_count > 0 then
    raise exception 'IMPACT_BLOCKING: % reserva(s) confirmada(s) futuras ya no caben en la capacidad nueva', v_blocking_count;
  end if;

  update public.room_types
  set base_adults = p_base_adults, max_adults = p_max_adults, max_children = p_max_children, max_pets = p_max_pets
  where id = p_room_type_id
  returning * into v_room_type;

  return v_room_type;
end;
$$;

comment on function public.update_room_type_capacity(uuid, integer, integer, integer, integer) is
  'Cambia la capacidad explícita de un TipoHabitacion tras ImpactAnalysis simplificado (SAFE/BLOQUEANTE): rechaza si alguna reserva confirmada futura/actual ya no cabría en la capacidad nueva.';

grant execute on function public.update_room_type_capacity(uuid, integer, integer, integer, integer) to authenticated;
