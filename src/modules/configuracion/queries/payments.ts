import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * Lectura propia de Configuración contra payment_methods/cash_settings
 * (Caja, 0046) -- regla 7: no se importa modules/caja/queries/payments.ts,
 * misma duplicación mínima ya aceptada para hotel_policies/reception_settings.
 */
export async function listPaymentMethodsForConfig(hotelId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("payment_methods")
    .select("id, name, type, is_active, requiere_referencia, requiere_validacion_manual, genera_comision, proveedor")
    .eq("hotel_id", hotelId)
    .order("name");
  if (error) throw error;
  return data;
}

export async function getCashSettingsForConfig(hotelId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("cash_settings")
    .select("usa_turnos_caja, requiere_facturacion_fiscal, rfc_hotel, regimen_fiscal")
    .eq("hotel_id", hotelId)
    .single();
  if (error) throw error;
  return data;
}
