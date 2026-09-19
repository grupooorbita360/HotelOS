"use server";

import { requirePermission } from "@/lib/auth/permissions";
import { logTimelineEvent } from "@/lib/events/timeline";
import { createClient } from "@/lib/supabase/server";

export interface PaymentMethodInput {
  name: string;
  type: "cash" | "card" | "transfer" | "other";
  requiereReferencia: boolean;
  requiereValidacionManual: boolean;
  generaComision: boolean;
  proveedor?: string;
}

export async function createPaymentMethod(hotelId: string, input: PaymentMethodInput) {
  await requirePermission(hotelId, "hotel.settings.manage");
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("payment_methods")
    .insert({
      hotel_id: hotelId,
      name: input.name,
      type: input.type,
      requiere_referencia: input.requiereReferencia,
      requiere_validacion_manual: input.requiereValidacionManual,
      genera_comision: input.generaComision,
      proveedor: input.proveedor ?? null,
    })
    .select()
    .single();
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "billing",
    eventType: "payment_method.created",
    entityType: "payment_method",
    entityId: data.id,
    payload: { name: input.name, type: input.type },
  });
}

export async function setPaymentMethodActive(hotelId: string, methodId: string, isActive: boolean) {
  await requirePermission(hotelId, "hotel.settings.manage");
  const supabase = await createClient();

  const { error } = await supabase
    .from("payment_methods")
    .update({ is_active: isActive })
    .eq("id", methodId)
    .eq("hotel_id", hotelId);
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "billing",
    eventType: isActive ? "payment_method.reactivated" : "payment_method.deactivated",
    entityType: "payment_method",
    entityId: methodId,
  });
}

export interface CashSettingsInput {
  usaTurnosCaja: boolean;
  requiereFacturacionFiscal: boolean;
  rfcHotel?: string;
  regimenFiscal?: string;
}

export async function updateCashSettings(hotelId: string, input: CashSettingsInput) {
  await requirePermission(hotelId, "hotel.settings.manage");
  const supabase = await createClient();

  const { error } = await supabase
    .from("cash_settings")
    .update({
      usa_turnos_caja: input.usaTurnosCaja,
      requiere_facturacion_fiscal: input.requiereFacturacionFiscal,
      rfc_hotel: input.rfcHotel ?? null,
      regimen_fiscal: input.regimenFiscal ?? null,
    })
    .eq("hotel_id", hotelId);
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "billing",
    eventType: "cash_settings.updated",
    entityType: "cash_settings",
    entityId: hotelId,
  });
}
