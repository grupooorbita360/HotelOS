"use server";

import { requirePermission } from "@/lib/auth/permissions";
import { logTimelineEvent } from "@/lib/events/timeline";
import { createClient } from "@/lib/supabase/server";

/**
 * Transiciones del ciclo de vida de la Estancia (spec Recepcion). Cada
 * funcion delega la mutacion real a la funcion SQL correspondiente
 * (SECURITY DEFINER, valida has_permission() internamente porque las
 * tablas de Recepcion no exponen INSERT/UPDATE directo al cliente) y aqui
 * solo se agrega la capa de UX (requirePermission) + el evento en timeline.
 */

export async function registerArrival(hotelId: string, stayId: string) {
  await requirePermission(hotelId, "checkin.perform");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("register_arrival", { p_stay_id: stayId });
  if (error) throw error;
  await logTimelineEvent({ hotelId, module: "front_desk", eventType: "stay.arrived", entityType: "stay", entityId: stayId });
  return data;
}

export async function checkIn(hotelId: string, stayId: string) {
  await requirePermission(hotelId, "checkin.perform");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("check_in", { p_stay_id: stayId });
  if (error) throw error;
  await logTimelineEvent({ hotelId, module: "front_desk", eventType: "stay.checked_in", entityType: "stay", entityId: stayId });
  return data;
}

/**
 * Asigna una habitación permitiendo upgrade (0032, `assign_room_for_checkin`):
 * si el room_type de la habitación elegida es distinto al vendido y su
 * tarifa base es mayor, la función SQL cobra la diferencia x noches como un
 * cargo real en la cuenta -- no hay lógica de precio aquí, sólo se delega.
 */
export async function assignRoomForCheckin(hotelId: string, stayId: string, roomId: string) {
  await requirePermission(hotelId, "room.change");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("assign_room_for_checkin", { p_stay_id: stayId, p_room_id: roomId });
  if (error) throw error;
  await logTimelineEvent({
    hotelId,
    module: "front_desk",
    eventType: "stay.room_assigned",
    entityType: "stay",
    entityId: stayId,
    payload: { room_id: roomId },
  });
  return data;
}

export interface ChangeRoomAuthorizationInput {
  reason?: string;
  isCourtesy?: boolean;
  chargeAmount?: number;
  compensationAmount?: number;
}

/**
 * Cambio de habitación autorizado para una estancia YA asignada (P0-3/P0-5,
 * handoff de demo) -- a diferencia de assignRoomForCheckin() (0032, sólo al
 * momento del check-in) y de assignRoomFromRack() (Rack, sólo mismo tipo),
 * esta sí permite upgrade/downgrade después del check-in vía
 * change_room_with_authorization() (0051): la función SQL determina
 * upgrade/downgrade comparando tarifas, exige motivo salvo para un cambio
 * equivalente, y cobra/compensa vía register_stay_transaction() (0026) --
 * no depende de que Caja (0046) esté desplegada.
 */
export async function changeRoomWithAuthorization(hotelId: string, stayId: string, roomId: string, input: ChangeRoomAuthorizationInput) {
  await requirePermission(hotelId, "room.change");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("change_room_with_authorization", {
    p_stay_id: stayId,
    p_new_room_id: roomId,
    p_reason: input.reason ?? null,
    p_is_courtesy: input.isCourtesy ?? false,
    p_charge_amount: input.chargeAmount ?? null,
    p_compensation_amount: input.compensationAmount ?? null,
  });
  if (error) throw error;
  await logTimelineEvent({
    hotelId,
    module: "front_desk",
    eventType: "stay.room_changed",
    entityType: "stay",
    entityId: stayId,
    payload: {
      new_room_id: roomId,
      reason: input.reason ?? null,
      is_courtesy: input.isCourtesy ?? false,
      charge_amount: input.chargeAmount ?? null,
      compensation_amount: input.compensationAmount ?? null,
    },
  });
  return data;
}

export async function deliverRoom(hotelId: string, stayId: string) {
  await requirePermission(hotelId, "checkin.perform");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("deliver_room", { p_stay_id: stayId });
  if (error) throw error;
  await logTimelineEvent({ hotelId, module: "front_desk", eventType: "stay.room_delivered", entityType: "stay", entityId: stayId });
  return data;
}

export async function markNoShow(hotelId: string, stayId: string, reason?: string) {
  await requirePermission(hotelId, "checkin.perform");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("mark_no_show", { p_stay_id: stayId, p_reason: reason ?? null });
  if (error) throw error;
  await logTimelineEvent({
    hotelId,
    module: "front_desk",
    eventType: "stay.no_show",
    entityType: "stay",
    entityId: stayId,
    payload: { reason: reason ?? null },
  });
  return data;
}

export async function markWalked(hotelId: string, stayId: string, reason?: string) {
  await requirePermission(hotelId, "checkin.perform");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("mark_walked", { p_stay_id: stayId, p_reason: reason ?? null });
  if (error) throw error;
  await logTimelineEvent({
    hotelId,
    module: "front_desk",
    eventType: "stay.walked",
    entityType: "stay",
    entityId: stayId,
    payload: { reason: reason ?? null },
  });
  return data;
}

/** Deshace mark_walked() (P1-4, handoff de demo P1 Tanda 2) -- ver undo_walked() (0056). */
export async function undoWalked(hotelId: string, stayId: string, reason?: string) {
  await requirePermission(hotelId, "checkin.perform");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("undo_walked", { p_stay_id: stayId, p_reason: reason ?? null });
  if (error) throw error;
  await logTimelineEvent({
    hotelId,
    module: "front_desk",
    eventType: "stay.walked_undone",
    entityType: "stay",
    entityId: stayId,
    payload: { reason: reason ?? null },
  });
  return data;
}

export async function attemptCheckOut(hotelId: string, stayId: string) {
  await requirePermission(hotelId, "checkout.perform");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("attempt_check_out", { p_stay_id: stayId });
  if (error) throw error;
  await logTimelineEvent({ hotelId, module: "front_desk", eventType: "stay.checked_out", entityType: "stay", entityId: stayId });
  return data;
}
