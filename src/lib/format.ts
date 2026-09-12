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
