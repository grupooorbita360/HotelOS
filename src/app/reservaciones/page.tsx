import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, getCurrentUserHotel } from "@/lib/auth/session";
import { signOut } from "@/app/login/actions";
import { listRoomTypes } from "@/modules/reservaciones/queries/availability";
import { listReservations, listActiveHolds } from "@/modules/reservaciones/queries/reservations";
import { listLeads } from "@/modules/reservaciones/queries/leads";
import { getQuoteOptionDetails, getHoldDetails } from "@/modules/reservaciones/queries/details";
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
      <div className="mx-auto max-w-lg space-y-4 p-8">
        <h1 className="text-lg font-semibold">Tu cuenta no tiene un hotel asignado todavía</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Para probar el flujo de Reservaciones, un platform admin debe crear un hotel y asignarte un rol (ej.{" "}
          <code>hotel_admin</code>) en <code>public.user_hotel_roles</code>. Ver instrucciones en el resumen de la
          sesión.
        </p>
        <form action={signOut}>
          <button className="text-sm underline">Cerrar sesión</button>
        </form>
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
    <div className="mx-auto max-w-4xl space-y-8 p-6 text-sm">
      <header className="flex items-center justify-between border-b border-zinc-200 pb-4 dark:border-zinc-800">
        <div>
          <h1 className="text-lg font-semibold">Reservaciones — {hotel.hotelName}</h1>
          <p className="text-zinc-500">
            Rol: {hotel.roleName ?? "—"} · <Link href="/reservaciones" className="underline">reiniciar</Link>
          </p>
        </div>
        <form action={signOut}>
          <button className="text-zinc-500 underline">Cerrar sesión</button>
        </form>
      </header>

      {params.error && (
        <p className="rounded bg-red-50 px-3 py-2 text-red-700 dark:bg-red-950 dark:text-red-300">{params.error}</p>
      )}
      {params.confirmed && (
        <p className="rounded bg-green-50 px-3 py-2 text-green-700 dark:bg-green-950 dark:text-green-300">
          Reserva confirmada.
        </p>
      )}
      {params.cancelled && (
        <p className="rounded bg-amber-50 px-3 py-2 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
          Reserva cancelada, inventario liberado.
        </p>
      )}

      {/* Paso 3: confirmar */}
      {hold && (
        <section className="space-y-3 rounded border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="font-semibold">3. Confirmar reserva</h2>
          <p>
            Hold {hold.status} para <strong>{hold.room_types?.name}</strong>, {hold.check_in} → {hold.check_out}.
            Vence: {new Date(hold.expires_at).toLocaleString("es-MX")}
          </p>
          {hold.status !== "active" ? (
            <p className="text-amber-600">
              Este Hold ya no está activo (status: {hold.status}). Vuelve a cotizar.
            </p>
          ) : (
            <form action={submitConfirmReservation} className="grid grid-cols-2 gap-3">
              <input type="hidden" name="hotelId" value={hotel.hotelId} />
              <input type="hidden" name="holdId" value={hold.id} />
              <input
                type="hidden"
                name="rateTotal"
                value={hold.quote_options?.total ?? 0}
              />
              <label className="col-span-2">
                Nombre del huésped
                <input
                  name="primaryGuestName"
                  required
                  defaultValue={hold.quote_options?.quotes?.leads?.guest_name ?? ""}
                  className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                />
              </label>
              <label>
                Email
                <input
                  name="primaryGuestEmail"
                  defaultValue={hold.quote_options?.quotes?.leads?.guest_email ?? ""}
                  className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                />
              </label>
              <label>
                Teléfono
                <input
                  name="primaryGuestPhone"
                  defaultValue={hold.quote_options?.quotes?.leads?.guest_phone ?? ""}
                  className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                />
              </label>
              <div className="col-span-2 flex gap-2">
                <button className="rounded bg-black px-3 py-1.5 font-medium text-white dark:bg-zinc-50 dark:text-black">
                  Confirmar garantía/pago y crear reserva
                </button>
              </div>
            </form>
          )}
          {hold.status === "active" && (
            <form action={submitReleaseHold}>
              <input type="hidden" name="hotelId" value={hotel.hotelId} />
              <input type="hidden" name="holdId" value={hold.id} />
              <button className="text-zinc-500 underline">Liberar Hold sin confirmar</button>
            </form>
          )}
        </section>
      )}

      {/* Paso 2: aceptar cotización y pedir Hold */}
      {quoteOption && !hold && (
        <section className="space-y-3 rounded border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="font-semibold">2. Cotización emitida</h2>
          <p>
            <strong>{quoteOption.room_types?.name}</strong>: {quoteOption.check_in} → {quoteOption.check_out} ·{" "}
            {quoteOption.adults} adultos, {quoteOption.children} niños
          </p>
          <p>
            Subtotal ${quoteOption.subtotal} + impuestos ${quoteOption.taxes} = <strong>Total ${quoteOption.total}</strong>
          </p>
          <p className="text-zinc-500">
            Huésped: {quoteOption.quotes?.leads?.guest_name} ({quoteOption.quotes?.leads?.guest_email || "sin correo"})
          </p>
          <form action={submitCreateHold}>
            <input type="hidden" name="hotelId" value={hotel.hotelId} />
            <input type="hidden" name="quoteOptionId" value={quoteOption.id} />
            <button className="rounded bg-black px-3 py-1.5 font-medium text-white dark:bg-zinc-50 dark:text-black">
              Aceptar y reservar (crear Hold)
            </button>
          </form>
        </section>
      )}

      {/* Paso 1: buscar y cotizar */}
      {!quoteOption && !hold && (
        <section className="space-y-3 rounded border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="font-semibold">1. Buscar disponibilidad y cotizar</h2>
          {roomTypes.length === 0 ? (
            <p className="text-zinc-500">
              Este hotel todavía no tiene tipos de habitación. Crea al menos uno en <code>room_types</code> antes de
              cotizar (ver resumen de la sesión).
            </p>
          ) : (
            <form action={submitSearchAndQuote} className="grid grid-cols-2 gap-3">
              <input type="hidden" name="hotelId" value={hotel.hotelId} />
              <label className="col-span-2">
                Nombre del huésped
                <input
                  name="guestName"
                  required
                  className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                />
              </label>
              <label>
                Email
                <input
                  name="guestEmail"
                  type="email"
                  className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                />
              </label>
              <label>
                Teléfono
                <input
                  name="guestPhone"
                  className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                />
              </label>
              <label>
                Tipo de habitación
                <select
                  name="roomTypeId"
                  required
                  className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                >
                  {roomTypes.map((rt) => (
                    <option key={rt.id} value={rt.id}>
                      {rt.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Tarifa por noche (MXN)
                <input
                  name="nightlyRate"
                  type="number"
                  min={0}
                  step="0.01"
                  required
                  className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                />
              </label>
              <label>
                Check-in
                <input
                  name="checkIn"
                  type="date"
                  required
                  className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                />
              </label>
              <label>
                Check-out
                <input
                  name="checkOut"
                  type="date"
                  required
                  className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                />
              </label>
              <label>
                Adultos
                <input
                  name="paxAdults"
                  type="number"
                  min={1}
                  defaultValue={1}
                  className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                />
              </label>
              <label>
                Niños
                <input
                  name="paxChildren"
                  type="number"
                  min={0}
                  defaultValue={0}
                  className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                />
              </label>
              <label className="flex items-center gap-2">
                <input name="hasPets" type="checkbox" /> Mascotas
              </label>
              <div className="col-span-2">
                <button className="rounded bg-black px-3 py-1.5 font-medium text-white dark:bg-zinc-50 dark:text-black">
                  Cotizar
                </button>
              </div>
            </form>
          )}
        </section>
      )}

      {/* Holds activos */}
      {activeHolds.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">Holds activos (esperando garantía/confirmación)</h2>
          <table className="w-full text-left">
            <thead className="text-zinc-500">
              <tr>
                <th className="py-1">Tipo</th>
                <th>Fechas</th>
                <th>Vence</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {activeHolds.map((h) => (
                <tr key={h.id} className="border-t border-zinc-100 dark:border-zinc-900">
                  <td className="py-1">{h.room_types?.name}</td>
                  <td>
                    {h.check_in} → {h.check_out}
                  </td>
                  <td>{new Date(h.expires_at).toLocaleString("es-MX")}</td>
                  <td>
                    <Link href={`/reservaciones?holdId=${h.id}`} className="underline">
                      abrir
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Listado de reservas */}
      <section className="space-y-2">
        <h2 className="font-semibold">Reservas ({reservations.length})</h2>
        <table className="w-full text-left">
          <thead className="text-zinc-500">
            <tr>
              <th className="py-1">Folio</th>
              <th>Huésped</th>
              <th>Estado</th>
              <th>Fechas</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {reservations.map((r) => (
              <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-900">
                <td className="py-1">{r.folio}</td>
                <td>{r.primary_guest_name}</td>
                <td>{r.status}</td>
                <td>
                  {r.reservation_stays
                    .map((s) => `${s.check_in} → ${s.check_out}`)
                    .join(", ")}
                </td>
                <td>
                  {r.status === "confirmed" && (
                    <form action={submitCancelReservation}>
                      <input type="hidden" name="hotelId" value={hotel.hotelId} />
                      <input type="hidden" name="reservationId" value={r.id} />
                      <button className="text-red-600 underline">cancelar</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Listado de leads */}
      <section className="space-y-2">
        <h2 className="font-semibold">Leads ({leads.length})</h2>
        <table className="w-full text-left">
          <thead className="text-zinc-500">
            <tr>
              <th className="py-1">Nombre</th>
              <th>Estado</th>
              <th>Canal</th>
              <th>Fechas deseadas</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => (
              <tr key={l.id} className="border-t border-zinc-100 dark:border-zinc-900">
                <td className="py-1">{l.guest_name}</td>
                <td>{l.status}</td>
                <td>{l.channel}</td>
                <td>
                  {l.desired_check_in} → {l.desired_check_out}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
