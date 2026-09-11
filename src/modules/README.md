# Módulos

Cada carpeta aquí es un módulo de negocio (Reservaciones, Rack, Recepción,
Habitaciones, Caja, ...). Ningún módulo debe importar directamente del
código interno de otro módulo — si dos módulos necesitan compartir algo,
ese algo vive en `src/lib/` o `src/components/ui/`.

Convención interna de cada módulo:

```
modules/<modulo>/
  actions/      Server Actions: mutaciones. Validan permisos con
                requirePermission() ANTES de tocar la base de datos, y
                registran el resultado con logTimelineEvent() al terminar.
  queries/      Lecturas server-side (para Server Components). RLS ya
                filtra por hotel; estas funciones sólo dan forma a los datos.
  components/   Client/Server Components específicos del módulo.
```

Sigue el patrón transversal de HotelOS (ver CLAUDE.md):

DATOS → ESTADO OPERATIVO (derivado) → REGLAS → PRIORIDAD → ACCIÓN RECOMENDADA
→ USUARIO EJECUTA → EVENTO EN TIMELINE → KPI

Ningún módulo captura a mano un "estado operativo": ese estado se deriva de
los datos (ej. una reservación con fecha de llegada = hoy y sin check-in
registrado en el timeline está "pendiente de check-in"). Los KPIs, a su vez,
se calculan a partir de `timeline_events`, no de contadores manuales.
