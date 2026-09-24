"use server";

import { requirePermission } from "@/lib/auth/permissions";
import { logTimelineEvent } from "@/lib/events/timeline";
import { createClient } from "@/lib/supabase/server";
import { isValidHexColor } from "@/lib/color";
import type { Json } from "@/types/database.types";

export interface HotelPoliciesInput {
  requiresGuarantee: boolean;
  guaranteeNotes?: string | null;
  allowsEarlyCheckin: boolean;
  standardCheckinTime: string;
  standardCheckoutTime: string;
  ivaPorcentaje: number;
}

export async function updateHotelPolicies(hotelId: string, input: HotelPoliciesInput) {
  await requirePermission(hotelId, "hotel.settings.manage");
  if (input.ivaPorcentaje < 0 || input.ivaPorcentaje > 100) {
    throw new Error("El IVA debe estar entre 0 y 100.");
  }

  const supabase = await createClient();

  const { error } = await supabase
    .from("hotel_policies")
    .update({
      requires_guarantee: input.requiresGuarantee,
      guarantee_notes: input.guaranteeNotes ?? null,
      allows_early_checkin: input.allowsEarlyCheckin,
      standard_checkin_time: input.standardCheckinTime,
      standard_checkout_time: input.standardCheckoutTime,
      iva_porcentaje: input.ivaPorcentaje,
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

/**
 * El color de marca se pidió explícitamente después de cerrar el alcance de
 * este módulo (CLAUDE.md lo había marcado fuera de alcance como parte de
 * "branding del hotel" completo -- logo, etc.). Se acota a un solo color de
 * acento: vive en `hotel_policies.extra_settings.brand_color`, el catch-all
 * jsonb que ya existía exactamente para esto (una política nueva que no
 * justifica todavía una columna propia), no una tabla ni columna nueva.
 */
export async function updateBrandColor(hotelId: string, hexColor: string | null) {
  await requirePermission(hotelId, "hotel.settings.manage");
  if (hexColor && !isValidHexColor(hexColor)) {
    throw new Error("Color inválido. Usa un formato hexadecimal, ej. #0F766E.");
  }

  const supabase = await createClient();
  const { data: current, error: currentError } = await supabase
    .from("hotel_policies")
    .select("extra_settings")
    .eq("hotel_id", hotelId)
    .single();
  if (currentError) throw currentError;

  const nextSettings: Record<string, Json> = { ...((current.extra_settings as Record<string, Json>) ?? {}) };
  if (hexColor) nextSettings.brand_color = hexColor;
  else delete nextSettings.brand_color;

  const { error } = await supabase
    .from("hotel_policies")
    .update({ extra_settings: nextSettings })
    .eq("hotel_id", hotelId);
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "core",
    eventType: "hotel_policies.updated",
    entityType: "hotel_policies",
    entityId: hotelId,
    payload: { brand_color: hexColor },
  });
}

/**
 * Logo del hotel (P1-2, handoff de demo) -- mismo patrón exacto que
 * updateBrandColor(): una URL en hotel_policies.extra_settings.logo_url, no
 * una columna nueva. Deliberadamente por URL, no por archivo: este proyecto
 * no tiene todavía un flujo de subida a Supabase Storage (Storage está en el
 * stack pero sin usar aún) -- construirlo sólo para esto sería una tarea de
 * infraestructura nueva, fuera del alcance "UI/UX de bajo riesgo" de esta
 * ronda. Un hotel sin logo (URL vacía) simplemente no muestra ninguno en
 * AppShell -- nunca un ícono roto.
 */
export async function updateBrandLogo(hotelId: string, logoUrl: string | null) {
  await requirePermission(hotelId, "hotel.settings.manage");
  if (logoUrl && !/^https?:\/\//i.test(logoUrl)) {
    throw new Error("La URL del logo debe empezar con http:// o https://.");
  }

  const supabase = await createClient();
  const { data: current, error: currentError } = await supabase
    .from("hotel_policies")
    .select("extra_settings")
    .eq("hotel_id", hotelId)
    .single();
  if (currentError) throw currentError;

  const nextSettings: Record<string, Json> = { ...((current.extra_settings as Record<string, Json>) ?? {}) };
  if (logoUrl) nextSettings.logo_url = logoUrl;
  else delete nextSettings.logo_url;

  const { error } = await supabase
    .from("hotel_policies")
    .update({ extra_settings: nextSettings })
    .eq("hotel_id", hotelId);
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "core",
    eventType: "hotel_policies.updated",
    entityType: "hotel_policies",
    entityId: hotelId,
    payload: { logo_url: logoUrl },
  });
}
