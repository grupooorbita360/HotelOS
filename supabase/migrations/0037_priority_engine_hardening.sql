-- HotelOS: endurecimiento y cierre del Motor de Prioridades V1 (Ajuste
-- 02.1). NO rediseña hotel_rules/hotel_priorities ni cambia el
-- comportamiento funcional validado en 0036 (dedupe/auto-resolve/primera
-- regla) -- sólo cierra las fronteras de seguridad que 0036 dejó
-- abiertas:
--
--   1) upsert_hotel_priority()/auto_resolve_stale_priorities() sólo
--      validaban pertenencia al hotel, no que el caller fuera realmente
--      el motor -- cualquier miembro autenticado podía invocarlas por
--      REST y fabricar severity/priority_score/category/source_module
--      arbitrarios. Estos cuatro campos ahora se derivan SIEMPRE de
--      hotel_rules (el catálogo, controlado por platform_admin), nunca
--      del caller. dedupe_key se valida contra el prefijo "rule.code:" y
--      source_event_id contra el hotel real, cerrando el resto de la
--      superficie de fabricación listada en la tarea.
--   2) hotel_priorities tenía una política de UPDATE amplia
--      (con priorities.manage se podía hacer UPDATE de CUALQUIER
--      columna, incluyendo rule_id/severity/priority_score/dedupe_key/
--      detected_at/auto_resolved). Se retira esa política por completo
--      (mismo patrón que la ausencia de política de INSERT en esta misma
--      tabla desde 0036): las transiciones humanas ahora sólo existen
--      como 5 funciones SECURITY DEFINER dedicadas, una por transición,
--      igual que check_in()/assign_room()/mark_no_show() en 0026 --
--      Postgres vuelve a ser la autoridad final, no sólo la Server
--      Action.
--
-- Nada de esto agrega infraestructura nueva (sin workers/colas/cron/
-- service_role): son funciones SECURITY DEFINER adicionales, mismo
-- patrón ya usado en todo el proyecto.

-- ============================================================
-- 1) Transiciones humanas: RPCs dedicadas, RLS de UPDATE retirada
-- ============================================================

-- Ya no hay UPDATE de cliente permitido sobre hotel_priorities -- ni
-- siquiera para quien tiene priorities.manage. Las 5 funciones de abajo
-- son ahora el único camino de escritura para las transiciones humanas
-- (mismo patrón que la ausencia de política de INSERT ya documentada en
-- 0036 para esta tabla).
drop policy if exists "hotel_priorities_update_manage_or_platform_admin" on public.hotel_priorities;

-- OPEN -> ACKNOWLEDGED
create or replace function public.acknowledge_hotel_priority(p_priority_id uuid)
returns public.hotel_priorities
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.hotel_priorities;
begin
  select * into v_row from public.hotel_priorities where id = p_priority_id for update;
  if not found then raise exception 'PRIORITY_NOT_FOUND'; end if;
  if not public.has_permission(v_row.hotel_id, 'priorities.manage') then
    raise exception 'PERMISSION_DENIED: priorities.manage required' using errcode = '42501';
  end if;
  if v_row.status <> 'OPEN' then
    raise exception 'INVALID_TRANSITION: priority status is %, expected "OPEN"', v_row.status;
  end if;

  update public.hotel_priorities set status = 'ACKNOWLEDGED', acknowledged_at = now()
  where id = p_priority_id
  returning * into v_row;
  return v_row;
end;
$$;

comment on function public.acknowledge_hotel_priority(uuid) is
  'Transición humana OPEN -> ACKNOWLEDGED. Única vía de escritura para este cambio -- hotel_priorities ya no acepta UPDATE directo del cliente.';

