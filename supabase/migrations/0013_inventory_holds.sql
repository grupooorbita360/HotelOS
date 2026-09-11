-- HotelOS / Reservaciones: InventoryHold. Decision cerrada del spec (ADR-01
-- / ADR-06): el Hold es una entidad INDEPENDIENTE, nunca un estado de
-- Reserva. Nace al bloquear inventario, protege esa capacidad mientras se
-- cumple la condicion de confirmacion (garantia/pago o confirmacion
-- explicita), y se CONVIERTE en Reserva -- nunca coexiste "activo y
-- confirmado" a la vez.

create table public.inventory_holds (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  room_type_id uuid not null references public.room_types (id),
  quote_option_id uuid references public.quote_options (id),

  check_in date not null,
  check_out date not null,

  status text not null default 'active'
    check (status in ('active', 'converted', 'expired', 'released', 'cancelled')),
  expires_at timestamptz not null,

  -- Se llena cuando status pasa a 'converted' (ver funcion
  -- confirm_reservation_from_hold en 0016).
  converted_reservation_id uuid,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),

  check (check_out > check_in)
);

comment on table public.inventory_holds is
  'Compromiso temporal de capacidad de un RoomType durante ciertas noches. No representa ingreso, garantia satisfecha, pago, ni habitacion fisica asignada (spec S4). Ver public.inventory_blocks para el detalle noche-a-noche que usa el algoritmo de disponibilidad.';
comment on column public.inventory_holds.expires_at is
  'Duracion configurable por hotel (hotel_policies.extra_settings.hold_duration_minutes, default 24h). La liberacion al vencer es automatica o manual segun hotel_policies (ver expire_stale_holds en 0016).';

create trigger trg_inventory_holds_audit
  before insert or update on public.inventory_holds
  for each row execute function public.set_audit_fields();

create index idx_inventory_holds_hotel_status on public.inventory_holds (hotel_id, status);
create index idx_inventory_holds_expires on public.inventory_holds (status, expires_at) where status = 'active';

alter table public.inventory_holds enable row level security;

create policy "inventory_holds_select_member_or_platform_admin"
  on public.inventory_holds for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());

-- No se exponen INSERT/UPDATE directos por RLS "for all": el unico camino
-- para crear/convertir un Hold es la funcion atomica attempt_inventory_hold
-- / confirm_reservation_from_hold (SECURITY DEFINER, 0016), que valida
-- has_permission() internamente antes de mutar. Esto evita que un cliente
-- inserte un Hold sin pasar por el algoritmo de concurrencia.
