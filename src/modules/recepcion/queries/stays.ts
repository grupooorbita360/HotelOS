import "server-only";
import { createClient } from "@/lib/supabase/server";

export interface StayFilters {
  status?: string;
}

export async function listStays(hotelId: string, filters: StayFilters = {}) {
  const supabase = await createClient();
  let query = supabase
    .from("stays")
    .select(
      `id, status, next_action, arrived_at, checked_in_at, in_house_at, checked_out_at,
       reservation_stays(check_in, check_out, room_type_id, room_types(name), reservations(folio, primary_guest_name)),
       stay_accounts(balance)`,
    )
    .eq("hotel_id", hotelId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (filters.status) query = query.eq("status", filters.status);

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export interface RoomTypeHousekeepingSummary {
  clean: number;
  dirty: number;
}

/**
 * Disponibilidad real por tipo de habitación (P1-7, handoff de demo P1
 * Tanda 2): "libre" deja de ser binario -- se separa entre libre-y-limpia y
 * libre-pero-sucia, para que la lista de llegadas diga si de verdad hay una
 * habitación lista o si el check-in va a tropezar con el gate de limpieza de
 * check_in() (0026). Mismo criterio de "disponible" que ya usan
 * listAssignableRooms()/listRoomAssignmentOptions() (activa + sin
 * room_assignments abierto) -- una sola pasada para todos los tipos del
 * hotel, no una consulta por estancia en la lista.
 */
export async function getRoomTypeHousekeepingSummary(
  hotelId: string,
): Promise<Map<string, RoomTypeHousekeepingSummary>> {
  const supabase = await createClient();
  const { data: rooms, error } = await supabase
    .from("rooms")
    .select("id, room_type_id, is_clean")
    .eq("hotel_id", hotelId)
    .eq("is_active", true);
  if (error) throw error;

  const { data: activeAssignments } = await supabase
    .from("room_assignments")
    .select("room_id")
    .eq("hotel_id", hotelId)
    .is("released_at", null);
  const occupied = new Set((activeAssignments ?? []).map((a) => a.room_id));

  const summary = new Map<string, RoomTypeHousekeepingSummary>();
  for (const r of rooms ?? []) {
    if (occupied.has(r.id)) continue;
    const entry = summary.get(r.room_type_id) ?? { clean: 0, dirty: 0 };
    if (r.is_clean) entry.clean += 1;
    else entry.dirty += 1;
    summary.set(r.room_type_id, entry);
  }
  return summary;
}

export async function getStayDetails(hotelId: string, stayId: string) {
  const supabase = await createClient();
  const { data: stay, error } = await supabase
    .from("stays")
    .select(
      `id, hotel_id, status, next_action, arrived_at, checked_in_at, in_house_at, checked_out_at, no_show_at, walked_at,
       reservation_stays(id, room_type_id, check_in, check_out, adults, children, rate_total, room_types(name),
         reservations(folio, primary_guest_name, primary_guest_email, primary_guest_phone)),
       stay_accounts(id, balance, status, currency)`,
    )
    .eq("id", stayId)
    .eq("hotel_id", hotelId)
    .single();
  if (error) throw error;

  const { data: activeAssignment } = await supabase
    .from("room_assignments")
    .select("id, room_id, assigned_at, rooms(code, is_clean, room_type_id)")
    .eq("stay_id", stayId)
    .is("released_at", null)
    .maybeSingle();

  const { data: transactions } = await supabase
    .from("stay_transactions")
    .select("id, type, amount, concept, method, created_at, reversed_transaction_id")
    .eq("stay_account_id", stay.stay_accounts?.id ?? "")
    .order("created_at", { ascending: false });

  const { data: guestRequests } = await supabase
    .from("guest_requests")
    .select("id, description, status, assigned_area, assigned_to, created_at, resolved_at")
    .eq("stay_id", stayId)
    .order("created_at", { ascending: false });

  const { data: incidents } = await supabase
    .from("stay_incidents")
    .select("id, type, severity, description, status, assigned_area, assigned_to, created_at, resolved_at")
    .eq("stay_id", stayId)
    .order("created_at", { ascending: false });

  const { data: assets } = await supabase
    .from("delivered_assets")
    .select("id, asset_name, delivered, returned")
    .eq("stay_id", stayId);

  const { data: readiness } = await supabase.rpc("check_out_readiness", { p_stay_id: stayId });

  return {
    stay,
    activeAssignment,
    transactions: transactions ?? [],
    guestRequests: guestRequests ?? [],
    incidents: incidents ?? [],
    assets: assets ?? [],
    readiness: readiness as { ready: boolean; blockers: string[] } | null,
  };
}

/** Habitaciones del mismo tipo vendido, activas y sin asignacion activa a otra estancia. */
export async function listAssignableRooms(hotelId: string, roomTypeId: string) {
  const supabase = await createClient();
  const { data: rooms, error } = await supabase
    .from("rooms")
    .select("id, code, is_clean")
    .eq("hotel_id", hotelId)
    .eq("room_type_id", roomTypeId)
    .eq("is_active", true);
  if (error) throw error;

  const { data: activeAssignments } = await supabase
    .from("room_assignments")
    .select("room_id")
    .eq("hotel_id", hotelId)
    .is("released_at", null);

  const occupied = new Set((activeAssignments ?? []).map((a) => a.room_id));
  return (rooms ?? []).filter((r) => !occupied.has(r.id));
}

export interface RoomAssignmentOption {
  id: string;
  code: string;
  building: string | null;
  bedType: string | null;
  isClean: boolean;
  roomTypeName: string;
  kind: "equivalente" | "upgrade";
  priceDiff: number;
}

/**
 * Opciones para el flujo guiado de check-in (assign_room_for_checkin, 0032):
 * habitaciones activas y libres del tipo vendido ("equivalente", sin costo)
 * + de otros tipos con tarifa base mayor ("upgrade", con la diferencia ya
 * calculada x noches). No se ofrecen downgrades como recomendacion -- ver
 * CLAUDE.md, sección Recepción.
 *
 * soldNightlyRate: la tarifa POR NOCHE realmente vendida en esta reserva
 * (reservation_stays.rate_total / noches), no room_types.base_rate del tipo
 * vendido -- pueden diferir porque el staff negoció una tarifa distinta al
 * cotizar, o porque base_rate cambió en Configuración desde que esta
 * reserva se confirmó (auditoría de precio, Tier 1, ver CLAUDE.md). El lado
 * "upgrade" sigue comparando contra el base_rate ACTUAL del tipo candidato:
 * no hay tarifa histórica que congelar para una habitación que el huésped
 * nunca reservó.
 */
export async function listRoomAssignmentOptions(
  hotelId: string,
  soldRoomTypeId: string,
  nights: number,
  soldNightlyRate: number,
): Promise<RoomAssignmentOption[]> {
  const supabase = await createClient();

  const { data: roomTypes, error: rtError } = await supabase
    .from("room_types")
    .select("id, name, base_rate")
    .eq("hotel_id", hotelId)
    .eq("is_active", true);
  if (rtError) throw rtError;

  const { data: rooms, error: roomsError } = await supabase
    .from("rooms")
    .select("id, code, building, bed_type, is_clean, room_type_id")
    .eq("hotel_id", hotelId)
    .eq("is_active", true);
  if (roomsError) throw roomsError;

  const { data: activeAssignments } = await supabase
    .from("room_assignments")
    .select("room_id")
    .eq("hotel_id", hotelId)
    .is("released_at", null);
  const occupied = new Set((activeAssignments ?? []).map((a) => a.room_id));

  const roomTypeById = new Map(roomTypes.map((rt) => [rt.id, rt]));

  return rooms
    .filter((r) => !occupied.has(r.id))
    .map((r) => {
      const type = roomTypeById.get(r.room_type_id);
      const isEquivalente = r.room_type_id === soldRoomTypeId;
      const diff = isEquivalente ? 0 : Math.round((((type?.base_rate ?? 0) - soldNightlyRate) * nights) * 100) / 100;
      return {
        id: r.id,
        code: r.code,
        building: r.building,
        bedType: r.bed_type,
        isClean: r.is_clean,
        roomTypeName: type?.name ?? "—",
        kind: isEquivalente ? ("equivalente" as const) : ("upgrade" as const),
        priceDiff: diff,
      };
    })
    .filter((opt) => opt.kind === "equivalente" || opt.priceDiff >= 0)
    .sort((a, b) => (a.kind === b.kind ? a.priceDiff - b.priceDiff : a.kind === "equivalente" ? -1 : 1));
}

export interface RoomChangeOption {
  id: string;
  code: string;
  building: string | null;
  bedType: string | null;
  isClean: boolean;
  roomTypeName: string;
  kind: "equivalente" | "upgrade" | "downgrade";
}

/**
 * Opciones para el cambio de habitación autorizado DESPUÉS del check-in
 * (P0-3/P0-5, handoff de demo) -- a diferencia de listRoomAssignmentOptions()
 * (sólo para el flujo guiado de check-in, excluye downgrades a propósito),
 * esta sí incluye downgrades: change_room_with_authorization() (0051) los
 * acepta con motivo + compensación opcional. La clasificación
 * (equivalente/upgrade/downgrade) compara contra el tipo de la habitación
 * ACTUAL de la estancia (o el tipo vendido si nunca tuvo una asignada),
 * mismo criterio que la función SQL -- sólo para mostrar la etiqueta
 * correcta en la UI; el servidor vuelve a decidir por su cuenta.
 */
export async function listRoomChangeOptions(hotelId: string, currentRoomTypeId: string): Promise<RoomChangeOption[]> {
  const supabase = await createClient();

  const { data: roomTypes, error: rtError } = await supabase
    .from("room_types")
    .select("id, name, base_rate")
    .eq("hotel_id", hotelId)
    .eq("is_active", true);
  if (rtError) throw rtError;

  const { data: rooms, error: roomsError } = await supabase
    .from("rooms")
    .select("id, code, building, bed_type, is_clean, room_type_id")
    .eq("hotel_id", hotelId)
    .eq("is_active", true);
  if (roomsError) throw roomsError;

  const { data: activeAssignments } = await supabase
    .from("room_assignments")
    .select("room_id")
    .eq("hotel_id", hotelId)
    .is("released_at", null);
  const occupied = new Set((activeAssignments ?? []).map((a) => a.room_id));

  const roomTypeById = new Map(roomTypes.map((rt) => [rt.id, rt]));
  const currentRate = roomTypeById.get(currentRoomTypeId)?.base_rate ?? 0;

  return rooms
    .filter((r) => !occupied.has(r.id))
    .map((r) => {
      const type = roomTypeById.get(r.room_type_id);
      const isEquivalente = r.room_type_id === currentRoomTypeId;
      const kind: RoomChangeOption["kind"] = isEquivalente
        ? "equivalente"
        : (type?.base_rate ?? 0) > currentRate
          ? "upgrade"
          : "downgrade";
      return {
        id: r.id,
        code: r.code,
        building: r.building,
        bedType: r.bed_type,
        isClean: r.is_clean,
        roomTypeName: type?.name ?? "—",
        kind,
      };
    })
    .sort((a, b) => (a.kind === b.kind ? a.code.localeCompare(b.code) : a.kind === "equivalente" ? -1 : a.kind === "upgrade" ? -1 : 1));
}

export async function getReceptionSettings(hotelId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("reception_settings")
    .select("*")
    .eq("hotel_id", hotelId)
    .single();
  if (error) throw error;
  return data;
}

export async function getHotelCheckinAssets(hotelId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("hotel_policies")
    .select("checkin_assets")
    .eq("hotel_id", hotelId)
    .single();
  if (error) throw error;
  return (data?.checkin_assets as string[] | null) ?? [];
}

export interface OpenServiceItem {
  id: string;
  stayId: string;
  guestName: string;
  description: string;
  status: string;
  assignedArea: string | null;
  createdAt: string;
}

type ServiceItemStayEmbed = {
  reservation_stays: { reservations: { primary_guest_name: string } | null } | null;
} | null;

/**
 * Enrutamiento minimo (P2-3): a diferencia de las listas por estancia que
 * ya existían (getStayDetails), estas son a nivel HOTEL -- lo que hace
 * falta para que Recepción/Gerencia vean todo lo abierto sin entrar
 * estancia por estancia. RLS ya da la visibilidad (cualquier miembro del
 * hotel ve las filas de su hotel) -- no se agrega ningún permiso nuevo
 * sólo para leer, mismo criterio que hotel_priorities.
 */
export async function listOpenGuestRequests(hotelId: string): Promise<OpenServiceItem[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("guest_requests")
    .select(
      `id, stay_id, description, status, assigned_area, created_at,
       stays(reservation_stays(reservations(primary_guest_name)))`,
    )
    .eq("hotel_id", hotelId)
    .not("status", "in", "(completed,cancelled)")
    .order("created_at", { ascending: true });
  if (error) throw error;

  return (data ?? []).map((r) => ({
    id: r.id,
    stayId: r.stay_id,
    guestName: (r.stays as unknown as ServiceItemStayEmbed)?.reservation_stays?.reservations?.primary_guest_name ?? "Huésped",
    description: r.description,
    status: r.status,
    assignedArea: r.assigned_area,
    createdAt: r.created_at,
  }));
}

export async function listOpenIncidents(hotelId: string): Promise<OpenServiceItem[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("stay_incidents")
    .select(
      `id, stay_id, description, status, assigned_area, created_at,
       stays(reservation_stays(reservations(primary_guest_name)))`,
    )
    .eq("hotel_id", hotelId)
    .neq("status", "resolved")
    .order("created_at", { ascending: true });
  if (error) throw error;

  return (data ?? []).map((r) => ({
    id: r.id,
    stayId: r.stay_id,
    guestName: (r.stays as unknown as ServiceItemStayEmbed)?.reservation_stays?.reservations?.primary_guest_name ?? "Huésped",
    description: r.description,
    status: r.status,
    assignedArea: r.assigned_area,
    createdAt: r.created_at,
  }));
}
