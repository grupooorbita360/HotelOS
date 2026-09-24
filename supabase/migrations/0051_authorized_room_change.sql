-- HotelOS / Recepción: cambio de habitación autorizado para una estancia ya
-- asignada (handoff de demo, P0-3/P0-5).
--
-- P0-2/P0-4 (Rack, mismo handoff) ya cubren el caso "mover a una habitación
-- EQUIVALENTE" vía assign_room() (0026, sin tocar). Lo que faltaba -- y lo
-- que este archivo agrega -- es el caso que assign_room() rechaza a
-- propósito con ROOM_TYPE_MISMATCH (spec original de Recepción, 0026): mover
-- a una habitación de OTRO tipo, con autorización explícita, igual que
-- assign_room_for_checkin() (0032) ya hace pero sólo para el momento del
-- check-in. Esta función es la misma capacidad para DESPUÉS del check-in
-- (una estancia ya in_house que necesita cambiar de habitación), que
-- assign_room_for_checkin() no cubre.
--
-- Autorización: has_permission(hotel_id, 'room.change') simple -- mismo
-- patrón temporal ya usado para Caja (cash.refund/cash.adjust, 0046):
-- cuando exista PermisoExcepcion como módulo formal, esta función se
-- conecta ahí, no antes. No se agrega un permiso nuevo -- room.change ya
-- gatea toda mutación de asignación física en este proyecto.
--
-- Cobro/compensación: reusa register_stay_transaction() (0026) -- el mismo
-- mecanismo que assign_room_for_checkin() ya usa para cobrar la diferencia
-- de un upgrade, así que stay_accounts/stay_transactions no necesitan nada
-- nuevo, y no depende de que Caja (0046) esté desplegada, tal como se pidió.
-- Un upgrade con cobro se registra como 'charge' (positivo, ya sube el
-- saldo). Una compensación de downgrade se registra como 'payment' con
-- monto negativo -- no es un pago real en efectivo/tarjeta, pero es el
-- único tipo de este catálogo cuyo signo REDUCE el saldo (convención de
-- signo de este ledger, ver CLAUDE.md sección Recepción: "charge/refund
-- positivos, payment negativo"); 'refund' no sirve aquí porque en este
-- ledger es positivo (sube el saldo), lo opuesto de lo que una compensación
-- debe hacer. p_method se manda null: no hubo instrumento de pago real.
--
-- Upgrade/downgrade se determina comparando room_types.base_rate del tipo
-- anterior (de la asignación activa si existe, o si nunca hubo asignación
-- física, del tipo VENDIDO en reservation_stays) contra el tipo de la
-- habitación nueva -- mismo criterio de "qué se considera upgrade" que ya
-- usa assign_room_for_checkin() (0032).
--
-- Motivo obligatorio sólo para upgrade/downgrade (pedido explícito); para
-- un cambio a categoría equivalente vía esta función el motivo sigue
-- siendo opcional, igual que ya lo es en el drag & drop del Rack.

create or replace function public.change_room_with_authorization(
  p_stay_id uuid,
  p_new_room_id uuid,
  p_reason text default null,
  p_is_courtesy boolean default false,
  p_charge_amount numeric default null,
  p_compensation_amount numeric default null
)
returns public.room_assignments
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_stay public.stays;
  v_reservation_stay public.reservation_stays;
  v_old_room_type_id uuid;
  v_new_room public.rooms;
  v_old_rate numeric;
  v_new_rate numeric;
  v_change_type text;
  v_assignment public.room_assignments;
begin
  select * into v_stay from public.stays where id = p_stay_id for update;
  if not found then raise exception 'STAY_NOT_FOUND'; end if;
  if not public.has_permission(v_stay.hotel_id, 'room.change') then
    raise exception 'PERMISSION_DENIED: room.change required' using errcode = '42501';
  end if;

  select * into v_reservation_stay from public.reservation_stays where id = v_stay.reservation_stay_id;

  select r.room_type_id into v_old_room_type_id
  from public.room_assignments ra
  join public.rooms r on r.id = ra.room_id
  where ra.stay_id = p_stay_id and ra.released_at is null;
  -- Si la estancia nunca tuvo habitacion fisica asignada, el "tipo anterior"
  -- para efectos de upgrade/downgrade es el tipo VENDIDO (reservation_stays),
  -- no un NULL -- mismo criterio de assign_room_for_checkin() (0032).
  v_old_room_type_id := coalesce(v_old_room_type_id, v_reservation_stay.room_type_id);

  select * into v_new_room from public.rooms where id = p_new_room_id and hotel_id = v_stay.hotel_id and is_active;
  if not found then raise exception 'ROOM_NOT_FOUND_FOR_HOTEL'; end if;

  if exists (
    select 1 from public.room_assignments
    where room_id = p_new_room_id and released_at is null and stay_id <> p_stay_id
  ) then
    raise exception 'ROOM_ALREADY_OCCUPIED: esa habitacion ya tiene una estancia activa asignada';
  end if;

  if v_new_room.room_type_id = v_old_room_type_id then
    v_change_type := 'equivalente';
  else
    select base_rate into v_old_rate from public.room_types where id = v_old_room_type_id;
    select base_rate into v_new_rate from public.room_types where id = v_new_room.room_type_id;
    v_change_type := case when v_new_rate > v_old_rate then 'upgrade' else 'downgrade' end;
  end if;

  if v_change_type <> 'equivalente' and (p_reason is null or btrim(p_reason) = '') then
    raise exception 'REASON_REQUIRED: motivo obligatorio para % de habitacion', v_change_type;
  end if;

  if v_change_type = 'upgrade' and not p_is_courtesy and p_charge_amount is not null and p_charge_amount < 0 then
    raise exception 'INVALID_CHARGE_AMOUNT';
  end if;
  if v_change_type = 'downgrade' and p_compensation_amount is not null and p_compensation_amount < 0 then
    raise exception 'INVALID_COMPENSATION_AMOUNT';
  end if;

  update public.room_assignments set released_at = now()
  where stay_id = p_stay_id and released_at is null;

  insert into public.room_assignments (hotel_id, stay_id, room_id)
  values (v_stay.hotel_id, p_stay_id, p_new_room_id)
  returning * into v_assignment;

  if v_change_type = 'upgrade' and not p_is_courtesy and coalesce(p_charge_amount, 0) > 0 then
    perform public.register_stay_transaction(
      p_stay_id, 'charge', p_charge_amount,
      'Upgrade autorizado a ' || v_new_room.code || ' -- ' || p_reason,
      null
    );
  end if;

  if v_change_type = 'downgrade' and coalesce(p_compensation_amount, 0) > 0 then
    perform public.register_stay_transaction(
      p_stay_id, 'payment', -p_compensation_amount,
      'Compensacion por downgrade a ' || v_new_room.code || ' -- ' || p_reason,
      null
    );
  end if;

  perform public.recompute_stay_next_action(p_stay_id);
  return v_assignment;
end;
$func$;

comment on function public.change_room_with_authorization(uuid, uuid, text, boolean, numeric, numeric) is
  'Cambio de habitación autorizado para una estancia ya asignada (P0-3/P0-5, handoff de demo) -- a diferencia de assign_room() (0026), sí permite cambiar de tipo (upgrade/downgrade), determinado comparando room_types.base_rate. Motivo obligatorio salvo para un cambio a tipo equivalente. Upgrade con cobro y compensación de downgrade se registran vía register_stay_transaction() (0026) -- no depende de Caja (0046).';

revoke execute on function public.change_room_with_authorization(uuid, uuid, text, boolean, numeric, numeric) from public;
revoke execute on function public.change_room_with_authorization(uuid, uuid, text, boolean, numeric, numeric) from anon;
grant execute on function public.change_room_with_authorization(uuid, uuid, text, boolean, numeric, numeric) to authenticated;
