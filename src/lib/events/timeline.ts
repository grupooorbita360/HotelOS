import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/types/database.types";

/**
 * Registra un evento en la bitácora central (public.timeline_events).
 *
 * Todo módulo que ejecute una acción relevante para el negocio (crear una
 * reservación, hacer check-in, registrar un pago, cambiar una habitación...)
 * debe llamar a esto justo después de que la mutación tuvo éxito. Es el paso
 * "EVENTO REGISTRADO EN TIMELINE" del patrón transversal de HotelOS descrito
 * en CLAUDE.md: los KPIs y el estado operativo derivado se calculan a partir
 * de esta tabla, nunca capturados a mano.
 */
export type TimelineModule =
  | "core"
  | "reservations"
  | "rack"
  | "front_desk"
  | "housekeeping"
  | "billing"
  | "priorities"
  | "platform";

export interface LogTimelineEventInput {
  hotelId: string;
  module: TimelineModule;
  /** Formato "entidad.accion" en snake_case, ej. "reservation.created". */
  eventType: string;
  entityType: string;
  entityId?: string;
  payload?: Record<string, Json>;
}

export async function logTimelineEvent(input: LogTimelineEventInput) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error("logTimelineEvent requiere un usuario autenticado (actor_user_id).");
  }

  const { error } = await supabase.from("timeline_events").insert({
    hotel_id: input.hotelId,
    module: input.module,
    event_type: input.eventType,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    payload: input.payload ?? {},
    actor_user_id: user.id,
  });

  if (error) throw error;
}
