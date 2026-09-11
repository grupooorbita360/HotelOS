import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * Capa de permisos para usar en Server Actions y Route Handlers.
 *
 * Esto es un refuerzo de UX (mensajes de error claros, cortar temprano antes
 * de tocar la base de datos), NO el mecanismo de seguridad real: la
 * autorización real vive en Postgres vía RLS + la función has_permission()
 * (ver supabase/migrations/0005_permission_helpers.sql). Aunque alguien se
 * salte esta capa, RLS sigue bloqueando la operación.
 */
export class PermissionError extends Error {
  constructor(permissionCode: string) {
    super(`No tienes el permiso requerido: ${permissionCode}`);
    this.name = "PermissionError";
  }
}

export async function hasPermission(hotelId: string, permissionCode: string): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("has_permission", {
    p_hotel_id: hotelId,
    p_permission_code: permissionCode,
  });

  if (error) throw error;
  return data === true;
}

/** Lanza PermissionError si el usuario autenticado no tiene el permiso en ese hotel. */
export async function requirePermission(hotelId: string, permissionCode: string): Promise<void> {
  const allowed = await hasPermission(hotelId, permissionCode);
  if (!allowed) throw new PermissionError(permissionCode);
}
