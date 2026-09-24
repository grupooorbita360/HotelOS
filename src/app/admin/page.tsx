import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { isPlatformAdmin, planLabel, FEATURE_KEYS } from "@/lib/auth/platform";
import { signOut } from "@/app/login/actions";
import {
  listPlatformHotels,
  listFeatureCatalog,
  listFeatureOverrides,
  listPlatformAuditEvents,
  type PlatformAuditRow,
} from "@/modules/platform/queries/hotels";
import { Card, CardTitle } from "@/components/ui/Card";
import { Field, TextInput, Select } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Banner } from "@/components/ui/Banner";
import {
  submitCreateHotel,
  submitUpdateHotel,
  submitUpdateHotelLicense,
  submitAssignHotelOwner,
  submitResendOwnerInvite,
  submitSetFeatureOverride,
  submitRemoveFeatureOverride,
  submitResetDemoHotel,
} from "./actions";

const FEATURE_LABELS: Record<string, string> = {
  "module.reservaciones": "Reservaciones",
  "module.recepcion": "Recepción",
  "module.rack": "Rack",
  "module.configuracion": "Configuración",
  "module.mi_hotel_hoy": "Mi Hotel Hoy",
  "module.caja": "Caja",
  "module.housekeeping": "Housekeeping",
  "module.mantenimiento": "Mantenimiento",
  "module.crm": "CRM",
  "module.tarifas": "Tarifas/Revenue",
  "module.radar_360": "Radar 360",
};

const STATUS_BADGE: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" | "info" }> = {
  trial: { label: "Prueba", tone: "info" },
  active: { label: "Activo", tone: "success" },
  suspended: { label: "Suspendido", tone: "danger" },
  canceled: { label: "Cancelado", tone: "neutral" },
};

const PLANS = ["basico", "plus", "pro"] as const;
const STATUSES = ["trial", "active", "suspended", "canceled"] as const;

const AUDIT_EVENT_LABELS: Record<string, string> = {
  "hotel.created": "Hotel creado",
  "hotel.updated": "Datos del hotel editados",
  "hotel.owner_assigned": "Dueño asignado",
  "hotel.license_updated": "Licencia actualizada",
  "hotel.feature_override_set": "Feature override fijado",
  "hotel.feature_override_removed": "Feature override quitado",
};

/** Resumen legible del payload de cada evento de plataforma. */
function auditDetail(eventType: string, payload: Record<string, unknown>): string {
  const str = (v: unknown) => (v == null || v === "" ? null : String(v));
  const limit = (v: unknown) => (v == null ? "∞" : String(v));
  switch (eventType) {
    case "hotel.created": {
      const invited = payload.owner_invited === true;
      return `plan ${str(payload.plan) ?? "?"} · dueño ${str(payload.owner_email) ?? "?"}${invited ? " (invitado)" : " (cuenta existente)"}`;
    }
    case "hotel.updated":
      return `nombre "${str(payload.name) ?? "?"}" · timezone ${str(payload.timezone) ?? "?"}`;
    case "hotel.owner_assigned": {
      const invited = payload.owner_invited === true;
      return `dueño ${str(payload.owner_email) ?? "?"}${invited ? " (invitado)" : " (cuenta existente)"}`;
    }
    case "hotel.license_updated":
      return (
        `plan ${str(payload.plan) ?? "?"} · ${STATUS_BADGE[str(payload.status) ?? ""]?.label ?? str(payload.status) ?? "?"}` +
        ` · hab ${limit(payload.rooms_max)} · usuarios ${limit(payload.users_max)}` +
        ` · vence ${str(payload.expires_at) ?? "nunca"}`
      );
    case "hotel.feature_override_set":
      return `${str(payload.feature_key) ?? "?"} → ${payload.enabled ? "encendida" : "apagada"}${str(payload.reason) ? ` · "${str(payload.reason)}"` : ""}`;
    case "hotel.feature_override_removed":
      return `${str(payload.feature_key) ?? "?"}`;
    default:
      return JSON.stringify(payload);
  }
}

