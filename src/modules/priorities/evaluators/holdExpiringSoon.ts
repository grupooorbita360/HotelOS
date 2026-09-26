import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { DetectedOccurrence, EvaluatorContext } from "../types";

const EXPIRING_SOON_MINUTES = 15;

/**
 * HOLD_EXPIRING_SOON: un Hold activo (inventory_holds, 0016) tiene menos de
 * EXPIRING_SOON_MINUTES minutos para expirar sin haberse confirmado como
 * reserva. Reusa el mecanismo de Hold ya existente -- sólo lee expires_at,
 * no crea ningún bloqueo ni canal de aviso nuevo (P2-2). "Avisar al hotel"
 * se resuelve generando una hotel_priorities, igual que cualquier otra
 * regla del motor -- sin push/email/WhatsApp, fuera de alcance.
 */
export async function holdExpiringSoonEvaluator({ hotelId }: EvaluatorContext): Promise<DetectedOccurrence[]> {
  const supabase = await createClient();
  const now = new Date();
  const threshold = new Date(now.getTime() + EXPIRING_SOON_MINUTES * 60_000);

  const { data: holds, error } = await supabase
    .from("inventory_holds")
    .select(
      `id, expires_at, check_in, check_out,
       quote_options(quotes(leads(guest_name)))`,
    )
    .eq("hotel_id", hotelId)
    .eq("status", "active")
    .gt("expires_at", now.toISOString())
    .lte("expires_at", threshold.toISOString());
  if (error) throw error;

  return (holds ?? []).map((h): DetectedOccurrence => {
    const guestName =
      (
        h.quote_options as unknown as {
          quotes: { leads: { guest_name: string } | null } | null;
        } | null
      )?.quotes?.leads?.guest_name ?? "Huésped sin identificar";
    const expiresLabel = new Date(h.expires_at).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });

    return {
      referenceType: "inventory_hold",
      referenceId: h.id,
      dedupeKey: `HOLD_EXPIRING_SOON:${h.id}`,
      title: `Hold por expirar: ${guestName}`,
      message: `El Hold de ${guestName} (${h.check_in} a ${h.check_out}) expira a las ${expiresLabel} si no se confirma antes.`,
      actionLabel: "Revisar Hold",
      actionRoute: "/reservaciones",
      actionContext: { holdId: h.id },
    };
  });
}
