"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { assignRoomFromRack } from "@/modules/rack/actions/assignments";

function rackUrl(params: Record<string, string | undefined>) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) qs.set(k, v);
  }
  const s = qs.toString();
  return `/rack${s ? `?${s}` : ""}`;
}

/** Asigna una reserva confirmada sin habitación física desde la sección dedicada del Rack (no drag & drop). */
export async function submitAssignUnassigned(formData: FormData) {
  const hotelId = String(formData.get("hotelId"));
  const stayId = String(formData.get("stayId"));
  const roomId = String(formData.get("roomId"));
  const backParams = {
    start: String(formData.get("start") || ""),
    days: String(formData.get("days") || ""),
    tipo: String(formData.get("tipo") || ""),
    focus: String(formData.get("focus") || ""),
  };

  try {
    await assignRoomFromRack(hotelId, stayId, roomId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    redirect(rackUrl({ ...backParams, error: message }));
  }

  revalidatePath("/rack");
  redirect(rackUrl(backParams));
}
