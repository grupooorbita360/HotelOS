import "server-only";
import { createClient } from "@/lib/supabase/server";

export async function getCurrentUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/**
 * Hotel "actual" del usuario autenticado: la primera fila activa que tenga
 * en user_hotel_roles. Sirve mientras no exista un selector de hotel en la
 * interfaz (un usuario de staff normalmente pertenece a un solo hotel).
 */
export async function getCurrentUserHotel() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data, error } = await supabase
    .from("user_hotel_roles")
    .select("hotel_id, hotels(id, name, slug), roles(name)")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    hotelId: data.hotel_id as string,
    hotelName: (data.hotels as unknown as { name: string } | null)?.name ?? "Hotel",
    roleName: (data.roles as unknown as { name: string } | null)?.name ?? null,
  };
}
