/**
 * Desglose contable/de reportes a partir de un monto YA final (impuesto
 * incluido) -- nunca al revés. No cambia ni un solo monto que el sistema ya
 * captura o muestra (tarifas, cargos, pagos siguen siendo el total tal como
 * el huésped los ve); esto es sólo para reportes contables futuros.
 */
export interface TaxBreakdown {
  total: number;
  subtotal: number;
  montoIva: number;
  ivaPorcentaje: number;
}

export function calculateTaxBreakdown(total: number, ivaPorcentaje: number): TaxBreakdown {
  const subtotal = Math.round((total / (1 + ivaPorcentaje / 100)) * 100) / 100;
  const montoIva = Math.round((total - subtotal) * 100) / 100;
  return { total, subtotal, montoIva, ivaPorcentaje };
}
