-- HotelOS / Reservaciones: algoritmo de compromiso de inventario (spec S7-S8).
--
-- "Verificar disponibilidad" y "bloquear inventario" son UNA sola operacion
-- logica atomica, nunca dos consultas separadas -- dos consultas dejan una
-- ventana de carrera donde dos usuarios pueden vender la misma ultima
-- unidad. Se implementa con pg_advisory_xact_lock por (hotel, tipo, noche):
-- cualquier otra transaccion que compita por la misma noche se bloquea
-- hasta que esta transaccion termine (commit o rollback), momento en el que
-- el conteo de inventory_blocks ya es definitivo.
--
-- Estas funciones son SECURITY DEFINER porque inventory_holds,
-- inventory_blocks y reservations no tienen politicas de INSERT/UPDATE para
-- el cliente (ver 0013-0015): el UNICO camino para escribir ahi es a traves
-- de aqui. Por eso cada funcion valida has_permission() y pertenencia al
-- hotel_id manualmente, ya que al correr como su dueno no pasan por RLS.

create or replace function public.expire_stale_holds()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  v_hold record;
begin
  for v_hold in
    select id from public.inventory_holds
    where status = 'active' and expires_at <= now()
    for update skip locked
  loop
    delete from public.inventory_blocks where hold_id = v_hold.id;
    update public.inventory_holds set status = 'expired' where id = v_hold.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

comment on function public.expire_stale_holds() is
  'Libera todos los Holds vencidos (de cualquier hotel) y borra sus inventory_blocks. Se llama de forma perezosa desde check_availability/attempt_inventory_hold; en produccion tambien debe llamarse periodicamente (pg_cron o un cron externo) para que un Hold vencido siempre genere la senal visible que exige el spec, no solo cuando alguien vuelve a consultar disponibilidad.';

create or replace function public.check_availability(
  p_hotel_id uuid,
  p_room_type_id uuid,
  p_check_in date,
  p_check_out date
)
returns table (stay_date date, total_units integer, blocked_units integer, available_units integer)
language plpgsql
security invoker
stable
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
  'Disponibilidad noche a noche = unidades activas de rooms MENOS filas en inventory_blocks para esa fecha (spec S8.1, sin overbooking en v1). security invoker: respeta RLS, un usuario fuera del hotel simplemente ve ceros.';

create or replace function public.attempt_inventory_hold(
  p_hotel_id uuid,
  p_room_type_id uuid,
  p_check_in date,
  p_check_out date,
  p_quote_option_id uuid default null,
  p_hold_minutes integer default null
)
returns public.inventory_holds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hold public.inventory_holds;
  v_day date;
  v_total_units integer;
  v_blocked_units integer;
  v_minutes integer;
