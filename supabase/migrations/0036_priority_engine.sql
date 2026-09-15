-- HotelOS: infraestructura transversal del motor de reglas (Mejora
-- transversal 02). Introduce el paso "REGLA -> PRIORIDAD -> NEXT ACTION"
-- del patrón de CLAUDE.md, hoy sólo cubierto hasta "EVENTO EN TIMELINE".
--
-- Dos tablas: hotel_rules (catálogo, config/metadata pura -- nunca código
-- ejecutable) y hotel_priorities (instancias reales detectadas). La
-- condición de cada regla vive en un evaluador de TypeScript versionado
-- (src/modules/priorities/evaluators/), nunca en SQL dinámico ni en un
-- campo de la tabla. Ver CLAUDE.md, sección "Motor de reglas y
-- Prioridades", para el razonamiento completo.

-- ============================================================
-- Catálogo de reglas
-- ============================================================
create table public.hotel_rules (
  id uuid primary key default gen_random_uuid(),
  -- NULL = regla global de HotelOS (el caso de hoy). Un valor = override
  -- de esa misma regla para un hotel concreto (futuro -- ver comentario
  -- de unicidad abajo). No se implementa todavía resolución de "regla
  -- efectiva" combinando global+override: sólo se deja el esquema listo.
  hotel_id uuid references public.hotels (id) on delete cascade,

  code text not null,
  module text not null,
  name text not null,
  description text,
  -- Categoría libre (ej. 'front_desk', 'housekeeping', 'commercial') --
  -- sin catálogo cerrado a propósito: nuevas reglas de módulos futuros
  -- no deben requerir ensanchar un check aquí, igual que
  -- timeline_events.module.
  category text not null,
  severity text not null check (severity in ('low', 'medium', 'high', 'critical')),
  priority_weight integer not null default 0,

  -- Rol típicamente responsable de atender esta prioridad (informativo,
  -- para una futura UI de asignación) -- NO es control de acceso. La
  -- visibilidad real ya la resuelve RLS por membresía de hotel (igual que
  -- reservations/stays/room_assignments): cualquier miembro del hotel ve
  -- sus prioridades. Se evitó agregar visible_roles como una segunda capa
  -- de visibilidad paralela a RLS -- habría duplicado la misma garantía
  -- con lógica de aplicación en vez de en Postgres.
  responsible_role text,
  allows_assignment boolean not null default true,

  -- Reemplaza "auto_resolution_condition": nunca se guarda una condición
  -- ejecutable en el catálogo (regla no negociable de esta tarea). Esta
  -- bandera sólo declara si SE ESPERA que el evaluador de esta regla
  -- pueda auto-resolver (la lógica real vive en el evaluador de TS).
  supports_auto_resolution boolean not null default true,

  deduplicates boolean not null default true,
  -- Minutos mínimos entre que una ocurrencia se resuelve y puede volver a
  -- generarse una nueva para el mismo dedupe_key. Columna lista para
  -- cuando se implemente el enforcement (ver riesgos en CLAUDE.md); el
  -- motor v1 no lo aplica todavía.
  cooldown_minutes integer not null default 0,

  is_active boolean not null default true,
  version integer not null default 1,

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),

  unique (hotel_id, code)
);

comment on table public.hotel_rules is
  'Catálogo de reglas operativas (config/metadata). La condición real de cada regla vive en un evaluador de TypeScript versionado (src/modules/priorities/evaluators/), nunca aquí -- esta tabla nunca contiene código ejecutable ni SQL dinámico.';
comment on column public.hotel_rules.hotel_id is
  'NULL = regla global de HotelOS. Con valor = override futuro de esa regla para un hotel concreto (mismo patrón que roles.hotel_id). No se implementa resolución de herencia todavía.';

-- Mismo patrón que roles (0004): unique(hotel_id, code) no alcanza para
-- garantizar un solo code global, porque Postgres trata cada NULL como
-- distinto -- se refuerza con un índice parcial.
create unique index idx_hotel_rules_unique_global_code
  on public.hotel_rules (code)
  where hotel_id is null;

create trigger trg_hotel_rules_audit
  before insert or update on public.hotel_rules
  for each row execute function public.set_audit_fields();

