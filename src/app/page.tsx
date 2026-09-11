export default function Home() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-zinc-50 px-6 text-center dark:bg-black">
      <h1 className="text-3xl font-semibold tracking-tight text-black dark:text-zinc-50">
        HotelOS
      </h1>
      <p className="max-w-md text-zinc-600 dark:text-zinc-400">
        Base del proyecto lista: Next.js + Supabase + Tailwind, multi-tenant
        y con RLS activo desde el día 1. Los módulos (Reservaciones, Rack,
        Recepción, Habitaciones, Caja) se construyen a partir de aquí — ver{" "}
        <code className="rounded bg-black/[.06] px-1 py-0.5 font-mono text-sm dark:bg-white/[.08]">
          CLAUDE.md
        </code>
        .
      </p>
    </div>
  );
}
