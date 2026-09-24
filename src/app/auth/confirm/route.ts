import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Punto de aterrizaje de los enlaces de correo de Supabase Auth
 * (recovery, invite, confirmación de signup). Las plantillas en Supabase
 * deben apuntar a {{ .SiteURL }}/auth/confirm?... y este route intercambia
 * el token por una sesión ANTES de redirigir — sin él, el dueño invitado
 * o el usuario en recovery aterrizaba en la home sin sesión (issue #8).
 *
 * Soporta los dos flujos que Supabase manda por correo:
 *   - PKCE:      ?code=...                 -> exchangeCodeForSession
 *   - OTP link:  ?token_hash=...&type=... -> verifyOtp
 *
 * Redirección según type:
 *   recovery | invite     -> /update-password (definir contraseña nueva)
 *   signup | email_change -> /login con mensaje de confirmación
 *   magiclink             -> la app (flujo normal)
 *
 * El param `next` solo se honra si es un path relativo interno: evita
 * open redirects a dominios externos vía &next=https://evil.com.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const next = safeNext(searchParams.get("next"));

  const supabase = await createClient();

  // Flujo PKCE (plantillas con {{ .Code }} o confirmación de signup).
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return withError(origin, error.message);
    return NextResponse.redirect(`${origin}${next ?? "/"}`);
  }

  // Flujo token_hash (recovery / invite / magiclink / email_change).
  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: type as "signup" | "invite" | "magiclink" | "recovery" | "email_change",
    });
    if (error) return withError(origin, error.message);

    if (type === "recovery" || type === "invite") {
      return NextResponse.redirect(`${origin}${next ?? "/update-password"}`);
    }
    if (type === "signup" || type === "email_change") {
      return NextResponse.redirect(
        `${origin}/login?message=${encodeURIComponent("Correo confirmado. Inicia sesión con tu contraseña.")}`,
      );
    }
    return NextResponse.redirect(`${origin}${next ?? "/"}`);
  }

  return withError(origin, "Enlace inválido o incompleto. Solicita uno nuevo.");
}

function withError(origin: string, message: string) {
  return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(message)}`);
}

/** Solo paths relativos internos; cualquier otra cosa se ignora. */
function safeNext(next: string | null): string | null {
  if (next && next.startsWith("/") && !next.startsWith("//")) return next;
  return null;
}