-- ============================================================
-- Prioridades detectadas (instancias reales de una regla)
-- ============================================================
create table public.hotel_priorities (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  rule_id uuid not null references public.hotel_rules (id),

  -- Mismo vocabulario que timeline_events.module (ej. 'front_desk').
  source_module text not null,
  -- Qué entidad de negocio originó esto (ej. 'stay') + su id. Nullable:
  -- una futura regla agregada a nivel hotel (sin una sola entidad de
  -- referencia) debe poder existir sin inventar un id.
  reference_type text not null,
  reference_id uuid,

  category text not null,
  severity text not null check (severity in ('low', 'medium', 'high', 'critical')),
  -- severity_weight + rule.priority_weight, calculado en el motor (TS) al
  -- detectar/refrescar -- ver computePriorityScore(). Guardado para poder
  -- ordenar/filtrar sin recalcular (KPIs y Radar futuro). Determinista,
  -- sin IA ni forecasting; el dinero (impact_amount) nunca participa en
  -- este cálculo para que una oportunidad comercial no desplace una
  -- situación operativa crítica.
  priority_score integer not null default 0,

  title text not null,
  message text not null,

  -- Contrato de "qué debe hacer el usuario", pensado para deep-link
  -- futuro -- hoy action_route apunta a una pantalla existente (nunca una
  -- ruta nueva), sin garantía todavía de que abra exactamente el registro.
  action_label text,
  action_route text,
  action_context jsonb not null default '{}'::jsonb,

  status text not null default 'OPEN'
    check (status in ('OPEN', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'DISMISSED')),

  assigned_to uuid references auth.users (id),
  due_at timestamptz,

  detected_at timestamptz not null default now(),
  acknowledged_at timestamptz,

  -- Cierre terminal: cubre tanto RESOLVED como DISMISSED (un "dismiss" es
  -- un cierre manual sin que la condición se haya corregido) -- no se
  -- agregaron dismissed_at/dismissed_by/dismissal_reason por separado,
  -- serían las mismas tres columnas con otro nombre para el mismo
  -- concepto ("quién/cuándo/por qué se cerró"), justo lo que la regla 6
  -- de CLAUDE.md pide evitar. auto_resolved=false siempre en un dismiss
  -- (es siempre una acción manual).
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id),
  auto_resolved boolean not null default false,
  resolution_reason text,

  -- Deduplicación: ver índice único parcial abajo. Formato
  -- "RULE_CODE:referencia", ej. "ARRIVAL_NOT_REGISTERED:<stay_id>".
  dedupe_key text not null,
  -- Para consolidación futura de varias señales bajo una misma causa
  -- (NO implementado en esta etapa -- sólo queda soportado el campo).
  group_key text,

  -- Si esta prioridad se originó a partir de un evento ya existente en
  -- timeline_events. Nullable: varias prioridades surgen de evaluar
  -- estado, no de un evento puntual.
  source_event_id uuid references public.timeline_events (id),

  -- Preparado para reglas comerciales futuras; ninguna regla de esta
  -- etapa los usa (la primera regla es puramente operativa, sin dinero).
  impact_value numeric,
  impact_amount numeric(12, 2),

  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);

comment on table public.hotel_priorities is
  'Instancia real detectada de una hotel_rules: "algo pasó, alguien debe hacer algo". Nunca se borra (RESOLVED/DISMISSED son estados terminales, no un delete) -- es el historial que el futuro Radar 360 necesita.';
comment on column public.hotel_priorities.dedupe_key is
  'Identifica la MISMA ocurrencia lógica (ej. "ARRIVAL_NOT_REGISTERED:<stay_id>"). Único mientras la prioridad esté en un estado activo (ver índice parcial) -- permite que, tras resolverse, la misma condición pueda volver a generar una ocurrencia nueva sin chocar con la anterior.';
comment on column public.hotel_priorities.group_key is
  'Reservado para consolidar varias señales bajo una misma causa operacional (ej. 3 alertas de la misma habitación). Sin algoritmo de agrupación todavía -- sólo el campo.';

