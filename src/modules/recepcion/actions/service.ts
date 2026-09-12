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
