import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "@/app/login/actions";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";

/**
 * Pantalla de hotel suspendido/cancelado. Se llega aquí desde el login
 * (login/actions.ts) cuando el usuario no tiene membresías activas pero sí
 * pertenecía a un hotel suspendido. Los accesos a datos ya están bloqueados
 * por RLS (la suspensión desactiva las membresías, ver 0039); esto sólo
 * explica la situación.
 */
export default async function SuspendidoPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const supabase = await createClient();
  const { data: suspended } = await supabase.rpc("user_has_suspended_membership");

  // Si la membresía ya se reactivó (hotel restaurado), volver a operar.
  if (!suspended) redirect("/reservaciones");

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <Card className="max-w-lg space-y-4 text-sm">
        <CardTitle>Tu acceso a HotelOS está suspendido</CardTitle>
        <p className="text-muted-strong">
          El acceso de tu hotel fue suspendido o cancelado por el equipo de Órbita 360, probablemente por
          vencimiento de la licencia. Tus datos están seguros y no se han borrado.
        </p>
        <p className="text-muted-strong">
          Para reactivar el acceso, contacta a soporte con el correo con el que inicias sesión.
        </p>
        <form action={signOut}>
          <Button variant="ghost">Cerrar sesión</Button>
        </form>
      </Card>
    </div>
  );
}
