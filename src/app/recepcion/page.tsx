import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, getCurrentUserHotel } from "@/lib/auth/session";
import { getHotelFeatures } from "@/lib/auth/platform";
import { signOut } from "@/app/login/actions";
import { formatDateRange, formatBalanceLabel } from "@/lib/format";
import {
  listStays,
  getStayDetails,
  listRoomAssignmentOptions,
  listRoomChangeOptions,
  getHotelCheckinAssets,
  getRoomTypeHousekeepingSummary,
  listOpenGuestRequests,
  listOpenIncidents,
} from "@/modules/recepcion/queries/stays";
import { Card, CardTitle } from "@/components/ui/Card";
import { Field, TextInput, Select } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { Badge } from "@/components/ui/Badge";
import { KpiCard } from "@/components/ui/KpiCard";
import { StayStatusBadge, nextActionLabel, ServiceItemStatusBadge } from "@/components/ui/Badge";
import { AppShell } from "@/components/ui/AppShell";
import {
  submitRegisterArrival,
  submitAssignRoom,
  submitCheckInWithRoom,
  submitDeliverRoom,
  submitMarkNoShow,
  submitMarkWalked,
  submitUndoWalked,
  submitCheckOut,
  submitRegisterTransaction,
  submitVoidTransaction,
  submitCreateGuestRequest,
  submitResolveGuestRequest,
  submitAssignGuestRequest,
  submitStartGuestRequestProgress,
  submitCreateIncident,
  submitResolveIncident,
  submitAssignIncident,
  submitStartIncidentProgress,
  submitSetAsset,
  submitChangeRoom,
} from "./actions";

