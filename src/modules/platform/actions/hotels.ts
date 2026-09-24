"use server";

import { requirePlatformAdmin, PLAN_DEFAULT_LIMITS, assertUserLimit, planLabel } from "@/lib/auth/platform";
import { computeZonedEndOfDay, isValidTimezone } from "@/lib/businessDate";
import { logTimelineEvent } from "@/lib/events/timeline";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Busca una cuenta existente por correo vía profiles (RLS permite a
 * platform_admin leer todos los perfiles, 0006). profiles.email es copia
 * sincronizada por trigger de auth.users (0030), así que cubre también a
 * usuarios invitados que aún no aceptaron.
 */
async function findUserIdByEmail(supabase: ServerSupabaseClient, email: string): Promise<string | null> {
  const { data, error } = await supabase.from("profiles").select("id").eq("email", email).maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

/** Mensaje legible para el fallo típico de inviteUserByEmail. */
function inviteFailureMessage(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  if (/rate limit/i.test(raw)) {
    return new Error(
      "No se pudo enviar la invitación: Supabase limita los correos por hora y se alcanzó el máximo. " +
        "No se creó nada. Espera ~1 hora y reintenta, o crea el usuario desde el dashboard de Supabase " +
        "(Authentication → Users → Add user → Create new user y marca Auto Confirm) y repite la acción " +
        "con el mismo correo para vincularlo.",
    );
  }
  return new Error(`No se pudo enviar la invitación (${raw}). No se creó nada; revisa el correo e inténtalo de nuevo.`);
}

/**
 * Devuelve el user_id del dueño: vincula la cuenta existente o invita.
 * La invitación es lo ÚNICO que usa el client admin (misma excepción
 * documentada que staff.ts); las escrituras las hace el caller con el
 * cliente normal (RLS).
 */
async function findOrInviteOwner(
  supabase: ServerSupabaseClient,
  email: string,
  fullName?: string,
): Promise<{ userId: string; invited: boolean }> {
  const existing = await findUserIdByEmail(supabase, email);
  if (existing) return { userId: existing, invited: false };

  const adminClient = createAdminClient();
  const { data: invited, error } = await adminClient.auth.admin.inviteUserByEmail(email, {
    data: fullName ? { full_name: fullName } : undefined,
  });
  if (error) throw inviteFailureMessage(error);
  return { userId: invited.user.id, invited: true };
}

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
  const ownerName = input.ownerName?.trim() || undefined;

  // 1. Dueño ANTES que el hotel: si la invitación falla (p. ej. el rate
  //    limit de correos de Supabase) NO queda hotel huérfano (issue #5).
  //    Si el correo ya tiene cuenta, se vincula sin enviar nada.
  const owner = await findOrInviteOwner(supabase, normalizedEmail, ownerName);

  // 2. Hotel (RLS: insert platform_admin_only).
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

  // 3. Licencia con los límites por defecto del plan (NULL = sin límite).
  const defaults = PLAN_DEFAULT_LIMITS[input.plan];
  const { error: licenseError } = await supabase.from("hotel_licenses").insert({
    hotel_id: hotel.id,
    rooms_max: defaults.roomsMax,
    users_max: defaults.usersMax,
    notes: "Alta inicial desde /admin",
  });
  if (licenseError) throw licenseError;

  // 4. Membresía hotel_admin del dueño.
  const { data: adminRole, error: roleError } = await supabase
    .from("roles")
    .select("id")
    .eq("name", "hotel_admin")
    .is("hotel_id", null)
    .single();
  if (roleError) throw roleError;

  const { error: memberError } = await supabase.from("user_hotel_roles").insert({
    user_id: owner.userId,
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
      owner_invited: owner.invited,
    },
  });

  return { hotelId: hotel.id, ownerInvited: owner.invited };
}

export interface UpdateHotelInput {
  name: string;
  timezone: string;
}

/**
 * Edita los datos básicos de un hotel existente (nombre y zona horaria).
 * El plan NO se edita aquí: vive en la licencia (updateHotelLicense), que
 * además dispara la cascada de suspensión/reactivación. El slug no es
 * editable: se usa como identificador legible desde el alta.
 */
export async function updateHotel(hotelId: string, input: UpdateHotelInput) {
  await requirePlatformAdmin();

  const name = input.name.trim();
  if (!name) throw new Error("El nombre del hotel no puede quedar vacío.");

  const timezone = input.timezone.trim() || "America/Mexico_City";
  if (!isValidTimezone(timezone)) {
    throw new Error(`"${timezone}" no es una zona horaria IANA válida (ej. America/Mexico_City).`);
  }

  const supabase = await createClient();

  // RLS: hotels_update_settings_manager_or_platform_admin (0006) — la
  // ruta platform_admin la cubre; el refuerzo de UX ya corrió arriba.
  const { data: hotel, error } = await supabase
    .from("hotels")
    .update({ name, timezone })
    .eq("id", hotelId)
    .select("name")
    .single();
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "platform",
    eventType: "hotel.updated",
    entityType: "hotel",
    entityId: hotelId,
    payload: { name: hotel.name, timezone },
  });
}

