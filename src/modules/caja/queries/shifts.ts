import "server-only";
import { createClient } from "@/lib/supabase/server";

export interface CashShift {
  id: string;
  status: string;
  fondoInicial: number;
  openedAt: string;
  efectivoContado: number | null;
  efectivoEsperado: number | null;
  diferencia: number | null;
  closedAt: string | null;
  notes: string | null;
}

function mapShift(s: {
  id: string;
  status: string;
  fondo_inicial: number;
  opened_at: string;
  efectivo_contado: number | null;
  efectivo_esperado: number | null;
  diferencia: number | null;
  closed_at: string | null;
  notes: string | null;
}): CashShift {
  return {
    id: s.id,
    status: s.status,
    fondoInicial: s.fondo_inicial,
    openedAt: s.opened_at,
    efectivoContado: s.efectivo_contado,
    efectivoEsperado: s.efectivo_esperado,
    diferencia: s.diferencia,
    closedAt: s.closed_at,
    notes: s.notes,
  };
}

export async function getOpenShift(hotelId: string): Promise<CashShift | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("cash_shifts")
    .select("id, status, fondo_inicial, opened_at, efectivo_contado, efectivo_esperado, diferencia, closed_at, notes")
    .eq("hotel_id", hotelId)
    .eq("status", "open")
    .maybeSingle();
  if (error) throw error;
  return data ? mapShift(data) : null;
}

export async function listShiftHistory(hotelId: string, limit = 20): Promise<CashShift[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("cash_shifts")
    .select("id, status, fondo_inicial, opened_at, efectivo_contado, efectivo_esperado, diferencia, closed_at, notes")
    .eq("hotel_id", hotelId)
    .order("opened_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data.map(mapShift);
}

export interface CashMovement {
  id: string;
  type: string;
  source: string;
  amount: number;
  concept: string;
  category: string | null;
  createdAt: string;
}

export async function listShiftMovements(shiftId: string): Promise<CashMovement[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("cash_movements")
    .select("id, type, source, amount, concept, category, created_at")
    .eq("cash_shift_id", shiftId)
    .order("created_at", { ascending: false });
  if (error) throw error;

  return data.map((m) => ({
    id: m.id,
    type: m.type,
    source: m.source,
    amount: m.amount,
    concept: m.concept,
    category: m.category,
    createdAt: m.created_at,
  }));
}
