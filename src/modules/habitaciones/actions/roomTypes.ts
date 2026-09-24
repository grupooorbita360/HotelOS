"use server";

import { requirePermission } from "@/lib/auth/permissions";
import { logTimelineEvent } from "@/lib/events/timeline";
import { createClient } from "@/lib/supabase/server";

export interface RoomTypeCapacityInput {
  baseAdults: number;
  maxAdults: number;
  maxChildren: number;
  maxPets: number;
}

/**
 * Cambia la capacidad explícita de un TipoHabitacion. Nunca hace el UPDATE
 * directo: pasa por update_room_type_capacity() (0039), que corre el
 * ImpactAnalysis simplificado (SAFE/BLOQUEANTE) contra reservas futuras
 * confirmadas antes de aceptar el cambio.
 */
export async function updateRoomTypeCapacity(hotelId: string, roomTypeId: string, input: RoomTypeCapacityInput) {
  await requirePermission(hotelId, "hotel.settings.manage");
  const supabase = await createClient();

  const { data, error } = await supabase
    .rpc("update_room_type_capacity", {
      p_room_type_id: roomTypeId,
      p_base_adults: input.baseAdults,
      p_max_adults: input.maxAdults,
      p_max_children: input.maxChildren,
      p_max_pets: input.maxPets,
    })
    .single();
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "rooms",
    eventType: "room_type.capacity_updated",
    entityType: "room_type",
    entityId: roomTypeId,
    payload: { ...input },
  });

  return data;
}

export async function createCatalogoAmenidad(hotelId: string, name: string, esPromesaComercial: boolean) {
  await requirePermission(hotelId, "hotel.settings.manage");
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("catalogo_amenidades")
    .insert({ hotel_id: hotelId, name, es_promesa_comercial: esPromesaComercial })
    .select()
    .single();
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "rooms",
    eventType: "amenidad.created",
    entityType: "catalogo_amenidad",
    entityId: data.id,
    payload: { name, es_promesa_comercial: esPromesaComercial },
  });

  return data;
}

/** Asigna una amenidad como base (HEREDA) de un TipoHabitacion. */
export async function addRoomTypeAmenidad(hotelId: string, roomTypeId: string, amenidadId: string) {
  await requirePermission(hotelId, "hotel.settings.manage");
  const supabase = await createClient();

  const { error } = await supabase
    .from("tipo_habitacion_amenidad")
    .insert({ hotel_id: hotelId, room_type_id: roomTypeId, amenidad_id: amenidadId });
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "rooms",
    eventType: "room_type.amenidad_added",
    entityType: "room_type",
    entityId: roomTypeId,
    payload: { amenidad_id: amenidadId },
  });
}

export async function removeRoomTypeAmenidad(hotelId: string, roomTypeId: string, amenidadId: string) {
  await requirePermission(hotelId, "hotel.settings.manage");
  const supabase = await createClient();

  const { error } = await supabase
    .from("tipo_habitacion_amenidad")
    .delete()
    .eq("hotel_id", hotelId)
    .eq("room_type_id", roomTypeId)
    .eq("amenidad_id", amenidadId);
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "rooms",
    eventType: "room_type.amenidad_removed",
    entityType: "room_type",
    entityId: roomTypeId,
    payload: { amenidad_id: amenidadId },
  });
}

/** Activo base (HEREDA) de un TipoHabitacion -- nombre libre contra hotel_policies.checkin_assets, sin FK (ver 0039). */
export async function addRoomTypeActivo(hotelId: string, roomTypeId: string, assetName: string) {
  await requirePermission(hotelId, "hotel.settings.manage");
  const supabase = await createClient();

  const { error } = await supabase
    .from("tipo_habitacion_activo")
    .insert({ hotel_id: hotelId, room_type_id: roomTypeId, asset_name: assetName });
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "rooms",
    eventType: "room_type.activo_added",
    entityType: "room_type",
    entityId: roomTypeId,
    payload: { asset_name: assetName },
  });
}

export async function removeRoomTypeActivo(hotelId: string, roomTypeId: string, assetName: string) {
  await requirePermission(hotelId, "hotel.settings.manage");
  const supabase = await createClient();

  const { error } = await supabase
    .from("tipo_habitacion_activo")
    .delete()
    .eq("hotel_id", hotelId)
    .eq("room_type_id", roomTypeId)
    .eq("asset_name", assetName);
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "rooms",
    eventType: "room_type.activo_removed",
    entityType: "room_type",
    entityId: roomTypeId,
    payload: { asset_name: assetName },
  });
}
