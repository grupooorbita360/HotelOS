import "server-only";
import { createClient } from "@/lib/supabase/server";
import { getHotelBusinessDate } from "@/lib/getHotelBusinessDate";

/**
 * Rack: capa de VISTA, no de dominio. No hay tabla ni algoritmo de
 * disponibilidad propio aquí -- se lee lo que ya calculan/guardan
 * Reservaciones (reservation_stays + inventory_blocks), Recepción
 * (stays + room_assignments) y Habitaciones/Configuración
 * (rooms.is_clean / rooms.is_active), y se combina en memoria para pintar
 * la cuadrícula. Ver CLAUDE.md, sección Rack, para el detalle de cada
 * decisión de esta composición.
 */

export type RackCellStatus = "IN_HOUSE" | "OUT_OF_SERVICE" | "BLOCKED" | "AVAILABLE";

export interface RackCell {
  date: string;
  status: RackCellStatus;
  isArrival: boolean;
  isDeparture: boolean;
  isConflict: boolean;
  conflictReason: string | null;
  stayId: string | null;
  stayStatus: string | null;
  reservationStayId: string | null;
  guestName: string | null;
  folio: string | null;
}

export interface RackRoom {
  roomId: string;
  code: string;
  roomTypeId: string;
  roomTypeName: string;
  building: string | null;
  bedType: string | null;
  isClean: boolean;
  cells: RackCell[];
  todayStatus: RackCellStatus;
  todayIsArrival: boolean;
  todayIsDeparture: boolean;
}

export interface UnassignedReservation {
  stayId: string;
  reservationStayId: string;
  folio: string;
  guestName: string;
  roomTypeId: string;
  roomTypeName: string;
  checkIn: string;
  checkOut: string;
  status: string;
}

export interface RackKpis {
  totalRooms: number;
  availableToday: number;
  occupiedToday: number;
  arrivalsToday: number;
  departuresToday: number;
  dirtyRooms: number;
  unassignedReservations: number;
}

export interface RackGridData {
  dateRange: string[];
  todayIso: string;
  rooms: RackRoom[];
  roomTypes: { id: string; name: string }[];
  unassigned: UnassignedReservation[];
  kpis: RackKpis;
}

