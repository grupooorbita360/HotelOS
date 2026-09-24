import "server-only";
import { createClient } from "@/lib/supabase/server";

export interface CashSettings {
  usaTurnosCaja: boolean;
  requiereFacturacionFiscal: boolean;
  rfcHotel: string | null;
  regimenFiscal: string | null;
}

export async function getCashSettings(hotelId: string): Promise<CashSettings> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("cash_settings")
    .select("usa_turnos_caja, requiere_facturacion_fiscal, rfc_hotel, regimen_fiscal")
    .eq("hotel_id", hotelId)
    .single();
  if (error) throw error;

  return {
    usaTurnosCaja: data.usa_turnos_caja,
    requiereFacturacionFiscal: data.requiere_facturacion_fiscal,
    rfcHotel: data.rfc_hotel,
    regimenFiscal: data.regimen_fiscal,
  };
}
