"use server";

import { requirePermission } from "@/lib/auth/permissions";
import { logTimelineEvent } from "@/lib/events/timeline";
import { createClient } from "@/lib/supabase/server";

/**
 * Acepta una OpcionCotizada y pide el Hold real de inventario (spec S4-S8):
 * este es el momento exacto en que el sistema hace la verificación +
 * bloqueo atómico -- nunca antes. fechas/tipo se leen de la opción ya
 * persistida (nunca del cliente) para no confiar en datos que el navegador
 * pudiera alterar.
 *
 * holdMinutes explícito sigue permitido para un caller futuro que necesite
 * un valor puntual distinto (el parámetro de attempt_inventory_hold(),
 * 0016, siempre lo aceptó) -- pero si no se manda, ya no cae en el default
 * de 24h de SQL: se lee hotel_policies.hold_duration_minutes (P2-2),
 * configurable por hotel, mismo criterio de "la política vive en
 * hotel_policies, nunca hardcodeada" que el resto del proyecto.
 */
export async function createHoldFromQuoteOption(hotelId: string, quoteOptionId: string, holdMinutes?: number) {
  await requirePermission(hotelId, "reservations.create");
  const supabase = await createClient();

  const { data: option, error: optionError } = await supabase
    .from("quote_options")
    .select("id, room_type_id, check_in, check_out")
    .eq("id", quoteOptionId)
    .eq("hotel_id", hotelId)
    .single();
  if (optionError) throw optionError;

  let effectiveHoldMinutes = holdMinutes;
  if (effectiveHoldMinutes === undefined) {
    const { data: policies, error: policiesError } = await supabase
      .from("hotel_policies")
      .select("hold_duration_minutes")
      .eq("hotel_id", hotelId)
      .single();
    if (policiesError) throw policiesError;
    effectiveHoldMinutes = policies.hold_duration_minutes;
  }

  const { data: hold, error } = await supabase.rpc("attempt_inventory_hold", {
    p_hotel_id: hotelId,
    p_room_type_id: option.room_type_id,
    p_check_in: option.check_in,
    p_check_out: option.check_out,
    p_quote_option_id: option.id,
    p_hold_minutes: effectiveHoldMinutes,
  });
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "reservations",
    eventType: "inventory_hold.created",
    entityType: "inventory_hold",
    entityId: hold.id,
    payload: { quote_option_id: quoteOptionId, check_in: option.check_in, check_out: option.check_out },
  });

  return hold;
}

export async function releaseHold(hotelId: string, holdId: string) {
  await requirePermission(hotelId, "reservations.create");
  const supabase = await createClient();

  const { error } = await supabase.rpc("release_hold", { p_hold_id: holdId });
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "reservations",
    eventType: "inventory_hold.released",
    entityType: "inventory_hold",
    entityId: holdId,
  });
}
