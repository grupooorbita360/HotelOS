"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  createHotel,
  updateHotelLicense,
  assignHotelOwner,
  resendOwnerInvite,
  setFeatureOverride,
  removeFeatureOverride,
} from "@/modules/platform/actions/hotels";

function tabUrl(tab: string, extra = "") {
  return `/admin?tab=${tab}${extra}`;
}

async function runOrError(tab: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    redirect(tabUrl(tab, `&error=${encodeURIComponent(message)}`));
  }
  revalidatePath("/admin");
  redirect(tabUrl(tab));
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
