-- HotelOS: cierre del pendiente de Ajuste 02.1 -- las dos primitivas
-- internas del motor (upsert_hotel_priority(), auto_resolve_stale_
-- priorities()) todavía validaban únicamente "pertenece al hotel"
-- (p_hotel_id in user_hotel_ids() or is_platform_admin()), lo que
-- seguía permitiendo que cualquier miembro autenticado del hotel -- con
-- o sin priorities.manage -- las invocara directo por REST y (a)
-- auto-resolviera de golpe todas las prioridades activas de una regla
-- con una lista vacía, o (b) sobrescribiera título/mensaje/impacto de
-- una alerta activa reconstruyendo su dedupe_key vía la rama
-- ON CONFLICT DO UPDATE.
--
-- Cierre: ambas funciones ahora exigen que la llamada venga
-- autenticada como el rol `service_role` de Postgres (auth.role() =
-- 'service_role'), reemplazando por completo el chequeo anterior --
-- nunca apilado encima, porque auth.uid() viene NULL para una llamada
-- de service_role y el chequeo viejo (basado en user_hotel_ids())
-- quedaría siempre falso para el único caller legítimo. No se agrega
-- infraestructura nueva: service_role ya existe en el proyecto
-- (src/lib/supabase/admin.ts) y sigue teniendo el mismo uso acotado de
-- siempre (nunca para atender una petición de usuario normal) -- aquí
-- se usa exclusivamente para estas dos escrituras internas del motor,
-- que ahora sale con ese cliente en vez del cliente de sesión (ver
-- src/modules/priorities/engine.ts). Las lecturas del motor (catálogo
-- de reglas, evaluadores) siguen con el cliente de sesión del usuario,
-- respetando RLS igual que siempre -- esto no cambia quién puede
-- disparar la evaluación de reglas (cualquier miembro del hotel, sin
-- necesitar priorities.manage), sólo con qué credencial sale la
-- escritura final.

create or replace function public.upsert_hotel_priority(
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
  if auth.role() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: service_role required' using errcode = '42501';
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
  'Único camino de INSERT en hotel_priorities. Sólo ejecutable por service_role (auth.role() = ''service_role'') -- ningún usuario autenticado normal, tenga o no priorities.manage, puede invocarla directo (ver Ajuste 02.1, cierre de pendiente). Sale desde engine.ts con createAdminClient(), nunca con el cliente de sesión. severity/priority_score/category/source_module se derivan siempre de hotel_rules (0037); dedupe_key se valida contra el prefijo del código de la regla; source_event_id contra el hotel real.';

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
  if auth.role() <> 'service_role' then
    raise exception 'PERMISSION_DENIED: service_role required' using errcode = '42501';
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

comment on function public.auto_resolve_stale_priorities is
  'Cierra como RESOLVED (auto_resolved=true) las prioridades activas de una regla cuyo dedupe_key ya no aparece entre las condiciones vigentes que evaluó el motor. Sólo ejecutable por service_role (mismo cierre que upsert_hotel_priority, ver Ajuste 02.1) -- antes cualquier miembro del hotel podía llamarla directo con una lista vacía y auto-resolver de golpe todas las prioridades activas de una regla.';

-- Los grants a `authenticated` de 0036/0037 quedan sin efecto práctico
-- (el chequeo interno ya rechaza cualquier llamada que no sea
-- service_role), pero se retiran explícitamente para que el propio
-- catálogo de privilegios de Postgres sea honesto con la intención: un
-- usuario normal ni siquiera debería tener EXECUTE. service_role no
-- necesita un grant explícito en Supabase (ya tiene acceso amplio a
-- nivel de plataforma), pero se otorga de todos modos para que este
-- proyecto nunca dependa de un comportamiento implícito no documentado
-- aquí.
revoke execute on function public.upsert_hotel_priority(
  uuid, uuid, text, uuid, text, text, text, text, jsonb, text, text, uuid, numeric, numeric
) from authenticated;
grant execute on function public.upsert_hotel_priority(
  uuid, uuid, text, uuid, text, text, text, text, jsonb, text, text, uuid, numeric, numeric
) to service_role;

revoke execute on function public.auto_resolve_stale_priorities(uuid, uuid, text[]) from authenticated;
grant execute on function public.auto_resolve_stale_priorities(uuid, uuid, text[]) to service_role;
