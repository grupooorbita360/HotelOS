"use server";

import { requirePermission } from "@/lib/auth/permissions";
import { logTimelineEvent } from "@/lib/events/timeline";
import { createClient } from "@/lib/supabase/server";

/**
 * Transiciones humanas de una prioridad. `requirePermission()` sigue
 * siendo la capa de UX (corta temprano con un mensaje claro) pero YA NO
 * es la única garantía: cada transición real ocurre dentro de una
 * función SECURITY DEFINER dedicada en Postgres (0037), que vuelve a
 * validar priorities.manage, la máquina de estados (OPEN/ACKNOWLEDGED/
 * ASSIGNED/IN_PROGRESS -> RESOLVED/DISMISSED, nunca al revés) y --en
 * assign-- que el usuario asignado pertenezca al mismo hotel. Si el RPC
 * lanza una excepción, el `await` revienta antes de llegar a
 * logTimelineEvent(): una transición fallida nunca genera timeline.
 */

export async function acknowledgePriority(hotelId: string, priorityId: string) {
  await requirePermission(hotelId, "priorities.manage");
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("acknowledge_hotel_priority", { p_priority_id: priorityId }).single();
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "priorities",
    eventType: "priority.acknowledged",
    entityType: "hotel_priority",
    entityId: priorityId,
  });

  return data;
}

export async function assignPriority(hotelId: string, priorityId: string, assigneeUserId: string) {
  await requirePermission(hotelId, "priorities.manage");
  const supabase = await createClient();

  const { data, error } = await supabase
    .rpc("assign_hotel_priority", { p_priority_id: priorityId, p_assignee_user_id: assigneeUserId })
    .single();
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "priorities",
    eventType: "priority.assigned",
    entityType: "hotel_priority",
    entityId: priorityId,
    payload: { assigned_to: assigneeUserId },
  });

  return data;
}

export async function startPriorityProgress(hotelId: string, priorityId: string) {
  await requirePermission(hotelId, "priorities.manage");
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("start_hotel_priority_progress", { p_priority_id: priorityId }).single();
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "priorities",
    eventType: "priority.in_progress",
    entityType: "hotel_priority",
    entityId: priorityId,
  });

  return data;
}

/** Cierre porque la condición se corrigió (nunca borra la fila -- ver CLAUDE.md). */
export async function resolvePriorityManually(hotelId: string, priorityId: string, reason?: string) {
  await requirePermission(hotelId, "priorities.manage");
  const supabase = await createClient();

  const { data, error } = await supabase
    .rpc("resolve_hotel_priority", { p_priority_id: priorityId, p_reason: reason ?? null })
    .single();
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "priorities",
    eventType: "priority.resolved",
    entityType: "hotel_priority",
    entityId: priorityId,
    payload: { auto_resolved: false, resolution_reason: reason ?? null },
  });

  return data;
}

/**
 * Cierre manual SIN corregir la condición -- siempre requiere motivo.
 * El `if (!reason.trim())` de aquí sigue siendo útil como UX (corta antes
 * de gastar un round-trip), pero la garantía real ahora la impone
 * dismiss_hotel_priority() en Postgres (DISMISS_REASON_REQUIRED) -- un
 * UPDATE directo o una llamada al RPC saltándose esta capa también sería
 * rechazado.
 */
export async function dismissPriority(hotelId: string, priorityId: string, reason: string) {
  await requirePermission(hotelId, "priorities.manage");
  if (!reason.trim()) throw new Error("Descartar una prioridad requiere un motivo.");
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("dismiss_hotel_priority", { p_priority_id: priorityId, p_reason: reason }).single();
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "priorities",
    eventType: "priority.dismissed",
    entityType: "hotel_priority",
    entityId: priorityId,
    payload: { resolution_reason: reason },
  });

  return data;
}
