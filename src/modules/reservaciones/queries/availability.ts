import "server-only";
import { createClient } from "@/lib/supabase/server";

export async function listRoomTypes(hotelId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("room_types")
    .select("id, name, code, capacity_adults, capacity_children, accepts_pets")
    .eq("hotel_id", hotelId)
    .eq("is_active", true)
    .order("name");

  if (error) throw error;
  return data;
}

export interface NightAvailability {
  stay_date: string;
  total_units: number;
  blocked_units: number;
  available_units: number;
}

/** Disponibilidad noche a noche. El mínimo de available_units en el rango determina si la estancia completa puede venderse (spec S8.1). */
export async function checkAvailability(
  hotelId: string,
  roomTypeId: string,
  checkIn: string,
  checkOut: string,
): Promise<NightAvailability[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("check_availability", {
    p_hotel_id: hotelId,
    p_room_type_id: roomTypeId,
    p_check_in: checkIn,
    p_check_out: checkOut,
  });

  if (error) throw error;
  return data ?? [];
}
