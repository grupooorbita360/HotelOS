/**
 * Traduce los códigos de error que las funciones SECURITY DEFINER de este
 * proyecto lanzan (`raise exception 'CODIGO: detalle'`) a un mensaje que un
 * usuario de staff pueda leer -- nunca un error 500 crudo (P0-1, handoff de
 * demo). Cubre los códigos ya usados en Reservaciones/Recepción/Rack; un
 * código no listado cae en el mensaje genérico, nunca se re-lanza tal cual.
 */
const KNOWN_ERROR_MESSAGES: Record<string, string> = {
  HOLD_EXPIRED: "Este Hold ya expiró. Vuelve a cotizar para generar uno nuevo.",
  HOLD_NOT_ACTIVE: "Este Hold ya no está activo (probablemente ya se confirmó o se liberó). Vuelve a cotizar.",
  HOLD_NOT_FOUND: "No se encontró este Hold -- puede que ya se haya usado. Vuelve a cotizar.",
  NO_AVAILABILITY: "Ya no hay disponibilidad para esas fechas: alguien más tomó la última unidad.",
  ROOM_TYPE_NOT_FOUND_FOR_HOTEL: "El tipo de habitación seleccionado ya no está disponible.",
  QUOTE_OPTION_NOT_FOUND_FOR_HOTEL: "No se encontró esa cotización.",
  QUOTE_NOT_FOUND: "No se encontró la cotización.",
  HOTEL_POLICIES_NOT_FOUND: "No se encontró la configuración de este hotel.",
  INVALID_DATE_RANGE: "El rango de fechas no es válido.",
  PERMISSION_DENIED: "No tienes permiso para realizar esta acción.",
  ROOM_NOT_FOUND_FOR_HOTEL: "Esa habitación ya no está disponible en este hotel.",
  ROOM_TYPE_MISMATCH: "Esa habitación es de otro tipo -- no se puede asignar sin autorización de upgrade/downgrade.",
  ROOM_ALREADY_OCCUPIED: "Esa habitación ya tiene una estancia activa asignada.",
  STAY_NOT_FOUND: "No se encontró esa estancia.",
  RESERVATION_NOT_FOUND: "No se encontró esa reserva.",
  RESERVATION_NOT_CANCELLABLE: "Esta reserva ya no se puede cancelar en su estado actual.",
  DISCOUNT_REASON_REQUIRED: "Un descuento o cortesía necesita un motivo.",
  REASON_REQUIRED: "Este cambio necesita un motivo.",
  INVALID_CHARGE_AMOUNT: "El monto del cobro no es válido.",
  INVALID_COMPENSATION_AMOUNT: "El monto de la compensación no es válido.",
};

function extractMessage(error: unknown): string {
  // Los errores de Postgres que llegan vía supabase-js (PostgrestError) no
  // siempre pasan `instanceof Error` de forma confiable a través de la
  // frontera de un Server Action -- se probó en vivo (P0-1, HOLD_EXPIRED)
  // que un chequeo estricto de `instanceof Error` deja pasar estos casos
  // al mensaje genérico. Se busca `.message` en cualquier objeto con esa
  // forma, no sólo en instancias reales de Error.
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

export function friendlyErrorMessage(error: unknown, fallback = "No se pudo completar la operación. Intenta de nuevo."): string {
  const raw = extractMessage(error);
  const code = Object.keys(KNOWN_ERROR_MESSAGES).find((c) => raw.includes(c));
  return code ? KNOWN_ERROR_MESSAGES[code] : fallback;
}
