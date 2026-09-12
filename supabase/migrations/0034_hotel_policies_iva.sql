-- HotelOS / Configuracion: IVA configurable por hotel (0-100%, ej. 16.00
-- general o 8.00 zona fronteriza en Mexico) -- no se hardcodea en codigo
-- (principio 4 de CLAUDE.md). Puramente aditivo sobre hotel_policies (0007),
-- ya en uso por Reservaciones/Recepcion: una columna nueva con default no
-- afecta ninguna fila ni consulta existente.
--
-- Importante (pedido explicito): esto NO cambia los montos que el sistema ya
-- captura/muestra (tarifas, cargos, pagos) -- esos siguen siendo el total
-- final tal como el huesped los ve hoy, IVA ya incluido. Este campo y su
-- funcion de desglose (ver calculateTaxBreakdown en src/lib/tax.ts) son solo
-- para fines contables/de reportes, todavia sin UI de reportes ni
-- facturacion electronica -- eso es trabajo futuro explicitamente fuera de
-- alcance de este cambio.

alter table public.hotel_policies
  add column iva_porcentaje numeric(5, 2) not null default 16.00
    check (iva_porcentaje >= 0 and iva_porcentaje <= 100);

comment on column public.hotel_policies.iva_porcentaje is
  'IVA del hotel en porcentaje (ej. 16.00, u 8.00 en zona fronteriza). Configurable por hotel, nunca hardcodeado. Los montos ya capturados/mostrados por el sistema no cambian: este campo solo alimenta el desglose contable (calculateTaxBreakdown), no el calculo de precios al huesped.';

-- Sin cambios de RLS: hotel_policies ya se lee/escribe con las politicas de
-- 0007 (select para miembros del hotel, update con hotel.settings.manage);
-- la columna nueva queda cubierta por esas mismas politicas sin nada extra.