export default async function RecepcionPage({
  searchParams,
}: {
  searchParams: Promise<{
    stayId?: string;
    error?: string;
    checkinStep?: string;
    roomChangeStep?: string;
    filter?: string;
    showCheckedOut?: string;
  }>;
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

  if (hotel.status === "suspended" || hotel.status === "canceled") redirect("/suspendido");

  const features = await getHotelFeatures(hotel.hotelId);
  if (!features.has("module.recepcion")) {
    return (
      <AppShell
        hotelId={hotel.hotelId}
        hotelName={hotel.hotelName}
        userDisplayName={hotel.userDisplayName}
        roleName={hotel.roleName}
        current="recepcion"
        resetHref="/recepcion"
        brandColor={hotel.brandColor}
        brandLogoUrl={hotel.brandLogoUrl}
        otherHotels={hotel.otherHotels}
        features={[...features]}
      >
        <Card className="space-y-3">
          <CardTitle>Recepción no está incluido en tu plan</CardTitle>
          <p className="text-sm text-muted-strong">
            Este módulo está deshabilitado para tu hotel. Contacta a Órbita 360 para actualizar tu plan.
          </p>
        </Card>
      </AppShell>
    );
  }

  const allStays = await listStays(hotel.hotelId);
  // P1-7 (handoff de demo P1 Tanda 2): una sola pasada para todo el hotel,
  // reusada por cada fila de la lista -- no una consulta por llegada.
  const housekeepingByRoomType = await getRoomTypeHousekeepingSummary(hotel.hotelId);
  // P2-3 (enrutamiento de solicitudes/incidencias): a nivel hotel, no por
  // estancia -- lo que hace falta para que Recepción/Gerencia vean todo lo
  // abierto sin entrar estancia por estancia.
  const openGuestRequests = await listOpenGuestRequests(hotel.hotelId);
  const openIncidents = await listOpenIncidents(hotel.hotelId);
  const counts = {
    expected: allStays.filter((s) => s.status === "expected").length,
    inHouse: allStays.filter((s) => s.status === "in_house").length,
    pendingAction: allStays.filter((s) => s.next_action !== "ninguna" && !["checked_out", "no_show", "walked"].includes(s.status)).length,
  };

  // P1-1/P1-3 (handoff de demo): las 3 KPI ahora navegan a la misma lista
  // filtrada por estado/acción -- ?filter=expected|in_house|pending, sin
  // valor = todas. Por defecto (sin filtro elegido) las estancias con
  // check-out ya hecho quedan ocultas -- no perdidas, sólo no visibles de
  // entrada -- con un link para mostrarlas (?showCheckedOut=1). Dentro de lo
  // que queda visible, las que tienen una acción pendiente van primero.
  const showCheckedOut = params.showCheckedOut === "1" || params.filter === "checked_out";
  const filter = params.filter ?? "";
  const filteredStays = allStays.filter((s) => {
    if (!showCheckedOut && s.status === "checked_out" && filter !== "checked_out") return false;
    if (filter === "expected") return s.status === "expected";
    if (filter === "in_house") return s.status === "in_house";
    if (filter === "pending") return s.next_action !== "ninguna" && !["checked_out", "no_show", "walked"].includes(s.status);
    if (filter === "checked_out") return s.status === "checked_out";
    return true;
  });
  const stays = [...filteredStays].sort((a, b) => {
    const aPending = a.next_action !== "ninguna" && !["checked_out", "no_show", "walked"].includes(a.status) ? 0 : 1;
    const bPending = b.next_action !== "ninguna" && !["checked_out", "no_show", "walked"].includes(b.status) ? 0 : 1;
    return aPending - bPending;
  });
  const hiddenCheckedOutCount = !showCheckedOut ? allStays.filter((s) => s.status === "checked_out").length : 0;

  const detail = params.stayId ? await getStayDetails(hotel.hotelId, params.stayId) : null;

  // Estado de cuenta -- Saldo siempre viene de stay_accounts.balance (fuente
  // real); Hospedaje/Extras/Pagado son un desglose informativo derivado de
  // datos ya cargados, nunca recalculan el saldo mostrado.
  const rateTotal = Number(detail?.stay.reservation_stays?.rate_total ?? 0);

  const needsRoomOptions =
    !!detail &&
    !detail.activeAssignment &&
    (detail.stay.status === "arrived" || detail.stay.status === "checked_in");
  const nights =
    detail && detail.stay.reservation_stays
      ? Math.max(
          1,
          Math.round(
            (new Date(detail.stay.reservation_stays.check_out).getTime() -
              new Date(detail.stay.reservation_stays.check_in).getTime()) /
              86400000,
          ),
        )
      : 1;
  // La tarifa POR NOCHE realmente vendida -- no room_types.base_rate, que
  // puede haberse editado en Configuración después de confirmar esta
  // reserva (auditoría de precio, Tier 1, ver CLAUDE.md).
  const soldNightlyRate = rateTotal / nights;
  const roomOptions = needsRoomOptions
    ? await listRoomAssignmentOptions(hotel.hotelId, detail!.stay.reservation_stays!.room_type_id, nights, soldNightlyRate)
    : [];
  const equivalentOptions = roomOptions.filter((o) => o.kind === "equivalente");
  const upgradeOptions = roomOptions.filter((o) => o.kind === "upgrade");

  // P0-3/P0-5 (handoff de demo): opciones para el cambio de habitación
  // autorizado DESPUÉS del check-in -- el tipo "actual" es el de la
  // habitación asignada si existe, o si no, el tipo vendido (mismo
  // fallback que change_room_with_authorization(), 0051).
  const needsRoomChangeOptions =
    !!detail &&
    params.roomChangeStep === "1" &&
    (detail.stay.status === "checked_in" || detail.stay.status === "in_house");
  const currentRoomTypeId =
    (detail?.activeAssignment?.rooms as unknown as { room_type_id: string } | null)?.room_type_id ??
    detail?.stay.reservation_stays?.room_type_id ??
    "";
  const roomChangeOptions = needsRoomChangeOptions
    ? await listRoomChangeOptions(hotel.hotelId, currentRoomTypeId)
    : [];
  const equivalentChangeOptions = roomChangeOptions.filter((o) => o.kind === "equivalente");
  const upgradeChangeOptions = roomChangeOptions.filter((o) => o.kind === "upgrade");
  const downgradeChangeOptions = roomChangeOptions.filter((o) => o.kind === "downgrade");

  const checkinAssets = detail ? await getHotelCheckinAssets(hotel.hotelId) : [];

  const extrasCharged = detail
    ? detail.transactions.filter((t) => t.type === "charge").reduce((sum, t) => sum + Number(t.amount), 0)
    : 0;
  const totalPagado = detail
    ? -detail.transactions.filter((t) => t.type === "payment").reduce((sum, t) => sum + Number(t.amount), 0)
    : 0;

  // P0-8 (handoff de demo): total cargos/total abonos de TODA la cuenta
  // (no sólo "extras" como arriba) -- se derivan del signo real de cada
  // transacción (positivo = se le suma a lo que debe, negativo = se le
  // resta), no del tipo -- así cubre charge/refund/payment/adjustment por
  // igual, sin tener que listar tipos a mano.
  const totalCargos = detail
    ? detail.transactions.filter((t) => Number(t.amount) > 0).reduce((sum, t) => sum + Number(t.amount), 0)
    : 0;
  const totalAbonos = detail
    ? -detail.transactions.filter((t) => Number(t.amount) < 0).reduce((sum, t) => sum + Number(t.amount), 0)
    : 0;

  return (
    <AppShell
      hotelId={hotel.hotelId}
      hotelName={hotel.hotelName}
      userDisplayName={hotel.userDisplayName}
      roleName={hotel.roleName}
      current="recepcion"
      resetHref="/recepcion"
      brandColor={hotel.brandColor}
      brandLogoUrl={hotel.brandLogoUrl}
      otherHotels={hotel.otherHotels}
      maxWidthClassName="max-w-6xl"
      features={[...features]}
    >
      <h1 className="text-xl font-bold text-foreground">Recepción</h1>

        {/* P1-1 (handoff de demo): sticky (queda visible al hacer scroll) +
            cada KPI navega a la lista filtrada correspondiente. El fondo
            propio evita que la lista se transparente al pasar por debajo. */}
        <div className="sticky top-0 z-[5] -mx-6 grid grid-cols-3 gap-4 bg-background px-6 pb-3 pt-1">
          <KpiCard label="Llegadas esperadas" value={counts.expected} href="/recepcion?filter=expected" />
          <KpiCard label="En casa" value={counts.inHouse} href="/recepcion?filter=in_house" />
          <KpiCard label="Con acción pendiente" value={counts.pendingAction} href="/recepcion?filter=pending" />
        </div>

        {params.error && <Banner tone="danger">{params.error}</Banner>}

        {/* P2-3 (enrutamiento de solicitudes/incidencias): vista a nivel
            hotel, para que Recepción/Gerencia vean todo lo abierto sin
            entrar estancia por estancia. Sólo enruta (asignar área +
            marcar en curso) -- resolver sigue siendo desde el detalle de
            la estancia, ya construido. */}
        {(openGuestRequests.length > 0 || openIncidents.length > 0) && (
          <Card className="space-y-3">
            <CardTitle>
              Solicitudes e incidencias abiertas del hotel ({openGuestRequests.length + openIncidents.length})
            </CardTitle>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase text-muted">Solicitudes ({openGuestRequests.length})</p>
                {openGuestRequests.length === 0 && <p className="text-muted">Ninguna abierta.</p>}
                {openGuestRequests.map((r) => (
                  <div key={r.id} className="space-y-1 rounded-lg bg-brand-soft p-2">
                    <div className="flex items-center justify-between">
                      <Link href={`/recepcion?stayId=${r.stayId}`} className="font-medium hover:underline">
                        {r.guestName}
                      </Link>
                      <ServiceItemStatusBadge status={r.status} />
                    </div>
                    <p>{r.description}</p>
                    {r.assignedArea ? (
                      <div className="flex items-center justify-between text-xs text-muted">
                        <span>→ {r.assignedArea === "housekeeping" ? "Housekeeping" : "Mantenimiento"}</span>
                        {r.status !== "in_progress" && (
                          <form action={submitStartGuestRequestProgress}>
                            <input type="hidden" name="hotelId" value={hotel.hotelId} />
                            <input type="hidden" name="stayId" value={r.stayId} />
                            <input type="hidden" name="requestId" value={r.id} />
                            <Button variant="ghost" className="text-xs">
                              marcar en curso
                            </Button>
                          </form>
                        )}
                      </div>
                    ) : (
                      <form action={submitAssignGuestRequest} className="flex items-center gap-2">
                        <input type="hidden" name="hotelId" value={hotel.hotelId} />
                        <input type="hidden" name="stayId" value={r.stayId} />
                        <input type="hidden" name="requestId" value={r.id} />
                        <Select name="assignedArea" defaultValue="housekeeping" className="flex-1 text-xs">
                          <option value="housekeeping">Housekeeping</option>
                          <option value="maintenance">Mantenimiento</option>
                        </Select>
                        <Button variant="ghost" className="text-xs">
                          enviar
                        </Button>
                      </form>
                    )}
                  </div>
                ))}
              </div>
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase text-muted">Incidencias ({openIncidents.length})</p>
                {openIncidents.length === 0 && <p className="text-muted">Ninguna abierta.</p>}
                {openIncidents.map((i) => (
                  <div key={i.id} className="space-y-1 rounded-lg bg-warning-soft p-2">
                    <div className="flex items-center justify-between">
                      <Link href={`/recepcion?stayId=${i.stayId}`} className="font-medium hover:underline">
                        {i.guestName}
                      </Link>
                      <ServiceItemStatusBadge status={i.status} />
                    </div>
                    <p>{i.description}</p>
                    {i.assignedArea ? (
                      <div className="flex items-center justify-between text-xs text-muted">
                        <span>→ {i.assignedArea === "housekeeping" ? "Housekeeping" : "Mantenimiento"}</span>
                        {i.status !== "in_progress" && (
                          <form action={submitStartIncidentProgress}>
                            <input type="hidden" name="hotelId" value={hotel.hotelId} />
                            <input type="hidden" name="stayId" value={i.stayId} />
                            <input type="hidden" name="incidentId" value={i.id} />
                            <Button variant="ghost" className="text-xs">
                              marcar en curso
                            </Button>
                          </form>
                        )}
                      </div>
                    ) : (
                      <form action={submitAssignIncident} className="flex items-center gap-2">
                        <input type="hidden" name="hotelId" value={hotel.hotelId} />
                        <input type="hidden" name="stayId" value={i.stayId} />
                        <input type="hidden" name="incidentId" value={i.id} />
                        <Select name="assignedArea" defaultValue="maintenance" className="flex-1 text-xs">
                          <option value="housekeeping">Housekeeping</option>
                          <option value="maintenance">Mantenimiento</option>
                        </Select>
                        <Button variant="ghost" className="text-xs">
                          enviar
                        </Button>
                      </form>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </Card>
        )}

        <div className="grid grid-cols-3 gap-6">
          {/* Lista de estancias */}
          <Card className="col-span-1 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <CardTitle>Estancias ({stays.length})</CardTitle>
              {filter && (
                <Link href="/recepcion" className="text-xs text-brand underline">
                  Ver todas
                </Link>
              )}
            </div>
            {/* P1-3 (handoff de demo): check-out ya hecho no desaparece para
                siempre -- sólo no se ve de entrada, con opción de mostrarlas. */}
            {hiddenCheckedOutCount > 0 && (
              <Link
                href={`/recepcion?${filter ? `filter=${filter}&` : ""}showCheckedOut=1`}
                className="block text-xs text-muted underline"
              >
                Mostrar {hiddenCheckedOutCount} con check-out ya hecho
              </Link>
            )}
            {showCheckedOut && filter !== "checked_out" && (
              <Link href={`/recepcion${filter ? `?filter=${filter}` : ""}`} className="block text-xs text-muted underline">
                Ocultar check-out ya hecho
              </Link>
            )}
            <div className="max-h-[70vh] space-y-2 overflow-auto">
              {stays.map((s) => {
                const rs = s.reservation_stays!;
                const res = rs.reservations!;
                // P1-7 (handoff de demo P1 Tanda 2): para una llegada todavía sin
                // habitación (expected/arrived), la disponibilidad real de su tipo
                // -- limpia/sucia/sin unidades -- no sólo "libre".
                const hk = ["expected", "arrived"].includes(s.status) ? housekeepingByRoomType.get(rs.room_type_id) : undefined;
                return (
                  <Link
                    key={s.id}
                    href={`/recepcion?stayId=${s.id}`}
                    className={`block rounded-lg border p-3 hover:border-brand ${
                      params.stayId === s.id ? "border-brand bg-brand-soft" : "border-border"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <b>{res.primary_guest_name}</b>
                      <StayStatusBadge status={s.status} />
                    </div>
                    <p className="text-muted">
                      {rs.room_types?.name} · {formatDateRange(rs.check_in, rs.check_out)}
                    </p>
                    <p className="text-xs font-medium text-brand">{nextActionLabel(s.next_action)}</p>
                    {hk && (
                      <p className="mt-1">
                        {hk.clean > 0 ? (
                          <Badge tone="success">{`${hk.clean} limpia(s) lista(s)`}</Badge>
                        ) : hk.dirty > 0 ? (
                          <Badge tone="warning">{`Sólo sucia(s) disponible(s) (${hk.dirty})`}</Badge>
                        ) : (
                          <Badge tone="danger">Sin habitación libre de este tipo</Badge>
                        )}
                      </p>
                    )}
                    {(s.stay_accounts?.balance ?? 0) > 0 && (
                      <p className="text-xs text-danger">{formatBalanceLabel(s.stay_accounts?.balance ?? 0)}</p>
                    )}
                  </Link>
                );
              })}
              {stays.length === 0 && (
                <p className="text-muted">
                  No hay estancias todavía. Confirma una reserva en{" "}
                  <Link href="/reservaciones" className="underline">
                    Reservaciones
                  </Link>{" "}
                  para que aparezca aquí automáticamente.
                </p>
              )}
            </div>
          </Card>

          {/* Detalle de la estancia seleccionada */}
          <div className="col-span-2 space-y-4">
            {!detail ? (
              <Card>
                <p className="text-muted">Selecciona una estancia de la lista para ver su detalle.</p>
              </Card>
            ) : (
              <>
                <Card className="space-y-3">
                  <div className="flex items-center justify-between">
                    <CardTitle>{detail.stay.reservation_stays!.reservations!.primary_guest_name}</CardTitle>
                    <StayStatusBadge status={detail.stay.status} />
                  </div>
                  <p className="text-muted">
                    Folio {detail.stay.reservation_stays!.reservations!.folio} ·{" "}
                    {detail.stay.reservation_stays!.room_types?.name} ·{" "}
                    {formatDateRange(detail.stay.reservation_stays!.check_in, detail.stay.reservation_stays!.check_out)}
                  </p>
                  <p>
                    Próxima acción: <strong className="text-brand">{nextActionLabel(detail.stay.next_action)}</strong>
                  </p>
                  {/* P1-5 (handoff de demo): "Sin acción pendiente" cubre dos
                      situaciones distintas (huésped en casa con cuenta al
                      corriente vs. estancia ya cerrada) -- se aclara cuál es
                      cuál en vez de renombrar el estado (el badge de arriba
                      ya distingue el status real). */}
                  {detail.stay.next_action === "ninguna" && (
                    <p className="text-xs text-muted">
                      {detail.stay.status === "in_house"
                        ? "El huésped ya está en casa, con habitación y cuenta al corriente — nada que hacer hasta su check-out."
                        : "Esta estancia ya terminó su ciclo — no aplica ninguna acción adicional."}
                    </p>
                  )}

                  <div className="flex flex-wrap gap-2 pt-2">
                    {detail.stay.status === "expected" && (
                      <>
                        <form action={submitRegisterArrival}>
                          <input type="hidden" name="hotelId" value={hotel.hotelId} />
                          <input type="hidden" name="stayId" value={detail.stay.id} />
                          <Button>Registrar llegada</Button>
                        </form>
                        <form action={submitMarkNoShow}>
                          <input type="hidden" name="hotelId" value={hotel.hotelId} />
                          <input type="hidden" name="stayId" value={detail.stay.id} />
                          <Button variant="danger">Marcar No-Show</Button>
                        </form>
                      </>
                    )}
                    {/* P1-4 (handoff de demo P1 Tanda 2): "Marcar Walked" dejó de ser
                        el único botón (prominente, en rojo) para una llegada -- se
                        movió al final del flujo guiado de check-in, como último
                        recurso, ver más abajo. */}
                    {detail.stay.status === "walked" && (
                      <form action={submitUndoWalked}>
                        <input type="hidden" name="hotelId" value={hotel.hotelId} />
                        <input type="hidden" name="stayId" value={detail.stay.id} />
                        <Button variant="secondary" title="Regresa la estancia a 'Llegó, falta check-in' -- para cuando se marcó Walked por error.">
                          Deshacer Walked
                        </Button>
                      </form>
                    )}
                    {detail.stay.status === "checked_in" && detail.activeAssignment && (
                      <form action={submitDeliverRoom}>
                        <input type="hidden" name="hotelId" value={hotel.hotelId} />
                        <input type="hidden" name="stayId" value={detail.stay.id} />
                        <Button>Entregar habitación {detail.activeAssignment.rooms?.code}</Button>
                      </form>
                    )}
                    {detail.stay.status === "in_house" && (
                      <form action={submitCheckOut}>
                        <input type="hidden" name="hotelId" value={hotel.hotelId} />
                        <input type="hidden" name="stayId" value={detail.stay.id} />
                        <Button>Hacer check-out</Button>
                      </form>
                    )}
                    {/* P0-5 (handoff de demo): "Cambio de habitación" sólo para una
                        estancia activa que ya tiene check-in -- nunca antes. */}
                    {(detail.stay.status === "checked_in" || detail.stay.status === "in_house") && (
                      <Link href={`/recepcion?stayId=${detail.stay.id}&roomChangeStep=1`}>
                        <Button variant="secondary">Cambio de habitación</Button>
                      </Link>
                    )}
                  </div>
                </Card>

                {/* Flujo guiado de check-in: Recibir a {guest} — 1. Cuenta / 2. Habitación */}
                {detail.stay.status === "arrived" && (
                  <Card className="space-y-4">
                    <CardTitle>
                      Recibir a {detail.stay.reservation_stays!.reservations!.primary_guest_name} —{" "}
                      {params.checkinStep === "habitacion" ? "2. Habitación" : "1. Cuenta"}
                    </CardTitle>

                    {params.checkinStep !== "habitacion" ? (
                      <>
                        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                          <div>
                            <p className="text-xs uppercase text-muted">Hospedaje</p>
                            <p className="font-semibold text-foreground">${rateTotal}</p>
                          </div>
                          <div>
                            <p className="text-xs uppercase text-muted">Extras y consumos</p>
                            <p className="font-semibold text-foreground">${extrasCharged}</p>
                          </div>
                          <div>
                            <p className="text-xs uppercase text-muted">Pagado</p>
                            <p className="font-semibold text-foreground">${totalPagado}</p>
                          </div>
                          <div>
                            <p className="text-xs uppercase text-muted">Saldo</p>
                            <p className={`font-semibold ${(detail.stay.stay_accounts?.balance ?? 0) > 0 ? "text-danger" : "text-brand"}`}>
                              {formatBalanceLabel(detail.stay.stay_accounts?.balance ?? 0)}
                            </p>
                          </div>
                        </div>

                        {(detail.stay.stay_accounts?.balance ?? 0) > 0 ? (
                          <Banner tone="warning">{`Saldo pendiente: $${detail.stay.stay_accounts?.balance}.`}</Banner>
                        ) : (
                          <Banner tone="success">Cuenta al corriente.</Banner>
                        )}

                        <form action={submitRegisterTransaction} className="flex flex-wrap items-end gap-3 border-t border-border pt-3">
                          <input type="hidden" name="hotelId" value={hotel.hotelId} />
                          <input type="hidden" name="stayId" value={detail.stay.id} />
                          <input type="hidden" name="type" value="payment" />
                          <input type="hidden" name="concept" value="Pago en check-in" />
                          <Field label="Registrar pago">
                            <TextInput name="amount" type="number" min={0.01} step="0.01" defaultValue={detail.stay.stay_accounts?.balance || undefined} />
                          </Field>
                          <Field label="Método">
                            <Select name="method" defaultValue="cash">
                              <option value="cash">Efectivo</option>
                              <option value="card">Tarjeta</option>
                              <option value="transfer">Transferencia</option>
                            </Select>
                          </Field>
                          <Button>Registrar pago</Button>
                        </form>

                        <Link href={`/recepcion?stayId=${detail.stay.id}&checkinStep=habitacion`}>
                          <Button>Continuar a Habitación</Button>
                        </Link>
                      </>
                    ) : (
                      <>
                        {roomOptions.length === 0 ? (
                          <Banner tone="warning">No hay habitaciones libres ahora mismo.</Banner>
                        ) : (
                          <form action={submitCheckInWithRoom} className="space-y-3">
                            <input type="hidden" name="hotelId" value={hotel.hotelId} />
                            <input type="hidden" name="stayId" value={detail.stay.id} />
                            <Field label="Habitación">
                              <Select name="roomId" required>
                                {equivalentOptions.length > 0 && (
                                  <optgroup label="Equivalente (sin costo adicional)">
                                    {equivalentOptions.map((o) => (
                                      <option key={o.id} value={o.id}>
                                        {o.code} · {o.roomTypeName}
                                        {o.building ? ` · ${o.building}` : ""}
                                        {o.bedType ? ` · ${o.bedType}` : ""}
                                        {o.isClean ? "" : " (sucia)"}
                                      </option>
                                    ))}
                                  </optgroup>
                                )}
                                {upgradeOptions.length > 0 && (
                                  <optgroup label="Upgrade disponible">
                                    {upgradeOptions.map((o) => (
                                      <option key={o.id} value={o.id}>
                                        {o.code} · {o.roomTypeName} — +${o.priceDiff}
                                        {o.building ? ` · ${o.building}` : ""}
                                        {o.bedType ? ` · ${o.bedType}` : ""}
                                        {o.isClean ? "" : " (sucia)"}
                                      </option>
                                    ))}
                                  </optgroup>
                                )}
                              </Select>
                            </Field>
                            <p className="text-xs text-muted">
                              Un upgrade cobra la diferencia de tarifa automáticamente a la cuenta de la estancia.
                            </p>
                            <Button>Asignar habitación y hacer Check-In</Button>
                          </form>
                        )}
                        <Link href={`/recepcion?stayId=${detail.stay.id}`} className="text-muted underline">
                          Regresar a Cuenta
                        </Link>
                      </>
                    )}

                    {/* P1-4 (handoff de demo P1 Tanda 2): último recurso del flujo de
                        llegada, no el primero -- antes era el único botón visible
                        (rojo, prominente) para una estancia "arrived". Aplica sólo
                        cuando el hotel no puede alojar al huésped (overbooking); si
                        hay habitación disponible, el flujo de arriba es el camino
                        normal. */}
                    <form action={submitMarkWalked} className="border-t border-border pt-3 text-right">
                      <input type="hidden" name="hotelId" value={hotel.hotelId} />
                      <input type="hidden" name="stayId" value={detail.stay.id} />
                      <Button
                        variant="ghost"
                        title="El huésped llegó con reserva confirmada pero el hotel no tiene habitación para darle (ej. overbooking) y se le reubica en otro hotel. Es reversible con 'Deshacer Walked'."
                      >
                        No se puede alojar — Marcar Walked
                      </Button>
                    </form>
                  </Card>
                )}

                {/* Asignar habitacion (estancia ya con check-in pero sin habitacion, ej. tras liberar una asignacion) */}
                {detail.stay.status === "checked_in" && !detail.activeAssignment && (
                  <Card className="space-y-3">
                    <CardTitle>Asignar habitación</CardTitle>
                    {roomOptions.length === 0 ? (
                      <Banner tone="warning">No hay habitaciones libres ahora mismo.</Banner>
                    ) : (
                      <form action={submitAssignRoom} className="flex items-end gap-3">
                        <input type="hidden" name="hotelId" value={hotel.hotelId} />
                        <input type="hidden" name="stayId" value={detail.stay.id} />
                        <Field label="Habitación" className="flex-1">
                          <Select name="roomId" required>
                            {equivalentOptions.length > 0 && (
                              <optgroup label="Equivalente (sin costo adicional)">
                                {equivalentOptions.map((o) => (
                                  <option key={o.id} value={o.id}>
                                    {o.code} {o.isClean ? "" : "(sucia)"}
                                  </option>
                                ))}
                              </optgroup>
                            )}
                            {upgradeOptions.length > 0 && (
                              <optgroup label="Upgrade disponible">
                                {upgradeOptions.map((o) => (
                                  <option key={o.id} value={o.id}>
                                    {o.code} · {o.roomTypeName} — +${o.priceDiff}
                                  </option>
                                ))}
                              </optgroup>
                            )}
                          </Select>
                        </Field>
                        <Button>Asignar</Button>
                      </form>
                    )}
                  </Card>
                )}

                {/* Cambio de habitación autorizado (P0-3/P0-5, handoff de demo):
                    a diferencia de "Asignar habitación" (arriba, sólo para el
                    caso raro de checked_in sin habitación), este SÍ permite
                    upgrade/downgrade de una estancia que ya tiene una asignada. */}
                {needsRoomChangeOptions && (
                  <Card className="space-y-3">
                    <CardTitle>Cambio de habitación</CardTitle>
                    {roomChangeOptions.length === 0 ? (
                      <Banner tone="warning">No hay otras habitaciones libres ahora mismo.</Banner>
                    ) : (
                      <form action={submitChangeRoom} className="space-y-3">
                        <input type="hidden" name="hotelId" value={hotel.hotelId} />
                        <input type="hidden" name="stayId" value={detail!.stay.id} />
                        <Field label="Nueva habitación">
                          <Select name="roomId" required>
                            {equivalentChangeOptions.length > 0 && (
                              <optgroup label="Equivalente (mismo tipo, sin costo)">
                                {equivalentChangeOptions.map((o) => (
                                  <option key={o.id} value={o.id}>
                                    {o.code} · {o.roomTypeName}
                                    {o.isClean ? "" : " (sucia)"}
                                  </option>
                                ))}
                              </optgroup>
                            )}
                            {upgradeChangeOptions.length > 0 && (
                              <optgroup label="Upgrade">
                                {upgradeChangeOptions.map((o) => (
                                  <option key={o.id} value={o.id}>
                                    {o.code} · {o.roomTypeName}
                                    {o.isClean ? "" : " (sucia)"}
                                  </option>
                                ))}
                              </optgroup>
                            )}
                            {downgradeChangeOptions.length > 0 && (
                              <optgroup label="Downgrade">
                                {downgradeChangeOptions.map((o) => (
                                  <option key={o.id} value={o.id}>
                                    {o.code} · {o.roomTypeName}
                                    {o.isClean ? "" : " (sucia)"}
                                  </option>
                                ))}
                              </optgroup>
                            )}
                          </Select>
                        </Field>
                        <Field label="Motivo (obligatorio para upgrade/downgrade)">
                          <TextInput name="reason" placeholder="Ej. solicitud del huésped, falla en la habitación…" />
                        </Field>
                        <div className="grid grid-cols-3 gap-3">
                          <label className="flex items-end gap-2 pb-2 text-muted-strong">
                            <input type="checkbox" name="isCourtesy" className="h-4 w-4" /> Upgrade de cortesía (sin cobro)
                          </label>
                          <Field label="Cobro de upgrade (si no es cortesía)">
                            <TextInput name="chargeAmount" type="number" min={0} step="0.01" />
                          </Field>
                          <Field label="Compensación por downgrade (opcional)">
                            <TextInput name="compensationAmount" type="number" min={0} step="0.01" />
                          </Field>
                        </div>
                        <div className="flex items-center gap-3">
                          <Button>Confirmar cambio de habitación</Button>
                          <Link href={`/recepcion?stayId=${detail!.stay.id}`} className="text-muted underline">
                            Cancelar
                          </Link>
                        </div>
                      </form>
                    )}
                  </Card>
                )}

                {/* Cuenta de la estancia */}
                <Card className="space-y-3">
                  <div className="flex items-center justify-between">
                    <CardTitle>Cuenta de la estancia</CardTitle>
                    {/* P0-8 (handoff de demo): nunca un número negativo crudo --
                        "A favor"/"Por pagar"/"Cuenta liquidada" en lenguaje simple. */}
                    <b className={(detail.stay.stay_accounts?.balance ?? 0) > 0 ? "text-danger" : "text-brand"}>
                      {formatBalanceLabel(detail.stay.stay_accounts?.balance ?? 0)}
                    </b>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <p className="uppercase text-muted">Total cargos</p>
                      <p className="font-semibold text-foreground">${totalCargos.toFixed(2)}</p>
                    </div>
                    <div>
                      <p className="uppercase text-muted">Total abonos/depósitos</p>
                      <p className="font-semibold text-foreground">${totalAbonos.toFixed(2)}</p>
                    </div>
                  </div>

                  {detail.stay.stay_accounts?.status === "open" && (
                    <form action={submitRegisterTransaction} className="grid grid-cols-4 gap-3">
                      <input type="hidden" name="hotelId" value={hotel.hotelId} />
                      <input type="hidden" name="stayId" value={detail.stay.id} />
                      <Field label="Tipo">
                        <Select name="type" defaultValue="charge">
                          <option value="charge">Cargo</option>
                          <option value="payment">Pago</option>
                          <option value="refund">Reembolso</option>
                        </Select>
                      </Field>
                      <Field label="Monto">
                        <TextInput name="amount" type="number" min={0.01} step="0.01" required />
                      </Field>
                      <Field label="Método">
                        <Select name="method" defaultValue="cash">
                          <option value="cash">Efectivo</option>
                          <option value="card">Tarjeta</option>
                          <option value="transfer">Transferencia</option>
                          <option value="other">Otro</option>
                        </Select>
                      </Field>
                      <Field label="Concepto">
                        <TextInput name="concept" required placeholder="Consumo, depósito, etc." />
                      </Field>
                      <div className="col-span-4">
                        <Button>Registrar movimiento</Button>
                      </div>
                    </form>
                  )}

                  <table className="w-full text-left">
                    <thead className="text-muted">
                      <tr>
                        <th className="pb-1 font-medium">Tipo</th>
                        <th className="font-medium">Monto</th>
                        <th className="font-medium">Concepto</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.transactions.map((t) => (
                        <tr key={t.id} className="border-t border-border">
                          <td className="py-1">{t.type}</td>
                          <td className={t.amount > 0 ? "text-danger" : "text-brand"}>${t.amount}</td>
                          <td>{t.concept}</td>
                          <td>
                            {!t.reversed_transaction_id && detail.stay.stay_accounts?.status === "open" && (
                              <form action={submitVoidTransaction}>
                                <input type="hidden" name="hotelId" value={hotel.hotelId} />
                                <input type="hidden" name="stayId" value={detail.stay.id} />
                                <input type="hidden" name="transactionId" value={t.id} />
                                <Button variant="ghost" className="text-xs text-danger">
                                  anular
                                </Button>
                              </form>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>

                {/* Check-out readiness */}
                {detail.stay.status === "in_house" && detail.readiness && !detail.readiness.ready && (
                  <Banner tone="warning">{`Falta para poder cerrar: ${detail.readiness.blockers.join(" · ")}`}</Banner>
                )}

                {/* Activos entregados -- P1-6 (handoff de demo): si el hotel
                    no tiene activos configurados, la sección completa se
                    oculta -- nunca un mensaje de "no hay nada aquí". */}
                {checkinAssets.length > 0 && (
                <Card className="space-y-3">
                  <CardTitle>Activos entregados</CardTitle>
                  <div className="space-y-2">
                    {checkinAssets.map((assetName) => {
                      const existing = detail.assets.find((a) => a.asset_name === assetName);
                      return (
                        <form key={assetName} action={submitSetAsset} className="flex items-center gap-4 rounded-lg border border-border p-2">
                          <input type="hidden" name="hotelId" value={hotel.hotelId} />
                          <input type="hidden" name="stayId" value={detail.stay.id} />
                          <input type="hidden" name="assetName" value={assetName} />
                          <span className="flex-1">{assetName}</span>
                          <label className="flex items-center gap-1">
                            <input type="checkbox" name="delivered" defaultChecked={existing?.delivered} /> Entregado
                          </label>
                          <label className="flex items-center gap-1">
                            <input type="checkbox" name="returned" defaultChecked={existing?.returned} /> Devuelto
                          </label>
                          <Button variant="secondary" className="text-xs">
                            Guardar
                          </Button>
                        </form>
                      );
                    })}
                  </div>
                </Card>
                )}

                {/* Solicitudes e incidencias */}
                <div className="grid grid-cols-2 gap-4">
                  <Card className="space-y-3">
                    <CardTitle>Solicitudes del huésped</CardTitle>
                    <form action={submitCreateGuestRequest} className="flex gap-2">
                      <input type="hidden" name="hotelId" value={hotel.hotelId} />
                      <input type="hidden" name="stayId" value={detail.stay.id} />
                      <TextInput name="description" required placeholder="Ej. toallas extra" className="flex-1" />
                      <Button className="shrink-0">Agregar</Button>
                    </form>
                    <div className="space-y-2">
                      {detail.guestRequests.map((r) => (
                        <div key={r.id} className="space-y-1 rounded-lg bg-brand-soft p-2">
                          <div className="flex items-center justify-between">
                            <span>{r.description}</span>
                            {r.status !== "completed" ? (
                              <form action={submitResolveGuestRequest}>
                                <input type="hidden" name="hotelId" value={hotel.hotelId} />
                                <input type="hidden" name="stayId" value={detail.stay.id} />
                                <input type="hidden" name="requestId" value={r.id} />
                                <Button variant="ghost" className="text-xs">
                                  resolver
                                </Button>
                              </form>
                            ) : (
                              <span className="text-xs text-muted">resuelta</span>
                            )}
                          </div>
                          {/* P2-3 (enrutamiento): asignar area de servicio + marcar en curso -- Housekeeping/Mantenimiento no existen como modulos reales todavia, sólo la etiqueta. */}
                          {r.status !== "completed" && (
                            <div className="flex items-center justify-between text-xs text-muted">
                              {r.assigned_area ? (
                                <span>→ {r.assigned_area === "housekeeping" ? "Housekeeping" : "Mantenimiento"}</span>
                              ) : (
                                <form action={submitAssignGuestRequest} className="flex items-center gap-2">
                                  <input type="hidden" name="hotelId" value={hotel.hotelId} />
                                  <input type="hidden" name="stayId" value={detail.stay.id} />
                                  <input type="hidden" name="requestId" value={r.id} />
                                  <Select name="assignedArea" defaultValue="housekeeping" className="text-xs">
                                    <option value="housekeeping">Housekeeping</option>
                                    <option value="maintenance">Mantenimiento</option>
                                  </Select>
                                  <Button variant="ghost" className="text-xs">
                                    enviar
                                  </Button>
                                </form>
                              )}
                              {r.assigned_area && r.status !== "in_progress" && (
                                <form action={submitStartGuestRequestProgress}>
                                  <input type="hidden" name="hotelId" value={hotel.hotelId} />
                                  <input type="hidden" name="stayId" value={detail.stay.id} />
                                  <input type="hidden" name="requestId" value={r.id} />
                                  <Button variant="ghost" className="text-xs">
                                    marcar en curso
                                  </Button>
                                </form>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </Card>

                  <Card className="space-y-3">
                    <CardTitle>Incidencias</CardTitle>
                    <form action={submitCreateIncident} className="space-y-2">
                      <input type="hidden" name="hotelId" value={hotel.hotelId} />
                      <input type="hidden" name="stayId" value={detail.stay.id} />
                      <div className="flex gap-2">
                        <Select name="type" defaultValue="maintenance" className="flex-1">
                          <option value="maintenance">Mantenimiento</option>
                          <option value="damage">Daño</option>
                          <option value="complaint">Queja</option>
                          <option value="other">Otro</option>
                        </Select>
                        <Select name="severity" defaultValue="low" className="flex-1">
                          <option value="low">Baja</option>
                          <option value="medium">Media</option>
                          <option value="high">Alta</option>
                        </Select>
                      </div>
                      <div className="flex gap-2">
                        <TextInput name="description" required placeholder="Ej. AC no enfría" className="flex-1" />
                        <Button className="shrink-0">Agregar</Button>
                      </div>
                    </form>
                    <div className="space-y-2">
                      {detail.incidents.map((i) => (
                        <div key={i.id} className="space-y-1 rounded-lg bg-warning-soft p-2">
                          <div className="flex items-center justify-between">
                            <span>
                              {i.description} <span className="text-xs text-muted">({i.severity})</span>
                            </span>
                            {i.status !== "resolved" ? (
                              <form action={submitResolveIncident}>
                                <input type="hidden" name="hotelId" value={hotel.hotelId} />
                                <input type="hidden" name="stayId" value={detail.stay.id} />
                                <input type="hidden" name="incidentId" value={i.id} />
                                <Button variant="ghost" className="text-xs">
                                  resolver
                                </Button>
                              </form>
                            ) : (
                              <span className="text-xs text-muted">resuelta</span>
                            )}
                          </div>
                          {/* P2-3 (enrutamiento): mismo patrón que Solicitudes del huésped. */}
                          {i.status !== "resolved" && (
                            <div className="flex items-center justify-between text-xs text-muted">
                              {i.assigned_area ? (
                                <span>→ {i.assigned_area === "housekeeping" ? "Housekeeping" : "Mantenimiento"}</span>
                              ) : (
                                <form action={submitAssignIncident} className="flex items-center gap-2">
                                  <input type="hidden" name="hotelId" value={hotel.hotelId} />
                                  <input type="hidden" name="stayId" value={detail.stay.id} />
                                  <input type="hidden" name="incidentId" value={i.id} />
                                  <Select name="assignedArea" defaultValue="maintenance" className="text-xs">
                                    <option value="housekeeping">Housekeeping</option>
                                    <option value="maintenance">Mantenimiento</option>
                                  </Select>
                                  <Button variant="ghost" className="text-xs">
                                    enviar
                                  </Button>
                                </form>
                              )}
                              {i.assigned_area && i.status !== "in_progress" && (
                                <form action={submitStartIncidentProgress}>
                                  <input type="hidden" name="hotelId" value={hotel.hotelId} />
                                  <input type="hidden" name="stayId" value={detail.stay.id} />
                                  <input type="hidden" name="incidentId" value={i.id} />
                                  <Button variant="ghost" className="text-xs">
                                    marcar en curso
                                  </Button>
                                </form>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </Card>
                </div>
              </>
            )}
          </div>
        </div>
    </AppShell>
  );
}
