"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { registerPaymentWithMovements, registerRefund, validatePayment } from "@/modules/caja/actions/payments";
import { openShift, closeShift, registerCashExpense } from "@/modules/caja/actions/shifts";
import { registerStayAdjustment } from "@/modules/caja/actions/adjustments";
import type { PaymentMovementInput } from "@/modules/caja/actions/payments";

async function runOrError(hotelId: string, fn: () => Promise<unknown>, successPath: string) {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    revalidatePath("/caja");
    redirect(`/caja?error=${encodeURIComponent(message)}`);
  }
  revalidatePath("/caja");
  redirect(successPath);
}

export async function submitOpenShift(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const fondoInicial = Number(formData.get("fondoInicial") || 0);
  const notes = String(formData.get("notes") || "") || undefined;
  await runOrError(hotelId, () => openShift(hotelId, fondoInicial, notes), "/caja");
}

export async function submitCloseShift(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const shiftId = String(formData.get("shiftId"));
  const efectivoContado = Number(formData.get("efectivoContado") || 0);
  const notes = String(formData.get("notes") || "") || undefined;
  await runOrError(hotelId, () => closeShift(hotelId, shiftId, efectivoContado, notes), "/caja?closed=1");
}

export async function submitCashExpense(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const shiftId = String(formData.get("shiftId"));
  const amount = Number(formData.get("amount") || 0);
  const concept = String(formData.get("concept") || "");
  const category = String(formData.get("category") || "") || undefined;
  await runOrError(
    hotelId,
    () => registerCashExpense({ hotelId, shiftId, amount, concept, category }),
    "/caja",
  );
}

export async function submitRegisterPayment(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const reservationId = String(formData.get("reservationId"));
  const type = String(formData.get("type") || "deposit") as "deposit" | "installment" | "full_payment";
  const confirmOverpayment = formData.get("confirmOverpayment") === "on";

  const movements: PaymentMovementInput[] = [];
  for (let i = 0; i < 3; i++) {
    const methodId = String(formData.get(`method_${i}`) || "");
    const amount = Number(formData.get(`amount_${i}`) || 0);
    const reference = String(formData.get(`reference_${i}`) || "") || undefined;
    if (methodId && amount > 0) movements.push({ paymentMethodId: methodId, amount, reference });
  }

  if (movements.length === 0) {
    redirect(`/caja?reservationId=${reservationId}&error=${encodeURIComponent("Captura al menos un método de pago con monto.")}`);
  }

  await runOrError(
    hotelId,
    () => registerPaymentWithMovements({ hotelId, reservationId, type, movements, confirmOverpayment }),
    `/caja?reservationId=${reservationId}&paid=1`,
  );
}

export async function submitRegisterRefund(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const reservationId = String(formData.get("reservationId"));
  const originalPaymentId = String(formData.get("originalPaymentId") || "") || undefined;
  const amount = Number(formData.get("amount") || 0);
  const paymentMethodId = String(formData.get("paymentMethodId"));
  const reason = String(formData.get("reason") || "");

  await runOrError(
    hotelId,
    () => registerRefund({ hotelId, reservationId, originalPaymentId, amount, paymentMethodId, reason }),
    `/caja?reservationId=${reservationId}&refunded=1`,
  );
}

export async function submitValidatePayment(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const paymentId = String(formData.get("paymentId"));
  await runOrError(hotelId, () => validatePayment(hotelId, paymentId), "/caja?validated=1");
}

export async function submitStayAdjustment(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const stayId = String(formData.get("stayId"));
  const amount = Number(formData.get("amount") || 0);
  const concept = String(formData.get("concept") || "");
  await runOrError(hotelId, () => registerStayAdjustment(hotelId, stayId, amount, concept), "/caja?adjusted=1");
}
