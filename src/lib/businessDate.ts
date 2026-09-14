/**
 * Cálculo puro de la fecha operativa ("businessDate") de un hotel a partir
 * de su timezone (IANA, ej. "America/Cancun"). Sin acceso a base de datos,
 * sin "server-only" -- para que sea importable desde cualquier contexto
 * (incluidas pruebas con `node` plano, sin bundler).
 *
 * Etapa actual (ver CLAUDE.md): businessDate = fecha calendario en el
 * timezone del hotel, sin corte nocturno. `getHotelBusinessDate()`
 * (src/lib/getHotelBusinessDate.ts) es la función que los módulos deben
 * usar en la práctica -- ésta es su motor de cálculo.
 */

/** true si `timezone` es un identificador IANA que Intl puede resolver. */
export function isValidTimezone(timezone: string): boolean {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fecha calendario (YYYY-MM-DD) del instante `instant` en el timezone dado.
 * Lanza si `timezone` no es un identificador IANA válido -- una
 * configuración inválida nunca debe producir silenciosamente una fecha
 * incorrecta (ej. cayendo de vuelta a UTC sin decirlo).
 */
export function computeBusinessDate(timezone: string, instant: Date = new Date()): string {
  if (!isValidTimezone(timezone)) {
    throw new Error(`businessDate: "${timezone}" no es un timezone IANA válido.`);
  }
  // en-CA formatea como YYYY-MM-DD de forma nativa; evita tener que armar
  // el string a mano a partir de formatToParts().
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}
