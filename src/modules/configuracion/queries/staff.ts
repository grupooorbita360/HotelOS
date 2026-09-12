import "server-only";
import { createClient } from "@/lib/supabase/server";

export async function listHotelStaff(hotelId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("user_hotel_roles")
    .select("id, is_active, role_id, roles(name, description), profiles(id, full_name, email)")
    .eq("hotel_id", hotelId)
    .order("is_active", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}

/** Roles base de sistema (hotel_id is null): hotel_admin, front_desk, housekeeping, accounting. */
export async function listSystemRoles() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("roles")
    .select("id, name, description")
    .is("hotel_id", null)
    .order("name");
  if (error) throw error;
  return data;
}
