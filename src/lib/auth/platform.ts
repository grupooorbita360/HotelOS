import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * Capa de plataforma (staff de HotelOS / Órbita 360), separada de la capa de
 * hotel (permissions.ts). La autorización real vive en Postgres:
 * is_platform_admin() + RLS. Esto es el refuerzo de UX, igual que
 * requirePermission() para los hoteles (ver CLAUDE.md, principio 2).
 */

export class PlatformAdminError extends Error {
  constructor() {
    super("Esta acción requiere ser administrador de plataforma de HotelOS.");
    this.name = "PlatformAdminError";
  }
}

export async function isPlatformAdmin(): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("is_platform_admin");
  if (error) throw error;
  return data === true;
}

/** Lanza PlatformAdminError si el usuario autenticado no es staff de plataforma. */
export async function requirePlatformAdmin(): Promise<void> {
  const allowed = await isPlatformAdmin();
  if (!allowed) throw new PlatformAdminError();
}

/**
 * Feature keys conocidos. Espejo del catálogo sembrado en plan_features
 * (migración 0039). La fuente de verdad de si una feature está encendida es
 * has_feature() / hotel_enabled_features() en Postgres; esta lista sirve
 * para tipar y para iterar sin strings mágicos.
 */
export const FEATURE_KEYS = [
  "module.reservaciones",
  "module.recepcion",
  "module.rack",
  "module.configuracion",
  "module.mi_hotel_hoy",
  "module.caja",
  "module.housekeeping",
  "module.mantenimiento",
  "module.crm",
  "module.tarifas",
  "module.radar_360",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export interface HotelLimitUsage {
  rooms_active: number;
  rooms_max: number | null;
  users_active: number;
  users_max: number | null;
}

export async function getHotelLimitUsage(hotelId: string): Promise<HotelLimitUsage> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("hotel_limit_usage", { p_hotel_id: hotelId });
  if (error) throw error;
  return data as HotelLimitUsage;
}

/**
 * Lanza un error legible si agregar una habitación excede el límite del plan.
 * Se llama ANTES de insertar (ver createRoom en configuracion/actions/rooms).
 */
export async function assertRoomLimit(hotelId: string, planLabel: string): Promise<void> {
  const usage = await getHotelLimitUsage(hotelId);
  if (usage.rooms_max !== null && usage.rooms_active >= usage.rooms_max) {
    throw new Error(
      `Tu plan ${planLabel} permite máximo ${usage.rooms_max} habitación(es). ` +
        `Actualiza tu plan o desactiva habitaciones que ya no uses.`,
    );
  }
}

/** Igual que assertRoomLimit, para altas de personal. */
export async function assertUserLimit(hotelId: string, planLabel: string): Promise<void> {
  const usage = await getHotelLimitUsage(hotelId);
  if (usage.users_max !== null && usage.users_active >= usage.users_max) {
    throw new Error(
      `Tu plan ${planLabel} permite máximo ${usage.users_max} usuario(s). ` +
        `Actualiza tu plan o desactiva usuarios que ya no trabajen contigo.`,
    );
  }
}

/** Features habilitadas para el hotel (plan + overrides). Set para lookup O(1). */
export async function getHotelFeatures(hotelId: string): Promise<Set<FeatureKey>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("hotel_enabled_features", { p_hotel_id: hotelId });
  if (error) throw error;
  return new Set(data as FeatureKey[]);
}

export const PLAN_LABELS: Record<string, string> = {
  basico: "Básico",
  plus: "Plus",
  pro: "Pro",
};

export const PLAN_DEFAULT_LIMITS: Record<string, { roomsMax: number | null; usersMax: number | null }> = {
  basico: { roomsMax: 16, usersMax: 6 },
  plus: { roomsMax: 40, usersMax: 15 },
  pro: { roomsMax: null, usersMax: null },
};

export function planLabel(plan: string): string {
  return PLAN_LABELS[plan] ?? plan;
}
