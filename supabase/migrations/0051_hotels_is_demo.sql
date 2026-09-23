-- HotelOS — hotels.is_demo: fuente de verdad única para detectar el Hotel Demo.
--
-- Contexto (issue #16): el aislamiento del Hotel Demo (jamás enviar correos,
-- WhatsApp, pagos o webhooks reales) necesita un flag explícito en hotels.
-- Hasta la 0050 el demo se detectaba por slug='hotel-demo' hardcodeado en 3
-- lugares (función reset_demo_hotel(), server action y tab Demo de /admin) —
-- eso convertía al slug en un flag de seguridad implícito que alguien podría
-- cambiar sin saber que rompe el aislamiento.
--
-- Qué hace esta migración:
--   1. Agrega hotels.is_demo (default false: ningún hotel real es demo).
--   2. Backfill: marca is_demo=true al hotel con slug='hotel-demo' si ya existe.
--   3. Garantiza UN solo hotel demo por base (índice único parcial).
--
-- La 0050 (reset_demo_hotel) se actualiza en el mismo cambio para consultar
-- por is_demo en vez de slug. Su CREATE FUNCTION no falla aunque la columna
-- todavía no exista al aplicar 0050 (plpgsql planea las consultas en la
-- primera ejecución, no al crear la función), y el orden de migraciones
-- garantiza 0050 -> 0051 antes de cualquier llamada.
--
-- Alcance deliberado: NO incluye el guard de salida externa (correo). Eso es
-- el resto del issue #16 y viene después, con la columna ya aplicada.

alter table public.hotels
  add column is_demo boolean not null default false;

comment on column public.hotels.is_demo is
  'true sólo para el Hotel Demo. Fuente de verdad del aislamiento del demo: ningún correo/WhatsApp/pago/webhook real puede salir de un hotel con is_demo=true (issue #16). El slug es sólo identificador legible, NO el flag de seguridad.';

-- Backfill: el hotel demo existente (creado por 0050 o a mano en desarrollo).
update public.hotels set is_demo = true where slug = 'hotel-demo';

-- Un solo hotel demo por base: evita que un segundo alta accidental quede
-- marcada como demo (y que el aislamiento aplique a un hotel que no debía).
create unique index hotels_single_demo_idx
  on public.hotels (is_demo)
  where is_demo;
