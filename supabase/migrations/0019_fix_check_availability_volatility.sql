-- Fix: check_availability() estaba marcada "stable", pero internamente
-- llama a expire_stale_holds(), que SI escribe (libera Holds vencidos).
-- PostgREST abre una transaccion de solo lectura para funciones
-- stable/immutable, y eso rompe el "select ... for update" de adentro de
-- expire_stale_holds con el error:
--   "cannot execute SELECT FOR UPDATE in a read-only transaction"
-- Se detecto al probar contra el proyecto real via la API REST (la prueba
-- local con psql no lo detecto porque psql no impone modo solo-lectura por
-- volatilidad declarada como si lo hace PostgREST).
--
-- No se edita 0016 (regla del proyecto: una migracion ya aplicada no se
-- toca) -- se reemplaza la funcion aqui, quitando "stable".

create or replace function public.check_availability(
  p_hotel_id uuid,
  p_room_type_id uuid,
  p_check_in date,
  p_check_out date
)
returns table (stay_date date, total_units integer, blocked_units integer, available_units integer)
language plpgsql
security invoker
as $$
begin
  if p_check_out <= p_check_in then
    raise exception 'INVALID_DATE_RANGE';
  end if;

  perform public.expire_stale_holds();

  return query
  select
    d::date,
    (select count(*)::int from public.rooms r
      where r.hotel_id = p_hotel_id and r.room_type_id = p_room_type_id and r.is_active),
    (select count(*)::int from public.inventory_blocks b
      where b.hotel_id = p_hotel_id and b.room_type_id = p_room_type_id and b.stay_date = d::date),
    (
      (select count(*)::int from public.rooms r
        where r.hotel_id = p_hotel_id and r.room_type_id = p_room_type_id and r.is_active)
      -
      (select count(*)::int from public.inventory_blocks b
        where b.hotel_id = p_hotel_id and b.room_type_id = p_room_type_id and b.stay_date = d::date)
    )
  from generate_series(p_check_in, p_check_out - 1, interval '1 day') as d
  order by d;
end;
$$;

comment on function public.check_availability(uuid, uuid, date, date) is
  'Disponibilidad noche a noche = unidades activas de rooms MENOS filas en inventory_blocks para esa fecha (spec S8.1, sin overbooking en v1). security invoker: respeta RLS. Volatile (no stable): llama a expire_stale_holds(), que escribe.';

grant execute on function public.check_availability(uuid, uuid, date, date) to authenticated;
