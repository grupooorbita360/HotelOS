"use server";

import { redirect } from "next/navigation";
import {
  registerArrival,
  checkIn,
  assignRoomForCheckin,
  changeRoomWithAuthorization,
  deliverRoom,
  markNoShow,
  markWalked,
  undoWalked,
  attemptCheckOut,
} from "@/modules/recepcion/actions/lifecycle";
import { registerStayTransaction, voidStayTransaction } from "@/modules/recepcion/actions/account";
import {
  createGuestRequest,
  resolveGuestRequest,
  createStayIncident,
  resolveStayIncident,
  setDeliveredAsset,
} from "@/modules/recepcion/actions/service";
import { friendlyErrorMessage } from "@/lib/friendlyError";

function stayUrl(stayId: string, extra = "") {
  return `/recepcion?stayId=${stayId}${extra}`;
}

async function runOrError(stayId: string, fn: () => Promise<unknown>, redirectExtra = "") {
  try {
    await fn();
  } catch (error) {
    redirect(stayUrl(stayId, `&error=${encodeURIComponent(friendlyErrorMessage(error))}`));
  }
  redirect(stayUrl(stayId, redirectExtra));
}

export async function submitRegisterArrival(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const stayId = String(formData.get("stayId"));
  await runOrError(stayId, () => registerArrival(hotelId, stayId));
}

export async function submitCheckIn(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const stayId = String(formData.get("stayId"));
  await runOrError(stayId, () => checkIn(hotelId, stayId));
}

export async function submitAssignRoom(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const stayId = String(formData.get("stayId"));
  const roomId = String(formData.get("roomId"));
  await runOrError(stayId, () => assignRoomForCheckin(hotelId, stayId, roomId));
}

/** Flujo guiado: check-in + asignación (con upgrade opcional) en un solo paso. */
export async function submitCheckInWithRoom(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const stayId = String(formData.get("stayId"));
  const roomId = String(formData.get("roomId"));
  await runOrError(stayId, async () => {
    await checkIn(hotelId, stayId);
    await assignRoomForCheckin(hotelId, stayId, roomId);
  });
}

/** Cambio de habitación autorizado (upgrade/downgrade) para una estancia YA con check-in (P0-3/P0-5, handoff de demo). */
export async function submitChangeRoom(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const stayId = String(formData.get("stayId"));
  const roomId = String(formData.get("roomId"));
  const reason = String(formData.get("reason") || "") || undefined;
  const isCourtesy = formData.get("isCourtesy") === "on";
  const chargeAmountRaw = formData.get("chargeAmount");
  const compensationAmountRaw = formData.get("compensationAmount");

  try {
    await changeRoomWithAuthorization(hotelId, stayId, roomId, {
      reason,
      isCourtesy,
      chargeAmount: chargeAmountRaw ? Number(chargeAmountRaw) : undefined,
      compensationAmount: compensationAmountRaw ? Number(compensationAmountRaw) : undefined,
    });
  } catch (error) {
    // Se queda en el mismo paso (roomChangeStep=1) para que el formulario
    // siga visible al reintentar -- volver a "Cuenta de la estancia" sin
    // el error visible sería confuso.
    redirect(stayUrl(stayId, `&roomChangeStep=1&error=${encodeURIComponent(friendlyErrorMessage(error))}`));
  }
  redirect(stayUrl(stayId));
}

export async function submitDeliverRoom(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const stayId = String(formData.get("stayId"));
  await runOrError(stayId, () => deliverRoom(hotelId, stayId));
}

export async function submitMarkNoShow(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const stayId = String(formData.get("stayId"));
  const reason = String(formData.get("reason") || "") || undefined;
  await runOrError(stayId, () => markNoShow(hotelId, stayId, reason));
}

export async function submitMarkWalked(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const stayId = String(formData.get("stayId"));
  const reason = String(formData.get("reason") || "") || undefined;
  await runOrError(stayId, () => markWalked(hotelId, stayId, reason));
}

export async function submitUndoWalked(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const stayId = String(formData.get("stayId"));
  await runOrError(stayId, () => undoWalked(hotelId, stayId));
}

export async function submitCheckOut(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const stayId = String(formData.get("stayId"));
  await runOrError(stayId, () => attemptCheckOut(hotelId, stayId));
}

export async function submitRegisterTransaction(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const stayId = String(formData.get("stayId"));
  const type = String(formData.get("type")) as "charge" | "payment" | "refund";
  const rawAmount = Math.abs(Number(formData.get("amount") || 0));
  const amount = type === "payment" ? -rawAmount : rawAmount;
  const concept = String(formData.get("concept"));
  const method = (String(formData.get("method") || "") || undefined) as
    | "cash"
    | "card"
    | "transfer"
    | "other"
    | undefined;
  await runOrError(stayId, () => registerStayTransaction(hotelId, stayId, type, amount, concept, method));
}

export async function submitVoidTransaction(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const stayId = String(formData.get("stayId"));
  const transactionId = String(formData.get("transactionId"));
  await runOrError(stayId, () => voidStayTransaction(hotelId, transactionId, stayId, "Anulado desde Recepción"));
}

export async function submitCreateGuestRequest(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const stayId = String(formData.get("stayId"));
  const description = String(formData.get("description"));
  await runOrError(stayId, () => createGuestRequest(hotelId, stayId, description));
}

export async function submitResolveGuestRequest(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const stayId = String(formData.get("stayId"));
  const requestId = String(formData.get("requestId"));
  await runOrError(stayId, () => resolveGuestRequest(hotelId, requestId, stayId));
}

export async function submitCreateIncident(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const stayId = String(formData.get("stayId"));
  const type = String(formData.get("type")) as "maintenance" | "damage" | "complaint" | "other";
  const description = String(formData.get("description"));
  const severity = String(formData.get("severity") || "low") as "low" | "medium" | "high";
  await runOrError(stayId, () => createStayIncident(hotelId, stayId, type, description, severity));
}

export async function submitResolveIncident(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const stayId = String(formData.get("stayId"));
  const incidentId = String(formData.get("incidentId"));
  await runOrError(stayId, () => resolveStayIncident(hotelId, incidentId, stayId));
}

export async function submitSetAsset(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const stayId = String(formData.get("stayId"));
  const assetName = String(formData.get("assetName"));
  const delivered = formData.get("delivered") === "on";
  const returned = formData.get("returned") === "on";
  await runOrError(stayId, () => setDeliveredAsset(hotelId, stayId, assetName, delivered, returned));
}
