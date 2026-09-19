"use server";

import { requirePermission } from "@/lib/auth/permissions";
import { assertUserLimit, planLabel } from "@/lib/auth/platform";
import { logTimelineEvent } from "@/lib/events/timeline";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Excepción deliberada y acotada a la regla "nunca uses admin.ts para una
 * petición de usuario normal" (ver CLAUDE.md): crear la cuenta de auth.users
 * de alguien nuevo SOLO puede hacerse con la Admin API de Supabase -- no es
 * una tabla `public.*`, no tiene RLS, y no hay forma de que el cliente
 * autenticado la escriba. El client admin se usa aquí única y exclusivamente
 * para ese paso (inviteUserByEmail); la decisión real de autorización
 * -- ¿puede ESTE usuario dar de alta gente en ESTE hotel? -- ya se validó
 * arriba con requirePermission() y se vuelve a validar en Postgres dentro de
 * find_user_id_by_email() (SECURITY DEFINER, ver 0031). La escritura que
 * importa (asignar el rol en user_hotel_roles) se hace siempre con el
 * cliente normal, sujeta a RLS como cualquier otra escritura del proyecto.
 */
async function assertSystemRole(roleId: string, hotelId: string) {
  const supabase = await createClient();
  const { data: role, error } = await supabase
    .from("roles")
    .select("id, hotel_id")
    .eq("id", roleId)
    .single();
  if (error) throw error;
  if (role.hotel_id !== null && role.hotel_id !== hotelId) {
    throw new Error("Rol inválido para este hotel.");
  }
}

async function countActiveHotelAdmins(hotelId: string, excludeUserHotelRoleId?: string) {
  const supabase = await createClient();
  const { data: adminRole, error: adminRoleError } = await supabase
    .from("roles")
    .select("id")
    .eq("name", "hotel_admin")
    .is("hotel_id", null)
    .single();
  if (adminRoleError) throw adminRoleError;

  let query = supabase
    .from("user_hotel_roles")
    .select("id", { count: "exact", head: true })
    .eq("hotel_id", hotelId)
    .eq("is_active", true)
    .eq("role_id", adminRole.id);
  if (excludeUserHotelRoleId) query = query.neq("id", excludeUserHotelRoleId);

  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

export async function addStaffMember(hotelId: string, email: string, roleId: string, fullName?: string) {
  await requirePermission(hotelId, "staff.manage");
  await assertSystemRole(roleId, hotelId);

  const supabase = await createClient();
  const normalizedEmail = email.trim().toLowerCase();

  const { data: existingUserId, error: lookupError } = await supabase.rpc("find_user_id_by_email", {
    p_hotel_id: hotelId,
    p_email: normalizedEmail,
  });
  if (lookupError) throw lookupError;

  const { data: hotel } = await supabase.from("hotels").select("plan").eq("id", hotelId).single();

  if (existingUserId) {
    const { data: existingRole, error: existingRoleError } = await supabase
      .from("user_hotel_roles")
      .select("id")
      .eq("hotel_id", hotelId)
      .eq("user_id", existingUserId)
      .eq("is_active", true)
      .maybeSingle();
    if (existingRoleError) throw existingRoleError;
    if (existingRole) {
      throw new Error("Este usuario ya tiene un rol activo en este hotel. Edítalo desde la lista en vez de agregarlo de nuevo.");
    }

    // Reactivar/agregar una membresía consume cupo de usuario del plan.
    await assertUserLimit(hotelId, planLabel(hotel?.plan ?? "basico"));

    const { error: insertError } = await supabase
      .from("user_hotel_roles")
      .insert({ user_id: existingUserId, hotel_id: hotelId, role_id: roleId });
    if (insertError) throw insertError;

    await logTimelineEvent({
      hotelId,
      module: "core",
      eventType: "staff.added",
      entityType: "user_hotel_role",
      entityId: existingUserId,
      payload: { email: normalizedEmail },
    });
    return;
  }

  const adminClient = createAdminClient();
  const { data: invited, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(normalizedEmail, {
    data: fullName ? { full_name: fullName } : undefined,
  });
  if (inviteError) throw inviteError;

  // Usuario nuevo: consume cupo de usuario del plan.
  await assertUserLimit(hotelId, planLabel(hotel?.plan ?? "basico"));

  const { error: insertError } = await supabase
    .from("user_hotel_roles")
    .insert({ user_id: invited.user.id, hotel_id: hotelId, role_id: roleId });
  if (insertError) throw insertError;

  await logTimelineEvent({
    hotelId,
    module: "core",
    eventType: "staff.invited",
    entityType: "user_hotel_role",
    entityId: invited.user.id,
    payload: { email: normalizedEmail },
  });
}

export async function changeStaffRole(hotelId: string, userHotelRoleId: string, newRoleId: string) {
  await requirePermission(hotelId, "staff.manage");
  await assertSystemRole(newRoleId, hotelId);

  const supabase = await createClient();
  const { data: current, error: currentError } = await supabase
    .from("user_hotel_roles")
    .select("id, is_active, roles(name)")
    .eq("id", userHotelRoleId)
    .eq("hotel_id", hotelId)
    .single();
  if (currentError) throw currentError;

  const wasAdmin = (current.roles as unknown as { name: string } | null)?.name === "hotel_admin";
  if (wasAdmin && current.is_active) {
    const remaining = await countActiveHotelAdmins(hotelId, userHotelRoleId);
    if (remaining === 0) {
      throw new Error("No puedes cambiar el rol del último hotel_admin activo de este hotel.");
    }
  }

  const { error } = await supabase
    .from("user_hotel_roles")
    .update({ role_id: newRoleId })
    .eq("id", userHotelRoleId)
    .eq("hotel_id", hotelId);
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "core",
    eventType: "staff.role_changed",
    entityType: "user_hotel_role",
    entityId: userHotelRoleId,
  });
}

export async function setStaffActive(hotelId: string, userHotelRoleId: string, isActive: boolean) {
  await requirePermission(hotelId, "staff.manage");
  const supabase = await createClient();

  if (!isActive) {
    const { data: current, error: currentError } = await supabase
      .from("user_hotel_roles")
      .select("id, roles(name)")
      .eq("id", userHotelRoleId)
      .eq("hotel_id", hotelId)
      .single();
    if (currentError) throw currentError;

    const isAdmin = (current.roles as unknown as { name: string } | null)?.name === "hotel_admin";
    if (isAdmin) {
      const remaining = await countActiveHotelAdmins(hotelId, userHotelRoleId);
      if (remaining === 0) {
        throw new Error("No puedes desactivar al último hotel_admin activo de este hotel.");
      }
    }
  }

  const { error } = await supabase
    .from("user_hotel_roles")
    .update({ is_active: isActive })
    .eq("id", userHotelRoleId)
    .eq("hotel_id", hotelId);
  if (error) throw error;

  await logTimelineEvent({
    hotelId,
    module: "core",
    eventType: isActive ? "staff.reactivated" : "staff.deactivated",
    entityType: "user_hotel_role",
    entityId: userHotelRoleId,
  });
}
