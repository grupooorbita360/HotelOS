"use server";

import { requirePermission } from "@/lib/auth/permissions";
import { assertFeatureEnabled } from "@/lib/auth/platform";
import { logTimelineEvent } from "@/lib/events/timeline";
import { createClient } from "@/lib/supabase/server";

export async function openShift(hotelId: string, fondoInicial: number, notes?: string) {
  await assertFeatureEnabled(hotelId, "module.caja");
  await requirePermission(hotelId, "payments.register");
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("open_cash_shift", {
    p_hotel_id: hotelId,
    p_fondo_inicial: fondoInicial,
    p_notes: notes ?? null,
  });
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "billing",
    eventType: "cash_shift.opened",
    entityType: "cash_shift",
    entityId: data.id,
    payload: { fondo_inicial: fondoInicial },
  });

  return data;
}

export async function closeShift(hotelId: string, shiftId: string, efectivoContado: number, notes?: string) {
  await assertFeatureEnabled(hotelId, "module.caja");
  await requirePermission(hotelId, "payments.register");
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("close_cash_shift", {
    p_shift_id: shiftId,
    p_efectivo_contado: efectivoContado,
    p_notes: notes ?? null,
  });
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "billing",
    eventType: "cash_shift.closed",
    entityType: "cash_shift",
    entityId: shiftId,
    payload: { efectivo_contado: efectivoContado, diferencia: data.diferencia },
  });

  return data;
}

export interface RegisterCashExpenseInput {
  hotelId: string;
  shiftId: string;
  amount: number;
  concept: string;
  category?: string;
  receiptUrl?: string;
}

/** Egreso operativo menor (taxi, caja chica) -- limite explicito de v1, nunca cuentas por pagar. */
export async function registerCashExpense(input: RegisterCashExpenseInput) {
  await assertFeatureEnabled(input.hotelId, "module.caja");
  await requirePermission(input.hotelId, "payments.register");
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("register_cash_expense", {
    p_shift_id: input.shiftId,
    p_amount: input.amount,
    p_concept: input.concept,
    p_category: input.category ?? null,
    p_receipt_url: input.receiptUrl ?? null,
  });
  if (error) throw error;

  await logTimelineEvent({
    hotelId: input.hotelId,
    module: "billing",
    eventType: "cash_expense.registered",
    entityType: "cash_movement",
    entityId: data.id,
    payload: { amount: input.amount, concept: input.concept, category: input.category ?? null },
  });

  return data;
}
