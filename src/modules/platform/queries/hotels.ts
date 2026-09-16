import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { HotelLimitUsage } from "@/lib/auth/platform";

export interface PlatformHotelOwner {
  email: string | null;
  name: string | null;
}

export interface PlatformHotelRow {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  timezone: string;
  created_at: string;
  license: {
    rooms_max: number | null;
    users_max: number | null;
    expires_at: string | null;
    notes: string | null;
  } | null;
  usage: HotelLimitUsage | null;
  owners: PlatformHotelOwner[];
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
    .select("id, name, slug, plan, status, timezone, created_at, hotel_licenses(rooms_max, users_max, expires_at, notes)")
    .order("created_at", { ascending: true });
  if (error) throw error;

  // Dueños activos (rol hotel_admin) de todos los hoteles en una sola pasada.
  const ownersByHotel = new Map<string, PlatformHotelOwner[]>();
  const hotelIds = (hotels ?? []).map((h) => h.id);
  if (hotelIds.length > 0) {
    const { data: adminRole } = await supabase
      .from("roles")
      .select("id")
      .eq("name", "hotel_admin")
      .is("hotel_id", null)
      .single();

    if (adminRole) {
      const { data: memberships, error: ownersError } = await supabase
        .from("user_hotel_roles")
        .select("hotel_id, profiles(email, full_name)")
        .eq("role_id", adminRole.id)
        .eq("is_active", true)
        .in("hotel_id", hotelIds);
      if (ownersError) throw ownersError;

      for (const membership of memberships ?? []) {
        const profile = Array.isArray(membership.profiles)
          ? membership.profiles[0]
          : membership.profiles;
        const list = ownersByHotel.get(membership.hotel_id) ?? [];
        list.push({ email: profile?.email ?? null, name: profile?.full_name ?? null });
        ownersByHotel.set(membership.hotel_id, list);
      }
    }
  }

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
      created_at: hotel.created_at,
      license,
      usage: usage as HotelLimitUsage | null,
      owners: ownersByHotel.get(hotel.id) ?? [],
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
