"use server";

import { requirePermission } from "@/lib/auth/permissions";
import { logTimelineEvent } from "@/lib/events/timeline";
import { createClient } from "@/lib/supabase/server";

/**
 * Desactiva una Habitacion física. Nunca hace el UPDATE directo: pasa por
 * deactivate_room() (0039), que exige motivo, corre el ImpactAnalysis
 * simplificado (SAFE/BLOQUEANTE contra asignaciones físicas activas) y
 * fija motivo_inactivacion/inactive_at/inactive_by siempre desde el
 * servidor.
 */
export async function deactivateRoom(hotelId: string, roomId: string, reason: string) {
  await requirePermission(hotelId, "hotel.settings.manage");
  if (!reason.trim()) throw new Error("Desactivar una habitación requiere un motivo.");
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("deactivate_room", { p_room_id: roomId, p_reason: reason }).single();
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "rooms",
    eventType: "room.deactivated",
    entityType: "room",
    entityId: roomId,
    payload: { reason },
  });

  return data;
}

export async function reactivateRoom(hotelId: string, roomId: string) {
  await requirePermission(hotelId, "hotel.settings.manage");
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("reactivate_room", { p_room_id: roomId }).single();
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "rooms",
    eventType: "room.reactivated",
    entityType: "room",
    entityId: roomId,
  });

  return data;
}

export async function updateRoomPhotos(hotelId: string, roomId: string, photos: string[]) {
  await requirePermission(hotelId, "hotel.settings.manage");
  const supabase = await createClient();

  const { error } = await supabase.from("rooms").update({ photos }).eq("id", roomId).eq("hotel_id", hotelId);
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "rooms",
    eventType: "room.photos_updated",
    entityType: "room",
    entityId: roomId,
    payload: { count: photos.length },
  });
}

/** Excepción de amenidad para una Habitacion concreta: AGREGA o EXCLUYE sobre lo heredado del TipoHabitacion. */
export async function setRoomAmenidadException(
  hotelId: string,
  roomId: string,
  amenidadId: string,
  tipo: "AGREGA" | "EXCLUYE",
) {
  await requirePermission(hotelId, "hotel.settings.manage");
  const supabase = await createClient();

  const { error } = await supabase
    .from("habitacion_amenidad_excepcion")
    .upsert(
      { hotel_id: hotelId, room_id: roomId, amenidad_id: amenidadId, tipo_excepcion: tipo },
      { onConflict: "room_id,amenidad_id" },
    );
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "rooms",
    eventType: "room.amenidad_exception_set",
    entityType: "room",
    entityId: roomId,
    payload: { amenidad_id: amenidadId, tipo_excepcion: tipo },
  });
}

/** Vuelve la amenidad a HEREDA (quita la excepción -- ya no hay fila). */
export async function clearRoomAmenidadException(hotelId: string, roomId: string, amenidadId: string) {
  await requirePermission(hotelId, "hotel.settings.manage");
  const supabase = await createClient();

  const { error } = await supabase
    .from("habitacion_amenidad_excepcion")
    .delete()
    .eq("hotel_id", hotelId)
    .eq("room_id", roomId)
    .eq("amenidad_id", amenidadId);
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "rooms",
    eventType: "room.amenidad_exception_cleared",
    entityType: "room",
    entityId: roomId,
    payload: { amenidad_id: amenidadId },
  });
}

export async function setRoomActivoException(hotelId: string, roomId: string, assetName: string, tipo: "AGREGA" | "EXCLUYE") {
  await requirePermission(hotelId, "hotel.settings.manage");
  const supabase = await createClient();

  const { error } = await supabase
    .from("habitacion_activo_excepcion")
    .upsert(
      { hotel_id: hotelId, room_id: roomId, asset_name: assetName, tipo_excepcion: tipo },
      { onConflict: "room_id,asset_name" },
    );
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "rooms",
    eventType: "room.activo_exception_set",
    entityType: "room",
    entityId: roomId,
    payload: { asset_name: assetName, tipo_excepcion: tipo },
  });
}

export async function clearRoomActivoException(hotelId: string, roomId: string, assetName: string) {
  await requirePermission(hotelId, "hotel.settings.manage");
  const supabase = await createClient();

  const { error } = await supabase
    .from("habitacion_activo_excepcion")
    .delete()
    .eq("hotel_id", hotelId)
    .eq("room_id", roomId)
    .eq("asset_name", assetName);
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "rooms",
    eventType: "room.activo_exception_cleared",
    entityType: "room",
    entityId: roomId,
    payload: { asset_name: assetName },
  });
}
