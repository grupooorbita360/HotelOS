# CLAUDE.md — HotelOS

Este archivo es la referencia permanente del proyecto. Cualquier sesión de
Claude Code (o cualquier desarrollador) que trabaje en este repo debe leerlo
antes de escribir código y respetar lo que dice aquí, especialmente la
sección de **principios no negociables**.

HotelOS es un sistema operativo para hoteles independientes/pequeños,
multi-tenant desde el diseño. Viene de un prototipo anterior en Google Apps
Script que tuvo tres problemas recurrentes que este proyecto existe para
evitar: **funciones duplicadas** (nadie sabía qué ya existía), **permisos
débiles** (todo validado sólo en el cliente) y **cero auditoría real**
(nadie podía saber quién hizo qué y cuándo). Todo lo que sigue está pensado
para que esos tres problemas no puedan volver a pasar.

## Stack

- **Next.js (App Router, TypeScript)** — frontend y backend en un solo
  proyecto: Server Components para lectura, Server Actions para mutaciones,
  Route Handlers sólo cuando se necesita un endpoint HTTP explícito (webhooks, etc.).
- **Supabase** — Postgres, Auth y Storage. Postgres es la fuente de verdad
  de datos *y* de seguridad (RLS), no sólo almacenamiento.
- **Tailwind CSS** — estilos.

## Principios de arquitectura (no negociables)

### 1. Multi-tenant desde el día 1

Cada hotel es un tenant aislado. Toda tabla operativa tiene `hotel_id` y
tiene **Row Level Security activado** en Supabase, de modo que un hotel
nunca puede ver datos de otro *aunque haya un bug en el código de la
aplicación*. La aplicación no es la barrera de seguridad — Postgres lo es.

- El tenant raíz es `public.hotels`.
- El límite de acceso de un usuario a un hotel es la tabla
  `public.user_hotel_roles` (usuario + hotel + rol). Un usuario sólo ve/opera
  en los hoteles donde tiene una fila activa ahí.
- Las funciones `public.user_hotel_ids()` y `public.is_platform_admin()`
  (ver `supabase/migrations/0005_permission_helpers.sql`) son la base de
  *todas* las políticas RLS. No inventes una forma distinta de filtrar por
  hotel en una tabla nueva: reusa estas funciones.
- Antes de crear una tabla operativa nueva, pregúntate: ¿tiene `hotel_id`?
  ¿tiene RLS con políticas que usan `user_hotel_ids()` / `has_permission()`?
  Si la respuesta a cualquiera es "no", no está lista para mergear.

### 2. Permisos reales en servidor

Ninguna acción sensible (crear reserva, registrar pago, hacer check-in,
cambiar habitación, editar configuración del hotel...) se valida sólo en la
interfaz. El navegador no es de confianza.

Hay dos capas, y **ambas** deben existir:

1. **RLS en Postgres** (la capa real de seguridad): cada política de INSERT/UPDATE
   usa `public.has_permission(hotel_id, 'codigo.del.permiso')`. Aunque
   alguien se salte por completo el código de Next.js y pegue directo a la
   API de Supabase con su propio token, esto sigue bloqueando la operación.
2. **`requirePermission()` en el Server Action** (capa de UX): ver
   `src/lib/auth/permissions.ts`. Corta temprano con un mensaje de error
   claro, antes de gastar una consulta a la base de datos. Esto es un
   refuerzo, no un reemplazo de RLS.

Patrón para cada Server Action que muta datos:

```ts
"use server";
import { requirePermission } from "@/lib/auth/permissions";
import { logTimelineEvent } from "@/lib/events/timeline";
import { createClient } from "@/lib/supabase/server";

export async function crearReserva(hotelId: string, input: NuevaReservaInput) {
  await requirePermission(hotelId, "reservations.create");

  const supabase = await createClient();
  const { data, error } = await supabase.from("reservations").insert({ ... }).select().single();
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "reservations",
    eventType: "reservation.created",
    entityType: "reservation",
    entityId: data.id,
    payload: { ... },
  });

  return data;
}
```

Nunca uses `src/lib/supabase/admin.ts` (service role, ignora RLS) para
atender una petición de usuario normal. Es sólo para jobs de sistema.

### 3. Auditoría integrada

Toda tabla operativa tiene `created_by`, `created_at`, `updated_by`,
`updated_at` desde el diseño del esquema, no agregados después. Estos campos
**nunca se llenan a mano ni se confía en lo que mande el cliente**: el
trigger `public.set_audit_fields()` (`supabase/migrations/0001_extensions_and_audit.sql`)
los fija siempre desde el servidor usando `auth.uid()`.

Al crear una tabla nueva:

```sql
created_at timestamptz not null default now(),
created_by uuid references auth.users (id),
updated_at timestamptz not null default now(),
updated_by uuid references auth.users (id)

-- y el trigger:
create trigger trg_<tabla>_audit
  before insert or update on public.<tabla>
  for each row execute function public.set_audit_fields();
```

Además de estos campos, `public.timeline_events` (ver principio 5) es la
auditoría *de negocio*: qué pasó, quién lo hizo, cuándo, con qué datos.

### 4. Configuración por hotel sin tocar código

Cada hotel tiene un plan (`basico` / `plus` / `pro`, columna `hotels.plan`)
y políticas propias — si requiere garantía, si permite check-in anticipado,
qué activos entrega, horarios estándar, etc. Todo esto vive en
`public.hotel_policies` (una fila por hotel, creada automáticamente al dar
de alta el hotel). Un cambio de política de un hotel es un `UPDATE`, nunca
un deploy.

`hotel_policies` tiene columnas explícitas para lo ya conocido y una columna
`extra_settings jsonb` como catch-all para políticas nuevas que todavía no
justifican una migración. Si una política se vuelve importante/consultada
seguido, prométela a columna real en una migración nueva.

### 5. Patrón transversal de HotelOS

Cada módulo (Reservaciones, Rack, Recepción, Habitaciones, Caja...) sigue
este flujo:

```
DATOS → ESTADO OPERATIVO (derivado) → REGLAS → PRIORIDAD
  → ACCIÓN RECOMENDADA → USUARIO EJECUTA → EVENTO EN TIMELINE → KPI
```

- **DATOS**: lo que se captura (una reserva, un pago, un huésped).
- **ESTADO OPERATIVO**: nunca se captura a mano — se *deriva* de los datos
  (ej. "pendiente de check-in" = reserva con fecha de llegada hoy y sin
  evento `checkin.completed` en el timeline).
- **REGLAS**: motor de reglas configurable (futuro; todavía no
  implementado). Pensado para vivir en tablas de configuración, igual que
  `hotel_policies`, no hardcodeado en el módulo.
- **PRIORIDAD / ACCIÓN RECOMENDADA**: lo que el sistema le sugiere hacer al
  usuario (futuro, por módulo).
- **USUARIO EJECUTA**: una Server Action, validada con `requirePermission()`.
- **EVENTO EN TIMELINE**: cada Server Action que muta datos relevantes
  termina con `logTimelineEvent()` hacia `public.timeline_events`
  (`src/lib/events/timeline.ts`). Esta tabla es append-only (sin política de
  UPDATE/DELETE): es la bitácora central del sistema.
- **KPI**: se calculan a partir de `timeline_events` (y de las tablas de
  datos), nunca con contadores mantenidos a mano en otra tabla.

`timeline_events` existe desde esta primera versión precisamente para que
ingún módulo futuro la trate como "algo que se agrega después".

## Esquema de base de datos (resumen)

Ver `supabase/migrations/` para el detalle real y comentado. Orden de
lectura recomendado (las migraciones dependen unas de otras en este orden):

