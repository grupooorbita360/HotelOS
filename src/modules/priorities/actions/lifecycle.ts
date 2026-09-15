"use server";

import { requirePermission } from "@/lib/auth/permissions";
import { logTimelineEvent } from "@/lib/events/timeline";
import { createClient } from "@/lib/supabase/server";

async function currentActorId(supabase: Awaited<ReturnType<typeof createClient>>) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("No autenticado");
  return user.id;
}

/** El usuario ya vio la prioridad y la reconoce -- sigue sin asignar/atender. */
export async function acknowledgePriority(hotelId: string, priorityId: string) {
  await requirePermission(hotelId, "priorities.manage");
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("hotel_priorities")
    .update({ status: "ACKNOWLEDGED", acknowledged_at: new Date().toISOString() })
    .eq("id", priorityId)
    .eq("hotel_id", hotelId)
    .eq("status", "OPEN")
    .select()
    .single();
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
    .from("hotel_priorities")
    .update({ status: "ASSIGNED", assigned_to: assigneeUserId })
    .eq("id", priorityId)
    .eq("hotel_id", hotelId)
    .in("status", ["OPEN", "ACKNOWLEDGED"])
    .select()
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

  const { data, error } = await supabase
    .from("hotel_priorities")
    .update({ status: "IN_PROGRESS" })
    .eq("id", priorityId)
    .eq("hotel_id", hotelId)
    .in("status", ["OPEN", "ACKNOWLEDGED", "ASSIGNED"])
    .select()
    .single();
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
  const actorId = await currentActorId(supabase);

  const { data, error } = await supabase
    .from("hotel_priorities")
    .update({
      status: "RESOLVED",
      resolved_at: new Date().toISOString(),
      resolved_by: actorId,
      auto_resolved: false,
      resolution_reason: reason ?? null,
    })
    .eq("id", priorityId)
    .eq("hotel_id", hotelId)
    .not("status", "in", "(RESOLVED,DISMISSED)")
    .select()
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
 * Cierre manual SIN corregir la condición -- siempre requiere motivo
 * (reutiliza resolved_at/resolved_by/resolution_reason, ver comentario en
 * la migración 0036 sobre por qué no se duplicaron esas tres columnas).
 */
export async function dismissPriority(hotelId: string, priorityId: string, reason: string) {
  await requirePermission(hotelId, "priorities.manage");
  if (!reason.trim()) throw new Error("Descartar una prioridad requiere un motivo.");
  const supabase = await createClient();
  const actorId = await currentActorId(supabase);

  const { data, error } = await supabase
    .from("hotel_priorities")
    .update({
      status: "DISMISSED",
      resolved_at: new Date().toISOString(),
      resolved_by: actorId,
      auto_resolved: false,
      resolution_reason: reason,
    })
    .eq("id", priorityId)
    .eq("hotel_id", hotelId)
    .not("status", "in", "(RESOLVED,DISMISSED)")
    .select()
    .single();
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