-- OPEN/ACKNOWLEDGED -> ASSIGNED. assigned_to debe pertenecer al MISMO
-- hotel de la prioridad (garantía de dominio, no sólo de UI).
create or replace function public.assign_hotel_priority(p_priority_id uuid, p_assignee_user_id uuid)
returns public.hotel_priorities
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.hotel_priorities;
begin
  select * into v_row from public.hotel_priorities where id = p_priority_id for update;
  if not found then raise exception 'PRIORITY_NOT_FOUND'; end if;
  if not public.has_permission(v_row.hotel_id, 'priorities.manage') then
    raise exception 'PERMISSION_DENIED: priorities.manage required' using errcode = '42501';
  end if;
  if v_row.status not in ('OPEN', 'ACKNOWLEDGED') then
    raise exception 'INVALID_TRANSITION: priority status is %, expected "OPEN" or "ACKNOWLEDGED"', v_row.status;
  end if;
  if not exists (
    select 1 from public.user_hotel_roles
    where user_id = p_assignee_user_id and hotel_id = v_row.hotel_id and is_active
  ) then
    raise exception 'ASSIGNEE_NOT_IN_HOTEL: el usuario asignado debe tener un rol activo en el mismo hotel';
  end if;

  update public.hotel_priorities set status = 'ASSIGNED', assigned_to = p_assignee_user_id
  where id = p_priority_id
  returning * into v_row;
  return v_row;
end;
$$;

comment on function public.assign_hotel_priority(uuid, uuid) is
  'Transición humana OPEN/ACKNOWLEDGED -> ASSIGNED. Valida que assigned_to tenga un rol activo en el mismo hotel de la prioridad -- nunca se puede asignar a alguien de otro hotel.';

-- OPEN/ACKNOWLEDGED/ASSIGNED -> IN_PROGRESS
create or replace function public.start_hotel_priority_progress(p_priority_id uuid)
returns public.hotel_priorities
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.hotel_priorities;
begin
  select * into v_row from public.hotel_priorities where id = p_priority_id for update;
  if not found then raise exception 'PRIORITY_NOT_FOUND'; end if;
  if not public.has_permission(v_row.hotel_id, 'priorities.manage') then
    raise exception 'PERMISSION_DENIED: priorities.manage required' using errcode = '42501';
  end if;
  if v_row.status not in ('OPEN', 'ACKNOWLEDGED', 'ASSIGNED') then
    raise exception 'INVALID_TRANSITION: priority status is %, expected an active pre-progress status', v_row.status;
  end if;

  update public.hotel_priorities set status = 'IN_PROGRESS'
  where id = p_priority_id
  returning * into v_row;
  return v_row;
end;
$$;

comment on function public.start_hotel_priority_progress(uuid) is
  'Transición humana OPEN/ACKNOWLEDGED/ASSIGNED -> IN_PROGRESS.';

