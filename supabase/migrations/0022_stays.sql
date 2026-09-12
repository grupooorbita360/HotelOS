-- HotelOS / Recepcion: Estancia -- ciclo de vida FISICO del huesped.
-- Separada por diseno de Reserva (ciclo comercial, modulo Reservaciones):
-- Reservaciones entrega una reserva "confirmed"; Recepcion la recibe aqui
-- como una Estancia nueva en 'expected' (ver trigger al final).
--
-- Regla no negociable: Check-In administrativo y Entrega fisica de la
-- habitacion son eventos SIEMPRE separados (checked_in_at != in_house_at),
-- nunca uno implicito en el otro. Sirve para medir cuellos de botella
-- entre Recepcion y Housekeeping.

create table public.stays (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  reservation_stay_id uuid not null unique references public.reservation_stays (id) on delete cascade,

  status text not null default 'expected'
    check (status in ('expected', 'arrived', 'checked_in', 'in_house', 'checked_out', 'no_show', 'walked')),

  -- Materializado por evento (funciones de 0026), nunca recalculado al leer.
  next_action text not null default 'registrar_llegada',

  arrived_at timestamptz,
  checked_in_at timestamptz,
  in_house_at timestamptz,
  checked_out_at timestamptz,
  no_show_at timestamptz,
  walked_at timestamptz,
  no_show_reason text,
  walked_reason text,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);

comment on table public.stays is
  'Ciclo de vida fisico del huesped: expected -> arrived -> checked_in -> in_house -> checked_out (o no_show / walked). No confundir con reservations.status (ciclo comercial) ni con reservation_stays (que sigue siendo lo vendido: tipo, fechas, tarifa).';
comment on column public.stays.next_action is
  'Accion recomendada materializada (patron "accion recomendada" del proyecto). Actualizada por las funciones de 0026 tras cada evento relevante, nunca calculada en el SELECT.';

create trigger trg_stays_audit
  before insert or update on public.stays
  for each row execute function public.set_audit_fields();

create index idx_stays_hotel_status on public.stays (hotel_id, status);

-- Alta automatica: al confirmarse una Reserva (reservation_stays ya
-- existe), Recepcion recibe la Estancia sin que Reservaciones conozca a
-- Recepcion (integracion a nivel de base de datos, no de codigo de
-- aplicacion -- ver CLAUDE.md regla 7 sobre no importar modulos entre si).
create or replace function public.handle_new_reservation_stay()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.stays (hotel_id, reservation_stay_id)
  values (new.hotel_id, new.id);
  return new;
end;
$$;

create trigger trg_on_reservation_stay_created
  after insert on public.reservation_stays
  for each row execute function public.handle_new_reservation_stay();

alter table public.stays enable row level security;

create policy "stays_select_member_or_platform_admin"
  on public.stays for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());

-- Sin INSERT/UPDATE directos: la alta es automatica (trigger de arriba) y
-- las transiciones de estado solo ocurren via las funciones SECURITY
-- DEFINER de 0026, que validan has_permission() manualmente.
