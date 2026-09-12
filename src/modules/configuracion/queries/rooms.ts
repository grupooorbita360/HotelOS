import "server-only";
import { createClient } from "@/lib/supabase/server";

export async function listRoomTypes(hotelId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("room_types")
    .select("id, name, code, capacity_adults, capacity_children, accepts_pets, base_rate, is_active")
    .eq("hotel_id", hotelId)
    .order("name");
  if (error) throw error;
  return data;
}

export async function listRooms(hotelId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("rooms")
    .select("id, code, building, bed_type, is_active, is_clean, room_type_id, room_types(name)")
    .eq("hotel_id", hotelId)
    .order("code");
  if (error) throw error;
  return data;
}
