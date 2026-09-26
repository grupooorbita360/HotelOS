"use client";

/**
 * Consumidor de enlaces de correo en flujo implícito (issue #8).
 * Los tokens llegan en el FRAGMENTO (#access_token=...), que el navegador
 * jamás envía al servidor — por eso esta página es cliente y lee
 * window.location.hash. Aplica a invitación de dueño, recovery y
 * confirmación de signup. Tras setSession, redirige según type.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function AuthCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const access_token = hash.get("access_token");
    const refresh_token = hash.get("refresh_token");
    const type = hash.get("type");

    if (!access_token || !refresh_token) {
      setError("Enlace inválido o incompleto. Solicita uno nuevo.");
      return;
    }

    createClient()
      .auth.setSession({ access_token, refresh_token })
      .then(({ error }) => {
        if (error) {
          setError(error.message);
          return;
        }
        if (type === "recovery" || type === "invite") {
          router.replace("/update-password");
        } else if (type === "signup" || type === "email_change") {
          router.replace(`/login?message=${encodeURIComponent("Correo confirmado. Inicia sesión con tu contraseña.")}`);
        } else {
          router.replace("/");
        }
      });
  }, [router]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <p className="text-center text-sm text-muted-strong">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <p className="text-center text-sm text-muted-strong">Confirmando tu acceso…</p>
    </div>
  );
}