begin
  if not public.has_permission(p_hotel_id, 'reservations.create') then
    raise exception 'PERMISSION_DENIED: reservations.create required' using errcode = '42501';
  end if;

  if p_check_out <= p_check_in then
    raise exception 'INVALID_DATE_RANGE';
  end if;

  if not exists (
    select 1 from public.room_types
    where id = p_room_type_id and hotel_id = p_hotel_id and is_active
  ) then
    raise exception 'ROOM_TYPE_NOT_FOUND_FOR_HOTEL';
  end if;

  if p_quote_option_id is not null and not exists (
    select 1 from public.quote_options where id = p_quote_option_id and hotel_id = p_hotel_id
  ) then
    raise exception 'QUOTE_OPTION_NOT_FOUND_FOR_HOTEL';
  end if;

  perform public.expire_stale_holds();

  v_minutes := coalesce(p_hold_minutes, 24 * 60);
  v_total_units := (
    select count(*) from public.rooms
    where hotel_id = p_hotel_id and room_type_id = p_room_type_id and is_active
  );

  insert into public.inventory_holds (
    hotel_id, room_type_id, quote_option_id, check_in, check_out, expires_at
  ) values (
    p_hotel_id, p_room_type_id, p_quote_option_id, p_check_in, p_check_out,
    now() + (v_minutes || ' minutes')::interval
  ) returning * into v_hold;

  v_day := p_check_in;
  while v_day < p_check_out loop
    -- Serializa contra cualquier otra transaccion que compita por esta
    -- misma noche+tipo+hotel. Se libera automaticamente al terminar esta
    -- transaccion (commit o rollback de todo el Server Action que invoco
    -- esta funcion).
    perform pg_advisory_xact_lock(
      hashtextextended(p_hotel_id::text || ':' || p_room_type_id::text || ':' || v_day::text, 0)
    );

    v_blocked_units := (
      select count(*) from public.inventory_blocks
      where hotel_id = p_hotel_id and room_type_id = p_room_type_id and stay_date = v_day
    );

    if v_blocked_units >= v_total_units then
      -- El rollback de la transaccion revierte tambien el insert del Hold
      -- de arriba: no queda un Hold "a medias" con solo algunas noches.
      raise exception 'NO_AVAILABILITY: room_type % on %', p_room_type_id, v_day
        using errcode = 'P0001';
    end if;

    insert into public.inventory_blocks (hotel_id, room_type_id, stay_date, block_type, hold_id)
    values (p_hotel_id, p_room_type_id, v_day, 'hold', v_hold.id);

    v_day := v_day + 1;
  end loop;

  return v_hold;
end;
$$;

comment on function public.attempt_inventory_hold(uuid, uuid, date, date, uuid, integer) is
  'Crea un InventoryHold y sus inventory_blocks de forma atomica: si cualquier noche no tiene disponibilidad, toda la operacion revierte (ninguna noche queda bloqueada a medias). Este es el unico punto de entrada valido para comprometer inventario -- spec S7 caso A: "dos usuarios intentan vender la ultima habitacion, solo uno obtiene el Hold".';

create or replace function public.confirm_reservation_from_hold(
  p_hold_id uuid,
  p_primary_guest_name text,
  p_primary_guest_email text default null,
  p_primary_guest_phone text default null,
  p_channel text default 'direct',
  p_rate_total numeric default 0,
  p_cancellation_policy_snapshot jsonb default '{}'::jsonb,
  p_adults integer default 1,
  p_children integer default 0,
  p_has_pets boolean default false,
  p_estimated_arrival_time time default null
)
returns public.reservations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hold public.inventory_holds;
  v_reservation public.reservations;
  v_stay public.reservation_stays;
  v_folio text;
  v_lead_id uuid;
  v_quote_id uuid;
