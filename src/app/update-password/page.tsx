import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { updatePassword } from "./actions";
import { Card } from "@/components/ui/Card";
import { Field, TextInput } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";

/**
 * Pantalla "define tu contraseña" — destino de recovery e invitación de
 * dueño (issue #8). Sin sesión (llegó directo, sin pasar por el enlace del
 * correo) no hay nada que actualizar: al login con explicación.
 */
export default async function UpdatePasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const user = await getCurrentUser();

  if (!user) {
    redirect(`/login?error=${encodeURIComponent("Tu enlace expiró o ya fue usado. Solicita uno nuevo.")}`);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <Card className="w-full max-w-sm">
        <h1 className="mb-2 text-center text-xl font-bold text-foreground">Define tu contraseña</h1>
        <p className="mb-5 text-center text-sm text-muted-strong">
          {user.email} — elige una contraseña de al menos 6 caracteres.
        </p>

        {params.error && (
          <div className="mb-4">
            <Banner tone="danger">{params.error}</Banner>
          </div>
        )}

        <form action={updatePassword} className="space-y-4">
          <Field label="Contraseña nueva">
            <TextInput name="password" type="password" required minLength={6} placeholder="••••••••" />
          </Field>
          <Field label="Confirmar contraseña">
            <TextInput name="confirm" type="password" required minLength={6} placeholder="••••••••" />
          </Field>
          <Button className="w-full pt-1">Guardar contraseña</Button>
        </form>
      </Card>
    </div>
  );
}
