import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, getCurrentUserHotel } from "@/lib/auth/session";
import { signOut } from "@/app/login/actions";
import { listRoomTypes } from "@/modules/reservaciones/queries/availability";
import { listReservations, listActiveHolds } from "@/modules/reservaciones/queries/reservations";
import { listLeads } from "@/modules/reservaciones/queries/leads";
import { getQuoteOptionDetails, getHoldDetails } from "@/modules/reservaciones/queries/details";
import { Card, CardTitle } from "@/components/ui/Card";
import { Field, TextInput, Select } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { KpiCard } from "@/components/ui/KpiCard";
import { ReservationStatusBadge, LeadStatusBadge, HoldStatusBadge } from "@/components/ui/Badge";
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
    error?: string;
    confirmed?: string;
    cancelled?: string;
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

  return (
    <div className="min-h-screen bg-background px-6 py-8">
      <div className="mx-auto max-w-5xl space-y-6 text-sm">
        <header className="flex items-center justify-between rounded-2xl bg-gradient-to-r from-brand to-brand-dark px-6 py-5 text-white shadow-sm">
          <div>
            <h1 className="text-xl font-bold">Reservaciones — {hotel.hotelName}</h1>
            <p className="text-white/80">
              Rol: {hotel.roleName ?? "—"} ·{" "}
              <Link href="/reservaciones" className="underline">
                reiniciar
              </Link>
            </p>
          </div>
          <form action={signOut}>
            <button className="text-sm text-white/80 underline hover:text-white">Cerrar sesión</button>
          </form>
        </header>

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

        {/* Paso 3: confirmar */}
        {hold && (
          <Card className="space-y-4">
            <div className="flex items-center justify-between">
              <CardTitle>3. Confirmar reserva</CardTitle>
              <HoldStatusBadge status={hold.status} />
            </div>
            <p className="text-muted-strong">
              <strong className="text-foreground">{hold.room_types?.name}</strong>, {hold.check_in} → {hold.check_out}.
              Vence: {new Date(hold.expires_at).toLocaleString("es-MX")}
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
              <strong>{quoteOption.room_types?.name}</strong>: {quoteOption.check_in} → {quoteOption.check_out} ·{" "}
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

        {/* Paso 1: buscar y cotizar */}
        {!quoteOption && !hold && (
          <Card className="space-y-4">
            <CardTitle>1. Buscar disponibilidad y cotizar</CardTitle>
            {roomTypes.length === 0 ? (
              <p className="text-muted">
                Este hotel todavía no tiene tipos de habitación. Crea al menos uno en <code>room_types</code> antes de
                cotizar.
              </p>
            ) : (
              <form action={submitSearchAndQuote} className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <input type="hidden" name="hotelId" value={hotel.hotelId} />
                <Field label="Nombre del huésped" className="col-span-2 md:col-span-4">
                  <TextInput name="guestName" required />
                </Field>
                <Field label="Email">
                  <TextInput name="guestEmail" type="email" />
                </Field>
                <Field label="Teléfono">
                  <TextInput name="guestPhone" />
                </Field>
                <Field label="Tipo de habitación">
                  <Select name="roomTypeId" required>
                    {roomTypes.map((rt) => (
                      <option key={rt.id} value={rt.id}>
                        {rt.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Tarifa por noche (MXN)">
                  <TextInput name="nightlyRate" type="number" min={0} step="0.01" required />
                </Field>
                <Field label="Check-in">
                  <TextInput name="checkIn" type="date" required />
                </Field>
                <Field label="Check-out">
                  <TextInput name="checkOut" type="date" required />
                </Field>
                <Field label="Adultos">
                  <TextInput name="paxAdults" type="number" min={1} defaultValue={1} />
                </Field>
                <Field label="Niños">
                  <TextInput name="paxChildren" type="number" min={0} defaultValue={0} />
                </Field>
                <label className="flex items-end gap-2 pb-2.5 text-muted-strong">
                  <input name="hasPets" type="checkbox" className="h-4 w-4" /> Mascotas
                </label>
                <div className="col-span-2 md:col-span-4">
                  <Button>Cotizar</Button>
                </div>
              </form>
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
                    <td>
                      {h.check_in} → {h.check_out}
                    </td>
                    <td>{new Date(h.expires_at).toLocaleString("es-MX")}</td>
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
                <tr key={r.id} className="border-t border-border">
                  <td className="py-2 font-mono text-xs">{r.folio}</td>
                  <td>{r.primary_guest_name}</td>
                  <td>
                    <ReservationStatusBadge status={r.status} />
                  </td>
                  <td>{r.reservation_stays.map((s) => `${s.check_in} → ${s.check_out}`).join(", ")}</td>
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
                <tr key={l.id} className="border-t border-border">
                  <td className="py-2">{l.guest_name}</td>
                  <td>
                    <LeadStatusBadge status={l.status} />
                  </td>
                  <td>{l.channel}</td>
                  <td>
                    {l.desired_check_in} → {l.desired_check_out}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}
