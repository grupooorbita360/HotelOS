"use server";

import { requirePermission } from "@/lib/auth/permissions";
import { logTimelineEvent } from "@/lib/events/timeline";
import { createClient } from "@/lib/supabase/server";
import { getHotelIvaPorcentaje } from "@/modules/reservaciones/queries/policies";
import { calculateStayPrice } from "@/lib/pricing";

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
  nightlyRateOverride?: number;
  channel?: string;
}

/**
 * Cotizar (spec S15): crea el Lead (si no existe), la Cotización y su
 * OpcionCotizada. NUNCA compromete inventario -- eso solo ocurre al aceptar
 * la opción y pedir el Hold (ver actions/hold.ts).
 *
 * subtotal/taxes/total SIEMPRE se calculan aquí, en el servidor, a partir
 * de room_types.base_rate -- nunca se aceptan ya calculados del caller
 * (auditoría de precio, Tier 1, ver CLAUDE.md). nightlyRateOverride sigue
 * siendo la tarifa negociada que el staff puede capturar (UX existente),
 * pero pasa por calculateStayPrice() igual que la tarifa de lista, nunca
 * determina el total por su cuenta.
 */
export async function createQuote(input: CreateQuoteInput) {
  await requirePermission(input.hotelId, "reservations.create");
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("No hay sesión activa.");

  const { data: roomType, error: roomTypeError } = await supabase
    .from("room_types")
    .select("base_rate")
    .eq("id", input.roomTypeId)
    .eq("hotel_id", input.hotelId)
    .single();
  if (roomTypeError) throw roomTypeError;

  const nights = Math.max(
    1,
    Math.round((new Date(input.checkOut).getTime() - new Date(input.checkIn).getTime()) / (1000 * 60 * 60 * 24)),
  );
  const ivaPorcentaje = await getHotelIvaPorcentaje(input.hotelId);
  const { subtotal, taxes, total } = calculateStayPrice({
    baseRateNightly: roomType.base_rate,
    nights,
    nightlyRateOverride: input.nightlyRateOverride,
    ivaPorcentaje,
  });

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
      subtotal,
      taxes,
      total,
      created_by: user.id,
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
    payload: { lead_id: lead.id, quote_option_id: option.id, total },
  });

  return { leadId: lead.id as string, quoteId: quote.id as string, quoteOptionId: option.id as string };
}
