"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * Decide a dónde va el usuario tras autenticarse:
 *   - plataforma (Órbita 360)        -> /admin
 *   - hotel operativo                -> /reservaciones
 *   - sin hotel pero con membresía en un hotel suspendido/cancelado -> /suspendido
 *   - resto (sin hotel asignado)     -> /reservaciones (la página muestra el aviso)
 */
async function homeForCurrentUser(): Promise<string> {
  const supabase = await createClient();

  const { data: membership } = await supabase
    .from("user_hotel_roles")
    .select("hotel_id, hotels(status)")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (membership) {
    const status = (membership.hotels as unknown as { status: string } | null)?.status;
    if (status === "suspended" || status === "canceled") return "/suspendido";
    return "/reservaciones";
  }

  const { data: isPlatformAdmin } = await supabase.rpc("is_platform_admin");
  if (isPlatformAdmin) return "/admin";

  const { data: hasSuspendedMembership } = await supabase.rpc("user_has_suspended_membership");
  if (hasSuspendedMembership) return "/suspendido";

  return "/reservaciones";
}

export async function signIn(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }

  redirect(await homeForCurrentUser());
}

export async function signUp(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({ email, password });

  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }

  if (!data.session) {
    redirect(
      `/login?message=${encodeURIComponent("Cuenta creada. Revisa tu correo para confirmarla y luego inicia sesión.")}`,
    );
  }

  redirect("/reservaciones");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
