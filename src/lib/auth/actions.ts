"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { SELECTED_HOTEL_COOKIE } from "@/lib/auth/session";

/**
 * Cambia el hotel "actual" de la sesión (selector de AppShell, para
 * usuarios con más de una membresía activa -- ver `getCurrentUserHotel()`).
 * Valida que `hotelId` sea de verdad una membresía activa de ESTE usuario
 * antes de fijar la cookie -- nunca confía en el valor del formulario sin
 * validar en servidor (regla 2). Un `hotelId` ajeno o inactivo se ignora
 * silenciosamente (la sesión se queda en el hotel que ya tenía).
 */
export async function selectHotel(formData: FormData) {
  const hotelId = String(formData.get("hotelId") ?? "");
  const returnTo = String(formData.get("returnTo") ?? "/reservaciones");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: membership, error } = await supabase
    .from("user_hotel_roles")
    .select("hotel_id")
    .eq("user_id", user.id)
    .eq("hotel_id", hotelId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;

  if (membership) {
    const cookieStore = await cookies();
    cookieStore.set(SELECTED_HOTEL_COOKIE, hotelId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });

    // Cambiar de hotel cambia lo que TODA página de módulo renderiza
    // (AppShell, KPIs, listados...) -- sin esto, Next.js puede servir el
    // Router Cache de antes del cambio para la misma URL de returnTo, igual
    // que el bug ya documentado en Configuración (ver CLAUDE.md: ningún
    // redirect() de vuelta a la URL de origen es seguro sin revalidatePath).
    revalidatePath("/", "layout");

    // revalidatePath() solo invalida el lado del servidor -- probado en vivo
    // que el Client Router Cache del navegador puede reusar igual el RSC ya
    // prefetcheado con la cookie vieja si el destino es la URL EXACTA de la
    // que se partió (mismo patrón ya documentado en este proyecto: un
    // parámetro nuevo en la URL invalida por sí solo esa entrada de caché).
    // Se agrega un parámetro que cambia en cada switch para forzar que el
    // navegador la trate como una URL distinta y pida el render fresco.
    const separator = returnTo.includes("?") ? "&" : "?";
    redirect(`${returnTo}${separator}hotelSwitchedAt=${Date.now()}`);
  }

  redirect(returnTo);
}
