import "server-only";
import { createClient } from "@/lib/supabase/server";

export async function getQuoteOptionDetails(hotelId: string, quoteOptionId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("quote_options")
    .select(
      "id, room_type_id, check_in, check_out, adults, children, has_pets, subtotal, taxes, total, room_types(name), quotes(lead_id, leads(guest_name, guest_email, guest_phone))",
    )
    .eq("id", quoteOptionId)
    .eq("hotel_id", hotelId)
    .single();

  if (error) throw error;
  return data;
}

export async function getReservationDetails(hotelId: string, reservationId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("reservations")
    .select(
      `id, folio, primary_guest_name, primary_guest_email, primary_guest_phone, status, channel,
       cancelled_at, cancellation_reason, created_at,
       reservation_stays(check_in, check_out, adults, children, has_pets, rate_total, notes_internal, room_types(name)),
       guarantees(type, amount, currency, status),
       payments(id, type, amount, currency, method, status, created_at)`,
    )
    .eq("id", reservationId)
    .eq("hotel_id", hotelId)
    .single();

  if (error) throw error;
  return data;
}

export async function getHoldDetails(hotelId: string, holdId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("inventory_holds")
    .select(
      "id, status, check_in, check_out, expires_at, room_types(name), quote_options(total, quotes(leads(guest_name, guest_email, guest_phone)))",
    )
    .eq("id", holdId)
    .eq("hotel_id", hotelId)
    .single();

  if (error) throw error;
  return data;
}
