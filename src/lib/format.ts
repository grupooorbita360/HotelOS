/** Formato de fecha en español simple, ej. "11 sep 2026" -- nunca mostrar el ISO crudo (yyyy-mm-dd) al usuario. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
}

export function formatDateRange(startIso: string | null | undefined, endIso: string | null | undefined): string {
  return `${formatDate(startIso)} → ${formatDate(endIso)}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("es-MX", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * Traduce un saldo con signo a lenguaje simple -- nunca se muestra un
 * número negativo crudo al usuario (ej. "-$345"). Ya existía sólo dentro
 * de Caja (`modules/caja/queries/payments.ts`); se movió aquí (P0-8,
 * handoff de demo) porque Recepción tiene el mismo problema con
 * `stay_accounts.balance` y no depende de que Caja esté desplegada --
 * regla 6, un solo lugar para esta traducción en vez de duplicarla.
 */
export function formatBalanceLabel(saldo: number): string {
  if (saldo > 0) return `Falta por pagar $${saldo.toFixed(2)}`;
  if (saldo < 0) return `Saldo a favor $${Math.abs(saldo).toFixed(2)}`;
  return "Cuenta liquidada";
}
