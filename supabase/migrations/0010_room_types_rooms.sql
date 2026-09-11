-- HotelOS / Reservaciones: prerequisito minimo del futuro modulo Habitaciones.
-- Solo lo necesario para que Reservaciones tenga inventario real contra el
-- que cotizar y bloquear. El modulo Habitaciones (Rack/Housekeeping) se
-- construira aparte y ampliara estas tablas (estado de limpieza, fotos,
-- amenidades, etc.) sin romper lo que se define aqui.

create table public.room_types (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  name text not null,
  code text not null,
  capacity_adults integer not null default 2,
  capacity_children integer not null default 0,
  accepts_pets boolean not null default false,
  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),

  unique (hotel_id, code)
);

comment on table public.room_types is
  'Categoria vendible (ej. "Sencilla", "Suite Manglar"). El Hold de Reservaciones bloquea RoomType, nunca Room directamente (ver InventoryHold).';

create trigger trg_room_types_audit
  before insert or update on public.room_types
  for each row execute function public.set_audit_fields();

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  room_type_id uuid not null references public.room_types (id) on delete restrict,
  code text not null,
  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),

  unique (hotel_id, code)
);

comment on table public.rooms is
  'Unidad fisica. La cantidad de filas activas por room_type_id es la "unidad_fisica" del algoritmo de disponibilidad (Reservaciones spec S8.1). La asignacion de una Room a una estancia ocurre hasta el check-in (modulo Recepcion), no aqui.';

create trigger trg_rooms_audit
  before insert or update on public.rooms
  for each row execute function public.set_audit_fields();

alter table public.room_types enable row level security;
alter table public.rooms enable row level security;

create policy "room_types_select_member_or_platform_admin"
  on public.room_types for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());

create policy "room_types_write_settings_manager_or_platform_admin"
  on public.room_types for all
  to authenticated
  using (public.is_platform_admin() or public.has_permission(hotel_id, 'hotel.settings.manage'))
  with check (public.is_platform_admin() or public.has_permission(hotel_id, 'hotel.settings.manage'));

create policy "rooms_select_member_or_platform_admin"
  on public.rooms for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());

create policy "rooms_write_settings_manager_or_platform_admin"
  on public.rooms for all
  to authenticated
  using (public.is_platform_admin() or public.has_permission(hotel_id, 'hotel.settings.manage'))
  with check (public.is_platform_admin() or public.has_permission(hotel_id, 'hotel.settings.manage'));
