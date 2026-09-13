"use server";

import { requirePermission } from "@/lib/auth/permissions";
import { logTimelineEvent } from "@/lib/events/timeline";
import { createClient } from "@/lib/supabase/server";
import { invalidateRackCache } from "@/modules/rack/queries/grid";

/**
 * Asigna o mueve (drag & drop vertical) una Estancia a una habitación física.
 * No es una función de dominio nueva: reusa assign_room() (0026, sin tocar),
 * la misma que ya usa el flujo de Recepción para el caso "asignar
 * equivalente" -- el Rack no reimplementa la validación de tipo/ocupación,
 * solo la invoca. RLS + has_permission('room.change') dentro de la función
 * son la barrera real; requirePermission() aquí es solo la capa de UX
 * (mismo patrón que el resto del proyecto).
 */
export async function assignRoomFromRack(hotelId: string, stayId: string, newRoomId: string, reason?: string) {
  await requirePermission(hotelId, "room.change");
  const supabase = await createClient();

  const { data: previous } = await supabase
    .from("room_assignments")
    .select("room_id, rooms(code)")
    .eq("stay_id", stayId)
    .is("released_at", null)
    .maybeSingle();

  const { data, error } = await supabase.rpc("assign_room", { p_stay_id: stayId, p_room_id: newRoomId });
  if (error) throw new Error(error.message);

  await logTimelineEvent({
    hotelId,
    module: "rack",
    eventType: previous ? "room.reassigned_from_rack" : "room.assigned_from_rack",
    entityType: "stay",
    entityId: stayId,
    payload: {
      previous_room_id: previous?.room_id ?? null,
      previous_room_code: (previous?.rooms as unknown as { code: string } | null)?.code ?? null,
      new_room_id: newRoomId,
      reason: reason ?? null,
    },
  });

  invalidateRackCache(hotelId);
  return data;
}
