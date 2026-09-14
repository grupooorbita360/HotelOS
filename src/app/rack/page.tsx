import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, getCurrentUserHotel } from "@/lib/auth/session";
import { signOut } from "@/app/login/actions";
import { formatDate } from "@/lib/format";
import { getHotelBusinessDate } from "@/lib/getHotelBusinessDate";
import { getRackGrid, listAssignableRoomsForType } from "@/modules/rack/queries/grid";
import { RackGrid } from "@/modules/rack/components/RackGrid";
import { Card, CardTitle } from "@/components/ui/Card";
import { Field, Select } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { KpiCard } from "@/components/ui/KpiCard";
import { AppShell } from "@/components/ui/AppShell";
import { submitAssignUnassigned } from "./actions";

const VALID_DAYS = [7, 14, 30] as const;
type FocusFilter = "all" | "available" | "occupied" | "arrivals" | "departures" | "dirty";

function shiftDate(iso: string, n: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function rackHref(params: Record<string, string | number | undefined>) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "" && v !== "all") qs.set(k, String(v));
  }
  const s = qs.toString();
  return `/rack${s ? `?${s}` : ""}`;
}

export default async function RackPage({
  searchParams,
}: {
  searchParams: Promise<{ start?: string; days?: string; tipo?: string; focus?: string; error?: string }>;
}) {
  const params = await searchParams;

  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const hotel = await getCurrentUserHotel();
  if (!hotel) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <Card className="max-w-lg space-y-4">
          <CardTitle>Tu cuenta no tiene un hotel asignado todavía</CardTitle>
          <form action={signOut}>
            <Button variant="ghost">Cerrar sesión</Button>
          </form>
        </Card>
      </div>
    );
  }

  // Fecha operativa del hotel (su timezone, no UTC/navegador) -- ver CLAUDE.md.
  const todayIso = await getHotelBusinessDate(hotel.hotelId);
  const start = params.start && /^\d{4}-\d{2}-\d{2}$/.test(params.start) ? params.start : todayIso;
  const days = (VALID_DAYS as readonly number[]).includes(Number(params.days)) ? Number(params.days) : 7;
  const focus = (params.focus as FocusFilter) || "all";
  const tipo = params.tipo || "";

  const data = await getRackGrid(hotel.hotelId, start, days);

  const filteredRooms = data.rooms.filter((room) => {
    if (tipo && room.roomTypeId !== tipo) return false;
    switch (focus) {
      case "available":
        return room.todayStatus === "AVAILABLE";
      case "occupied":
        return room.todayStatus === "IN_HOUSE";
      case "arrivals":
        return room.todayIsArrival;
      case "departures":
        return room.todayIsDeparture;
      case "dirty":
        return !room.isClean;
      default:
        return true;
    }
  });

  // Habitaciones asignables por tipo, solo para los tipos que de verdad
  // aparecen en la lista de reservas sin asignar (evita consultas de más).
  const roomTypesNeeded = [...new Set(data.unassigned.map((u) => u.roomTypeId))];
  const assignableByType = new Map(
    await Promise.all(
      roomTypesNeeded.map(async (id) => [id, await listAssignableRoomsForType(hotel.hotelId, id)] as const),
    ),
  );

  const backParams = { start, days, tipo, focus };

  return (
    <AppShell hotelName={hotel.hotelName} roleName={hotel.roleName} current="rack" resetHref="/rack" brandColor={hotel.brandColor} maxWidthClassName="max-w-7xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">Rack</h1>
      </div>

      {params.error && <Banner tone="danger">{params.error}</Banner>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <Link href={rackHref({ ...backParams, focus: "all" })}>
          <KpiCard label="Habitaciones totales" value={data.kpis.totalRooms} />
        </Link>
        <Link href={rackHref({ ...backParams, focus: "available" })}>
          <KpiCard label="Disponibles hoy" value={data.kpis.availableToday} />
        </Link>
        <Link href={rackHref({ ...backParams, focus: "occupied" })}>
          <KpiCard label="Ocupadas hoy" value={data.kpis.occupiedToday} />
        </Link>
        <Link href={rackHref({ ...backParams, focus: "arrivals" })}>
          <KpiCard label="Llegadas hoy" value={data.kpis.arrivalsToday} />
        </Link>
        <Link href={rackHref({ ...backParams, focus: "departures" })}>
          <KpiCard label="Salidas hoy" value={data.kpis.departuresToday} />
        </Link>
        <Link href={rackHref({ ...backParams, focus: "dirty" })}>
          <KpiCard label="Por limpiar" value={data.kpis.dirtyRooms} />
        </Link>
        <Link href="#reservas-sin-asignar">
          <KpiCard label="Reservas sin asignar" value={data.kpis.unassignedReservations} />
        </Link>
      </div>

      <Card className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Link href={rackHref({ ...backParams, start: shiftDate(start, -days) })}>
              <Button variant="secondary">← Anterior</Button>
            </Link>
            <Link href={rackHref({ ...backParams, start: todayIso })}>
              <Button variant="secondary">Hoy</Button>
            </Link>
            <Link href={rackHref({ ...backParams, start: shiftDate(start, days) })}>
              <Button variant="secondary">Siguiente →</Button>
            </Link>
            <span className="text-muted">
              {formatDate(data.dateRange[0])} → {formatDate(data.dateRange[data.dateRange.length - 1])}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {VALID_DAYS.map((d) => (
              <Link key={d} href={rackHref({ ...backParams, days: d })}>
                <Button variant={d === days ? "primary" : "secondary"} className="px-3 py-1.5 text-xs">
                  {d} días
                </Button>
              </Link>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-strong">Mostrar:</span>
          <Link href={rackHref({ ...backParams, tipo: "" })}>
            <span className={`rounded-full px-3 py-1 ${!tipo ? "bg-brand text-white" : "bg-border text-muted-strong"}`}>Todos los tipos</span>
          </Link>
          {data.roomTypes.map((rt) => (
            <Link key={rt.id} href={rackHref({ ...backParams, tipo: rt.id })}>
              <span className={`rounded-full px-3 py-1 ${tipo === rt.id ? "bg-brand text-white" : "bg-border text-muted-strong"}`}>{rt.name}</span>
            </Link>
          ))}
          {focus !== "all" && (
            <Link href={rackHref({ ...backParams, focus: "all" })} className="ml-2 underline text-brand">
              Quitar filtro &quot;{focus}&quot;
            </Link>
          )}
        </div>

        <RackGrid hotelId={hotel.hotelId} dateRange={data.dateRange} rooms={filteredRooms} todayIso={data.todayIso} />
      </Card>

      <div id="reservas-sin-asignar">
        <Card className="space-y-3">
          <CardTitle>Reservas confirmadas sin habitación asignada ({data.unassigned.length})</CardTitle>
          <p className="text-muted">
            Reservas ya confirmadas por Reservaciones que todavía no tienen una habitación física concreta. Asígnalas
            aquí directamente, o desde Recepción al momento del check-in.
          </p>

          <div className="space-y-2">
            {data.unassigned.map((u) => {
              const options = assignableByType.get(u.roomTypeId) ?? [];
              return (
                <div key={u.stayId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
                  <div>
                    <b>{u.guestName}</b> <span className="text-muted">· Folio {u.folio}</span>
                    <p className="text-muted">
                      {u.roomTypeName} · {formatDate(u.checkIn)} → {formatDate(u.checkOut)}
                    </p>
                  </div>
                  <form action={submitAssignUnassigned} className="flex items-center gap-2">
                    <input type="hidden" name="hotelId" value={hotel.hotelId} />
                    <input type="hidden" name="stayId" value={u.stayId} />
                    <input type="hidden" name="start" value={start} />
                    <input type="hidden" name="days" value={days} />
                    <input type="hidden" name="tipo" value={tipo} />
                    <input type="hidden" name="focus" value={focus} />
                    <Field label="">
                      <Select name="roomId" required defaultValue="" className="min-w-[160px]">
                        <option value="" disabled>
                          Elige habitación…
                        </option>
                        {options.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.code} {o.is_clean ? "" : "(sucia)"}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Button disabled={options.length === 0}>Asignar</Button>
                  </form>
                </div>
              );
            })}
            {data.unassigned.length === 0 && <p className="text-muted">No hay reservas pendientes de asignación.</p>}
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
