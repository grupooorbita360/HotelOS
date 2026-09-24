-- HotelOS / Reservaciones: fuente única de precio, Tier 2 (auditoría
-- externa -- ver CLAUDE.md, sección "Fuente única de precio").
--
-- Confirmado antes de tocar esta política (pedido explícito): la política
-- actual de quote_options (0012, endurecida en 0044) YA exige
-- created_by = auth.uid() AND has_permission(hotel_id, 'reservations.create')
-- en el WITH CHECK -- no sólo created_by. Lo que seguía abierto: un caller
-- con ese permiso legítimo, dentro de su propio hotel, podía saltarse el
-- Server Action y pegar directo a PostgREST con un `total` fabricado que
-- nunca pasó por el cálculo real (Tier 1). A diferencia del residual ya
-- aceptado en 0037 para upsert_hotel_priority() (un título/mensaje
-- inventado, puramente informativo), éste sí tiene dinero de por medio.
--
-- Se cierra con el mismo patrón que inventory_holds/inventory_blocks/
-- reservations (0013/0015/0016): se retira la política de escritura del
-- cliente y el único camino para insertar pasa a ser una función
-- SECURITY DEFINER. A diferencia de Tier 1 (que sólo dejó de CONFIAR en un
-- total ya calculado por el cliente), aquí el cálculo mismo se mueve
-- POR COMPLETO a esta función -- mismo criterio que 0037 aplicó a
-- priority_score ("tener el mismo cálculo en dos lenguajes sólo servía
-- para que el del cliente fuera el que un caller malicioso podía
-- ignorar"): un caller que invoque este RPC directo ya no tiene ningún
-- parámetro de precio que inyectar -- sólo nightly_rate_override
-- (la tarifa negociada legítima, igual que hoy), y el total sale siempre
-- de room_types.base_rate + hotel_policies.iva_porcentaje resueltos aquí
-- mismo. Por eso src/lib/pricing.ts (calculateStayPrice(), Tier 1) queda
-- sin caller y se borra -- mismo destino que scoring.ts en 0037.
--
-- hotel_id se deriva de la fila de `quotes` (que ya existe cuando se pide
-- esta función -- createQuote() la inserta primero, sin cambios), nunca de
-- un parámetro suelto que el caller pudiera desalinear (lección 0040/0043).

drop policy if exists "quote_options_write_reservations_create_or_platform_admin" on public.quote_options;

comment on table public.quote_options is
  'Una alternativa cotizada dentro de una Cotizacion (fechas + tipo + tarifa especificos). Inmutable igual que la Cotizacion que la contiene. Sin política de INSERT/UPDATE para el cliente (0048, Tier 2 de fuente única de precio) -- el único camino de escritura es create_quote_option() (SECURITY DEFINER), que calcula subtotal/taxes/total server-side y no acepta ninguno de los tres como parámetro.';

create or replace function public.create_quote_option(
  p_quote_id uuid,
  p_room_type_id uuid,
  p_check_in date,
  p_check_out date,
  p_adults integer default 1,
  p_children integer default 0,
  p_has_pets boolean default false,
  p_nightly_rate_override numeric default null
)
returns public.quote_options
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_hotel_id uuid;
  v_base_rate numeric;
  v_iva_porcentaje numeric;
  v_nights integer;
  v_nightly_rate_used numeric;
  v_total numeric;
  v_subtotal numeric;
  v_taxes numeric;
  v_option public.quote_options;
begin
  select hotel_id into v_hotel_id from public.quotes where id = p_quote_id;
  if not found then
    raise exception 'QUOTE_NOT_FOUND';
  end if;

  if not public.has_permission(v_hotel_id, 'reservations.create') then
    raise exception 'PERMISSION_DENIED: reservations.create required' using errcode = '42501';
  end if;

  if p_check_out <= p_check_in then
    raise exception 'INVALID_DATE_RANGE';
  end if;

  select base_rate into v_base_rate
  from public.room_types
  where id = p_room_type_id and hotel_id = v_hotel_id;
  if not found then
    raise exception 'ROOM_TYPE_NOT_FOUND_FOR_HOTEL';
  end if;

  select iva_porcentaje into v_iva_porcentaje
  from public.hotel_policies
  where hotel_id = v_hotel_id;
  if not found then
    raise exception 'HOTEL_POLICIES_NOT_FOUND';
  end if;

  -- Mismo cálculo que calculateStayPrice()/calculateTaxBreakdown()
  -- (src/lib/tax.ts) -- éste es ahora el único lugar donde vive: un
  -- caller que invoque el RPC directo no tiene forma de fabricar el total,
  -- sólo puede pedir una tarifa negociada distinta (p_nightly_rate_override),
  -- que pasa por el mismo cálculo que la tarifa de lista.
  v_nights := greatest(1, p_check_out - p_check_in);
  v_nightly_rate_used := coalesce(p_nightly_rate_override, v_base_rate);
  v_total := round(v_nightly_rate_used * v_nights, 2);
  v_subtotal := round(v_total / (1 + v_iva_porcentaje / 100), 2);
  v_taxes := round(v_total - v_subtotal, 2);

  insert into public.quote_options (
    hotel_id, quote_id, room_type_id, check_in, check_out,
    adults, children, has_pets, subtotal, taxes, total, created_by
  ) values (
    v_hotel_id, p_quote_id, p_room_type_id, p_check_in, p_check_out,
    p_adults, p_children, p_has_pets, v_subtotal, v_taxes, v_total, auth.uid()
  ) returning * into v_option;

  return v_option;
end;
$func$;

comment on function public.create_quote_option(uuid, uuid, date, date, integer, integer, boolean, numeric) is
  'Único camino de escritura a quote_options (0048, Tier 2 de fuente única de precio): calcula subtotal/taxes/total server-side a partir de room_types.base_rate + hotel_policies.iva_porcentaje -- ningún parámetro de precio ya hecho, sólo p_nightly_rate_override (tarifa negociada legítima). hotel_id se deriva de la fila de quotes, nunca de un parámetro suelto.';

revoke execute on function public.create_quote_option(uuid, uuid, date, date, integer, integer, boolean, numeric) from public;
revoke execute on function public.create_quote_option(uuid, uuid, date, date, integer, integer, boolean, numeric) from anon;
grant execute on function public.create_quote_option(uuid, uuid, date, date, integer, integer, boolean, numeric) to authenticated;
