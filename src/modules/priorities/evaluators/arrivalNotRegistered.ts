import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { DetectedOccurrence, EvaluatorContext } from "../types";

/**
 * ARRIVAL_NOT_REGISTERED: una Estancia sigue en 'expected' (nunca se llamó
 * register_arrival(), 0026) y su fecha de check-in ya quedó atrás según la
 * fecha operativa del hotel. No implica no-show (esa es una decisión
 * separada, con su propio periodo de gracia -- mark_no_show(), 0035): esto
 * sólo señala que nadie ha actuado todavía sobre una llegada que ya
 * debería haber pasado.
 *
 * Se determina enteramente con datos que ya existen -- stays.status +
 * reservation_stays.check_in -- sin Housekeeping, sin Caja, sin tocar
 * ninguna regla de Reservaciones/Recepción.
 */
export async function arrivalNotRegisteredEvaluator({
  hotelId,
  businessDate,
  supabaseClient,
}: EvaluatorContext): Promise<DetectedOccurrence[]> {
  const supabase = supabaseClient ?? (await createClient());

  const { data: stays, error } = await supabase
    .from("stays")
    .select(
      `id, status,
       reservation_stays(check_in, reservations(folio, primary_guest_name))`,
    )
    .eq("hotel_id", hotelId)
    .eq("status", "expected");
  if (error) throw error;

  return (stays ?? [])
    .map((s) => {
      const rs = s.reservation_stays as unknown as {
        check_in: string;
        reservations: { folio: string; primary_guest_name: string } | null;
      } | null;
      return { stay: s, rs };
    })
    .filter(({ rs }) => rs && rs.check_in < businessDate)
    .map(({ stay, rs }): DetectedOccurrence => {
      const guestName = rs?.reservations?.primary_guest_name ?? "Huésped";
      const folio = rs?.reservations?.folio ?? "—";
      return {
        referenceType: "stay",
        referenceId: stay.id,
        dedupeKey: `ARRIVAL_NOT_REGISTERED:${stay.id}`,
        title: `Llegada no registrada: ${guestName}`,
        message: `${guestName} (folio ${folio}) tenía check-in el ${rs?.check_in} y todavía no se registró su llegada.`,
        actionLabel: "Revisar llegada",
        actionRoute: "/recepcion",
        actionContext: { stayId: stay.id },
      };
    });
}
