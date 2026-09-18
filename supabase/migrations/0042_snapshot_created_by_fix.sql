-- HotelOS / Habitaciones: fix de created_by en snapshot_comercial_habitacion.
--
-- Bug real encontrado probando congelar_configuracion_comercial() contra
-- Supabase real (0041), no en las pruebas locales: la tabla es append-only
-- y a propósito no tiene updated_at/updated_by (0041, "inmutable, no se
-- actualiza nunca"), así que no lleva el trigger genérico
-- set_audit_fields() -- pero eso significa que created_by debía fijarse a
-- mano dentro del INSERT de la función SECURITY DEFINER, y se me olvidó
-- (exactamente la lección de la regla 11 de CLAUDE.md / el fix de
-- stay_transactions en 0028 -- verificado ahí mismo, no evitado aquí por
-- descuido). El INSERT original no listaba created_by, así que la columna
-- quedaba siempre NULL sin que nada lo señalara (no rompe nada, por eso
-- pasó desapercibido hasta revisar el dato en vivo a propósito).
create or replace function public.congelar_configuracion_comercial(p_reservation_id uuid)
returns public.snapshot_comercial_habitacion
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation public.reservations;
  v_stay public.reservation_stays;
  v_room_type public.room_types;
  v_amenidades jsonb;
  v_snapshot public.snapshot_comercial_habitacion;
begin
  select * into v_reservation from public.reservations where id = p_reservation_id;
  if not found then raise exception 'RESERVATION_NOT_FOUND'; end if;

  if not public.has_permission(v_reservation.hotel_id, 'reservations.create') then
    raise exception 'PERMISSION_DENIED: reservations.create required' using errcode = '42501';
  end if;

  select * into v_stay from public.reservation_stays
  where reservation_id = p_reservation_id
  order by check_in asc
  limit 1;
  if not found then raise exception 'RESERVATION_STAY_NOT_FOUND'; end if;

  select * into v_room_type from public.room_types where id = v_stay.room_type_id;
  if not found then raise exception 'ROOM_TYPE_NOT_FOUND'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('name', ca.name) order by ca.name), '[]'::jsonb)
    into v_amenidades
  from public.tipo_habitacion_amenidad tha
  join public.catalogo_amenidades ca on ca.id = tha.amenidad_id
  where tha.room_type_id = v_room_type.id and ca.es_promesa_comercial = true and ca.is_active = true;

  insert into public.snapshot_comercial_habitacion (
    hotel_id, reservation_id, room_type_id, room_id,
    base_adults, max_adults, max_children, max_pets, amenidades_prometidas,
    created_by
  ) values (
    v_reservation.hotel_id, p_reservation_id, v_room_type.id, v_stay.room_id,
    v_room_type.base_adults, v_room_type.max_adults, v_room_type.max_children, v_room_type.max_pets,
    v_amenidades, auth.uid()
  )
  on conflict (reservation_id) do nothing;

  select * into v_snapshot from public.snapshot_comercial_habitacion where reservation_id = p_reservation_id;
  return v_snapshot;
end;
$$;