function addDays(iso: string, n: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dateRangeArray(startIso: string, endExclusiveIso: string) {
  const dates: string[] = [];
  let cursor = startIso;
  while (cursor < endExclusiveIso) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return dates;
}

const ACTIVE_STAY_STATUSES = new Set(["arrived", "checked_in", "in_house"]);

/**
 * Cache simple en memoria (proceso Node), TTL corto -- la consulta completa
 * del Rack combina 5 tablas y se pide cada vez que alguien abre/navega la
 * pantalla. No es un cache distribuido (en un despliegue multi-instancia
 * cada instancia tiene el suyo), a propósito: es "cache simple" pedido para
 * este MVP, no una capa de infraestructura nueva.
 */
interface CacheEntry {
  data: RackGridData;
  expiresAt: number;
}
const gridCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 45_000;

export function invalidateRackCache(hotelId: string) {
  for (const key of gridCache.keys()) {
    if (key.startsWith(`${hotelId}:`)) gridCache.delete(key);
  }
}

export async function getRackGrid(hotelId: string, startIso: string, days: number): Promise<RackGridData> {
  const cacheKey = `${hotelId}:${startIso}:${days}`;
  const cached = gridCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const data = await fetchRackGrid(hotelId, startIso, days);
  gridCache.set(cacheKey, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

async function fetchRackGrid(hotelId: string, startIso: string, days: number): Promise<RackGridData> {
  const supabase = await createClient();
  // Fecha operativa del hotel (su timezone, no UTC del servidor) -- ver CLAUDE.md.
  const todayIso = await getHotelBusinessDate(hotelId);

  const displayEnd = addDays(startIso, days);
  // Las KPIs son siempre "de hoy", sin importar qué ventana esté navegando
  // el usuario (Anterior/Siguiente) -- se amplía la consulta para que hoy
  // siempre esté cubierto, pero solo se manda al cliente la ventana visible.
  const coverageStart = startIso < todayIso ? startIso : todayIso;
  const coverageEndExclusive = displayEnd > addDays(todayIso, 1) ? displayEnd : addDays(todayIso, 1);
  const coverageDates = dateRangeArray(coverageStart, coverageEndExclusive);
  const displayDates = dateRangeArray(startIso, displayEnd);

  const { data: rooms, error: roomsError } = await supabase
    .from("rooms")
    .select("id, code, room_type_id, building, bed_type, is_clean, room_types(name)")
    .eq("hotel_id", hotelId)
    .eq("is_active", true)
    .order("code");
  if (roomsError) throw roomsError;

  const { data: reservationStays, error: rsError } = await supabase
    .from("reservation_stays")
    .select("id, room_type_id, check_in, check_out, reservations(status, folio, primary_guest_name)")
    .eq("hotel_id", hotelId)
    .lt("check_in", coverageEndExclusive)
    .gt("check_out", coverageStart);
  if (rsError) throw rsError;

  const confirmedStays = (reservationStays ?? []).filter(
    (rs) => (rs.reservations as unknown as { status: string } | null)?.status === "confirmed",
  );
  const rsIds = confirmedStays.map((rs) => rs.id);

  const { data: staysRows, error: staysError } =
    rsIds.length > 0
      ? await supabase.from("stays").select("id, reservation_stay_id, status").eq("hotel_id", hotelId).in("reservation_stay_id", rsIds)
      : { data: [] as { id: string; reservation_stay_id: string; status: string }[], error: null };
  if (staysError) throw staysError;

  const stayIds = (staysRows ?? []).map((s) => s.id);

  const { data: assignments, error: assignError } =
    stayIds.length > 0
      ? await supabase.from("room_assignments").select("stay_id, room_id").eq("hotel_id", hotelId).is("released_at", null).in("stay_id", stayIds)
      : { data: [] as { stay_id: string; room_id: string }[], error: null };
  if (assignError) throw assignError;

  const { data: blocks, error: blocksError } = await supabase
    .from("inventory_blocks")
    .select("room_id, block_type, stay_date")
    .eq("hotel_id", hotelId)
    .not("room_id", "is", null)
    .gte("stay_date", coverageStart)
    .lt("stay_date", coverageEndExclusive);
  if (blocksError) throw blocksError;

  const stayById = new Map((staysRows ?? []).map((s) => [s.id, s]));
  const reservationStayById = new Map(confirmedStays.map((rs) => [rs.id, rs]));

  const stayIdsByRoom = new Map<string, string[]>();
  const assignmentsByStay = new Map<string, string>();
  for (const a of assignments ?? []) {
    assignmentsByStay.set(a.stay_id, a.room_id);
    const list = stayIdsByRoom.get(a.room_id) ?? [];
    list.push(a.stay_id);
    stayIdsByRoom.set(a.room_id, list);
  }

  const blockIndex = new Map<string, Map<string, string>>();
  for (const b of blocks ?? []) {
    if (!b.room_id) continue;
    const m = blockIndex.get(b.room_id) ?? new Map<string, string>();
    m.set(b.stay_date, b.block_type);
    blockIndex.set(b.room_id, m);
  }

  const arrivalByRoomDate = new Set<string>();
  const departureByRoomDate = new Set<string>();
  for (const rs of confirmedStays) {
    const stay = staysRows?.find((s) => s.reservation_stay_id === rs.id);
    if (!stay) continue;
    const roomId = assignmentsByStay.get(stay.id);
    if (!roomId) continue;
    arrivalByRoomDate.add(`${roomId}:${rs.check_in}`);
    departureByRoomDate.add(`${roomId}:${rs.check_out}`);
  }

  function computeCell(roomId: string, date: string): RackCell {
    const occupyingStayIds = stayIdsByRoom.get(roomId) ?? [];
    let inHouse: { stayId: string; stayStatus: string; reservationStayId: string; guestName: string; folio: string } | null = null;
    let activeMatches = 0;

    for (const stayId of occupyingStayIds) {
      const stay = stayById.get(stayId);
      if (!stay || !ACTIVE_STAY_STATUSES.has(stay.status)) continue;
      const rs = reservationStayById.get(stay.reservation_stay_id);
      if (!rs || date < rs.check_in || date >= rs.check_out) continue;
      activeMatches += 1;
      if (!inHouse) {
        const reservation = rs.reservations as unknown as { folio: string; primary_guest_name: string } | null;
        inHouse = {
          stayId: stay.id,
          stayStatus: stay.status,
          reservationStayId: rs.id,
          guestName: reservation?.primary_guest_name ?? "—",
          folio: reservation?.folio ?? "—",
        };
      }
    }

    const blockTypeHere = blockIndex.get(roomId)?.get(date) ?? null;
    const maintenanceHere = blockTypeHere === "maintenance";
    const blockedHere = blockTypeHere !== null && !maintenanceHere;

    let status: RackCellStatus = "AVAILABLE";
    if (inHouse) status = "IN_HOUSE";
    else if (maintenanceHere) status = "OUT_OF_SERVICE";
    else if (blockedHere) status = "BLOCKED";

    const isConflict = activeMatches > 1 || (Boolean(inHouse) && maintenanceHere);
    const conflictReason = isConflict
      ? activeMatches > 1
        ? "Dos estancias activas asignadas a esta habitación en la misma fecha"
        : "Estancia activa y bloqueo de mantenimiento simultáneos en esta habitación"
      : null;

    return {
      date,
      status,
      isArrival: arrivalByRoomDate.has(`${roomId}:${date}`),
      isDeparture: departureByRoomDate.has(`${roomId}:${date}`),
      isConflict,
      conflictReason,
      stayId: inHouse?.stayId ?? null,
      stayStatus: inHouse?.stayStatus ?? null,
      reservationStayId: inHouse?.reservationStayId ?? null,
      guestName: inHouse?.guestName ?? null,
      folio: inHouse?.folio ?? null,
    };
  }

  const roomTypeSet = new Map<string, string>();
  const rackRooms: RackRoom[] = (rooms ?? []).map((room) => {
    const roomTypeName = (room.room_types as unknown as { name: string } | null)?.name ?? "—";
    roomTypeSet.set(room.room_type_id, roomTypeName);
    const allCells = coverageDates.map((date) => computeCell(room.id, date));
    const cellByDate = new Map(allCells.map((c) => [c.date, c]));
    const todayCell = cellByDate.get(todayIso) ?? computeCell(room.id, todayIso);
    return {
      roomId: room.id,
      code: room.code,
      roomTypeId: room.room_type_id,
      roomTypeName,
      building: room.building,
      bedType: room.bed_type,
      isClean: room.is_clean,
      cells: displayDates.map((date) => cellByDate.get(date)!),
      todayStatus: todayCell.status,
      todayIsArrival: todayCell.isArrival,
      todayIsDeparture: todayCell.isDeparture,
    };
  });

  // KPIs de hoy: se reusa el todayStatus ya calculado por habitación arriba,
  // sin importar la ventana visible que esté navegando el usuario.
  let occupiedToday = 0;
  let arrivalsToday = 0;
  let departuresToday = 0;
  let dirtyRooms = 0;
  let notAvailableToday = 0;
  for (const room of rackRooms) {
    if (!room.isClean) dirtyRooms += 1;
    if (room.todayStatus === "IN_HOUSE") occupiedToday += 1;
    if (room.todayStatus === "OUT_OF_SERVICE" || room.todayStatus === "BLOCKED") notAvailableToday += 1;
    if (room.todayIsArrival) arrivalsToday += 1;
    if (room.todayIsDeparture) departuresToday += 1;
  }
  const totalRooms = rackRooms.length;
  const availableToday = Math.max(totalRooms - occupiedToday - notAvailableToday, 0);

  // Reservas confirmadas sin habitación física asignada todavía (a cualquier
  // fecha futura/en curso, no solo la ventana visible) -- ver CLAUDE.md:
  // reservation_stays.room_id nunca se escribe hoy, así que "sin asignar" se
  // define por ausencia de room_assignments activo, no por esa columna.
  const { data: futureReservationStays, error: futureError } = await supabase
    .from("reservation_stays")
    .select("id, room_type_id, check_in, check_out, room_types(name), reservations(status, folio, primary_guest_name)")
    .eq("hotel_id", hotelId)
    .gte("check_out", todayIso);
  if (futureError) throw futureError;

  const confirmedFuture = (futureReservationStays ?? []).filter(
    (rs) => (rs.reservations as unknown as { status: string } | null)?.status === "confirmed",
  );
  const futureIds = confirmedFuture.map((rs) => rs.id);

  const { data: futureStays, error: futureStaysError } =
    futureIds.length > 0
      ? await supabase.from("stays").select("id, reservation_stay_id, status").eq("hotel_id", hotelId).in("reservation_stay_id", futureIds)
      : { data: [] as { id: string; reservation_stay_id: string; status: string }[], error: null };
  if (futureStaysError) throw futureStaysError;

  const futureStayByRs = new Map((futureStays ?? []).map((s) => [s.reservation_stay_id, s]));
  const futureStayIds = (futureStays ?? []).map((s) => s.id);

  const { data: futureAssignments, error: futureAssignError } =
    futureStayIds.length > 0
      ? await supabase.from("room_assignments").select("stay_id").eq("hotel_id", hotelId).is("released_at", null).in("stay_id", futureStayIds)
      : { data: [] as { stay_id: string }[], error: null };
  if (futureAssignError) throw futureAssignError;
  const assignedStaySet = new Set((futureAssignments ?? []).map((a) => a.stay_id));

  const unassigned: UnassignedReservation[] = confirmedFuture
    .map((rs) => ({ rs, stay: futureStayByRs.get(rs.id) }))
    .filter(
      (x): x is { rs: (typeof confirmedFuture)[number]; stay: { id: string; reservation_stay_id: string; status: string } } =>
        Boolean(x.stay) && !assignedStaySet.has(x.stay!.id) && !["checked_out", "no_show", "walked"].includes(x.stay!.status),
    )
    .map(({ rs, stay }) => {
      const reservation = rs.reservations as unknown as { folio: string; primary_guest_name: string } | null;
      return {
        stayId: stay.id,
        reservationStayId: rs.id,
        folio: reservation?.folio ?? "—",
        guestName: reservation?.primary_guest_name ?? "—",
        roomTypeId: rs.room_type_id,
        roomTypeName: (rs.room_types as unknown as { name: string } | null)?.name ?? "—",
        checkIn: rs.check_in,
        checkOut: rs.check_out,
        status: stay.status,
      };
    })
    .sort((a, b) => a.checkIn.localeCompare(b.checkIn));

  return {
    dateRange: displayDates,
    todayIso,
    rooms: rackRooms,
    roomTypes: [...roomTypeSet.entries()].map(([id, name]) => ({ id, name })),
    unassigned,
    kpis: {
      totalRooms,
      availableToday: Math.max(availableToday, 0),
      occupiedToday,
      arrivalsToday,
      departuresToday,
      dirtyRooms,
      unassignedReservations: unassigned.length,
    },
  };
}

/**
 * Habitaciones activas de un tipo, sin asignación activa a otra estancia --
 * usada solo para poblar el selector de la sección "Reservas sin asignar".
 * Es la misma consulta de 5 líneas que ya existe en
 * modules/recepcion/queries/stays.ts (listAssignableRooms); se repite aquí
 * en vez de importarla porque los módulos no se importan entre sí (regla 7
 * de CLAUDE.md) -- mismo criterio ya documentado para las políticas del
 * hotel en Configuración.
 */
export async function listAssignableRoomsForType(hotelId: string, roomTypeId: string) {
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