-- El corazón de la deduplicación: a lo más UNA prioridad activa por
-- dedupe_key. Habilita `insert ... on conflict (dedupe_key) where ...`
-- como upsert atómico real (ver upsert_hotel_priority() abajo) -- mismo
-- espíritu que los índices únicos parciales de inventory_blocks (0015)
-- para el Hold/Estancia.
create unique index idx_hotel_priorities_active_dedupe
  on public.hotel_priorities (dedupe_key)
  where status in ('OPEN', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS');

create index idx_hotel_priorities_hotel_status on public.hotel_priorities (hotel_id, status);
create index idx_hotel_priorities_hotel_rule_status on public.hotel_priorities (hotel_id, rule_id, status);
create index idx_hotel_priorities_source_event on public.hotel_priorities (source_event_id) where source_event_id is not null;

create trigger trg_hotel_priorities_audit
  before insert or update on public.hotel_priorities
  for each row execute function public.set_audit_fields();

-- ============================================================
-- RLS
-- ============================================================
alter table public.hotel_rules enable row level security;
alter table public.hotel_priorities enable row level security;

-- Reglas globales (hotel_id null) visibles para cualquier usuario
-- autenticado; overrides futuros de un hotel sólo visibles a sus
-- miembros. Escritura: sólo platform_admin en esta v1 -- no se construyó
-- un editor de reglas (fuera de alcance explícito), mismo criterio que
-- roles (0004/0006): "sólo el equipo de plataforma crea/edita".
create policy "hotel_rules_select_global_or_member_or_platform_admin"
  on public.hotel_rules for select
  to authenticated
  using (hotel_id is null or hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());

create policy "hotel_rules_write_platform_admin_only"
  on public.hotel_rules for all
  to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

-- Cualquier miembro del hotel ve sus prioridades (igual que
-- stays/reservations/room_assignments) -- esto ya cubre "Owner/Manager
-- visibilidad completa" sin necesitar un permiso nuevo sólo para leer.
create policy "hotel_priorities_select_member_or_platform_admin"
  on public.hotel_priorities for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());

-- Transiciones manuales (acknowledge/assign/resolve/dismiss) sí son una
-- acción de negocio privilegiada -> requieren priorities.manage. La
-- detección/dedupe/auto-resolve del motor NO pasa por aquí: corre en
-- upsert_hotel_priority()/auto_resolve_stale_priorities() (SECURITY
-- DEFINER), que sólo exigen pertenencia al hotel -- es comportamiento de
-- sistema, no una acción de negocio que deba estar detrás de un permiso
-- especial (mismo criterio que logTimelineEvent()).
create policy "hotel_priorities_update_manage_or_platform_admin"
  on public.hotel_priorities for update
  to authenticated
  using (public.is_platform_admin() or public.has_permission(hotel_id, 'priorities.manage'))
  with check (public.is_platform_admin() or public.has_permission(hotel_id, 'priorities.manage'));

-- Sin política de INSERT para el cliente: el único camino de escritura
-- inicial es upsert_hotel_priority() (SECURITY DEFINER, abajo) -- mismo
-- patrón que inventory_holds/inventory_blocks/reservations (0015/0016):
-- protege la garantía de deduplicación atómica de que un INSERT directo
-- del cliente podría saltarse. Sin política de DELETE nunca (el
-- historial no se borra).

-- ============================================================
-- Permiso nuevo
-- ============================================================
insert into public.permissions (code, module, description) values
  ('priorities.manage', 'priorities', 'Reconocer, asignar, resolver o descartar una prioridad detectada por HotelOS')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'priorities.manage'
where r.name in ('hotel_admin', 'front_desk') and r.hotel_id is null
on conflict do nothing;

-- ============================================================
-- Funciones SECURITY DEFINER: único camino de escritura del motor
-- ============================================================