| Migración | Contenido |
|---|---|
| `0001_extensions_and_audit.sql` | `pgcrypto`, función `set_audit_fields()` |
| `0002_hotels.sql` | `hotels` (el tenant raíz) |
| `0003_profiles.sql` | `profiles` (1:1 con `auth.users`), alta automática por trigger |
| `0004_roles_permissions.sql` | `roles`, `permissions`, `role_permissions`, `user_hotel_roles` |
| `0005_permission_helpers.sql` | `is_platform_admin()`, `user_hotel_ids()`, `has_permission()` |
| `0006_rls_policies.sql` | Políticas RLS de todo lo anterior |
| `0007_hotel_policies.sql` | `hotel_policies` (config/políticas por hotel) + alta automática |
| `0008_timeline_events.sql` | `timeline_events` (bitácora central, append-only) |
| `0009_seed_roles_permissions.sql` | Catálogo inicial de permisos y roles de sistema |
| `0010_room_types_rooms.sql` | `room_types`, `rooms` — prerequisito mínimo del futuro módulo Habitaciones |
| `0011_leads.sql` | `leads` |
| `0012_quotes.sql` | `quotes`, `quote_options` |
| `0013_inventory_holds.sql` | `inventory_holds` |
| `0014_reservations.sql` | `reservations`, `reservation_stays` |
| `0015_inventory_blocks.sql` | `inventory_blocks` — tabla de verdad noche-a-noche para disponibilidad |
| `0016_inventory_concurrency_functions.sql` | Algoritmo de concurrencia atómica: `attempt_inventory_hold()`, `confirm_reservation_from_hold()`, `release_hold()`, `cancel_reservation()`, `expire_stale_holds()`, `check_availability()` |
| `0017_guarantees_payments.sql` | `guarantees`, `payments` |
| `0018_deferred_foreign_keys.sql` | FKs que no se pudieron declarar antes de que existiera `reservations` |
| `0019_fix_check_availability_volatility.sql` | Fix de volatilidad de `check_availability()` (detectado contra Supabase real, ver sección de Reservaciones) |
| `0020_reception_settings.sql` | `reception_settings` (config de Recepción por hotel) + alta automática |
| `0021_rooms_cleanliness.sql` | `rooms.is_clean` (placeholder mínimo hasta que exista Housekeeping) |
| `0022_stays.sql` | `stays` (Estancia: ciclo físico del huésped) + alta automática al confirmarse una reserva |
| `0023_room_assignments.sql` | `room_assignments` (historial de habitación física por estancia) |
| `0024_stay_accounts_transactions.sql` | `stay_accounts`, `stay_transactions` (cuenta contable de Recepción, independiente de Caja) |
| `0025_guest_requests_incidents_assets.sql` | `guest_requests`, `stay_incidents`, `delivered_assets` |
| `0026_reception_functions.sql` | Máquina de estados de Estancia y gates: `register_arrival()`, `check_in()`, `assign_room()`, `deliver_room()`, `mark_no_show()`, `mark_walked()`, `register_stay_transaction()`, `void_stay_transaction()`, `attempt_check_out()`, `can_deliver_room()`, `check_out_readiness()` |
| `0027_seed_front_desk_payments.sql` | Fix: agrega `payments.register` al rol `front_desk` (faltaba desde el seed original) |
| `0028_fix_stay_transactions_created_by.sql` | Fix: `register_stay_transaction()`/`void_stay_transaction()` no fijaban `created_by` (ver sección de Recepción) |
| `0029_room_catalog_fields.sql` | `room_types.base_rate`; `rooms.building`, `rooms.bed_type` (Módulo 04, ver sección de Configuración) |
| `0030_profiles_email_sync.sql` | `profiles.email`, sincronizado por trigger desde `auth.users` (alta y cambio de correo) |
| `0031_staff_lookup_function.sql` | `find_user_id_by_email()` — SECURITY DEFINER, gate `staff.manage`, usado por el alta de usuarios de Configuración |
| `0032_room_upgrade_assignment.sql` | `assign_room_for_checkin()` — asignación con upgrade (cobra la diferencia de tarifa) para el flujo guiado de check-in |
| `0033_inventory_blocks_physical_extension.sql` | Extensión aditiva de `inventory_blocks`: `room_id`, `reason`, `created_by` + catálogo de `block_type` ampliado (preparación para Rack, ver sección de Reservaciones) |
| `0034_hotel_policies_iva.sql` | `hotel_policies.iva_porcentaje` — IVA configurable por hotel, solo para desglose contable (ver sección de Configuración) |
| `0035_no_show_hotel_timezone.sql` | Fix: `mark_no_show()` usaba `current_date` (timezone de la sesión) en vez de `hotels.timezone` (ver sección de Fecha operativa) |
| `0036_priority_engine.sql` | `hotel_rules`, `hotel_priorities`, permiso `priorities.manage`, funciones `upsert_hotel_priority()`/`auto_resolve_stale_priorities()` y la regla `ARRIVAL_NOT_REGISTERED` (ver sección de Motor de reglas y Prioridades) |
| `0037_priority_engine_hardening.sql` | Endurecimiento del Motor V1: `upsert_hotel_priority()` ya no acepta severity/category/priority_score/source_module del caller; retira la política de `UPDATE` de `hotel_priorities`; agrega 5 funciones `SECURITY DEFINER` para las transiciones humanas (ver "Ajuste 02.1" en Motor de reglas y Prioridades) |
| `0038_priority_engine_service_role_only.sql` | Cierre del Ajuste 02.1: `upsert_hotel_priority()`/`auto_resolve_stale_priorities()` sólo ejecutables por `service_role` (`auth.role() = 'service_role'`, reemplaza el chequeo de pertenencia al hotel); `engine.ts` usa `createAdminClient()` sólo en esas dos llamadas |
| `0039_platform_licenses.sql` | Fase 0/Plataforma: `hotel_licenses`, `plan_features`, `hotel_feature_overrides`, funciones `has_feature()`/`hotel_enabled_features()`/`hotel_limit_usage()`/`user_has_suspended_membership()` y suspensión por desactivación de membresías (ver sección de Plataforma) |
| `0040_hotel_functions_membership_guard.sql` | Fase 0/Plataforma: `assert_hotel_member()` + guard de pertenencia en las tres funciones de 0039. |
| `0041_habitaciones_domain.sql` | Módulo Habitaciones: capacidad explícita aditiva en `room_types`, desactivación con motivo obligatorio en `rooms`, catálogo de amenidades + herencia con excepción (amenidades y activos), `snapshot_comercial_habitacion`, funciones `deactivate_room()`/`reactivate_room()`/`update_room_type_capacity()` (ImpactAnalysis) y `congelar_configuracion_comercial()` (ver sección Habitaciones). No depende de 0039/0040 (no toca `room_types`/`rooms`, sin colisión de nombres de tabla/función) |
| `0042_snapshot_created_by_fix.sql` | Fix: `congelar_configuracion_comercial()` no fijaba `created_by` en el `INSERT` de `snapshot_comercial_habitacion` (quedaba siempre `NULL`) |
| `0043_reception_readonly_functions_guard.sql` | Fix de seguridad: `can_deliver_room()`/`check_out_readiness()` (0026) eran `SECURITY DEFINER` sin validar `has_permission()` ni pertenencia al hotel -- ejecutables sin sesión y contra estancias de cualquier hotel (ver sección de Recepción) |
| `0044_created_by_audit_fixes.sql` | Fix de auditoría: `attempt_inventory_hold()`/`confirm_reservation_from_hold()` no fijaban `inventory_blocks.created_by`; política de `quote_options` no exigía `created_by = auth.uid()` en el `WITH CHECK` (ver sección de Reservaciones) |
| `0045_revoke_public_execute_internal_functions.sql` | Fix de seguridad: revoca `EXECUTE` de `PUBLIC`/`anon` en `expire_stale_holds()`, `recompute_stay_next_action()`, los 7 triggers `handle_*`, `set_audit_fields()`, `set_updated_at_only()`, `sync_stay_account_balance()` y `assert_hotel_member()` -- ninguna función interna debería tener grant a `anon` por el default de Postgres (ver sección de Reservaciones) |
| `0046_caja_module.sql` | Módulo Caja: `payment_methods`, `payment_movements`, `cash_settings`, `cash_shifts`, `cash_movements`; extiende `payments`/`stay_transactions` (aditivo); funciones `register_payment_with_movements()`/`register_refund()`/`validate_payment()`/`register_stay_adjustment()`/`open_cash_shift()`/`close_cash_shift()`/`register_cash_expense()`; `hotels.moneda_base` (ver sección de Caja) |
| `0047_pricing_source_of_truth_tier1.sql` | Fuente única de precio (Tier 1, auditoría externa): `confirm_reservation_from_hold()` pierde `p_rate_total` -- `rate_total` se deriva siempre de `quote_options.total` vía `inventory_holds.quote_option_id`, nunca de un parámetro que el caller pudiera mandar (ver sección "Fuente única de precio") |
| `0048_quote_options_no_client_insert.sql` | Fuente única de precio (Tier 2): retira la política de `INSERT`/`UPDATE` de cliente en `quote_options`; único camino de escritura es `create_quote_option()` (`SECURITY DEFINER`), que calcula `subtotal`/`taxes`/`total` server-side -- ningún parámetro de precio ya hecho (ver sección "Fuente única de precio") |
| _(0049 no existe -- hueco intencional, ver nota debajo de esta tabla)_ | |
| `0050_demo_hotel_seed_reset.sql` | `reset_demo_hotel()`: borra y re-siembra el hotel `hotel-demo` con ~7 semanas de historial anclado a `current_date` (ocupación, ADR, ingresos, no-show, cancelaciones, estancias in-house, solicitudes/incidencias/activos, timeline real). Sólo `platform_admin`. Botón manual en `/admin` → tab "Demo" (`resetDemoHotel()`/`submitResetDemoHotel()`). Traída desde la rama `feature/demo-reset` -- ya estaba aplicada en producción antes de fusionarse a esta rama (ver nota debajo) |
| `0051_authorized_room_change.sql` | `change_room_with_authorization()` -- upgrade/downgrade de habitación después del check-in, con cobro/cortesía/compensación (P0-3, ver "Handoff de demo P0") |
| `0052_quote_discount_authorization.sql` | `create_quote_option()` gana `p_is_courtesy`/`p_discount_reason` -- exige `reservations.discount` + motivo para cotizar fuera de la tarifa de lista (P0-7, ver "Handoff de demo P0") |
| `0053_fix_reset_demo_hotel_leads_fk.sql` | Fix real: `reset_demo_hotel()` (0050) borraba `reservations` antes de desvincular `leads.reservation_id` -- fallaba con violación de FK en cuanto el hotel demo real acumulaba algún lead convertido por uso genuino de la app (ver "Handoff de demo P0") |
| `0054_fix_reset_demo_hotel_holds_fk.sql` | Mismo problema que 0053, columna distinta: `inventory_holds.converted_reservation_id` (que `confirm_reservation_from_hold()`, 0016, fija en TODO Hold confirmado) tampoco se desvinculaba antes del wipe -- más grave que 0053 porque no es un caso raro, es el camino normal de confirmar una reserva (ver "Handoff de demo P0") |
| `0055_hotels_is_demo.sql` | `hotels.is_demo` -- fuente de verdad única para el aislamiento del Hotel Demo (issue #16), reemplaza detectarlo por `slug = 'hotel-demo'`; `reset_demo_hotel()` recreada consultando por `is_demo`. Traída por PR #18 (`feature/is-demo-0051`), reconciliada al mergear ese PR a esta rama |
| `0056_undo_walked.sql` | `undo_walked()` -- deshace `mark_walked()` (0026), regresa la estancia a `arrived` y limpia `walked_at`/`walked_reason` (P1-4, ver "Handoff de demo P1, Tanda 2") |
| `0057_checkout_marks_room_dirty.sql` | `attempt_check_out()` (recreada sobre 0026) marca `is_clean = false` en la habitación que libera -- puente temporal hasta que exista Housekeeping real (P1-7, ver "Handoff de demo P1, Tanda 2") |
| `0058_room_deactivation_estimated_date.sql` | `rooms.estimated_available_at`; `deactivate_room()` gana `p_estimated_available_at` opcional (drop + create, cambia la firma), `reactivate_room()` la limpia (P1-12, ver "Handoff de demo P1, Tanda 2") |

**Nota sobre el hueco en 0049 y la reconciliación de `feature/demo-reset`
(commit `2ab7580`):** `feature/demo-reset` es una rama remota que se
bifurcó de un commit anterior a que esta rama agregara `0041`-`0048` --
nunca vio ese trabajo, y esta rama nunca había visto la suya. Su autor
escribió `0050_demo_hotel_seed_reset.sql` sabiendo (por haber consultado
Supabase real, no el repo) que `0041`/`0042` ya estaban aplicadas en
producción aunque no las viera en su propio árbol de archivos, y dejó
`0049` como hueco deliberado a propósito ("deja hueco a 0040... y a
0041/0042 que existen en producción... aunque aún no estén commiteadas
en el repo", comentario original del archivo). Se confirmó (auditoría
externa + verificación en vivo contra Supabase) que `reset_demo_hotel()`
ya corría en producción desde antes de esta fusión -- fusionar esta rama
NO aplicó nada nuevo a la base de datos, sólo la deja versionada aquí.
Único conflicto real al fusionar: dos tabs nuevas e independientes en
`src/app/admin/page.tsx` (`Auditoría` de esta rama, `Demo` de
`feature/demo-reset`) insertadas en el mismo punto del archivo --
resuelto conservando ambas, sin pérdida de ninguna. `0049` queda vacío a
propósito, documentado aquí para que ninguna sesión futura intente
reusar ese número. El primer número real y libre para migraciones nuevas
avanza según la tabla de arriba -- al momento de escribir esto (después de
`0058`) es **`0059`**; no reafirmes aquí un número fijo, revisa siempre
`supabase/migrations/` para el máximo real antes de crear una migración.

Todas las tablas de este listado tienen RLS activado y probado (ver sección
"Cómo se validó" abajo). Ninguna tiene política de `DELETE` salvo que se
haya agregado explícitamente — dar de baja algo es un cambio de `status`/`is_active`,
no un borrado físico.

## Reservaciones: decisiones de esquema (Módulo 02)

Este módulo se construyó a partir de una especificación funcional propia
(`MODULO_02_RESERVACIONES_spec_completa.md`) que en realidad contenía **dos
versiones distintas y contradictorias** en el mismo archivo (una sección
"v1.2 cerrada" con sus propios ADR-01..06, y una revisión independiente
posterior, con su propio modelo y ADR-001..003, que corregía puntos de la
primera). Se resolvió combinando lo mejor de ambas; documentar esto aquí es
obligatorio para que ninguna sesión futura reabra estas decisiones sin
saber que ya se compararon las dos alternativas.

### Decisiones cerradas de esta implementación

1. **Frontera Reservaciones / Recepción.** `reservations.status` es sólo
   `confirmed | cancelled | no_show | completed` — **no** incluye
   `checked_in`/`in_house`/`checked_out` como proponía la v1.2 original. Esos
   estados son operación física y se agregan en el futuro módulo Recepción
   como columnas nuevas sobre esta misma tabla, nunca como un rediseño.
   Reservaciones entrega una reserva `confirmed`; Recepción la recibe.

2. **Inventario en una sola tabla de verdad.** En vez de calcular
   disponibilidad sumando por separado holds activos + reservas confirmadas +
   bloqueos manuales (como proponía la v1.2 original), todo consumo de
   inventario vive en **`inventory_blocks`**: una fila = una unidad de
   `room_type` consumida en una fecha, con `block_type` ∈
   `hold | reservation | maintenance | overbooking`. Esto es lo que permite
   que `attempt_inventory_hold()` sea una operación atómica real contra una
   sola tabla, en vez de una condición de carrera entre varias.

3. **"Sin garantía" nunca es un tipo de Garantía.** `guarantees.type` sólo
   admite `card_hold | cash_deposit` (decisión cerrada explícita de la v1.2
   original, §16.1 del spec). Que un hotel no requiera garantía es
   `hotel_policies.requires_guarantee = false`, nunca una fila de garantía
   con un tipo "ninguna". Si no hay garantía, el Hold se convierte en
   Reserva con una confirmación explícita del huésped/staff, nunca por
   aceptación automática de silencio.

Todo lo demás del documento base (Hold como entidad independiente que nace
**antes** de la condición de confirmación y nunca es un estado de Reserva;
Cotización como snapshot inmutable que nunca compromete inventario;
Reservation 1:N ReservationStay desde el modelo aunque la interfaz limite a
una Estancia; tipo de cambio y política de cancelación congelados por
snapshot) se implementó tal cual el spec original lo cierra — ver comentarios
en cada migración `0010`-`0018` para el razonamiento completo.

### El algoritmo de concurrencia (por qué es real, no sólo validación de app)

`attempt_inventory_hold()` (ver `0016`) toma un
`pg_advisory_xact_lock` por cada `(hotel_id, room_type_id, noche)` del rango
solicitado **antes** de contar cuánto inventario queda. Cualquier otra
transacción que compita por la misma noche se bloquea en Postgres hasta que
la primera termina (commit o rollback) — momento en el que el conteo ya es
definitivo. Esto convierte "verificar disponibilidad" + "bloquear
inventario" en una sola operación atómica, no dos consultas separadas con
una ventana de carrera en medio (spec S7-S8). Se probó localmente con dos
transacciones concurrentes sobre la última unidad disponible: sólo una
obtiene el Hold, la otra falla limpio con `NO_AVAILABILITY` (caso A de la
matriz de concurrencia del spec, ver `supabase/migrations/0016...`).

Por la misma razón, `inventory_holds`, `inventory_blocks` y `reservations`
**no tienen política de INSERT/UPDATE para el cliente** — el único camino
para escribir ahí es a través de las funciones `SECURITY DEFINER` de `0016`,
que validan `has_permission()` manualmente porque al correr como su dueño no
pasan por RLS (ver comentario en cada función). Nunca agregues una política
de INSERT directa a estas tres tablas: rompería la garantía de atomicidad.

### Alcance de esta sesión (qué NO se construyó todavía, a propósito)

El spec original de Reservaciones incluye mucho más de lo que se pidió
construir en esta sesión. Lo siguiente está modelado como catálogo cerrado
donde es gratis hacerlo (ej. `leads.lost_reason`) pero **no tiene lógica ni
UI todavía** — es evolución futura explícita, no un olvido:

- Lista de espera (`WaitlistRequest`) y su reconexión automática.
- `AlternativeSearchService` ("no perder la venta": categoría alterna,
  upgrade, combinación de habitaciones, fechas cercanas).
- `PermisoExcepcion`/`AuthorizationRequest` (autorización de descuentos y
  excepciones por umbral) — hoy sólo existe el permiso binario
  `reservations.create`/`reservations.cancel`/`payments.register` ya
  sembrado desde la base del proyecto; no se agregaron permisos nuevos
  porque esos tres ya cubren el flujo completo de este módulo.
- Catálogo de mensajes automáticos al huésped (`CAT_MENSAJES_HUESPED`).
- Campos de sincronización OTA (`source`, `sync_status`, etc.).
- `CancellationPolicyEvaluator`/`RefundService`: `cancel_reservation()`
  cancela y libera inventario, pero **no calcula reembolso** —
  `cancellation_policy_snapshot` ya se guarda en la reserva para que ese
  cálculo se agregue después sin rediseñar nada.
- `folio_accounts` como tabla separada: en esta versión `payments` referencia
  `reservation_id` directo. La entidad `FolioAccount` formal (para folios
  divididos/grupales) es responsabilidad del futuro módulo Caja.
- Liberación automática de Holds vencidos por cron: `expire_stale_holds()`
  existe y se llama de forma perezosa (lazy) desde `check_availability()` y
  `attempt_inventory_hold()`, pero en producción también debe llamarse
  periódicamente (`pg_cron` o un cron externo) para que un Hold vencido
  siempre genere señal visible aunque nadie vuelva a consultar disponibilidad.

### Extensión de `inventory_blocks` para el futuro Rack (0033)

Pedido explícito: preparar `inventory_blocks` (en producción con datos
reales) para que el futuro módulo Rack pueda representar bloqueos
**físicos** (mantenimiento de una habitación concreta, uso interno, etc.)
en la misma tabla, en vez de crear una tabla paralela — exactamente el
principio con el que se diseñó esta tabla desde 0015 ("no puede haber dos
algoritmos de disponibilidad distintos"). Puramente aditivo: ninguna
columna, tipo, ni valor de `block_type` existente se quitó o cambió.

Se agregó:
- `room_id` (nullable, FK a `rooms`) — `NULL` = bloqueo comercial por tipo
  (como siempre, todas las filas existentes); no-`NULL` = bloqueo de una
  unidad física específica. No participa en el conteo de
  `check_availability()`/`attempt_inventory_hold()` (siguen contando por
  `hotel_id + room_type_id + stay_date`, sin mirar `room_id`) — un bloqueo
  físico sigue restando del total del tipo, que es el comportamiento
  correcto (se probó explícitamente, ver abajo).
- `block_type` ganó 4 valores nuevos: `internal_use`, `courtesy`, `group`,
  `contingency`. Los 4 originales (`hold`, `reservation`, `maintenance`,
  `overbooking`) siguen intactos.
- `reason` (texto, nullable) y `created_by` (uuid, nullable, FK a
  `auth.users`) — pensados originalmente sólo para bloqueos manuales
  futuros, asumiendo que `hold`/`reservation` ya quedaban auditados vía
  `hold_id`/`reservation_stay_id`. **Corrección (0044, ver más abajo):**
  ese supuesto resultó equivocado — `hold_id`/`reservation_stay_id`
  identifican la entidad de negocio, no quién ejecutó la acción; sin
  `created_by`, no había forma de saber qué usuario creó un Hold o
  confirmó una reserva. Por eso `created_by` sí se fija ahora también para
  `hold`/`reservation`, no sólo para bloqueos manuales.

**Decisión de nombres:** el pedido original pidió `motivo`/`usuario_id` y
"MANTENIMIENTO" como valor nuevo de `block_type`. Se ajustó a
`reason`/`created_by` (inglés, como el resto de las ~30 tablas del
esquema — ninguna otra usa un nombre de columna en español) y **no** se
agregó `mantenimiento`: `maintenance` ya existía desde 0015 y significa
exactamente lo mismo — agregar un segundo valor para el mismo concepto
habría violado la regla 6 (nunca dupliques algo que ya existe) y dejado
ambiguo cuál usar de ahí en adelante. Los 4 valores realmente nuevos sí se
agregaron, en inglés para ser consistentes con `hold`/`reservation` ya
existentes.

**Sin cambios de RLS ni de funciones**: esta tabla nunca aceptó
INSERT/UPDATE directo del cliente (0015) y sigue sin aceptarlo — los 4
`block_type` nuevos no son alcanzables desde ningún lado todavía. Eso es
intencional: no se construyó el módulo Rack en esta sesión (regla 8), sólo
el esquema que va a necesitar. Cuando se construya Rack, va a necesitar su
propia función `SECURITY DEFINER` (validando `has_permission()`) para
crear estos bloqueos manuales, igual que `attempt_inventory_hold()` (0016)
es hoy el único camino para `hold`/`reservation`.

**Cómo se validó** (contra el esquema completo 0001-0032 local, antes de
mandar la migración): se repitió la batería de pruebas de concurrencia y
disponibilidad de Reservaciones sin ningún cambio de comportamiento
(`check_availability()`, `attempt_inventory_hold()`,
`confirm_reservation_from_hold()`, `cancel_reservation()` — mismos
resultados que antes de la migración), y además: un bloqueo físico de
`maintenance` con `room_id` sí resta de la disponibilidad comercial del
tipo; los 4 `block_type` nuevos se aceptan; un valor inválido se sigue
rechazando; un cliente autenticado normal sigue sin poder insertar
directo. Los dos `check` de 0015 eran anónimos (declarados inline) — no se
puede ensanchar un `check` in place, así que la migración los localiza por
catálogo (`pg_constraint`) y los reemplaza, en vez de asumir un nombre
autogenerado que podría no coincidir entre el entorno local y Supabase.

### Bug real de auditoría: `inventory_blocks.created_by` y `quote_options.created_by` en NULL (0044)

Auditoría externa encontró dos huecos reales, del mismo tipo que el ya
corregido en `stay_transactions` (0028) y `snapshot_comercial_habitacion`
(0042): una columna `created_by` que existe en el esquema pero nunca se
llenaba.

- **`inventory_blocks.created_by`**: `attempt_inventory_hold()` insertaba
  filas `block_type = 'hold'` sin listar `created_by` en absoluto (ver
  corrección de la nota de 0033 arriba); `confirm_reservation_from_hold()`
  las re-etiquetaba a `'reservation'` sin tocarlo tampoco. Corregido
  fijando `created_by = auth.uid()` en el `INSERT` de la primera, y
  `created_by = coalesce(created_by, auth.uid())` en el `UPDATE` de la
  segunda — `coalesce` porque, una vez corregido el `INSERT`, el valor ya
  viene bien desde que se creó el Hold, y `created_by` significa "quién
  creó la fila", no "quién la tocó por última vez" (esta tabla no tiene
  `updated_by` para eso); el `coalesce` sólo actúa de respaldo si una fila
  llegara con `NULL` de todos modos.
- **`quote_options.created_by`**: a diferencia de `inventory_blocks`, esta
  tabla sí acepta `INSERT` directo del cliente (0012) — mismo patrón que
  `timeline_events` (regla 11: tabla sin `updated_at`/`updated_by`, INSERT
  directo, RLS como garantía real). `createQuote()` (TypeScript) nunca
  mandaba `created_by`, y la política RLS de escritura no lo exigía, así
  que quedaba `NULL` sin que nada lo impidiera. Corregido en dos partes:
  la política de `quote_options` ahora exige `created_by = auth.uid()` en
  el `WITH CHECK` (igual que `timeline_events_insert_member_as_self`), y
  `createQuote()` (`src/modules/reservaciones/actions/quote.ts`) ahora
  manda `created_by: user?.id` obtenido de `supabase.auth.getUser()`. Los
  dos cambios son necesarios juntos: sin el `WITH CHECK`, un caller que se
  saltara el Server Action podría insertar con un `created_by` ajeno; sin
  el cambio en `createQuote()`, el flujo normal de la app habría empezado
  a fallar contra el `WITH CHECK` nuevo (el INSERT ya no habría cumplido
  la condición).

Migración: `0044_created_by_audit_fixes.sql`. Validado localmente y
contra Supabase real: crear un Hold y confirmar una reserva real deja
`inventory_blocks.created_by` con el usuario real (no `NULL`); crear una
cotización real deja `quote_options.created_by` con el usuario real.

### Actualización de UI (feedback de uso real, misma sesión)

El "Paso 1" dejó de ser "escribe a mano un tipo + una tarifa": ahora es
`GuestSearchField` (busca por nombre/correo/teléfono contra los leads ya
cargados del hotel, sin ida y vuelta al servidor) + fechas/pax, y al
"Buscar opciones" (navegación GET normal, sin Server Action — no hay nada
que escribir todavía) se listan TODOS los tipos con disponibilidad real
(`searchAvailableOptions()`) y su `base_rate` como tarifa editable, con un
botón "Copiar cotización" (portapapeles, sin envío automático) además de
"Reservar". Reservas y Leads del listado ahora son clicables a un detalle
(`?reservationId=`/`?leadId=`), y todas las fechas se muestran con
`formatDate()`/`formatDateRange()` (`src/lib/format.ts`) en vez del ISO
crudo.

Bug real encontrado al probar: `GuestSearchField` guarda nombre/correo/
teléfono en `useState` inicializado desde props (`defaultName`, etc.) para
poder editarlos localmente. Al navegar con un `<Link>` de Next.js (client-
side, sin recargar la página) hacia una URL con esos valores distintos
(ej. "Cotizar para este lead"), React reconciliaba el mismo componente en
vez de desmontarlo, y `useState` **no vuelve a leer su argumento inicial**
en renders posteriores — el campo se quedaba vacío pese a que la URL y los
`searchParams` del servidor ya traían el nombre correcto. Se corrigió con
un `key` en `GuestSearchField` derivado de esos mismos valores
(`key={`${guestName}|${guestEmail}|${guestPhone}`}`) para forzar un
remount cuando cambian. Lección para cualquier Client Component nuevo que
inicialice estado editable desde `searchParams`/props del servidor: si se
llega a él por navegación client-side (no full reload), necesita un `key`
atado a esos valores, o el estado queda "pegado" al primer valor con el
que se montó.

### Actualización de UI, ronda 2 (feedback de uso real, misma sesión)

- **Buscar disponibilidad en fechas pasadas ya no devuelve opciones.** Se
  valida `checkIn >= hoy` y `checkOut > checkIn` antes de llamar
  `searchAvailableOptions()`; si falla, se muestra un `Banner` y no se
  ejecuta la búsqueda. Los inputs de fecha también llevan `min={hoy}` como
  ayuda visual, pero la validación real es esta (server-side), no el
  atributo HTML.
- **El menú lateral es ahora fijo (`AppShell`, reemplaza `ModuleHeader`).**
  El header superior con gradiente + links a la derecha "se perdía" al
  hacer scroll porque vivía dentro del contenedor que hacía scroll.
  `AppShell` separa un `<aside>` con `position: fixed` (nunca se mueve) de
  un `<main>` que es la única región que hace scroll — mismo patrón que el
  sidebar del prototipo anterior (sólo se llevó el layout, no su lógica).
  Sólo lista los 3 módulos que existen de verdad (Reservaciones, Recepción,
  Configuración); no se inventaron links a módulos todavía no construidos.
- **Confirmar una reserva ahora sí registra un Pago real.** El comentario
  original de `actions/confirm.ts` decía "garantía/pago real se añaden con
  actions/guarantee.ts y actions/payment.ts sobre la reserva ya
  confirmada" -- ese archivo nunca se había creado. Se agregó
  `modules/reservaciones/actions/payment.ts` (`registerPayment()`), y el
  formulario de "Confirmar reserva" ahora incluye Canal, Total hospedaje
  (solo lectura), Anticipo, Moneda y Método de pago (`card`/`transfer`,
  los únicos que acepta el `check` de `payments.method` desde 0017) +
  Observaciones. Si hay anticipo, `submitConfirmReservation` llama
  `registerPayment()` justo después de confirmar la reserva, como
  `type: 'deposit'`. `payments` acepta INSERT directo del cliente (RLS de
  0017 ya lo permite vía `payments.register`), así que no hizo falta una
  función `SECURITY DEFINER` nueva. Sigue sin construirse el flujo de
  Garantía (`guarantees`, `card_hold`/`cash_deposit`) -- no se pidió
  todavía y es un ciclo de vida distinto (retener/liberar/cobrar).

### Bug real encontrado al probar contra Supabase (no solo local)

`check_availability()` estaba declarada `stable` pero llama internamente a
`expire_stale_holds()`, que escribe (libera Holds vencidos). PostgREST abre
una transacción de solo lectura para funciones `stable`/`immutable`, así
que la escritura interna fallaba con `cannot execute SELECT FOR UPDATE in a
read-only transaction` — pero **solo al llamarla vía la API REST real**;
`psql` local no impone ese modo de solo lectura por volatilidad declarada,
así que la batería de pruebas local no lo detectó. Se corrigió en
`0019_fix_check_availability_volatility.sql` quitando `stable`. Lección
para cualquier función nueva: si internamente llama a algo que escribe
(aunque sea "de paso", como una limpieza perezosa), **nunca la marques
`stable`/`immutable`**, sin importar que sus propios `SELECT` parezcan de
solo lectura — y no confíes solo en pruebas locales con `psql` para esto:
hay que probar contra la API real de Supabase.

## Recepción: decisiones de esquema (Módulo 03)

### Validación previa obligatoria (antes de tocar este esquema)

Se confirmó que `reservations.status` (Reservaciones) sigue limitado a
`confirmed | cancelled | no_show | completed` — ningún estado físico
(`checked_in`/`in_house`/`checked_out`) se había colado ahí. No fue
necesario corregir nada antes de construir Recepción.

### Frontera con Reservaciones

`reservation_stays` (Reservaciones) sigue siendo **lo vendido**: tipo,
fechas, tarifa, ocupantes — el acuerdo comercial. `stays` (Recepción, esta
sección) es **lo que pasa físicamente**: llegada, check-in, entrega de
habitación, check-out. Son tablas distintas, 1:1, y la integración entre
módulos ocurre a nivel de base de datos, no de código: un trigger en
`reservation_stays` (`handle_new_reservation_stay`, en
`0022_stays.sql`) crea automáticamente la `stays` correspondiente en
cuanto Reservaciones confirma una reserva. Reservaciones nunca importa
código de Recepción ni sabe que existe (regla 7 de este documento).

### Decisión clave: Recepción tiene su propia cuenta, independiente de Caja

`stay_accounts` + `stay_transactions` son la cuenta contable de la
**estancia**, propiedad de Recepción. El futuro módulo Caja se encargará de
instrumentos de pago (procesar tarjetas, conciliación, arqueo) y alimentará
esta cuenta insertando transacciones — pero Recepción **nunca** depende de
Caja para decidir si puede entregar una habitación o cerrar una cuenta: esa
decisión se toma aquí mismo, contra `stay_accounts.balance`.

`balance` es la suma de `stay_transactions.amount`, mantenida por un
trigger (`sync_stay_account_balance`) — nunca un campo que la aplicación
escriba directamente. Convención de signo: `charge`/`refund` positivos,
`payment` negativo (balance = "lo que el huésped debe"). Las transacciones
son inmutables: anular una crea una transacción nueva de signo contrario
con `reversed_transaction_id` apuntando a la original (`void_stay_transaction()`),
nunca se edita ni se borra una fila existente.

### Separación no negociable: Check-In administrativo ≠ Entrega física

`stays.status` tiene 7 valores: `expected → arrived → checked_in →
in_house → checked_out`, más `no_show` y `walked`. `checked_in_at` y
`in_house_at` son campos y eventos **siempre separados** — `check_in()` es
"ya lo registramos, es huésped de la casa"; `deliver_room()` es "ya tiene
la llave en la mano". Nunca colapses estos dos eventos en una sola acción:
es lo que permite medir cuellos de botella entre Recepción y Housekeeping
(ej. "cuánto tiempo pasa entre que alguien hace check-in y recibe su
habitación").

### Los tres algoritmos, y por qué están separados

- **`can_deliver_room()`** — gate **financiero** de entrega: sólo mira
  `reception_settings.entrega_permite_saldo` contra `stay_accounts.balance`.
  No mira limpieza — eso ya se decidió en el check-in (siguiente punto).
- **`check_in()`** aplica el gate de **limpieza**
  (`reception_settings.checkin_permite_sucia`): si es `false`, no se puede
  hacer check-in mientras la habitación asignada esté sucia
  (`rooms.is_clean`). Si no hay habitación asignada todavía, este gate no
  aplica (se asigna después).
- **`check_out_readiness()`** — evalúa TODO lo que puede bloquear el cierre
  de cuenta: saldo pendiente (si `bloquear_checkout_saldo`), activos
  entregados y no devueltos, incidencias abiertas. Devuelve
  `{ready, blockers[]}`, nunca solo `true`/`false`, para que la interfaz
  pueda decir exactamente qué falta.
- **`next_action`** (columna de `stays`) se recalcula con
  `recompute_stay_next_action()` al final de cada función que cambia algo
  relevante (estado, asignación, saldo) — igual que el resto del proyecto,
  nunca se recalcula al leer.

### rooms.is_clean — placeholder mínimo de Housekeeping

Igual que `room_types`/`rooms` fueron el mínimo necesario para que
Reservaciones tuviera inventario real, `rooms.is_clean` (booleano simple)
es el mínimo necesario para que el gate de `checkin_permite_sucia`
funcione. El módulo Housekeeping real (estados detallados, tareas, tiempos
de limpieza) se construye aparte y puede ampliar esta columna sin romper
Recepción.

### Fix de permisos: `front_desk` no tenía `payments.register`

El seed original (`0009`) le daba a `front_desk` `checkin.perform` y
`checkout.perform` pero no `payments.register`, aunque la especificación
original de Reservaciones ya describía ese rol como responsable de
"cotizar, crear reservas, **registrar pagos**". Sin este permiso, Recepción
no podría cobrar/registrar transacciones en la cuenta de la estancia — se
corrigió en `0027_seed_front_desk_payments.sql`. No se crearon permisos
nuevos: `checkin.perform`, `checkout.perform`, `room.change`,
`payments.register` y `rooms.manage` (ya sembrados) cubren todo el módulo.

### Bug real encontrado al probar el flujo completo contra Supabase

`register_stay_transaction()` y `void_stay_transaction()` insertaban en
`stay_transactions` sin fijar `created_by`, quedando siempre `NULL` —
auditoría rota, detectado al correr el flujo end-to-end contra el proyecto
real (no en las pruebas locales con `psql`, que no distinguen usuario real
de un valor omitido). Causa: `stay_transactions` es append-only y no tiene
`updated_at`/`updated_by`, así que **no puede** usar el trigger genérico
`set_audit_fields()` (fallaría al no existir esas columnas) — pero al
excluirlo, se me olvidó que entonces la propia función `SECURITY DEFINER`
tenía que fijar `created_by = auth.uid()` a mano en el `INSERT`, ya que esta
tabla tampoco acepta INSERT directo del cliente (no hay RLS que lo
garantice como en `timeline_events`). Corregido en
`0028_fix_stay_transactions_created_by.sql`. Lección: cualquier tabla
append-only sin `updated_at`/`updated_by` que se escriba solo desde una
función `SECURITY DEFINER` necesita que **esa función** fije `created_by`
explicitamente — no hay trigger genérico ni RLS que lo haga por ti.

### Falla de seguridad real: `can_deliver_room()`/`check_out_readiness()` sin guard (0043)

Auditoría externa detectó que estas dos funciones (0026), aunque
`SECURITY DEFINER`, recibían un `stay_id` libre y no validaban nada: ni
`has_permission()`, ni siquiera que la fila existiera. Al correr como su
dueño, `SECURITY DEFINER` **ignora RLS por completo** -- exactamente la
razón por la que cualquier función así que toque datos multi-tenant debe
hacer su propia validación, como ya hacían `deliver_room()`/
`attempt_check_out()`/`deactivate_room()` en el mismo archivo/proyecto.
Sin ese guard, ambas eran ejecutables **sin sesión** (`anon`) y devolvían
saldo pendiente, activos sin devolver e incidencias abiertas de
**cualquier hotel**, con sólo conocer/adivinar el UUID de una estancia --
exactamente el tipo de fuga entre tenants que RLS existe para impedir, y
que ninguna política de RLS puede tapar una vez que la función corre como
su dueño.

Corregido en `0043_reception_readonly_functions_guard.sql` con el mismo
patrón que `deactivate_room()`: `select * into v_stay from public.stays
where id = p_stay_id; if not found then raise 'STAY_NOT_FOUND'; end if;`
seguido de `has_permission(v_stay.hotel_id, 'checkin.perform' |
'checkout.perform')` -- el permiso elegido por consistencia con la acción
que cada función precede (`deliver_room()` exige `checkin.perform`,
`attempt_check_out()` exige `checkout.perform`). `hotel_id` sale siempre
de la fila real, nunca de un parámetro separado que el caller pudiera
desalinear. No se tocó nada más del cuerpo de ninguna de las dos
funciones.

**Validado contra Supabase real** (no sólo local) con las tres pruebas
que exige cualquier cambio de guard multi-tenant en este proyecto: (A)
llamada sin sesión (`anon`, sin `Authorization`) con un `stay_id` real ->
`401`, `PERMISSION_DENIED`; (B) usuario con sesión y permiso sobre una
estancia de su propio hotel -> respuesta normal, sin regresión; (C)
usuario con sesión y con ese mismo permiso, pero en **otro** hotel,
contra una estancia ajena -> `403`, `PERMISSION_DENIED` -- prueba que el
guard valida el hotel de la fila, no sólo si el caller tiene el permiso
en algún hotel. El usuario de la prueba (C) fue una cuenta desechable
creada y borrada sólo para la prueba (nunca se tocaron credenciales de
una cuenta real).

Hallazgo aparte, no corregido a propósito (fuera del alcance de este
fix -- "no toques nada más de estas dos funciones salvo el guard"):
`can_deliver_room()` ya tenía, desde el 0026 original, un bug de lógica
independiente -- cuando hay saldo pendiente hace `return query select
false, reason` pero no corta el flujo, así que después ejecuta también el
`return query select true, null` final, devolviendo 2 filas en vez de 1.
Documentado aquí para que una sesión futura lo corrija a propósito, no
por accidente al tocar esta función de nuevo.

### Alcance de esta sesión (fuera de alcance a propósito)

~~Upgrade/downgrade de habitación con autorización~~ — se construyó en esta
misma sesión, ver "Check-in guiado con upgrade" abajo. Sigue fuera de
alcance: impacto financiero completo de `walked` (`mark_walked()` sólo
registra el evento); aplicación automática de saldo a favor; integración
automática de incidencias hacia un futuro módulo de Mantenimiento
(`stay_incidents` se registra y se resuelve manualmente, sin flujo
automático todavía); Late Check-Out/Early Check-In configurables.

### Check-in guiado con upgrade (feedback de uso real, misma sesión)

"Hacer check-in" dejó de ser un botón suelto: ahora es un flujo de 2 pasos
en `/recepcion` (estado en la URL vía `?checkinStep=`, mismo patrón que los
pasos de Reservaciones) — **1. Cuenta** (hospedaje/extras/pagado/saldo +
registrar un pago ahí mismo) y **2. Habitación** (elegir una habitación
"Equivalente" o "Upgrade disponible", con la diferencia de tarifa ya
calculada). El botón final ("Asignar habitación y hacer Check-In") llama
`check_in()` (0026, sin cambios) y luego la función nueva
`assign_room_for_checkin()` (0032) en la misma Server Action.

`assign_room_for_checkin()` es una función **nueva**, no una edición de
`assign_room()` (0026, que no se toca — sigue siendo la vía estrictamente
equivalente si algún caller la sigue usando). Hace lo mismo que
`assign_room()` pero sin el `ROOM_TYPE_MISMATCH` que bloqueaba elegir un
tipo distinto al vendido: si el `room_type` de la habitación elegida tiene
`base_rate` mayor al vendido, cobra la diferencia × noches como un cargo
real (`register_stay_transaction()`) en la misma transacción — si ese cargo
falla (ej. permisos), toda la reasignación se revierte, no queda un estado a
medias. Downgrade (tarifa menor) no genera abono automático a favor —
mismo criterio que "aplicación automática de saldo a favor" ya fuera de
alcance. Los dos casos (equivalente y upgrade) y el bloqueo de permisos se
probaron localmente antes de mandar la migración.

`listRoomAssignmentOptions()` (nueva query) reemplazó a `listAssignableRooms()`
como la única fuente de opciones de habitación en la UI — agrupa
"equivalente" (mismo tipo, sin costo) y "upgrade" (otro tipo, tarifa mayor,
diferencia ya calculada), y **excluye downgrades de la lista de
recomendaciones** (un tipo más barato no se ofrece como upsell). El bloque
"Asignar habitación (equivalente)" que ya existía para el caso raro de
`checked_in` sin habitación asignada se actualizó para usar la misma
función/query en vez de mantener una segunda implementación (regla 6).

## Configuración: decisiones de esquema (Módulo 04)

Módulo deliberadamente ligero: sólo lo que Reservaciones y Recepción ya
necesitan de verdad (dejaron de editarse a mano en Supabase), no un centro
de configuración exhaustivo. Cubre catálogo de habitaciones, políticas del
hotel y usuarios/roles.

### Catálogo de habitaciones: por qué NO es una tabla nueva ni un campo duplicado

El pedido original describía "habitaciones" con capacidad máxima, si acepta
mascotas y tarifa base — pero `capacity_adults`, `capacity_children` y
`accepts_pets` **ya existían desde 0010 en `room_types`** (la categoría
vendible), no en `rooms` (la unidad física). Esto no es casualidad: todo el
motor de Reservaciones cotiza y bloquea inventario por `room_type_id`,
nunca por `Room` individual (ver Módulo 02, `attempt_inventory_hold()`).
Mover esos campos a `rooms` habría creado una segunda fuente de verdad para
el mismo dato y roto esa premisa.

Decisión (0029): no se duplica nada.

- `room_types` gana `base_rate` (tarifa de referencia por noche) — mismo
  nivel que capacidad/mascotas, porque es el nivel al que hoy se cotiza.

  **Actualización (feedback de uso real, misma sesión):** originalmente se
  documentó aquí como "puramente informativa, el formulario sigue
  capturando el monto a mano" — eso cambió al usar la app: la búsqueda de
  disponibilidad de Reservaciones (`searchAvailableOptions()`, ver
  `modules/reservaciones/queries/availability.ts`) ahora sí precarga
  `base_rate` como tarifa por defecto de cada opción mostrada, editable
  antes de cotizar. Esto NO es el motor de tarifas dinámicas/temporadas
  (`base_rate` sigue siendo un solo número fijo por tipo, sin fechas ni
  reglas) — eso sigue siendo el futuro módulo de Tarifas — pero cerrar el
  ciclo "la tarifa que configuras es la que ves al cotizar" sí se pidió
  explícitamente y no ameritaba esperar a ese módulo.
- `rooms` gana `building` (zona/edificio) y `bed_type` (catálogo cerrado
  chico vía `check`) — estos SÍ son atributos de la unidad física: dos
  habitaciones del mismo `room_type` pueden estar en edificios distintos o
  tener camas distintas.

La pantalla de Configuración por eso tiene dos secciones (Tipos de
habitación / Habitaciones físicas), no una tabla plana — refleja el
esquema real en vez de forzar los dos niveles en uno.

### Políticas del hotel: por qué NO se fusionan `hotel_policies` y `reception_settings`

Se pidió unificar en una sola pantalla clara las configuraciones que
Reservaciones (`hotel_policies`, Módulo 02) y Recepción
(`reception_settings`, Módulo 03) ya usan. Revisando ambas: **no hay ni un
solo campo duplicado o en conflicto entre ellas** — cada una gobierna gates
de su propio módulo (garantía/horarios en una, entrega/checkin
sucia/no-show/checkout en la otra). Fusionarlas en una tabla habría violado
la regla 7 (los módulos no se importan/mezclan entre sí) al nivel de
esquema, y `reception_settings` seguiría siendo, por diseño, propiedad de
Recepción (Módulo 03 ya documentó por qué existe separada).

Decisión: **unificación sólo en la UI**, nunca en el esquema. La pantalla
"Políticas del hotel" de Configuración es dos `Card` una junto a la otra, cada
una escribiendo a su tabla de siempre. Configuración define su propia
lectura/escritura mínima contra ambas tablas
(`modules/configuracion/queries|actions/policies.ts`) en vez de importar
las de `modules/recepcion/` (regla 7 es explícita: los módulos no se
importan entre sí, ni siquiera para una lectura de una fila). Es una
duplicación deliberada de una función de 5 líneas, no de una tabla.

No se expuso edición de `hotel_policies.checkin_assets` (catálogo de
activos) en esta pantalla: el pedido lo marcó explícitamente fuera de
alcance ("ya existe básico en Recepción, no lo expandas todavía"). Sigue
editable sólo por SQL hasta que se pida ese trabajo.

### Usuarios y roles: la única excepción deliberada a "nunca uses admin.ts"

"Invitar" un usuario que todavía no tiene cuenta en HotelOS requiere crear
su fila en `auth.users` — y **eso no se puede hacer con RLS**: no es una
tabla `public.*`, no hay política que un cliente autenticado pueda
satisfacer para insertar ahí, sólo la Admin API de Supabase puede hacerlo.
Es la única razón de este proyecto para tocar `src/lib/supabase/admin.ts`
fuera de un job de sistema, y se acotó lo más posible:

1. `requirePermission(hotelId, 'staff.manage')` corre primero (capa de UX,
   igual que cualquier Server Action).
2. `find_user_id_by_email()` (0031, SECURITY DEFINER) decide si el correo
   ya tiene cuenta. Vuelve a validar `has_permission(hotel_id,
   'staff.manage')` **adentro de la función**, no confía en que el Server
   Action ya lo haya hecho — mismo patrón de defensa-en-profundidad que
   `register_stay_transaction()` — y sólo devuelve un `uuid` o `null`,
   nunca una fila de `auth.users`.
3. Sólo si no existe cuenta, se usa `createAdminClient()` — y únicamente
   para `auth.admin.inviteUserByEmail()`. Ese es el límite exacto del
   privilegio: crear la cuenta y mandar el correo de invitación.
4. La escritura que de verdad importa — asignar el rol en
   `user_hotel_roles` — **siempre** se hace con el cliente normal
   (`createClient()`), sujeta a la misma RLS que cualquier otra escritura
   del proyecto (`has_permission(hotel_id, 'staff.manage')`), sin importar
   si el usuario ya existía o se acaba de invitar.

`profiles` no tenía columna `email` (0003) — sólo vivía en `auth.users`,
que un usuario normal no puede leer vía PostgREST. La pantalla de
Usuarios necesita mostrar el correo para identificar a alguien cuyo
`full_name` puede seguir vacío (invitación no aceptada todavía). Se agregó
`profiles.email` (0030) sincronizada por trigger en alta y en cambio de
correo — nunca escrita a mano, mismo espíritu que `set_audit_fields()`.

Resguardo agregado (no pedido explícitamente, pero directamente ligado al
modelo de acceso): ni `changeStaffRole()` ni `setStaffActive()` permiten
dejar a un hotel sin ningún `hotel_admin` activo — evita que un hotel se
quede sin nadie que pueda administrarlo. Es una sola consulta de conteo,
no un motor de reglas.

### Alcance de esta sesión (fuera de alcance a propósito)

Tarifas dinámicas/temporadas (módulo de Tarifas futuro); expandir el
catálogo de activos entregables de Recepción; facturación, planes de
suscripción y branding del hotel; roles personalizados por hotel (la
columna `roles.hotel_id` ya lo modela desde 0004, pero crear roles sigue
restringido a `platform_admin` — ver 0006).

**Actualización (feedback de uso real, misma sesión):** "branding del
hotel" se pidió parcialmente después de cerrar este alcance — un solo
color de acento (`updateBrandColor()`, guardado en
`hotel_policies.extra_settings.brand_color`, aplicado vía CSS custom
properties con `brandStyleVars()` en `src/lib/color.ts`). Sigue fuera de
alcance todo lo demás de branding completo: logo, tipografía, favicon,
white-label.

### IVA configurable por hotel (0034)

Pedido explícito, con una restricción muy clara: **los montos que
Reservaciones/Recepción ya capturan y muestran (tarifas, cargos, pagos) no
cambian** — siguen siendo el total final tal como el huésped los ve hoy,
IVA ya incluido. Esto NO es una función de cálculo de precios, es sólo
preparación para reportes/contabilidad futuros.

- `hotel_policies.iva_porcentaje` (numeric, default `16.00`, `check` entre
  0 y 100) — configurable porque varía por región (16% general, 8% en zona
  fronteriza en México). Columna aditiva sobre una tabla en producción con
  datos reales: default + `check` no afectan ninguna fila existente, y el
  trigger `handle_new_hotel()` de 0007 (sin tocar) sigue dando de alta la
  fila de políticas de cada hotel nuevo, ahora con `iva_porcentaje = 16.00`
  automáticamente.
- `calculateTaxBreakdown(total, ivaPorcentaje)` en `src/lib/tax.ts` — pura,
  sin acceso a base de datos, `subtotal = total / (1 + iva/100)`,
  `montoIva = total - subtotal`. Toma un monto YA final (con impuesto
  incluido) y lo desglosa; nunca al revés, nunca se usa para calcular ni
  mostrar un precio al huésped. Ningún módulo la llama todavía (no hay
  pantalla de reportes ni facturación electrónica) — queda disponible para
  cuando se pida ese trabajo, tal como se pidió explícitamente.
- Se agregó a la pantalla de Configuración → Políticas del hotel (mismo
  formulario/tabla de "Reservaciones y garantía") con una nota explícita en
  la UI de que no afecta las tarifas mostradas, para no generar la
  expectativa de que cambia algo que hoy ya funciona.

**Validado**: además de las pruebas propias del campo (hoteles existentes
reciben `16.00` por default, un hotel nuevo también, `hotel_admin` puede
cambiarlo a 8.00, un valor fuera de 0–100 se rechaza), se repitió la
batería completa de Reservaciones (`check_availability()`,
`attempt_inventory_hold()`, `confirm_reservation_from_hold()`,
`cancel_reservation()`, ciclo Hold→Reserva→Cancelar) sobre el esquema con
0033+0034 aplicadas: mismos resultados que siempre, nada se rompió.

### `estatus_limpieza` / `estatus_venta`: no son campos nuevos, ya existen (verificado contra Supabase real)

Se pidió confirmar si `estatus_limpieza` (enum Limpia/Sucia, default
"Sucia") ya existía en `rooms`, y si no, agregarlo; lo mismo para
`estatus_venta` con valores "Fuera de Servicio"/"Mantenimiento". Se
verificó **contra la API REST real de Supabase** (no sólo el código,
como se pidió explícitamente), consultando `rooms` directo:

- **`estatus_limpieza` no existe con ese nombre.** El campo real es
  `rooms.is_clean` (boolean, agregado en `0021_rooms_cleanliness.sql`),
  con default `true` — polaridad opuesta a la asumida en la pregunta
  (`true` = Limpia, `false` = Sucia; una habitación nueva nace "Limpia",
  no "Sucia"). Ya es consumido por el gate de limpieza de `check_in()`
  (`0026`) y por `listRoomAssignmentOptions()`/`getStayDetails()` de
  Recepción. Es exactamente el mismo concepto binario que pedía
  `estatus_limpieza` (Limpia/Sucia son sólo dos valores) — agregar una
  columna nueva en paralelo habría creado dos fuentes de verdad para lo
  mismo (regla 6), una de las cuales (la nueva) no la leería ningún gate
  real. Decisión: **no se creó columna nueva**; `rooms.is_clean` sigue
  siendo la única fuente de verdad, y esta sección documenta el nombre y
  los valores exactos para que el futuro módulo Rack lea este campo
  (`is_clean = true` ↔ "Limpia", `is_clean = false` ↔ "Sucia").
- **`estatus_venta` tampoco existe con ese nombre**, y "Fuera de Servicio"
  no es un valor a agregar: **ya es el texto que la UI de Configuración
  usa hoy** para `rooms.is_active = false` (`src/app/configuracion/page.tsx`,
  badge `"En venta"` / `"Fuera de servicio"`). No existe un tercer valor
  "Mantenimiento" distinto de "Fuera de Servicio" — igual que con
  `block_type` en `0033` (`maintenance` ya cubría el mismo concepto que el
  "MANTENIMIENTO" pedido entonces), duplicar aquí un tercer estado para lo
  mismo que ya representa `is_active = false` habría violado la regla 6.
  `is_active` además ya gobierna disponibilidad real
  (`check_availability()`, `attempt_inventory_hold()`,
  `assign_room_for_checkin()` filtran físicamente por `is_active`) — no es
  sólo una bandera de catálogo. Decisión: **no se creó columna ni valor
  nuevo**; Rack debe leer `rooms.is_active` (`true` ↔ "En venta",
  `false` ↔ "Fuera de servicio").
- Gap real encontrado y sí corregido: `is_clean` ya existía y ya se leía
  en Recepción, pero **no era editable desde la pantalla de Configuración**
  (sólo `is_active` lo era, con el patrón "Desactivar/Reactivar"). Se
  agregó `setRoomClean()` (`src/modules/configuracion/actions/rooms.ts`,
  mismo patrón que `setRoomActive()`) y un botón "Marcar sucia/Marcar
  limpia" junto al badge Limpia/Sucia en la fila de cada habitación física
  de `/configuracion?tab=habitaciones` — sin tabla, pantalla ni columna
  nueva, tal como se pidió ("sólo el campo, editable desde la pantalla que
  ya existe"). No requirió migración: la política RLS de `rooms` (`0010`,
  `rooms_write_settings_manager_or_platform_admin`) ya cubre cualquier
  columna de la tabla para quien tiene `hotel.settings.manage`.

**Bug real encontrado al probar este botón contra la app real (no sólo
`psql`/REST):** los tres toggles de Configuración (`setRoomActive`,
`setRoomTypeActive`, y el nuevo `setRoomClean`) pasan por el mismo
`runOrError()` en `src/app/configuracion/actions.ts`, que llama
`redirect()` de vuelta a la **misma URL** (`/configuracion?tab=habitaciones`)
tras la mutación. Sin `revalidatePath()`, Next.js sirve esa navegación
desde el Router Cache del cliente en vez de pedir un render fresco del
Server Component — el valor mostrado quedaba un clic completo "atrasado"
respecto a la base de datos real (confirmado con Playwright: clics
sucesivos sobre el mismo botón mostraban siempre el estado anterior al
último clic, aunque la fila en Supabase sí tenía el valor correcto en
cada paso). No se manifestó antes porque los flujos de Reservaciones/
Recepción navegan a URLs con un parámetro distinto tras cada acción
(`?reservationId=`, `?checkinStep=`), lo que por sí solo invalida la
entrada de caché; Configuración fue el primer módulo en redirigir
siempre a la URL exacta de la que partió. Corregido agregando
`revalidatePath("/configuracion")` en `runOrError()`, antes del
`redirect()` de éxito — cubre los tres toggles y cualquier mutación
futura de este archivo por el mismo punto único. Lección para cualquier
Server Action nueva que haga `redirect()` de vuelta a la URL de origen
(no a una con parámetros distintos): sin `revalidatePath()` el usuario ve
un estado desactualizado hasta la siguiente navegación real, y esto sólo
se detecta probando clics repetidos contra la app corriendo — ni `psql`
ni una sola verificación con Playwright (sin repetir el toggle) lo
revelan.

## Rack: decisiones de esquema

_(Nota: esta sección decía "Módulo 05", pero esa numeración chocaba con
Habitaciones, que el dueño del producto confirmó explícitamente como
Módulo 05 al pedir Caja/Módulo 06 -- ver esa sección. No se reafirma un
número para Rack aquí porque no está confirmado contra la numeración real
del proyecto; se quitó en vez de arriesgar otro choque. Pendiente:
confirmar el número real de Rack con el dueño del producto.)_

Pedido explícito y no negociable de esta sesión: el Rack es una capa de
**vista**, no de dominio. Sin tablas propias (ninguna `rack_*`) y sin
recalcular disponibilidad — lee lo que ya calculan/guardan otros módulos:

- **Reservaciones**: `reservation_stays` (fechas/tipo vendido) +
  `inventory_blocks` (bloqueos comerciales, incluida la extensión física de
  `0033`: `room_id`/`reason`/`created_by`).
- **Recepción**: `stays` (estado físico) + `room_assignments` (habitación
  física actual de cada estancia).
- **Habitaciones/Configuración**: `rooms.is_clean` (limpieza) y
  `rooms.is_active` (fuera de servicio) — los nombres reales ya confirmados
  contra Supabase en la sección anterior, no `estatus_limpieza`/
  `estatus_venta`.

Todo se combina en memoria en `src/modules/rack/queries/grid.ts`
(`getRackGrid()`), con varias consultas simples por tabla — mismo estilo que
`getStayDetails()` de Recepción — en vez de un único `select` con embeds
gigante (evita el riesgo de `GenericStringError`, regla 10, y es más fácil
razonar qué tabla aporta qué dato). Cero migraciones nuevas: todo lo que el
Rack necesita leer y escribir (vía `assign_room()`, 0026) ya existía.

### Por qué una reserva sin habitación física no se "pinta" sobre ninguna fila

`reservation_stays.room_id` existe en el esquema desde `0014` pero **ningún
código lo escribe jamás** (se confirmó releyendo Reservaciones/Recepción
antes de construir esto) — la asignación física real vive únicamente en
`room_assignments`, resuelta hasta Recepción. Eso significa que "reserva
confirmada, tipo vendido, sin habitación todavía" no puede pintarse de forma
honesta sobre una fila concreta de la cuadrícula: no hay dato que diga cuál
de las N habitaciones libres de ese tipo "es" esa reserva.

Se consideró y se descartó repartir esas reservas heurísticamente sobre
habitaciones libres del tipo sólo para que se vieran en la cuadrícula — eso
habría sido inventar un algoritmo de asignación/bin-packing propio del Rack
únicamente para dibujar, exactamente lo que esta tarea prohibió de forma
explícita. En vez de eso, se listan en su propia sección ("Reservas
confirmadas sin habitación asignada", con su propio KPI) — coincide con lo
pedido explícitamente en el alcance del MVP, no es un rodeo.

Esto deja la prioridad `"RESERVED"` por habitación" del enunciado original
implementada pero inerte en la práctica hoy: sólo se activaría si
`reservation_stays.room_id` llegara a escribirse en el futuro (una
pre-asignación comercial explícita, distinta de la operativa de Recepción).
El mismo razonamiento aplica a `BLOCKED`: un `inventory_block` comercial
(`hold`/`reservation`/`overbooking`) sin `room_id` — el caso normal — es
consumo a nivel de TIPO, no de una unidad física; `BLOCKED` sólo se enciende
cuando el bloqueo YA trae `room_id` (0033), lo cual hoy nada escribe todavía
(esa función es del futuro módulo Rack de bloqueos manuales, explícitamente
fuera de alcance de esta sesión). Documentado aquí para que ninguna sesión
futura reabra esta decisión sin saber que ya se evaluó y descartó la
alternativa.

### KPIs "de hoy" independientes de la ventana que se está navegando

Con Anterior/Siguiente el usuario puede estar viendo, por ejemplo, el 20-30
de octubre; las KPIs ("Ocupadas hoy", "Llegadas hoy"...) deben seguir
reflejando el día real de hoy, no el primer día de la ventana visible.
`getRackGrid()` por eso consulta una ventana de cobertura que siempre
incluye la fecha de hoy (unión de la ventana visible + hoy) y calcula el
estado de cada habitación para hoy con la misma función (`computeCell`) que
pinta la cuadrícula, exponiendo al cliente sólo el sub-rango visible. Un
solo cálculo, dos usos — nunca una segunda lógica paralela para las KPIs.

### Conflicto real: detectado al leer, no prevenido con una tabla nueva

`assign_room()` (0026, sin tocar) ya evita crear un conflicto nuevo
(`ROOM_ALREADY_OCCUPIED`), pero el Rack además detecta, por si acaso, dos
casos reales al leer: (a) dos `room_assignments` activos apuntando a la
misma habitación con estancias activas que se traslapan en fecha, (b) una
estancia activa y un bloqueo `maintenance` sobre la misma habitación/fecha
simultáneamente. Ambos se marcan con un indicador distinto (⚠ Conflicto +
`title` con el motivo) — nunca sólo un color, tal como se pidió.

### Mover de habitación (drag & drop vertical) reusa `assign_room()`, no una función nueva

El movimiento vertical (misma fecha, otra habitación) llama a `assign_room()`
de Recepción (0026) vía RPC — la misma función que ya usa el flujo "Asignar
habitación (equivalente)" de Recepción. No se creó una función
`move_room_assignment()` paralela: `assign_room()` ya valida tipo
equivalente y ocupación del destino, y el trigger genérico de auditoría de
`room_assignments` ya registra quién hizo el cambio y cuándo. Lo único que el
Rack agrega encima es un evento de timeline
(`room.assigned_from_rack`/`room.reassigned_from_rack`, con
`previous_room_id`/`new_room_id`/`reason` en el payload) para que quede
trazado también en la bitácora de negocio, más el motivo opcional que pidió
esta tarea y que `assign_room()` no acepta como parámetro.

Por lo mismo, el Rack sólo puede mover a una habitación del MISMO tipo
vendido — `assign_room()` rechaza con `ROOM_TYPE_MISMATCH` si no lo es.
Upgrade/downgrade con cobro de diferencia sigue siendo exclusivo del flujo
guiado de check-in (`assign_room_for_checkin()`, 0032); no se duplicó esa
lógica de cobro aquí.

Nunca es optimista: `RackGrid` (Client Component) muestra un panel de
confirmación tras soltar, y sólo refresca la vista (`router.refresh()`)
después de que el Server Action confirma éxito contra la base de datos; si
`assign_room()` rechaza el movimiento, el error real de Postgres se muestra
tal cual en el panel y nada se mueve visualmente antes de eso.

### Cache de 45s, invalidado explícitamente al mover/asignar

`getRackGrid()` guarda el resultado combinado en un `Map` en memoria del
proceso de Node (TTL 45s) por `hotelId:start:days` — "cache simple" tal como
se pidió, no una capa de infraestructura nueva. **No se pudo usar
`unstable_cache` de Next.js**: internamente la consulta usa `createClient()`
(Supabase SSR), que lee `cookies()`, y Next.js prohíbe llamar APIs dinámicas
dentro de una función envuelta en `unstable_cache` (falla en tiempo de
ejecución). El cache es seguro de compartir entre todo el personal del mismo
hotel: las filas que puede leer un miembro cualquiera vía RLS son las mismas
para cualquier otro miembro del mismo hotel (la política de SELECT sólo
filtra por `hotel_id`, no por rol) — no hay dato personalizado por usuario en
esta pantalla. Cualquier acción que mute algo que el Rack muestra
(`assignRoomFromRack()`) llama `invalidateRackCache(hotelId)` de inmediato,
además de `revalidatePath("/rack")` en el flujo de formulario plano de la
sección "Reservas sin asignar" — la lección del bug de cache de Configuración
(ver arriba) ya estaba fresca al construir esto.

### Bug real encontrado al probar contra Supabase real (no sólo local)

Antes de poder probar el Rack contra la app real, se encontró que la base de
Supabase de este proyecto **no tenía aplicada la migración `0033`** (que sí
está commiteada en el repo desde antes, y sí está aplicada en el Postgres
local de pruebas de esta sesión) — `inventory_blocks.room_id` no existía
todavía, y la consulta del Rack fallaba con
`42703 column inventory_blocks.room_id does not exist`. No es un bug de
esquema: es una migración que quedó sin correr contra el proyecto real en
algún momento anterior (lo más probable: al aplicarlas una por una a mano en
el SQL Editor). Se le reenvió el archivo de la migración (sin cambios) para
correrla de nuevo. Lección para cualquier sesión futura: que este archivo
documente que una migración "ya se validó y aplicó" no es garantía de que el
proyecto de Supabase que se esté usando en un momento dado realmente la
tenga — si una consulta nueva depende de una columna de una migración
anterior, vale la pena confirmarlo contra la API real antes de asumir que ya
existe. Es la misma lección de la regla 9, aplicada aquí a "columna
faltante" en vez de "función mal marcada".

## Habitaciones: decisiones de esquema (Módulo 05)

Completa el dominio que Rack, Reservaciones y Recepción ya consumían
parcialmente vía `room_types`/`rooms` (creados en 0010, extendidos en
0021/0029). Antes de escribir código se auditó el esquema real (no lo que
el pedido asumía) — ver `0041_habitaciones_domain.sql`.

### Dos referencias del pedido que no existen en el código real

Verificadas por `grep` contra todo el repo antes de escribir la migración,
no asumidas:

- **No hay un catálogo normalizado de activos con id propio** ("CAT_
  ACTIVOS_ENTREGA"). Lo que existe es `hotel_policies.checkin_assets`
  (jsonb, catálogo de nombres) y `delivered_assets.asset_name` (texto
  libre contra ese catálogo, sin FK — 0025). `tipo_habitacion_activo` y
  `habitacion_activo_excepcion` (abajo) siguen exactamente ese mismo
  patrón — `asset_name text`, sin FK a una tabla que no existe — en vez
  de inventar un catálogo normalizado nuevo que duplicaría
  `hotel_policies.checkin_assets` (regla 6).
- **No existe una tabla genérica "HistorialCambio"** en el proyecto. La
  auditoría de negocio existente es `timeline_events` (patrón
  transversal) — se usa esa para reclasificación/desactivación, no se
  creó una tabla nueva.

### Capacidad explícita: aditivo, no rename

El pedido pedía `base_adults`/`max_adults`/`max_children`/`max_pets` "o
el nombre que ya tenga esa tabla" asumiendo que Reservaciones ya los
esperaba. Verificado: Reservaciones (`availability.ts`, `confirm.ts`) hoy
sólo lee `capacity_adults`/`capacity_children`/`accepts_pets` (0010) —
esos campos explícitos no existían. Se agregaron como columnas **nuevas**
(backfilleadas desde las existentes: `max_adults ← capacity_adults`,
`max_children ← capacity_children`, `max_pets ← accepts_pets ? 1 : 0`),
sin renombrar ni borrar las viejas — mismo criterio aditivo que
0029/0033/0034, y consistente con que tocar el modelo de capacidad de
Reservaciones está fuera de alcance de esta sesión. Reconciliarlas
(que Reservaciones empiece a leer las nuevas) es evolución futura, igual
que `base_rate` (0029) estuvo "sin conectar" hasta que esta misma sesión
lo necesitó de verdad para el fix de IVA.

### Herencia con excepción (3 estados): HEREDA / AGREGA / EXCLUYE

Para amenidades y activos a nivel Habitacion individual. Sin fila en
`habitacion_amenidad_excepcion`/`habitacion_activo_excepcion` = HEREDA
(toma la base de `tipo_habitacion_amenidad`/`tipo_habitacion_activo`).
Con fila `tipo_excepcion = 'AGREGA'` = la habitación tiene algo que su
tipo no tiene. Con fila `'EXCLUYE'` = la habitación NO tiene algo que su
tipo sí tiene. La resolución (base + excepciones) vive en TypeScript
(`resolveRoomAmenities()`/`resolveRoomAssets()`,
`modules/habitaciones/queries/rooms.ts`), nunca en una vista
materializada — MVP simple, sin infraestructura nueva.

### SnapshotComercialHabitacion: una vez por reserva, dueño = Habitaciones

`congelar_configuracion_comercial(reservation_id)` (SECURITY DEFINER) es
el único camino de escritura — mismo patrón que `hotel_priorities`/
`inventory_blocks` (sin política de INSERT/UPDATE de cliente). Toma la
primera `reservation_stay` de la reserva (el modelo soporta 1:N pero la
interfaz de esta sesión sigue limitando a una Estancia, decisión ya
cerrada de Reservaciones) y congela capacidad + sólo las amenidades con
`es_promesa_comercial = true`, como JSON compacto. `room_id` es nullable
a propósito: al confirmarse, `reservation_stays.room_id` nunca se ha
escrito todavía (ver sección Rack) — se congela lo comercial (tipo), lo
físico es Recepción. Idempotente vía `on conflict (reservation_id) do
nothing`, para que un reintento del mismo confirm no duplique.

`modules/reservaciones/actions/confirm.ts` llama a este RPC **directo**
(`supabase.rpc("congelar_configuracion_comercial", ...)`), nunca
importando `modules/habitaciones/actions/snapshot.ts` — regla 7 (los
módulos no se importan entre sí), mismo patrón exacto que Rack llamando
`assign_room()` por RPC en vez de importar
`modules/recepcion/actions/lifecycle.ts`. El wrapper de Habitaciones
(`congelarConfiguracionComercial()`) sigue existiendo como su propio
punto de entrada, para cuando el propio módulo Habitaciones lo necesite.

### ImpactAnalysis simplificado: SAFE / BLOQUEANTE, sin nivel intermedio

Dos funciones `SECURITY DEFINER`, cada una evaluando la señal real que
ya existe (no una heurística nueva):

- **`deactivate_room(room_id, reason)`** — BLOQUEANTE si existe una fila
  activa en `room_assignments` (`released_at is null`) para esa
  habitación: significa que una Estancia real (actual o futura) depende
  de esa unidad física concreta. No mira `reservation_stays.room_id`
  porque nada lo escribe hoy (mismo hallazgo que la sección Rack).
  Motivo obligatorio, siempre rechazado por Postgres si viene vacío —
  nunca sólo una validación de TypeScript.
- **`update_room_type_capacity(room_type_id, ...)`** — BLOQUEANTE si
  existe una `reservation_stay` de una reserva `confirmed` con
  `check_out` todavía no pasado (fecha operativa del hotel, nunca
  `current_date` de sesión — mismo patrón que `mark_no_show()`, 0035)
  cuya ocupación ya vendida (`adults`/`children`/`has_pets`) no cabría en
  la capacidad nueva.

El nivel intermedio `REQUIERE_AUTORIZACION` queda fuera de alcance a
propósito (pedido explícito de esta sesión) — no hay excepción en el MVP,
un `BLOQUEANTE` siempre rechaza el guardado completo.

### Cambio de comportamiento en Configuración: desactivar ya no es un UPDATE directo

`setRoomActive()` (`modules/configuracion/actions/rooms.ts`) dejó de
hacer `.update({is_active})` directo: ahora llama a
`deactivate_room()`/`reactivate_room()` por RPC (mismo patrón de llamada
directa que arriba, sin importar el Server Action de Habitaciones), y
exige un motivo para desactivar — se agregó un campo "Motivo (obligatorio)"
junto al botón "Desactivar" en `/configuracion?tab=habitaciones`. Esto no
duplica la lógica de ImpactAnalysis (vive una sola vez en el RPC); es la
misma duplicación mínima ya aceptada en este proyecto para no importar
entre módulos (ej. `hotel_policies`/`reception_settings` en Configuración
vs. Recepción).

### Fuera de alcance a propósito (esta etapa)

Sistema de Media con URLs firmadas y contexto (COMERCIAL/DAÑO/
MANTENIMIENTO) — por ahora `photos text[]` simple en `room_types`/
`rooms`; catálogos cerrados de Zona/Edificio; relaciones CONNECTING/
ADJOINING/NEARBY entre habitaciones; `catalog_health_score`; alta masiva
de habitaciones; suministros/inventario; nivel `REQUIERE_AUTORIZACION`
del ImpactAnalysis; reconciliar `capacity_adults`/`capacity_children`/
`accepts_pets` (Reservaciones) con `max_adults`/`max_children`/
`max_pets` (Habitaciones, nuevos). Ningún módulo de negocio nuevo
(Rack/Recepción/Reservaciones) se tocó salvo el punto de integración
explícito de `confirm.ts`.

## Caja: decisiones de esquema (Módulo 06)

Control del movimiento REAL de dinero de la operación. Principio de
propietarios (no renegociable): Reservaciones responde qué se debe cobrar;
Recepción responde cuándo debe pagar el huésped; **Caja responde qué
movimiento real de dinero ocurrió y si cuadra**. Caja nunca se mezcla con
Contabilidad/Finanzas (futuro, fuera de alcance).

### Decisión central: CuentaFolio/MovimientoCuenta YA existen, no se duplican

El spec de Caja pedía `CuentaFolio`/`MovimientoCuenta` como conceptos
nuevos. Verificado antes de escribir código: **ya son `stay_accounts`/
`stay_transactions` (0024, Recepción)** — inmutables, saldo mantenido por
trigger, reverso por contrapartida nunca por edición. Crear una tabla
paralela habría sido exactamente la regla 6 (nunca dupliques algo que ya
existe) al nivel de esquema más caro posible para este módulo. En vez de
eso, `0046_caja_module.sql`:

- Amplía el catálogo cerrado de `stay_transactions.type` (antes sólo
  `charge`/`payment`/`refund`) agregando `adjustment` — el único tipo
  genuinamente nuevo que el spec necesitaba (ajustes manuales, ver abajo).
- Agrega un trigger (`handle_cash_stay_transaction()`) que alimenta
  `cash_movements` cuando una `stay_transactions` en efectivo ocurre —
  sin tocar `register_stay_transaction()`/`void_stay_transaction()` (0026,
  Recepción, sin cambios). Caja "alimenta" la cuenta ya existente
  exactamente como pedía el principio de propietarios, nunca al revés.

### `payments` (0017, Reservaciones) se extiende, no se reemplaza

`payments` es el ledger de **la Reserva** (anticipos/abonos/pago total
antes o al llegar el huésped) — distinto de `stay_transactions`, que es el
ledger de **la Estancia física**. Caja necesitaba que `payments` aceptara
efectivo y métodos configurables, y estados más ricos que
`pending/completed/rejected/reversed`. Cambios, todos aditivos sobre una
tabla en producción con datos reales:

- **`payment_method_id`** (nueva FK nullable a `payment_methods`).
  `method` (el texto legacy `card`/`transfer`) **se conserva intacto** —
  `registerPayment()` de Reservaciones (`src/modules/reservaciones/
  actions/payment.ts`) no se tocó y sigue funcionando exactamente igual,
  sin saber que Caja existe (regla 7). Los pagos nuevos que salen de
  `register_payment_with_movements()` (Caja) fijan ambas columnas.
- **`method` amplía su `CHECK`** de `('card','transfer')` a
  `('cash','card','transfer','other')` — esto sí fue necesario tocarlo
  (no sólo "extender junto a"): sin ampliarlo, un pago en efectivo
  registrado desde Caja habría violado el `CHECK` original al insertar.
  Superset seguro: los dos valores legacy siguen siendo válidos, y
  `registerPayment()` (tipo TS `"card" | "transfer"`) nunca manda otra
  cosa, así que no hay regresión posible.
- **`status` amplía su catálogo** a `pending | completed | rejected |
  reversed | voided | pending_validation` — `completed` se **reusa**
  para "APLICADO" del spec (nunca se agregó un sinónimo, regla 6);
  `voided`/`pending_validation` son los dos genuinamente nuevos
  (ANULADO/EN_VALIDACIÓN).
- Los dos `CHECK` anónimos de `payments` (`method`, `status`) y los dos de
  `stay_transactions` (`type` solo, y `type`+`amount` cruzado) se
  localizan por catálogo (`pg_constraint`), nunca por nombre autogenerado
  asumido — mismo patrón que 0033. Se encontró y corrigió un riesgo real
  al escribir esto: dos `CHECK` distintos de `stay_transactions`
  contienen las palabras `charge`/`payment`/`refund` a la vez (el de
  `type` solo, y el cruzado con `amount`) — un filtro `ilike` que sólo
  buscaba esas palabras habría emparejado ambos y hecho fallar el `select
  ... into` con "more than one row returned". Se desambiguó exigiendo (o
  excluyendo) la palabra `amount` en la definición.

### `payment_movements`: 1 Pago → N MovimientoCaja, sólo `payments`

Decisión explícita y cerrada: `payment_movements` (Pago dividido entre
métodos, ej. $2,000 tarjeta + $1,000 efectivo = un `payments` + dos
`payment_movements`) se ató **sólo a `payments`** (nivel Reserva), no a
`stay_transactions` (nivel Estancia) — un pago durante la estancia sigue
siendo un solo `stay_transactions.method` simple, como siempre. Sin
política de INSERT/UPDATE de cliente (mismo patrón que
`inventory_blocks`/`reservations`): el único camino es
`register_payment_with_movements()`/`register_refund()`.

### `payment_methods`: catálogo configurable, cortesía nunca es un método

`payment_methods` es por hotel, con los flags del spec
(`requiere_referencia`, `requiere_validacion_manual`, `genera_comision`,
etc.). Se siembran 2 métodos por hotel automáticamente al crearse (mismo
patrón `handle_new_hotel_*` que `reception_settings`/`hotel_policies`):
`Tarjeta` (`type='card'`) y `Transferencia` (`type='transfer'`,
`requiere_referencia=true`) — los dos valores que `payments.method` ya
aceptaba, para que el backfill de pagos históricos tenga a qué mapear.
**`Efectivo` no se siembra por defecto** — cada hotel lo agrega desde
Configuración → Métodos de pago si lo necesita (la mayoría sí, pero no es
universal: no se asumió). Cortesía nunca es un método de pago aquí — es
un descuento vía `has_permission()`, porque no hubo dinero real (no se
modeló ninguna fila para ese caso).

### PermisoExcepcion: decisión TEMPORAL, no resuelta a propósito

El spec pide reembolsos/ajustes vía `PermisoExcepcion` (autorización
configurable). Ese módulo transversal **no existe todavía** y no se
construyó aquí — pedido explícito: usar `has_permission()` simple
(`cash.refund`, `cash.adjust`, sembrados a `hotel_admin` y `accounting`,
**no** a `front_desk`) como el resto del proyecto ya hace en todos
lados. **Esto queda documentado como decisión temporal, no definitiva**:
cuando exista `PermisoExcepcion` como módulo propio, `register_refund()`
y `register_stay_adjustment()` deben conectarse a él en vez de al
permiso binario actual. No se re-litiga la decisión de no construirlo
ahora; sí se re-litiga (a propósito) cuál mecanismo de autorización usan
estas dos funciones, el día que exista.

### TurnoCaja (`cash_shifts`/`cash_movements`): lo único genuinamente nuevo

Un turno abierto por hotel a la vez (índice único parcial
`where status = 'open'`) — el turno es el periodo/caja física, **no** el
usuario: varios usuarios pueden cobrar en el mismo turno, cada
`cash_movements.created_by` conserva quién hizo cada movimiento.

`cash_movements` es la única fuente para calcular `EfectivoEsperado`
(`fondo_inicial + Σcash_in − Σcash_out`) — nunca se deriva sumando por
separado `payment_movements`+`stay_transactions` en dos lugares (regla
6). Se llena sola por tres caminos, nunca INSERT directo del cliente:

1. **Trigger** sobre `stay_transactions` en efectivo (ver arriba) —
   **best-effort, nunca bloquea a Recepción**: si el hotel no usa turnos
   (`cash_settings.usa_turnos_caja = false`) o no hay turno abierto, el
   trigger simplemente no genera el movimiento y `register_stay_
   transaction()` sigue funcionando igual (validado explícitamente:
   Recepción no puede depender del estado de Caja para operar, mismo
   principio ya cerrado en el Módulo 03). Es un hueco operativo real y
   consciente si el hotel usa turnos pero olvida abrir uno — no se
   bloquea retroactivamente algo que Recepción necesita poder hacer
   siempre.
2. **`register_payment_with_movements()`/`register_refund()`** (Caja,
   nivel Reserva) — aquí **sí bloquea**: si el método es efectivo y el
   hotel usa turnos pero no hay uno abierto, rechaza con
   `NO_OPEN_CASH_SHIFT`. La asimetría con el punto 1 es intencional: este
   es un camino nuevo que Caja controla por completo, sin una función
   ajena que dependa de que funcione siempre.
3. **`register_cash_expense()`** — egreso operativo manual (taxi, caja
   chica, proveedor menor). Límite explícito de v1: nunca cuentas por
   pagar ni gasto contable completo, eso es el futuro módulo de
   Finanzas — `register_cash_expense()` sólo acepta un turno abierto y
   un monto/concepto, sin flujo de aprobación previo (el propio permiso
   `payments.register` ya es la autorización).

`close_cash_shift()` calcula `efectivo_esperado`/`diferencia` en el
momento del cierre (nunca recalculado después) y los guarda —
`EfectivoContado − EfectivoEsperado`, mostrado en lenguaje simple desde
la UI (`/caja`), nunca como variable técnica cruda.

### Saldo de la Reserva vs. saldo de la Estancia — dos saldos distintos, a propósito

`getReservationBalance()` (`src/modules/caja/queries/payments.ts`) calcula
`Σreservation_stays.rate_total − Σpayments.amount` (neto, `payments.amount`
ya viene con signo: positivo cobros, negativo reembolsos) — es el saldo
que usa el guard de sobrepago de `register_payment_with_movements()`.
**Esto es un saldo distinto de `stay_accounts.balance`** (Recepción,
0024): uno es "cuánto se ha pagado de lo vendido en la Reserva", el otro
es "cuánto debe la Estancia física ahora mismo" (incluye cargos por
consumos/activos que Reservaciones nunca ve). No se fusionan — cada uno
sigue siendo responsabilidad de su módulo, mismo principio que ya cerró
Recepción con `hotel_policies`/`reception_settings` en Configuración.
Nunca se muestra un saldo negativo crudo: `formatBalanceLabel()` traduce
a "Falta por pagar"/"Saldo a favor"/"Cuenta liquidada".

### Sobrepago: nunca se acepta en silencio

`register_payment_with_movements()` calcula el saldo de la Reserva antes
de insertar; si el monto del pago lo supera y el caller no manda
`p_confirm_overpayment = true`, rechaza con `OVERPAYMENT_CONFIRMATION_
REQUIRED` (incluye el saldo pendiente y el monto intentado en el mensaje
para que la UI pueda mostrar la pregunta explícita del spec: "Corregir
monto" / "Registrar saldo a favor"). La UI de `/caja` expone esto como un
checkbox de confirmación explícito, nunca un reintento silencioso.

### Reembolsos: entrada siempre positiva, signo interno preservado

`register_refund()` recibe `p_amount` siempre positivo (nunca se le pide
al usuario capturar un número negativo) y exige motivo. Internamente
inserta `payments` con `amount = -p_amount` — el `CHECK` original de
0017 (`type = 'refund' and amount < 0`) **no se tocó**: seguía siendo
correcto, sólo la UX de captura cambió. Valida que el reembolso no
exceda el pago original cuando se vincula uno (`REFUND_EXCEEDS_
ORIGINAL`), y genera `cash_movements` tipo `cash_out` si el método es
efectivo, con la misma exigencia de turno abierto que un cobro.

### Ajustes manuales: nunca se edita el saldo directo

`register_stay_adjustment()` es el único camino para insertar una fila
`stay_transactions` tipo `adjustment` (permiso `cash.adjust`) — motivo
obligatorio, monto distinto de cero (puede ser positivo o negativo, a
diferencia de `charge`/`payment`/`refund` que tienen signo fijo por
tipo). `register_stay_transaction()`/`void_stay_transaction()` (0026)
nunca emiten este tipo — su propia validación de signo interna sólo
conoce `charge`/`payment`/`refund`, así que ni siquiera intentarían
producir uno por error.

### Herencias obligatorias de este proyecto, aplicadas tal cual

Cada función `SECURITY DEFINER` nueva deriva `hotel_id` de la fila
(`stays`/`payments`/`cash_shifts`), nunca de un parámetro suelto que el
caller pudiera desalinear (lección 0040/0043) — validado explícitamente
contra un usuario de otro hotel intentando `register_stay_adjustment()`
y `register_cash_expense()` sobre filas ajenas: ambos rechazan con
`PERMISSION_DENIED` porque `has_permission()` evalúa el `hotel_id` real
de la fila, no uno que el caller pudiera mandar. `created_by` se fija
explícitamente en cada `INSERT` de las tablas append-only nuevas
(`payment_movements`, `cash_movements`) — lección 0044/regla 11: ninguna
tiene `updated_at`/`updated_by` ni acepta INSERT directo del cliente.
`module.caja` se valida en cada Server Action (`assertFeatureEnabled()`,
nueva en `src/lib/auth/platform.ts`) antes de mutar, siguiendo el patrón
que la sección de Plataforma ya documentó para features conmutables.

### Fuera de alcance a propósito (MVP de esta sesión)

Conciliación completa de método de pago (queda para v2 — pero
`payments`/`payment_movements` ya están diseñadas para no bloquear esa
evolución: `genera_comision`/`proveedor` en `payment_methods` y
`validated_at`/`validated_by` en `payment_movements` ya existen sin
consumidor todavía); corte de caja intermedio sin cerrar turno;
timbrado real de CFDI (`cash_settings.requiere_facturacion_fiscal`/
`rfc_hotel`/`regimen_fiscal` sólo guardan los datos, la integración con
un PAC externo es trabajo futuro); pago que cubre más de una reserva a
la vez (grupos); reembolso parcial de un pago dividido entre métodos
(hoy un reembolso es un método a la vez); Radar 360/Mi Hotel Hoy
consumiendo estos datos. Ningún módulo de negocio existente
(Reservaciones/Recepción/Rack/Habitaciones) se tocó salvo: el `CHECK` de
`payments.method`/`status` (necesario, ver arriba), el `CHECK` de
`stay_transactions.type` (necesario), y un display de un solo renglón en
`src/app/reservaciones/page.tsx` (el texto de método de pago sólo sabía
mostrar "tarjeta"/"transferencia", y ahora un pago en efectivo real
podía llegar por ahí desde que `payments.method` acepta `cash`).

## Plataforma: licencias y features (Fase 0)

Decisiones de modelo comercial multi-tenant:

- `hotels.plan` / `hotels.status` siguen siendo la fuente comercial de
  verdad (existentes desde `0002`). No se duplican.
- `hotel_licenses` (1:1 con `hotels`) guarda sólo límites y fechas:
  `rooms_max` / `users_max` (`NULL` = ilimitado), `starts_at`, `expires_at`
  (`NULL` = sin vencimiento). Hoteles existentes se migran con límites
  `NULL` (grandfathered) para no romper el piloto.
- `plan_features` es el catálogo plan → feature (`PK (feature_key, plan)`).
  Los módulos actuales (`module.reservaciones`, `module.recepcion`,
  `module.rack`, `module.configuracion`, `module.mi_hotel_hoy`) están
  activos en TODOS los planes al lanzar; los futuros (caja, housekeeping,
  tarifas, CRM, mantenimiento, radar_360) diferencian planes. El piloto
  es `basico` y debe seguir funcionando igual.
- `hotel_feature_overrides` (gana sobre `plan_features`) permite a
  plataforma habilitar/deshabilitar una feature puntual para un hotel
  (ej. dar Caja a un hotel Básico por cortesía). Es la ÚNICA tabla del
  proyecto con política de `DELETE` (el override es config derivada, no
  dato de negocio).
- `has_feature(hotel_id, key)`: override gana, luego plan, default false.
  `hotel_enabled_features(hotel_id)`: plan activas ∪ override-activas
  excepto override-desactivadas. Se consumen desde
  `src/lib/auth/platform.ts` (`getHotelFeatures`, `assertRoomLimit`,
  `assertUserLimit`) — nunca en el cliente.
- Límites: se aplican en los puntos de alta (crear habitación, alta de
  personal) vía `hotel_limit_usage()`, lanzando error legible con nombre
  del plan. Defaults: Básico 16 cuartos/6 usuarios, Plus 40/15, Pro ∞.
- Suspensión: `updateHotelLicense` con `status = suspended|canceled`
  desactiva las filas de `user_hotel_roles` marcándolas
  `deactivated_by_suspension = true`. Como `user_hotel_ids()` sólo ve
  membresías activas, TODA la RLS existente niega acceso automáticamente
  sin tocar ninguna política. Reactivar (trial/active) restaura sólo las
  filas marcadas. `user_has_suspended_membership()` permite distinguir en
  login entre "sin hotel" y "hotel suspendido" → redirect a `/suspendido`.
- El gating de features en UI es UX, no seguridad: las Server Actions
  siguen verificando permisos con `requirePermission()`. AppShell recibe
  `features?: string[]` para ocultar módulos del nav.
- **Patrón para enforcement server-side de features (cuando un módulo
  diferencie planes — el primer caso será Caja):** cada Server Action
  nueva que pertenezca a una feature conmutable debe verificarla ANTES de
  ejecutar, llamando a `has_feature(hotelId, 'module.<x>')` en Postgres
  (vía RPC, igual que `getHotelFeatures()` en `src/lib/auth/platform.ts`)
  y abortando con error legible tipo `FEATURE_NOT_ENABLED: module.<x> no
  está incluido en tu plan` si regresa false. El chequeo va en la action,
  no en el componente (el cliente puede saltarse cualquier gate de UI), y
  por sesión/hotel justo antes de la mutación, no cacheado al entrar al
  módulo — un override puede encenderse/apagarse en cualquier momento.
  Las features activas en TODOS los planes desde el lanzamiento
  (`module.reservaciones`, `module.recepcion`, `module.rack`,
  `module.configuracion`, `module.mi_hotel_hoy`) NO llevan este chequeo:
  es ruido para lo que hoy no puede estar apagado. El patrón aplica a
  partir de la primera feature que realmente diferencie planes.
- `/admin` es sólo para `profiles.is_platform_admin` (verificado con
  `is_platform_admin()` en server, no confiar del cliente). Alta de hotel:
  PRIMERO se resuelve al dueño —si el correo ya tiene cuenta se vincula
  (búsqueda por `profiles.email`, que plataforma puede leer vía RLS, 0006);
  si no, se invita por email (`auth.admin.inviteUserByEmail` — excepción
  documentada al veto de `admin.ts`)— y DESPUÉS se crea hotel + licencia
  con defaults del plan + rol `hotel_admin` global. Si el invite falla
  (p. ej. rate limit de correos de Supabase) NO queda hotel huérfano y el
  error dice cómo reintentar. La tabla de /admin muestra el dueño activo
  de cada hotel y permite asignarlo/reasignarlo y reenviar la invitación
  (`assignHotelOwner` / `resendOwnerInvite`, PR #6).
- **Hotel Demo (`/admin` → tab "Demo", `0050`):** la demo vive como un
  hotel más (`slug = 'hotel-demo'`) -- mismo código, misma base, aislado
  sólo por la RLS multi-tenant que ya existe, sin infraestructura
  paralela. `reset_demo_hotel()` (`SECURITY DEFINER`, sólo
  `platform_admin`) borra todo el dato operativo de ese hotel y lo
  re-siembra con ~7 semanas de historial ancladas a `current_date` para
  que la demo se vea viva (ocupación/ADR/revPAR con historia,
  llegadas/estancias en curso, incidencias, timeline real). Reset manual
  a propósito en esta fase (un reset automático destruiría lo que el
  equipo genera explorando) -- la misma función puede programarse como
  cron cuando la demo sea pública. Esta migración se escribió en una
  rama distinta (`feature/demo-reset`) que se bifurcó antes de que este
  branch agregara `0041`-`0048`; se reconcilió trayendo `0050` tal cual
  (ya estaba aplicada en producción) -- ver la nota junto a la tabla de
  migraciones sobre el hueco en `0049`.

## Fecha operativa del hotel (businessDate)

La fecha operativa de un hotel nunca debe calcularse directamente desde UTC
o desde el navegador. Los módulos deben consumir la fuente central de
`businessDate` basada en `hotel.timezone` — no reinventar
`new Date().toISOString().slice(0, 10)` por módulo: dos hoteles en
timezones distintos, o el mismo hotel cerca de medianoche, verían un "hoy"
equivocado.

`getHotelBusinessDate(hotelId)` (`src/lib/getHotelBusinessDate.ts`, cálculo
puro en `src/lib/businessDate.ts`) es esa fuente única en TypeScript: lee
`hotels.timezone` (columna IANA que ya existía desde `0002_hotels.sql`, sin
usarse hasta este cambio — no hizo falta migración nueva) y devuelve la
fecha calendario de ese hotel en ese instante. La usan Rack
(`getRackGrid()`) y Reservaciones (validación de fechas pasadas).

Esta misma regla aplica dentro de Postgres: ninguna función SQL debe usar
`current_date`/`current_timestamp` (dependen del timezone de la *sesión* de
la base de datos, no del hotel) como sustituto de "hoy" para una decisión
operativa. La forma correcta dentro de una función es
`(now() AT TIME ZONE v_hotel_timezone)::date`, leyendo `v_hotel_timezone`
de `hotels.timezone` para el `hotel_id` de la fila en cuestión — ver
`mark_no_show()` (`0026`, corregida en `0035_no_show_hotel_timezone.sql`)
como el patrón a seguir. TypeScript y Postgres tienen implementaciones
técnicas distintas pero deben producir siempre el mismo resultado.

Los timestamps técnicos (`created_at`, `updated_at`, `resolved_at`,
expiración de Holds, `timeline_events`, etc.) siguen en UTC normal — esto
sólo aplica a "qué día es hoy" para el hotel, no a cuándo ocurrió algo.

Etapa actual: `businessDate` = fecha calendario en el timezone del hotel,
sin corte nocturno (`business_day_cutoff` queda para una evolución futura).

## Motor de reglas y Prioridades (Mejora transversal 02)

Infraestructura transversal para el paso que faltaba del patrón de este
documento:

```
DATOS → ESTADO OPERATIVO → REGLA → PRIORIDAD → NEXT ACTION
  → USUARIO EJECUTA → RESOLUCIÓN → TIMELINE/HISTORIAL → KPI/RADAR futuro
```

Dos distinciones que **no se deben re-litigar**:

1. **Catálogo de reglas (`hotel_rules`) ≠ evaluadores.** `hotel_rules` es
   config/metadata pura (severidad, peso, si permite asignación, etc.) —
   **nunca contiene código ejecutable ni SQL dinámico**. La condición real
   de cada regla vive en un evaluador de TypeScript versionado y explícito
   en `src/modules/priorities/evaluators/` (ej.
   `arrivalNotRegisteredEvaluator()`), registrado a mano en el mapa
   `rule.code -> evaluador` de `src/modules/priorities/engine.ts`. Agregar
   una regla nueva siempre significa escribir un evaluador nuevo, nunca
   guardar una expresión/condición en una fila.
2. **Prioridad (`hotel_priorities`) ≠ Tarea manual.** Una prioridad existe
   porque una condición operacional detectada por HotelOS activó una
   regla — nunca es algo que un usuario crea a mano. Una futura "Tarea"
   manual (ej. "limpiar la 305") es otra entidad y otro módulo; no se
   modeló aquí ni se debe fusionar con esto.

### `hotel_id` nullable en `hotel_rules`: mismo patrón que `roles`

`hotel_id` nulo = regla global de HotelOS (el único caso que existe hoy).
Con valor = override futuro de esa regla para un hotel concreto — **no
implementado todavía** (sólo el esquema lo soporta: `unique(hotel_id, code)`
+ índice único parcial para code global, exactamente como `roles`, 0004).
No hay resolución de "regla efectiva" combinando global+override; el motor
v1 sólo lee las reglas globales (`hotel_id is null`).

### Por qué no hay `visible_roles`

Se pidió `visible_roles` (o "criterio equivalente compatible con el modelo
actual de permisos"). El modelo de permisos de este proyecto es por
capacidad (`has_permission()`), no por visibilidad de fila por rol — y la
visibilidad de `hotel_priorities` ya la resuelve RLS por membresía de hotel
(igual que `stays`/`reservations`/`room_assignments`): cualquier miembro
del hotel ve todas sus prioridades. Agregar `visible_roles` como filtro de
UI habría duplicado esa garantía con lógica de aplicación en vez de
Postgres — exactamente el error que la regla 2 de este documento previene.
`responsible_role` (nullable) sí se agregó, pero es sólo informativo (para
una futura UI de asignación), nunca control de acceso.

### `auto_resolution_condition` → `supports_auto_resolution` (boolean)

La tarea prohibió explícitamente guardar una condición ejecutable en el
catálogo. `hotel_rules.supports_auto_resolution` sólo declara si se espera
que el evaluador de esa regla pueda auto-resolver — la lógica real de "ya
no aplica" vive en el evaluador y en `auto_resolve_stale_priorities()`
(ver abajo), nunca en una columna.

### Deduplicación: un índice único parcial, no una comparación en código

`hotel_priorities` tiene un índice único parcial:
`unique (dedupe_key) where status in ('OPEN','ACKNOWLEDGED','ASSIGNED','IN_PROGRESS')`.
Esto es lo que permite que `upsert_hotel_priority()` (`SECURITY DEFINER`)
haga `insert ... on conflict (dedupe_key) where ... do update ...` como una
sola operación atómica — nunca "leer si existe, luego insertar" desde
TypeScript, que tendría una ventana de carrera real si el motor llegara a
correr más de una vez en paralelo (mismo principio que los índices únicos
parciales de `inventory_blocks`, 0015). Como el índice sólo cubre estados
**activos**, una prioridad puede resolverse y, más tarde, la misma
condición puede generar una ocurrencia nueva sin chocar con la fila
histórica ya resuelta — el historial nunca se borra.

`upsert_hotel_priority()` devuelve `out_is_new` (vía el modismo
`xmax = 0` del `RETURNING`) para que el motor sepa si esto fue una
detección genuinamente nueva o sólo un refresco de una ya activa — sólo en
el primer caso se registra `priority.detected` en el timeline (principio
"no registrar cada evaluación, sólo cambios significativos").

**Bug real encontrado probando esta función contra Postgres local antes de
mandarla:** los parámetros de salida de `returns table (...)` se declaran
como variables plpgsql visibles en todo el cuerpo de la función. Nombrar
uno `status` (igual que la columna real de `hotel_priorities`) volvía
ambiguo `where status in (...)` dentro del `ON CONFLICT` — Postgres no
sabía si era la variable de salida o la columna. Se corrigió prefijando
los parámetros de salida (`out_priority_id`, `out_status`, `out_is_new`) en
vez de reusar los nombres de columna. Lección para cualquier función nueva
con `returns table (...)` que además haga referencia a columnas del mismo
nombre en su cuerpo: nombra los parámetros de salida de forma que nunca
puedan coincidir con una columna real.

### `auto_resolve_stale_priorities()`: acotado a una regla a la vez

Recibe la lista completa de `dedupe_key` que el evaluador considera
vigentes **para esa regla** en esta corrida, y cierra (RESOLVED,
`auto_resolved = true`) cualquier prioridad activa de esa misma regla cuyo
`dedupe_key` ya no esté en la lista. Deliberadamente acotado por
`rule_id` para que nunca resuelva por accidente prioridades de otra regla
evaluada en la misma corrida del motor.

### Permisos: detección ≠ acción humana

Un solo permiso nuevo, `priorities.manage` (sembrado a `hotel_admin` y
`front_desk`), gatea únicamente las transiciones manuales
(acknowledge/assign/in_progress/resolve/dismiss vía
`src/modules/priorities/actions/lifecycle.ts`, RLS `UPDATE` de
`hotel_priorities`). La detección/dedupe/auto-resolve del motor
(`upsert_hotel_priority()`/`auto_resolve_stale_priorities()`) **no**
exige ese permiso — sólo pertenencia al hotel (mismo criterio que
`logTimelineEvent()`): es comportamiento de sistema, no una acción de
negocio privilegiada, y no debe bloquearse para un rol que todavía no
tiene `priorities.manage`. Lectura (`SELECT`) tampoco requiere el permiso:
igual que `stays`/`reservations`, cualquier miembro del hotel ve las
prioridades de su hotel vía RLS — así se cumple "Owner/Manager visibilidad
completa" sin inventar un permiso sólo para leer.

`hotel_priorities` no tiene política de `INSERT` para el cliente (sólo
`upsert_hotel_priority()` escribe ahí) ni de `DELETE` nunca — mismo patrón
que `inventory_holds`/`inventory_blocks`/`reservations` (0015/0016): el
historial no se borra, es lo que el futuro Radar 360 necesita.

### `DISMISSED` reusa `resolved_at`/`resolved_by`/`resolution_reason`

No se agregaron `dismissed_at`/`dismissed_by`/`dismissal_reason` por
separado: serían las mismas tres columnas con otro nombre para el mismo
concepto ("quién/cuándo/por qué se cerró"), justo lo que la regla 6 de
este documento pide evitar. `DISMISSED` es un cierre terminal igual que
`RESOLVED`, sólo que sin corregir la condición
(`auto_resolved` siempre `false` en un dismiss, siempre manual) — la
acción de dismiss en `lifecycle.ts` exige un motivo no vacío.

### Primera regla vertical: `ARRIVAL_NOT_REGISTERED`

Se descartó a propósito el ejemplo del enunciado de la tarea (habitación
no lista al llegar el huésped) porque roza Housekeeping. La regla elegida
se determina enteramente con datos que ya existen —
`stays.status = 'expected'` + `reservation_stays.check_in` ya pasado según
`getHotelBusinessDate()` — sin Housekeeping, sin Caja, sin tocar ninguna
regla de Reservaciones/Recepción ni introducir dinero. No implica
no-show: `mark_no_show()` (0026/0035) sigue siendo la única decisión que
cambia el estado de la Estancia; esta prioridad es puramente informativa
("nadie ha actuado todavía").

### Scoring: determinista, sin dinero

`computePriorityScore()` (`src/modules/priorities/scoring.ts`) es
`severity_weight + rule.priority_weight` — nada de IA/ML, y a propósito
**nunca** incluye `impact_amount`: una oportunidad comercial de alto valor
no debe desplazar una situación operativa crítica sólo por tener más
impacto económico. Aging/escalation queda para una evolución futura (el
campo `priority_score` ya vive en la fila, listo para ese cálculo cuando
se necesite).

### Fuera de alcance a propósito (esta etapa)

Dashboard "Mi Hotel Hoy", Radar 360, editor de reglas, notificaciones
(push/email/WhatsApp), cron/workers/colas, resolución de
regla-global-más-override, algoritmo de `group_key`, enforcement de
`cooldown_minutes` (la columna existe; el motor v1 no la aplica todavía).

### Ajuste 02.1: endurecimiento y cierre del Motor V1 (0037)

La v1 (0036) ya tenía RLS + `has_permission()` + `requirePermission()`,
pero dos fronteras quedaron más abiertas de lo necesario: cualquier
miembro autenticado del hotel podía invocar `upsert_hotel_priority()`/
`auto_resolve_stale_priorities()` por REST y controlar campos que
conceptualmente son del motor, no del caller; y la política de `UPDATE`
de `hotel_priorities` permitía, a quien tuviera `priorities.manage`,
modificar *cualquier* columna (no sólo las de una transición humana
legítima). `0037_priority_engine_hardening.sql` cierra ambas sin agregar
infraestructura nueva (sin workers/colas/cron/service_role):

1. **`upsert_hotel_priority()` ya no acepta `severity`/`category`/
   `priority_score`/`source_module` como parámetros** (se quitaron de la
   firma, no sólo se ignoran) -- siempre se derivan de `hotel_rules` a
   partir de `rule_id`, que ahora se valida que exista, aplique al hotel
   (global o de ese hotel) y esté activo. El cálculo de `priority_score`
   (`severity_weight + rule.priority_weight`) que antes vivía en
   `src/modules/priorities/scoring.ts` (TypeScript) se movió por completo
   a la función SQL -- tener el mismo cálculo en dos lenguajes sólo servía
   para que el del cliente fuera el que un caller malicioso podía
   ignorar; `scoring.ts` se borró (dead code una vez que dejó de tener
   caller). `dedupe_key` se valida contra el prefijo `"<rule.code>:"` y
   `source_event_id`, si viene, contra que el evento pertenezca al mismo
   hotel. `title`/`message`/`reference_type`/`reference_id`/`action_*`/
   `impact_*` siguen siendo del caller porque son contenido dinámico que
   sólo el evaluador de TypeScript conoce (nombre del huésped, fechas...)
   -- no hay forma de derivarlos en SQL sin reintroducir lógica de regla
   ahí, exactamente lo que la arquitectura de evaluadores prohíbe. Este
   residual (un miembro del propio hotel podría, llamando el RPC directo,
   crear una prioridad con un título/mensaje inventado pero con
   severity/score/categoría siempre honestos, dentro de su propio hotel)
   queda documentado como riesgo aceptado, no como pendiente.
2. **`hotel_priorities` ya no tiene política de `UPDATE` para el
   cliente** -- mismo patrón que la ausencia de política de `INSERT` que
   ya tenía desde 0036. Las 5 transiciones humanas (`acknowledge`,
   `assign`, `start_progress`, `resolve`, `dismiss`) son ahora funciones
   `SECURITY DEFINER` dedicadas (`acknowledge_hotel_priority()` etc.),
   mismo patrón que `check_in()`/`assign_room()`/`mark_no_show()` (0026):
   cada una revalida `has_permission(hotel_id, 'priorities.manage')`
   *adentro*, deriva `hotel_id` de la fila (no de un parámetro que el
   caller pudiera desalinear), exige que el estado actual esté en el
   conjunto de origen válido para esa transición (si no, `INVALID_
   TRANSITION`) y sólo escribe las columnas de esa transición. Server
   Actions (`lifecycle.ts`) siguen llamando `requirePermission()` primero
   (capa de UX) pero ya no hacen el `.update()`: invocan el RPC
   correspondiente. Esto es lo que de verdad impide `RESOLVED`/
   `DISMISSED` -> estado activo (no hay reapertura en v1, por diseño) y lo
   que hace que descartar sin motivo sea imposible aunque alguien se
   salte `lifecycle.ts` (`dismiss_hotel_priority()` rechaza motivo vacío
   con `DISMISS_REASON_REQUIRED`, no sólo el `if (!reason.trim())` de
   TypeScript).
3. **`assign_hotel_priority()` valida que el usuario asignado tenga una
   fila activa en `user_hotel_roles` para el mismo hotel de la
   prioridad** -- antes nada impedía asignar a alguien de otro hotel
   salvo la UI.
4. `auto_resolve_stale_priorities()` ganó la misma validación de
   `rule_id` (existe y aplica al hotel) por consistencia con
   `upsert_hotel_priority()`, aunque su firma no cambió. Queda como
   riesgo aceptado (no resuelto en este ajuste, no pedido) que un
   miembro del propio hotel podría llamarla directo con una lista vacía
   de `dedupe_keys` vigentes y auto-resolver de golpe todas las
   prioridades activas de una regla en su propio hotel -- es
   autolesión dentro del propio tenant, no una fuga entre hoteles ni una
   escalación de privilegio, y arreglarlo de raíz requeriría que Postgres
   pudiera re-ejecutar el evaluador de TypeScript (imposible sin romper
   la separación catálogo/evaluador de esta arquitectura).

**Por qué no se usó `service_role`**: el motor (`evaluateHotelRules()`)
sigue corriendo con el cliente normal (`createClient()`, sesión del
usuario) -- llama los mismos RPCs `SECURITY DEFINER` que un caller
directo por REST podría llamar, porque no existe en esta arquitectura una
identidad "sistema" distinta de "usuario autenticado" sin agregar
infraestructura nueva (cola, worker, secreto compartido) que esta tarea
pidió explícitamente no construir. La mitigación por eso no es "impedir
la llamada directa" (no es posible sin esa infraestructura) sino "reducir
al mínimo necesario lo que esa llamada puede fabricar", exactamente lo
que hace el punto 1.

### Trade-off consciente: `hotel_priorities.created_by` queda NULL en toda alerta del motor (0038)

Consecuencia directa del cierre de 0038: `upsert_hotel_priority()` sólo
acepta llamadas de `service_role` (`auth.role() = 'service_role'`), y el
trigger genérico `set_audit_fields()` que sí tiene `hotel_priorities`
(0036) fija `created_by = auth.uid()` -- que para una llamada de
`service_role` (sin JWT de usuario) siempre es `NULL`. Es decir: **toda
prioridad creada por el motor queda con `created_by = NULL`**, siempre,
por diseño de 0038, no por un bug.

Auditoría externa lo señaló y el dueño del producto ya decidió: esto se
**acepta tal cual**, no se corrige. Una alerta generada automáticamente
por una regla del sistema no tiene un "creador humano" -- forzar un
`created_by` ahí (ej. usando el `auth.uid()` de quien disparó la
evaluación desde la UI, que es incidental y no el origen real de la
alerta) sería falsear la auditoría, no repararla. La auditoría real de
"por qué existe esta prioridad" ya vive en `rule_id` + `detected_at` +
`source_event_id` (0036/0037), que sí describen el origen con precisión;
`created_by` simplemente no es el campo correcto para esa pregunta en
esta tabla. Las 5 transiciones humanas (`acknowledge_hotel_priority()` y
el resto, 0037) sí corren con el cliente de sesión del usuario y sí dejan
`updated_by` correcto -- el hueco es exclusivamente `created_by` en el
`INSERT` original del motor, y sólo ahí.

## Fuente única de precio (auditoría externa, Tier 1)

Auditoría externa encontró que HotelOS no tenía una fuente única de
cálculo de precio: cuatro puntos distintos lo resolvían cada uno por su
cuenta -- `submitSearchAndQuote()` tomaba `nightlyRate` crudo del
`FormData` del navegador; `searchAvailableOptions()` mostraba
`room_types.base_rate` como "precio de referencia" sin validarlo;
`submitConfirmReservation()` tomaba un `rateTotal` **independiente**
también crudo del `FormData`, sin relación alguna con lo ya cotizado; y
`listRoomAssignmentOptions()` (Recepción) recalculaba el upgrade con
`room_types.base_rate` en vez de la tarifa realmente vendida. Un mismo
hueco con cuatro síntomas, no cuatro bugs distintos -- se propuso el
diseño completo antes de tocar código (mismo patrón que el fix de
`service_role`, 0038, y el de IVA, 0034) y se aprobó por partes: Tier 1
(cierra los cuatro síntomas reportados) primero, Tier 2 (cerrar
`quote_options` al mismo patrón sin-INSERT-de-cliente que
`inventory_blocks`/`reservations`) como decisión separada posterior.

### Tier 1: cálculo central + freeze real en confirm

- **`src/lib/pricing.ts` (`calculateStayPrice()`)** -- función pura, sin
  acceso a DB, mismo espíritu que `calculateTaxBreakdown()` (0034): recibe
  `baseRateNightly` (ya resuelto por el caller desde `room_types.base_rate`),
  `nights`, un `nightlyRateOverride` opcional y `ivaPorcentaje`, y devuelve
  `{ nightlyRateUsed, subtotal, taxes, total, isOverride }`. El override
  **no se prohíbe** -- sigue siendo la tarifa negociada que el staff ya
  podía capturar al cotizar (Módulo 04) -- sólo deja de determinar el total
  por su cuenta: pasa por el mismo cálculo que la tarifa de lista.
- **`createQuote()`** (`modules/reservaciones/actions/quote.ts`) ya no
  acepta `subtotal`/`taxes`/`total` del caller: recibe
  `nightlyRateOverride?`, resuelve `room_types.base_rate` server-side y
  calcula con `calculateStayPrice()` antes de insertar en `quote_options`.
  `submitSearchAndQuote()` dejó de hacer aritmética -- sólo reenvía
  `nightlyRate` (si el staff lo editó) como `nightlyRateOverride`.
- **`confirm_reservation_from_hold()` (0047) perdió `p_rate_total` de la
  firma por completo** -- no sólo dejó de usarse, se quitó del parámetro
  (drop + create, Postgres no permite quitar un parámetro con
  `create or replace`; mismo criterio ya aplicado en 0037 a
  `upsert_hotel_priority()`: "se quitan de la firma, no sólo se ignoran").
  `rate_total` se deriva siempre de
  `inventory_holds.quote_option_id -> quote_options.total` -- el mismo
  Hold que se está confirmando, nunca de un valor que el navegador
  reenviara en el formulario de confirmación. Un Hold sin
  `quote_option_id` (no generado por la UI actual) sigue cayendo en 0,
  igual que el default anterior. Se aprovechó el mismo cambio de firma
  para aplicarle la higiene de 0045/0046 (`revoke ... from public/anon`,
  sólo `authenticated`), ya que de cualquier forma había que recrear la
  función.
  `confirmReservation()`/`submitConfirmReservation()` dejaron de pedir
  `rateTotal`; el campo oculto `rateTotal` del formulario de confirmación
  (`src/app/reservaciones/page.tsx`) se eliminó -- ya no hay ningún valor
  de precio que el cliente pueda reenviar en ese paso.
- **`listRoomAssignmentOptions()`** (Recepción) gana un parámetro
  `soldNightlyRate` (la tarifa **realmente vendida**,
  `reservation_stays.rate_total / noches`) que reemplaza el
  `room_types.base_rate` del tipo vendido como base de comparación del
  upgrade -- ambos podían divergir por una tarifa negociada al cotizar, o
  porque `base_rate` cambió en Configuración después de confirmarse esa
  reserva en particular. El lado "upgrade" sigue comparando contra el
  `base_rate` **actual** del tipo candidato -- no hay tarifa histórica que
  congelar para una habitación que el huésped nunca reservó. Su único call
  site (`src/app/recepcion/page.tsx`) ya tenía `rate_total` cargado para
  el estado de cuenta; se reordenó para calcular `soldNightlyRate` antes
  de pedir las opciones, sin duplicar la lectura.

**Validado localmente antes de mandar la migración** (Postgres 16 local,
mismo rigor que toda migración de este proyecto): cotizar con y sin
override reconstruye `subtotal + taxes = total` exacto en ambos casos;
confirmar una reserva real dentro de una transacción de prueba deja
`reservation_stays.rate_total` **idéntico** a `quote_options.total` del
Hold confirmado, sin que ningún parámetro de precio exista ya en la
llamada; un Hold sin cotización previa sigue cayendo en `rate_total = 0`
(comportamiento sin cambios); la firma vieja con `p_rate_total` ya no
resuelve en absoluto (`function ... does not exist`); el gate de
`has_permission('reservations.create')` sigue rechazando a un rol sin ese
permiso (código de la función sin tocar, sólo se movió la derivación del
precio). Pendiente de aplicar contra Supabase real y repetir estas mismas
pruebas ahí antes de dar el ciclo por cerrado.

### Tier 2: `quote_options` sin INSERT de cliente (0048)

Antes de tocar la política, se confirmó lo pedido: la política de
escritura anterior (`quote_options_write_reservations_create_or_platform_admin`,
0012, endurecida en 0044) **ya exigía ambas cosas**, no sólo
`created_by = auth.uid()` -- el `WITH CHECK` (y el `USING`) pedían
`created_by = auth.uid() AND (is_platform_admin() OR has_permission(hotel_id, 'reservations.create'))`.
Es decir: un caller que se saltara el Server Action y pegara directo a
PostgREST con su propio token ya no podía insertar una cotización para
otro usuario, ni para un hotel donde no tiene `reservations.create` --
pero sí podía, dentro de su propio hotel y con ese permiso legítimo,
insertar un `total` fabricado que nunca pasó por el cálculo real. A
diferencia del residual ya aceptado en 0037 para `upsert_hotel_priority()`
(un título/mensaje inventado, puramente informativo), éste sí tenía
dinero de por medio.

`0048_quote_options_no_client_insert.sql` cierra esto con el mismo patrón
que `inventory_holds`/`inventory_blocks`/`reservations` (0013/0015/0016):
se retira por completo la política de escritura de `quote_options` (ya no
hay `INSERT` ni `UPDATE` de cliente, sólo `SELECT`) y el único camino de
escritura pasa a ser `create_quote_option()` (`SECURITY DEFINER`).

**Diferencia clave con Tier 1**: Tier 1 sólo dejó de *confiar* en un total
ya calculado por el cliente (`createQuote()`, en TypeScript, seguía
haciendo el cálculo). Tier 2 mueve el cálculo mismo **por completo** a
`create_quote_option()` -- mismo criterio que 0037 aplicó a
`priority_score` ("tener el mismo cálculo en dos lenguajes sólo servía
para que el del cliente fuera el que un caller malicioso podía ignorar").
La función deriva `hotel_id` de la fila de `quotes` (que ya existe cuando
se la invoca -- `createQuote()` la inserta primero, sin cambios), nunca de
un parámetro suelto (lección 0040/0043); resuelve `room_types.base_rate`
y `hotel_policies.iva_porcentaje` ella misma; y sólo acepta
`p_nightly_rate_override` como entrada de precio -- la misma tarifa
negociada que el staff ya podía capturar, nunca un total/subtotal/taxes ya
hechos. Un caller que invoque el RPC directo por REST, aunque tenga
`reservations.create` legítimo en su propio hotel, **no tiene ningún
parámetro de precio que fabricar**: sólo puede pedir una tarifa por noche
distinta, que pasa por el mismo cálculo que la tarifa de lista.

Como consecuencia, `src/lib/pricing.ts` (`calculateStayPrice()`, Tier 1)
se quedó sin caller -- `createQuote()` ya no calcula nada, sólo reenvía
`nightlyRateOverride` al RPC y usa `option.total` de lo que el RPC
devuelve. Se borró, mismo destino que `scoring.ts` en 0037.

**Validado localmente** (mismo Postgres 16 de las pruebas de Tier 1, con
0047+0048 aplicadas juntas):
- **A** -- un `INSERT` directo a `quote_options` con un `total` fabricado
  (`1`, muy por debajo del real), ejecutado como `hotel_admin` de Hotel A
  con `reservations.create` legítimo *en su propio hotel*, es rechazado
  categóricamente por RLS (`new row violates row-level security policy for
  table "quote_options"`) -- no hay ninguna combinación de permiso que lo
  permita, porque ya no existe política de `INSERT` en absoluto.
- **B** -- el flujo normal (`create_quote_option()` vía RPC, tal como lo
  llama `createQuote()`) sigue funcionando exactamente igual: tipo
  Sencilla de Hotel A (`base_rate = 950`), 2 noches, sin override →
  `total = 1900.00`, `subtotal = 1637.93`, `taxes = 262.07`.
- **C** -- mismo tipo/hotel, 2 noches, con `p_nightly_rate_override = 700`
  → `total = 1400.00`, `subtotal = 1206.90`, `taxes = 193.10` -- **valores
  idénticos** a los que `calculateStayPrice()` (TypeScript, Tier 1) ya
  había calculado para el mismo caso antes de borrarse, confirmando que
  mover el cálculo a SQL no cambió el resultado. La firma de
  `create_quote_option()` se confirmó de 8 parámetros, ninguno
  `subtotal`/`taxes`/`total` -- no existe vector para inyectar un precio
  ya hecho.

**Actualización: `0047`/`0048` ya se aplicaron a Supabase real y las
pruebas A-D se repitieron ahí con los mismos resultados** -- ver el
detalle en la sección "Handoff de demo P0" (más abajo, P0-1) para el
hallazgo real encontrado después: `confirm_reservation_from_hold()` podía
lanzar `HOLD_EXPIRED` sin que nada lo atrapara, produciendo un 500 crudo
en vez de un mensaje claro. No es una regresión de Tier 1/2 -- ese hueco
de manejo de errores ya existía desde antes de esta auditoría de precio;
Tier 1/2 sólo cambiaron QUÉ se manda al RPC, nunca si sus errores se
atrapan.

## Handoff de demo P0 (bloqueos de funcionalidad core)

Ronda de corrección sobre una lista de 8 hallazgos (P0-1 a P0-8) reportados
contra el Hotel Demo real. Se diagnosticó primero (reproduciendo cada uno
contra Hotel Demo recién reiniciado con `reset_demo_hotel()`, 0050) y sólo
después se corrigió -- varios comparten la misma causa raíz, documentada
una sola vez aquí en vez de repetida por punto.

### P0-1: error 500 crudo al confirmar -- causa real, no dato faltante ni regresión de precio

Reproducido en vivo: `submitSearchAndQuote()`/`submitConfirmReservation()`
(`src/app/reservaciones/actions.ts`) y sus hermanos (`submitCreateHold`,
`submitReleaseHold`, `submitCancelReservation`,
`submitRegisterAdditionalPayment`) no atrapaban ninguna excepción de
negocio -- un Hold vencido (`HOLD_EXPIRED`, 0016) llegando a
`confirmReservation()` producía un `throw` sin capturar, Next.js lo
renderizaba como su página de error genérica ("A server error occurred"),
`digest` incluido. Confirmado con el log real del servidor:
`⨯ Error: {"code":"P0001",...,"message":"HOLD_EXPIRED"} ... POST
/reservaciones?holdId=... 500 ... submitConfirmReservation`. No es un dato
faltante del seed (0050) ni una regresión de Tier 1/2 (ver nota arriba) --
es un hueco de manejo de errores que ya existía.

Corregido con `src/lib/friendlyError.ts`
(`friendlyErrorMessage(error, fallback?)`): traduce los códigos que este
proyecto ya usa (`HOLD_EXPIRED`, `HOLD_NOT_ACTIVE`, `NO_AVAILABILITY`,
`PERMISSION_DENIED`, `ROOM_TYPE_MISMATCH`, etc.) a un mensaje en español;
cualquier código no listado cae en un mensaje genérico -- **nunca se
re-lanza el error crudo**. Todas las Server Actions de
`reservaciones/actions.ts` ahora atrapan y redirigen con `?error=` (mismo
patrón que `submitCreateHold()` ya tenía para `NO_AVAILABILITY`, ahora
generalizado). Bug real encontrado corrigiendo esto: `error instanceof
Error` no siempre es `true` para un `PostgrestError` de supabase-js que
cruza la frontera de un Server Action -- `friendlyErrorMessage()` cayó al
mensaje genérico en la primera prueba en vivo en vez del mensaje
específico de `HOLD_EXPIRED`. Corregido buscando `.message` en cualquier
objeto con esa forma, no sólo en instancias reales de `Error`; validado de
nuevo en vivo con un Hold recién creado y vencido a mano (`expires_at` en
el pasado) -- esta vez sí mostró "Este Hold ya expiró. Vuelve a cotizar
para generar uno nuevo.", sin 500.

### P0-2/P0-4: causa compartida real -- `assignRoomFromRack()` nunca llamaba `revalidatePath("/rack")`

No se pudo reproducir "falla al confirmar" para un movimiento de MISMA
categoría contra Hotel Demo real: arrastrar y soltar, confirmar, y el
movimiento se aplicó y persistió correctamente (verificado releyendo el
Rack en una navegación nueva). Pero se encontró la causa raíz real de por
qué SÍ podía parecer que fallaba: `src/app/rack/actions.ts`
(`submitAssignUnassigned`, el flujo de formulario plano) ya llamaba
`revalidatePath("/rack")` después de mover -- pero
`assignRoomFromRack()` (`src/modules/rack/actions/assignments.ts`, el
código que **ambos** flujos comparten, incluido el drag & drop) sólo
llamaba `invalidateRackCache()`, el `Map` en memoria del proceso Node
documentado explícitamente como "no es un cache distribuido -- en un
despliegue multi-instancia cada instancia tiene el suyo". En cualquier
despliegue con más de un proceso sirviendo peticiones, un movimiento podía
escribirse correctamente en la base y el siguiente `router.refresh()`
aterrizar en OTRA instancia que nunca se enteró de la invalidación,
sirviendo su copia cacheada hasta que expirara el TTL de 45s -- exactamente
lo que un usuario percibiría como "confirmé el movimiento y no pasó nada".

Corregido agregando `revalidatePath("/rack")` dentro de
`assignRoomFromRack()` mismo (cubre drag & drop y el formulario plano por
igual, un solo punto) y quitando la llamada ahora redundante en
`rack/actions.ts`. `invalidateRackCache()` se conserva sin tocar -- sigue
sirviendo para el caso de una sola instancia (dev local, o cualquier
despliegue de un solo proceso), donde invalida de inmediato sin esperar el
TTL.

### P0-3: no era el mismo bug que P0-2 -- era una función que nunca se construyó

Confirmado explícitamente antes de diseñar nada: el "falla" de cambiar a
categoría DISTINTA es `assign_room()` (0026) rechazando con
`ROOM_TYPE_MISMATCH` -- comportamiento **intencional** desde el spec
original ("MVP solo permite asignación equivalente"), capturado limpio por
el `try/catch` que ya existía en `RackGrid.tsx`, sin crash. No comparte
causa con P0-2/P0-4: aquí no faltaba invalidar caché, faltaba la función
de autorización que el spec siempre dejó pendiente.

`change_room_with_authorization()` (`0051_authorized_room_change.sql`) es
la función nueva: a diferencia de `assign_room()` (Rack, sólo equivalente)
y `assign_room_for_checkin()` (0032, sólo al momento del check-in), ésta
permite upgrade/downgrade **después** del check-in. Determina
upgrade/downgrade comparando `room_types.base_rate` del tipo anterior
(de la asignación activa si existe, o si no, del tipo vendido en
`reservation_stays` -- mismo criterio que 0032) contra el tipo nuevo.
Motivo obligatorio salvo para un cambio equivalente. Autorización:
`has_permission(hotel_id, 'room.change')` simple -- mismo patrón temporal
ya usado para Caja (`cash.refund`/`cash.adjust`, 0046): cuando exista
`PermisoExcepcion` formal, se conecta ahí, no antes. El cobro de upgrade y
la compensación de downgrade reusan `register_stay_transaction()` (0026)
-- no dependen de que Caja (0046) esté desplegada, tal como se pidió. La
compensación de downgrade se registra como `type='payment'` con monto
negativo (no `'refund'`, que en este ledger es positivo -- ver comentario
completo en la migración); "quién autorizó" es
`room_assignments.created_by` (ya `auth.uid()` vía el trigger genérico),
sin columna nueva.

Server Action: `changeRoomWithAuthorization()`
(`src/modules/recepcion/actions/lifecycle.ts`) + `submitChangeRoom()`
(`src/app/recepcion/actions.ts`). Query nueva: `listRoomChangeOptions()`
(`src/modules/recepcion/queries/stays.ts`) -- a diferencia de
`listRoomAssignmentOptions()` (sólo para el check-in guiado, excluye
downgrades a propósito), ésta sí los incluye. UI: sección "Cambio de
habitación" en `/recepcion?stayId=X&roomChangeStep=1` (ver P0-5).

**Validado localmente** (Postgres 16, `has_permission` real): upgrade con
cobro ($300) sube el saldo exactamente ese monto; upgrade de cortesía no
mueve el saldo aunque se mande un `charge_amount` por error (se ignora);
downgrade con compensación ($200) baja el saldo exactamente ese monto,
registrado como `payment` negativo; upgrade/downgrade sin motivo rechaza
con `REASON_REQUIRED`; un rol sin `room.change` rechaza con
`PERMISSION_DENIED`. Pendiente de repetir contra Supabase real una vez
aplicada `0051` (ver reporte de esta ronda).

### P0-5: el menú de una estancia ya no ofrecía sólo lo válido para su estado

Encontrado real: el modal de detalle de celda del Rack
(`RackGrid.tsx`, `openCell`) tenía **tres enlaces idénticos** ("Expediente"
/ "Check-In" / "Cobrar"), los tres a la misma URL, sin condicionar en
absoluto por `cell.stayStatus` -- "Check-In" aparecía siempre, incluso
para una estancia ya `in_house`. La tarjeta principal de
`/recepcion?stayId=X` sí condicionaba bien sus botones (`Registrar
llegada`/`Marcar No-Show`/`Marcar Walked`/`Entregar habitación`/`Hacer
check-out`, cada uno sólo para su estado) -- el bug era específico del
modal del Rack.

Corregido: "Check-In" sólo para `expected`/`arrived`; "Cambio de
habitación" (nuevo, P0-3) sólo para `checked_in`/`in_house`, enlazando a
`?roomChangeStep=1`; "Cobrar" para cualquier estado con cuenta activa. Se
agregó también el mismo botón "Cambio de habitación" a la tarjeta
principal de acciones de Recepción, junto a los demás, condicionado igual.

### P0-6: el buscador ignoraba por completo ocupantes/mascotas

`searchAvailableOptions()` (`src/modules/reservaciones/queries/
availability.ts`) sólo filtraba por fechas -- `paxAdults`/`paxChildren`/
`hasPets` se leían del formulario pero nunca llegaban a la consulta.
Cambiar esos campos SÍ disparaba una navegación nueva (es un `<form
method="GET">`), pero el resultado no cambiaba: un tipo sin capacidad para
6 adultos, o que no acepta mascotas, seguía apareciendo igual que con los
filtros por defecto. Corregido agregando esos tres filtros a la función
(compara contra `room_types.capacity_adults`/`capacity_children`/
`accepts_pets`, ya leídos, nunca antes usados para filtrar) y pasándolos
desde `reservaciones/page.tsx`. Validado en vivo contra Hotel Demo: sin
filtro de mascotas, 4 tipos disponibles; con mascotas, sólo 2 (los que
`accepts_pets`); con 6 adultos, 0 (ningún tipo tiene esa capacidad) --
antes de este fix los tres casos habrían mostrado los mismos 4 tipos.

### P0-7: el precio deja de ser un campo libre

`create_quote_option()` (0048) aceptaba `p_nightly_rate_override` de
cualquier usuario con `reservations.create`, sin motivo ni permiso
adicional. `0052_quote_discount_authorization.sql` la recrea (mismo
patrón 0037/0047: se quita/agrega parámetro de la firma, nunca se ignora)
agregando `p_is_courtesy`/`p_discount_reason`: si el override difiere de
`base_rate`, o se pide cortesía, exige
`has_permission(hotel_id, 'reservations.discount')` (permiso nuevo,
sembrado sólo a `hotel_admin` -- mismo criterio que `cash.refund`/
`cash.adjust`, no a `front_desk`) + motivo no vacío, antes de calcular
nada. Cortesía dejó el precio en 0. "Quién autorizó" sigue siendo
`quote_options.created_by`; motivo/monto/cortesía se registran en el
payload del evento de timeline (`quote.discount_authorized` en vez de
`quote.issued`) -- regla 6, no una columna nueva.

UI (`reservaciones/page.tsx`): el campo "Tarifa/noche" ahora es de sólo
lectura (el precio de lista); un `<details>` colapsable "Descuento o
cortesía" con el override + cortesía + motivo sólo se muestra si
`hasPermission(hotelId, 'reservations.discount')` -- oculta el control a
quien igual sería rechazado por el servidor (sólo UX, la autorización real
sigue siendo el RPC).

**Validado localmente**: `hotel_admin` sin override cotiza a `base_rate`
sin pedir nada; con override y sin motivo, rechaza
`DISCOUNT_REASON_REQUIRED`; con override y motivo, cotiza al nuevo precio;
con cortesía, total `0.00`; `front_desk` con override y motivo rechaza
`PERMISSION_DENIED` (no tiene `reservations.discount`); `front_desk` sin
override sigue cotizando normal, sin regresión. Pendiente de repetir
contra Supabase real una vez aplicada `0052`.

### P0-8: era presentación, no cálculo -- confirmado explícitamente

Se verificó primero si el saldo mismo estaba mal calculado: no -- en cada
prueba de esta ronda (incluidas las de P0-3, cobro/compensación),
`stay_accounts.balance` reflejó exactamente el monto esperado tras cada
movimiento. El problema real era de presentación: la tarjeta "Cuenta de la
estancia" (`/recepcion`) mostraba `${balance}` crudo, con sólo el color
como pista -- un saldo a favor real se habría visto como `$-345`.

`formatBalanceLabel()` ya existía, pero sólo dentro de Caja
(`modules/caja/queries/payments.ts`) -- Recepción necesitaba la misma
traducción sin depender de que Caja esté desplegada (pedido explícito), y
regla 7 prohíbe importar entre módulos. Se movió a `src/lib/format.ts`
(ya comparte `formatDate*` entre módulos) y Caja ahora la reexporta desde
ahí -- una sola implementación, no dos (regla 6). Recepción la usa en las
tres vistas donde mostraba el saldo crudo (tarjeta de cuenta, paso 1 del
check-in guiado, resumen de la lista de estancias) y agrega "Total
cargos"/"Total abonos" en la tarjeta principal, derivados del signo real
de cada transacción (positivo/negativo), no de su `type` -- cubre
`charge`/`refund`/`payment`/`adjustment` por igual sin listar tipos a
mano.

### Bug real encontrado preparando las pruebas: `reset_demo_hotel()` no podía limpiar un hotel con uso real (0053)

Al intentar partir de un estado limpio para probar P0-3/P0-7 en vivo (tal
como esta ronda lo exigía), `reset_demo_hotel()` (0050) falló contra el
Hotel Demo real con `update or delete on table "reservations" violates
foreign key constraint "leads_reservation_id_fkey"`. Causa: el hotel demo
real ya tenía, por uso genuino de la app (no del seed -- 0050 nunca
inserta `leads`), algún `lead` con `status='converted'` y
`reservation_id` apuntando a una reserva de ese hotel; el orden de
limpieza de 0050 borra `reservations` (línea 103) antes que `leads`
(línea 107), y `leads.reservation_id` (0018) no tiene `on delete
cascade`/`set null` -- Postgres rechaza el `DELETE` de la reserva
mientras exista un lead convertido que la referencie. Nunca se detectó
antes porque las pruebas de 0050 se hicieron contra un hotel demo recién
creado, sin leads convertidos todavía; sólo se manifiesta después de que
el hotel demo real acumula uso genuino entre un reset y el siguiente --
exactamente el mismo tipo de hallazgo que la sección de Rack ya documentó
para la migración `0033` sin aplicar ("que este archivo documente que
algo ya se validó no es garantía de que el proyecto real esté en ese
estado").

Corregido en `0053_fix_reset_demo_hotel_leads_fk.sql`: antes de borrar
`reservations`, desvincula (`reservation_id = null`) cualquier lead del
hotel que apunte a una de sus reservas -- el lead en sí se sigue
borrando dos líneas después, sin cambio. Mismo `create or replace`, sin
tocar la firma ni el resto del cuerpo (recreación completa de la función
porque no hay forma de insertar una sola línea en medio de un `CREATE OR
REPLACE FUNCTION` ya aplicado sin repetir el cuerpo entero).

**Segundo hallazgo de la misma familia, en la misma ronda de pruebas
(reset inmediato después de aplicar 0053):** el reset volvió a fallar,
ahora con `inventory_holds_converted_reservation_id_fkey`.
`confirm_reservation_from_hold()` (0016) fija SIEMPRE
`inventory_holds.status = 'converted'` +
`converted_reservation_id = <la reserva recién creada>` en cada
confirmación real -- es decir, TODO Hold confirmado por el flujo normal
deja esta referencia, no sólo un caso raro como el lead convertido. Mismo
patrón, mismo tipo de FK sin `on delete` (0018). Se descartó reordenar el
bloque completo de `DELETE`s (`inventory_holds` también depende de
`quote_options` sin cascada -- reordenar a ciegas podía introducir un
problema distinto) a favor de la misma corrección quirúrgica: desvincular
antes de borrar. Corregido en `0054_fix_reset_demo_hotel_holds_fk.sql`.
Se verificó además, revisando todas las FK sin `on delete` que apuntan a
`hotels`/`reservations`/`leads`/`inventory_holds`/`quote_options`/`quotes`/
`reservation_stays` en el esquema completo, que no queda un tercer caso de
este tipo: las únicas dos referencias "hacia atrás" contra `reservations`
son exactamente `leads.reservation_id` (0053) e
`inventory_holds.converted_reservation_id` (0054) -- el resto de FKs sin
cascada encontradas (`reservations.lead_id`/`.quote_id`/`.hold_id`) son en
sentido contrario (reservations es la fila hija ahí, ya se borra primero
en el wipe), así que no bloquean nada.

## Resolución del hotel actual: por qué no era cosmético

Encontrado probando la ronda P0 en vivo, con una cuenta con dos
membresías activas (`demo@hotelos.test`, dueño de dos hoteles demo):
`getCurrentUserHotel()` (`src/lib/auth/session.ts`) resolvía "el hotel
actual" con `.from("user_hotel_roles")...limit(1).maybeSingle()` **sin
`order by`** -- sin garantía de orden, la misma sesión podía resolver a
un hotel distinto entre requests. Se manifestó como `PGRST116` (0 filas)
al pedir una estancia real bajo el `hotel_id` equivocado. El mismo patrón
existía en `homeForCurrentUser()` (`src/app/login/actions.ts`), decidiendo
a qué módulo aterriza un usuario justo después de iniciar sesión.

No se trató como un caso raro a ignorar: HotelOS es multi-hotel por
diseño (un dueño puede administrar más de un hotel, ver Plataforma/`/admin`
más arriba) -- resolver "el primero" en silencio, sin forma de elegir,
era un hueco de producto real, no sólo un bug técnico. Se corrigió en dos
capas:

1. **Orden determinista (mínimo viable).** `listActiveHotelMemberships()`
   (nueva, `session.ts`) ordena `user_hotel_roles` por `created_at asc` --
   la membresía más antigua es el hotel "de siempre" para quien nunca ha
   elegido. `homeForCurrentUser()` gana el mismo `order by` sobre su
   propia consulta (no se unificó con la función anterior: su proyección y
   necesidad -- sólo el primer hotel y su `status` -- son distintas, y
   duplicar un `order by` de una línea no es la duplicación que la regla 6
   busca evitar).
2. **Selector explícito de hotel**, porque un mínimo viable silencioso
   seguía sin resolver el caso real (elegir CUÁL hotel operar, no sólo que
   la elección por defecto sea estable). Cookie `selected_hotel_id`
   (httpOnly, 1 año), fijada únicamente por `selectHotel()`
   (`src/lib/auth/actions.ts`, Server Action nueva) -- que **siempre**
   revalida contra `user_hotel_roles` que ese `hotel_id` es una membresía
   activa real de ese usuario antes de fijar la cookie (regla 2: nunca
   confiar en un hotel_id que venga del cliente sin validar en servidor;
   un valor ajeno o inactivo se ignora en silencio, la sesión se queda en
   el hotel que ya tenía). `getCurrentUserHotel()` usa la cookie si sigue
   siendo válida; si no hay cookie o ya no aplica, cae al orden
   determinista de (1). `AppShell` (`src/components/ui/AppShell.tsx`) sólo
   muestra el selector (un `<select>` + botón "Ir", sin JS de cliente,
   mismo patrón de formulario plano del resto del proyecto) cuando
   `otherHotels` trae algo -- un usuario de un solo hotel no ve nada nuevo.

`getCurrentUserHotel()` devuelve ahora también `otherHotels` (las demás
membresías activas, para pintar el selector) -- las 5 páginas de módulo
(`reservaciones`/`recepcion`/`rack`/`configuracion`/`caja`) pasan
`hotelId`/`otherHotels` nuevos a `AppShell` en sus 10 usos (2 por página:
la variante "módulo no incluido en el plan" y la principal).

**Bug real encontrado validando el selector en vivo:** el primer cambio de
hotel fijaba la cookie correctamente (confirmado leyendo la cookie real
del navegador) pero el render inmediatamente después seguía mostrando el
hotel anterior -- sólo una recarga dura o una navegación fresca mostraban
el valor correcto. `revalidatePath("/", "layout")` en `selectHotel()` no
bastaba por sí solo: invalida el lado del servidor, pero el Client Router
Cache del navegador podía reusar el RSC ya prefetcheado con la cookie
vieja cuando el destino (`returnTo`) era la URL EXACTA de la que se
partió -- mismo síntoma, causa distinta, que el bug ya documentado en
Configuración ("ningún `redirect()` de vuelta a la URL de origen es
seguro sin invalidar la entrada de caché de esa URL exacta"). Corregido
agregando un parámetro que cambia en cada cambio de hotel
(`?hotelSwitchedAt=<timestamp>`) al `returnTo` antes de redirigir -- fuerza
al navegador a tratarlo como una URL distinta y pedir el render fresco,
mismo principio que `?reservationId=`/`?checkinStep=` ya usan en otros
flujos para lo mismo. Validado en vivo con una cuenta real de dos
membresías: resolución sin cookie estable en 3 llamadas repetidas (siempre
la membresía más antigua); cambiar de hotel y volver a cargar la misma
página 3 veces seguidas siempre refleja el hotel elegido; cambiar de
regreso al otro hotel también refleja de inmediato, sin flash del valor
anterior.

## Handoff de demo P1, Tanda 1 (UI/UX de bajo riesgo)

Nueve hallazgos (P1-1, P1-2, P1-3, P1-5, P1-6, P1-9, P1-10, P1-11, P1-13)
de una lista de P1 más larga -- P1-4/P1-7/P1-8/P1-12/P1-14 quedan
explícitamente para una tanda futura por tocar lógica de negocio real, y
P2 no se tocó en absoluto. Validado en vivo contra Hotel Demo real
(`reset_demo_hotel()` antes de probar).

### P1-2: nombre de usuario, logo, shell bilingüe

`getCurrentUserHotel()` (`src/lib/auth/session.ts`) ahora también resuelve
`profiles.full_name` (o el correo si no lo ha llenado) en el mismo viaje ya
abierto para el hotel actual -- se muestra en el sidebar junto al rol, que
ahora es una etiqueta con más contraste en vez de texto plano.

Logo del hotel: mismo patrón exacto que `brand_color` -- una URL en
`hotel_policies.extra_settings.logo_url`, no una columna/tabla nueva ni
subida de archivo (Supabase Storage no está en uso en el proyecto todavía;
construir esa integración sólo para un logo sería infraestructura nueva,
fuera del alcance "bajo riesgo" de esta ronda). `updateBrandLogo()` exige
que la URL empiece con `http(s)://`; `AppShell` la muestra junto al nombre
del hotel si existe, sin lugar para un ícono roto si no hay logo.

Selector de idioma ES/EN: **shell-only**, decisión explícita del dueño del
producto tras evaluar el esfuerzo real -- el proyecto no tenía ninguna
infraestructura de i18n (cero librerías, cero strings extraídos);
traducir el contenido de las ~15 pantallas de cada módulo es un esfuerzo
grande, aparte, para una ronda futura. `src/lib/i18n.ts` tiene el
diccionario mínimo de `AppShell` (nombres de módulo, "Rol", "Cerrar
sesión", "Reiniciar", "Cambiar de hotel", "Idioma", "Ir") y `getLocale()`
lee la cookie `locale`; `selectLocale()` (`src/lib/auth/actions.ts`) la
fija con el mismo patrón que `selectHotel()`: `revalidatePath("/",
"layout")` + un parámetro que cambia en el redirect
(`?localeChangedAt=<timestamp>`) para que el Client Router Cache no sirva
el idioma anterior (misma lección ya documentada arriba para el selector
de hotel). `AppShell` pasó a ser un Server Component `async` para leer la
cookie directamente, en vez de que cada una de las 5 páginas de módulo
tuviera que resolverla y pasarla como prop.

### P1-1: KPIs accionables y sticky (Recepción y Reservaciones)

La barra de KPIs queda `sticky top-0` (con su propio fondo, para que la
lista no se transparente al pasar por debajo) en ambas pantallas. En
Recepción, cada KPI navega a la lista de Estancias filtrada por lo mismo
que cuenta (`?filter=expected|in_house|pending`) -- `KpiCard` ganó un
`href` opcional (se vuelve `<Link>` en vez de `<div>`, mismo componente
para ambos casos). En Reservaciones, los 3 KPIs (Reservas/Leads/Holds
activos) ya son cada uno una sección propia de la página con un solo tipo
de contenido -- "su lista filtrada" es directamente esa sección, así que
navegan por ancla (`#reservas`/`#leads`/`#holds-activos`; `Card` ganó un
`id` opcional) en vez de inventar un filtro que no aportaría nada nuevo.

No se movió la barra al lado derecho -- pedido explícito de no decidir
eso por cuenta propia, es una decisión de diseño pendiente del dueño del
producto. Sugerencia para cuando se revise: mover los KPIs a una columna
lateral dejaría más ancho para la lista/tabla principal en pantallas
anchas, pero cambia el layout de las 5 páginas de módulo, no sólo estas
dos -- vale la pena decidirlo una sola vez para todo `AppShell`, no
página por página.

### P1-3: prioridad y check-out oculto por defecto (Recepción)

Dentro de la lista de Estancias, las que tienen una acción pendiente
(`next_action !== 'ninguna'` y no `checked_out`/`no_show`/`walked`) van
primero -- un `sort()` de JavaScript, estable desde ES2019, así que dentro
de cada grupo (pendiente / no pendiente) se conserva el orden anterior
(`created_at desc`) sin necesitar un criterio de desempate adicional. Las
que ya hicieron check-out se ocultan por defecto -- nunca para siempre:
un link "Mostrar N con check-out ya hecho" las revela
(`?showCheckedOut=1`), con su contraparte para volver a ocultarlas.

### P1-5: "Sin acción pendiente" ya no es ambiguo

`next_action = 'ninguna'` (`recompute_stay_next_action()`, 0026) cubre dos
situaciones reales y muy distintas: un huésped `in_house` con la cuenta al
corriente (no hay nada que hacer hasta su check-out) y una estancia ya
**cerrada** (`checked_out`/`no_show`/`walked`, el ciclo completo terminó).
No se renombró el estado -- el badge de arriba de la estancia ya distingue
el status real -- se agregó una línea de ayuda en el detalle que aclara
cuál de las dos situaciones aplica según `detail.stay.status`.

### P1-6: sección de activos ausente, no vacía con un aviso

Si `hotel_policies.checkin_assets` está vacío, la tarjeta "Activos
entregados" completa desaparece de la vista de una estancia -- nunca el
mensaje "Este hotel no tiene activos configurados en su política de
check-in" que mostraba antes. Confirmado contra Hotel Demo real:
`checkin_assets = []`, la sección no aparece en absoluto.

### P1-9: el buscador de huésped ignoraba a quien nunca tuvo un lead

`GuestSearchField` (Reservaciones) sugería sólo contra `leads` -- un
huésped cuya única fila en el sistema es una `reservations` directa (una
cancelada, por ejemplo, como el caso real "Perla Treviño" que el dueño
encontró en la demo) nunca tuvo un `lead` propio y por eso nunca aparecía
en las sugerencias, sin importar cuántas veces se buscara su nombre. El
directorio de sugerencias ahora combina `leads` con `reservations` (ya
cargada en la misma página para el listado de abajo -- sólo se le agregó
`primary_guest_email`/`primary_guest_phone` al `select()` que ya existía,
sin consulta nueva), incluyendo a propósito `cancelled`/`no_show`/
`completed`, deduplicado por correo (o teléfono, o nombre si no hay
ninguno de los dos) para no repetir a la misma persona si ya tiene lead Y
reserva. Validado en vivo: buscar "Trevi" contra Hotel Demo recién
reiniciado sugiere "Nadia Treviño" -- la reserva cancelada del seed
(`0050`, nunca inserta `leads`) que antes de este fix era invisible para
el buscador.

### P1-10: historial de reservas colapsado

De entrada sólo se ve "Reservas próximas" (`status = 'confirmed'`, lo que
importa día a día); el historial completo (pasadas/canceladas/no-show)
queda en un `<details>` al pie con totales por categoría en el `<summary>`
-- mismo patrón `<details>` que esta página ya usa para "Descuento o
cortesía" (P0-7), sin JS de cliente. Validado en vivo: "Reservas próximas
(8)" visible de entrada contra 46 reservas totales; el resumen colapsado
muestra "(46) — Pasadas: 35 · Canceladas: 2 · No-show: 1", números reales
del seed.

### P1-11: editar ya no salta al final de la lista

Editar un tipo de habitación o una habitación física (Configuración)
navegaba a `?editRoomTypeId=`/`?editRoomId=` y el formulario de edición
aparecía reutilizando la posición del formulario "crear nuevo", siempre al
final de cada columna -- el usuario perdía el scroll de donde estaba en
una lista larga. `src/components/ui/Modal.tsx` (`<dialog>` nativo, nuevo)
resuelve esto: el estado real sigue viviendo en la URL (mismo patrón ya
establecido, sin reinventar nada), el componente sólo sincroniza
open/close de un `<dialog>` con esa prop vía `showModal()`/`close()`.
Cerrar (Escape, click en el fondo, botón ✕) navega de vuelta a la URL sin
el parámetro de edición.

Dos bugs reales encontrados probando esto en vivo:
- El `<Link>` de "Editar" seguía subiendo el scroll a la parte superior al
  cambiar el query param -- comportamiento default de `next/link`, y
  justo lo que este punto pidió evitar. Corregido con `scroll={false}` en
  esos `Link` (y los de "Cancelar" dentro del popup) y en el
  `router.push()` que dispara el cierre del `<dialog>`.
- El `<dialog>` aparecía pegado a la esquina superior izquierda en vez de
  centrado: el reset de Tailwind (`preflight`) pone `margin: 0` en todos
  los elementos, incluido `<dialog>`, eliminando el `margin: auto` que el
  navegador usa por default para auto-centrarlo. Corregido con centrado
  explícito (`fixed` + `top-1/2 left-1/2` + `-translate-x-1/2
  -translate-y-1/2`) en vez de depender del comportamiento nativo.

Validado en vivo con Playwright: el popup abre con los datos correctos
precargados; guardar refleja el cambio de inmediato en la lista de atrás;
la posición de scroll (probado en 300px) se mantiene idéntica antes,
durante y después de cerrar el popup, en las tres formas de cerrarlo.

### P1-13: "Marcar sucia" sí tiene un flujo real -- confirmado, no removido

Se pidió confirmar en el código (no asumir) qué hace este botón antes de
decidir su destino. Confirmado: `setRoomClean()`
(`src/modules/configuracion/actions/rooms.ts`) actualiza `rooms.is_clean`
de verdad, registra `room.marked_clean`/`room.marked_dirty` en el
timeline, y ese valor alimenta dos consumidores reales -- el gate de
`reception_settings.checkin_permite_sucia` dentro de `check_in()` (0026) y
el aviso "(sucia)" que ya muestran `listRoomAssignmentOptions()`/
`listRoomChangeOptions()` al asignar o cambiar de habitación en Recepción.
No es un botón sin función: se conservó.

Hallazgo real, no corregido a propósito (fuera de alcance -- tocaría la
función SQL de checkout, lógica de negocio explícitamente vetada en esta
ronda): **ninguna función del flujo de check-out marca sucia una
habitación automáticamente** -- `attempt_check_out()` nunca toca
`is_clean`. Como Housekeeping no existe todavía, este botón es hoy la
**única** forma de que `is_clean` pase a `false` en la operación real (el
demo la usa vía `reset_demo_hotel()`, pero eso es sólo el seed). Se
documentó esto con una línea de ayuda junto al badge Limpia/Sucia en vez
de dejar el botón sin contexto -- decidir si el check-out debería marcar
sucia automáticamente queda para cuando se revise el flujo de checkout a
propósito (P1/P2 futuro con lógica de negocio, no esta ronda).

## Bug real: cotizar podía duplicar el Lead de un huésped en cada reintento

Reporte real contra Hotel Demo: buscar Sencilla para "Luciana Torres" (23-27
sep 2026, 1 adulto, tarifa de lista) y pulsar "Reservar" mostró "A server
error occurred" -- el Lead quedó creado como "Cotizado" pero sin
`quote_options` ni Hold ni Reserva (46 reservas sin cambio, 0 Holds
activos).

**Diagnóstico:** se reprodujeron los mismos parámetros exactos (mismo tipo,
mismas fechas, mismo adulto, misma tarifa) tanto llamando `create_quote_option()`
directo por REST como recorriendo el flujo completo en vivo contra Hotel
Demo -- en ambos casos, sin error. La causa exacta del 500 original no se
pudo reproducir de forma determinista (probable condición transitoria de
red/conexión en el momento de esa llamada específica, no un defecto de
lógica reproducible). Pero investigar el código de `createQuote()`
(`src/modules/reservaciones/actions/quote.ts`) para descartar esa causa
expuso un bug real, independiente y siempre reproducible: la función hace
un `insert` incondicional en `leads` **en cada llamada**, sin buscar si el
mismo huésped ya tiene un Lead abierto. Esto significa que **cualquier
reintento después de cualquier error a mitad de camino** (el 500 original,
o cualquier otro) duplica el Lead del mismo huésped -- exactamente el
riesgo que el reporte pedía evitar explícitamente ("completar el flujo sin
duplicar el lead existente").

**Corrección:** `createQuote()` ahora busca, antes de insertar, un Lead
existente del mismo hotel cuyo huésped coincida (mismo criterio de dedupe
que el directorio de sugerencias de la UI, P1-9: correo si hay, si no
teléfono, si no nombre, comparación case-insensitive) y cuyo `status` siga
abierto (`new`/`contacted`/`quoted`/`negotiating`/`waitlisted`). Si existe,
se actualiza ese mismo Lead (fechas/tipo/pax/status más recientes) en vez
de insertar uno nuevo -- mismo `id`, se conserva su historial. Un Lead ya
`converted`/`lost` es una intención de compra cerrada y **no** se reutiliza
en silencio: una cotización nueva para ese huésped crea un Lead nuevo,
igual que antes. No hizo falta migración: `leads` ya no tenía política de
`UPDATE` distinta de `INSERT` (misma policy `for all` desde 0011), así que
el `has_permission()` que ya se exigía cubre ambos caminos por igual.

Efecto colateral encontrado al escribir el fix: `leads.Update` (tipo
generado, `src/types/database.types.ts`) es `Partial<Insert>`, y el
`Insert` generado para esta tabla nunca incluyó `last_interaction_at` (una
columna con default `now()` pensada sólo para lecturas de CRM) -- intentar
fijarla a mano en el `.update()` rompía el build (`Type 'string' is not
assignable to type 'never'`, el error típico de TypeScript para una
propiedad fuera del tipo objetivo). No se regeneraron los tipos sólo por
esto (no hubo cambio de esquema): se quitó ese campo del `.update()`, ya
que no era necesario para la corrección real (el Lead reusado ya refleja
la fecha del intento más reciente en `updated_at`, que sí llena el trigger
genérico).

**Validado en vivo contra Hotel Demo real** (no sólo local): se reprodujo
el flujo completo (Sencilla, 23-27 sep 2026, 1 adulto, tarifa de lista,
huésped "Luciana Torres") de punta a punta con el fix aplicado --
Cotización → Hold → Reserva confirmada (folio `260924-401CB`), sin ningún
error 500 en el camino. Se confirmó contra la base real, antes y después,
que el Lead de Luciana Torres (`c682c425-...`) es el **mismo** antes y
después -- nunca se creó un segundo Lead -- y que terminó con
`status = 'converted'` y `reservation_id` apuntando a la reserva nueva,
exactamente el ciclo de vida esperado de un Lead que se convierte.

## Handoff de demo P1, Tanda 2 (lógica de negocio)

Cinco hallazgos (P1-4, P1-7, P1-8, P1-12, P1-14) de la misma lista P1 que la
Tanda 1 (UI/UX de bajo riesgo) dejó fuera a propósito por tocar lógica de
negocio real. P2 no se tocó. Validado en vivo contra Hotel Demo real
(`reset_demo_hotel()` antes de probar) para todo lo que no depende de una
migración nueva -- ver la nota de migraciones pendientes al final de esta
sección, es importante leerla antes de dar esta ronda por cerrada.

### P1-4: "Marcar Walked" reversible y menos prominente

**"Error desconocido" no se pudo reproducir de forma determinista.**
`mark_walked()` (0026) se probó directo por RPC y a través del flujo
completo de la UI, con y sin motivo, contra Hotel Demo real -- en todos los
casos, 200 y la estancia queda en `status = 'walked'`, sin error. Lo que sí
se confirmó real, leyendo `src/lib/friendlyError.ts`: varios códigos que
Recepción/Habitaciones ya lanzan (`INVALID_TRANSITION` el más relevante
aquí) no estaban en el mapa de mensajes conocidos -- caían al mensaje
genérico, la clase de experiencia "no dice qué pasó" que el reporte
describe. Se agregaron (ver más abajo) y se validó en vivo el caso real que
sí los dispara: una estancia cuyo estado cambia (por otra pestaña/usuario)
entre que se carga la página y se envía el formulario -- antes caía al
genérico, ahora muestra "Esta acción ya no aplica al estado actual de la
estancia. Actualiza la página e inténtalo de nuevo." (probado forzando el
cambio de estado por REST mientras la página ya estaba cargada, simulando
la carrera real).

**Reordenado y des-enfatizado.** Antes, "Marcar Walked" era el ÚNICO botón
visible (rojo, `variant="danger"`) para una estancia `arrived` -- aparecía
ANTES del flujo guiado de check-in normal (Cuenta → Habitación), no
después. Se movió al final de ese mismo Card (después de ambos pasos,
visible en los dos), como link `variant="ghost"` con el texto "No se puede
alojar — Marcar Walked" -- último recurso, no el primero.

**Reversible.** `undo_walked()` (0056, nueva) regresa la estancia a
`arrived` (nunca a `expected` -- el huésped sí llegó) y limpia
`walked_at`/`walked_reason`, mismo patrón que `reactivate_room()` (0041).
Un botón "Deshacer Walked" (`variant="secondary"`, no danger -- corregir un
error no es una acción destructiva) aparece sólo para `status = 'walked'`.
El evento original (`stay.walked`) y el de deshacer (`stay.walked_undone`)
quedan ambos en `timeline_events` -- el historial de que ocurrió y se
corrigió no se borra, sólo el estado operativo actual.

### P1-7 + hallazgo de P1-13: disponibilidad real de housekeeping

**En la lista de Estancias, una llegada sin habitación (`expected`/
`arrived`) ya no dice sólo "libre".** `getRoomTypeHousekeepingSummary()`
(nueva, `modules/recepcion/queries/stays.ts`) cuenta, para cada tipo de
habitación, cuántas unidades activas y sin asignación activa hay --
separadas por `is_clean` -- en una sola pasada para todo el hotel (no una
consulta por llegada). Cada fila de la lista muestra "N limpia(s)
lista(s)" / "Sólo sucia(s) disponible(s) (N)" / "Sin habitación libre de
este tipo" según corresponda. Validado en vivo: con las 4 Sencillas
limpias salvo una, mostró "3 limpia(s) lista(s)"; forzando las 4 a sucias
por REST, cambió a "Sólo sucia(s) disponible(s) (3)" (una ya estaba
ocupada) sin recargar nada más que la página.

**El check-out ya marca sucia la habitación.** P1-13 (Tanda 1) ya había
documentado el hallazgo: ninguna función del flujo marcaba
`rooms.is_clean = false`, así que "Marcar sucia" en Configuración era la
ÚNICA forma real de que pasara -- sin relación con que el huésped
realmente se hubiera ido. `attempt_check_out()` (0057, recreada sobre
0026) ahora marca `is_clean = false` en la(s) habitación(es) que libera,
en el mismo `UPDATE` que ya hacía sobre `room_assignments` -- puente
temporal mínimo hasta que exista Housekeeping real, tal como se pidió
explícitamente (no se construyó Housekeeping completo). No se tocó
ninguna otra función de la máquina de estados.

### P1-8: cotización completa

**`src/lib/pricing.ts` (`calculateStayPrice()`) ya no existe** -- se borró
en el Tier 2 de la auditoría de fuente única de precio (0048, ver esa
sección arriba): el cálculo se movió por completo a `create_quote_option()`
(SQL). El pedido asumía que seguía ahí; verificado antes de escribir
código, no asumido. La fuente correcta hoy es el resultado YA calculado
por el RPC (`quote_options.subtotal/taxes/total`, que la página ya carga)
-- ningún recálculo nuevo en TypeScript, más alineado con el principio de
fuente única que si se hubiera revivido el archivo borrado.

**"2. Cotización emitida" ahora muestra tarifa por noche** (derivada de
`total / noches`, no un cálculo aparte) además del desglose que ya tenía
(subtotal + impuestos = total), y gana su propio "Copiar cotización" --
antes ese botón sólo existía en el Paso 1 (una ESTIMACIÓN antes de cotizar
de verdad, sin subtotal/impuestos reales); el Paso 2 (después de
`create_quote_option()`, con los montos reales) no tenía ninguno.

**Contenido nuevo del texto completo** (`getQuoteCopyContext()`,
`modules/reservaciones/queries/details.ts`): descripción del tipo
(`room_types.description`, ya existía desde 0041, sin usar en Reservaciones
hasta ahora) + amenidades base del tipo (`tipo_habitacion_amenidad` +
`catalogo_amenidades`, mismo nivel al que Reservaciones ya cotiza -- sin
resolver excepciones por habitación física, todavía no hay una habitación
elegida en este punto del flujo) + política de cancelación + cómo pagar.

**Política de cancelación y cómo pagar son texto libre nuevo**, mismo
patrón que `brand_color`/`logo_url` (P1-2): no existía ningún campo real
para esto (verificado contra el esquema antes de escribir nada) --
`hotel_policies.extra_settings.cancellation_policy_text` /
`.payment_instructions_text`, editables en Configuración → Políticas →
Cotización (`updateQuotingContent()`, una sola función para las dos, no
dos casi-idénticas más). Se agregó `TextArea` a `components/ui/Field.tsx`
(no existía ningún campo de texto largo en el proyecto hasta ahora).

**Validado en vivo contra Hotel Demo real, end-to-end con lectura real del
portapapeles** (Playwright con permisos de clipboard, no sólo que el botón
exista): se guardaron política de cancelación + cómo pagar reales desde
Configuración, se agregaron 2 amenidades de prueba a Sencilla, se cotizó
(1 adulto, 3 noches, tarifa de lista) y el texto copiado fue exactamente
el esperado -- nombre + fechas, descripción, "Incluye: ...", pax, "$1150/
noche x 3 noche(s) = Subtotal $2974.14 + impuestos $475.86 = Total $3450
MXN", huésped, política de cancelación, cómo pagar -- cada línea presente
sólo cuando hay contenido real (sin amenidades no se agrega esa línea, sin
política de cancelación tampoco esa).

### P1-12: fuera de servicio con fecha estimada de entrega

**Motivo/inactive_at/inactive_by NO se duplican** -- pedido explícito, ya
obligatorios desde 0041 y ya fijados sólo por `deactivate_room()`. Lo
único genuinamente nuevo, verificado contra el esquema real antes de
escribir la migración: ningún campo equivalente a "fecha estimada de
entrega" existía. Se agregó `rooms.estimated_available_at` (date,
nullable) -- 0058.

`deactivate_room()` gana `p_estimated_available_at` (opcional) -- mismo
criterio que 0037/0047/0052: agregar un parámetro cambia la firma
(`(uuid,text)` -> `(uuid,text,date)`), así que `create or replace` sólo
habría creado un OVERLOAD nuevo dejando las dos versiones vivas; se
eliminó explícitamente la firma vieja antes de recrear.
`reactivate_room()` la limpia junto con los demás campos de desactivación
(misma firma, sin cambio de parámetros). En Configuración, el formulario
de "Desactivar" gana un campo de fecha opcional junto al motivo
(obligatorio, sin cambio); la habitación inactiva muestra motivo + "Regresa
el {fecha}" cuando hay una estimación. No se construyó el módulo de
Mantenimiento completo (pedido explícito) -- sólo el campo de captura y que
quede visible.

### P1-14: crecimiento de inventario -- no había nada bloqueando

Se verificó, no se asumió: Hotel Demo tiene `hotel_licenses.rooms_max =
NULL` (sin límite, plan `pro`) -- ninguna de las suspechas del pedido
("límite mal calculado", "contador que no se actualiza") aplicaba ahí. Se
insertó una habitación de prueba directo por REST (simulando exactamente
lo que hace `createRoom()`) y se confirmó contra `hotel_limit_usage()`
real: `rooms_active` pasó de 9 a 10 de inmediato, sin caché ni paso manual
-- la función es `stable` porque es una consulta pura, sin limpieza
perezosa de por medio (no aplica la lección de la regla 9 aquí). Habitación de prueba
borrada después de confirmar. El límite en sí sólo se aplica en la capa de
Server Action (`assertRoomLimit()`, `src/lib/auth/platform.ts`) contra
`hotel_licenses.rooms_max` -- eso ya estaba documentado como decisión de
diseño (no es RLS, es un gate de negocio) desde la sección de Plataforma;
P1-14 no pidió cambiar eso, sólo confirmar que no había un bug ahí, y no
lo hay.

El Rack sí puede tardar hasta 45s en reflejar una habitación recién
creada -- su cache en memoria (`getRackGrid()`, ver sección Rack) expira
solo, sin paso manual; no se tocó, es el comportamiento ya documentado y
aceptado para ese cache, no un bug de este punto.

### Migraciones de esta ronda -- aplicadas y validadas

`0056_undo_walked.sql`, `0057_checkout_marks_room_dirty.sql` y
`0058_room_deactivation_estimated_date.sql` no se pudieron aplicar desde
esta sesión (sin credencial de conexión directa a Postgres en el entorno,
sólo API keys de REST) -- se le pasó el contenido literal de los tres
archivos al dueño del producto para correrlos por el SQL Editor de
Supabase, y confirmó éxito en los tres. Validado en vivo después, contra
Hotel Demo real, cada punto que había quedado bloqueado:

- **`undo_walked()`**: ciclo completo `arrived -> walked -> arrived` vía
  la UI real (Marcar Walked, luego Deshacer Walked) -- confirmado también
  contra la base (`status`, `walked_at`, `walked_reason` correctos en cada
  paso).
- **`attempt_check_out()` marca sucia**: una habitación marcada limpia a
  propósito antes de la prueba quedó `is_clean = false` automáticamente
  justo después de un check-out real vía la UI (cuenta liquidada +
  activos devueltos primero, para que `check_out_readiness()` no
  bloqueara) -- sin ningún clic manual de "Marcar sucia".
- **`deactivate_room()` con fecha estimada**: se desactivó una habitación
  real con motivo + fecha desde `/configuracion?tab=habitaciones`, y la
  fila mostró "Fuera de servicio" + motivo + "Regresa el 15 dic 2026" de
  inmediato; reactivada después para dejar el demo limpio.

**Bug real encontrado validando el primer punto** (no relacionado con las
migraciones en sí): `/configuracion?tab=habitaciones` sí cargaba bien tras
aplicar `0058`, pero desactivar una habitación mostraba "Error
desconocido" en vez del motivo real (`IMPACT_BLOCKING` en ese primer
intento, contra una habitación con una asignación activa -- rechazo
correcto, sólo el mensaje era inútil). Causa: `runOrError()`
(`src/app/configuracion/actions.ts`) todavía usaba
`error instanceof Error ? error.message : "Error desconocido"` -- el mismo
hallazgo ya corregido en Recepción/Reservaciones (P0-1): un
`PostgrestError` de supabase-js no siempre pasa `instanceof Error` al
cruzar la frontera de un Server Action. Corregido reusando
`friendlyErrorMessage()` (`src/lib/friendlyError.ts`, que ya traduce
`IMPACT_BLOCKING` desde P1-4) -- con una diferencia respecto a como se usa
en Recepción/Reservaciones: aquí el *fallback* es el mensaje ya extraído
(`extractMessage()`, exportada para esto), no el genérico. Configuración
también lanza mensajes en español ya legibles a mano en TypeScript (ej.
"El IVA debe estar entre 0 y 100.", "Desactivar una habitación requiere un
motivo.") que no son códigos de Postgres -- enrutarlos por el mismo
fallback genérico que usa Recepción los habría reemplazado por un mensaje
menos útil en vez de dejarlos pasar tal cual. Validado con la misma
habitación reintentando sin conflicto: mensaje de éxito, sin error.

## Convenciones de nombres

- **Tablas y columnas de Postgres**: `snake_case`, tablas en plural
  (`hotels`, `timeline_events`).
- **Códigos de permiso**: `modulo.accion` en `snake_case`, ej.
  `reservations.create`, `checkin.perform`, `hotel.settings.manage`.
- **Tipos de evento de timeline**: `entidad.accion` en `snake_case`, ej.
  `reservation.created`, `payment.registered`.
- **Carpetas de módulos de negocio** (`src/modules/*`): en español, porque
  reflejan vocabulario del hotel (`reservaciones`, `rack`, `recepcion`,
  `habitaciones`, `caja`).
- **Identificadores de código** (variables, funciones, tipos TS): en inglés,
  siguiendo la convención del ecosistema Next.js/Supabase/TypeScript. No
  mezclar idiomas dentro de un mismo identificador.
- **Migraciones SQL**: `NNNN_descripcion_corta.sql`, numeración secuencial.
  Una migración ya aplicada/commiteada **no se edita**: los cambios van en
  una migración nueva.

## Estructura de carpetas

```
src/
  app/                    Rutas (App Router). Páginas y layouts.
    login/                Login/signup mínimo con Supabase Auth (email+password).
    reservaciones/        Página de prueba del módulo: buscar → cotizar → Hold → confirmar → listado.
    recepcion/            Página de prueba del módulo: llegada → check-in → asignar → entregar → cobrar → check-out.
    rack/                 Cuadrícula habitación×fecha (capa de vista, ver sección Rack).
    configuracion/        Página de prueba del módulo: catálogo de habitaciones, políticas del hotel, métodos de pago/Caja, usuarios y roles (tabs).
    caja/                 Página de prueba del módulo: turno de caja, cobrar/reembolsar por reserva, pendientes de validar, ajuste manual de estancia.
  proxy.ts                Refresca la sesión de Supabase en cada request (convención Next.js 16; reemplaza a middleware.ts).
  lib/
    supabase/
      client.ts           Cliente para Client Components (anon key).
      server.ts           Cliente para Server Components/Actions (anon key + cookies de sesión). Éste es el que usan los módulos.
      admin.ts             Cliente con service role (ignora RLS). Sólo para jobs de sistema, nunca para peticiones de usuario.
      middleware.ts        Lógica de refresco de sesión usada por proxy.ts.
    auth/
      permissions.ts        requirePermission()/hasPermission(): capa de UX sobre has_permission() de Postgres.
      session.ts             getCurrentUser()/getCurrentUserHotel(): usuario y hotel "actual" (primera fila activa en user_hotel_roles).
    events/
      timeline.ts           logTimelineEvent(): único punto de escritura a timeline_events.
  modules/
    reservaciones/
      actions/             quote.ts, hold.ts, confirm.ts, payment.ts — requirePermission() -> RPC atómica o mutación -> logTimelineEvent().
      queries/             availability.ts, reservations.ts, leads.ts, details.ts — lecturas server-side.
    recepcion/
      actions/             lifecycle.ts (transiciones de Estancia), account.ts (cuenta/transacciones), service.ts (solicitudes/incidencias/activos).
      queries/             stays.ts — listado, detalle, habitaciones asignables, config y catálogo de activos.
    configuracion/
      actions/             rooms.ts (tipos/habitaciones), policies.ts (hotel_policies/reception_settings), staff.ts (alta/rol/activación), payments.ts (payment_methods/cash_settings -- lectura/escritura propia, no importa modules/caja/, regla 7).
      queries/             rooms.ts, policies.ts, staff.ts, payments.ts — lecturas propias, no importadas de otros módulos (regla 7).
    rack/
      queries/             grid.ts — getRackGrid() (capa de vista, combina Reservaciones/Recepción/Habitaciones, sin tabla propia).
      actions/             assignments.ts — assignRoomFromRack(), reusa assign_room() (0026) vía RPC.
      components/          RackGrid.tsx — Client Component: drag & drop vertical + panel de detalle.
    priorities/
      engine.ts             evaluateHotelRules() — orquesta evaluadores, dedupe/auto-resolve vía RPC, timeline.
      scoring.ts             computePriorityScore() — determinista, sin dinero.
      evaluators/             arrivalNotRegistered.ts — un evaluador de TS por rule.code, registrado a mano en engine.ts.
      queries/             priorities.ts — listHotelPriorities(), getHotelPriority().
      actions/             lifecycle.ts — acknowledge/assign/startProgress/resolve/dismiss, todas requirePermission('priorities.manage').
    habitaciones/
      queries/             roomTypes.ts, rooms.ts — catálogo, amenidades/activos base, resolveRoomAmenities()/resolveRoomAssets() (herencia con excepción).
      actions/             roomTypes.ts (capacidad vía RPC con ImpactAnalysis, catálogo de amenidades), rooms.ts (deactivate/reactivate vía RPC, excepciones), snapshot.ts (congelarConfiguracionComercial(), propio punto de entrada -- Reservaciones llama al RPC directo, no este archivo).
    caja/
      actions/             payments.ts (registerPaymentWithMovements/registerRefund/validatePayment), shifts.ts (openShift/closeShift/registerCashExpense), adjustments.ts (registerStayAdjustment).
      queries/             payments.ts (metodos, saldo de reserva, pagos, pendientes de validar), shifts.ts (turno abierto/historial/movimientos), settings.ts (cash_settings).
    (ver src/modules/README.md para la convención completa)
  components/ui/          Componentes de UI compartidos entre módulos.
  types/
    database.types.ts      Tipos de la base de datos. Regenerar con el CLI de Supabase en cuanto haya forma de correr `supabase gen types` contra el proyecto real (instrucciones en el propio archivo).
supabase/
  config.toml             Config del CLI de Supabase.
  migrations/              Esquema completo, incremental, comentado (ver tabla arriba).
```

## Trabajar con Supabase

1. Crear un proyecto en supabase.com, copiar `.env.example` a `.env.local` y
   llenar `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` y
   `SUPABASE_SERVICE_ROLE_KEY` desde Project Settings → API.
2. Vincular el proyecto: `npx supabase link --project-ref <ref>`.
3. Aplicar el esquema: `npx supabase db push` (corre todo lo que hay en
   `supabase/migrations/` en orden).
4. Regenerar tipos cuando cambie el esquema:
   `npx supabase gen types typescript --linked --schema public > src/types/database.types.ts`.
5. Para agregar esquema nuevo: nueva migración con
   `npx supabase migration new <nombre>`, nunca editar una ya aplicada.

### Cómo se validó este esquema

Antes de dejarlo como base, las 9 migraciones se corrieron contra un
Postgres 16 local (con un stub mínimo del esquema `auth` de Supabase) y se
probó explícitamente que:

- Un usuario con rol en el Hotel A no puede ver hoteles, ni eventos de
timeline, de un Hotel B.
- `has_permission()` devuelve `true`/`false` correctamente según el rol
asignado (ej. `front_desk` puede `reservations.create` pero no
`hotel.settings.manage`).
- Un intento de insertar un evento de timeline en el hotel de otro usuario,
suplantando su propio `actor_user_id`, es bloqueado por RLS.

## Reglas para cualquier sesión futura de Claude Code (o humano)

Estas reglas existen directamente por los problemas del prototipo anterior.
No son sugerencias:

1. **Nunca** crear una tabla operativa sin `hotel_id` + RLS activado con
   políticas basadas en `user_hotel_ids()` / `has_permission()`.
2. **Nunca** confiar en un rol/permiso/hotel_id que venga del cliente sin
   validar contra `has_permission()` en servidor. La UI puede ocultar un
   botón; eso no es control de acceso.
3. **Nunca** llenar `created_by`/`updated_by`/`created_at`/`updated_at` a
   mano: usar el trigger `set_audit_fields()`.
4. **Nunca** hardcodear una política de hotel (garantías, horarios anticipados,
   activos entregados, límites de plan) en código: debe vivir en
   `hotel_policies` (o en una tabla de configuración nueva si no encaja ahí).
5. **Siempre** que una Server Action mute datos de negocio relevantes,
   terminar con `logTimelineEvent()`. Si un módulo nuevo necesita un
   `module` o `event_type` que no existe, agrégalo como convención
   documentada aquí, no lo inventes ad hoc en un solo lugar.
6. **Antes de escribir una función/componente/query nueva, busca si ya
   existe algo equivalente** (`grep`/buscar en `src/lib` y en el módulo
   correspondiente). Las funciones duplicadas sin que nadie se diera cuenta
   fueron el problema #1 del prototipo anterior.
7. Los módulos no se importan entre sí directamente. Código compartido va a
   `src/lib/` o `src/components/ui/`.
8. No se implementa lógica de negocio de un módulo (Reservaciones, Rack,
   Recepción, Habitaciones, Caja) hasta que se pida explícitamente esa
   tarea — la base de este documento es la única base compartida.
9. **Nunca** marcar una función de Postgres como `stable`/`immutable` si
   internamente llama a algo que escribe (aunque sea "de paso", como una
   limpieza perezosa tipo `expire_stale_holds()`) — PostgREST abre una
   transacción de solo lectura para esas funciones y la escritura falla en
   producción aunque funcione perfecto en local (ver el bug real de
   `check_availability()` en la sección de Reservaciones). Corolario: no te
   fíes solo de pruebas locales con `psql` para esto — hay que probar contra
   la API REST real de Supabase al menos una vez antes de dar por bueno un
   esquema con funciones.
10. **Nunca** construyas el string de `.select(...)` de Supabase
    concatenando con `+`: el cliente necesita el string como *literal* en
    tiempo de compilación para inferir el tipo de la fila (columnas
    embebidas incluidas); concatenar lo vuelve `string` genérico y toda la
    consulta se tipa como `GenericStringError`, silenciando el autocompletado
    y el chequeo de tipos sin un error obvio. Usa un solo string (con
    template literal sin `${}` si necesitas varias líneas), nunca `"a" + "b"`.
11. Si una tabla es append-only y por eso **no** tiene
    `updated_at`/`updated_by` (ej. `timeline_events`, `stay_transactions`),
    **no le pongas el trigger genérico** `set_audit_fields()` (fallaría, esas
    columnas no existen). Pero entonces `created_by` no se llena solo:
    o la tabla acepta INSERT directo del cliente y una política RLS
    `WITH CHECK (created_by = auth.uid())` lo garantiza (patrón de
    `timeline_events`), o solo se escribe vía una función `SECURITY DEFINER`
    y **esa función** debe fijar `created_by = auth.uid()` explícitamente en
    el `INSERT` (patrón de `stay_transactions` tras el fix de `0028`).
    Verifícalo probando contra Supabase real, no solo local — un
    `created_by` en `NULL` no revienta nada, así que pasa desapercibido si
    no se revisa a propósito.