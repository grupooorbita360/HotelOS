"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  createRoomType,
  updateRoomType,
  setRoomTypeActive,
  createRoom,
  updateRoom,
  setRoomActive,
  setRoomClean,
} from "@/modules/configuracion/actions/rooms";
import { updateHotelPolicies, updateReceptionSettings, updateBrandColor } from "@/modules/configuracion/actions/policies";
import { addStaffMember, changeStaffRole, setStaffActive } from "@/modules/configuracion/actions/staff";
import { createPaymentMethod, setPaymentMethodActive, updateCashSettings } from "@/modules/configuracion/actions/payments";

function tabUrl(tab: string, extra = "") {
  return `/configuracion?tab=${tab}${extra}`;
}

async function runOrError(tab: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    redirect(tabUrl(tab, `&error=${encodeURIComponent(message)}`));
  }
  revalidatePath("/configuracion");
  redirect(tabUrl(tab));
}

function num(formData: FormData, key: string) {
  return Number(formData.get(key) || 0);
}

export async function submitCreateRoomType(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  await runOrError("habitaciones", () =>
    createRoomType(hotelId, {
      name: String(formData.get("name")),
      code: String(formData.get("code")),
      capacityAdults: num(formData, "capacityAdults"),
      capacityChildren: num(formData, "capacityChildren"),
      acceptsPets: formData.get("acceptsPets") === "on",
      baseRate: num(formData, "baseRate"),
    }),
  );
}

export async function submitUpdateRoomType(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const roomTypeId = String(formData.get("roomTypeId"));
  await runOrError("habitaciones", () =>
    updateRoomType(hotelId, roomTypeId, {
      name: String(formData.get("name")),
      code: String(formData.get("code")),
      capacityAdults: num(formData, "capacityAdults"),
      capacityChildren: num(formData, "capacityChildren"),
      acceptsPets: formData.get("acceptsPets") === "on",
      baseRate: num(formData, "baseRate"),
    }),
  );
}

export async function submitSetRoomTypeActive(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const roomTypeId = String(formData.get("roomTypeId"));
  const isActive = formData.get("isActive") === "true";
  await runOrError("habitaciones", () => setRoomTypeActive(hotelId, roomTypeId, isActive));
}

export async function submitCreateRoom(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  await runOrError("habitaciones", () =>
    createRoom(hotelId, {
      code: String(formData.get("code")),
      roomTypeId: String(formData.get("roomTypeId")),
      building: (String(formData.get("building") || "") || null) as string | null,
      bedType: (String(formData.get("bedType") || "") || null) as string | null,
    }),
  );
}

export async function submitUpdateRoom(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const roomId = String(formData.get("roomId"));
  await runOrError("habitaciones", () =>
    updateRoom(hotelId, roomId, {
      code: String(formData.get("code")),
      roomTypeId: String(formData.get("roomTypeId")),
      building: (String(formData.get("building") || "") || null) as string | null,
      bedType: (String(formData.get("bedType") || "") || null) as string | null,
    }),
  );
}

export async function submitSetRoomActive(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const roomId = String(formData.get("roomId"));
  const isActive = formData.get("isActive") === "true";
  const reason = String(formData.get("reason") || "") || undefined;
  await runOrError("habitaciones", () => setRoomActive(hotelId, roomId, isActive, reason));
}

export async function submitSetRoomClean(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const roomId = String(formData.get("roomId"));
  const isClean = formData.get("isClean") === "true";
  await runOrError("habitaciones", () => setRoomClean(hotelId, roomId, isClean));
}

export async function submitUpdateHotelPolicies(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  await runOrError("politicas", () =>
    updateHotelPolicies(hotelId, {
      requiresGuarantee: formData.get("requiresGuarantee") === "on",
      guaranteeNotes: (String(formData.get("guaranteeNotes") || "") || null) as string | null,
      allowsEarlyCheckin: formData.get("allowsEarlyCheckin") === "on",
      standardCheckinTime: String(formData.get("standardCheckinTime")),
      standardCheckoutTime: String(formData.get("standardCheckoutTime")),
      ivaPorcentaje: Number(formData.get("ivaPorcentaje") || 0),
    }),
  );
}

export async function submitUpdateReceptionSettings(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  await runOrError("politicas", () =>
    updateReceptionSettings(hotelId, {
      entregaPermiteSaldo: formData.get("entregaPermiteSaldo") === "on",
      checkinPermiteSucia: formData.get("checkinPermiteSucia") === "on",
      noshowDiasGracia: num(formData, "noshowDiasGracia"),
      bloquearCheckoutSaldo: formData.get("bloquearCheckoutSaldo") === "on",
    }),
  );
}

export async function submitUpdateBrandColor(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const color = String(formData.get("brandColor") || "") || null;
  await runOrError("politicas", () => updateBrandColor(hotelId, color));
}

export async function submitAddStaffMember(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const email = String(formData.get("email"));
  const roleId = String(formData.get("roleId"));
  const fullName = String(formData.get("fullName") || "") || undefined;
  await runOrError("usuarios", () => addStaffMember(hotelId, email, roleId, fullName));
}

export async function submitChangeStaffRole(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const userHotelRoleId = String(formData.get("userHotelRoleId"));
  const newRoleId = String(formData.get("newRoleId"));
  await runOrError("usuarios", () => changeStaffRole(hotelId, userHotelRoleId, newRoleId));
}

export async function submitSetStaffActive(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const userHotelRoleId = String(formData.get("userHotelRoleId"));
  const isActive = formData.get("isActive") === "true";
  await runOrError("usuarios", () => setStaffActive(hotelId, userHotelRoleId, isActive));
}

export async function submitCreatePaymentMethod(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  await runOrError("caja", () =>
    createPaymentMethod(hotelId, {
      name: String(formData.get("name")),
      type: String(formData.get("type")) as "cash" | "card" | "transfer" | "other",
      requiereReferencia: formData.get("requiereReferencia") === "on",
      requiereValidacionManual: formData.get("requiereValidacionManual") === "on",
      generaComision: formData.get("generaComision") === "on",
      proveedor: String(formData.get("proveedor") || "") || undefined,
    }),
  );
}

export async function submitSetPaymentMethodActive(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const methodId = String(formData.get("methodId"));
  const isActive = formData.get("isActive") === "true";
  await runOrError("caja", () => setPaymentMethodActive(hotelId, methodId, isActive));
}

export async function submitUpdateCashSettings(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  await runOrError("caja", () =>
    updateCashSettings(hotelId, {
      usaTurnosCaja: formData.get("usaTurnosCaja") === "on",
      requiereFacturacionFiscal: formData.get("requiereFacturacionFiscal") === "on",
      rfcHotel: String(formData.get("rfcHotel") || "") || undefined,
      regimenFiscal: String(formData.get("regimenFiscal") || "") || undefined,
    }),
  );
}
