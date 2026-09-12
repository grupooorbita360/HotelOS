-- HotelOS / Recepcion: asignacion de habitacion con upgrade, pedida
-- explicitamente despues de cerrar el alcance del Modulo 03 (que dejo
-- "Upgrade/downgrade de habitacion con autorizacion" fuera a proposito).
--
-- assign_room() (0026) sigue existiendo tal cual -- sigue siendo la unica
-- via para una asignacion estrictamente equivalente y no se toca (no se
-- edita una migracion ya aplicada). Esta es una funcion nueva, mas permisiva,
-- para el flujo guiado de check-in: permite asignar una habitacion de un
-- room_type distinto al vendido, y si la tarifa base del nuevo tipo es mayor,
-- cobra la diferencia (noches x diferencia de tarifa) como un cargo real en
-- la cuenta de la estancia -- mismo mecanismo que un cargo manual
-- (register_stay_transaction), no una tabla ni un concepto nuevo.
--
-- Downgrade (tarifa nueva menor) NO genera un abono automatico a favor --
-- igual que "aplicacion automatica de saldo a favor" ya quedo fuera de
-- alcance en el Modulo 03; un downgrade se resuelve con un ajuste manual si
-- el hotel decide hacerlo.

create or replace function public.assign_room_for_checkin(p_stay_id uuid, p_room_id uuid)
returns public.room_assignments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stay public.stays;
  v_reservation_stay public.reservation_stays;
  v_room public.rooms;
  v_sold_type public.room_types;
  v_new_type public.room_types;
  v_nights integer;
  v_rate_diff numeric;
  v_charge_amount numeric;
  v_assignment public.room_assignments;
begin
  select * into v_stay from public.stays where id = p_stay_id for update;
  if not found then raise exception 'STAY_NOT_FOUND'; end if;
  if not public.has_permission(v_stay.hotel_id, 'room.change') then
    raise exception 'PERMISSION_DENIED: room.change required' using errcode = '42501';
  end if;

  select * into v_reservation_stay from public.reservation_stays where id = v_stay.reservation_stay_id;
  select * into v_room from public.rooms where id = p_room_id and hotel_id = v_stay.hotel_id and is_active;
  if not found then raise exception 'ROOM_NOT_FOUND_FOR_HOTEL'; end if;

  if exists (
    select 1 from public.room_assignments
    where room_id = p_room_id and released_at is null and stay_id <> p_stay_id
  ) then
    raise exception 'ROOM_ALREADY_OCCUPIED: esa habitacion ya tiene una estancia activa asignada';
  end if;

  select * into v_sold_type from public.room_types where id = v_reservation_stay.room_type_id;
  select * into v_new_type from public.room_types where id = v_room.room_type_id;
  v_nights := greatest(1, v_reservation_stay.check_out - v_reservation_stay.check_in);
  v_rate_diff := v_new_type.base_rate - v_sold_type.base_rate;

  -- Reasignacion: libera cualquier asignacion activa previa de esta misma estancia.
  update public.room_assignments set released_at = now()
  where stay_id = p_stay_id and released_at is null;

  insert into public.room_assignments (hotel_id, stay_id, room_id)
  values (v_stay.hotel_id, p_stay_id, p_room_id)
  returning * into v_assignment;

  if v_room.room_type_id <> v_reservation_stay.room_type_id and v_rate_diff > 0 then
    v_charge_amount := round(v_rate_diff * v_nights, 2);
    -- register_stay_transaction() ya valida has_permission(hotel_id,
    -- 'payments.register') adentro; si falla, la excepcion revierte toda
    -- esta funcion (incluida la reasignacion de arriba) en la misma
    -- transaccion -- no queda un estado a medias.
    perform public.register_stay_transaction(
      p_stay_id, 'charge', v_charge_amount,
      'Upgrade a ' || v_new_type.name || ' (' || v_nights || ' noche(s) x $' || v_rate_diff || ')'
    );
  end if;

  perform public.recompute_stay_next_action(p_stay_id);
  return v_assignment;
end;
$$;

comment on function public.assign_room_for_checkin(uuid, uuid) is
  'Como assign_room() pero permite un room_type distinto al vendido (upgrade): si la tarifa base del nuevo tipo es mayor, cobra la diferencia x noches como un cargo real en la cuenta. Downgrade no genera abono automatico. assign_room() (0026) sigue siendo la via estrictamente equivalente.';

grant execute on function public.assign_room_for_checkin(uuid, uuid) to authenticated;
