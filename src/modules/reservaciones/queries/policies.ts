import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * hotel_policies es propiedad de Reservaciones (ver CLAUDE.md), pero
 * Configuración ya tiene su propia lectura mínima de esta misma tabla
 * (regla 7: los módulos no se importan entre sí) -- esta es la lectura
 * mínima equivalente, sólo la columna que Reservaciones necesita para
 * desglosar (nunca calcular) el total de una cotización.
 */
export async function getHotelIvaPorcentaje(hotelId: string): Promise<number> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("hotel_policies")
    .select("iva_porcentaje")
    .eq("hotel_id", hotelId)
    .single();
  if (error) throw error;
  return data.iva_porcentaje;
}
