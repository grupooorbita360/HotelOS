"use server";

import { createClient } from "@/lib/supabase/server";

/**
 * Congela la configuración comercial de una reserva ya confirmada
 * (capacidad + amenidades marcadas es_promesa_comercial), una vez por
 * reserva, nunca por noche. Habitaciones sigue siendo dueño de QUÉ se
 * congela (congelar_configuracion_comercial(), 0039, SECURITY DEFINER);
 * este wrapper es el punto que Reservaciones invoca justo después de
 * confirmar (ver modules/reservaciones/actions/confirm.ts) -- Reservaciones
 * nunca importa código de Habitaciones directamente más allá de esta
 * función explícita (regla 7: los módulos no se importan entre sí para
 * lógica interna, pero un servicio de dominio expuesto a propósito para
 * otro módulo, como éste, es distinto de importar sus queries/acciones
 * internas).
 */
export async function congelarConfiguracionComercial(reservationId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("congelar_configuracion_comercial", { p_reservation_id: reservationId }).single();
  if (error) throw error;
  return data;
}
