"use server";

import { redirect } from "next/navigation";
import { createQuote } from "@/modules/reservaciones/actions/quote";
import { createHoldFromQuoteOption, releaseHold } from "@/modules/reservaciones/actions/hold";
import { confirmReservation, cancelReservation } from "@/modules/reservaciones/actions/confirm";
import { registerPayment } from "@/modules/reservaciones/actions/payment";

export async function submitSearchAndQuote(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  // nightlyRate es la tarifa negociada que el staff puede capturar (UX
  // existente) -- ya no se hace aritmética aquí con ella: se reenvía como
  // override y createQuote() la resuelve contra room_types.base_rate en el
  // servidor (auditoría de precio, Tier 1, ver CLAUDE.md). Vacío = sin
  // override, usa la tarifa de lista.
  const nightlyRateRaw = formData.get("nightlyRate");
  const nightlyRateOverride =
    nightlyRateRaw !== null && nightlyRateRaw !== "" ? Number(nightlyRateRaw) : undefined;

  const { quoteOptionId } = await createQuote({
    hotelId,
    guestName: String(formData.get("guestName")),
    guestEmail: String(formData.get("guestEmail") || "") || undefined,
    guestPhone: String(formData.get("guestPhone") || "") || undefined,
    paxAdults: Number(formData.get("paxAdults") || 1),
    paxChildren: Number(formData.get("paxChildren") || 0),
    hasPets: formData.get("hasPets") === "on",
    roomTypeId: String(formData.get("roomTypeId")),
    checkIn: String(formData.get("checkIn")),
    checkOut: String(formData.get("checkOut")),
    nightlyRateOverride,
  });

  redirect(`/reservaciones?quoteOptionId=${quoteOptionId}`);
}

export async function submitCreateHold(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const quoteOptionId = String(formData.get("quoteOptionId"));

  let holdId: string;
  try {
    const hold = await createHoldFromQuoteOption(hotelId, quoteOptionId);
    holdId = hold.id;
  } catch (error) {
    // redirect() lanza internamente para interrumpir el render: nunca debe
    // quedar dentro del mismo try que puede lanzar el error real, o se
    // auto-capturaría aquí.
    if (error instanceof Error && error.message.includes("NO_AVAILABILITY")) {
      redirect(
        `/reservaciones?quoteOptionId=${quoteOptionId}&error=${encodeURIComponent(
          "Ya no hay disponibilidad para esas fechas: alguien más tomó la última unidad.",
        )}`,
      );
    }
    throw error;
  }
  redirect(`/reservaciones?holdId=${holdId}`);
}

export async function submitReleaseHold(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const holdId = String(formData.get("holdId"));
  await releaseHold(hotelId, holdId);
  redirect("/reservaciones");
}

export async function submitConfirmReservation(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const holdId = String(formData.get("holdId"));
  const channel = String(formData.get("channel") || "direct");

  // rateTotal ya no se lee del formulario: confirm_reservation_from_hold()
  // lo deriva siempre de quote_options.total vía el Hold que se está
  // confirmando, nunca de lo que el navegador reenvíe (auditoría de
  // precio, Tier 1, ver CLAUDE.md).
  const reservation = await confirmReservation({
    hotelId,
    holdId,
    primaryGuestName: String(formData.get("primaryGuestName")),
    primaryGuestEmail: String(formData.get("primaryGuestEmail") || "") || undefined,
    primaryGuestPhone: String(formData.get("primaryGuestPhone") || "") || undefined,
    channel,
  });

  const depositAmount = Number(formData.get("depositAmount") || 0);
  const depositMethod = String(formData.get("depositMethod") || "") as "card" | "transfer" | "";
  if (depositAmount > 0 && depositMethod) {
    await registerPayment({
      hotelId,
      reservationId: reservation.id,
      type: "deposit",
      amount: depositAmount,
      currency: String(formData.get("depositCurrency") || "MXN"),
      method: depositMethod,
      notes: String(formData.get("depositNotes") || "") || undefined,
    });
  }

  redirect(`/reservaciones?reservationId=${reservation.id}&confirmed=1`);
}

export async function submitCancelReservation(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const reservationId = String(formData.get("reservationId"));
  await cancelReservation(hotelId, reservationId, "Cancelada desde la interfaz de prueba");
  redirect("/reservaciones?cancelled=1");
}

export async function submitRegisterAdditionalPayment(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const reservationId = String(formData.get("reservationId"));
  const amount = Number(formData.get("amount") || 0);
  const method = String(formData.get("method")) as "card" | "transfer";
  const type = String(formData.get("type") || "installment") as "deposit" | "installment" | "full_payment" | "refund";

  try {
    await registerPayment({ hotelId, reservationId, type, amount, method });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    redirect(`/reservaciones?reservationId=${reservationId}&error=${encodeURIComponent(message)}`);
  }
  redirect(`/reservaciones?reservationId=${reservationId}`);
}
