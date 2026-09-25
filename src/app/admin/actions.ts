"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  createHotel,
  updateHotel,
  updateHotelLicense,
  assignHotelOwner,
  resendOwnerInvite,
  setFeatureOverride,
  removeFeatureOverride,
  resetDemoHotel,
} from "@/modules/platform/actions/hotels";

function tabUrl(tab: string, extra = "") {
  return `/admin?tab=${tab}${extra}`;
}

async function runOrError(tab: string, fn: () => Promise<unknown>) {
  let successMsg = "";
  try {
    const result = await fn();
    if (typeof result === "string") successMsg = result;
  } catch (error) {
    // No interceptar redirects de Next: deben propagarse.
    if (typeof error === "object" && error !== null && "digest" in error) throw error;
    console.error("[admin:runOrError]", error);   // el error real queda en logs de Vercel
    const raw = error instanceof Error ? error.message : JSON.stringify(error);
    redirect(tabUrl(tab, `&error=${encodeURIComponent(raw ?? "Error desconocido")}`));
  }
  revalidatePath("/admin");
  redirect(tabUrl(tab, successMsg ? `&msg=${encodeURIComponent(successMsg)}` : ""));
}

function nullableNum(formData: FormData, key: string): number | null {
  const raw = String(formData.get(key) ?? "").trim();
  if (raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function nullableDate(formData: FormData, key: string): string | null {
  const raw = String(formData.get(key) ?? "").trim();
  return raw === "" ? null : raw;
}

export async function submitCreateHotel(formData: FormData) {
  await runOrError("hoteles", () =>
    createHotel({
      name: String(formData.get("name")),
      slug: String(formData.get("slug")),
      plan: String(formData.get("plan")) as "basico" | "plus" | "pro",
      timezone: String(formData.get("timezone") || "America/Mexico_City"),
      ownerEmail: String(formData.get("ownerEmail")),
      ownerName: String(formData.get("ownerName") || "") || undefined,
    }),
  );
}

export async function submitUpdateHotel(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  await runOrError("hoteles", () =>
    updateHotel(hotelId, {
      name: String(formData.get("name")),
      timezone: String(formData.get("timezone") || "America/Mexico_City"),
    }),
  );
}

export async function submitUpdateHotelLicense(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  await runOrError("hoteles", () =>
    updateHotelLicense(hotelId, {
      plan: String(formData.get("plan")) as "basico" | "plus" | "pro",
      status: String(formData.get("status")) as "trial" | "active" | "suspended" | "canceled",
      roomsMax: nullableNum(formData, "roomsMax"),
      usersMax: nullableNum(formData, "usersMax"),
      expiresAt: nullableDate(formData, "expiresAt"),
      notes: String(formData.get("notes") || ""),
    }),
  );
}

export async function submitAssignHotelOwner(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  await runOrError("hoteles", () =>
    assignHotelOwner(hotelId, {
      ownerEmail: String(formData.get("ownerEmail")),
      ownerName: String(formData.get("ownerName") || "") || undefined,
    }),
  );
}

export async function submitResendOwnerInvite(formData: FormData) {
  await runOrError("hoteles", () => resendOwnerInvite(String(formData.get("ownerEmail"))));
}

export async function submitSetFeatureOverride(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const featureKey = String(formData.get("featureKey"));
  await runOrError("features", () =>
    setFeatureOverride(
      hotelId,
      featureKey,
      formData.get("enabled") === "on",
      String(formData.get("reason") || ""),
    ),
  );
}

export async function submitRemoveFeatureOverride(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const featureKey = String(formData.get("featureKey"));
  await runOrError("features", () => removeFeatureOverride(hotelId, featureKey));
}

export async function submitResetDemoHotel(formData: FormData) {
  if (formData.get("confirm") !== "on") {
    redirect(tabUrl("demo", `&error=${encodeURIComponent("Marca la confirmación para reiniciar la demo.")}`));
  }
  await runOrError("demo", async () => {
    const r = await resetDemoHotel();
    return `Demo reiniciada: ${r.stays_created} estancias, ${r.reservations_created} reservaciones, ` +
      `${r.transactions_created} transacciones y ${r.timeline_events_created} eventos de timeline.`;
  });
}
