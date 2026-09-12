import Link from "next/link";
import { Button } from "@/components/ui/Button";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <h1 className="text-3xl font-bold tracking-tight text-brand">HotelOS</h1>
      <p className="max-w-md text-muted-strong">
        Base del proyecto lista: Next.js + Supabase + Tailwind, multi-tenant y con RLS activo desde el día 1. Módulo
        activo:{" "}
        <Link href="/reservaciones" className="font-medium text-brand underline">
          Reservaciones
        </Link>
        . Ver <code className="rounded bg-border px-1.5 py-0.5 font-mono text-sm">CLAUDE.md</code> para principios y
        esquema.
      </p>
      <Link href="/login">
        <Button>Iniciar sesión</Button>
      </Link>
    </div>
  );
}
