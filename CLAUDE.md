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
ningún módulo futuro la trate como "algo que se agrega después".

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
      actions/             quote.ts, hold.ts, confirm.ts — requirePermission() -> RPC atómica o mutación -> logTimelineEvent().
      queries/             availability.ts, reservations.ts, leads.ts, details.ts — lecturas server-side.
    rack/ recepcion/ habitaciones/ caja/  (carpetas listas, sin lógica todavía)
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
