import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/types/database.types";

/**
 * Cliente de Supabase para Server Components, Server Actions y Route
 * Handlers. Opera con la sesión del usuario autenticado (anon key + cookies),
 * por lo que toda lectura/escritura pasa por RLS: este es el cliente que
 * deben usar todas las acciones de los módulos (reservaciones, recepción,
 * caja, etc.). Nunca usar el cliente admin (service role) para servir una
 * petición normal de usuario.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Se llamó desde un Server Component sin permiso de escritura de
            // cookies. El middleware (src/middleware.ts) se encarga de
            // refrescar la sesión en cada request, así que esto es seguro de ignorar.
          }
        },
      },
    },
  );
}