begin
  select * into v_hold from public.inventory_holds where id = p_hold_id for update;

  if not found then
    raise exception 'HOLD_NOT_FOUND';
  end if;

  if not public.has_permission(v_hold.hotel_id, 'reservations.create') then
    raise exception 'PERMISSION_DENIED: reservations.create required' using errcode = '42501';
  end if;

  if v_hold.status = 'active' and v_hold.expires_at <= now() then
    delete from public.inventory_blocks where hold_id = v_hold.id;
    update public.inventory_holds set status = 'expired' where id = v_hold.id;
    raise exception 'HOLD_EXPIRED';
  end if;

  if v_hold.status <> 'active' then
    raise exception 'HOLD_NOT_ACTIVE: current status = %', v_hold.status;
  end if;

  select qo.quote_id, q.lead_id into v_quote_id, v_lead_id
  from public.quote_options qo
  join public.quotes q on q.id = qo.quote_id
  where qo.id = v_hold.quote_option_id;

  v_folio := to_char(now(), 'YYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 5));

  insert into public.reservations (
    hotel_id, folio, lead_id, quote_id, hold_id,
    primary_guest_name, primary_guest_email, primary_guest_phone,
    channel, cancellation_policy_snapshot
  ) values (
    v_hold.hotel_id, v_folio, v_lead_id, v_quote_id, v_hold.id,
    p_primary_guest_name, p_primary_guest_email, p_primary_guest_phone,
    p_channel, p_cancellation_policy_snapshot
  ) returning * into v_reservation;

  insert into public.reservation_stays (
    hotel_id, reservation_id, room_type_id, check_in, check_out,
    adults, children, has_pets, rate_total, estimated_arrival_time
  ) values (
    v_hold.hotel_id, v_reservation.id, v_hold.room_type_id, v_hold.check_in, v_hold.check_out,
    p_adults, p_children, p_has_pets, coalesce(p_rate_total, 0), p_estimated_arrival_time
  ) returning * into v_stay;

  update public.inventory_blocks
  set block_type = 'reservation', hold_id = null, reservation_stay_id = v_stay.id
  where hold_id = v_hold.id;

  update public.inventory_holds
  set status = 'converted', converted_reservation_id = v_reservation.id
  where id = v_hold.id;

  if v_lead_id is not null then
    update public.leads set status = 'converted', reservation_id = v_reservation.id where id = v_lead_id;
  end if;

  return v_reservation;
end;
$$;

comment on function public.confirm_reservation_from_hold(uuid, text, text, text, text, numeric, jsonb, integer, integer, boolean, time) is
  'Convierte un Hold activo en Reserva confirmada: crea Reservation + ReservationStay, re-etiqueta sus inventory_blocks de hold->reservation, cierra el Hold (converted) y marca el Lead como convertido. Todo en una sola transaccion. Si el Hold ya vencio, lo expira y falla explicitamente en vez de confirmar sobre inventario que ya no es tuyo.';

create or replace function public.release_hold(p_hold_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hold public.inventory_holds;
begin
  select * into v_hold from public.inventory_holds where id = p_hold_id for update;
  if not found then
    raise exception 'HOLD_NOT_FOUND';
  end if;
  if not public.has_permission(v_hold.hotel_id, 'reservations.create') then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if v_hold.status <> 'active' then
    raise exception 'HOLD_NOT_ACTIVE: current status = %', v_hold.status;
  end if;
  delete from public.inventory_blocks where hold_id = v_hold.id;
  update public.inventory_holds set status = 'released' where id = v_hold.id;
end;
$$;

create or replace function public.cancel_reservation(p_reservation_id uuid, p_reason text default null)
returns public.reservations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation public.reservations;
begin
  select * into v_reservation from public.reservations where id = p_reservation_id for update;
  if not found then
    raise exception 'RESERVATION_NOT_FOUND';
  end if;
  if not public.has_permission(v_reservation.hotel_id, 'reservations.cancel') then
    raise exception 'PERMISSION_DENIED: reservations.cancel required' using errcode = '42501';
  end if;
  if v_reservation.status <> 'confirmed' then
    raise exception 'RESERVATION_NOT_CANCELLABLE: current status = %', v_reservation.status;
  end if;

  delete from public.inventory_blocks
  where reservation_stay_id in (
    select id from public.reservation_stays where reservation_id = v_reservation.id
  );

  update public.reservations
  set status = 'cancelled', cancelled_at = now(), cancellation_reason = p_reason
  where id = v_reservation.id
  returning * into v_reservation;

  return v_reservation;
end;
$$;

comment on function public.cancel_reservation(uuid, text) is
  'Cancela y libera el inventario. NO calcula reembolso (CancellationPolicyEvaluator/RefundService quedan fuera de este alcance, ver CLAUDE.md) -- ese calculo se agrega como siguiente iteracion sobre cancellation_policy_snapshot, que ya se guarda en la reserva.';

grant execute on function public.expire_stale_holds() to authenticated;
grant execute on function public.check_availability(uuid, uuid, date, date) to authenticated;
grant execute on function public.attempt_inventory_hold(uuid, uuid, date, date, uuid, integer) to authenticated;
grant execute on function public.confirm_reservation_from_hold(uuid, text, text, text, text, numeric, jsonb, integer, integer, boolean, time) to authenticated;
grant execute on function public.release_hold(uuid) to authenticated;
grant execute on function public.cancel_reservation(uuid, text) to authenticated;
