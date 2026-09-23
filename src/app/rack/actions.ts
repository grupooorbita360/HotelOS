"use server";

import { redirect } from "next/navigation";
import { assignRoomFromRack } from "@/modules/rack/actions/assignments";
import { friendlyErrorMessage } from "@/lib/friendlyError";

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
    redirect(rackUrl({ ...backParams, error: friendlyErrorMessage(error) }));
  }

  // revalidatePath("/rack") ya corre dentro de assignRoomFromRack() (P0-4,
  // handoff de demo) -- no se duplica aquí.
  redirect(rackUrl(backParams));
}
