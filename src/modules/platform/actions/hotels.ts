"use server";

import { requirePlatformAdmin, PLAN_DEFAULT_LIMITS } from "@/lib/auth/platform";
import { logTimelineEvent } from "@/lib/events/timeline";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Acciones del admin de plataforma (/admin, staff de Órbita 360).
 *
 * La autorización real está en RLS: todas estas escrituras pasan por
 * políticas "platform_admin_only" (ver 0039 y 0006). requirePlatformAdmin()
 * es el refuerzo de UX que corta temprano con mensaje claro.
 *
 * Excepción deliberada al "nunca uses admin.ts": la INVITACIÓN del owner
 * inicial (auth.admin.inviteUserByEmail) es el mismo caso acotado ya
 * documentado para staff.ts (crear auth.users no puede pasar por RLS). La
 * autorización ya se validó con requirePlatformAdmin() y la escritura que
 * importa (hotel, licencia, membresía) se hace con el cliente normal.
 */

export interface CreateHotelInput {
  name: string;
  slug: string;
  plan: "basico" | "plus" | "pro";
  timezone?: string;
  ownerEmail: string;
  ownerName?: string;
}

export async function createHotel(input: CreateHotelInput) {
  await requirePlatformAdmin();

  const supabase = await createClient();
  const normalizedEmail = input.ownerEmail.trim().toLowerCase();

  // 1. Hotel (RLS: insert platform_admin_only).
  const { data: hotel, error: hotelError } = await supabase
    .from("hotels")
    .insert({
      name: input.name.trim(),
      slug: input.slug.trim().toLowerCase(),
      plan: input.plan,
      status: "trial",
      timezone: input.timezone ?? "America/Mexico_City",
    })
    .select()
    .single();
  if (hotelError) throw hotelError;

  // hotel_policies y reception_settings se crean solos por trigger (0007/0020).

  // 2. Licencia con los límites por defecto del plan (NULL = sin límite).
  const defaults = PLAN_DEFAULT_LIMITS[input.plan];
  const { error: licenseError } = await supabase.from("hotel_licenses").insert({
    hotel_id: hotel.id,
    rooms_max: defaults.roomsMax,
    users_max: defaults.usersMax,
    notes: "Alta inicial desde /admin",
  });
  if (licenseError) throw licenseError;

  // 3. Owner: si ya tiene cuenta se vincula; si no, se invita.
  const { data: existingUserId, error: lookupError } = await supabase.rpc("find_user_id_by_email", {
    p_hotel_id: hotel.id,
    p_email: normalizedEmail,
  });
  if (lookupError) throw lookupError;

  const { data: adminRole, error: roleError } = await supabase
    .from("roles")
    .select("id")
    .eq("name", "hotel_admin")
    .is("hotel_id", null)
    .single();
  if (roleError) throw roleError;

  let ownerUserId: string;
  let ownerInvited = false;

  if (existingUserId) {
    ownerUserId = existingUserId as string;
  } else {
    const adminClient = createAdminClient();
    const { data: invited, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(normalizedEmail, {
      data: input.ownerName ? { full_name: input.ownerName } : undefined,
    });
    if (inviteError) throw inviteError;
    ownerUserId = invited.user.id;
    ownerInvited = true;
  }

  const { error: memberError } = await supabase.from("user_hotel_roles").insert({
    user_id: ownerUserId,
    hotel_id: hotel.id,
    role_id: adminRole.id,
  });
  if (memberError) throw memberError;

  await logTimelineEvent({
    hotelId: hotel.id,
    module: "platform",
    eventType: "hotel.created",
    entityType: "hotel",
    entityId: hotel.id,
    payload: {
      plan: input.plan,
      owner_email: normalizedEmail,
      owner_invited: ownerInvited,
    },
  });

  return { hotelId: hotel.id, ownerInvited };
}

export interface UpdateHotelLicenseInput {
  plan: "basico" | "plus" | "pro";
  status: "trial" | "active" | "suspended" | "canceled";
  roomsMax: number | null;
  usersMax: number | null;
  expiresAt: string | null; // yyyy-mm-dd o vacío = sin vencimiento
  notes: string;
}

export async function updateHotelLicense(hotelId: string, input: UpdateHotelLicenseInput) {
  await requirePlatformAdmin();

  const supabase = await createClient();

  const { error: hotelError } = await supabase
    .from("hotels")
    .update({ plan: input.plan, status: input.status })
    .eq("id", hotelId);
  if (hotelError) throw hotelError;

  const { error: licenseError } = await supabase
    .from("hotel_licenses")
    .update({
      rooms_max: input.roomsMax,
      users_max: input.usersMax,
      expires_at: input.expiresAt ? `${input.expiresAt}T23:59:59Z` : null,
      notes: input.notes || null,
    })
    .eq("hotel_id", hotelId);
  if (licenseError) throw licenseError;

  // Suspender/reactivar desactiva/reactiva membresías: el bloqueo queda
  // enforcementado por RLS (user_hotel_ids() queda vacío), no por la UI.
  if (input.status === "suspended" || input.status === "canceled") {
    const { error: deactivateError } = await supabase
      .from("user_hotel_roles")
      .update({ is_active: false, deactivated_by_suspension: true })
      .eq("hotel_id", hotelId)
      .eq("is_active", true);
    if (deactivateError) throw deactivateError;
  } else {
    // trial/active: reactivar SÓLO las que la suspensión desactivó.
    const { error: reactivateError } = await supabase
      .from("user_hotel_roles")
      .update({ is_active: true, deactivated_by_suspension: false })
      .eq("hotel_id", hotelId)
      .eq("deactivated_by_suspension", true);
    if (reactivateError) throw reactivateError;
  }

  await logTimelineEvent({
    hotelId,
    module: "platform",
    eventType: "hotel.license_updated",
    entityType: "hotel",
    entityId: hotelId,
    payload: {
      plan: input.plan,
      status: input.status,
      rooms_max: input.roomsMax,
      users_max: input.usersMax,
      expires_at: input.expiresAt,
    },
  });
}

export async function setFeatureOverride(hotelId: string, featureKey: string, enabled: boolean, reason: string) {
  await requirePlatformAdmin();

  const supabase = await createClient();
  const { error } = await supabase.from("hotel_feature_overrides").upsert({
    hotel_id: hotelId,
    feature_key: featureKey,
    enabled,
    reason: reason || null,
  });
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "platform",
    eventType: "hotel.feature_override_set",
    entityType: "hotel_feature_override",
    entityId: hotelId,
    payload: { feature_key: featureKey, enabled, reason },
  });
}

