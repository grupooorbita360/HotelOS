-- HotelOS / Reservaciones: Reserva y Estancia.
--
-- Decision cerrada de origen (spec ADR-02): Reservation 1:N ReservationStay
-- desde el modelo de datos, aunque el MVP de interfaz limite a una sola
-- Estancia por Reserva.
--
-- Decision de esta implementacion (frontera Reservaciones/Recepcion, ver
-- CLAUDE.md "Reservaciones: decisiones de esquema"): Reserva NO incluye
-- CheckedIn/InHouse/CheckedOut/NoShow como estados propios. Esos son
-- operacion fisica de Recepcion y se modelaran en ese modulo sobre esta
-- misma tabla (columnas nuevas, no un rediseno). Reserva se queda en su
-- ciclo comercial: confirmed -> (cancelled | no_show | completed).

create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,

  folio text not null,
  lead_id uuid references public.leads (id),
  quote_id uuid references public.quotes (id),
  hold_id uuid references public.inventory_holds (id),

  primary_guest_name text not null,
  primary_guest_email text,
  primary_guest_phone text,

  channel text not null default 'direct'
    check (channel in ('direct', 'phone', 'walkin', 'booking', 'airbnb', 'expedia', 'other')),

  status text not null default 'confirmed'
    check (status in ('confirmed', 'cancelled', 'no_show', 'completed')),

  -- Copia versionada de la politica aceptada al confirmarse (spec S19):
  -- cambiar la politica del hotel manana no debe alterar esta reserva.
  cancellation_policy_snapshot jsonb not null default '{}'::jsonb,

  cancelled_at timestamptz,
  cancellation_reason text,
  refund_amount numeric(12, 2),

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),

  unique (hotel_id, folio)
);

comment on table public.reservations is
  'Acuerdo comercial confirmado. Solo existe una vez que un InventoryHold se convierte (nunca representa Cotizacion ni Hold activo -- esas son otras entidades). Estados de operacion fisica (check-in/en casa/check-out) se agregan en el modulo Recepcion sobre esta tabla, no aqui.';

create trigger trg_reservations_audit
  before insert or update on public.reservations
  for each row execute function public.set_audit_fields();

create index idx_reservations_hotel_status on public.reservations (hotel_id, status);

create table public.reservation_stays (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  reservation_id uuid not null references public.reservations (id) on delete cascade,
  room_type_id uuid not null references public.room_types (id),
  room_id uuid references public.rooms (id), -- asignacion fisica, resuelta hasta check-in (Recepcion)

  check_in date not null,
  check_out date not null,
  adults integer not null default 1,
  children integer not null default 0,
  has_pets boolean not null default false,

  rate_total numeric(12, 2) not null,
  estimated_arrival_time time,
  notes_guest text,
  notes_internal text,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),

  check (check_out > check_in)
);

comment on table public.reservation_stays is
  'Unidad vendida dentro de una Reserva: tipo vendido, fechas, ocupantes, habitacion fisica (nullable). Una Reserva familiar de 3 habitaciones = 1 Reserva + 3 Estancias bajo el mismo folio (spec S11-S12).';

create trigger trg_reservation_stays_audit
  before insert or update on public.reservation_stays
  for each row execute function public.set_audit_fields();

create index idx_reservation_stays_reservation on public.reservation_stays (reservation_id);
create index idx_reservation_stays_room on public.reservation_stays (room_id) where room_id is not null;

alter table public.reservations enable row level security;
alter table public.reservation_stays enable row level security;

create policy "reservations_select_member_or_platform_admin"
  on public.reservations for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());

create policy "reservations_update_reservations_create_or_platform_admin"
  on public.reservations for update
  to authenticated
  using (public.is_platform_admin() or public.has_permission(hotel_id, 'reservations.create'))
  with check (public.is_platform_admin() or public.has_permission(hotel_id, 'reservations.create'));

-- Sin INSERT directo: una Reserva solo nace dentro de
-- confirm_reservation_from_hold() (0016), atomica junto con la conversion
-- del Hold. Igual que inventory_holds, es SECURITY DEFINER y valida
-- has_permission() internamente.

create policy "reservation_stays_select_member_or_platform_admin"
  on public.reservation_stays for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());

create policy "reservation_stays_update_reservations_create_or_platform_admin"
  on public.reservation_stays for update
  to authenticated
  using (public.is_platform_admin() or public.has_permission(hotel_id, 'reservations.create'))
  with check (public.is_platform_admin() or public.has_permission(hotel_id, 'reservations.create'));
