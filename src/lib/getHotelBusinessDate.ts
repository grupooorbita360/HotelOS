import "server-only";
import { createClient } from "@/lib/supabase/server";
import { computeBusinessDate } from "@/lib/businessDate";

/**
 * Fuente única de "hoy" para un hotel: lee `hotels.timezone` (IANA, ej.
 * "America/Cancun") y devuelve la fecha calendario (YYYY-MM-DD) de ese
 * hotel en este instante. Nunca calcules "hoy" con `new Date()`/UTC o en
 * el navegador para decisiones operativas (llegadas, salidas, KPIs de
 * Rack, no-shows, etc.) -- usa siempre esta función. Ver CLAUDE.md.
 */
export async function getHotelBusinessDate(hotelId: string): Promise<string> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("hotels").select("timezone").eq("id", hotelId).single();
  if (error) throw error;
  return computeBusinessDate(data.timezone);
}
