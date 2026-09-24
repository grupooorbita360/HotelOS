import "server-only";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";

/**
 * Cookie que recuerda cuál de los hoteles del usuario está usando ahora --
 * sólo una preferencia de sesión, nunca una fuente de permisos. Se lee aquí
 * y se escribe únicamente desde `selectHotel()` (`src/lib/auth/actions.ts`),
 * que valida contra `user_hotel_roles` antes de fijarla (regla 2: nunca
 * confiar en un hotel_id que venga del cliente sin validar en servidor).
 */
export const SELECTED_HOTEL_COOKIE = "selected_hotel_id";

export interface ActiveHotelMembership {
  hotelId: string;
  hotelName: string;
  roleName: string | null;
  status: string;
}

/**
 * Todas las membresías activas del usuario, en un orden determinista (la
 * más antigua primero) -- nunca "lo que Postgres devuelva primero" sin
 * `order by`, que no está garantizado y puede variar entre llamadas.
 *
 * Bug real: `getCurrentUserHotel()`/`homeForCurrentUser()` (login) hacían
 * exactamente eso (`.limit(1).maybeSingle()` sin order by), y HotelOS es
 * multi-hotel por diseño (un dueño puede administrar más de un hotel) --
 * no es un caso raro. Reproducido en vivo probando P0-3/P0-7 contra una
 * cuenta con dos membresías activas: la misma sesión resolvía a un hotel
 * distinto entre requests, produciendo `PGRST116` (0 filas) al buscar una
 * estancia real de OTRO hotel bajo el `hotel_id` equivocado. Ver CLAUDE.md.
 */
export async function listActiveHotelMemberships(userId: string): Promise<ActiveHotelMembership[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("user_hotel_roles")
    .select("hotel_id, hotels(name, status), roles(name)")
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("created_at", { ascending: true });
  if (error) throw error;

  return (data ?? []).map((row) => ({
    hotelId: row.hotel_id as string,
    hotelName: (row.hotels as unknown as { name: string } | null)?.name ?? "Hotel",
    roleName: (row.roles as unknown as { name: string } | null)?.name ?? null,
    status: (row.hotels as unknown as { status?: string } | null)?.status ?? "active",
  }));
}

export async function getCurrentUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/**
 * Hotel "actual" del usuario autenticado. Si tiene una sola membresía
 * activa, es esa. Si tiene varias (dueño de más de un hotel, cuenta demo,
 * etc.), usa la que haya elegido explícitamente vía `selectHotel()`
 * (cookie `selected_hotel_id`, revalidada aquí contra sus membresías
 * activas reales -- una cookie inválida o de un hotel del que ya no es
 * miembro simplemente se ignora) y si no ha elegido, cae a la más antigua
 * (orden determinista de `listActiveHotelMemberships()`).
 */
export async function getCurrentUserHotel() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const memberships = await listActiveHotelMemberships(user.id);
  if (memberships.length === 0) return null;

  const cookieStore = await cookies();
  const selectedHotelId = cookieStore.get(SELECTED_HOTEL_COOKIE)?.value;
  const current = (selectedHotelId && memberships.find((m) => m.hotelId === selectedHotelId)) || memberships[0];

  const { data: policies } = await supabase
    .from("hotel_policies")
    .select("extra_settings")
    .eq("hotel_id", current.hotelId)
    .maybeSingle();
  const brandColor = (policies?.extra_settings as { brand_color?: string } | null)?.brand_color ?? null;

  return {
    hotelId: current.hotelId,
    hotelName: current.hotelName,
    roleName: current.roleName,
    status: current.status,
    brandColor,
    /** Otras membresías activas, para el selector de hotel de AppShell -- vacío si sólo tiene una. */
    otherHotels: memberships.filter((m) => m.hotelId !== current.hotelId).map((m) => ({ hotelId: m.hotelId, hotelName: m.hotelName })),
  };
}
