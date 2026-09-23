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
  nightlyRateOverride?: number;
  isCourtesy?: boolean;
  discountReason?: string;
  channel?: string;
}

/**
 * Cotizar (spec S15): crea el Lead (si no existe), la Cotización y su
 * OpcionCotizada. NUNCA compromete inventario -- eso solo ocurre al aceptar
 * la opción y pedir el Hold (ver actions/hold.ts).
 *
 * quote_options ya no acepta INSERT directo del cliente (auditoría de
 * precio, Tier 2, ver CLAUDE.md): create_quote_option() (0048/0052) es el
 * único camino de escritura y calcula subtotal/taxes/total server-side a
 * partir de room_types.base_rate + hotel_policies.iva_porcentaje.
 *
 * P0-7 (handoff de demo): nightlyRateOverride/isCourtesy ya no son un
 * campo libre -- la función SQL exige has_permission(hotelId,
 * 'reservations.discount') + discountReason no vacío en cuanto el override
 * difiere de base_rate o se pide cortesía; sin permiso, el RPC rechaza con
 * PERMISSION_DENIED antes de tocar nada. "Quién autorizó" es
 * quote_options.created_by (ya auth.uid()); motivo/monto/cortesía se
 * registran aquí en el payload del timeline, no en una columna nueva.
 */
export async function createQuote(input: CreateQuoteInput) {
  await requirePermission(input.hotelId, "reservations.create");
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("No hay sesión activa.");

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

  const { data: option, error: optionError } = await supabase.rpc("create_quote_option", {
    p_quote_id: quote.id,
    p_room_type_id: input.roomTypeId,
    p_check_in: input.checkIn,
    p_check_out: input.checkOut,
    p_adults: input.paxAdults,
    p_children: input.paxChildren,
    p_has_pets: input.hasPets,
    p_nightly_rate_override: input.nightlyRateOverride ?? null,
    p_is_courtesy: input.isCourtesy ?? false,
    p_discount_reason: input.discountReason ?? null,
  });
  if (optionError) throw optionError;

  const isDiscounted = Boolean(input.isCourtesy) || Boolean(input.discountReason);
  await logTimelineEvent({
    hotelId: input.hotelId,
    module: "reservations",
    eventType: isDiscounted ? "quote.discount_authorized" : "quote.issued",
    entityType: "quote",
    entityId: quote.id,
    payload: {
      lead_id: lead.id,
      quote_option_id: option.id,
      total: option.total,
      ...(isDiscounted && {
        is_courtesy: input.isCourtesy ?? false,
        nightly_rate_override: input.nightlyRateOverride ?? null,
        discount_reason: input.discountReason ?? null,
        authorized_by: user.id,
      }),
    },
  });

  return { leadId: lead.id as string, quoteId: quote.id as string, quoteOptionId: option.id as string };
}
