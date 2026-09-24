-- HotelOS / Recepción: falla de seguridad real en can_deliver_room() y
-- check_out_readiness() (0026).
--
-- Auditoría externa: ambas son SECURITY DEFINER, reciben sólo un stay_id
-- libre, y no validaban membresía ni permiso -- eran ejecutables sin
-- sesión (anon) y devolvían saldo pendiente, activos sin devolver e
-- incidencias abiertas de CUALQUIER hotel con sólo adivinar/conocer el
-- UUID de una estancia. SECURITY DEFINER corre como el dueño de la
-- función y por eso ignora RLS por completo -- exactamente la razón por
-- la que cada función SECURITY DEFINER de este proyecto que toca datos
-- multi-tenant debe validar has_permission() ella misma (ver deactivate_room(),
-- 0041, y todo 0026/0037): RLS no está ahí para protegerla.
--
-- Fix: mismo patrón que deactivate_room() -- derivar hotel_id de la fila
-- (a partir de stay_id, con "for update"/"if not found") y validar
-- has_permission() antes de devolver cualquier dato. No se acepta
-- hotel_id como parámetro separado (podría desalinearse del stay_id
-- real). Permisos elegidos por consistencia con la acción que cada
-- función precede: can_deliver_room() es el pre-check de deliver_room()
-- (checkin.perform); check_out_readiness() es el pre-check de
-- attempt_check_out() (checkout.perform). No se tocó nada más del cuerpo
-- de ninguna de las dos funciones.

create or replace function public.can_deliver_room(p_stay_id uuid)
returns table (allowed boolean, reason text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_stay public.stays;
  v_entrega_permite_saldo boolean;
  v_balance numeric;
begin
  select * into v_stay from public.stays where id = p_stay_id;
  if not found then raise exception 'STAY_NOT_FOUND'; end if;

  if not public.has_permission(v_stay.hotel_id, 'checkin.perform') then
    raise exception 'PERMISSION_DENIED: checkin.perform required' using errcode = '42501';
  end if;

  select sa.balance into v_balance
  from public.stay_accounts sa
  where sa.stay_id = v_stay.id;

  select rs.entrega_permite_saldo into v_entrega_permite_saldo
  from public.reception_settings rs where rs.hotel_id = v_stay.hotel_id;

  if not coalesce(v_entrega_permite_saldo, false) and coalesce(v_balance, 0) > 0 then
    return query select false, 'Saldo pendiente de ' || v_balance::text;
  end if;

  return query select true, null::text;
end;
$$;

create or replace function public.check_out_readiness(p_stay_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_stay public.stays;
  v_balance numeric;
  v_bloquear_saldo boolean;
  v_blockers text[] := array[]::text[];
  v_assets_sin_devolver integer;
  v_incidencias_abiertas integer;
begin
  select * into v_stay from public.stays where id = p_stay_id;
  if not found then raise exception 'STAY_NOT_FOUND'; end if;

  if not public.has_permission(v_stay.hotel_id, 'checkout.perform') then
    raise exception 'PERMISSION_DENIED: checkout.perform required' using errcode = '42501';
  end if;

  select sa.balance into v_balance
  from public.stay_accounts sa
  where sa.stay_id = v_stay.id;

  select rs.bloquear_checkout_saldo into v_bloquear_saldo
  from public.reception_settings rs where rs.hotel_id = v_stay.hotel_id;

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
