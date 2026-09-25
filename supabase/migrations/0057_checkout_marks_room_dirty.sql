-- HotelOS / Recepcion: el check-out marca la habitacion sucia (P1-7 +
-- hallazgo de P1-13, handoff de demo P1 Tanda 2).
--
-- P1-13 (Tanda 1) ya documentó el hallazgo: ninguna función del flujo de
-- check-out tocaba rooms.is_clean -- "Marcar sucia" en Configuración era la
-- ÚNICA forma de que una habitación pasara a sucia en la operación real, sin
-- relación con que el huésped realmente se hubiera ido. Esto es el puente
-- temporal mínimo hasta que exista Housekeeping real (explícitamente pedido
-- así, no se construye Housekeeping completo aquí): attempt_check_out()
-- (0026) ahora marca is_clean = false en la(s) habitación(es) que libera en
-- el mismo UPDATE que ya hacía sobre room_assignments -- no una consulta ni
-- una función nueva, un WHERE adicional sobre el mismo conjunto de filas.
--
-- Por qué ahí y no en deliver_room()/register_arrival(): "sucia" describe el
-- estado físico DESPUÉS de que el huésped se va, no antes ni durante la
-- estancia -- exactamente cuándo attempt_check_out() ya libera la
-- asignación. No se toca ninguna otra función de la máquina de estados.

create or replace function public.attempt_check_out(p_stay_id uuid)
returns public.stays
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stay public.stays;
  v_readiness jsonb;
begin
  select * into v_stay from public.stays where id = p_stay_id for update;
  if not found then raise exception 'STAY_NOT_FOUND'; end if;
  if not public.has_permission(v_stay.hotel_id, 'checkout.perform') then
    raise exception 'PERMISSION_DENIED: checkout.perform required' using errcode = '42501';
  end if;
  if v_stay.status <> 'in_house' then
    raise exception 'INVALID_TRANSITION: stay status is %, expected "in_house"', v_stay.status;
  end if;

  v_readiness := public.check_out_readiness(p_stay_id);
  if not (v_readiness ->> 'ready')::boolean then
    raise exception 'CHECKOUT_BLOCKED: %', v_readiness -> 'blockers';
  end if;

  update public.stays set status = 'checked_out', checked_out_at = now()
  where id = p_stay_id;

  update public.stay_accounts set status = 'closed', closed_at = now()
  where stay_id = p_stay_id;

  -- P1-7 (handoff de demo P1 Tanda 2): la(s) habitación(es) que se liberan
  -- aquí quedan sucias -- el check-out real del huésped es la única señal
  -- confiable de que hay que limpiar, y hoy es la única función que
  -- garantiza que se dispare (mismo hallazgo documentado en P1-13).
  update public.rooms
  set is_clean = false
  where id in (
    select room_id from public.room_assignments
    where stay_id = p_stay_id and released_at is null
  );

  update public.room_assignments set released_at = now()
  where stay_id = p_stay_id and released_at is null;

  perform public.recompute_stay_next_action(p_stay_id);
  select * into v_stay from public.stays where id = p_stay_id;
  return v_stay;
end;
$$;

comment on function public.attempt_check_out(uuid) is
  'Cierra la Estancia (checked_out), cierra la cuenta y libera la asignación física -- desde P1-7 (handoff de demo P1 Tanda 2) también marca is_clean=false en la habitación liberada, puente temporal hasta que exista Housekeeping real (sin cambio en el resto del cuerpo respecto a 0026).';
