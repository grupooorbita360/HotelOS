import { redirect } from "next/navigation";
import { getCurrentUser, getCurrentUserHotel } from "@/lib/auth/session";
import { getHotelFeatures } from "@/lib/auth/platform";
import { getHotelBusinessDate } from "@/lib/getHotelBusinessDate";
import { AppShell } from "@/components/ui/AppShell";
import { Card, CardTitle } from "@/components/ui/Card";
import { Field, TextInput, Select } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { KpiCard } from "@/components/ui/KpiCard";
import { Badge } from "@/components/ui/Badge";
import {
  findReservationsByFolioOrGuest,
  listPaymentMethods,
  getReservationBalance,
  formatBalanceLabel,
  listReservationPayments,
  listPendingValidationPayments,
} from "@/modules/caja/queries/payments";
import { getOpenShift, listShiftMovements } from "@/modules/caja/queries/shifts";
import { getCashSettings } from "@/modules/caja/queries/settings";
import {
  submitOpenShift,
  submitCloseShift,
  submitCashExpense,
  submitRegisterPayment,
  submitRegisterRefund,
  submitValidatePayment,
  submitStayAdjustment,
} from "./actions";

const PAYMENT_TYPE_LABELS: Record<string, string> = {
  deposit: "Anticipo",
  installment: "Abono",
  full_payment: "Pago total",
  refund: "Reembolso",
};

