-- HotelOS: configuración/políticas propias de cada hotel. Nada de esto debe
-- vivir en código: un cambio de política es una fila, no un deploy.

create table public.hotel_policies (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null unique references public.hotels (id) on delete cascade,

  requires_guarantee boolean not null default false,
  guarantee_notes text,

  allows_early_checkin boolean not null default false,
  standard_checkin_time time not null default '15:00',
  standard_checkout_time time not null default '12:00',

  -- Activos que se entregan en el check-in (llaves, control, toallas, etc.)
  -- Lista libre en JSON para no requerir migración cada vez que un hotel
  -- cambia qué entrega.
  checkin_assets jsonb not null default '[]'::jsonb,

  -- Catch-all para políticas futuras sin necesidad de alterar el esquema.
  extra_settings jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);

comment on table public.hotel_policies is
  'Configuración operativa por hotel (garantías, horarios, activos de check-in, etc.). Un renglón por hotel; se crea automáticamente al dar de alta el hotel.';

create trigger trg_hotel_policies_audit
  before insert or update on public.hotel_policies
  for each row execute function public.set_audit_fields();

-- Al crear un hotel, se crea su fila de políticas con valores por defecto,
-- para que ningún módulo tenga que manejar "políticas no configuradas".
create or replace function public.handle_new_hotel()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.hotel_policies (hotel_id) values (new.id);
  return new;
end;
$$;

create trigger trg_on_hotel_created
  after insert on public.hotels
  for each row execute function public.handle_new_hotel();

alter table public.hotel_policies enable row level security;

create policy "hotel_policies_select_member_or_platform_admin"
  on public.hotel_policies for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());

create policy "hotel_policies_write_settings_manager_or_platform_admin"
  on public.hotel_policies for update
  to authenticated
  using (public.is_platform_admin() or public.has_permission(hotel_id, 'hotel.settings.manage'))
  with check (public.is_platform_admin() or public.has_permission(hotel_id, 'hotel.settings.manage'));

-- Sin INSERT manual (lo hace el trigger trg_on_hotel_created) ni DELETE.
