"use server";

import { requirePermission } from "@/lib/auth/permissions";
import { logTimelineEvent } from "@/lib/events/timeline";
import { createClient } from "@/lib/supabase/server";

export interface CreateQuoteInput {
  hotelId: string;
  guestName: string;
  guestEmail?: string;
  guestPhone?: string;
  paxAdults: number;
  paxChildren: number;
  hasPets: boolean;
  roomTypeId: string;
  checkIn: string;
  checkOut: string;
  subtotal: number;
  taxes: number;
  total: number;
  channel?: string;
}

/**
 * Cotizar (spec S15): crea el Lead (si no existe), la Cotización y su
 * OpcionCotizada. NUNCA compromete inventario -- eso solo ocurre al aceptar
 * la opción y pedir el Hold (ver actions/hold.ts).
 */
export async function createQuote(input: CreateQuoteInput) {
  await requirePermission(input.hotelId, "reservations.create");
  const supabase = await createClient();

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .insert({
      hotel_id: input.hotelId,
      guest_name: input.guestName,
      guest_email: input.guestEmail || null,
      guest_phone: input.guestPhone || null,
      pax_adults: input.paxAdults,
      pax_children: input.paxChildren,
      has_pets: input.hasPets,
      desired_check_in: input.checkIn,
      desired_check_out: input.checkOut,
      desired_room_type_id: input.roomTypeId,
      channel: input.channel ?? "direct",
      status: "quoted",
    })
    .select("id")
    .single();
  if (leadError) throw leadError;

  const priceValidUntil = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

  const { data: quote, error: quoteError } = await supabase
    .from("quotes")
    .insert({
      hotel_id: input.hotelId,
      lead_id: lead.id,
      price_valid_until: priceValidUntil,
    })
    .select("id")
    .single();
  if (quoteError) throw quoteError;

  const { data: option, error: optionError } = await supabase
    .from("quote_options")
    .insert({
      hotel_id: input.hotelId,
      quote_id: quote.id,
      room_type_id: input.roomTypeId,
      check_in: input.checkIn,
      check_out: input.checkOut,
      adults: input.paxAdults,
      children: input.paxChildren,
      has_pets: input.hasPets,
      subtotal: input.subtotal,
      taxes: input.taxes,
      total: input.total,
    })
    .select("id")
    .single();
  if (optionError) throw optionError;

  await logTimelineEvent({
    hotelId: input.hotelId,
    module: "reservations",
    eventType: "quote.issued",
    entityType: "quote",
    entityId: quote.id,
    payload: { lead_id: lead.id, quote_option_id: option.id, total: input.total },
  });

  return { leadId: lead.id as string, quoteId: quote.id as string, quoteOptionId: option.id as string };
}
