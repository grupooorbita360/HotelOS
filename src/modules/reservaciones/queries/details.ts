import "server-only";
import { createClient } from "@/lib/supabase/server";

export async function getQuoteOptionDetails(hotelId: string, quoteOptionId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("quote_options")
    .select(
      "id, room_type_id, check_in, check_out, adults, children, has_pets, subtotal, taxes, total, room_types(name, description), quotes(lead_id, leads(guest_name, guest_email, guest_phone))",
    )
    .eq("id", quoteOptionId)
    .eq("hotel_id", hotelId)
    .single();

  if (error) throw error;
  return data;
}

/**
 * Contenido para el texto de cotización completo (P1-8, handoff de demo P1
 * Tanda 2): amenidades base del tipo (mismo nivel al que Reservaciones ya
 * cotiza -- sin resolver excepciones por habitación física, eso es de
 * Recepción/Habitaciones, aquí todavía no hay una habitación elegida) +
 * política de cancelación / cómo pagar del hotel, ambas texto libre en
 * hotel_policies.extra_settings (mismo patrón que brand_color/logo_url,
 * P1-2) -- no existía ningún campo real para esto, verificado contra el
 * esquema antes de escribir esto.
 */
export async function getQuoteCopyContext(hotelId: string, roomTypeId: string) {
  const supabase = await createClient();

  const { data: amenities, error: amenitiesError } = await supabase
    .from("tipo_habitacion_amenidad")
    .select("catalogo_amenidades(name)")
    .eq("hotel_id", hotelId)
    .eq("room_type_id", roomTypeId);
  if (amenitiesError) throw amenitiesError;

  const { data: policies, error: policiesError } = await supabase
    .from("hotel_policies")
    .select("extra_settings")
    .eq("hotel_id", hotelId)
    .single();
  if (policiesError) throw policiesError;

  const extra = (policies.extra_settings as {
    cancellation_policy_text?: string;
    payment_instructions_text?: string;
  } | null) ?? {};

  return {
    amenityNames: (amenities ?? [])
      .map((a) => (a.catalogo_amenidades as unknown as { name: string } | null)?.name)
      .filter((n): n is string => Boolean(n)),
    cancellationPolicyText: extra.cancellation_policy_text ?? null,
    paymentInstructionsText: extra.payment_instructions_text ?? null,
  };
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
