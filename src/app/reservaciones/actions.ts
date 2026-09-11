"use server";

import { redirect } from "next/navigation";
import { createQuote } from "@/modules/reservaciones/actions/quote";
import { createHoldFromQuoteOption, releaseHold } from "@/modules/reservaciones/actions/hold";
import { confirmReservation, cancelReservation } from "@/modules/reservaciones/actions/confirm";

const IVA = 0.16;

export async function submitSearchAndQuote(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const nightlyRate = Number(formData.get("nightlyRate"));
  const checkIn = String(formData.get("checkIn"));
  const checkOut = String(formData.get("checkOut"));
  const nights = Math.max(
    1,
    Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / (1000 * 60 * 60 * 24)),
  );
  const subtotal = Math.round(nightlyRate * nights * 100) / 100;
  const taxes = Math.round(subtotal * IVA * 100) / 100;
  const total = Math.round((subtotal + taxes) * 100) / 100;

  const { quoteOptionId } = await createQuote({
    hotelId,
    guestName: String(formData.get("guestName")),
    guestEmail: String(formData.get("guestEmail") || "") || undefined,
    guestPhone: String(formData.get("guestPhone") || "") || undefined,
    paxAdults: Number(formData.get("paxAdults") || 1),
    paxChildren: Number(formData.get("paxChildren") || 0),
    hasPets: formData.get("hasPets") === "on",
    roomTypeId: String(formData.get("roomTypeId")),
    checkIn,
    checkOut,
    subtotal,
    taxes,
    total,
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
  const rateTotal = Number(formData.get("rateTotal") || 0);

  await confirmReservation({
    hotelId,
    holdId,
    primaryGuestName: String(formData.get("primaryGuestName")),
    primaryGuestEmail: String(formData.get("primaryGuestEmail") || "") || undefined,
    primaryGuestPhone: String(formData.get("primaryGuestPhone") || "") || undefined,
    rateTotal,
  });

  redirect("/reservaciones?confirmed=1");
}

export async function submitCancelReservation(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const reservationId = String(formData.get("reservationId"));
  await cancelReservation(hotelId, reservationId, "Cancelada desde la interfaz de prueba");
  redirect("/reservaciones?cancelled=1");
}
