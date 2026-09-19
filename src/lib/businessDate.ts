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

/**
 * Offset (ms) del timezone IANA respecto a UTC en el instante dado:
 * sumarlo a una hora de pared local (interpretada como UTC) la convierte
 * al instante UTC real. Se evalúa dos veces en computeZonedEndOfDay para
 * absorber el redondeo de la primera pasada (cambio de offset a mitad
 * del cálculo, p. ej. medianoche con DST).
 */
function tzOffsetMs(timezone: string, instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  const hour = map.hour === "24" ? 0 : Number(map.hour);
  const wallAsUtc = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), hour, Number(map.minute), Number(map.second));
  return wallAsUtc - instant.getTime();
}

/**
 * Último instante (23:59:59.999) del día calendario `dateYmd` ("YYYY-MM-DD")
 * en el timezone del hotel, como Date UTC. Es el criterio correcto para
 * vencimientos "ese día" (licencias, políticas): un hotel en
 * America/Mexico_City con vencimiento 2026-12-31 debe vigorar hasta las
 * 23:59:59.999 de Cancún/DF, no de UTC (fix M-3: guardar 23:59:59Z
 * adelantaba/atrasa el corte según el tz y dejaba 1s fuera).
 */
export function computeZonedEndOfDay(timezone: string, dateYmd: string): Date {
  if (!isValidTimezone(timezone)) {
    throw new Error(`businessDate: "${timezone}" no es un timezone IANA válido.`);
  }
  const [y, m, d] = dateYmd.split("-").map(Number);
  if (!y || !m || !d) {
    throw new Error(`businessDate: "${dateYmd}" no es una fecha YYYY-MM-DD válida.`);
  }
  // Aproximación: medianoche (hora de pared) del día siguiente en UTC...
  const approx = new Date(Date.UTC(y, m - 1, d + 1));
  // ...se corrige con el offset real del tz (dos pasadas para DST)...
  let offset = tzOffsetMs(timezone, approx);
  const nextMidnightUtc = new Date(approx.getTime() - offset);
  offset = tzOffsetMs(timezone, nextMidnightUtc);
  const refined = new Date(approx.getTime() - offset);
  // ...y se resta 1 ms: queda 23:59:59.999 del día pedido, hora del hotel.
  return new Date(refined.getTime() - 1);
}
