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

export async function assignRoom(hotelId: string, stayId: string, roomId: string) {
  await requirePermission(hotelId, "room.change");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("assign_room", { p_stay_id: stayId, p_room_id: roomId });
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

export async function attemptCheckOut(hotelId: string, stayId: string) {
  await requirePermission(hotelId, "checkout.perform");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("attempt_check_out", { p_stay_id: stayId });
  if (error) throw error;
  await logTimelineEvent({ hotelId, module: "front_desk", eventType: "stay.checked_out", entityType: "stay", entityId: stayId });
  return data;
}
