import "server-only";
import { createClient } from "@/lib/supabase/server";

export interface LeadFilters {
  status?: string;
}

export async function listLeads(hotelId: string, filters: LeadFilters = {}) {
  const supabase = await createClient();
  let query = supabase
    .from("leads")
    .select("id, guest_name, guest_email, guest_phone, status, channel, desired_check_in, desired_check_out, created_at")
    .eq("hotel_id", hotelId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (filters.status) query = query.eq("status", filters.status);

  const { data, error } = await query;
  if (error) throw error;
  return data;
}
