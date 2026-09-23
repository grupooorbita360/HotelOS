-- HotelOS / Reservaciones: el precio deja de ser editable libremente al
-- cotizar (handoff de demo, P0-7).
--
-- Hasta ahora create_quote_option() (0048) aceptaba p_nightly_rate_override
-- de cualquier usuario con reservations.create, sin motivo ni distinción
-- entre "tarifa negociada legítima" y "descuento/cortesía discrecional" --
-- cualquier front_desk podía cotizar al precio que quisiera con sólo
-- escribirlo en el campo. Se cierra con el mismo patrón temporal ya
-- decidido para Caja (0046, cash.refund/cash.adjust): un permiso nuevo,
-- simple, sembrado sólo a hotel_admin (no a front_desk) -- cuando exista
-- PermisoExcepcion como módulo formal, esto se conecta ahí, no antes.
--
-- p_nightly_rate_override NO se elimina de la firma (sigue siendo la
-- misma tarifa negociada de siempre) -- lo que cambia es que ahora, si el
-- caller manda un override distinto de base_rate, o pide cortesía, la
-- función exige (a) has_permission(hotel_id, 'reservations.discount') y
-- (b) un motivo no vacío. Cortesía (p_is_courtesy) es un caso nuevo:
-- nightly_rate_used = 0, con la misma exigencia de permiso + motivo.
-- "Quién autorizó" no necesita columna nueva: quote_options.created_by
-- (0044) ya es auth.uid() del caller, que es el mismo que pasó el gate de
-- permiso aquí -- motivo/monto/cortesía se registran en el payload del
-- evento de timeline (createQuote(), TypeScript), igual que el resto del
-- proyecto usa timeline_events como la auditoría de negocio, no columnas
-- nuevas en la tabla de datos (regla 6).

drop function public.create_quote_option(uuid, uuid, date, date, integer, integer, boolean, numeric);

create or replace function public.create_quote_option(
  p_quote_id uuid,
  p_room_type_id uuid,
  p_check_in date,
  p_check_out date,
  p_adults integer default 1,
  p_children integer default 0,
  p_has_pets boolean default false,
  p_nightly_rate_override numeric default null,
  p_is_courtesy boolean default false,
  p_discount_reason text default null
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

  -- P0-7: un override que en verdad cambie el precio (o una cortesía)
  -- deja de ser gratis -- exige permiso explícito + motivo. Un override
  -- que casualmente manda el mismo valor que base_rate no cuenta como
  -- descuento (no hay nada que autorizar).
  if p_is_courtesy or (p_nightly_rate_override is not null and p_nightly_rate_override <> v_base_rate) then
    if not public.has_permission(v_hotel_id, 'reservations.discount') then
      raise exception 'PERMISSION_DENIED: reservations.discount required' using errcode = '42501';
    end if;
    if p_discount_reason is null or btrim(p_discount_reason) = '' then
      raise exception 'DISCOUNT_REASON_REQUIRED';
    end if;
  end if;

  v_nights := greatest(1, p_check_out - p_check_in);
  v_nightly_rate_used := case when p_is_courtesy then 0 else coalesce(p_nightly_rate_override, v_base_rate) end;
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

comment on function public.create_quote_option(uuid, uuid, date, date, integer, integer, boolean, numeric, boolean, text) is
  'Único camino de escritura a quote_options (0048/0052). Un override de precio distinto de base_rate, o una cortesía, exige has_permission(hotel_id, ''reservations.discount'') + motivo no vacío (P0-7, handoff de demo) -- decisión temporal, igual patrón que cash.refund/cash.adjust (0046) hasta que exista PermisoExcepcion formal.';

revoke execute on function public.create_quote_option(uuid, uuid, date, date, integer, integer, boolean, numeric, boolean, text) from public;
revoke execute on function public.create_quote_option(uuid, uuid, date, date, integer, integer, boolean, numeric, boolean, text) from anon;
grant execute on function public.create_quote_option(uuid, uuid, date, date, integer, integer, boolean, numeric, boolean, text) to authenticated;

-- ============================================================
-- Permiso nuevo: reservations.discount (sólo hotel_admin, no front_desk --
-- mismo criterio que cash.refund/cash.adjust en 0046).
-- ============================================================
insert into public.permissions (code, module, description) values
  ('reservations.discount', 'reservations', 'Autorizar un descuento o cortesía en una cotización')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name = 'hotel_admin' and r.hotel_id is null and p.code = 'reservations.discount'
on conflict do nothing;
