import "server-only";
import { createClient } from "@/lib/supabase/server";

export async function listRoomTypes(hotelId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("room_types")
    .select("id, name, code, capacity_adults, capacity_children, accepts_pets, base_rate")
    .eq("hotel_id", hotelId)
    .eq("is_active", true)
    .order("name");

  if (error) throw error;
  return data;
}

export interface NightAvailability {
  stay_date: string;
  total_units: number;
  blocked_units: number;
  available_units: number;
}

/** Disponibilidad noche a noche. El mínimo de available_units en el rango determina si la estancia completa puede venderse (spec S8.1). */
export async function checkAvailability(
  hotelId: string,
  roomTypeId: string,
  checkIn: string,
  checkOut: string,
): Promise<NightAvailability[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("check_availability", {
    p_hotel_id: hotelId,
    p_room_type_id: roomTypeId,
    p_check_in: checkIn,
    p_check_out: checkOut,
  });

  if (error) throw error;
  return data ?? [];
}

export interface AvailableOption {
  roomTypeId: string;
  name: string;
  capacityAdults: number;
  capacityChildren: number;
  acceptsPets: boolean;
  baseRate: number;
  nights: number;
  minAvailable: number;
}

export interface SearchAvailableOptionsFilters {
  paxAdults?: number;
  paxChildren?: number;
  hasPets?: boolean;
}

/**
 * Disponibilidad de TODOS los tipos activos para un rango de fechas, con su
 * tarifa base de Configuración como precio de referencia -- reemplaza el
 * "escribe tú la tarifa a mano para un solo tipo" por ver de una vez qué hay
 * disponible y a qué precio de partida (spec S15, ver CLAUDE.md Módulo 04
 * sobre por qué base_rate no se conectaba automáticamente hasta ahora).
 *
 * P0-6 (handoff de demo): filtra también por ocupantes/mascotas -- antes
 * esta función ignoraba por completo paxAdults/paxChildren/hasPets (sólo
 * miraba fechas), así que cambiar esos campos en el buscador no invalidaba
 * nada: se seguía mostrando un tipo que no acepta mascotas, o que no cabe
 * para la cantidad de personas pedida, con el mismo resultado de antes.
 */
export async function searchAvailableOptions(
  hotelId: string,
  checkIn: string,
  checkOut: string,
  filters: SearchAvailableOptionsFilters = {},
): Promise<AvailableOption[]> {
  const paxAdults = filters.paxAdults ?? 1;
  const paxChildren = filters.paxChildren ?? 0;
  const hasPets = filters.hasPets ?? false;

  const roomTypes = (await listRoomTypes(hotelId)).filter(
    (rt) => rt.capacity_adults >= paxAdults && rt.capacity_children >= paxChildren && (!hasPets || rt.accepts_pets),
  );
  const nights = Math.max(1, Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000));

  const results = await Promise.all(
    roomTypes.map(async (rt) => {
      const nightly = await checkAvailability(hotelId, rt.id, checkIn, checkOut);
      const minAvailable = nightly.length > 0 ? Math.min(...nightly.map((n) => n.available_units)) : 0;
      return {
        roomTypeId: rt.id,
        name: rt.name,
        capacityAdults: rt.capacity_adults,
        capacityChildren: rt.capacity_children,
        acceptsPets: rt.accepts_pets,
        baseRate: rt.base_rate,
        nights,
        minAvailable,
      };
    }),
  );

  return results.filter((r) => r.minAvailable > 0);
}
