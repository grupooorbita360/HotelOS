# HotelOS — Checklist de Seguridad

Documento vivo. Registra pruebas ya ejecutadas y pendientes, organizadas
por ronda de riesgo. Basado en propuesta inicial (Claude, 26-sep-2026)
ampliada y estructurada por ChatGPT.

**Regla permanente:** todo módulo nuevo de HotelOS define su propia
matriz de seguridad (aislamiento tenant, permisos, transiciones válidas,
concurrencia, timeline) en su documento funcional, antes de construirse.
No se audita solo al final.

---

## ✅ Ya validado (26-sep-2026, issue #8)

| # | Prueba | Resultado |
|---|--------|-----------|
| 1 | Flujo de tokens de recovery/invitación (PKCE vs. fragmento vs. token_hash) | ✅ resuelto vía página cliente `/auth/callback` |
| 2 | Reutilización de enlace de recovery/invitación ya usado | ✅ rechazado con error legible |
| 3 | Protección contra open redirect (`&next=` externo malicioso) | ✅ ignorado, cae a flujo seguro |
| 4 | Rate limiting del SMTP default de Supabase | ✅ confirmado que existe (~4 correos/hora) |

---

## Ronda 1 — Aislamiento Hotel A / Hotel B (CRÍTICO — siguiente)

**Requiere:** crear Hotel A (Owner A + Recepción A) y Hotel B (Owner B + Recepción B) de prueba.

| # | Prueba | Ejecutable por | Bien | Alerta |
|---|--------|-----------------|------|--------|
| 1.1 | Lectura cruzada por ID (reserva, estancia, habitación, pago, huésped de otro hotel) | Eduardo (UI) | 0 resultados / acceso denegado | Devuelve datos del otro hotel |
| 1.2 | Modificación cruzada (UPDATE) | Eduardo (UI) | Rechazado | Modifica el registro |
| 1.3 | Creación con `hotel_id` ajeno | Kimi (requiere llamada directa) | Rechazado | INSERT exitoso |
| 1.4 | Eliminación cruzada | Eduardo (UI) | Rechazado | Elimina |
| 1.5 | RPC/funciones `SECURITY DEFINER` con IDs ajenos | Kimi (requiere llamada directa) | Valida pertenencia y rechaza | Opera sobre el otro hotel |
| 1.6 | Relaciones indirectas (payments, movements, assignments, timeline, incidencias, holds) | Eduardo (UI) + Kimi | Nada accesible | Datos hijos expuestos |
| 1.7 | Storage (archivos/logos privados) | N/A por ahora | — | — |
| 1.8 | Realtime (suscripciones entre hoteles) | N/A por ahora | — | — |

---

## Ronda 2 — Privilegios y `/admin` (CRÍTICO)

| # | Prueba | Ejecutable por | Bien | Alerta |
|---|--------|-----------------|------|--------|
| 2.1 | Staff intenta autoascenderse a `hotel_admin` | Eduardo (UI) | Rechazado | Consigue elevar rol |
| 2.2 | `hotel_admin` intenta volverse `platform_admin` | Eduardo (UI) | Imposible | Obtiene privilegio |
| 2.3 | Ejecutar acción oculta en la UI directamente (no solo botón escondido) | Kimi (requiere llamada directa) | Backend rechaza | Funciona porque solo estaba oculto |
| 2.4 | Staff modifica rol/permiso de otro usuario del mismo hotel | Eduardo (UI) | Según permiso explícito | Cualquier staff puede hacerlo |
| 2.5 | Rol no autorizado aprueba/revierte una operación financiera | Eduardo (UI) | Rechazo por permiso | Acción exitosa |
| 2.6 | Staff modifica configuración (IVA, timezone, métodos de pago, políticas) | Eduardo (UI) | Rechazado | Modificación exitosa |
| 2.7 | Payload manipulado con rol/permiso falso | Kimi (requiere llamada directa) | Backend ignora/rechaza | Confía en el cliente |
| 3.1 | `hotel_admin` accede directo a rutas `/admin` (URL directa, no menú) | Eduardo (UI) | Rechazo/redirección segura | Ruta responde con datos |
| 3.2 | `hotel_admin` llama acciones de plataforma directamente (crear hotel, cambiar plan/licencia, activar función, invitar admin, suspender) | Kimi (requiere llamada directa) | Autorización de plataforma en servidor | Basta conocer el endpoint |
| 3.3 | Tenant manipula su propio plan/límites desde el cliente | Kimi (requiere llamada directa) | Imposible | Tenant altera sus límites |
| 3.4 | Confirmar qué usa `platform_admin` vs `service_role` internamente | Kimi (revisión de código) | Separación clara de roles | `service_role` usado como admin normal |

