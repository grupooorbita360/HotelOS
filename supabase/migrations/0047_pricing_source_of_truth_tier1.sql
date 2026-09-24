-- HotelOS / Reservaciones: fuente única de precio (auditoría externa,
-- Tier 1 -- ver CLAUDE.md, sección "Fuente única de precio").
--
-- Hasta ahora rate_total llegaba a confirm_reservation_from_hold() como
-- p_rate_total: un parámetro suelto que el navegador reenviaba en el
-- formulario de "Confirmar reserva" (submitConfirmReservation), sin
-- relación alguna con el total ya calculado y persistido en
-- quote_options.total al cotizar -- el precio final cobrado dependía de lo
-- que el cliente HTTP quisiera reenviar en el último paso, no de lo que el
-- sistema ya había cotizado.
--
-- Mismo patrón ya aplicado en 0037 a upsert_hotel_priority()
-- ("severity/category/priority_score/source_module ya no se aceptan como
-- parámetros -- se quitan de la firma, no sólo se ignoran, siempre se
-- derivan"): aquí se aplica a precio en vez de severidad. p_rate_total se
-- elimina de la firma (drop + create: Postgres no permite quitar un
-- parámetro con create or replace). rate_total ahora se deriva SIEMPRE de
-- inventory_holds.quote_option_id -> quote_options.total -- el mismo Hold
-- que se está confirmando, nunca de un valor que el caller pudiera mandar.
-- Un Hold sin quote_option_id (creado sin cotizar antes -- caso que la UI
-- actual no genera) resulta en rate_total = 0, igual que el default
-- anterior (coalesce(p_rate_total, 0)).
--
-- Se aprovecha el mismo cambio de firma para aplicar la higiene de 0045/
-- 0046 (revoke de PUBLIC/anon, sólo authenticated) a esta función, ya que
-- de cualquier forma hay que recrearla.

drop function public.confirm_reservation_from_hold(uuid, text, text, text, text, numeric, jsonb, integer, integer, boolean, time);

create or replace function public.confirm_reservation_from_hold(
  p_hold_id uuid,
  p_primary_guest_name text,
  p_primary_guest_email text default null,
  p_primary_guest_phone text default null,
  p_channel text default 'direct',
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
as $func$
declare
  v_hold public.inventory_holds;
  v_reservation public.reservations;
  v_stay public.reservation_stays;
  v_folio text;
  v_lead_id uuid;
  v_quote_id uuid;
  v_rate_total numeric;
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

  select qo.quote_id, q.lead_id, qo.total into v_quote_id, v_lead_id, v_rate_total
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
    p_adults, p_children, p_has_pets, coalesce(v_rate_total, 0), p_estimated_arrival_time
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
$func$;

comment on function public.confirm_reservation_from_hold(uuid, text, text, text, text, jsonb, integer, integer, boolean, time) is
  'Convierte un Hold activo en Reserva confirmada: crea Reservation + ReservationStay, re-etiqueta sus inventory_blocks de hold->reservation, cierra el Hold (converted) y marca el Lead como convertido. rate_total se deriva SIEMPRE de quote_options.total vía inventory_holds.quote_option_id -- nunca de un parámetro que el caller pudiera mandar (0047, fuente única de precio). Si el Hold ya venció, lo expira y falla explícitamente en vez de confirmar sobre inventario que ya no es tuyo.';

revoke execute on function public.confirm_reservation_from_hold(uuid, text, text, text, text, jsonb, integer, integer, boolean, time) from public;
revoke execute on function public.confirm_reservation_from_hold(uuid, text, text, text, text, jsonb, integer, integer, boolean, time) from anon;
grant execute on function public.confirm_reservation_from_hold(uuid, text, text, text, text, jsonb, integer, integer, boolean, time) to authenticated;
