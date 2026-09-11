import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/types/database.types";

/**
 * Cliente de Supabase para Client Components. Usa la anon key: la seguridad
 * real la da RLS en Postgres, no este cliente. Nunca pasar la service role
 * key aquí.
 */
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
