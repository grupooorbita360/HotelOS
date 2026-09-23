"use server";

import { revalidatePath } from "next/cache";
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
 *
 * P0-4 (handoff de demo): invalidateRackCache() sólo limpia el Map en
 * memoria del proceso que atendió ESTA petición -- en cualquier despliegue
 * con más de una instancia (el caso normal en producción), el siguiente
 * router.refresh() del cliente puede aterrizar en OTRA instancia que nunca
 * se enteró de la invalidación y sigue sirviendo su copia cacheada hasta
 * que expire el TTL de 45s. revalidatePath("/rack") es el mecanismo del
 * propio framework (no depende de qué instancia lo procesa) -- el flujo de
 * "Reservas sin asignar" (src/app/rack/actions.ts) ya lo llamaba; el drag &
 * drop nunca lo había hecho porque llama a esta función directo desde un
 * Client Component, sin pasar por un Server Action que lo agregara.
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
  revalidatePath("/rack");
  return data;
}
