-- HotelOS / Recepcion: mark_no_show() (0026) comparaba el periodo de
-- gracia de no-show contra current_date -- la fecha de la SESION de
-- Postgres, no la del hotel. En Supabase esa sesion normalmente corre en
-- UTC, así que un hotel en otro timezone podía ver la regla evaluada un
-- día antes o después de su "hoy" real -- el mismo problema que
-- getHotelBusinessDate() (TypeScript) ya resuelve para Rack/Reservaciones,
-- pero esta función vive en Postgres y no puede llamar código de Next.js.
--
-- Cambio ADITIVO/EVOLUTIVO vía create or replace: no se edita 0026. Misma
-- regla de negocio, misma firma, mismo mensaje de error, mismo periodo de
-- gracia -- solo cambia de dónde sale "hoy".

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
  v_hotel_timezone text;
  v_hotel_today date;
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

  select h.timezone into v_hotel_timezone
  from public.hotels h where h.id = v_stay.hotel_id;

  -- "Hoy" para esta regla = fecha calendario en el timezone del hotel,
  -- misma definición que getHotelBusinessDate() en TypeScript (ver
  -- CLAUDE.md) -- nunca current_date de la sesión de Postgres. Un
  -- timezone ausente o inválido debe fallar de forma explícita, nunca
  -- caer en silencio a UTC: NULL se rechaza a mano (AT TIME ZONE NULL
  -- daría NULL y la comparación de abajo simplemente no dispararía,
  -- dejando pasar el no-show sin haber cumplido el periodo de gracia);
  -- un identificador IANA inexistente ya hace que AT TIME ZONE lance un
  -- error real de Postgres por sí solo.
  if v_hotel_timezone is null then
    raise exception 'HOTEL_TIMEZONE_MISSING: el hotel % no tiene timezone configurado', v_stay.hotel_id;
  end if;

  v_hotel_today := (now() AT TIME ZONE v_hotel_timezone)::date;

  if v_hotel_today < v_check_in + coalesce(v_grace_days, 0) then
    raise exception 'NOSHOW_GRACE_PERIOD_NOT_ELAPSED: espera hasta % para marcar No-Show', v_check_in + coalesce(v_grace_days, 0);
  end if;

  update public.stays set status = 'no_show', no_show_at = now(), no_show_reason = p_reason
  where id = p_stay_id;

  perform public.recompute_stay_next_action(p_stay_id);
  select * into v_stay from public.stays where id = p_stay_id;
  return v_stay;
end;
$$;