export interface AssignHotelOwnerInput {
  ownerEmail: string;
  ownerName?: string;
}

/**
 * Asigna (o reasigna) el dueño de un hotel existente. Cubre los dos casos:
 * correo con cuenta (se vincula) o sin cuenta (se invita). También sirve de
 * reintento para hoteles dados de alta cuando el invite falló (issue #5) y
 * para hoteles huérfanos creados antes de este fix (issue #2).
 */
export async function assignHotelOwner(hotelId: string, input: AssignHotelOwnerInput) {
  await requirePlatformAdmin();

  const supabase = await createClient();
  const normalizedEmail = input.ownerEmail.trim().toLowerCase();
  const ownerName = input.ownerName?.trim() || undefined;

  const { data: adminRole, error: roleError } = await supabase
    .from("roles")
    .select("id")
    .eq("name", "hotel_admin")
    .is("hotel_id", null)
    .single();
  if (roleError) throw roleError;

  // ¿Ya es dueño activo de ESTE hotel? (idempotencia + mensaje claro)
  const alreadyOwnerId = await findUserIdByEmail(supabase, normalizedEmail);
  if (alreadyOwnerId) {
    const { data: activeMembership, error: activeError } = await supabase
      .from("user_hotel_roles")
      .select("id")
      .eq("hotel_id", hotelId)
      .eq("user_id", alreadyOwnerId)
      .eq("role_id", adminRole.id)
      .eq("is_active", true)
      .maybeSingle();
    if (activeError) throw activeError;
    if (activeMembership) {
      throw new Error("Ese correo ya es dueño activo de este hotel.");
    }
  }

  const owner = await findOrInviteOwner(supabase, normalizedEmail, ownerName);

  // Cuenta nueva: consume cupo de usuarios del plan.
  if (owner.invited) {
    const { data: hotel } = await supabase.from("hotels").select("plan").eq("id", hotelId).single();
    await assertUserLimit(hotelId, planLabel(hotel?.plan ?? "basico"));
  }

  // ¿Tenía membresía previa (desactivada)? Se reactiva; si no, se inserta.
  const { data: priorMembership, error: priorError } = await supabase
    .from("user_hotel_roles")
    .select("id")
    .eq("hotel_id", hotelId)
    .eq("user_id", owner.userId)
    .eq("role_id", adminRole.id)
    .maybeSingle();
  if (priorError) throw priorError;

  if (priorMembership) {
    const { error: reactivateError } = await supabase
      .from("user_hotel_roles")
      .update({ is_active: true, deactivated_by_suspension: false })
      .eq("id", priorMembership.id);
    if (reactivateError) throw reactivateError;
  } else {
    const { error: insertError } = await supabase.from("user_hotel_roles").insert({
      user_id: owner.userId,
      hotel_id: hotelId,
      role_id: adminRole.id,
    });
    if (insertError) throw insertError;
  }

  await logTimelineEvent({
    hotelId,
    module: "platform",
    eventType: "hotel.owner_assigned",
    entityType: "hotel",
    entityId: hotelId,
    payload: {
      owner_email: normalizedEmail,
      owner_invited: owner.invited,
    },
  });
}

/**
 * Reenvía la invitación a un dueño que aún no aceptó. Si el correo ya
 * completó su registro, no hay nada que reenviar: entra con su contraseña.
 */
export async function resendOwnerInvite(ownerEmail: string) {
  await requirePlatformAdmin();

  const normalizedEmail = ownerEmail.trim().toLowerCase();
  const adminClient = createAdminClient();
  const { error } = await adminClient.auth.admin.inviteUserByEmail(normalizedEmail, {});
  if (error) {
    if (/already/i.test(error.message ?? "")) {
      throw new Error("Ese correo ya completó su registro: no necesita invitación, puede entrar con su contraseña.");
    }
    throw inviteFailureMessage(error);
  }
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

  // El timezone se necesita para fijar el vencimiento a fin del día en la
  // fecha del HOTEL (fix M-3): 23:59:59.999 America/Mexico_City, no UTC.
  const { data: hotel, error: hotelReadError } = await supabase
    .from("hotels")
    .select("timezone")
    .eq("id", hotelId)
    .single();
  if (hotelReadError) throw hotelReadError;

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
      expires_at: input.expiresAt ? computeZonedEndOfDay(hotel.timezone, input.expiresAt).toISOString() : null,
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

  const result = data as unknown as ResetDemoResult;

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