export async function removeFeatureOverride(hotelId: string, featureKey: string) {
  await requirePlatformAdmin();

  const supabase = await createClient();
  const { error } = await supabase
    .from("hotel_feature_overrides")
    .delete()
    .eq("hotel_id", hotelId)
    .eq("feature_key", featureKey);
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "platform",
    eventType: "hotel.feature_override_removed",
    entityType: "hotel_feature_override",
    entityId: hotelId,
    payload: { feature_key: featureKey },
  });
}

export interface ResetDemoResult {
  hotel_id: string;
  hotel_slug: string;
  stays_created: number;
  reservations_created: number;
  transactions_created: number;
  timeline_events_created: number;
  reset_at: string;
}

/**
 * Regenera el Hotel Demo (hotels.is_demo = true; el slug 'hotel-demo' queda
 * sólo como identificador legible, ver 0051) con ~7 semanas de historial.
 *
 * El borrado + seed corre dentro de la función reset_demo_hotel() (0050):
 * atómico, idempotente y con guard de platform_admin a nivel de base
 * (is_platform_admin() lee auth.uid() del JWT — este RPC va con la sesión
 * del admin, nunca con service role, para que el guard tenga sentido).
 *
 * Decisión deliberada: NO hay reset automático/cron en esta fase. Es un
 * botón manual en /admin (tab "Demo"); el cron se activará cuando la demo
 * sea pública.
 */
export async function resetDemoHotel(): Promise<ResetDemoResult> {
  await requirePlatformAdmin();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("reset_demo_hotel");
  if (error) throw error;

  const result = data as ResetDemoResult;

  await logTimelineEvent({
    hotelId: result.hotel_id,
    module: "platform",
    eventType: "demo.reset_requested",
    entityType: "hotel",
    entityId: result.hotel_id,
    payload: {
      stays: result.stays_created,
      reservations: result.reservations_created,
      transactions: result.transactions_created,
    },
  });

  return result;
}
