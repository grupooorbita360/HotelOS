"use server";

import { redirect } from "next/navigation";
import { createQuote } from "@/modules/reservaciones/actions/quote";
import { createHoldFromQuoteOption, releaseHold } from "@/modules/reservaciones/actions/hold";
import { confirmReservation, cancelReservation } from "@/modules/reservaciones/actions/confirm";
import { registerPayment } from "@/modules/reservaciones/actions/payment";
import { friendlyErrorMessage } from "@/lib/friendlyError";

export async function submitSearchAndQuote(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const checkIn = String(formData.get("checkIn"));
  const checkOut = String(formData.get("checkOut"));
  const guestName = String(formData.get("guestName") || "");
  const searchParams = new URLSearchParams({
    checkIn,
    checkOut,
    guestName,
    guestEmail: String(formData.get("guestEmail") || ""),
    guestPhone: String(formData.get("guestPhone") || ""),
    adults: String(formData.get("paxAdults") || "1"),
    children: String(formData.get("paxChildren") || "0"),
  });
  if (formData.get("hasPets") === "on") searchParams.set("hasPets", "on");

  // nightlyRate ya no es un campo libre (P0-7, handoff de demo): sólo se
  // lee si viene de los controles de "Descuento o cortesía", junto con el
  // motivo -- create_quote_option() (0048/0052) exige
  // has_permission(hotelId, 'reservations.discount') + motivo en cuanto
  // esto difiere de base_rate o se pide cortesía; sin override, usa
  // siempre la tarifa de lista.
  const nightlyRateRaw = formData.get("nightlyRate");
  const nightlyRateOverride =
    nightlyRateRaw !== null && nightlyRateRaw !== "" ? Number(nightlyRateRaw) : undefined;
  const isCourtesy = formData.get("isCourtesy") === "on";
  const discountReason = String(formData.get("discountReason") || "") || undefined;

  let quoteOptionId: string;
  try {
    const result = await createQuote({
      hotelId,
      guestName,
      guestEmail: String(formData.get("guestEmail") || "") || undefined,
      guestPhone: String(formData.get("guestPhone") || "") || undefined,
      paxAdults: Number(formData.get("paxAdults") || 1),
      paxChildren: Number(formData.get("paxChildren") || 0),
      hasPets: formData.get("hasPets") === "on",
      roomTypeId: String(formData.get("roomTypeId")),
      checkIn,
      checkOut,
      nightlyRateOverride,
      isCourtesy,
      discountReason,
    });
    quoteOptionId = result.quoteOptionId;
  } catch (error) {
    // redirect() lanza internamente para interrumpir el render: nunca debe
    // quedar dentro del mismo try que puede lanzar el error real, o se
    // auto-capturaría aquí (mismo cuidado que submitCreateHold).
    searchParams.set("error", friendlyErrorMessage(error));
    redirect(`/reservaciones?${searchParams.toString()}`);
  }

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
    redirect(`/reservaciones?quoteOptionId=${quoteOptionId}&error=${encodeURIComponent(friendlyErrorMessage(error))}`);
  }
  redirect(`/reservaciones?holdId=${holdId}`);
}

export async function submitReleaseHold(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const holdId = String(formData.get("holdId"));
  try {
    await releaseHold(hotelId, holdId);
  } catch (error) {
    redirect(`/reservaciones?holdId=${holdId}&error=${encodeURIComponent(friendlyErrorMessage(error))}`);
  }
  redirect("/reservaciones");
}

export async function submitConfirmReservation(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const holdId = String(formData.get("holdId"));
  const channel = String(formData.get("channel") || "direct");

  let reservationId: string;
  try {
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
    reservationId = reservation.id;
  } catch (error) {
    // Si el Hold ya expiró o se convirtió mientras el staff llenaba el
    // formulario, nunca debe llegar un error 500 crudo -- se vuelve al
    // mismo Hold con un mensaje claro (mismo cuidado de orden que
    // submitCreateHold: redirect() fuera del try que puede volver a lanzar).
    redirect(`/reservaciones?holdId=${holdId}&error=${encodeURIComponent(friendlyErrorMessage(error))}`);
  }

  // La reserva ya existe en este punto: un fallo del anticipo es un error
  // aparte, nunca debe mandar de vuelta a un Hold que ya se convirtió.
  const depositAmount = Number(formData.get("depositAmount") || 0);
  const depositMethod = String(formData.get("depositMethod") || "") as "card" | "transfer" | "";
  if (depositAmount > 0 && depositMethod) {
    try {
      await registerPayment({
        hotelId,
        reservationId,
        type: "deposit",
        amount: depositAmount,
        currency: String(formData.get("depositCurrency") || "MXN"),
        method: depositMethod,
        notes: String(formData.get("depositNotes") || "") || undefined,
      });
    } catch (error) {
      redirect(
        `/reservaciones?reservationId=${reservationId}&confirmed=1&error=${encodeURIComponent(
          `Reserva confirmada, pero el anticipo no se pudo registrar: ${friendlyErrorMessage(error)}`,
        )}`,
      );
    }
  }

  redirect(`/reservaciones?reservationId=${reservationId}&confirmed=1`);
}

export async function submitCancelReservation(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const reservationId = String(formData.get("reservationId"));
  try {
    await cancelReservation(hotelId, reservationId, "Cancelada desde la interfaz de prueba");
  } catch (error) {
    redirect(`/reservaciones?reservationId=${reservationId}&error=${encodeURIComponent(friendlyErrorMessage(error))}`);
  }
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
    redirect(`/reservaciones?reservationId=${reservationId}&error=${encodeURIComponent(friendlyErrorMessage(error))}`);
  }
  redirect(`/reservaciones?reservationId=${reservationId}`);
}
