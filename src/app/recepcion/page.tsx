import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, getCurrentUserHotel } from "@/lib/auth/session";
import { signOut } from "@/app/login/actions";
import { listStays, getStayDetails, listAssignableRooms, getHotelCheckinAssets } from "@/modules/recepcion/queries/stays";
import { Card, CardTitle } from "@/components/ui/Card";
import { Field, TextInput, Select } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { KpiCard } from "@/components/ui/KpiCard";
import { StayStatusBadge, nextActionLabel } from "@/components/ui/Badge";
import {
  submitRegisterArrival,
  submitCheckIn,
  submitAssignRoom,
  submitDeliverRoom,
  submitMarkNoShow,
  submitMarkWalked,
  submitCheckOut,
  submitRegisterTransaction,
  submitVoidTransaction,
  submitCreateGuestRequest,
  submitResolveGuestRequest,
  submitCreateIncident,
  submitResolveIncident,
  submitSetAsset,
} from "./actions";

export default async function RecepcionPage({
  searchParams,
}: {
  searchParams: Promise<{ stayId?: string; error?: string }>;
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

  const stays = await listStays(hotel.hotelId);
  const counts = {
    expected: stays.filter((s) => s.status === "expected").length,
    inHouse: stays.filter((s) => s.status === "in_house").length,
    pendingAction: stays.filter((s) => s.next_action !== "ninguna" && !["checked_out", "no_show", "walked"].includes(s.status)).length,
  };

  const detail = params.stayId ? await getStayDetails(hotel.hotelId, params.stayId) : null;
  const assignableRooms =
    detail && !detail.activeAssignment
      ? await listAssignableRooms(hotel.hotelId, detail.stay.reservation_stays!.room_type_id)
      : [];
  const checkinAssets = detail ? await getHotelCheckinAssets(hotel.hotelId) : [];

  return (
    <div className="min-h-screen bg-background px-6 py-8">
      <div className="mx-auto max-w-6xl space-y-6 text-sm">
        <header className="flex items-center justify-between rounded-2xl bg-gradient-to-r from-brand to-brand-dark px-6 py-5 text-white shadow-sm">
          <div>
            <h1 className="text-xl font-bold">Recepción — {hotel.hotelName}</h1>
            <p className="text-white/80">
              Rol: {hotel.roleName ?? "—"} ·{" "}
              <Link href="/reservaciones" className="underline">
                Reservaciones
              </Link>{" "}
              ·{" "}
              <Link href="/configuracion" className="underline">
                Configuración
              </Link>{" "}
              ·{" "}
              <Link href="/recepcion" className="underline">
                reiniciar
              </Link>
            </p>
          </div>
          <form action={signOut}>
            <button className="text-sm text-white/80 underline hover:text-white">Cerrar sesión</button>
          </form>
        </header>

        <div className="grid grid-cols-3 gap-4">
          <KpiCard label="Llegadas esperadas" value={counts.expected} />
          <KpiCard label="En casa" value={counts.inHouse} />
          <KpiCard label="Con acción pendiente" value={counts.pendingAction} />
        </div>

        {params.error && <Banner tone="danger">{params.error}</Banner>}

        <div className="grid grid-cols-3 gap-6">
          {/* Lista de estancias */}
          <Card className="col-span-1 space-y-3">
            <CardTitle>Estancias ({stays.length})</CardTitle>
            <div className="max-h-[70vh] space-y-2 overflow-auto">
              {stays.map((s) => {
                const rs = s.reservation_stays!;
                const res = rs.reservations!;
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
                      {rs.room_types?.name} · {rs.check_in} → {rs.check_out}
                    </p>
                    <p className="text-xs font-medium text-brand">{nextActionLabel(s.next_action)}</p>
                    {(s.stay_accounts?.balance ?? 0) > 0 && (
                      <p className="text-xs text-danger">Saldo: ${s.stay_accounts?.balance}</p>
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
                    {detail.stay.reservation_stays!.room_types?.name} · {detail.stay.reservation_stays!.check_in} →{" "}
                    {detail.stay.reservation_stays!.check_out}
                  </p>
                  <p>
                    Próxima acción: <strong className="text-brand">{nextActionLabel(detail.stay.next_action)}</strong>
                  </p>

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
                    {detail.stay.status === "arrived" && (
                      <>
                        <form action={submitCheckIn}>
                          <input type="hidden" name="hotelId" value={hotel.hotelId} />
                          <input type="hidden" name="stayId" value={detail.stay.id} />
                          <Button>Hacer check-in</Button>
                        </form>
                        <form action={submitMarkWalked}>
                          <input type="hidden" name="hotelId" value={hotel.hotelId} />
                          <input type="hidden" name="stayId" value={detail.stay.id} />
                          <Button variant="danger">Marcar Walked</Button>
                        </form>
                      </>
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
                  </div>
                </Card>

                {/* Asignar habitacion */}
                {detail.stay.status === "checked_in" && !detail.activeAssignment && (
                  <Card className="space-y-3">
                    <CardTitle>Asignar habitación (equivalente)</CardTitle>
                    {assignableRooms.length === 0 ? (
                      <Banner tone="warning">No hay habitaciones de este tipo disponibles ahora mismo.</Banner>
                    ) : (
                      <form action={submitAssignRoom} className="flex items-end gap-3">
                        <input type="hidden" name="hotelId" value={hotel.hotelId} />
                        <input type="hidden" name="stayId" value={detail.stay.id} />
                        <Field label="Habitación" className="flex-1">
                          <Select name="roomId" required>
                            {assignableRooms.map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.code} {r.is_clean ? "" : "(sucia)"}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Button>Asignar</Button>
                      </form>
                    )}
                  </Card>
                )}

                {/* Cuenta de la estancia */}
                <Card className="space-y-3">
                  <div className="flex items-center justify-between">
                    <CardTitle>Cuenta de la estancia</CardTitle>
                    <b className={detail.stay.reservation_stays ? "" : ""}>
                      Saldo: <span className={detail.stay.stay_accounts && detail.stay.stay_accounts.balance > 0 ? "text-danger" : "text-brand"}>
                        ${detail.stay.stay_accounts?.balance ?? 0}
                      </span>
                    </b>
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

                {/* Activos entregados */}
                <Card className="space-y-3">
                  <CardTitle>Activos entregados</CardTitle>
                  <div className="space-y-2">
                    {checkinAssets.length === 0 && <p className="text-muted">Este hotel no tiene activos configurados en su política de check-in.</p>}
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
                        <div key={r.id} className="flex items-center justify-between rounded-lg bg-brand-soft p-2">
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
                        <div key={i.id} className="flex items-center justify-between rounded-lg bg-warning-soft p-2">
                          <span>
                            {i.description} <span className="text-xs text-muted">({i.severity})</span>
                          </span>
                          {i.status === "open" ? (
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
                      ))}
                    </div>
                  </Card>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
