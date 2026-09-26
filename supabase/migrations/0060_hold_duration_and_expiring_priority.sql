-- HotelOS / Reservaciones + Motor de Prioridades: duración de Hold
-- configurable por hotel + aviso de Hold por expirar (P2-2, propuesta
-- aprobada por el dueño del producto).
--
-- Extensión de lo que ya existe -- NO un mecanismo nuevo de bloqueo de
-- inventario. attempt_inventory_hold() (0016) ya acepta p_hold_minutes
-- (default 24h si no se manda) y createHoldFromQuoteOption() (TS) ya tiene
-- el parámetro listo para usarse -- lo único que faltaba era que algún
-- caller real lo pasara con un valor configurable por hotel en vez de
-- dejarlo caer siempre en el default de 24h de SQL.
--
-- El comentario original de inventory_holds.expires_at (0013) ya
-- anticipaba "hotel_policies.extra_settings.hold_duration_minutes" como el
-- lugar correcto para esto -- nunca se implementó (ningún código llegó a
-- leer ni escribir esa ruta de extra_settings). Se promueve directo a
-- columna real en vez de JSONB porque se vuelve una política consultada en
-- cada creación de Hold (regla de CLAUDE.md: "si una política se vuelve
-- importante/consultada seguido, prométela a columna real").

alter table public.hotel_policies
  add column hold_duration_minutes integer not null default 120
  check (hold_duration_minutes > 0);

comment on column public.hotel_policies.hold_duration_minutes is
  'Minutos que un Hold de inventario (inventory_holds, 0016) permanece activo antes de expirar mientras el huésped completa el pago. Default 120 (2h). Reemplaza el placeholder nunca implementado hotel_policies.extra_settings.hold_duration_minutes mencionado en el comentario original de inventory_holds.expires_at (0013) -- promovido a columna real por ser una política consultada en cada creación de Hold.';

comment on column public.inventory_holds.expires_at is
  'Duración configurable por hotel vía hotel_policies.hold_duration_minutes (P2-2) -- antes un placeholder sin implementar en extra_settings. La liberación al vencer sigue siendo perezosa (expire_stale_holds(), ver 0016) o manual.';

-- ============================================================
-- Motor de Prioridades: segunda regla vertical (la primera desde
-- ARRIVAL_NOT_REGISTERED, 0036). "Avisa al hotel" del pedido de P2-2 se
-- resuelve reusando el motor que ya existe (hotel_rules/hotel_priorities +
-- un evaluador de TypeScript) en vez de construir un canal de
-- notificación nuevo (push/email/WhatsApp sigue fuera de alcance, ver
-- CLAUDE.md sección "Motor de reglas y Prioridades").
-- ============================================================
insert into public.hotel_rules (
  hotel_id, code, module, name, description, category, severity, priority_weight,
  responsible_role, allows_assignment, supports_auto_resolution, deduplicates, cooldown_minutes, is_active
) values (
  null,
  'HOLD_EXPIRING_SOON',
  'reservations',
  'Hold por expirar',
  'Un Hold activo de inventario (inventory_holds) está a menos de 15 minutos de expirar sin haberse confirmado como reserva -- el huésped podría estar a mitad de pago. No implica que ya se perdió la venta: sólo avisa mientras todavía hay tiempo de confirmar, extender el Hold o contactar al huésped.',
  'reservations',
  'medium',
  10,
  'front_desk',
  true,
  true,
  true,
  0,
  true
)
on conflict (code) where hotel_id is null do nothing;
