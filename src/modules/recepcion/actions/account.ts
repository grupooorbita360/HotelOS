"use server";

import { requirePermission } from "@/lib/auth/permissions";
import { logTimelineEvent } from "@/lib/events/timeline";
import { createClient } from "@/lib/supabase/server";

export async function registerStayTransaction(
  hotelId: string,
  stayId: string,
  type: "charge" | "payment" | "refund",
  amount: number,
  concept: string,
  method?: "cash" | "card" | "transfer" | "other",
) {
  await requirePermission(hotelId, "payments.register");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("register_stay_transaction", {
    p_stay_id: stayId,
    p_type: type,
    p_amount: amount,
    p_concept: concept,
    p_method: method ?? null,
  });
  if (error) throw error;
  await logTimelineEvent({
    hotelId,
    module: "front_desk",
    eventType: "stay.transaction_registered",
    entityType: "stay",
    entityId: stayId,
    payload: { type, amount, concept },
  });
  return data;
}

export async function voidStayTransaction(hotelId: string, transactionId: string, stayId: string, reason?: string) {
  await requirePermission(hotelId, "payments.register");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("void_stay_transaction", {
    p_transaction_id: transactionId,
    p_reason: reason ?? null,
  });
  if (error) throw error;
  await logTimelineEvent({
    hotelId,
    module: "front_desk",
    eventType: "stay.transaction_voided",
    entityType: "stay",
    entityId: stayId,
    payload: { transaction_id: transactionId, reason: reason ?? null },
  });
  return data;
}
