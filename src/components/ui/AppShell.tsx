import Link from "next/link";
import type { ReactNode } from "react";
import { signOut } from "@/app/login/actions";
import { selectHotel, selectLocale } from "@/lib/auth/actions";
import { brandStyleVars } from "@/lib/color";
import { getLocale, shellT } from "@/lib/i18n";
import { scheduleHotelRuleEvaluation } from "@/modules/priorities/engine";

/**
 * Módulos del menú y la feature de plataforma que los enciende/apaga
 * (catálogo plan_features, ver migración 0039). El menú nunca muestra un
 * módulo que el plan del hotel no incluye. Las etiquetas se traducen vía
 * shellT() -- ver `src/lib/i18n.ts`.
 */
const MODULES = [
  { key: "reservaciones", labelKey: "module.reservaciones", href: "/reservaciones", icon: "📅", feature: "module.reservaciones" },
  { key: "recepcion", labelKey: "module.recepcion", href: "/recepcion", icon: "🛎️", feature: "module.recepcion" },
  { key: "rack", labelKey: "module.rack", href: "/rack", icon: "🗓️", feature: "module.rack" },
  { key: "configuracion", labelKey: "module.configuracion", href: "/configuracion", icon: "⚙️", feature: "module.configuracion" },
  { key: "caja", labelKey: "module.caja", href: "/caja", icon: "💰", feature: "module.caja" },
] as const;

/**
 * Menú lateral fijo (no se pierde al hacer scroll) -- reemplaza el header
 * superior que se iba con el contenido. El contenido de cada página vive en
 * <main>, que es lo único que hace scroll; el <aside> queda con position
 * fixed a la izquierda todo el tiempo.
 *
 * Server Component async (P1-2, handoff de demo): lee el idioma actual
 * directamente de la cookie (`getLocale()`) en vez de que cada una de las 5
 * páginas de módulo tenga que resolverlo y pasarlo como prop -- el shell es
 * el único que lo necesita hoy (i18n de esta ronda es sólo el chrome, ver
 * `src/lib/i18n.ts`).
 */
