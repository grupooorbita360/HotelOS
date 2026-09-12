import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, getCurrentUserHotel } from "@/lib/auth/session";
import { signOut } from "@/app/login/actions";
import { brandStyleVars } from "@/lib/color";
import { formatDate, formatDateRange, formatDateTime } from "@/lib/format";
import { listRoomTypes, searchAvailableOptions } from "@/modules/reservaciones/queries/availability";
import { listReservations, listActiveHolds } from "@/modules/reservaciones/queries/reservations";
import { listLeads } from "@/modules/reservaciones/queries/leads";
import { getQuoteOptionDetails, getHoldDetails, getReservationDetails } from "@/modules/reservaciones/queries/details";
import { Card, CardTitle } from "@/components/ui/Card";
import { Field, TextInput } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { KpiCard } from "@/components/ui/KpiCard";
import { ReservationStatusBadge, LeadStatusBadge, HoldStatusBadge } from "@/components/ui/Badge";
import { ModuleHeader } from "@/components/ui/ModuleHeader";
import { GuestSearchField } from "@/components/ui/GuestSearchField";
import { CopyQuoteButton } from "@/components/ui/CopyQuoteButton";
import {
  submitSearchAndQuote,
  submitCreateHold,
  submitReleaseHold,
  submitConfirmReservation,
  submitCancelReservation,
} from "./actions";

