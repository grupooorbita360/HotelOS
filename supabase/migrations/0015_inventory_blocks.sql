-- HotelOS / Reservaciones: InventoryBlock -- tabla de verdad noche-a-noche
-- para disponibilidad (spec S8: "el inventario se evalua por hotel + tipo
-- habitacion + cada noche del rango, nunca como un numero unico"). Una fila
-- = 1 unidad de un RoomType consumida en 1 fecha, por 1 origen (Hold,
-- Reserva, mantenimiento o overbooking autorizado).
--
-- Unificar todo consumo de inventario en una sola tabla (en vez de sumar por
-- separado holds activos + reservas confirmadas + bloqueos manuales) es lo
-- que permite que crear un Hold sea una operacion atomica real: se bloquea
-- con advisory locks sobre (hotel_id, room_type_id, fecha) y se cuenta
-- contra esta unica tabla dentro de la misma transaccion (ver 0016).

create table public.inventory_blocks (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  room_type_id uuid not null references public.room_types (id),
  stay_date date not null,

  block_type text not null
    check (block_type in ('hold', 'reservation', 'maintenance', 'overbooking')),

  hold_id uuid references public.inventory_holds (id) on delete cascade,
  reservation_stay_id uuid references public.reservation_stays (id) on delete cascade,

  created_at timestamptz not null default now(),

  check (
    (block_type = 'hold' and hold_id is not null and reservation_stay_id is null)
    or (block_type = 'reservation' and reservation_stay_id is not null and hold_id is null)
    or (block_type in ('maintenance', 'overbooking'))
  )
);

comment on table public.inventory_blocks is
  'Una fila = una unidad de RoomType consumida en una fecha. Fuente unica de disponibilidad, compartida por Reservaciones y el futuro Rack (spec ADR-03: no puede haber dos algoritmos de disponibilidad distintos). No se edita: se inserta al crear/convertir un Hold y se borra al liberar/expirar/cancelar.';

-- Como el modelo de intervalos es [check_in, check_out), cada Hold/Estancia
-- de N noches genera N filas (una por noche consumida, nunca la noche de
-- salida). Un mismo Hold no puede duplicar la misma noche dos veces.
create unique index idx_inventory_blocks_hold_night
  on public.inventory_blocks (hold_id, stay_date) where hold_id is not null;
create unique index idx_inventory_blocks_stay_night
  on public.inventory_blocks (reservation_stay_id, stay_date) where reservation_stay_id is not null;

-- Indice critico del algoritmo de disponibilidad: contar unidades
-- consumidas por hotel + tipo + fecha en O(log n).
create index idx_inventory_blocks_lookup
  on public.inventory_blocks (hotel_id, room_type_id, stay_date);

alter table public.inventory_blocks enable row level security;

create policy "inventory_blocks_select_member_or_platform_admin"
  on public.inventory_blocks for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());

-- Sin INSERT/UPDATE/DELETE directos: solo las funciones atomicas de 0016
-- (SECURITY DEFINER) escriben aqui. Esta tabla es el activo mas sensible del
-- modulo (protege contra sobreventa real) y no debe ser alcanzable desde un
-- INSERT arbitrario del cliente.
