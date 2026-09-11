-- HotelOS / Reservaciones: Lead. Intencion de compra ANTES de cualquier
-- compromiso de inventario. Lead != Cotizacion != Reserva (regla de
-- separacion no negociable del spec del modulo).

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,

  guest_name text not null,
  guest_email text,
  guest_phone text,

  pax_adults integer not null default 1,
  pax_children integer not null default 0,
  has_pets boolean not null default false,

  desired_check_in date,
  desired_check_out date,
  desired_room_type_id uuid references public.room_types (id),

  channel text not null default 'direct'
    check (channel in ('direct', 'phone', 'walkin', 'booking', 'airbnb', 'expedia', 'other')),

  status text not null default 'new'
    check (status in ('new', 'contacted', 'quoted', 'negotiating', 'waitlisted', 'converted', 'lost')),

  -- Catalogo cerrado, nunca texto libre (spec S2: distingue "perdemos por
  -- precio" de "perdemos por responder tarde").
  lost_reason text
    check (lost_reason is null or lost_reason in (
      'price', 'no_availability', 'no_response', 'booked_competitor',
      'changed_dates', 'trip_cancelled', 'location', 'policy', 'payment_method', 'other'
    )),

  reservation_id uuid, -- se referencia formalmente una vez existe public.reservations (ver 0014)

  first_contact_at timestamptz not null default now(),
  last_interaction_at timestamptz not null default now(),
  next_action_at timestamptz,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);

comment on table public.leads is
  'Intencion de compra. No es una Reserva. Se convierte via lead.status=converted + reservation_id, conservando la relacion para medir conversion y origen comercial.';

create trigger trg_leads_audit
  before insert or update on public.leads
  for each row execute function public.set_audit_fields();

create index idx_leads_hotel_status on public.leads (hotel_id, status);

alter table public.leads enable row level security;

create policy "leads_select_member_or_platform_admin"
  on public.leads for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());

create policy "leads_write_reservations_create_or_platform_admin"
  on public.leads for all
  to authenticated
  using (public.is_platform_admin() or public.has_permission(hotel_id, 'reservations.create'))
  with check (public.is_platform_admin() or public.has_permission(hotel_id, 'reservations.create'));
