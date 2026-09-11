-- HotelOS: tabla central de eventos/timeline. Es el paso "EVENTO REGISTRADO
-- EN TIMELINE" del patrón transversal (DATOS -> ESTADO OPERATIVO -> REGLAS ->
-- PRIORIDAD -> ACCIÓN RECOMENDADA -> USUARIO EJECUTA -> TIMELINE -> KPI).
-- Todo módulo (Reservaciones, Rack, Recepción, Habitaciones, Caja...) escribe
-- aquí cuando ocurre algo relevante. Los KPIs y el estado operativo derivado
-- se calculan a partir de este log, nunca al revés.
--
-- Es append-only por diseño: no hay política de UPDATE ni DELETE.

create table public.timeline_events (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,

  -- Módulo de origen: 'reservations' | 'rack' | 'front_desk' | 'rooms' | 'billing' | ...
  module text not null,
  -- Tipo de evento en formato "entidad.accion", ej. 'reservation.created',
  -- 'checkin.completed', 'payment.registered', 'room.changed'.
  event_type text not null,

  entity_type text not null,
  entity_id uuid,

  -- Snapshot de datos relevantes del evento (antes/después, montos, etc.).
  payload jsonb not null default '{}'::jsonb,

  -- Quién ejecutó la acción. Null sólo permitido para eventos generados por
  -- el sistema (ver policy de insert), nunca para acciones de un humano.
  actor_user_id uuid references auth.users (id),

  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

comment on table public.timeline_events is
  'Bitácora central append-only de todo lo que ocurre en un hotel. Fuente de verdad para auditoría, estado operativo derivado y KPIs. No editable ni borrable desde la aplicación.';
comment on column public.timeline_events.event_type is
  'Convención "entidad.accion" en snake_case, ej. reservation.created, checkin.completed, payment.registered, room.changed.';

create index idx_timeline_events_hotel_occurred on public.timeline_events (hotel_id, occurred_at desc);
create index idx_timeline_events_entity on public.timeline_events (hotel_id, entity_type, entity_id);
create index idx_timeline_events_type on public.timeline_events (hotel_id, event_type);

alter table public.timeline_events enable row level security;

create policy "timeline_events_select_member_or_platform_admin"
  on public.timeline_events for select
  to authenticated
  using (hotel_id in (select public.user_hotel_ids()) or public.is_platform_admin());

-- Cualquier miembro activo del hotel puede insertar eventos de su propia
-- autoría; el sistema (actor_user_id null) sólo vía función security definer
-- o rol de servicio, nunca desde el cliente directamente.
create policy "timeline_events_insert_member_as_self"
  on public.timeline_events for insert
  to authenticated
  with check (
    hotel_id in (select public.user_hotel_ids())
    and actor_user_id = auth.uid()
  );

-- Sin UPDATE ni DELETE: el timeline es inmutable por diseño.
