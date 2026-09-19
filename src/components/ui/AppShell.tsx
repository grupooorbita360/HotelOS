import Link from "next/link";
import type { ReactNode } from "react";
import { signOut } from "@/app/login/actions";
import { brandStyleVars } from "@/lib/color";

/**
 * Módulos del menú y la feature de plataforma que los enciende/apaga
 * (catálogo plan_features, ver migración 0039). El menú nunca muestra un
 * módulo que el plan del hotel no incluye.
 */
const MODULES = [
  { key: "reservaciones", label: "Reservaciones", href: "/reservaciones", icon: "📅", feature: "module.reservaciones" },
  { key: "recepcion", label: "Recepción", href: "/recepcion", icon: "🛎️", feature: "module.recepcion" },
  { key: "rack", label: "Rack", href: "/rack", icon: "🗓️", feature: "module.rack" },
  { key: "configuracion", label: "Configuración", href: "/configuracion", icon: "⚙️", feature: "module.configuracion" },
  { key: "caja", label: "Caja", href: "/caja", icon: "💰", feature: "module.caja" },
] as const;

/**
 * Menú lateral fijo (no se pierde al hacer scroll) -- reemplaza el header
 * superior que se iba con el contenido. El contenido de cada página vive en
 * <main>, que es lo único que hace scroll; el <aside> queda con position
 * fixed a la izquierda todo el tiempo.
 */
export function AppShell({
  hotelName,
  roleName,
  current,
  resetHref,
  brandColor,
  maxWidthClassName = "max-w-5xl",
  features,
  children,
}: {
  hotelName: string;
  roleName: string | null;
  current: (typeof MODULES)[number]["key"];
  resetHref: string;
  brandColor?: string | null;
  maxWidthClassName?: string;
  /** Features habilitadas para el hotel (hotel_enabled_features). Si no se
   *  pasa, se muestran todos los módulos (comportamiento anterior). */
  features?: string[];
  children: ReactNode;
}) {
  const visibleModules = features
    ? MODULES.filter((m) => features.includes(m.feature))
    : MODULES;

  return (
    <div className="min-h-screen bg-background" style={brandStyleVars(brandColor)}>
      <aside className="fixed inset-y-0 left-0 z-10 flex w-60 flex-col justify-between overflow-y-auto bg-gradient-to-b from-brand to-brand-dark px-4 py-6 text-white">
        <div>
          <h1 className="truncate px-2 text-lg font-bold" title={hotelName}>
            {hotelName}
          </h1>
          <p className="px-2 text-xs text-white/70">Rol: {roleName ?? "—"}</p>

          <nav className="mt-8 space-y-1">
            {visibleModules.map((m) => (
              <Link
                key={m.key}
                href={m.href}
                className={`block rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                  current === m.key ? "bg-white/20" : "text-white/85 hover:bg-white/10"
                }`}
              >
                {m.icon} {m.label}
              </Link>
            ))}
            <Link
              href={resetHref}
              className="block rounded-lg px-3 py-2.5 text-sm text-white/60 transition-colors hover:bg-white/10"
            >
              ↺ Reiniciar
            </Link>
          </nav>
        </div>

        <form action={signOut}>
          <button className="w-full rounded-lg px-3 py-2.5 text-left text-sm text-white/70 transition-colors hover:bg-white/10 hover:text-white">
            Cerrar sesión
          </button>
        </form>
      </aside>

      <main className="ml-60 px-6 py-8">
        <div className={`mx-auto space-y-6 text-sm ${maxWidthClassName}`}>{children}</div>
      </main>
    </div>
  );
}
