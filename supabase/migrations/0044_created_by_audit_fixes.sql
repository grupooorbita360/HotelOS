-- HotelOS: dos huecos reales de auditoría encontrados por auditoría externa.
--
-- 1) inventory_blocks.created_by quedaba siempre NULL para block_type
--    'hold'/'reservation': attempt_inventory_hold() (INSERT) nunca lo
--    fijaba, y confirm_reservation_from_hold() (UPDATE, re-etiqueta
--    hold->reservation sobre la misma fila) tampoco. inventory_blocks no
--    tiene updated_at/updated_by (0033: "no se actualiza nunca vía trigger
--    genérico, mismo caso que timeline_events") y no acepta INSERT/UPDATE
--    directo del cliente (0015/0016) -- sólo estas funciones SECURITY
--    DEFINER escriben ahí, así que created_by sólo puede fijarse a mano
--    dentro de ellas (regla 11 de CLAUDE.md, mismo patrón que el fix de
--    stay_transactions en 0028 y de snapshot_comercial_habitacion en 0042).
--    En confirm_reservation_from_hold() se usa coalesce(created_by,
--    auth.uid()): si el INSERT ya lo fijó (caso normal a partir de esta
--    migración), la re-etiquetada a 'reservation' preserva a quien creó el
--    Hold originalmente -- created_by significa "quién creó la fila", no
--    "quién la tocó por última vez" (no hay updated_by para eso). El
--    coalesce sólo actúa como respaldo sobre filas que hubieran quedado en
--    NULL por el bug ya corregido.
--
-- 2) quote_options.created_by quedaba siempre NULL: createQuote() (TS) no
--    lo enviaba en el INSERT, y la política RLS no lo exigía. A diferencia
--    de inventory_blocks, quote_options SÍ acepta INSERT directo del
--    cliente (0012) -- incluso patrón de timeline_events (regla 11): tabla
--    sin updated_at/updated_by, poblada por INSERT directo del cliente,
--    RLS con WITH CHECK (created_by = auth.uid()) como garantía real (no
--    basta con que el cliente TypeScript lo mande "bien" -- un caller que
--    se salte el Server Action y pegue directo a PostgREST con su propio
--    token no debe poder insertar con un created_by ajeno). El fix en
--    TypeScript (createQuote(), fuera de esta migración) es el que hace que
--    la app funcione con este check ya exigido; sin ese cambio, el INSERT
--    actual (que no manda created_by) empezaría a fallar con RLS.

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

    insert into public.inventory_blocks (hotel_id, room_type_id, stay_date, block_type, hold_id, created_by)
    values (p_hotel_id, p_room_type_id, v_day, 'hold', v_hold.id, auth.uid());

    v_day := v_day + 1;
  end loop;

  return v_hold;
end;
$$;

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
  set block_type = 'reservation', hold_id = null, reservation_stay_id = v_stay.id,
      created_by = coalesce(created_by, auth.uid())
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

-- quote_options: mismo patrón que timeline_events (regla 11) -- tabla sin
-- updated_at/updated_by, poblada por INSERT directo del cliente. Se
-- reemplaza la política única de escritura por una que además exige
-- created_by = auth.uid() en el WITH CHECK (aplica a INSERT y a un
-- eventual UPDATE; nada en el proyecto actualiza quote_options hoy --
-- es inmutable por diseño, 0012 -- así que esto no cambia comportamiento
-- existente, sólo cierra la puerta a un INSERT con created_by ajeno).
drop policy if exists "quote_options_write_reservations_create_or_platform_admin" on public.quote_options;

create policy "quote_options_write_reservations_create_or_platform_admin"
  on public.quote_options for all
  to authenticated
  using (public.is_platform_admin() or public.has_permission(hotel_id, 'reservations.create'))
  with check (
    created_by = auth.uid()
    and (public.is_platform_admin() or public.has_permission(hotel_id, 'reservations.create'))
  );
