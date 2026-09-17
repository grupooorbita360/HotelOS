import "server-only";
import { createClient } from "@/lib/supabase/server";

export async function listRoomTypes(hotelId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("room_types")
    .select(
      `id, name, code, description, base_adults, max_adults, max_children, max_pets,
       base_rate, orden_comercial, photos, is_active`,
    )
    .eq("hotel_id", hotelId)
    .order("orden_comercial")
    .order("name");
  if (error) throw error;
  return data;
}

export async function listCatalogoAmenidades(hotelId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("catalogo_amenidades")
    .select("id, name, es_promesa_comercial, is_active")
    .eq("hotel_id", hotelId)
    .order("name");
  if (error) throw error;
  return data;
}

/** Amenidades base de un TipoHabitacion (el "HEREDA" por defecto de cualquier Habitacion de ese tipo). */
export async function listRoomTypeAmenidades(hotelId: string, roomTypeId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tipo_habitacion_amenidad")
    .select("id, amenidad_id, catalogo_amenidades(id, name, es_promesa_comercial)")
    .eq("hotel_id", hotelId)
    .eq("room_type_id", roomTypeId);
  if (error) throw error;
  return data;
}

export async function listTipoHabitacionActivos(hotelId: string, roomTypeId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tipo_habitacion_activo")
    .select("id, asset_name")
    .eq("hotel_id", hotelId)
    .eq("room_type_id", roomTypeId)
    .order("asset_name");
  if (error) throw error;
  return data;
}
