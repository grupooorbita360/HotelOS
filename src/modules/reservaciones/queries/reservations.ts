import "server-only";
import { createClient } from "@/lib/supabase/server";

export interface ReservationFilters {
  status?: string;
  channel?: string;
}

export async function listReservations(hotelId: string, filters: ReservationFilters = {}) {
  const supabase = await createClient();
  let query = supabase
    .from("reservations")
    .select(
      "id, folio, primary_guest_name, status, channel, created_at, reservation_stays(check_in, check_out, room_type_id, room_types(name))",
    )
    .eq("hotel_id", hotelId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (filters.status) query = query.eq("status", filters.status);
  if (filters.channel) query = query.eq("channel", filters.channel);

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export async function listActiveHolds(hotelId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("inventory_holds")
    .select("id, check_in, check_out, expires_at, status, room_types(name)")
    .eq("hotel_id", hotelId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) throw error;
  return data;
}
