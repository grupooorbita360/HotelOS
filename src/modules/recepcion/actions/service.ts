"use server";

import { requirePermission } from "@/lib/auth/permissions";
import { logTimelineEvent } from "@/lib/events/timeline";
import { createClient } from "@/lib/supabase/server";

/**
 * SolicitudHuesped, IncidenciaEstancia y ActivosEntregados no pasan por
 * funciones SQL: sus tablas ya tienen politicas RLS con has_permission()
 * directas (ver 0025), asi que estas acciones mutan la tabla normalmente,
 * igual que cualquier otro modulo (requirePermission -> mutacion -> evento).
 */

export async function createGuestRequest(hotelId: string, stayId: string, description: string) {
  await requirePermission(hotelId, "checkin.perform");
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("guest_requests")
    .insert({ hotel_id: hotelId, stay_id: stayId, description })
    .select()
    .single();
  if (error) throw error;
  await logTimelineEvent({ hotelId, module: "front_desk", eventType: "guest_request.created", entityType: "stay", entityId: stayId });
  return data;
}

export async function resolveGuestRequest(hotelId: string, requestId: string, stayId: string) {
  await requirePermission(hotelId, "checkin.perform");
  const supabase = await createClient();
  const { error } = await supabase
    .from("guest_requests")
    .update({ status: "completed", resolved_at: new Date().toISOString() })
    .eq("id", requestId);
  if (error) throw error;
  await logTimelineEvent({ hotelId, module: "front_desk", eventType: "guest_request.resolved", entityType: "stay", entityId: stayId });
}

/**
 * Enrutamiento minimo a Housekeeping/Mantenimiento (P2-3): Housekeeping/
 * Mantenimiento no existen como modulos/roles reales todavia, asi que
 * assignedArea es solo una etiqueta de triage -- no hay a quien validar
 * pertenencia. Mismo permiso que crear (checkin.perform): asignar es
 * triage, no la resolucion final (que sigue igual que antes). Sube
 * status a 'assigned' sólo si sigue en 'open' -- reasignar de area/persona
 * una solicitud que ya está 'in_progress' no la regresa de estado.
 */
export async function assignGuestRequest(
  hotelId: string,
  requestId: string,
  stayId: string,
  assignedArea: "housekeeping" | "maintenance",
  assignedTo?: string,
) {
  await requirePermission(hotelId, "checkin.perform");
  const supabase = await createClient();
  const { data: current, error: currentError } = await supabase
    .from("guest_requests")
    .select("status")
    .eq("id", requestId)
    .single();
  if (currentError) throw currentError;

  const { error } = await supabase
    .from("guest_requests")
    .update({
      assigned_area: assignedArea,
      assigned_to: assignedTo ?? null,
      status: current.status === "open" ? "assigned" : current.status,
    })
    .eq("id", requestId);
  if (error) throw error;
  await logTimelineEvent({
    hotelId,
    module: "front_desk",
    eventType: "guest_request.assigned",
    entityType: "stay",
    entityId: stayId,
    payload: { request_id: requestId, assigned_area: assignedArea, assigned_to: assignedTo ?? null },
  });
}

export async function startGuestRequestProgress(hotelId: string, requestId: string, stayId: string) {
  await requirePermission(hotelId, "checkin.perform");
  const supabase = await createClient();
  const { error } = await supabase
    .from("guest_requests")
    .update({ status: "in_progress" })
    .eq("id", requestId)
    .in("status", ["open", "assigned"]);
  if (error) throw error;
  await logTimelineEvent({ hotelId, module: "front_desk", eventType: "guest_request.progress_started", entityType: "stay", entityId: stayId });
}

export async function createStayIncident(
  hotelId: string,
  stayId: string,
  type: "maintenance" | "damage" | "complaint" | "other",
  description: string,
  severity: "low" | "medium" | "high" = "low",
) {
  await requirePermission(hotelId, "checkin.perform");
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("stay_incidents")
    .insert({ hotel_id: hotelId, stay_id: stayId, type, description, severity })
    .select()
    .single();
  if (error) throw error;
  await logTimelineEvent({ hotelId, module: "front_desk", eventType: "stay_incident.created", entityType: "stay", entityId: stayId });
  return data;
}

export async function resolveStayIncident(hotelId: string, incidentId: string, stayId: string) {
  await requirePermission(hotelId, "rooms.manage");
  const supabase = await createClient();
  const { error } = await supabase
    .from("stay_incidents")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("id", incidentId);
  if (error) throw error;
  await logTimelineEvent({ hotelId, module: "front_desk", eventType: "stay_incident.resolved", entityType: "stay", entityId: stayId });
}

/** Mismo criterio que assignGuestRequest() -- ver comentario ahí (P2-3). */
export async function assignStayIncident(
  hotelId: string,
  incidentId: string,
  stayId: string,
  assignedArea: "housekeeping" | "maintenance",
  assignedTo?: string,
) {
  await requirePermission(hotelId, "checkin.perform");
  const supabase = await createClient();
  const { data: current, error: currentError } = await supabase
    .from("stay_incidents")
    .select("status")
    .eq("id", incidentId)
    .single();
  if (currentError) throw currentError;

  const { error } = await supabase
    .from("stay_incidents")
    .update({
      assigned_area: assignedArea,
      assigned_to: assignedTo ?? null,
      status: current.status === "open" ? "assigned" : current.status,
    })
    .eq("id", incidentId);
  if (error) throw error;
  await logTimelineEvent({
    hotelId,
    module: "front_desk",
    eventType: "stay_incident.assigned",
    entityType: "stay",
    entityId: stayId,
    payload: { incident_id: incidentId, assigned_area: assignedArea, assigned_to: assignedTo ?? null },
  });
}

export async function startStayIncidentProgress(hotelId: string, incidentId: string, stayId: string) {
  await requirePermission(hotelId, "checkin.perform");
  const supabase = await createClient();
  const { error } = await supabase
    .from("stay_incidents")
    .update({ status: "in_progress" })
    .eq("id", incidentId)
    .in("status", ["open", "assigned"]);
  if (error) throw error;
  await logTimelineEvent({ hotelId, module: "front_desk", eventType: "stay_incident.progress_started", entityType: "stay", entityId: stayId });
}

export async function setDeliveredAsset(
  hotelId: string,
  stayId: string,
  assetName: string,
  delivered: boolean,
  returned: boolean,
) {
  await requirePermission(hotelId, "checkin.perform");
  const supabase = await createClient();
  const { error } = await supabase.from("delivered_assets").upsert(
    {
      hotel_id: hotelId,
      stay_id: stayId,
      asset_name: assetName,
      delivered,
      delivered_at: delivered ? new Date().toISOString() : null,
      returned,
      returned_at: returned ? new Date().toISOString() : null,
    },
    { onConflict: "stay_id,asset_name" },
  );
  if (error) throw error;
  await logTimelineEvent({
    hotelId,
    module: "front_desk",
    eventType: "delivered_asset.updated",
    entityType: "stay",
    entityId: stayId,
    payload: { asset_name: assetName, delivered, returned },
  });
}
