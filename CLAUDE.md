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

Todas las tablas de este listado tienen RLS activado y probado (ver sección
"Cómo se validó" abajo). Ninguna tiene política de `DELETE` salvo que se
haya agregado explícitamente — dar de baja algo es un cambio de `status`/`is_active`,
no un borrado físico.

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
  middleware.ts           Refresca la sesión de Supabase en cada request.
  lib/
    supabase/
      client.ts           Cliente para Client Components (anon key).
      server.ts           Cliente para Server Components/Actions (anon key + cookies de sesión). Éste es el que usan los módulos.
      admin.ts             Cliente con service role (ignora RLS). Sólo para jobs de sistema, nunca para peticiones de usuario.
      middleware.ts        Lógica de refresco de sesión usada por middleware.ts.
    auth/
      permissions.ts        requirePermission()/hasPermission(): capa de UX sobre has_permission() de Postgres.
    events/
      timeline.ts           logTimelineEvent(): único punto de escritura a timeline_events.
  modules/
    reservaciones/ rack/ recepcion/ habitaciones/ caja/
      actions/             Server Actions (mutaciones): requirePermission() -> mutación -> logTimelineEvent().
      queries/             Lecturas server-side para Server Components.
      components/          UI específica del módulo.
    (ver src/modules/README.md para la convención completa)
  components/ui/          Componentes de UI compartidos entre módulos.
  types/
    database.types.ts      Tipos de la base de datos. Regenerar con el CLI de Supabase en cuanto exista un proyecto real (instrucciones en el propio archivo).
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
