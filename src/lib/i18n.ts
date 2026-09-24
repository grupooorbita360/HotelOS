import "server-only";
import { cookies } from "next/headers";

/**
 * i18n shell-only (P1-2, handoff de demo): sólo el "chrome" de la app
 * (AppShell -- menú lateral, roles, botones de sesión/hotel) tiene
 * traducción ES/EN por ahora. Traducir el contenido de cada módulo
 * (Reservaciones/Recepción/Rack/Configuración/Caja -- listados, formularios,
 * mensajes de error de negocio) es un esfuerzo grande aparte (extraer y
 * mantener strings de ~15 archivos), fuera de alcance de esta ronda de bajo
 * riesgo -- decisión explícita del dueño del producto, documentada también
 * en CLAUDE.md. Mismo patrón de persistencia que el selector de hotel
 * (`selected_hotel_id`): cookie httpOnly, Server Action que la fija.
 */
export type Locale = "es" | "en";

export const LOCALE_COOKIE = "locale";

const SHELL_STRINGS = {
  es: {
    "module.reservaciones": "Reservaciones",
    "module.recepcion": "Recepción",
    "module.rack": "Rack",
    "module.configuracion": "Configuración",
    "module.caja": "Caja",
    role: "Rol",
    signOut: "Cerrar sesión",
    reset: "Reiniciar",
    switchHotel: "Cambiar de hotel",
    go: "Ir",
    language: "Idioma",
  },
  en: {
    "module.reservaciones": "Reservations",
    "module.recepcion": "Front Desk",
    "module.rack": "Rack",
    "module.configuracion": "Settings",
    "module.caja": "Cash Register",
    role: "Role",
    signOut: "Sign out",
    reset: "Reset",
    switchHotel: "Switch hotel",
    go: "Go",
    language: "Language",
  },
} as const;

export type ShellStringKey = keyof (typeof SHELL_STRINGS)["es"];

export async function getLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  const value = cookieStore.get(LOCALE_COOKIE)?.value;
  return value === "en" ? "en" : "es";
}

export function shellT(locale: Locale, key: ShellStringKey): string {
  return SHELL_STRINGS[locale][key];
}