export default async function CajaPage({
  searchParams,
}: {
  searchParams: Promise<{
    search?: string;
    reservationId?: string;
    error?: string;
    paid?: string;
    refunded?: string;
    closed?: string;
    validated?: string;
    adjusted?: string;
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
        </Card>
      </div>
    );
  }
  if (hotel.status === "suspended" || hotel.status === "canceled") redirect("/suspendido");

  const features = await getHotelFeatures(hotel.hotelId);
  if (!features.has("module.caja")) {
    return (
      <AppShell
        hotelName={hotel.hotelName}
        roleName={hotel.roleName}
        current="caja"
        resetHref="/caja"
        brandColor={hotel.brandColor}
        features={[...features]}
      >
        <Card className="space-y-3">
          <CardTitle>Caja no está incluido en tu plan</CardTitle>
          <p className="text-sm text-muted-strong">
            Este módulo está deshabilitado para tu hotel. Contacta a Órbita 360 para actualizar tu plan.
          </p>
        </Card>
      </AppShell>
    );
  }

  const [businessDate, shift, cashSettings, pendingValidation] = await Promise.all([
    getHotelBusinessDate(hotel.hotelId),
    getOpenShift(hotel.hotelId),
    getCashSettings(hotel.hotelId),
    listPendingValidationPayments(hotel.hotelId),
  ]);

  const [paymentMethods, shiftMovements] = await Promise.all([
    listPaymentMethods(hotel.hotelId),
    shift ? listShiftMovements(shift.id) : Promise.resolve([]),
  ]);

  const cashInToday = shiftMovements.filter((m) => m.type === "cash_in").reduce((s, m) => s + m.amount, 0);
  const cashOutToday = shiftMovements.filter((m) => m.type === "cash_out").reduce((s, m) => s + m.amount, 0);
  const efectivoEsperadoParcial = shift ? shift.fondoInicial + cashInToday - cashOutToday : 0;

  const searchResults = params.search ? await findReservationsByFolioOrGuest(hotel.hotelId, params.search) : [];

  let selectedBalance: Awaited<ReturnType<typeof getReservationBalance>> | null = null;
  let selectedPayments: Awaited<ReturnType<typeof listReservationPayments>> = [];
  if (params.reservationId) {
    [selectedBalance, selectedPayments] = await Promise.all([
      getReservationBalance(hotel.hotelId, params.reservationId),
      listReservationPayments(hotel.hotelId, params.reservationId),
    ]);
  }

  return (
    <AppShell
      hotelName={hotel.hotelName}
      roleName={hotel.roleName}
      current="caja"
      resetHref="/caja"
      brandColor={hotel.brandColor}
      features={[...features]}
      maxWidthClassName="max-w-6xl"
    >
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Caja</h1>
          <p className="text-sm text-muted">Movimiento real de dinero de la operación — {businessDate}</p>
        </div>

        {params.error && <Banner tone="danger">{params.error}</Banner>}
        {params.paid && <Banner tone="success">Pago registrado.</Banner>}
        {params.refunded && <Banner tone="success">Reembolso registrado.</Banner>}
        {params.closed && <Banner tone="success">Turno cerrado.</Banner>}
        {params.validated && <Banner tone="success">Pago validado.</Banner>}
        {params.adjusted && <Banner tone="success">Ajuste registrado.</Banner>}

        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <KpiCard label="Turno" value={shift ? "Abierto" : "Cerrado"} note={shift ? `Fondo $${shift.fondoInicial}` : undefined} />
          <KpiCard label="Efectivo esperado (parcial)" value={shift ? `$${efectivoEsperadoParcial.toFixed(2)}` : "—"} />
          <KpiCard label="Transferencias por validar" value={pendingValidation.length} />
          <KpiCard label="Métodos de pago activos" value={paymentMethods.length} />
        </div>

        {/* ===== Caja/Turno ===== */}
        <Card className="space-y-4">
          <CardTitle>Caja / Turno</CardTitle>
          {!cashSettings.usaTurnosCaja && (
            <Banner tone="info">Este hotel no usa turnos de caja (configurable en Configuración).</Banner>
          )}
          {!shift ? (
            <form action={submitOpenShift} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="hotelId" value={hotel.hotelId} />
              <Field label="Fondo inicial" className="w-40">
                <TextInput name="fondoInicial" type="number" min={0} step="0.01" defaultValue={0} />
              </Field>
              <Field label="Notas" className="w-64">
                <TextInput name="notes" />
              </Field>
              <Button type="submit">Abrir turno</Button>
            </form>
          ) : (
            <>
              <p className="text-sm text-muted-strong">
                Abierto desde {new Date(shift.openedAt).toLocaleString("es-MX")} · Fondo inicial ${shift.fondoInicial} · Entradas $
                {cashInToday.toFixed(2)} · Salidas ${cashOutToday.toFixed(2)}
              </p>

              <form action={submitCashExpense} className="flex flex-wrap items-end gap-3 border-t border-border pt-3">
                <input type="hidden" name="hotelId" value={hotel.hotelId} />
                <input type="hidden" name="shiftId" value={shift.id} />
                <Field label="Egreso operativo">
                  <TextInput name="concept" placeholder="Ej. Taxi para huésped" />
                </Field>
                <Field label="Categoría" className="w-36">
                  <TextInput name="category" placeholder="taxi, caja_chica..." />
                </Field>
                <Field label="Monto" className="w-32">
                  <TextInput name="amount" type="number" min={0} step="0.01" />
                </Field>
                <Button type="submit" variant="ghost">
                  Registrar egreso
                </Button>
              </form>

              <div className="border-t border-border pt-3">
                <p className="mb-2 font-semibold text-foreground">Movimientos del turno ({shiftMovements.length})</p>
                <div className="space-y-1 text-sm">
                  {shiftMovements.length === 0 && <p className="text-muted">Sin movimientos todavía.</p>}
                  {shiftMovements.map((m) => (
                    <div key={m.id} className="flex justify-between border-b border-border py-1">
                      <span>
                        {m.type === "cash_in" ? "+" : "−"} {m.concept}
                      </span>
                      <span className="text-muted-strong">${m.amount.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              </div>

              <form
                action={submitCloseShift}
                className="flex flex-wrap items-end gap-3 border-t border-border pt-3"
              >
                <input type="hidden" name="hotelId" value={hotel.hotelId} />
                <input type="hidden" name="shiftId" value={shift.id} />
                <Field label="Efectivo contado" className="w-40">
                  <TextInput name="efectivoContado" type="number" min={0} step="0.01" required />
                </Field>
                <Field label="Notas" className="w-64">
                  <TextInput name="notes" />
                </Field>
                <Button type="submit" variant="danger">
                  Cerrar turno
                </Button>
              </form>
            </>
          )}
        </Card>

        {/* ===== Pendientes ===== */}
        {pendingValidation.length > 0 && (
          <Card className="space-y-3">
            <CardTitle>Pendientes de validar</CardTitle>
            {pendingValidation.map((p) => (
              <div key={p.id} className="flex items-center justify-between border-b border-border py-2 text-sm">
                <span>
                  {p.reservationFolio} — ${p.amount} {p.currency} ({new Date(p.createdAt).toLocaleDateString("es-MX")})
                </span>
                <form action={submitValidatePayment}>
                  <input type="hidden" name="hotelId" value={hotel.hotelId} />
                  <input type="hidden" name="paymentId" value={p.id} />
                  <Button type="submit" variant="ghost">
                    Validar
                  </Button>
                </form>
              </div>
            ))}
          </Card>
        )}

        {/* ===== Por cobrar / buscar reserva ===== */}
        <Card className="space-y-4">
          <CardTitle>Por cobrar</CardTitle>
          <form method="GET" className="flex items-end gap-3">
            <Field label="Buscar por folio o huésped">
              <TextInput name="search" defaultValue={params.search} />
            </Field>
            <Button type="submit">Buscar</Button>
          </form>

          {params.search && (
            <div className="space-y-1">
              {searchResults.length === 0 && <p className="text-sm text-muted">Sin resultados.</p>}
              {searchResults.map((r) => (
                <a
                  key={r.id}
                  href={`/caja?reservationId=${r.id}`}
                  className="block rounded-lg border border-border p-3 text-sm hover:border-brand"
                >
                  <b>{r.folio}</b> — {r.primaryGuestName}
                </a>
              ))}
            </div>
          )}

          {params.reservationId && selectedBalance && (
            <div className="space-y-4 border-t border-border pt-4">
              <div className="flex items-center justify-between">
                <p className="font-semibold text-foreground">Saldo de la reserva</p>
                <Badge tone={selectedBalance.saldo > 0 ? "warning" : selectedBalance.saldo < 0 ? "info" : "success"}>
                  {formatBalanceLabel(selectedBalance.saldo)}
                </Badge>
              </div>

              <p className="text-sm text-muted">
                Total vendido ${selectedBalance.totalVendido.toFixed(2)} · Ya pagado ${selectedBalance.yaPagado.toFixed(2)}
              </p>

              <form action={submitRegisterPayment} className="space-y-3 rounded-lg border border-border p-4">
                <input type="hidden" name="hotelId" value={hotel.hotelId} />
                <input type="hidden" name="reservationId" value={params.reservationId} />
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="Tipo" className="w-40">
                    <Select name="type" defaultValue="deposit">
                      <option value="deposit">Anticipo</option>
                      <option value="installment">Abono</option>
                      <option value="full_payment">Pago total</option>
                    </Select>
                  </Field>
                </div>
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex flex-wrap items-end gap-3">
                    <Field label={`Método ${i + 1}`} className="w-40">
                      <Select name={`method_${i}`} defaultValue="">
                        <option value="">—</option>
                        {paymentMethods.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Monto" className="w-32">
                      <TextInput name={`amount_${i}`} type="number" min={0} step="0.01" />
                    </Field>
                    <Field label="Referencia" className="w-40">
                      <TextInput name={`reference_${i}`} />
                    </Field>
                  </div>
                ))}
                <label className="flex items-center gap-2 text-sm text-muted-strong">
                  <input type="checkbox" name="confirmOverpayment" className="h-4 w-4" />
                  Confirmo registrar aunque supere el saldo pendiente (saldo a favor)
                </label>
                <Button type="submit">Registrar pago</Button>
              </form>

              <details className="rounded-lg border border-border p-4">
                <summary className="cursor-pointer font-semibold text-foreground">Registrar reembolso</summary>
                <form action={submitRegisterRefund} className="mt-3 flex flex-wrap items-end gap-3">
                  <input type="hidden" name="hotelId" value={hotel.hotelId} />
                  <input type="hidden" name="reservationId" value={params.reservationId} />
                  <Field label="Pago original (opcional)" className="w-56">
                    <Select name="originalPaymentId" defaultValue="">
                      <option value="">—</option>
                      {selectedPayments
                        .filter((p) => p.amount > 0)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {PAYMENT_TYPE_LABELS[p.type] ?? p.type} — ${p.amount}
                          </option>
                        ))}
                    </Select>
                  </Field>
                  <Field label="Monto" className="w-32">
                    <TextInput name="amount" type="number" min={0} step="0.01" />
                  </Field>
                  <Field label="Método" className="w-40">
                    <Select name="paymentMethodId" defaultValue="">
                      <option value="">—</option>
                      {paymentMethods.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Motivo" className="w-56">
                    <TextInput name="reason" required />
                  </Field>
                  <Button type="submit" variant="danger">
                    Reembolsar
                  </Button>
                </form>
              </details>

              <div>
                <p className="mb-2 font-semibold text-foreground">Pagos de esta reserva ({selectedPayments.length})</p>
                <div className="space-y-1 text-sm">
                  {selectedPayments.map((p) => (
                    <div key={p.id} className="flex items-center justify-between border-b border-border py-2">
                      <span>
                        {PAYMENT_TYPE_LABELS[p.type] ?? p.type} — ${p.amount} {p.currency}{" "}
                        {p.movements.length > 1 && (
                          <span className="text-muted">
                            ({p.movements.map((m) => `${m.methodName} $${m.amount}`).join(" + ")})
                          </span>
                        )}
                      </span>
                      <Badge
                        tone={
                          p.status === "completed"
                            ? "success"
                            : p.status === "pending_validation"
                              ? "warning"
                              : p.status === "rejected" || p.status === "voided"
                                ? "danger"
                                : "neutral"
                        }
                      >
                        {p.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </Card>

        {/* ===== Ajuste manual de estancia (avanzado) ===== */}
        <Card className="space-y-3">
          <details>
            <summary className="cursor-pointer font-semibold text-foreground">Ajuste manual de una estancia</summary>
            <form action={submitStayAdjustment} className="mt-3 flex flex-wrap items-end gap-3">
              <input type="hidden" name="hotelId" value={hotel.hotelId} />
              <Field label="ID de la estancia (stay_id)" className="w-72">
                <TextInput name="stayId" required />
              </Field>
              <Field label="Monto (+ cargo / − crédito)" className="w-40">
                <TextInput name="amount" type="number" step="0.01" required />
              </Field>
              <Field label="Motivo" className="w-64">
                <TextInput name="concept" required />
              </Field>
              <Button type="submit" variant="ghost">
                Registrar ajuste
              </Button>
            </form>
          </details>
        </Card>
      </div>
    </AppShell>
  );
}
