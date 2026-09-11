import { signIn, signUp } from "./actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  const params = await searchParams;

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-6 dark:bg-black">
      <div className="w-full max-w-sm space-y-4">
        <h1 className="text-xl font-semibold text-black dark:text-zinc-50">HotelOS</h1>

        {params.error && (
          <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {params.error}
          </p>
        )}
        {params.message && (
          <p className="rounded bg-blue-50 px-3 py-2 text-sm text-blue-700 dark:bg-blue-950 dark:text-blue-300">
            {params.message}
          </p>
        )}

        <form className="space-y-3">
          <div>
            <label className="block text-sm text-zinc-600 dark:text-zinc-400">Correo</label>
            <input
              name="email"
              type="email"
              required
              className="mt-1 w-full rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </div>
          <div>
            <label className="block text-sm text-zinc-600 dark:text-zinc-400">Contraseña</label>
            <input
              name="password"
              type="password"
              required
              minLength={6}
              className="mt-1 w-full rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </div>
          <div className="flex gap-2">
            <button
              formAction={signIn}
              className="flex-1 rounded bg-black px-3 py-2 text-sm font-medium text-white dark:bg-zinc-50 dark:text-black"
            >
              Entrar
            </button>
            <button
              formAction={signUp}
              className="flex-1 rounded border border-zinc-300 px-3 py-2 text-sm font-medium dark:border-zinc-700"
            >
              Crear cuenta
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
