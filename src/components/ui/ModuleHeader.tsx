import Link from "next/link";
import { signOut } from "@/app/login/actions";

const MODULES = [
  { key: "reservaciones", label: "Reservaciones", href: "/reservaciones" },
  { key: "recepcion", label: "Recepción", href: "/recepcion" },
  { key: "configuracion", label: "Configuración", href: "/configuracion" },
] as const;

/** Header compartido de las páginas de módulo: título + navegación a la derecha (nunca a la izquierda, mezclada con el texto). */
export function ModuleHeader({
  title,
  hotelName,
  roleName,
  current,
  resetHref,
}: {
  title: string;
  hotelName: string;
  roleName: string | null;
  current: (typeof MODULES)[number]["key"];
  resetHref: string;
}) {
  const otherModules = MODULES.filter((m) => m.key !== current);

  return (
    <header className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-gradient-to-r from-brand to-brand-dark px-6 py-5 text-white shadow-sm">
      <div>
        <h1 className="text-xl font-bold">
          {title} — {hotelName}
        </h1>
        <p className="text-white/80">Rol: {roleName ?? "—"}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {otherModules.map((m) => (
          <Link
            key={m.key}
            href={m.href}
            className="rounded-lg bg-white/15 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-white/25"
          >
            {m.label}
          </Link>
        ))}
        <Link
          href={resetHref}
          className="rounded-lg bg-white/15 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-white/25"
        >
          reiniciar
        </Link>
        <form action={signOut}>
          <button className="rounded-lg px-3 py-1.5 text-sm font-medium text-white/80 transition-colors hover:bg-white/10 hover:text-white">
            Cerrar sesión
          </button>
        </form>
      </div>
    </header>
  );
}
