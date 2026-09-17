"use server";

import { requirePermission } from "@/lib/auth/permissions";
import { logTimelineEvent } from "@/lib/events/timeline";
import { createClient } from "@/lib/supabase/server";

export interface ConfirmReservationInput {
  hotelId: string;
  holdId: string;
  primaryGuestName: string;
  primaryGuestEmail?: string;
  primaryGuestPhone?: string;
  channel?: string;
  rateTotal?: number;
  adults?: number;
  children?: number;
  hasPets?: boolean;
}

/**
 * Convierte un Hold activo en Reserva confirmada (spec S5-S6): la garantía
 * o la confirmación explícita del huésped es lo que CONVIERTE el Hold,
 * nunca lo que lo crea. Este MVP registra la confirmación directamente
 * (garantía/pago real se añaden con actions/guarantee.ts y
 * actions/payment.ts sobre la reserva ya confirmada).
 */
export async function confirmReservation(input: ConfirmReservationInput) {
  await requirePermission(input.hotelId, "reservations.create");
  const supabase = await createClient();

  const { data: reservation, error } = await supabase.rpc("confirm_reservation_from_hold", {
    p_hold_id: input.holdId,
    p_primary_guest_name: input.primaryGuestName,
    p_primary_guest_email: input.primaryGuestEmail ?? null,
    p_primary_guest_phone: input.primaryGuestPhone ?? null,
    p_channel: input.channel ?? "direct",
    p_rate_total: input.rateTotal ?? 0,
    p_adults: input.adults ?? 1,
    p_children: input.children ?? 0,
    p_has_pets: input.hasPets ?? false,
  });
  if (error) throw error;

  // Habitaciones sigue siendo dueño de QUÉ se congela (capacidad +
  // amenidades es_promesa_comercial) -- Reservaciones sólo dispara el
  // momento, una vez por reserva, nunca por noche (ver CLAUDE.md, Módulo
  // 06 Habitaciones). Se llama al RPC directo, nunca importando el
  // Server Action de Habitaciones (regla 7: los módulos no se importan
  // entre sí -- mismo patrón que Rack llamando assign_room() por RPC en
  // vez de importar modules/recepcion/actions/lifecycle.ts).
  const { error: snapshotError } = await supabase.rpc("congelar_configuracion_comercial", {
    p_reservation_id: reservation.id,
  });
  if (snapshotError) throw snapshotError;

  await logTimelineEvent({
    hotelId: input.hotelId,
    module: "reservations",
    eventType: "reservation.confirmed",
    entityType: "reservation",
    entityId: reservation.id,
    payload: { folio: reservation.folio, hold_id: input.holdId },
  });

  return reservation;
}

export async function cancelReservation(hotelId: string, reservationId: string, reason?: string) {
  await requirePermission(hotelId, "reservations.cancel");
  const supabase = await createClient();

  const { data: reservation, error } = await supabase.rpc("cancel_reservation", {
    p_reservation_id: reservationId,
    p_reason: reason ?? null,
  });
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "reservations",
    eventType: "reservation.cancelled",
    entityType: "reservation",
    entityId: reservationId,
    payload: { reason: reason ?? null },
  });

  return reservation;
}
