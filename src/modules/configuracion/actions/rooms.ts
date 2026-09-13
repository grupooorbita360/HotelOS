"use server";

import { requirePermission } from "@/lib/auth/permissions";
import { logTimelineEvent } from "@/lib/events/timeline";
import { createClient } from "@/lib/supabase/server";

export interface RoomTypeInput {
  name: string;
  code: string;
  capacityAdults: number;
  capacityChildren: number;
  acceptsPets: boolean;
  baseRate: number;
}

export async function createRoomType(hotelId: string, input: RoomTypeInput) {
  await requirePermission(hotelId, "hotel.settings.manage");
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("room_types")
    .insert({
      hotel_id: hotelId,
      name: input.name,
      code: input.code,
      capacity_adults: input.capacityAdults,
      capacity_children: input.capacityChildren,
      accepts_pets: input.acceptsPets,
      base_rate: input.baseRate,
    })
    .select()
    .single();
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "core",
    eventType: "room_type.created",
    entityType: "room_type",
    entityId: data.id,
    payload: { name: input.name, code: input.code },
  });

  return data;
}

export async function updateRoomType(hotelId: string, roomTypeId: string, input: RoomTypeInput) {
  await requirePermission(hotelId, "hotel.settings.manage");
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("room_types")
    .update({
      name: input.name,
      code: input.code,
      capacity_adults: input.capacityAdults,
      capacity_children: input.capacityChildren,
      accepts_pets: input.acceptsPets,
      base_rate: input.baseRate,
    })
    .eq("id", roomTypeId)
    .eq("hotel_id", hotelId)
    .select()
    .single();
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "core",
    eventType: "room_type.updated",
    entityType: "room_type",
    entityId: roomTypeId,
  });

  return data;
}

export async function setRoomTypeActive(hotelId: string, roomTypeId: string, isActive: boolean) {
  await requirePermission(hotelId, "hotel.settings.manage");
  const supabase = await createClient();

  const { error } = await supabase
    .from("room_types")
    .update({ is_active: isActive })
    .eq("id", roomTypeId)
    .eq("hotel_id", hotelId);
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "core",
    eventType: isActive ? "room_type.reactivated" : "room_type.deactivated",
    entityType: "room_type",
    entityId: roomTypeId,
  });
}

export interface RoomInput {
  code: string;
  roomTypeId: string;
  building?: string | null;
  bedType?: string | null;
}

export async function createRoom(hotelId: string, input: RoomInput) {
  await requirePermission(hotelId, "hotel.settings.manage");
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("rooms")
    .insert({
      hotel_id: hotelId,
      code: input.code,
      room_type_id: input.roomTypeId,
      building: input.building ?? null,
      bed_type: input.bedType ?? null,
    })
    .select()
    .single();
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "core",
    eventType: "room.created",
    entityType: "room",
    entityId: data.id,
    payload: { code: input.code, room_type_id: input.roomTypeId },
  });

  return data;
}

export async function updateRoom(hotelId: string, roomId: string, input: RoomInput) {
  await requirePermission(hotelId, "hotel.settings.manage");
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("rooms")
    .update({
      code: input.code,
      room_type_id: input.roomTypeId,
      building: input.building ?? null,
      bed_type: input.bedType ?? null,
    })
    .eq("id", roomId)
    .eq("hotel_id", hotelId)
    .select()
    .single();
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "core",
    eventType: "room.updated",
    entityType: "room",
    entityId: roomId,
  });

  return data;
}

export async function setRoomActive(hotelId: string, roomId: string, isActive: boolean) {
  await requirePermission(hotelId, "hotel.settings.manage");
  const supabase = await createClient();

  const { error } = await supabase
    .from("rooms")
    .update({ is_active: isActive })
    .eq("id", roomId)
    .eq("hotel_id", hotelId);
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "core",
    eventType: isActive ? "room.reactivated" : "room.deactivated",
    entityType: "room",
    entityId: roomId,
  });
}

export async function setRoomClean(hotelId: string, roomId: string, isClean: boolean) {
  await requirePermission(hotelId, "hotel.settings.manage");
  const supabase = await createClient();

  const { error } = await supabase
    .from("rooms")
    .update({ is_clean: isClean })
    .eq("id", roomId)
    .eq("hotel_id", hotelId);
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "core",
    eventType: isClean ? "room.marked_clean" : "room.marked_dirty",
    entityType: "room",
    entityId: roomId,
  });
}