/**
 * Admin de plataforma (Órbita 360). Sólo is_platform_admin(); la barrera
 * real es RLS (todas las escrituras de este módulo son platform_admin_only,
 * ver 0039) — esto corta temprano con mensaje claro.
 */
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; error?: string; msg?: string }>;
}) {
  const params = await searchParams;
  const tab = params.tab ?? "hoteles";

  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const platformAdmin = await isPlatformAdmin();
  if (!platformAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <Card className="max-w-lg space-y-4">
          <CardTitle>Sin acceso</CardTitle>
          <p className="text-sm text-muted-strong">
            Esta área es sólo para el equipo de plataforma de HotelOS.
          </p>
          <form action={signOut}>
            <Button variant="ghost">Cerrar sesión</Button>
          </form>
        </Card>
      </div>
    );
  }

  const [hotels, catalog, overrides, auditEvents] = await Promise.all([
    listPlatformHotels(),
    listFeatureCatalog(),
    listFeatureOverrides(),
    tab === "auditoria" ? listPlatformAuditEvents() : Promise.resolve([] as PlatformAuditRow[]),
  ]);

  const overrideKey = (hotelId: string, featureKey: string) => `${hotelId}:${featureKey}`;
  const overridesByKey = new Map(overrides.map((o) => [overrideKey(o.hotel_id, o.feature_key), o]));
  const catalogEnabled = (featureKey: string, plan: string) =>
    catalog.find((c) => c.feature_key === featureKey && c.plan === plan)?.enabled ?? false;

  // Fuente de verdad del demo: hotels.is_demo (0051), no el slug.
  const demoHotel = hotels.find((h) => h.is_demo);

  return (
    <div className="min-h-screen bg-background px-6 py-8">
      <div className="mx-auto max-w-5xl space-y-6 text-sm">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-brand">HotelOS · Plataforma</h1>
            <p className="text-muted-strong">Administración de hoteles, planes y funciones.</p>
          </div>
          <form action={signOut}>
            <Button variant="ghost">Cerrar sesión</Button>
          </form>
        </header>

        <nav className="flex gap-2">
          {[
            { key: "hoteles", label: "Hoteles" },
            { key: "features", label: "Funciones por plan" },
            { key: "auditoria", label: "Auditoría" },
            { key: "demo", label: "Demo" },
          ].map((t) => (
            <Link
              key={t.key}
              href={`/admin?tab=${t.key}`}
              className={`rounded-lg px-4 py-2 text-sm font-medium ${
                tab === t.key ? "bg-brand text-white" : "bg-border text-foreground hover:bg-border-strong"
              }`}
            >
              {t.label}
            </Link>
          ))}
        </nav>

        {params.error && <Banner tone="danger">{params.error}</Banner>}
        {params.msg && <Banner tone="success">{params.msg}</Banner>}

        {tab === "hoteles" && (
          <div className="space-y-6">
            <Card className="space-y-4">
              <CardTitle>Dar de alta un hotel</CardTitle>
              <form action={submitCreateHotel} className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <Field label="Nombre del hotel">
                  <TextInput name="name" required placeholder="Hotel Blue Garden" />
                </Field>
                <Field label="Slug (único, minúsculas)">
                  <TextInput name="slug" required placeholder="blue-garden" />
                </Field>
                <Field label="Plan">
                  <Select name="plan" defaultValue="basico">
                    {PLANS.map((p) => (
                      <option key={p} value={p}>{planLabel(p)}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Zona horaria">
                  <TextInput name="timezone" defaultValue="America/Mexico_City" />
                </Field>
                <Field label="Correo del dueño">
                  <TextInput name="ownerEmail" type="email" required placeholder="dueno@hotel.com" />
                </Field>
                <Field label="Nombre del dueño">
                  <TextInput name="ownerName" placeholder="Nombre y apellido" />
                </Field>
                <div className="md:col-span-3">
                  <Button type="submit">Crear hotel y enviar invitación</Button>
                </div>
              </form>
              <p className="text-xs text-muted">
                Se crea el hotel, su licencia con los límites del plan, y la política inicial. Si el correo del
                dueño ya tiene cuenta se vincula directo; si no, recibe invitación con el rol hotel_admin. La
                invitación se envía ANTES de crear el hotel: si falla (p. ej. límite de correos de Supabase)
                no queda nada a medias y puedes reintentar. Los límites por defecto: Básico 16 hab / 6 usuarios,
                Plus 40 hab / 15 usuarios, Pro sin límite.
              </p>
            </Card>

            <Card className="space-y-4">
              <CardTitle>Hoteles ({hotels.length})</CardTitle>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-border text-muted-strong">
                      <th className="py-2 pr-3">Hotel</th>
                      <th className="py-2 pr-3">Dueño</th>
                      <th className="py-2 pr-3">Plan</th>
                      <th className="py-2 pr-3">Estado</th>
                      <th className="py-2 pr-3">Habitaciones</th>
                      <th className="py-2 pr-3">Usuarios</th>
                      <th className="py-2 pr-3">Vencimiento</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hotels.map((h) => {
                      const status = STATUS_BADGE[h.status] ?? { label: h.status, tone: "neutral" as const };
                      return (
                        <tr key={h.id} className="border-b border-border">
                <td className="py-2 pr-3 font-medium">
                  {h.name}
                  {h.is_demo && <span className="ml-2 text-muted">(demo)</span>}
                </td>
                <td className="py-2 pr-3">
                  {h.owners.length > 0 ? (
                    <span>
                      {h.owners[0].email}
                      {h.owners.length > 1 && (
                        <span className="text-muted"> +{h.owners.length - 1}</span>
                      )}
                    </span>
                  ) : (
                    <span className="text-muted">sin dueño</span>
                  )}
                          </td>
                          <td className="py-2 pr-3">{planLabel(h.plan)}</td>
                          <td className="py-2 pr-3"><Badge tone={status.tone}>{status.label}</Badge></td>
                          <td className="py-2 pr-3">
                            <span className={h.license?.rooms_max != null && (h.usage?.rooms_active ?? 0) >= h.license.rooms_max ? "font-semibold text-danger" : ""}>
                              {h.usage?.rooms_active ?? 0} / {h.license?.rooms_max ?? "∞"}
                            </span>
                            {h.license?.rooms_max != null && (h.usage?.rooms_active ?? 0) >= h.license.rooms_max && (
                              <span className="ml-2 inline-block rounded-full bg-danger-soft px-2 py-0.5 text-[10px] font-semibold text-danger">al límite</span>
                            )}
                          </td>
                          <td className="py-2 pr-3">
                            <span className={h.license?.users_max != null && (h.usage?.users_active ?? 0) >= h.license.users_max ? "font-semibold text-danger" : ""}>
                              {h.usage?.users_active ?? 0} / {h.license?.users_max ?? "∞"}
                            </span>
                            {h.license?.users_max != null && (h.usage?.users_active ?? 0) >= h.license.users_max && (
                              <span className="ml-2 inline-block rounded-full bg-danger-soft px-2 py-0.5 text-[10px] font-semibold text-danger">al límite</span>
                            )}
                          </td>
                          <td className="py-2 pr-3">
                            {h.license?.expires_at
                              ? new Date(h.license.expires_at).toLocaleDateString("es-MX")
                              : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="space-y-4 border-t border-border pt-4">
                {hotels.map((h) => (
                <div key={h.id} className="rounded-lg bg-background p-3">
                  <form
                    action={submitUpdateHotel}
                    className="grid grid-cols-2 items-end gap-3 md:grid-cols-3"
                  >
                    <input type="hidden" name="hotelId" value={h.id} />
                    <Field label={`Datos · ${h.slug}`}>
                      <TextInput name="name" required defaultValue={h.name} />
                    </Field>
                    <Field label="Zona horaria (IANA)">
                      <TextInput name="timezone" defaultValue={h.timezone} placeholder="America/Mexico_City" />
                    </Field>
                    <div className="flex items-center gap-2">
                      <Button type="submit" variant="secondary" className="shrink-0">Guardar datos</Button>
                      <span className="text-xs text-muted">
                        Nombre y timezone. El plan se edita abajo, en la licencia.
                      </span>
                    </div>
                  </form>

                  <form
                    action={submitUpdateHotelLicense}
                    className="mt-3 grid grid-cols-2 items-end gap-3 border-t border-border pt-3 md:grid-cols-6"
                  >
                    <input type="hidden" name="hotelId" value={h.id} />
                    <Field label={h.name}>
                      <Select name="plan" defaultValue={h.plan}>
                        {PLANS.map((p) => (
                          <option key={p} value={p}>{planLabel(p)}</option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Estado">
                      <Select name="status" defaultValue={h.status}>
                        {STATUSES.map((s) => (
                          <option key={s} value={s}>{STATUS_BADGE[s]?.label ?? s}</option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Máx. habitaciones (vacío = ∞)">
                      <TextInput name="roomsMax" type="number" min={1}
                        defaultValue={h.license?.rooms_max ?? ""} />
                    </Field>
                    <Field label="Máx. usuarios (vacío = ∞)">
                      <TextInput name="usersMax" type="number" min={1}
                        defaultValue={h.license?.users_max ?? ""} />
                    </Field>
                    <Field label="Vence (vacío = nunca)">
                      <TextInput name="expiresAt" type="date"
                        defaultValue={h.license?.expires_at?.slice(0, 10) ?? ""} />
                    </Field>
                    <div className="flex items-center gap-2">
                      <TextInput name="notes" placeholder="Nota" defaultValue={h.license?.notes ?? ""} />
                      <Button type="submit" variant="secondary" className="shrink-0">Guardar</Button>
                    </div>
                    <p className="col-span-2 text-xs text-muted md:col-span-6">
                      Suspender desactiva a todo el personal del hotel (bloqueo enforcementado por RLS, no sólo por
                      la interfaz). Reactivar restaura sólo a quienes la suspensión desactivó.
                    </p>
                  </form>

                  {h.owners.length > 0 ? (
                    <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-3 text-xs">
                      <span className="text-muted">Dueño:</span>
                      <span className="font-medium">{h.owners.map((o) => o.email).join(", ")}</span>
                      <form action={submitResendOwnerInvite} className="ml-auto flex items-center gap-2">
                        <input type="hidden" name="ownerEmail" value={h.owners[0].email ?? ""} />
                        <Button type="submit" variant="ghost">Reenviar invitación</Button>
                      </form>
                      <span className="text-muted">
                        Sólo si aún no aceptó la invitación; si ya tiene cuenta, entra con su contraseña.
                      </span>
                    </div>
                  ) : (
                    <form action={submitAssignHotelOwner} className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-3">
                      <input type="hidden" name="hotelId" value={h.id} />
                      <span className="text-xs font-medium text-danger">Sin dueño asignado</span>
                      <TextInput name="ownerEmail" type="email" required placeholder="Correo del dueño" className="!mt-0 w-56" />
                      <TextInput name="ownerName" placeholder="Nombre (opcional)" className="!mt-0 w-44" />
                      <Button type="submit" variant="secondary">Asignar dueño</Button>
                      <span className="text-xs text-muted">
                        Si el correo ya tiene cuenta se vincula; si no, recibe invitación por correo.
                      </span>
                    </form>
                  )}
                </div>
                ))}
              </div>
            </Card>
          </div>
        )}

        {tab === "features" && (
          <Card className="space-y-4">
            <CardTitle>Funciones por plan</CardTitle>
            <p className="text-xs text-muted">
              El catálogo plan → función vive en <code>plan_features</code> (una fila, no un deploy). Los overrides
              por hotel se crean abajo; el override siempre gana sobre el plan.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-border text-muted-strong">
                    <th className="py-2 pr-3">Función</th>
                    <th className="py-2 pr-3">Básico</th>
                    <th className="py-2 pr-3">Plus</th>
                    <th className="py-2 pr-3">Pro</th>
                  </tr>
                </thead>
                <tbody>
                  {FEATURE_KEYS.map((key) => (
                    <tr key={key} className="border-b border-border">
                      <td className="py-2 pr-3 font-medium">{FEATURE_LABELS[key] ?? key}</td>
                      {PLANS.map((p) => (
                        <td key={p} className="py-2 pr-3">
                          {catalogEnabled(key, p) ? "✅" : "—"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-3 border-t border-border pt-4">
              <h3 className="font-semibold">Overrides por hotel</h3>
              {hotels.map((h) => (
                <details key={h.id} className="rounded-lg bg-background p-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    {h.name} <span className="text-muted">({planLabel(h.plan)})</span>
                  </summary>
                  <div className="mt-3 space-y-2">
                    {FEATURE_KEYS.map((key) => {
                      const existing = overridesByKey.get(overrideKey(h.id, key));
                      const effective = existing
                        ? existing.enabled
                        : catalogEnabled(key, h.plan);
                      return (
                        <div key={key} className="flex flex-wrap items-center gap-3 rounded border border-border px-3 py-2">
                          <span className="w-40 font-medium">{FEATURE_LABELS[key] ?? key}</span>
                          <Badge tone={effective ? "success" : "neutral"}>
                            {effective ? "Encendida" : "Apagada"}
                          </Badge>
                          {existing && (
                            <span className="text-xs text-muted">
                              override: {existing.enabled ? "on" : "off"}
                              {existing.reason ? ` · ${existing.reason}` : ""}
                            </span>
                          )}
                          <form action={submitSetFeatureOverride} className="ml-auto flex items-center gap-2">
                            <input type="hidden" name="hotelId" value={h.id} />
                            <input type="hidden" name="featureKey" value={key} />
                            <input type="hidden" name="enabled" value={existing?.enabled ? "off" : "on" } />
                            <TextInput name="reason" placeholder="Motivo" className="!mt-0 w-40" />
                            <Button type="submit" variant="secondary">
                              {existing?.enabled ? "Apagar" : "Encender"}
                            </Button>
                          </form>
                          {existing && (
                            <form action={submitRemoveFeatureOverride}>
                              <input type="hidden" name="hotelId" value={h.id} />
                              <input type="hidden" name="featureKey" value={key} />
                              <Button type="submit" variant="ghost">Quitar override</Button>
                            </form>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </details>
              ))}
            </div>
          </Card>
        )}

        {tab === "auditoria" && (
          <Card className="space-y-4">
            <CardTitle>Auditoría de plataforma</CardTitle>
            <p className="text-xs text-muted">
              Acciones del equipo de plataforma sobre hoteles (altas, ediciones, licencias, dueños y
              overrides), leídas de <code>timeline_events</code> — la misma bitácora append-only que usa
              el resto del sistema, sin tabla nueva.
            </p>
            {auditEvents.length === 0 ? (
              <p className="text-sm text-muted">Todavía no hay eventos de plataforma registrados.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-border text-muted-strong">
                      <th className="py-2 pr-3">Fecha</th>
                      <th className="py-2 pr-3">Actor</th>
                      <th className="py-2 pr-3">Hotel</th>
                      <th className="py-2 pr-3">Acción</th>
                      <th className="py-2 pr-3">Detalle</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditEvents.map((e) => (
                      <tr key={e.id} className="border-b border-border align-top">
                        <td className="whitespace-nowrap py-2 pr-3 text-muted">
                          {new Date(e.occurred_at).toLocaleString("es-MX")}
                        </td>
                        <td className="py-2 pr-3">{e.actor_email ?? "—"}</td>
                        <td className="py-2 pr-3 font-medium">{e.hotel_name ?? e.hotel_id}</td>
                        <td className="whitespace-nowrap py-2 pr-3">
                          {AUDIT_EVENT_LABELS[e.event_type] ?? e.event_type}
                        </td>
                        <td className="py-2 pr-3 text-muted-strong">{auditDetail(e.event_type, e.payload)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}

        {tab === "demo" && (
          <Card className="space-y-4">
            <CardTitle>Hotel Demo</CardTitle>
            <p className="text-xs text-muted">
              La demo vive dentro de este proyecto como el hotel marcado con <code>is_demo</code> (hoy el de slug{" "}
              <code>hotel-demo</code>): mismo código, misma base de datos, aislamiento garantizado por la RLS
              multi-tenant que ya existe. El botón borra todo el dato operativo de ese hotel y lo regenera con ~7
              semanas de historial anclado a la fecha actual: estancias cerradas (ocupación, ADR, ingresos por
              día/semana), un no-show, cancelaciones, 3 estancias en casa con saldos parciales, llegadas futuras,
              solicitudes, incidencias y timeline real para los KPIs. No toca a otros hoteles ni las membresías: la
              cuenta demo sigue funcionando después.
            </p>

            {demoHotel ? (
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <Badge tone={STATUS_BADGE[demoHotel.status]?.tone ?? "neutral"}>
                  {STATUS_BADGE[demoHotel.status]?.label ?? demoHotel.status}
                </Badge>
                <span>{planLabel(demoHotel.plan)}</span>
                <span className="text-muted">
                  {demoHotel.usage?.rooms_active ?? 0} habitaciones activas · slug{" "}
                  <code>{demoHotel.slug}</code>
                </span>
              </div>
            ) : (
              <p className="text-xs text-muted">
                Aún no existe un hotel con <code>is_demo</code>: el primer reinicio lo crea automáticamente (plan
                Pro, sin límites, status activo).
              </p>
            )}

            <form action={submitResetDemoHotel} className="space-y-3">
              <label className="flex items-start gap-2 text-xs text-muted-strong">
                <input type="checkbox" name="confirm" className="mt-0.5 accent-brand" />
                Entiendo que se borran todos los datos del Hotel Demo y se regeneran desde cero. Esta acción no se
                puede deshacer.
              </label>
              <Button type="submit" variant="secondary">
                Reiniciar datos del Hotel Demo
              </Button>
            </form>

            <p className="text-xs text-muted">
              Reset manual a propósito: en la fase de pruebas un reset automático destruiría los datos que el
              equipo genera explorando el sistema. Cuando la demo se vuelva pública, la misma función se puede
              programar como cron nocturno (migración 0050, <code>public.reset_demo_hotel()</code>).
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}
