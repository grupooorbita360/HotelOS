import { calculateTaxBreakdown } from "@/lib/tax";

/**
 * Fuente única de cálculo de precio de una estancia (auditoría de precio,
 * Tier 1 -- ver CLAUDE.md). Pura, sin acceso a DB: quien la llama trae
 * baseRateNightly (room_types.base_rate) e ivaPorcentaje ya resueltos.
 *
 * nightlyRateOverride sigue siendo la tarifa negociada que el staff puede
 * capturar al cotizar (UX ya existente, ver Módulo 04) -- esto NO la
 * prohíbe, sólo hace que pase por el mismo cálculo que la tarifa de lista
 * en vez de que el total llegue ya hecho desde el cliente.
 */
export interface StayPriceInput {
  baseRateNightly: number;
  nights: number;
  nightlyRateOverride?: number;
  ivaPorcentaje: number;
}

export interface StayPriceResult {
  nightlyRateUsed: number;
  nights: number;
  subtotal: number;
  taxes: number;
  total: number;
  isOverride: boolean;
}

export function calculateStayPrice(input: StayPriceInput): StayPriceResult {
  const nightlyRateUsed = input.nightlyRateOverride ?? input.baseRateNightly;
  const total = Math.round(nightlyRateUsed * input.nights * 100) / 100;
  const { subtotal, montoIva: taxes } = calculateTaxBreakdown(total, input.ivaPorcentaje);

  return {
    nightlyRateUsed,
    nights: input.nights,
    subtotal,
    taxes,
    total,
    isOverride: input.nightlyRateOverride != null && input.nightlyRateOverride !== input.baseRateNightly,
  };
}