---

## Ronda 3 — Dinero (Caja) — priorizar cuando Caja tenga más uso real

| # | Prueba | Bien | Alerta |
|---|--------|------|--------|
| Doble envío de pago | Idempotencia evita doble efecto | Doble pago por doble click/retry |
| Monto manipulado desde el cliente | Backend valida monto real | Acepta cualquier monto del frontend |
| Valores imposibles (negativos, cero, decimales excesivos, moneda inválida) | Reglas backend rechazan | Se aceptan |
| Refund/reversión repetida | Saldo/estado lo impide | Reembolso duplicado |
| Pago aplicado a reserva/hotel ajeno | Rechazo por tenant + consistencia relacional | Se aplica |
| Salto de estado de aprobación | Transición gobernada | UPDATE directo basta |

---

## Ronda 4 — Sesión, entradas, errores, secretos

| # | Prueba | Bien | Alerta |
|---|--------|------|--------|
| Logout → reutilizar acción sensible | Requiere sesión válida | Sigue funcionando |
| Cambio de contraseña → sesiones existentes | Política deliberada | Comportamiento accidental |
| Usuario desactivado con sesión abierta | Pierde capacidad pronto | Sigue operando largo tiempo |
| Cambio de rol con sesión activa (sin relogin) | Servidor usa permisos actuales | Permisos viejos persisten |
| Membresía a 2 hoteles: hotel visual A + `hotel_id` B enviado | Se valida membresía real | Accede a B |
| XSS almacenado (notas, nombres, motivos, referencias) con HTML/scripts/Unicode | Se sanitiza o rechaza | Rompe interfaz o ejecuta contenido |
| Mensajes de error no filtran SQL, stack trace, claves, datos de otro hotel | Mensaje genérico | Expone información interna |
| Revisar bundle del cliente por `service_role` u otras credenciales privilegiadas | Nunca presente | Aparece en el JS compilado |

---

## Ronda 5 — SaaS: límites y licencias

| # | Prueba | Bien | Alerta |
|---|--------|------|--------|
| Crear recurso #11 con límite de plan en 10 | Backend rechaza | Se crea igual |
| Usuario adicional sobre el máximo del plan | Backend rechaza | Se agrega igual |
| Activar función premium sin el plan que la incluye | Backend rechaza | Se activa igual |
| Hotel suspendido/licencia vencida sigue operando | Bloqueado | Sigue operando |

---

## Backlog / no aplica todavía

- Storage (sin uso actual)
- Realtime (sin uso actual)
- Pruebas específicas de Housekeeping (módulo no construido aún — definir su matriz al construirlo)
- Auditoría/timeline: intento de alterar/borrar evidencia por el mismo usuario que hizo la operación
- Borrado de entidades referenciadas (habitación con historial, huésped con reservas, etc.) — probar cuando existan más datos reales

---

## Prueba integral final (cuando las rondas 1-2 estén validadas)

Con Platform Admin + Hotel A (Owner, Recepción) + Hotel B (Owner, Recepción):
generar en ambos el ciclo completo Reserva → Hold → Huésped → Estancia →
Habitación → Pago → Evento, y confirmar la matriz completa de acceso
(propio: según permisos: cruzado: nunca; anónimo: nunca) tanto por UI
como por llamada directa al backend.
