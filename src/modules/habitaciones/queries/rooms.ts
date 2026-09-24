import "server-only";
import { createClient } from "@/lib/supabase/server";

export async function listRooms(hotelId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("rooms")
    .select(
      `id, code, building, floor, bed_type, photos, is_active, is_clean,
       motivo_inactivacion, inactive_at, inactive_by, room_type_id, room_types(name)`,
    )
    .eq("hotel_id", hotelId)
    .order("code");
  if (error) throw error;
  return data;
}

export interface ResolvedAmenity {
  amenidadId: string;
  name: string;
  esPromesaComercial: boolean;
  origen: "HEREDA" | "AGREGA";
}

/**
 * Resuelve la herencia con excepción (3 estados) de amenidades para una
 * Habitacion concreta: HEREDA (base del TipoHabitacion sin excepción) +
 * AGREGA (excepción propia) - EXCLUYE (excepción propia que anula una
 * base heredada). Se resuelve en TypeScript, nunca en una vista
 * materializada -- MVP simple, sin infraestructura nueva (ver 0039).
 */
export async function resolveRoomAmenities(hotelId: string, roomId: string): Promise<ResolvedAmenity[]> {
  const supabase = await createClient();

  const { data: room, error: roomError } = await supabase
    .from("rooms")
    .select("room_type_id")
    .eq("hotel_id", hotelId)
    .eq("id", roomId)
    .single();
  if (roomError) throw roomError;

  const { data: base, error: baseError } = await supabase
    .from("tipo_habitacion_amenidad")
    .select("amenidad_id, catalogo_amenidades(id, name, es_promesa_comercial)")
    .eq("hotel_id", hotelId)
    .eq("room_type_id", room.room_type_id);
  if (baseError) throw baseError;

  const { data: excepciones, error: excError } = await supabase
    .from("habitacion_amenidad_excepcion")
    .select("amenidad_id, tipo_excepcion, catalogo_amenidades(id, name, es_promesa_comercial)")
    .eq("hotel_id", hotelId)
    .eq("room_id", roomId);
  if (excError) throw excError;

  const excluidas = new Set(
    (excepciones ?? []).filter((e) => e.tipo_excepcion === "EXCLUYE").map((e) => e.amenidad_id),
  );

  const heredadas: ResolvedAmenity[] = (base ?? [])
    .filter((b) => !excluidas.has(b.amenidad_id))
    .map((b) => {
      const cat = b.catalogo_amenidades as unknown as { id: string; name: string; es_promesa_comercial: boolean };
      return { amenidadId: cat.id, name: cat.name, esPromesaComercial: cat.es_promesa_comercial, origen: "HEREDA" as const };
    });

  const agregadas: ResolvedAmenity[] = (excepciones ?? [])
    .filter((e) => e.tipo_excepcion === "AGREGA")
    .map((e) => {
      const cat = e.catalogo_amenidades as unknown as { id: string; name: string; es_promesa_comercial: boolean };
      return { amenidadId: cat.id, name: cat.name, esPromesaComercial: cat.es_promesa_comercial, origen: "AGREGA" as const };
    });

  return [...heredadas, ...agregadas];
}

export interface ResolvedAsset {
  assetName: string;
  origen: "HEREDA" | "AGREGA";
}

/** Misma herencia con excepción que resolveRoomAmenities(), para activos entregables. */
export async function resolveRoomAssets(hotelId: string, roomId: string): Promise<ResolvedAsset[]> {
  const supabase = await createClient();

  const { data: room, error: roomError } = await supabase
    .from("rooms")
    .select("room_type_id")
    .eq("hotel_id", hotelId)
    .eq("id", roomId)
    .single();
  if (roomError) throw roomError;

  const { data: base, error: baseError } = await supabase
    .from("tipo_habitacion_activo")
    .select("asset_name")
    .eq("hotel_id", hotelId)
    .eq("room_type_id", room.room_type_id);
  if (baseError) throw baseError;

  const { data: excepciones, error: excError } = await supabase
    .from("habitacion_activo_excepcion")
    .select("asset_name, tipo_excepcion")
    .eq("hotel_id", hotelId)
    .eq("room_id", roomId);
  if (excError) throw excError;

  const excluidos = new Set((excepciones ?? []).filter((e) => e.tipo_excepcion === "EXCLUYE").map((e) => e.asset_name));

  const heredados: ResolvedAsset[] = (base ?? [])
    .filter((b) => !excluidos.has(b.asset_name))
    .map((b) => ({ assetName: b.asset_name, origen: "HEREDA" as const }));

  const agregados: ResolvedAsset[] = (excepciones ?? [])
    .filter((e) => e.tipo_excepcion === "AGREGA")
    .map((e) => ({ assetName: e.asset_name, origen: "AGREGA" as const }));

  return [...heredados, ...agregados];
}
