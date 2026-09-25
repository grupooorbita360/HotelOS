import { signIn, signUp, requestPasswordReset } from "./actions";
import { Card } from "@/components/ui/Card";
import { Field, TextInput } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  const params = await searchParams;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <Card className="w-full max-w-sm">
        <h1 className="mb-5 text-center text-xl font-bold text-foreground">HotelOS</h1>

        <div className="mb-4 space-y-2">
          {params.error && <Banner tone="danger">{params.error}</Banner>}
          {params.message && <Banner tone="info">{params.message}</Banner>}
        </div>

        <form className="space-y-4">
          <Field label="Correo electrónico">
            <TextInput name="email" type="email" required placeholder="tu@hotel.com" />
          </Field>
          <Field label="Contraseña">
            <TextInput name="password" type="password" required minLength={6} placeholder="••••••••" />
          </Field>
          <div className="flex gap-2 pt-1">
            <Button formAction={signIn} className="flex-1">
              Iniciar sesión
            </Button>
            <Button formAction={signUp} variant="secondary" className="flex-1">
              Crear cuenta
            </Button>
          </div>
        </form>

        {/* Recovery de contraseña (issue #8): el enlace aterriza en
            /auth/confirm -> /update-password. Respuesta genérica para
            no revelar si el correo existe. */}
        <form action={requestPasswordReset} className="mt-6 space-y-3">
          <p className="text-center text-xs text-muted-strong">¿Olvidaste tu contraseña?</p>
          <TextInput name="email" type="email" required placeholder="tu@hotel.com" />
          <Button variant="secondary" className="w-full">
            Enviar enlace de restablecimiento
          </Button>
        </form>
      </Card>
    </div>
  );
}
