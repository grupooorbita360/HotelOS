"use server";

import { requirePermission } from "@/lib/auth/permissions";
import { assertFeatureEnabled } from "@/lib/auth/platform";
import { logTimelineEvent } from "@/lib/events/timeline";
import { createClient } from "@/lib/supabase/server";

/**
 * Ajuste manual de la CuentaEstancia (stay_accounts/stay_transactions,
 * 0024) -- el saldo nunca se edita directo, siempre es un movimiento con
 * motivo (register_stay_adjustment, 0046, cash.adjust).
 */
export async function registerStayAdjustment(hotelId: string, stayId: string, amount: number, concept: string) {
  await assertFeatureEnabled(hotelId, "module.caja");
  await requirePermission(hotelId, "cash.adjust");
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("register_stay_adjustment", {
    p_stay_id: stayId,
    p_amount: amount,
    p_concept: concept,
  });
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "billing",
    eventType: "stay_account.adjusted",
    entityType: "stay_transaction",
    entityId: data.id,
    payload: { stay_id: stayId, amount, concept },
  });

  return data;
}
