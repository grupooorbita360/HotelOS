-- HotelOS / Recepcion: ConfiguracionRecepcion. Parametros por hotel, sin
-- tocar codigo (mismo patron que hotel_policies).

create table public.reception_settings (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null unique references public.hotels (id) on delete cascade,

  -- Si es false, la Entrega de habitacion se bloquea mientras haya saldo
  -- pendiente en la CuentaEstancia (gate financiero de entrega).
  entrega_permite_saldo boolean not null default false,

  -- Si es false, el Check-In administrativo se bloquea si la habitacion
  -- asignada no esta marcada como limpia.
  checkin_permite_sucia boolean not null default true,

  -- Dias de gracia antes de que el staff pueda marcar No-Show manualmente
  -- (No-Show sigue siendo siempre una accion manual, nunca automatica).
  noshow_dias_gracia integer not null default 0,

  -- Si es true, un saldo pendiente bloquea el Check-Out (Check-Out
  -- Readiness). Si es false, se puede cerrar la cuenta con saldo abierto.
  bloquear_checkout_saldo boolean not null default true,

  extra_settings jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);

comment on table public.reception_settings is
  'Configuracion operativa de Recepcion por hotel: gates de entrega/checkin/checkout y gracia de no-show. Una fila por hotel, creada automaticamente al dar de alta el hotel.';

create trigger trg_reception_settings_audit
  before insert or update on public.reception_settings
  for each row execute function public.set_audit_fields();

create or replace function public.handle_new_hotel_reception_settings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.reception_settings (hotel_id) values (new.id);
  return new;
end;
$$;

create trigger trg_on_hotel_created_reception_settings
  after insert on public.hotels
  for each row execute function public.handle_new_hotel_reception_settings();

alter table public.reception_settings enable row level security;

create policy "reception_settings_select_member_or_platform_admin"
  on public.reception_settings for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());

create policy "reception_settings_write_settings_manager_or_platform_admin"
  on public.reception_settings for update
  to authenticated
  using (public.is_platform_admin() or public.has_permission(hotel_id, 'hotel.settings.manage'))
  with check (public.is_platform_admin() or public.has_permission(hotel_id, 'hotel.settings.manage'));

-- Backfill: hoteles que ya existian antes de esta migracion.
insert into public.reception_settings (hotel_id)
select id from public.hotels
on conflict (hotel_id) do nothing;
