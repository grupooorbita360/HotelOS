import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

/**
 * Cliente con la service role key: IGNORA Row Level Security por completo.
 *
 * Uso permitido SOLO para operaciones de sistema/plataforma que no ocurren
 * en el contexto de un usuario final (ej. jobs administrativos, webhooks
 * verificados, scripts de soporte). NUNCA usar este cliente para atender una
 * petición normal de un usuario del hotel: eso rompería el principio de
 * aislamiento multi-tenant y de permisos reales en servidor (ver CLAUDE.md).
 *
 * SUPABASE_SERVICE_ROLE_KEY nunca debe exponerse al cliente/navegador ni
 * tener el prefijo NEXT_PUBLIC_.
 */
export function createAdminClient() {
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}