export default async function ReservacionesPage({
  searchParams,
}: {
  searchParams: Promise<{
    quoteOptionId?: string;
    holdId?: string;
    reservationId?: string;
    leadId?: string;
    error?: string;
    confirmed?: string;
    cancelled?: string;
    guestName?: string;
    guestEmail?: string;
    guestPhone?: string;
    checkIn?: string;
    checkOut?: string;
    adults?: string;
    children?: string;
    hasPets?: string;
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
          <p className="text-sm text-muted">
            Para probar el flujo de Reservaciones, un platform admin debe crear un hotel y asignarte un rol (ej.{" "}
            <code>hotel_admin</code>) en <code>public.user_hotel_roles</code>.
          </p>
          <form action={signOut}>
            <Button variant="ghost">Cerrar sesión</Button>
          </form>
        </Card>
      </div>
    );
  }

  const roomTypes = await listRoomTypes(hotel.hotelId);
  const reservations = await listReservations(hotel.hotelId);
  const leads = await listLeads(hotel.hotelId);
  const activeHolds = await listActiveHolds(hotel.hotelId);

  const quoteOption = params.quoteOptionId ? await getQuoteOptionDetails(hotel.hotelId, params.quoteOptionId) : null;
  const hold = params.holdId ? await getHoldDetails(hotel.hotelId, params.holdId) : null;
  const reservationDetail = params.reservationId ? await getReservationDetails(hotel.hotelId, params.reservationId) : null;
  const leadDetail = params.leadId ? leads.find((l) => l.id === params.leadId) : null;

  const availableOptions =
    !quoteOption && !hold && params.checkIn && params.checkOut
      ? await searchAvailableOptions(hotel.hotelId, params.checkIn, params.checkOut)
      : null;

  // Solo lo que el buscador de huesped (Client Component) necesita -- no cruza
  // el limite servidor/cliente el resto de cada fila de lead (fechas, canal, etc.).
  const guestDirectory = leads.map((l) => ({
    id: l.id,
    guest_name: l.guest_name,
    guest_email: l.guest_email,
    guest_phone: l.guest_phone,
  }));

  return (
    <div className="min-h-screen bg-background px-6 py-8" style={brandStyleVars(hotel.brandColor)}>
      <div className="mx-auto max-w-5xl space-y-6 text-sm">
        <ModuleHeader
          title="Reservaciones"
          hotelName={hotel.hotelName}
          roleName={hotel.roleName}
          current="reservaciones"
          resetHref="/reservaciones"
        />

        <div className="grid grid-cols-3 gap-4">
          <KpiCard label="Reservas" value={reservations.length} />
          <KpiCard label="Leads" value={leads.length} />
          <KpiCard label="Holds activos" value={activeHolds.length} note="Esperando confirmación" />
        </div>

        <div className="space-y-2">
          {params.error && <Banner tone="danger">{params.error}</Banner>}
          {params.confirmed && <Banner tone="success">Reserva confirmada.</Banner>}
          {params.cancelled && <Banner tone="warning">Reserva cancelada, inventario liberado.</Banner>}
        </div>

        {/* Detalle de una reserva (clic desde el listado) */}
        {reservationDetail && (
          <Card className="space-y-3">
            <div className="flex items-center justify-between">
              <CardTitle>
                Reserva {reservationDetail.folio} — {reservationDetail.primary_guest_name}
              </CardTitle>
              <ReservationStatusBadge status={reservationDetail.status} />
            </div>
            <p className="text-muted">
              {reservationDetail.primary_guest_email || "sin correo"} · {reservationDetail.primary_guest_phone || "sin teléfono"} · canal:{" "}
              {reservationDetail.channel}
            </p>
            {reservationDetail.reservation_stays.map((s, i) => (
              <p key={i} className="text-muted-strong">
                <strong className="text-foreground">{s.room_types?.name}</strong> · {formatDateRange(s.check_in, s.check_out)} ·{" "}
                {s.adults} adultos, {s.children} niños{s.has_pets ? " · con mascota" : ""} · ${s.rate_total}
              </p>
            ))}
            {reservationDetail.guarantees.length > 0 && (
              <div>
                <p className="font-medium text-foreground">Garantías</p>
                {reservationDetail.guarantees.map((g, i) => (
                  <p key={i} className="text-muted">
                    {g.type} · ${g.amount} {g.currency} · {g.status}
                  </p>
                ))}
              </div>
            )}
            {reservationDetail.payments.length > 0 && (
              <div>
                <p className="font-medium text-foreground">Pagos</p>
                {reservationDetail.payments.map((p, i) => (
                  <p key={i} className="text-muted">
                    {formatDate(p.created_at)} · {p.type} · ${p.amount} {p.currency} ({p.method}) · {p.status}
                  </p>
                ))}
              </div>
            )}
            {reservationDetail.status === "cancelled" && (
              <Banner tone="warning">{`Cancelada ${formatDate(reservationDetail.cancelled_at)}${
                reservationDetail.cancellation_reason ? `: ${reservationDetail.cancellation_reason}` : ""
              }`}</Banner>
            )}
            <Link href="/reservaciones" className="text-brand underline">
              Cerrar detalle
            </Link>
          </Card>
        )}

        {/* Detalle de un lead (clic desde el listado) */}
        {leadDetail && (
          <Card className="space-y-3">
            <div className="flex items-center justify-between">
              <CardTitle>Lead — {leadDetail.guest_name}</CardTitle>
              <LeadStatusBadge status={leadDetail.status} />
            </div>
            <p className="text-muted">
              {leadDetail.guest_email || "sin correo"} · {leadDetail.guest_phone || "sin teléfono"} · canal: {leadDetail.channel}
            </p>
            <p className="text-muted-strong">
              Fechas deseadas: {formatDateRange(leadDetail.desired_check_in, leadDetail.desired_check_out)}
            </p>
            <p className="text-xs text-muted">Primer contacto: {formatDate(leadDetail.created_at)}</p>
            <div className="flex gap-3">
              <Link
                href={`/reservaciones?guestName=${encodeURIComponent(leadDetail.guest_name)}&guestEmail=${encodeURIComponent(
                  leadDetail.guest_email ?? "",
                )}&guestPhone=${encodeURIComponent(leadDetail.guest_phone ?? "")}`}
                className="text-brand underline"
              >
                Cotizar para este lead
              </Link>
              <Link href="/reservaciones" className="text-muted underline">
                Cerrar detalle
              </Link>
            </div>
          </Card>
        )}

        {/* Paso 3: confirmar */}
        {hold && (
          <Card className="space-y-4">
            <div className="flex items-center justify-between">
              <CardTitle>3. Confirmar reserva</CardTitle>
              <HoldStatusBadge status={hold.status} />
            </div>
            <p className="text-muted-strong">
              <strong className="text-foreground">{hold.room_types?.name}</strong>, {formatDateRange(hold.check_in, hold.check_out)}.
              Vence: {formatDateTime(hold.expires_at)}
            </p>
            {hold.status !== "active" ? (
              <Banner tone="warning">Este Hold ya no está activo. Vuelve a cotizar.</Banner>
            ) : (
              <form action={submitConfirmReservation} className="grid grid-cols-2 gap-4">
                <input type="hidden" name="hotelId" value={hotel.hotelId} />
                <input type="hidden" name="holdId" value={hold.id} />
                <input type="hidden" name="rateTotal" value={hold.quote_options?.total ?? 0} />
                <Field label="Nombre del huésped" className="col-span-2">
                  <TextInput
                    name="primaryGuestName"
                    required
                    defaultValue={hold.quote_options?.quotes?.leads?.guest_name ?? ""}
                  />
                </Field>
                <Field label="Email">
                  <TextInput
                    name="primaryGuestEmail"
                    defaultValue={hold.quote_options?.quotes?.leads?.guest_email ?? ""}
                  />
                </Field>
                <Field label="Teléfono">
                  <TextInput
                    name="primaryGuestPhone"
                    defaultValue={hold.quote_options?.quotes?.leads?.guest_phone ?? ""}
                  />
                </Field>
                <div className="col-span-2">
                  <Button>Confirmar garantía/pago y crear reserva</Button>
                </div>
              </form>
            )}
            {hold.status === "active" && (
              <form action={submitReleaseHold}>
                <input type="hidden" name="hotelId" value={hotel.hotelId} />
                <input type="hidden" name="holdId" value={hold.id} />
                <Button variant="ghost">Liberar Hold sin confirmar</Button>
              </form>
            )}
          </Card>
        )}

        {/* Paso 2: aceptar cotización y pedir Hold */}
        {quoteOption && !hold && (
          <Card className="space-y-4">
            <CardTitle>2. Cotización emitida</CardTitle>
            <p>
              <strong>{quoteOption.room_types?.name}</strong>: {formatDateRange(quoteOption.check_in, quoteOption.check_out)} ·{" "}
              {quoteOption.adults} adultos, {quoteOption.children} niños
            </p>
            <div className="rounded-xl bg-brand-soft p-4">
              <p className="text-muted-strong">
                Subtotal ${quoteOption.subtotal} + impuestos ${quoteOption.taxes}
              </p>
              <p className="text-2xl font-bold text-brand">Total ${quoteOption.total}</p>
            </div>
            <p className="text-muted">
              Huésped: {quoteOption.quotes?.leads?.guest_name} ({quoteOption.quotes?.leads?.guest_email || "sin correo"})
            </p>
            <form action={submitCreateHold}>
              <input type="hidden" name="hotelId" value={hotel.hotelId} />
              <input type="hidden" name="quoteOptionId" value={quoteOption.id} />
              <Button>Aceptar y reservar (crear Hold)</Button>
            </form>
          </Card>
        )}

        {/* Paso 1: buscar disponibilidad y ver opciones */}
        {!quoteOption && !hold && (
          <Card className="space-y-4">
            <CardTitle>1. Buscar disponibilidad y cotizar</CardTitle>
            {roomTypes.length === 0 ? (
              <p className="text-muted">
                Este hotel todavía no tiene tipos de habitación activos. Crea al menos uno en{" "}
                <Link href="/configuracion?tab=habitaciones" className="underline">
                  Configuración
                </Link>{" "}
                antes de cotizar.
              </p>
            ) : (
              <>
                <form method="GET" className="grid grid-cols-2 gap-4 md:grid-cols-4">
                  <GuestSearchField
                    key={`${params.guestName ?? ""}|${params.guestEmail ?? ""}|${params.guestPhone ?? ""}`}
                    leads={guestDirectory}
                    defaultName={params.guestName}
                    defaultEmail={params.guestEmail}
                    defaultPhone={params.guestPhone}
                  />
                  <Field label="Check-in">
                    <TextInput name="checkIn" type="date" required defaultValue={params.checkIn} />
                  </Field>
                  <Field label="Check-out">
                    <TextInput name="checkOut" type="date" required defaultValue={params.checkOut} />
                  </Field>
                  <Field label="Adultos">
                    <TextInput name="adults" type="number" min={1} defaultValue={params.adults ?? "1"} />
                  </Field>
                  <Field label="Niños">
                    <TextInput name="children" type="number" min={0} defaultValue={params.children ?? "0"} />
                  </Field>
                  <label className="flex items-end gap-2 pb-2.5 text-muted-strong">
                    <input name="hasPets" type="checkbox" className="h-4 w-4" defaultChecked={params.hasPets === "on"} /> Mascotas
                  </label>
                  <div className="col-span-2 md:col-span-4">
                    <Button type="submit">Buscar opciones</Button>
                  </div>
                </form>

                {availableOptions && (
                  <div className="space-y-3 border-t border-border pt-4">
                    <p className="font-semibold text-foreground">Opciones disponibles ({availableOptions.length})</p>
                    {availableOptions.length === 0 && (
                      <Banner tone="warning">Sin disponibilidad para esas fechas en ningún tipo de habitación.</Banner>
                    )}
                    {availableOptions.map((opt) => {
                      const estimatedSubtotal = Math.round(opt.baseRate * opt.nights * 100) / 100;
                      const quoteText = `${opt.name} — ${formatDateRange(params.checkIn, params.checkOut)}\n${opt.nights} noche(s) x $${opt.baseRate} = $${estimatedSubtotal} MXN (+ impuestos)\nHuésped: ${params.guestName ?? ""}${params.guestPhone ? ` · ${params.guestPhone}` : ""}`;
                      return (
                        <div key={opt.roomTypeId} className="rounded-lg border border-border p-4">
                          <div className="flex items-center justify-between">
                            <b>{opt.name}</b>
                            <span className="text-xs text-muted">{opt.minAvailable} unidad(es) libres</span>
                          </div>
                          <p className="text-muted">
                            Hasta {opt.capacityAdults} adultos, {opt.capacityChildren} niños
                            {opt.acceptsPets ? " · acepta mascotas" : ""} · {opt.nights} noche(s)
                          </p>
                          <form action={submitSearchAndQuote} className="mt-2 flex flex-wrap items-end gap-3">
                            <input type="hidden" name="hotelId" value={hotel.hotelId} />
                            <input type="hidden" name="roomTypeId" value={opt.roomTypeId} />
                            <input type="hidden" name="checkIn" value={params.checkIn} />
                            <input type="hidden" name="checkOut" value={params.checkOut} />
                            <input type="hidden" name="paxAdults" value={params.adults ?? "1"} />
                            <input type="hidden" name="paxChildren" value={params.children ?? "0"} />
                            {params.hasPets === "on" && <input type="hidden" name="hasPets" value="on" />}
                            <input type="hidden" name="guestName" value={params.guestName ?? ""} />
                            <input type="hidden" name="guestEmail" value={params.guestEmail ?? ""} />
                            <input type="hidden" name="guestPhone" value={params.guestPhone ?? ""} />
                            <Field label="Tarifa/noche" className="w-32">
                              <TextInput name="nightlyRate" type="number" min={0} step="0.01" defaultValue={opt.baseRate} />
                            </Field>
                            <Button>Reservar</Button>
                            <CopyQuoteButton text={quoteText} />
                          </form>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </Card>
        )}

        {/* Holds activos */}
        {activeHolds.length > 0 && (
          <Card className="space-y-3">
            <CardTitle>Holds activos</CardTitle>
            <table className="w-full text-left">
              <thead className="text-muted">
                <tr>
                  <th className="pb-2 font-medium">Tipo</th>
                  <th className="font-medium">Fechas</th>
                  <th className="font-medium">Vence</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {activeHolds.map((h) => (
                  <tr key={h.id} className="border-t border-border">
                    <td className="py-2">{h.room_types?.name}</td>
                    <td>{formatDateRange(h.check_in, h.check_out)}</td>
                    <td>{formatDateTime(h.expires_at)}</td>
                    <td>
                      <Link href={`/reservaciones?holdId=${h.id}`} className="font-medium text-brand hover:underline">
                        abrir
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        {/* Listado de reservas */}
        <Card className="space-y-3">
          <CardTitle>Reservas ({reservations.length})</CardTitle>
          <table className="w-full text-left">
            <thead className="text-muted">
              <tr>
                <th className="pb-2 font-medium">Folio</th>
                <th className="font-medium">Huésped</th>
                <th className="font-medium">Estado</th>
                <th className="font-medium">Fechas</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {reservations.map((r) => (
                <tr key={r.id} className="border-t border-border hover:bg-border/30">
                  <td className="py-2">
                    <Link href={`/reservaciones?reservationId=${r.id}`} className="font-mono text-xs text-brand hover:underline">
                      {r.folio}
                    </Link>
                  </td>
                  <td>
                    <Link href={`/reservaciones?reservationId=${r.id}`} className="hover:underline">
                      {r.primary_guest_name}
                    </Link>
                  </td>
                  <td>
                    <ReservationStatusBadge status={r.status} />
                  </td>
                  <td>{r.reservation_stays.map((s, i) => <span key={i}>{formatDateRange(s.check_in, s.check_out)}</span>)}</td>
                  <td>
                    {r.status === "confirmed" && (
                      <form action={submitCancelReservation}>
                        <input type="hidden" name="hotelId" value={hotel.hotelId} />
                        <input type="hidden" name="reservationId" value={r.id} />
                        <Button variant="ghost" className="text-danger">
                          cancelar
                        </Button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        {/* Listado de leads */}
        <Card className="space-y-3">
          <CardTitle>Leads ({leads.length})</CardTitle>
          <table className="w-full text-left">
            <thead className="text-muted">
              <tr>
                <th className="pb-2 font-medium">Nombre</th>
                <th className="font-medium">Estado</th>
                <th className="font-medium">Canal</th>
                <th className="font-medium">Fechas deseadas</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id} className="border-t border-border hover:bg-border/30">
                  <td className="py-2">
                    <Link href={`/reservaciones?leadId=${l.id}`} className="text-brand hover:underline">
                      {l.guest_name}
                    </Link>
                  </td>
                  <td>
                    <LeadStatusBadge status={l.status} />
                  </td>
                  <td>{l.channel}</td>
                  <td>{formatDateRange(l.desired_check_in, l.desired_check_out)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}
