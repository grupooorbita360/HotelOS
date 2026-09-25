"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { headers } from "next/headers";
/**
 * Decide a dónde va el usuario tras autenticarse:
 *   - plataforma (Órbita 360)        -> /admin
 *   - hotel operativo                -> /reservaciones
 *   - sin hotel pero con membresía en un hotel suspendido/cancelado -> /suspendido
 *   - resto (sin hotel asignado)     -> /reservaciones (la página muestra el aviso)
 */
export async function homeForCurrentUser(): Promise<string> {
  const supabase = await createClient();

  // order by created_at: mismo criterio determinista que getCurrentUserHotel()
  // (src/lib/auth/session.ts) -- sin esto, un usuario con más de una
  // membresía activa podía aterrizar en un hotel distinto en cada login
  // (bug real, ver CLAUDE.md).
  const { data: membership } = await supabase
    .from("user_hotel_roles")
    .select("hotel_id, hotels(status)")
    .eq("is_active", true)
    .order("created_at", { ascending: true })
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

/**
 * Dispara el correo de recovery de contraseña (issue #8). El enlace
 * aterriza en /auth/confirm (token_hash + type=recovery), que intercambia
 * el token y manda a /update-password. Respuesta genérica a propósito:
 * no revelar si el correo existe.
 */
export async function requestPasswordReset(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) {
    redirect(`/login?error=${encodeURIComponent("Escribe tu correo para restablecer la contraseña.")}`);
  }

  const origin = (await headers()).get("origin");
  if (!origin) {
    redirect(`/login?error=${encodeURIComponent("No se pudo preparar el enlace. Intenta de nuevo.")}`);
  }

  const supabase = await createClient();
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/auth/confirm`,
  });

  redirect(`/login?message=${encodeURIComponent("Si el correo existe, te enviamos un enlace para restablecer tu contraseña.")}`);
}
