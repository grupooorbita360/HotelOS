import "server-only";
import { createClient } from "@/lib/supabase/server";
import { computeBusinessDate } from "@/lib/businessDate";

/**
 * Fuente única de "hoy" para un hotel: lee `hotels.timezone` (IANA, ej.
 * "America/Cancun") y devuelve la fecha calendario (YYYY-MM-DD) de ese
 * hotel en este instante. Nunca calcules "hoy" con `new Date()`/UTC o en
 * el navegador para decisiones operativas (llegadas, salidas, KPIs de
 * Rack, no-shows, etc.) -- usa siempre esta función. Ver CLAUDE.md.
 *
 * supabaseClient opcional (P2-2): un caller que corre dentro de after()
 * (next/server) no puede construir su propio cliente ahí -- cookies() no
 * se puede leer dentro de ese callback -- así que necesita inyectar uno ya
 * creado antes. Todo el resto de callers sigue sin pasar nada.
 */
export async function getHotelBusinessDate(
  hotelId: string,
  supabaseClient?: Awaited<ReturnType<typeof createClient>>,
): Promise<string> {
  const supabase = supabaseClient ?? (await createClient());
  const { data, error } = await supabase.from("hotels").select("timezone").eq("id", hotelId).single();
  if (error) throw error;
  return computeBusinessDate(data.timezone);
}
