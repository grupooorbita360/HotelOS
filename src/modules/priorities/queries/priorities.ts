import "server-only";
import { createClient } from "@/lib/supabase/server";

export async function listHotelPriorities(hotelId: string, filters: { status?: string } = {}) {
  const supabase = await createClient();
  let query = supabase
    .from("hotel_priorities")
    .select(
      `id, rule_id, source_module, reference_type, reference_id, category, severity, priority_score,
       title, message, action_label, action_route, action_context, status, assigned_to, due_at,
       detected_at, acknowledged_at, resolved_at, resolved_by, auto_resolved, resolution_reason,
       dedupe_key, group_key`,
    )
    .eq("hotel_id", hotelId)
    .order("priority_score", { ascending: false })
    .order("detected_at", { ascending: false });

  if (filters.status) query = query.eq("status", filters.status);

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export async function getHotelPriority(hotelId: string, priorityId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("hotel_priorities")
    .select("*")
    .eq("hotel_id", hotelId)
    .eq("id", priorityId)
    .single();
  if (error) throw error;
  return data;
}
