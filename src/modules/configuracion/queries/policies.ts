import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * hotel_policies y reception_settings son propiedad de Reservaciones/Recepción
 * respectivamente (ver CLAUDE.md). Configuración no importa las queries de
 * esos módulos (regla 7: los módulos no se importan entre sí) -- define su
 * propia lectura mínima contra las mismas tablas, a propósito.
 */
export async function getHotelPolicies(hotelId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("hotel_policies")
    .select(
      "hotel_id, requires_guarantee, guarantee_notes, allows_early_checkin, standard_checkin_time, standard_checkout_time, extra_settings",
    )
    .eq("hotel_id", hotelId)
    .single();
  if (error) throw error;
  return data;
}

export async function getReceptionSettings(hotelId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("reception_settings")
    .select("hotel_id, entrega_permite_saldo, checkin_permite_sucia, noshow_dias_gracia, bloquear_checkout_saldo")
    .eq("hotel_id", hotelId)
    .single();
  if (error) throw error;
  return data;
}
