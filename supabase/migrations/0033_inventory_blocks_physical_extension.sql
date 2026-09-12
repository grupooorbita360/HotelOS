-- HotelOS / Reservaciones + futuro Rack: extension ADITIVA de
-- inventory_blocks (0015), en produccion con datos reales. Nada de lo que
-- sigue quita ni renombra una columna, cambia un tipo, ni retira un valor
-- ya permitido de block_type -- ver CLAUDE.md para el analisis de impacto
-- completo contra 0016/0019 (las unicas funciones que escriben/leen esta
-- tabla) antes de aplicar esto.
--
-- Motivo: el futuro modulo Rack va a reusar esta misma tabla para bloqueos
-- FISICOS (mantenimiento de una habitacion concreta, uso interno, etc.) en
-- vez de crear una tabla paralela -- exactamente el principio de "una sola
-- fuente de verdad de disponibilidad" con el que se diseño esta tabla
-- (ver comentario de 0015). No se construye Rack todavia (regla 8 de
-- CLAUDE.md): esto es solo la preparacion de esquema que Rack va a
-- necesitar, sin permisos ni funciones nuevas para escribir con los tipos
-- nuevos -- eso llega con el modulo Rack mismo.

alter table public.inventory_blocks
  add column room_id uuid references public.rooms (id),
  add column reason text,
  add column created_by uuid references auth.users (id);

comment on column public.inventory_blocks.room_id is
  'NULL (default, todo lo existente) = bloqueo comercial por tipo, como siempre. NOT NULL = bloqueo de una unidad fisica especifica -- para el futuro Rack (mantenimiento/uso interno sobre UNA habitacion, no sobre el tipo completo). No participa en el conteo de check_availability()/attempt_inventory_hold(), que siguen contando por (hotel_id, room_type_id, stay_date) sin importar si el bloqueo es de tipo o de unidad -- un bloqueo fisico especifico sigue restando del total del tipo, que es el comportamiento correcto.';
comment on column public.inventory_blocks.reason is
  'Motivo libre para un bloqueo manual (mantenimiento, uso interno, cortesia, grupo, contingencia). NULL para hold/reservation -- esos ya tienen su propio rastro via hold_id/reservation_stay_id.';
comment on column public.inventory_blocks.created_by is
  'Quien creo un bloqueo manual. NULL para hold/reservation (se auditan via inventory_holds/reservations). Se llama created_by, no usuario_id, para seguir la convencion del resto del esquema (aunque esta tabla en particular no lleva el trigger set_audit_fields() -- no tiene updated_at/by, mismo caso que timeline_events, ver CLAUDE.md regla 11).';

-- Los dos checks originales eran anonimos (declarados inline en el create
-- table de 0015): no se puede ensanchar un check in place, hay que
-- reemplazarlo. Se localizan por catalogo en vez de asumir un nombre
-- autogenerado, para que esto corra igual en cualquier entorno.
do $$
declare
  r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.inventory_blocks'::regclass and contype = 'c'
  loop
    execute format('alter table public.inventory_blocks drop constraint %I', r.conname);
  end loop;
end $$;

-- Mismo constraint de 0015, solo con el catalogo de block_type ampliado.
-- hold/reservation/maintenance/overbooking (los 4 que ya existian y que
-- 0016/0019 siguen usando tal cual) quedan exactamente igual de validos.
alter table public.inventory_blocks
  add constraint inventory_blocks_block_type_check
    check (block_type in (
      'hold', 'reservation', 'maintenance', 'overbooking',
      'internal_use', 'courtesy', 'group', 'contingency'
    ));

alter table public.inventory_blocks
  add constraint inventory_blocks_origin_check
    check (
      (block_type = 'hold' and hold_id is not null and reservation_stay_id is null)
      or (block_type = 'reservation' and reservation_stay_id is not null and hold_id is null)
      or (block_type in ('maintenance', 'overbooking', 'internal_use', 'courtesy', 'group', 'contingency'))
    );

-- Sin cambios de RLS: esta tabla nunca tuvo politica de INSERT/UPDATE para
-- el cliente (0015) y sigue sin tenerla -- los tipos nuevos (internal_use,
-- courtesy, group, contingency) todavia no son alcanzables desde ningun
-- lado hasta que el modulo Rack traiga su propia funcion SECURITY DEFINER
-- que valide has_permission() para crearlos, igual que 0016 lo hace hoy
-- para hold/reservation.
