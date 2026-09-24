import "server-only";
import { createClient } from "@/lib/supabase/server";

export interface ReservationSummary {
  id: string;
  folio: string;
  primaryGuestName: string;
  status: string;
}

/**
 * Lectura minima de reservations propia de Caja (regla 7: los modulos no
 * se importan entre si -- mismo patron que Configuracion leyendo
 * hotel_policies por su cuenta en vez de importar Reservaciones).
 */
export async function findReservationsByFolioOrGuest(hotelId: string, search: string): Promise<ReservationSummary[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("reservations")
    .select("id, folio, primary_guest_name, status")
    .eq("hotel_id", hotelId)
    .eq("status", "confirmed")
    .or(`folio.ilike.%${search}%,primary_guest_name.ilike.%${search}%`)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  return data.map((r) => ({ id: r.id, folio: r.folio, primaryGuestName: r.primary_guest_name, status: r.status }));
}

export interface PaymentMethod {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  requiereReferencia: boolean;
  requiereAutorizacion: boolean;
  requiereTerminal: boolean;
  permiteMonedaExtranjera: boolean;
  requiereValidacionManual: boolean;
  generaComision: boolean;
  proveedor: string | null;
}

export async function listPaymentMethods(hotelId: string, onlyActive = true): Promise<PaymentMethod[]> {
  const supabase = await createClient();
  let query = supabase
    .from("payment_methods")
    .select(
      "id, name, type, is_active, requiere_referencia, requiere_autorizacion, requiere_terminal, permite_moneda_extranjera, requiere_validacion_manual, genera_comision, proveedor",
    )
    .eq("hotel_id", hotelId)
    .order("name");
  if (onlyActive) query = query.eq("is_active", true);

  const { data, error } = await query;
  if (error) throw error;

  return data.map((m) => ({
    id: m.id,
    name: m.name,
    type: m.type,
    isActive: m.is_active,
    requiereReferencia: m.requiere_referencia,
    requiereAutorizacion: m.requiere_autorizacion,
    requiereTerminal: m.requiere_terminal,
    permiteMonedaExtranjera: m.permite_moneda_extranjera,
    requiereValidacionManual: m.requiere_validacion_manual,
    generaComision: m.genera_comision,
    proveedor: m.proveedor,
  }));
}

export interface ReservationBalance {
  totalVendido: number;
  yaPagado: number;
  /** > 0 = falta por pagar, < 0 = saldo a favor, 0 = liquidada. Nunca se muestra crudo al usuario -- ver formatBalanceLabel(). */
  saldo: number;
}

/**
 * Saldo de una reserva a nivel Caja: lo vendido (reservation_stays.rate_total)
 * menos lo neto pagado (payments.amount ya viene con signo: positivo cobros,
 * negativo reembolsos). Distinto del saldo de Recepción (stay_accounts.balance,
 * 0024) -- ese es el saldo de la Estancia física, éste es el de la Reserva.
 */
export async function getReservationBalance(hotelId: string, reservationId: string): Promise<ReservationBalance> {
  const supabase = await createClient();

  const { data: stays, error: staysError } = await supabase
    .from("reservation_stays")
    .select("rate_total")
    .eq("reservation_id", reservationId);
  if (staysError) throw staysError;

  const { data: payments, error: paymentsError } = await supabase
    .from("payments")
    .select("amount, status")
    .eq("hotel_id", hotelId)
    .eq("reservation_id", reservationId)
    .not("status", "in", "(rejected,voided)");
  if (paymentsError) throw paymentsError;

  const totalVendido = stays.reduce((sum, s) => sum + s.rate_total, 0);
  const yaPagado = payments.reduce((sum, p) => sum + p.amount, 0);

  return { totalVendido, yaPagado, saldo: totalVendido - yaPagado };
}

// formatBalanceLabel() se movió a src/lib/format.ts (P0-8, handoff de
// demo): Recepción necesitaba la misma traducción para stay_accounts.balance
// sin depender de que Caja esté desplegada -- regla 6, un solo lugar.
export { formatBalanceLabel } from "@/lib/format";

export interface ReservationPayment {
  id: string;
  type: string;
  amount: number;
  currency: string;
  status: string;
  notes: string | null;
  createdAt: string;
  movements: { id: string; amount: number; methodName: string; methodType: string; reference: string | null }[];
}

export async function listReservationPayments(hotelId: string, reservationId: string): Promise<ReservationPayment[]> {
  const supabase = await createClient();

  const { data: payments, error } = await supabase
    .from("payments")
    .select("id, type, amount, currency, status, notes, created_at")
    .eq("hotel_id", hotelId)
    .eq("reservation_id", reservationId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  if (payments.length === 0) return [];

  const { data: movements, error: movementsError } = await supabase
    .from("payment_movements")
    .select("id, payment_id, amount, reference, payment_methods(name, type)")
    .in(
      "payment_id",
      payments.map((p) => p.id),
    );
  if (movementsError) throw movementsError;

  return payments.map((p) => ({
    id: p.id,
    type: p.type,
    amount: p.amount,
    currency: p.currency,
    status: p.status,
    notes: p.notes,
    createdAt: p.created_at,
    movements: movements
      .filter((m) => m.payment_id === p.id)
      .map((m) => ({
        id: m.id,
        amount: m.amount,
        methodName: (m.payment_methods as unknown as { name: string; type: string } | null)?.name ?? "?",
        methodType: (m.payment_methods as unknown as { name: string; type: string } | null)?.type ?? "other",
        reference: m.reference,
      })),
  }));
}

export interface PendingValidationPayment {
  id: string;
  reservationId: string;
  reservationFolio: string;
  amount: number;
  currency: string;
  createdAt: string;
}

export async function listPendingValidationPayments(hotelId: string): Promise<PendingValidationPayment[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("payments")
    .select("id, reservation_id, amount, currency, created_at, reservations(folio)")
    .eq("hotel_id", hotelId)
    .eq("status", "pending_validation")
    .order("created_at");
  if (error) throw error;

  return data.map((p) => ({
    id: p.id,
    reservationId: p.reservation_id,
    reservationFolio: (p.reservations as unknown as { folio: string } | null)?.folio ?? "?",
    amount: p.amount,
    currency: p.currency,
    createdAt: p.created_at,
  }));
}