-- Upsert atómico: si ya existe una prioridad ACTIVA con el mismo
-- dedupe_key, la refresca (nunca duplica); si no, crea una nueva OPEN.
-- xmax = 0 en el RETURNING es el modismo estándar de Postgres para saber
-- si la fila retornada vino de la rama INSERT o de la rama UPDATE del
-- ON CONFLICT -- se lo devolvemos al caller como is_new para que sólo
-- registre timeline_events en una detección genuinamente nueva (nunca en
-- cada evaluación del motor, ver CLAUDE.md).
create or replace function public.upsert_hotel_priority(
  p_hotel_id uuid,
  p_rule_id uuid,
  p_source_module text,
  p_reference_type text,
  p_reference_id uuid,
  p_category text,
  p_severity text,
  p_priority_score integer,
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
-- Los nombres de salida NO pueden llamarse igual que columnas de
-- hotel_priorities (ej. "status"): en plpgsql, returns table(...) crea
-- variables OUT visibles dentro de todo el cuerpo de la función, y
-- "status" dentro de la cláusula ON CONFLICT ... WHERE quedaría ambiguo
-- entre esa variable y la columna real de la tabla (error real,
-- encontrado probando esta migración contra Postgres local antes de
-- mandarla -- ver CLAUDE.md).
returns table (out_priority_id uuid, out_status text, out_is_new boolean)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (p_hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin()) then
    raise exception 'PERMISSION_DENIED: not a member of this hotel' using errcode = '42501';
  end if;
  if p_dedupe_key is null or p_dedupe_key = '' then
    raise exception 'DEDUPE_KEY_REQUIRED';
  end if;

  return query
  insert into public.hotel_priorities (
    hotel_id, rule_id, source_module, reference_type, reference_id,
    category, severity, priority_score, title, message,
    action_label, action_route, action_context,
    dedupe_key, group_key, source_event_id, impact_value, impact_amount,
    status, detected_at
  ) values (
    p_hotel_id, p_rule_id, p_source_module, p_reference_type, p_reference_id,
    p_category, p_severity, p_priority_score, p_title, p_message,
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
  'Único camino de INSERT en hotel_priorities. Atómico vía ON CONFLICT sobre el índice único parcial de dedupe activo -- evita la condición de carrera de "leer si existe, luego insertar". is_new=false significa que ya existía una prioridad activa y sólo se refrescó.';

-- Cierra (RESOLVED, auto_resolved=true) las prioridades activas de una
-- regla cuyo dedupe_key ya NO está en la lista de "sigue vigente" que
-- manda el evaluador -- es decir, la condición dejó de cumplirse.
-- Acotado a una sola regla a la vez (p_rule_id) para que nunca resuelva
-- por accidente prioridades de otra regla.
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
  'Cierra como RESOLVED (auto_resolved=true) las prioridades activas de una regla cuyo dedupe_key ya no aparece entre las condiciones vigentes que evaluó el motor. Nunca borra la fila -- el historial se conserva para Radar 360 futuro.';

grant execute on function public.upsert_hotel_priority(
  uuid, uuid, text, text, uuid, text, text, integer, text, text, text, text, jsonb, text, text, uuid, numeric, numeric
) to authenticated;
grant execute on function public.auto_resolve_stale_priorities(uuid, uuid, text[]) to authenticated;

-- ============================================================
-- Primera regla vertical: ARRIVAL_NOT_REGISTERED
-- ============================================================
-- Una Estancia sigue en 'expected' (nunca se llamó register_arrival(),
-- 0026) y su reservation_stays.check_in ya quedó atrás según la fecha
-- operativa del hotel. Se determina enteramente con datos que ya existen
-- (stays.status + reservation_stays.check_in) y la infraestructura de
-- businessDate recién construida -- sin Housekeeping, sin Caja, sin tocar
-- ninguna regla de Reservaciones/Recepción, sin introducir dinero.
insert into public.hotel_rules (
  hotel_id, code, module, name, description, category, severity, priority_weight,
  responsible_role, allows_assignment, supports_auto_resolution, deduplicates, cooldown_minutes, is_active
) values (
  null,
  'ARRIVAL_NOT_REGISTERED',
  'front_desk',
  'Llegada no registrada',
  'La fecha de check-in de la estancia ya pasó (según la fecha operativa del hotel) y todavía no se registró la llegada (register_arrival()). No implica no-show: sólo señala que nadie ha actuado todavía.',
  'front_desk',
  'high',
  30,
  'front_desk',
  true,
  true,
  true,
  0,
  true
)
on conflict (code) where hotel_id is null do nothing;
