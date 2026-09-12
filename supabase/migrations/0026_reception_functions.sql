-- HotelOS / Recepcion: funciones de dominio. Todas SECURITY DEFINER porque
-- stays, room_assignments, stay_accounts y stay_transactions no tienen
-- politicas de INSERT/UPDATE para el cliente (ver 0022-0024) -- el unico
-- camino para mutarlas es aqui, validando has_permission() manualmente.

-- ============================================================
-- Helper interno: recalcula next_action (materializado, nunca
-- recalculado en el SELECT).
-- ============================================================
create or replace function public.recompute_stay_next_action(p_stay_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_has_assignment boolean;
  v_delivery record;
  v_balance numeric;
  v_next text;
begin
  select status into v_status from public.stays where id = p_stay_id;
  if not found then
    return;
  end if;

  if v_status = 'expected' then
    v_next := 'registrar_llegada';
  elsif v_status = 'arrived' then
    v_next := 'hacer_checkin';
  elsif v_status = 'checked_in' then
    select exists(
      select 1 from public.room_assignments
      where stay_id = p_stay_id and released_at is null
    ) into v_has_assignment;

    if not v_has_assignment then
      v_next := 'asignar_habitacion';
    else
      select * into v_delivery from public.can_deliver_room(p_stay_id);
      v_next := case when v_delivery.allowed then 'entregar_habitacion' else 'cobrar_saldo' end;
    end if;
  elsif v_status = 'in_house' then
    select sa.balance into v_balance from public.stay_accounts sa where sa.stay_id = p_stay_id;
    v_next := case when coalesce(v_balance, 0) > 0 then 'cobrar_saldo' else 'ninguna' end;
  else
    v_next := 'ninguna';
  end if;

  update public.stays set next_action = v_next where id = p_stay_id;
end;
$$;

-- ============================================================
-- Gate financiero de entrega
-- ============================================================
create or replace function public.can_deliver_room(p_stay_id uuid)
returns table (allowed boolean, reason text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_hotel_id uuid;
  v_entrega_permite_saldo boolean;
  v_balance numeric;
begin
  select s.hotel_id, sa.balance
    into v_hotel_id, v_balance
  from public.stays s
  join public.stay_accounts sa on sa.stay_id = s.id
  where s.id = p_stay_id;

  select rs.entrega_permite_saldo into v_entrega_permite_saldo
  from public.reception_settings rs where rs.hotel_id = v_hotel_id;

  if not coalesce(v_entrega_permite_saldo, false) and coalesce(v_balance, 0) > 0 then
    return query select false, 'Saldo pendiente de ' || v_balance::text;
  end if;

  return query select true, null::text;
end;
$$;

-- ============================================================
-- Check-Out Readiness
-- ============================================================
create or replace function public.check_out_readiness(p_stay_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_hotel_id uuid;
  v_balance numeric;
  v_bloquear_saldo boolean;
  v_blockers text[] := array[]::text[];
  v_assets_sin_devolver integer;
  v_incidencias_abiertas integer;
begin
  select s.hotel_id, sa.balance
    into v_hotel_id, v_balance
  from public.stays s
  join public.stay_accounts sa on sa.stay_id = s.id
  where s.id = p_stay_id;

  select rs.bloquear_checkout_saldo into v_bloquear_saldo
  from public.reception_settings rs where rs.hotel_id = v_hotel_id;

  if coalesce(v_bloquear_saldo, true) and coalesce(v_balance, 0) > 0 then
    v_blockers := array_append(v_blockers, 'Saldo pendiente de ' || v_balance::text);
  end if;

  select count(*) into v_assets_sin_devolver
  from public.delivered_assets
  where stay_id = p_stay_id and delivered and not returned;
  if v_assets_sin_devolver > 0 then
    v_blockers := array_append(v_blockers, v_assets_sin_devolver || ' activo(s) sin devolver');
  end if;

  select count(*) into v_incidencias_abiertas
  from public.stay_incidents
  where stay_id = p_stay_id and status = 'open';
  if v_incidencias_abiertas > 0 then
    v_blockers := array_append(v_blockers, v_incidencias_abiertas || ' incidencia(s) abierta(s)');
  end if;

  return jsonb_build_object('ready', array_length(v_blockers, 1) is null, 'blockers', to_jsonb(v_blockers));
end;
$$;

-- ============================================================
-- Transiciones de la Estancia
-- ============================================================
create or replace function public.register_arrival(p_stay_id uuid)
returns public.stays
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stay public.stays;
begin
  select * into v_stay from public.stays where id = p_stay_id for update;
  if not found then raise exception 'STAY_NOT_FOUND'; end if;
  if not public.has_permission(v_stay.hotel_id, 'checkin.perform') then
    raise exception 'PERMISSION_DENIED: checkin.perform required' using errcode = '42501';
  end if;
  if v_stay.status <> 'expected' then
    raise exception 'INVALID_TRANSITION: stay status is %, expected "expected"', v_stay.status;
  end if;

  update public.stays set status = 'arrived', arrived_at = now()
  where id = p_stay_id returning * into v_stay;

  perform public.recompute_stay_next_action(p_stay_id);
  select * into v_stay from public.stays where id = p_stay_id;
  return v_stay;
end;
$$;

create or replace function public.check_in(p_stay_id uuid)
returns public.stays
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stay public.stays;
  v_checkin_permite_sucia boolean;
  v_room_dirty boolean;
begin
  select * into v_stay from public.stays where id = p_stay_id for update;
  if not found then raise exception 'STAY_NOT_FOUND'; end if;
  if not public.has_permission(v_stay.hotel_id, 'checkin.perform') then
    raise exception 'PERMISSION_DENIED: checkin.perform required' using errcode = '42501';
  end if;
  if v_stay.status <> 'arrived' then
    raise exception 'INVALID_TRANSITION: stay status is %, expected "arrived"', v_stay.status;
  end if;

  select rs.checkin_permite_sucia into v_checkin_permite_sucia
  from public.reception_settings rs where rs.hotel_id = v_stay.hotel_id;

  if not coalesce(v_checkin_permite_sucia, true) then
    select not r.is_clean into v_room_dirty
    from public.room_assignments ra
    join public.rooms r on r.id = ra.room_id
    where ra.stay_id = p_stay_id and ra.released_at is null;

    if coalesce(v_room_dirty, false) then
      raise exception 'ROOM_NOT_CLEAN: hotel policy blocks check-in until the room is clean';
    end if;
  end if;

  update public.stays set status = 'checked_in', checked_in_at = now()
  where id = p_stay_id;

  perform public.recompute_stay_next_action(p_stay_id);
  select * into v_stay from public.stays where id = p_stay_id;
  return v_stay;
end;
$$;

create or replace function public.assign_room(p_stay_id uuid, p_room_id uuid)
returns public.room_assignments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stay public.stays;
  v_reservation_stay public.reservation_stays;
  v_room public.rooms;
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

  if v_room.room_type_id <> v_reservation_stay.room_type_id then
    raise exception 'ROOM_TYPE_MISMATCH: MVP solo permite asignacion equivalente (mismo tipo vendido)';
  end if;

  if exists (
    select 1 from public.room_assignments
    where room_id = p_room_id and released_at is null and stay_id <> p_stay_id
  ) then
    raise exception 'ROOM_ALREADY_OCCUPIED: esa habitacion ya tiene una estancia activa asignada';
  end if;

  -- Reasignacion: libera cualquier asignacion activa previa de esta misma estancia.
  update public.room_assignments set released_at = now()
  where stay_id = p_stay_id and released_at is null;

  insert into public.room_assignments (hotel_id, stay_id, room_id)
  values (v_stay.hotel_id, p_stay_id, p_room_id)
  returning * into v_assignment;

  perform public.recompute_stay_next_action(p_stay_id);
  return v_assignment;
end;
$$;

create or replace function public.deliver_room(p_stay_id uuid)
returns public.stays
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stay public.stays;
  v_gate record;
begin
  select * into v_stay from public.stays where id = p_stay_id for update;
  if not found then raise exception 'STAY_NOT_FOUND'; end if;
  if not public.has_permission(v_stay.hotel_id, 'checkin.perform') then
    raise exception 'PERMISSION_DENIED: checkin.perform required' using errcode = '42501';
  end if;
  if v_stay.status <> 'checked_in' then
    raise exception 'INVALID_TRANSITION: stay status is %, expected "checked_in"', v_stay.status;
  end if;
  if not exists (select 1 from public.room_assignments where stay_id = p_stay_id and released_at is null) then
    raise exception 'NO_ROOM_ASSIGNED: asigna una habitacion antes de entregarla';
  end if;

  select * into v_gate from public.can_deliver_room(p_stay_id);
  if not v_gate.allowed then
    raise exception 'DELIVERY_BLOCKED: %', v_gate.reason;
  end if;

  update public.stays set status = 'in_house', in_house_at = now()
  where id = p_stay_id;

  perform public.recompute_stay_next_action(p_stay_id);
  select * into v_stay from public.stays where id = p_stay_id;
  return v_stay;
end;
$$;

create or replace function public.mark_no_show(p_stay_id uuid, p_reason text default null)
returns public.stays
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stay public.stays;
  v_check_in date;
  v_grace_days integer;
begin
  select * into v_stay from public.stays where id = p_stay_id for update;
  if not found then raise exception 'STAY_NOT_FOUND'; end if;
  if not public.has_permission(v_stay.hotel_id, 'checkin.perform') then
    raise exception 'PERMISSION_DENIED: checkin.perform required' using errcode = '42501';
  end if;
  if v_stay.status not in ('expected', 'arrived') then
    raise exception 'INVALID_TRANSITION: stay status is %, expected "expected" or "arrived"', v_stay.status;
  end if;

  select rst.check_in into v_check_in
  from public.reservation_stays rst where rst.id = v_stay.reservation_stay_id;
  select rs.noshow_dias_gracia into v_grace_days
  from public.reception_settings rs where rs.hotel_id = v_stay.hotel_id;

  if current_date < v_check_in + coalesce(v_grace_days, 0) then
    raise exception 'NOSHOW_GRACE_PERIOD_NOT_ELAPSED: espera hasta % para marcar No-Show', v_check_in + coalesce(v_grace_days, 0);
  end if;

  update public.stays set status = 'no_show', no_show_at = now(), no_show_reason = p_reason
  where id = p_stay_id;

  perform public.recompute_stay_next_action(p_stay_id);
  select * into v_stay from public.stays where id = p_stay_id;
  return v_stay;
end;
$$;

create or replace function public.mark_walked(p_stay_id uuid, p_reason text default null)
returns public.stays
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stay public.stays;
begin
  select * into v_stay from public.stays where id = p_stay_id for update;
  if not found then raise exception 'STAY_NOT_FOUND'; end if;
  if not public.has_permission(v_stay.hotel_id, 'checkin.perform') then
    raise exception 'PERMISSION_DENIED: checkin.perform required' using errcode = '42501';
  end if;
  if v_stay.status <> 'arrived' then
    raise exception 'INVALID_TRANSITION: stay status is %, expected "arrived"', v_stay.status;
  end if;

  update public.stays set status = 'walked', walked_at = now(), walked_reason = p_reason
  where id = p_stay_id;

  perform public.recompute_stay_next_action(p_stay_id);
  select * into v_stay from public.stays where id = p_stay_id;
  return v_stay;
end;
$$;

-- ============================================================
-- Cuenta de la estancia
-- ============================================================
create or replace function public.register_stay_transaction(
  p_stay_id uuid,
  p_type text,
  p_amount numeric,
  p_concept text,
  p_method text default null
)
returns public.stay_transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stay public.stays;
  v_account public.stay_accounts;
  v_transaction public.stay_transactions;
begin
  select * into v_stay from public.stays where id = p_stay_id;
  if not found then raise exception 'STAY_NOT_FOUND'; end if;
  if not public.has_permission(v_stay.hotel_id, 'payments.register') then
    raise exception 'PERMISSION_DENIED: payments.register required' using errcode = '42501';
  end if;

  select * into v_account from public.stay_accounts where stay_id = p_stay_id for update;
  if v_account.status <> 'open' then
    raise exception 'ACCOUNT_CLOSED: la cuenta de esta estancia ya esta cerrada';
  end if;

  if p_type in ('charge', 'refund') and p_amount <= 0 then
    raise exception 'INVALID_AMOUNT: % debe ser positivo', p_type;
  end if;
  if p_type = 'payment' and p_amount >= 0 then
    raise exception 'INVALID_AMOUNT: payment debe ser negativo';
  end if;

  insert into public.stay_transactions (hotel_id, stay_account_id, type, amount, concept, method)
  values (v_stay.hotel_id, v_account.id, p_type, p_amount, p_concept, p_method)
  returning * into v_transaction;

  perform public.recompute_stay_next_action(p_stay_id);
  return v_transaction;
end;
$$;

create or replace function public.void_stay_transaction(p_transaction_id uuid, p_reason text default null)
returns public.stay_transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_original public.stay_transactions;
  v_account public.stay_accounts;
  v_stay_id uuid;
  v_new_type text;
  v_new public.stay_transactions;
begin
  select * into v_original from public.stay_transactions where id = p_transaction_id;
  if not found then raise exception 'TRANSACTION_NOT_FOUND'; end if;

  select * into v_account from public.stay_accounts where id = v_original.stay_account_id;
  if not public.has_permission(v_account.hotel_id, 'payments.register') then
    raise exception 'PERMISSION_DENIED: payments.register required' using errcode = '42501';
  end if;
  if v_account.status <> 'open' then
    raise exception 'ACCOUNT_CLOSED: la cuenta de esta estancia ya esta cerrada';
  end if;

  v_new_type := case when v_original.type = 'payment' then 'refund' else 'payment' end;
  v_stay_id := v_account.stay_id;

  insert into public.stay_transactions (
    hotel_id, stay_account_id, type, amount, concept, method, reversed_transaction_id
  ) values (
    v_account.hotel_id, v_account.id, v_new_type, -v_original.amount,
    'Anulacion: ' || v_original.concept || coalesce(' -- ' || p_reason, ''),
    v_original.method, v_original.id
  ) returning * into v_new;

  perform public.recompute_stay_next_action(v_stay_id);
  return v_new;
end;
$$;

-- ============================================================
-- Check-Out
-- ============================================================
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

  update public.room_assignments set released_at = now()
  where stay_id = p_stay_id and released_at is null;

  perform public.recompute_stay_next_action(p_stay_id);
  select * into v_stay from public.stays where id = p_stay_id;
  return v_stay;
end;
$$;

grant execute on function public.can_deliver_room(uuid) to authenticated;
grant execute on function public.check_out_readiness(uuid) to authenticated;
grant execute on function public.register_arrival(uuid) to authenticated;
grant execute on function public.check_in(uuid) to authenticated;
grant execute on function public.assign_room(uuid, uuid) to authenticated;
grant execute on function public.deliver_room(uuid) to authenticated;
grant execute on function public.mark_no_show(uuid, text) to authenticated;
grant execute on function public.mark_walked(uuid, text) to authenticated;
grant execute on function public.register_stay_transaction(uuid, text, numeric, text, text) to authenticated;
grant execute on function public.void_stay_transaction(uuid, text) to authenticated;
grant execute on function public.attempt_check_out(uuid) to authenticated;
