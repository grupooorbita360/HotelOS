-- HotelOS / Recepcion: SolicitudHuesped e IncidenciaEstancia -- entidades
-- separadas a proposito: una es servicio al cliente (lo que el huesped
-- pide), la otra es operacion/mantenimiento (lo que esta roto o falla).
-- No se mezclan. ActivosEntregados: control basico Si/No de llaves y
-- controles, sin cantidades ni cargos todavia.

create table public.guest_requests (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  stay_id uuid not null references public.stays (id) on delete cascade,

  description text not null,
  status text not null default 'open' check (status in ('open', 'in_progress', 'completed', 'cancelled')),

  resolved_at timestamptz,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);

comment on table public.guest_requests is
  'Solicitud de servicio hecha por el huesped (ej. toallas extra, despertador). Servicio al cliente, no operacion/mantenimiento -- ver stay_incidents para eso.';

create trigger trg_guest_requests_audit
  before insert or update on public.guest_requests
  for each row execute function public.set_audit_fields();

create table public.stay_incidents (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  stay_id uuid not null references public.stays (id) on delete cascade,
  room_id uuid references public.rooms (id),

  type text not null check (type in ('maintenance', 'damage', 'complaint', 'other')),
  severity text not null default 'low' check (severity in ('low', 'medium', 'high')),
  description text not null,
  status text not null default 'open' check (status in ('open', 'resolved')),

  resolved_at timestamptz,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);

comment on table public.stay_incidents is
  'Incidencia operativa/de mantenimiento asociada a una estancia (ej. AC descompuesto, dano reportado). No es una solicitud del huesped -- ver guest_requests. Sin flujo automatico a un futuro modulo de Mantenimiento todavia: solo se registra y se resuelve manualmente.';

create trigger trg_stay_incidents_audit
  before insert or update on public.stay_incidents
  for each row execute function public.set_audit_fields();

create table public.delivered_assets (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  stay_id uuid not null references public.stays (id) on delete cascade,

  -- Nombre del activo, tomado del catalogo ya existente en
  -- hotel_policies.checkin_assets (no se crea un catalogo nuevo).
  asset_name text not null,

  delivered boolean not null default false,
  delivered_at timestamptz,
  returned boolean not null default false,
  returned_at timestamptz,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),

  unique (stay_id, asset_name)
);

comment on table public.delivered_assets is
  'Control basico Si/No de entrega y devolucion de activos (llaves, controles) por estancia. Sin cantidades ni cargos -- eso es evolucion futura. El check-out bloquea si hay un activo entregado y no devuelto.';

create trigger trg_delivered_assets_audit
  before insert or update on public.delivered_assets
  for each row execute function public.set_audit_fields();

create index idx_guest_requests_stay on public.guest_requests (stay_id);
create index idx_stay_incidents_stay on public.stay_incidents (stay_id);
create index idx_delivered_assets_stay on public.delivered_assets (stay_id);

alter table public.guest_requests enable row level security;
alter table public.stay_incidents enable row level security;
alter table public.delivered_assets enable row level security;

create policy "guest_requests_select_member_or_platform_admin"
  on public.guest_requests for select to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());
create policy "guest_requests_write_checkin_perform_or_platform_admin"
  on public.guest_requests for all to authenticated
  using (public.is_platform_admin() or public.has_permission(hotel_id, 'checkin.perform'))
  with check (public.is_platform_admin() or public.has_permission(hotel_id, 'checkin.perform'));

create policy "stay_incidents_select_member_or_platform_admin"
  on public.stay_incidents for select to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());
create policy "stay_incidents_insert_checkin_perform_or_platform_admin"
  on public.stay_incidents for insert to authenticated
  with check (public.is_platform_admin() or public.has_permission(hotel_id, 'checkin.perform'));
create policy "stay_incidents_update_rooms_manage_or_platform_admin"
  on public.stay_incidents for update to authenticated
  using (public.is_platform_admin() or public.has_permission(hotel_id, 'rooms.manage') or public.has_permission(hotel_id, 'checkin.perform'))
  with check (public.is_platform_admin() or public.has_permission(hotel_id, 'rooms.manage') or public.has_permission(hotel_id, 'checkin.perform'));

create policy "delivered_assets_select_member_or_platform_admin"
  on public.delivered_assets for select to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());
create policy "delivered_assets_write_checkin_perform_or_platform_admin"
  on public.delivered_assets for all to authenticated
  using (public.is_platform_admin() or public.has_permission(hotel_id, 'checkin.perform'))
  with check (public.is_platform_admin() or public.has_permission(hotel_id, 'checkin.perform'));