export async function AppShell({
  hotelId,
  hotelName,
  userDisplayName,
  roleName,
  current,
  resetHref,
  brandColor,
  brandLogoUrl,
  maxWidthClassName = "max-w-5xl",
  features,
  otherHotels,
  children,
}: {
  hotelId: string;
  hotelName: string;
  /** Nombre del usuario (profiles.full_name, o su correo si no lo ha llenado). */
  userDisplayName?: string | null;
  roleName: string | null;
  current: (typeof MODULES)[number]["key"];
  resetHref: string;
  brandColor?: string | null;
  /** URL del logo del hotel (hotel_policies.extra_settings.logo_url) -- si no hay, se muestra sólo el nombre. */
  brandLogoUrl?: string | null;
  maxWidthClassName?: string;
  /** Features habilitadas para el hotel (hotel_enabled_features). Si no se
   *  pasa, se muestran todos los módulos (comportamiento anterior). */
  features?: string[];
  /** Otras membresías activas del usuario (getCurrentUserHotel().otherHotels)
   *  -- si viene vacío/undefined, un usuario de un solo hotel no ve selector. */
  otherHotels?: { hotelId: string; hotelName: string }[];
  children: ReactNode;
}) {
  const visibleModules = features
    ? MODULES.filter((m) => features.includes(m.feature))
    : MODULES;
  const locale = await getLocale();
  const t = (key: Parameters<typeof shellT>[1]) => shellT(locale, key);

  // P2-2 (Motor de Prioridades, ver CLAUDE.md): único punto de invocación
  // real de evaluateHotelRules() -- AppShell es el único componente
  // compartido por las 5 páginas de módulo, así que una regla como
  // HOLD_EXPIRING_SOON se dispara sin importar en qué pantalla esté el
  // usuario. scheduleHotelRuleEvaluation() ya trae su propio cooldown en
  // memoria y corre después de que la respuesta ya se mandó (after()) --
  // esta llamada nunca añade latencia perceptible a la página.
  await scheduleHotelRuleEvaluation(hotelId);

  return (
    <div className="min-h-screen bg-background" style={brandStyleVars(brandColor)}>
      <aside className="fixed inset-y-0 left-0 z-10 flex w-60 flex-col justify-between overflow-y-auto bg-gradient-to-b from-brand to-brand-dark px-4 py-6 text-white">
        <div>
          <div className="flex items-center gap-2 px-2">
            {brandLogoUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- logo por URL externa arbitraria, sin dominio fijo que configurar en next.config
              <img src={brandLogoUrl} alt="" className="h-8 w-8 shrink-0 rounded object-contain" />
            )}
            <h1 className="truncate text-lg font-bold" title={hotelName}>
              {hotelName}
            </h1>
          </div>
          {userDisplayName && <p className="truncate px-2 text-sm font-medium text-white" title={userDisplayName}>{userDisplayName}</p>}
          <p className="px-2 text-xs text-white/70">
            {t("role")}: <span className="rounded bg-white/15 px-1.5 py-0.5 font-medium">{roleName ?? "—"}</span>
          </p>

          {otherHotels && otherHotels.length > 0 && (
            <form action={selectHotel} className="mt-3 px-2">
              <input type="hidden" name="returnTo" value={resetHref} />
              <label className="block text-[11px] uppercase tracking-wide text-white/60">{t("switchHotel")}</label>
              <div className="mt-1 flex gap-1.5">
                <select
                  name="hotelId"
                  defaultValue={hotelId}
                  className="w-full rounded-md border border-white/20 bg-white/10 px-2 py-1.5 text-xs text-white outline-none focus:border-white/40"
                >
                  <option value={hotelId}>{hotelName}</option>
                  {otherHotels.map((h) => (
                    <option key={h.hotelId} value={h.hotelId} className="text-foreground">
                      {h.hotelName}
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  className="shrink-0 rounded-md bg-white/15 px-2 py-1.5 text-xs font-medium text-white hover:bg-white/25"
                >
                  {t("go")}
                </button>
              </div>
            </form>
          )}

          <form action={selectLocale} className="mt-3 px-2">
            <input type="hidden" name="returnTo" value={resetHref} />
            <label className="block text-[11px] uppercase tracking-wide text-white/60">{t("language")}</label>
            <div className="mt-1 flex gap-1.5">
              <select
                name="locale"
                defaultValue={locale}
                className="w-full rounded-md border border-white/20 bg-white/10 px-2 py-1.5 text-xs text-white outline-none focus:border-white/40"
              >
                <option value="es" className="text-foreground">Español</option>
                <option value="en" className="text-foreground">English</option>
              </select>
              <button
                type="submit"
                className="shrink-0 rounded-md bg-white/15 px-2 py-1.5 text-xs font-medium text-white hover:bg-white/25"
              >
                {t("go")}
              </button>
            </div>
          </form>

          <nav className="mt-8 space-y-1">
            {visibleModules.map((m) => (
              <Link
                key={m.key}
                href={m.href}
                className={`block rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                  current === m.key ? "bg-white/20" : "text-white/85 hover:bg-white/10"
                }`}
              >
                {m.icon} {t(m.labelKey)}
              </Link>
            ))}
            <Link
              href={resetHref}
              className="block rounded-lg px-3 py-2.5 text-sm text-white/60 transition-colors hover:bg-white/10"
            >
              ↺ {t("reset")}
            </Link>
          </nav>
        </div>

        <form action={signOut}>
          <button className="w-full rounded-lg px-3 py-2.5 text-left text-sm text-white/70 transition-colors hover:bg-white/10 hover:text-white">
            {t("signOut")}
          </button>
        </form>
      </aside>

      <main className="ml-60 px-6 py-8">
        <div className={`mx-auto space-y-6 text-sm ${maxWidthClassName}`}>{children}</div>
      </main>
    </div>
  );
}
