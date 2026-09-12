-- HotelOS / Configuracion: campos que le faltaban al catalogo de
-- habitaciones para dejar de editarse a mano en Supabase (Modulo 04).
--
-- Decision de donde va cada campo (documentada tambien en CLAUDE.md):
-- capacidad maxima y "acepta mascotas" YA existian en room_types (la
-- categoria vendible) desde 0010, porque Reservaciones cotiza y bloquea
-- inventario por room_type, nunca por Room individual (ver comentario de
-- 0010 y el algoritmo de concurrencia en 0016). No se duplican aqui en
-- rooms: seria una segunda fuente de verdad para el mismo dato.
--
-- "tarifa base" es nueva y va en room_types por la misma razon: es el nivel
-- al que hoy se cotiza (quote_options.subtotal se captura a mano en cada
-- cotizacion porque el motor de tarifas es evolucion futura). Esta columna
-- es puramente de referencia para el staff -- Reservaciones no la lee
-- automaticamente todavia; conectarla al flujo de cotizacion es trabajo del
-- futuro modulo de Tarifas, fuera de alcance de esta sesion.
--
-- "zona/edificio" y "tipo de cama" SI son atributos de la unidad fisica
-- (dos habitaciones del mismo room_type pueden estar en edificios o tener
-- camas distintas), asi que van en rooms.

alter table public.room_types
  add column base_rate numeric(12, 2) not null default 0;

comment on column public.room_types.base_rate is
  'Tarifa de referencia por noche para esta categoria. Informativa para el staff en esta version -- el flujo de cotizacion de Reservaciones sigue capturando el monto a mano (ver 0012_quotes.sql); integrarla automaticamente es alcance del futuro modulo de Tarifas.';

alter table public.rooms
  add column building text,
  add column bed_type text
    check (bed_type is null or bed_type in ('individual', 'matrimonial', 'queen', 'king', 'litera', 'sofa_cama'));

comment on column public.rooms.building is
  'Zona o edificio de la unidad fisica (ej. "Torre A", "Planta baja"). Texto libre, no hay catalogo fijo de zonas por hotel.';
comment on column public.rooms.bed_type is
  'Tipo de cama de la unidad fisica. Catalogo cerrado chico a proposito (igual que otros campos tipo-enum del proyecto); NULL = no capturado todavia.';

-- Sin cambios de RLS: las politicas de escritura de 0010 (hotel.settings.manage)
-- ya cubren estas columnas nuevas al ser "for all" sobre toda la fila.
