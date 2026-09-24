"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { homeForCurrentUser } from "@/app/login/actions";

/**
 * Define la contraseña nueva tras llegar por enlace de recovery o
 * invitación (issue #8). El usuario YA tiene sesión: /auth/confirm
 * intercambió el token antes de redirigir aquí. Tras actualizar, va al
 * mismo destino que un login normal (reservaciones / admin / suspendido).
 */
export async function updatePassword(formData: FormData) {
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (password.length < 6) {
    redirect(`/update-password?error=${encodeURIComponent("La contraseña debe tener al menos 6 caracteres.")}`);
  }
  if (password !== confirm) {
    redirect(`/update-password?error=${encodeURIComponent("Las contraseñas no coinciden.")}`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    redirect(`/update-password?error=${encodeURIComponent(error.message)}`);
  }

  redirect(await homeForCurrentUser());
}
