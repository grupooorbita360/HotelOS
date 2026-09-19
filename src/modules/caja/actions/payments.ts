"use server";

import { requirePermission } from "@/lib/auth/permissions";
import { assertFeatureEnabled } from "@/lib/auth/platform";
import { logTimelineEvent } from "@/lib/events/timeline";
import { createClient } from "@/lib/supabase/server";

export interface PaymentMovementInput {
  paymentMethodId: string;
  amount: number;
  reference?: string;
}

export interface RegisterPaymentInput {
  hotelId: string;
  reservationId: string;
  type: "deposit" | "installment" | "full_payment";
  movements: PaymentMovementInput[];
  currency?: string;
  notes?: string;
  confirmOverpayment?: boolean;
}

/**
 * Pago compuesto: 1 Pago -> N MovimientoCaja (register_payment_with_movements,
 * 0046). Nunca inserta directo -- la funcion valida sobrepago, metodo activo,
 * referencia obligatoria y turno de caja abierto si hay efectivo.
 */
export async function registerPaymentWithMovements(input: RegisterPaymentInput) {
  await assertFeatureEnabled(input.hotelId, "module.caja");
  await requirePermission(input.hotelId, "payments.register");
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("register_payment_with_movements", {
    p_hotel_id: input.hotelId,
    p_reservation_id: input.reservationId,
    p_type: input.type,
    p_movements: input.movements.map((m) => ({
      payment_method_id: m.paymentMethodId,
      amount: m.amount,
      reference: m.reference ?? null,
    })),
    p_currency: input.currency ?? "MXN",
    p_notes: input.notes ?? null,
    p_confirm_overpayment: input.confirmOverpayment ?? false,
  });
  if (error) throw error;

  await logTimelineEvent({
    hotelId: input.hotelId,
    module: "billing",
    eventType: "payment.registered",
    entityType: "payment",
    entityId: data.id,
    payload: { reservation_id: input.reservationId, type: input.type, amount: data.amount },
  });

  return data;
}

export interface RegisterRefundInput {
  hotelId: string;
  reservationId: string;
  originalPaymentId?: string;
  amount: number;
  paymentMethodId: string;
  reason: string;
}

/** Reembolso: monto siempre positivo en la entrada (0046, cash.refund). */
export async function registerRefund(input: RegisterRefundInput) {
  await assertFeatureEnabled(input.hotelId, "module.caja");
  await requirePermission(input.hotelId, "cash.refund");
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("register_refund", {
    p_hotel_id: input.hotelId,
    p_reservation_id: input.reservationId,
    p_original_payment_id: input.originalPaymentId ?? null,
    p_amount: input.amount,
    p_payment_method_id: input.paymentMethodId,
    p_reason: input.reason,
  });
  if (error) throw error;

  await logTimelineEvent({
    hotelId: input.hotelId,
    module: "billing",
    eventType: "payment.refunded",
    entityType: "payment",
    entityId: data.id,
    payload: { reservation_id: input.reservationId, amount: input.amount, reason: input.reason },
  });

  return data;
}

export async function validatePayment(hotelId: string, paymentId: string) {
  await assertFeatureEnabled(hotelId, "module.caja");
  await requirePermission(hotelId, "payments.register");
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("validate_payment", { p_payment_id: paymentId });
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "billing",
    eventType: "payment.validated",
    entityType: "payment",
    entityId: paymentId,
  });

  return data;
}
