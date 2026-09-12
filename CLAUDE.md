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
explícitamente — no hay trigger genérico ni RLS que lo haga por ti.

### Alcance de esta sesión (fuera de alcance a propósito)

Upgrade/downgrade de habitación con autorización (MVP sólo hace asignación
equivalente: misma `room_type_id` vendida); impacto financiero completo de
`walked` (`mark_walked()` sólo registra el evento); aplicación automática de
saldo a favor; integración automática de incidencias hacia un futuro módulo
de Mantenimiento (`stay_incidents` se registra y se resuelve manualmente,
sin flujo automático todavía); Late Check-Out/Early Check-In configurables.

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
"Políticas del hotel" de Configuración es dos `Card` una junto a otra, cada
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
    configuracion/        Página de prueba del módulo: catálogo de habitaciones, políticas del hotel, usuarios y roles (tabs).
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
      actions/             rooms.ts (tipos/habitaciones), policies.ts (hotel_policies/reception_settings), staff.ts (alta/rol/activación).
      queries/             rooms.ts, policies.ts, staff.ts — lecturas propias, no importadas de otros módulos (regla 7).
    rack/ habitaciones/ caja/  (carpetas listas, sin lógica todavía)
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
