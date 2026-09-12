"use server";

import { requirePermission } from "@/lib/auth/permissions";
import { logTimelineEvent } from "@/lib/events/timeline";
import { createClient } from "@/lib/supabase/server";

export interface HotelPoliciesInput {
  requiresGuarantee: boolean;
  guaranteeNotes?: string | null;
  allowsEarlyCheckin: boolean;
  standardCheckinTime: string;
  standardCheckoutTime: string;
}

export async function updateHotelPolicies(hotelId: string, input: HotelPoliciesInput) {
  await requirePermission(hotelId, "hotel.settings.manage");
  const supabase = await createClient();

  const { error } = await supabase
    .from("hotel_policies")
    .update({
      requires_guarantee: input.requiresGuarantee,
      guarantee_notes: input.guaranteeNotes ?? null,
      allows_early_checkin: input.allowsEarlyCheckin,
      standard_checkin_time: input.standardCheckinTime,
      standard_checkout_time: input.standardCheckoutTime,
    })
    .eq("hotel_id", hotelId);
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "core",
    eventType: "hotel_policies.updated",
    entityType: "hotel_policies",
    entityId: hotelId,
  });
}

export interface ReceptionSettingsInput {
  entregaPermiteSaldo: boolean;
  checkinPermiteSucia: boolean;
  noshowDiasGracia: number;
  bloquearCheckoutSaldo: boolean;
}

export async function updateReceptionSettings(hotelId: string, input: ReceptionSettingsInput) {
  await requirePermission(hotelId, "hotel.settings.manage");
  const supabase = await createClient();

  const { error } = await supabase
    .from("reception_settings")
    .update({
      entrega_permite_saldo: input.entregaPermiteSaldo,
      checkin_permite_sucia: input.checkinPermiteSucia,
      noshow_dias_gracia: input.noshowDiasGracia,
      bloquear_checkout_saldo: input.bloquearCheckoutSaldo,
    })
    .eq("hotel_id", hotelId);
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "core",
    eventType: "reception_settings.updated",
    entityType: "reception_settings",
    entityId: hotelId,
  });
}
