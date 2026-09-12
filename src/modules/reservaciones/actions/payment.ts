"use server";

import { requirePermission } from "@/lib/auth/permissions";
import { logTimelineEvent } from "@/lib/events/timeline";
import { createClient } from "@/lib/supabase/server";

export interface RegisterPaymentInput {
  hotelId: string;
  reservationId: string;
  type: "deposit" | "installment" | "full_payment" | "refund";
  amount: number;
  currency?: string;
  method: "card" | "transfer";
  notes?: string;
}

/**
 * Registra un Pago real sobre una reserva ya confirmada (spec S16/S18: nunca
 * el mismo registro que una Garantia). Sin motor de tipo de cambio todavia:
 * exchange_rate_applied usa el default de la tabla (1) y amount_local = amount.
 * No es SECURITY DEFINER -- guarantees/payments SI aceptan INSERT directo del
 * cliente (ver 0017), a diferencia de inventory_holds/reservations.
 */
export async function registerPayment(input: RegisterPaymentInput) {
  await requirePermission(input.hotelId, "payments.register");
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("payments")
    .insert({
      hotel_id: input.hotelId,
      reservation_id: input.reservationId,
      type: input.type,
      amount: input.amount,
      currency: input.currency ?? "MXN",
      amount_local: input.amount,
      method: input.method,
      notes: input.notes ?? null,
    })
    .select()
    .single();
  if (error) throw error;

  await logTimelineEvent({
    hotelId: input.hotelId,
    module: "reservations",
    eventType: "payment.registered",
    entityType: "payment",
    entityId: data.id,
    payload: { reservation_id: input.reservationId, type: input.type, amount: input.amount, method: input.method },
  });

  return data;
}
