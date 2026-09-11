-- HotelOS / Reservaciones: Cotizacion. "Foto" congelada e inmutable de lo
-- ofrecido. NUNCA compromete inventario -- su vigencia_hasta es vigencia de
-- PRECIO, no de disponibilidad (decision cerrada del spec, S15.2).

create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,

  status text not null default 'valid'
    check (status in ('valid', 'expired', 'converted', 'discarded')),

  currency text not null default 'MXN',
  -- Copia congelada de la politica de cancelacion vigente al emitir. Nunca
  -- una referencia viva (misma logica que el congelamiento de tipo de cambio).
  cancellation_policy_snapshot jsonb not null default '{}'::jsonb,

  price_valid_until timestamptz not null,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);

comment on table public.quotes is
  'Snapshot inmutable de una oferta comercial. Los campos de precio/fechas/politica no se editan tras crearse: un cambio genera una cotizacion nueva (versionado por reemplazo, no por UPDATE). Solo status transiciona.';

create trigger trg_quotes_audit
  before insert or update on public.quotes
  for each row execute function public.set_audit_fields();

create table public.quote_options (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  quote_id uuid not null references public.quotes (id) on delete cascade,
  room_type_id uuid not null references public.room_types (id),

  check_in date not null,
  check_out date not null,
  adults integer not null default 1,
  children integer not null default 0,
  has_pets boolean not null default false,

  subtotal numeric(12, 2) not null,
  taxes numeric(12, 2) not null default 0,
  total numeric(12, 2) not null,
  -- Desglose de ajustes aplicados (ReglaTarifaAplicada), como JSON en vez de
  -- tabla propia: el motor de tarifas configurable es evolucion futura: aqui
  -- solo se congela el resultado ya calculado.
  rules_applied jsonb not null default '[]'::jsonb,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),

  check (check_out > check_in)
);

comment on table public.quote_options is
  'Una alternativa cotizada dentro de una Cotizacion (fechas + tipo + tarifa especificos). Inmutable igual que la Cotizacion que la contiene.';

create index idx_quote_options_quote on public.quote_options (quote_id);

alter table public.quotes enable row level security;
alter table public.quote_options enable row level security;

create policy "quotes_select_member_or_platform_admin"
  on public.quotes for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());

create policy "quotes_write_reservations_create_or_platform_admin"
  on public.quotes for all
  to authenticated
  using (public.is_platform_admin() or public.has_permission(hotel_id, 'reservations.create'))
  with check (public.is_platform_admin() or public.has_permission(hotel_id, 'reservations.create'));

create policy "quote_options_select_member_or_platform_admin"
  on public.quote_options for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());

create policy "quote_options_write_reservations_create_or_platform_admin"
  on public.quote_options for all
  to authenticated
  using (public.is_platform_admin() or public.has_permission(hotel_id, 'reservations.create'))
  with check (public.is_platform_admin() or public.has_permission(hotel_id, 'reservations.create'));