-- Cualquier estado activo -> RESOLVED. Nunca reabre un estado terminal.
create or replace function public.resolve_hotel_priority(p_priority_id uuid, p_reason text default null)
returns public.hotel_priorities
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.hotel_priorities;
begin
  select * into v_row from public.hotel_priorities where id = p_priority_id for update;
  if not found then raise exception 'PRIORITY_NOT_FOUND'; end if;
  if not public.has_permission(v_row.hotel_id, 'priorities.manage') then
    raise exception 'PERMISSION_DENIED: priorities.manage required' using errcode = '42501';
  end if;
  if v_row.status not in ('OPEN', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS') then
    raise exception 'INVALID_TRANSITION: priority status is %, already terminal', v_row.status;
  end if;

  update public.hotel_priorities
  set status = 'RESOLVED', resolved_at = now(), resolved_by = auth.uid(),
      auto_resolved = false, resolution_reason = p_reason
  where id = p_priority_id
  returning * into v_row;
  return v_row;
end;
$$;

comment on function public.resolve_hotel_priority(uuid, text) is
  'Cierre manual: la condición se corrigió. Cualquier estado activo -> RESOLVED; nunca reabre RESOLVED/DISMISSED (son terminales).';

-- Cualquier estado activo -> DISMISSED. Motivo obligatorio validado en
-- Postgres, no sólo en TypeScript (antes sólo existía `if (!reason.trim())`
-- en lifecycle.ts, saltable con un UPDATE directo).
create or replace function public.dismiss_hotel_priority(p_priority_id uuid, p_reason text)
returns public.hotel_priorities
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.hotel_priorities;
begin
  select * into v_row from public.hotel_priorities where id = p_priority_id for update;
  if not found then raise exception 'PRIORITY_NOT_FOUND'; end if;
  if not public.has_permission(v_row.hotel_id, 'priorities.manage') then
    raise exception 'PERMISSION_DENIED: priorities.manage required' using errcode = '42501';
  end if;
  if v_row.status not in ('OPEN', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS') then
    raise exception 'INVALID_TRANSITION: priority status is %, already terminal', v_row.status;
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'DISMISS_REASON_REQUIRED: descartar una prioridad requiere un motivo';
  end if;

  update public.hotel_priorities
  set status = 'DISMISSED', resolved_at = now(), resolved_by = auth.uid(),
      auto_resolved = false, resolution_reason = p_reason
  where id = p_priority_id
  returning * into v_row;
  return v_row;
end;
$$;

comment on function public.dismiss_hotel_priority(uuid, text) is
  'Cierre manual sin corregir la condición. Motivo obligatorio (rechazado por Postgres, no sólo por TypeScript) -- conserva quién (resolved_by), cuándo (resolved_at) y por qué (resolution_reason), mismas columnas que RESOLVED (ver comentario en 0036 sobre por qué no se duplican).';

grant execute on function public.acknowledge_hotel_priority(uuid) to authenticated;
grant execute on function public.assign_hotel_priority(uuid, uuid) to authenticated;
grant execute on function public.start_hotel_priority_progress(uuid) to authenticated;
grant execute on function public.resolve_hotel_priority(uuid, text) to authenticated;
grant execute on function public.dismiss_hotel_priority(uuid, text) to authenticated;

-- ============================================================
-- 2) Primitivas internas del motor: ya no aceptan campos fabricables
-- ============================================================

-- upsert_hotel_priority() cambia de firma: se quitan p_severity,
-- p_category, p_source_module y p_priority_score -- ya no son
-- parámetros, es imposible pasarlos. Se derivan siempre de hotel_rules
-- (catálogo controlado por platform_admin) a partir de p_rule_id, que a
-- su vez ahora se valida que exista y aplique al hotel (global o de ese
-- hotel) y esté activo. Se requiere DROP porque cambia el número de
-- parámetros (create or replace no permite esto).
drop function if exists public.upsert_hotel_priority(
  uuid, uuid, text, text, uuid, text, text, integer, text, text, text, text, jsonb, text, text, uuid, numeric, numeric
);

create function public.upsert_hotel_priority(
  p_hotel_id uuid,
  p_rule_id uuid,
  p_reference_type text,
  p_reference_id uuid,
  p_title text,
  p_message text,
  p_action_label text default null,
  p_action_route text default null,
  p_action_context jsonb default '{}'::jsonb,
  p_dedupe_key text default null,
  p_group_key text default null,
  p_source_event_id uuid default null,
  p_impact_value numeric default null,
  p_impact_amount numeric default null
)
returns table (out_priority_id uuid, out_status text, out_is_new boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rule public.hotel_rules;
  v_score integer;
begin
  if not (p_hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin()) then
    raise exception 'PERMISSION_DENIED: not a member of this hotel' using errcode = '42501';
  end if;

  select * into v_rule from public.hotel_rules
  where id = p_rule_id and (hotel_id is null or hotel_id = p_hotel_id);
  if not found then
    raise exception 'RULE_NOT_FOUND: rule % does not exist or does not apply to this hotel', p_rule_id;
  end if;
  if not v_rule.is_active then
    raise exception 'RULE_NOT_ACTIVE: rule % is not active', v_rule.code;
  end if;

  if p_dedupe_key is null or p_dedupe_key = '' then
    raise exception 'DEDUPE_KEY_REQUIRED';
  end if;
  if p_dedupe_key not like (v_rule.code || ':%') then
    raise exception 'DEDUPE_KEY_RULE_MISMATCH: dedupe_key must start with "%:"', v_rule.code;
  end if;

  if p_source_event_id is not null and not exists (
    select 1 from public.timeline_events where id = p_source_event_id and hotel_id = p_hotel_id
  ) then
    raise exception 'SOURCE_EVENT_NOT_IN_HOTEL';
  end if;

  -- severity/priority_score/category/source_module NUNCA vienen del
  -- caller (ver AJUSTE 02.1): siempre se derivan de v_rule, la misma
  -- fórmula que antes vivía en src/modules/priorities/scoring.ts
  -- (computePriorityScore), ahora la única fuente de verdad porque
  -- calcularla en el cliente permitía que cualquier caller mandara el
  -- resultado que quisiera junto con el resto de los parámetros.
  v_score := (
    case v_rule.severity
      when 'low' then 10 when 'medium' then 20 when 'high' then 30 when 'critical' then 40 else 0
    end
  ) + v_rule.priority_weight;

  return query
  insert into public.hotel_priorities (
    hotel_id, rule_id, source_module, reference_type, reference_id,
    category, severity, priority_score, title, message,
    action_label, action_route, action_context,
    dedupe_key, group_key, source_event_id, impact_value, impact_amount,
    status, detected_at
  ) values (
    p_hotel_id, v_rule.id, v_rule.module, p_reference_type, p_reference_id,
    v_rule.category, v_rule.severity, v_score, p_title, p_message,
    p_action_label, p_action_route, coalesce(p_action_context, '{}'::jsonb),
    p_dedupe_key, p_group_key, p_source_event_id, p_impact_value, p_impact_amount,
    'OPEN', now()
  )
  on conflict (dedupe_key) where hotel_priorities.status in ('OPEN', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS')
  do update set
    severity = excluded.severity,
    priority_score = excluded.priority_score,
    title = excluded.title,
    message = excluded.message,
    action_label = excluded.action_label,
    action_route = excluded.action_route,
    action_context = excluded.action_context,
    impact_value = excluded.impact_value,
    impact_amount = excluded.impact_amount,
    updated_at = now()
  returning hotel_priorities.id, hotel_priorities.status, (xmax = 0);
end;
$$;

comment on function public.upsert_hotel_priority is
  'Único camino de INSERT en hotel_priorities. severity/priority_score/category/source_module se derivan SIEMPRE de hotel_rules (nunca del caller) -- cierra la fabricación arbitraria de esos campos que existía en la firma original de 0036. dedupe_key se valida contra el prefijo del código de la regla; source_event_id contra el hotel real.';

grant execute on function public.upsert_hotel_priority(
  uuid, uuid, text, uuid, text, text, text, text, jsonb, text, text, uuid, numeric, numeric
) to authenticated;

-- auto_resolve_stale_priorities(): misma firma (no rompe el contrato con
-- el motor), pero ahora valida que p_rule_id exista y aplique al hotel
-- -- mismo criterio de defensa en profundidad que upsert_hotel_priority,
-- por consistencia (antes sólo lo validaba la FK al hacer el UPDATE, sin
-- un mensaje de error explícito).
create or replace function public.auto_resolve_stale_priorities(
  p_hotel_id uuid,
  p_rule_id uuid,
  p_active_dedupe_keys text[]
)
returns table (out_priority_id uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (p_hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin()) then
    raise exception 'PERMISSION_DENIED: not a member of this hotel' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.hotel_rules
    where id = p_rule_id and (hotel_id is null or hotel_id = p_hotel_id)
  ) then
    raise exception 'RULE_NOT_FOUND: rule % does not exist or does not apply to this hotel', p_rule_id;
  end if;

  return query
  update public.hotel_priorities
  set status = 'RESOLVED',
      resolved_at = now(),
      auto_resolved = true,
      resolution_reason = 'La condición ya no se cumple (auto-resuelto por el motor de reglas)',
      updated_at = now()
  where hotel_id = p_hotel_id
    and rule_id = p_rule_id
    and status in ('OPEN', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS')
    and not (dedupe_key = any(coalesce(p_active_dedupe_keys, array[]::text[])))
  returning hotel_priorities.id;
end;
$$;
