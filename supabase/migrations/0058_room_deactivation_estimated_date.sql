-- HotelOS / Habitaciones: fecha estimada de entrega al desactivar una
-- habitación (P1-12, handoff de demo P1 Tanda 2).
--
-- El pedido fue explícito en no duplicar motivo_inactivacion/inactive_at/
-- inactive_by (0041, ya obligatorios y ya fijados sólo por deactivate_room())
-- -- se reutilizan tal cual. Lo único genuinamente nuevo es una fecha
-- estimada de cuándo la habitación vuelve a estar disponible (no existía
-- ningún campo equivalente, verificado contra el esquema real antes de
-- escribir esto). Aditivo sobre `rooms` en producción con datos reales:
-- nullable, sin default distinto de NULL, ninguna fila existente cambia.
--
-- No se construye el módulo de Mantenimiento completo (pedido explícito):
-- sólo el campo de captura + que quede visible en la habitación, igual que
-- motivo_inactivacion.

alter table public.rooms add column estimated_available_at date;

comment on column public.rooms.estimated_available_at is
  'Fecha estimada de regreso a servicio, opcional. Igual que motivo_inactivacion, sólo la fija deactivate_room() -- nunca UPDATE directo -- y reactivate_room() la limpia. NULL mientras la habitación esté activa o si nadie dio una estimación al desactivar.';

-- create or replace no basta: agregar un parámetro cambia la firma
-- (uuid, text) -> (uuid, text, date), y Postgres trataría eso como un
-- OVERLOAD nuevo en vez de un reemplazo -- quedarían las dos funciones
-- vivas a la vez (mismo cuidado ya aplicado en 0037/0047/0052: "se quita/
-- agrega de la firma, nunca sólo se ignora"). Se elimina la firma vieja
-- explícitamente antes de recrear.
drop function public.deactivate_room(uuid, text);

create or replace function public.deactivate_room(p_room_id uuid, p_reason text, p_estimated_available_at date default null)
returns public.rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_blocking_count integer;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if not public.has_permission(v_room.hotel_id, 'hotel.settings.manage') then
    raise exception 'PERMISSION_DENIED: hotel.settings.manage required' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'DEACTIVATION_REASON_REQUIRED: desactivar una habitación requiere un motivo';
  end if;
  if not v_room.is_active then
    raise exception 'INVALID_TRANSITION: la habitación ya está inactiva';
  end if;

  select count(*) into v_blocking_count
  from public.room_assignments
  where room_id = p_room_id and released_at is null;

  if v_blocking_count > 0 then
    raise exception 'IMPACT_BLOCKING: % asignación(es) activa(s) dependen de esta habitación -- resuélvelas antes de desactivar', v_blocking_count;
  end if;

  update public.rooms
  set is_active = false,
      motivo_inactivacion = p_reason,
      inactive_at = now(),
      inactive_by = auth.uid(),
      estimated_available_at = p_estimated_available_at
  where id = p_room_id
  returning * into v_room;

  return v_room;
end;
$$;

comment on function public.deactivate_room(uuid, text, date) is
  'Desactiva una Habitacion tras ImpactAnalysis simplificado (SAFE/BLOQUEANTE): rechaza si hay una asignación física activa (room_assignments) dependiendo de ella. Motivo obligatorio; fecha estimada de entrega opcional (P1-12, handoff de demo P1 Tanda 2) -- ambos fijados siempre por esta función, nunca a mano.';

revoke execute on function public.deactivate_room(uuid, text, date) from public;
revoke execute on function public.deactivate_room(uuid, text, date) from anon;
grant execute on function public.deactivate_room(uuid, text, date) to authenticated;

create or replace function public.reactivate_room(p_room_id uuid)
returns public.rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if not public.has_permission(v_room.hotel_id, 'hotel.settings.manage') then
    raise exception 'PERMISSION_DENIED: hotel.settings.manage required' using errcode = '42501';
  end if;
  if v_room.is_active then
    raise exception 'INVALID_TRANSITION: la habitación ya está activa';
  end if;

  update public.rooms
  set is_active = true,
      motivo_inactivacion = null,
      inactive_at = null,
      inactive_by = null,
      estimated_available_at = null
  where id = p_room_id
  returning * into v_room;

  return v_room;
end;
$$;

comment on function public.reactivate_room(uuid) is
  'Reactivar nunca requiere ImpactAnalysis (siempre SAFE) -- limpia motivo_inactivacion/inactive_at/inactive_by/estimated_available_at.';
