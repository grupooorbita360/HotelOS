import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { HotelLimitUsage } from "@/lib/auth/platform";

export interface PlatformHotelRow {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  timezone: string;
  is_demo: boolean;
  created_at: string;
  license: {
    rooms_max: number | null;
    users_max: number | null;
    expires_at: string | null;
    notes: string | null;
  } | null;
  usage: HotelLimitUsage | null;
}

/**
 * Lista completa de hoteles para el admin de plataforma (/admin).
 * Sólo plataforma puede leer todos los hoteles (RLS); las llamadas a esta
 * función deben ir precedidas de requirePlatformAdmin().
 */
export async function listPlatformHotels(): Promise<PlatformHotelRow[]> {
  const supabase = await createClient();

  const { data: hotels, error } = await supabase
    .from("hotels")
    .select("id, name, slug, plan, status, timezone, is_demo, created_at, hotel_licenses(rooms_max, users_max, expires_at, notes)")
    .order("created_at", { ascending: true });
  if (error) throw error;

  const rows: PlatformHotelRow[] = [];
  for (const hotel of hotels ?? []) {
    const { data: usage, error: usageError } = await supabase.rpc("hotel_limit_usage", {
      p_hotel_id: hotel.id,
    });
    if (usageError) throw usageError;

    const license = Array.isArray(hotel.hotel_licenses)
      ? (hotel.hotel_licenses[0] ?? null)
      : (hotel.hotel_licenses ?? null);

    rows.push({
      id: hotel.id,
      name: hotel.name,
      slug: hotel.slug,
      plan: hotel.plan,
      status: hotel.status,
      timezone: hotel.timezone,
      is_demo: hotel.is_demo,
      created_at: hotel.created_at,
      license,
      usage: usage as HotelLimitUsage | null,
    });
  }

  return rows;
}

export interface FeatureCatalogRow {
  feature_key: string;
  plan: string;
  enabled: boolean;
}

/** Catálogo completo plan_features (matriz plan x feature para la UI). */
export async function listFeatureCatalog(): Promise<FeatureCatalogRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("plan_features")
    .select("feature_key, plan, enabled")
    .order("feature_key", { ascending: true });
  if (error) throw error;
  return (data ?? []) as FeatureCatalogRow[];
}

export interface FeatureOverrideRow {
  hotel_id: string;
  feature_key: string;
  enabled: boolean;
  reason: string | null;
}

export async function listFeatureOverrides(): Promise<FeatureOverrideRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("hotel_feature_overrides")
    .select("hotel_id, feature_key, enabled, reason");
  if (error) throw error;
  return (data ?? []) as FeatureOverrideRow[];
}
