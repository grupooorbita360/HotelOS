import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, getCurrentUserHotel } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { signOut } from "@/app/login/actions";
import { brandStyleVars } from "@/lib/color";
import { listRoomTypes, listRooms } from "@/modules/configuracion/queries/rooms";
import { getHotelPolicies, getReceptionSettings } from "@/modules/configuracion/queries/policies";
import { listHotelStaff, listSystemRoles } from "@/modules/configuracion/queries/staff";
import { Card, CardTitle } from "@/components/ui/Card";
import { Field, TextInput, Select } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { Badge } from "@/components/ui/Badge";
import { ModuleHeader } from "@/components/ui/ModuleHeader";
import {
  submitCreateRoomType,
  submitUpdateRoomType,
  submitSetRoomTypeActive,
  submitCreateRoom,
  submitUpdateRoom,
  submitSetRoomActive,
  submitUpdateHotelPolicies,
  submitUpdateReceptionSettings,
  submitUpdateBrandColor,
  submitAddStaffMember,
  submitChangeStaffRole,
  submitSetStaffActive,
} from "./actions";

const BED_TYPES = [
  { value: "", label: "Sin especificar" },
  { value: "individual", label: "Individual" },
  { value: "matrimonial", label: "Matrimonial" },
  { value: "queen", label: "Queen" },
  { value: "king", label: "King" },
  { value: "litera", label: "Litera" },
  { value: "sofa_cama", label: "Sofá cama" },
];

export default async function ConfiguracionPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    editRoomTypeId?: string;
    editRoomId?: string;
    error?: string;
  }>;
}) {
  const params = await searchParams;

  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const hotel = await getCurrentUserHotel();
  if (!hotel) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <Card className="max-w-lg space-y-4">
          <CardTitle>Tu cuenta no tiene un hotel asignado todavía</CardTitle>
          <form action={signOut}>
            <Button variant="ghost">Cerrar sesión</Button>
          </form>
        </Card>
      </div>
    );
  }

  const [canManageSettings, canManageStaff] = await Promise.all([
    hasPermission(hotel.hotelId, "hotel.settings.manage"),
    hasPermission(hotel.hotelId, "staff.manage"),
  ]);

  if (!canManageSettings && !canManageStaff) {
    return (
      <div className="min-h-screen bg-background px-6 py-8">
        <div className="mx-auto max-w-3xl space-y-6 text-sm">
          <Card className="space-y-3">
            <CardTitle>No tienes acceso a Configuración</CardTitle>
            <p className="text-muted">
              Esta sección requiere el rol <b>hotel_admin</b> de {hotel.hotelName}. Tu rol actual es{" "}
              {hotel.roleName ?? "—"}.
            </p>
            <Link href="/reservaciones" className="text-brand underline">
              Volver a Reservaciones
            </Link>
          </Card>
        </div>
      </div>
    );
  }

  const availableTabs = [
    canManageSettings ? "habitaciones" : null,
    canManageSettings ? "politicas" : null,
    canManageStaff ? "usuarios" : null,
  ].filter((t): t is string => t !== null);
  const tab = availableTabs.includes(params.tab || "") ? (params.tab as string) : availableTabs[0];

  const roomTypes = tab === "habitaciones" ? await listRoomTypes(hotel.hotelId) : [];
  const rooms = tab === "habitaciones" ? await listRooms(hotel.hotelId) : [];
  const editingRoomType = params.editRoomTypeId ? roomTypes.find((rt) => rt.id === params.editRoomTypeId) : null;
  const editingRoom = params.editRoomId ? rooms.find((r) => r.id === params.editRoomId) : null;

  const hotelPolicies = tab === "politicas" ? await getHotelPolicies(hotel.hotelId) : null;
  const receptionSettings = tab === "politicas" ? await getReceptionSettings(hotel.hotelId) : null;

  const staff = tab === "usuarios" ? await listHotelStaff(hotel.hotelId) : [];
  const systemRoles = tab === "usuarios" ? await listSystemRoles() : [];

  const TAB_LABELS: Record<string, string> = {
    habitaciones: "Catálogo de habitaciones",
    politicas: "Políticas del hotel",
    usuarios: "Usuarios y roles",
  };

  return (
    <div className="min-h-screen bg-background px-6 py-8" style={brandStyleVars(hotel.brandColor)}>
      <div className="mx-auto max-w-5xl space-y-6 text-sm">
        <ModuleHeader
          title="Configuración"
          hotelName={hotel.hotelName}
          roleName={hotel.roleName}
          current="configuracion"
          resetHref="/configuracion"
        />

        <div className="flex gap-2 border-b border-border pb-2">
          {availableTabs.map((t) => (
            <Link
              key={t}
              href={`/configuracion?tab=${t}`}
              className={`rounded-lg px-4 py-2 font-medium ${
                tab === t ? "bg-brand text-white" : "text-muted-strong hover:bg-border"
              }`}
            >
              {TAB_LABELS[t]}
            </Link>
          ))}
        </div>

        {params.error && <Banner tone="danger">{params.error}</Banner>}

        {tab === "habitaciones" && (
          <div className="grid grid-cols-2 gap-6">
            <Card className="space-y-4">
              <CardTitle>Tipos de habitación ({roomTypes.length})</CardTitle>
              <p className="text-muted">
                La categoría vendible: lo que Reservaciones cotiza y bloquea. Capacidad, mascotas y tarifa base viven
                aquí, no en la unidad física.
              </p>

              <div className="space-y-2">
                {roomTypes.map((rt) => (
                  <div key={rt.id} className={`rounded-lg border p-3 ${rt.is_active ? "border-border" : "border-border bg-border/40 opacity-60"}`}>
                    <div className="flex items-center justify-between">
                      <b>
                        {rt.name} <span className="font-normal text-muted">({rt.code})</span>
                      </b>
                      <Badge tone={rt.is_active ? "success" : "neutral"}>{rt.is_active ? "Activo" : "Inactivo"}</Badge>
                    </div>
                    <p className="text-muted">
                      {rt.capacity_adults} adultos · {rt.capacity_children} niños ·{" "}
                      {rt.accepts_pets ? "acepta mascotas" : "sin mascotas"} · tarifa base ${rt.base_rate}
                    </p>
                    <div className="mt-2 flex gap-3">
                      <Link href={`/configuracion?tab=habitaciones&editRoomTypeId=${rt.id}`} className="text-brand underline">
                        Editar
                      </Link>
                      <form action={submitSetRoomTypeActive}>
                        <input type="hidden" name="hotelId" value={hotel.hotelId} />
                        <input type="hidden" name="roomTypeId" value={rt.id} />
                        <input type="hidden" name="isActive" value={(!rt.is_active).toString()} />
                        <button className="text-danger underline">{rt.is_active ? "Desactivar" : "Reactivar"}</button>
                      </form>
                    </div>
                  </div>
                ))}
                {roomTypes.length === 0 && <p className="text-muted">Sin tipos de habitación todavía.</p>}
              </div>

              <form
                action={editingRoomType ? submitUpdateRoomType : submitCreateRoomType}
                className="space-y-3 border-t border-border pt-4"
              >
                <input type="hidden" name="hotelId" value={hotel.hotelId} />
                {editingRoomType && <input type="hidden" name="roomTypeId" value={editingRoomType.id} />}
                <p className="font-semibold">{editingRoomType ? `Editando "${editingRoomType.name}"` : "Nuevo tipo de habitación"}</p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Nombre">
                    <TextInput name="name" required defaultValue={editingRoomType?.name} />
                  </Field>
                  <Field label="Código">
                    <TextInput name="code" required defaultValue={editingRoomType?.code} />
                  </Field>
                  <Field label="Capacidad adultos">
                    <TextInput name="capacityAdults" type="number" min={1} defaultValue={editingRoomType?.capacity_adults ?? 2} />
                  </Field>
                  <Field label="Capacidad niños">
                    <TextInput name="capacityChildren" type="number" min={0} defaultValue={editingRoomType?.capacity_children ?? 0} />
                  </Field>
                  <Field label="Tarifa base">
                    <TextInput name="baseRate" type="number" min={0} step="0.01" defaultValue={editingRoomType?.base_rate ?? 0} />
                  </Field>
                  <label className="flex items-center gap-2 self-end pb-2.5 text-muted-strong">
                    <input type="checkbox" name="acceptsPets" className="h-4 w-4" defaultChecked={editingRoomType?.accepts_pets} /> Acepta
                    mascotas
                  </label>
                </div>
                <div className="flex gap-2">
                  <Button>{editingRoomType ? "Guardar cambios" : "Crear tipo"}</Button>
                  {editingRoomType && (
                    <Link href="/configuracion?tab=habitaciones">
                      <Button variant="ghost" type="button">
                        Cancelar
                      </Button>
                    </Link>
                  )}
                </div>
              </form>
            </Card>

            <Card className="space-y-4">
              <CardTitle>Habitaciones físicas ({rooms.length})</CardTitle>
              <p className="text-muted">Unidad real: número, zona/edificio y tipo de cama. Pertenece a un tipo de arriba.</p>

              <div className="max-h-80 space-y-2 overflow-auto">
                {rooms.map((r) => (
                  <div key={r.id} className={`rounded-lg border p-3 ${r.is_active ? "border-border" : "border-border bg-border/40 opacity-60"}`}>
                    <div className="flex items-center justify-between">
                      <b>{r.code}</b>
                      <Badge tone={r.is_active ? "success" : "neutral"}>{r.is_active ? "En venta" : "Fuera de servicio"}</Badge>
                    </div>
                    <p className="text-muted">
                      {(r.room_types as unknown as { name: string } | null)?.name ?? "—"}
                      {r.building ? ` · ${r.building}` : ""}
                      {r.bed_type ? ` · ${r.bed_type}` : ""}
                    </p>
                    <div className="mt-2 flex gap-3">
                      <Link href={`/configuracion?tab=habitaciones&editRoomId=${r.id}`} className="text-brand underline">
                        Editar
                      </Link>
                      <form action={submitSetRoomActive}>
                        <input type="hidden" name="hotelId" value={hotel.hotelId} />
                        <input type="hidden" name="roomId" value={r.id} />
                        <input type="hidden" name="isActive" value={(!r.is_active).toString()} />
                        <button className="text-danger underline">{r.is_active ? "Desactivar" : "Reactivar"}</button>
                      </form>
                    </div>
                  </div>
                ))}
                {rooms.length === 0 && <p className="text-muted">Sin habitaciones todavía.</p>}
              </div>

              <form action={editingRoom ? submitUpdateRoom : submitCreateRoom} className="space-y-3 border-t border-border pt-4">
                <input type="hidden" name="hotelId" value={hotel.hotelId} />
                {editingRoom && <input type="hidden" name="roomId" value={editingRoom.id} />}
                <p className="font-semibold">{editingRoom ? `Editando habitación "${editingRoom.code}"` : "Nueva habitación"}</p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Número/código">
                    <TextInput name="code" required defaultValue={editingRoom?.code} />
                  </Field>
                  <Field label="Tipo de habitación">
                    <Select name="roomTypeId" required defaultValue={editingRoom?.room_type_id}>
                      <option value="">Selecciona…</option>
                      {roomTypes.map((rt) => (
                        <option key={rt.id} value={rt.id}>
                          {rt.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Zona / edificio">
                    <TextInput name="building" placeholder="Ej. Torre A" defaultValue={editingRoom?.building ?? ""} />
                  </Field>
                  <Field label="Tipo de cama">
                    <Select name="bedType" defaultValue={editingRoom?.bed_type ?? ""}>
                      {BED_TYPES.map((b) => (
                        <option key={b.value} value={b.value}>
                          {b.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <div className="flex gap-2">
                  <Button>{editingRoom ? "Guardar cambios" : "Crear habitación"}</Button>
                  {editingRoom && (
                    <Link href="/configuracion?tab=habitaciones">
                      <Button variant="ghost" type="button">
                        Cancelar
                      </Button>
                    </Link>
                  )}
                </div>
              </form>
            </Card>
          </div>
        )}

        {tab === "politicas" && hotelPolicies && receptionSettings && (
          <div className="grid grid-cols-2 gap-6">
            <Card className="col-span-2 space-y-4">
              <CardTitle>Apariencia</CardTitle>
              <form action={submitUpdateBrandColor} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="hotelId" value={hotel.hotelId} />
                <Field label="Color de marca">
                  <input
                    type="color"
                    name="brandColor"
                    defaultValue={
                      (hotelPolicies.extra_settings as { brand_color?: string } | null)?.brand_color ?? "#0F766E"
                    }
                    className="mt-1.5 h-10 w-20 cursor-pointer rounded-lg border border-border-strong bg-surface"
                  />
                </Field>
                <p className="max-w-sm text-muted">
                  Se usa en el encabezado y los acentos de las 3 páginas. Sin motor de branding completo todavía (logo,
                  etc.) — sólo este color.
                </p>
                <Button>Guardar color</Button>
              </form>
            </Card>

            <Card className="space-y-4">
              <CardTitle>Reservaciones y garantía</CardTitle>
              <form action={submitUpdateHotelPolicies} className="space-y-3">
                <input type="hidden" name="hotelId" value={hotel.hotelId} />
                <label className="flex items-center gap-2 text-muted-strong">
                  <input type="checkbox" name="requiresGuarantee" className="h-4 w-4" defaultChecked={hotelPolicies.requires_guarantee} />
                  Requiere garantía para confirmar una reserva
                </label>
                <Field label="Notas de garantía (opcional)">
                  <TextInput name="guaranteeNotes" defaultValue={hotelPolicies.guarantee_notes ?? ""} />
                </Field>
                <label className="flex items-center gap-2 text-muted-strong">
                  <input type="checkbox" name="allowsEarlyCheckin" className="h-4 w-4" defaultChecked={hotelPolicies.allows_early_checkin} />
                  Permite check-in anticipado
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Hora estándar de check-in">
                    <TextInput name="standardCheckinTime" type="time" defaultValue={hotelPolicies.standard_checkin_time} />
                  </Field>
                  <Field label="Hora estándar de check-out">
                    <TextInput name="standardCheckoutTime" type="time" defaultValue={hotelPolicies.standard_checkout_time} />
                  </Field>
                </div>
                <Button>Guardar políticas</Button>
              </form>
            </Card>

            <Card className="space-y-4">
              <CardTitle>Recepción</CardTitle>
              <form action={submitUpdateReceptionSettings} className="space-y-3">
                <input type="hidden" name="hotelId" value={hotel.hotelId} />
                <label className="flex items-center gap-2 text-muted-strong">
                  <input
                    type="checkbox"
                    name="entregaPermiteSaldo"
                    className="h-4 w-4"
                    defaultChecked={receptionSettings.entrega_permite_saldo}
                  />
                  Permite entregar la habitación con saldo pendiente
                </label>
                <label className="flex items-center gap-2 text-muted-strong">
                  <input
                    type="checkbox"
                    name="checkinPermiteSucia"
                    className="h-4 w-4"
                    defaultChecked={receptionSettings.checkin_permite_sucia}
                  />
                  Permite hacer check-in con la habitación sucia
                </label>
                <Field label="Días de gracia antes de poder marcar No-Show">
                  <TextInput name="noshowDiasGracia" type="number" min={0} defaultValue={receptionSettings.noshow_dias_gracia} />
                </Field>
                <label className="flex items-center gap-2 text-muted-strong">
                  <input
                    type="checkbox"
                    name="bloquearCheckoutSaldo"
                    className="h-4 w-4"
                    defaultChecked={receptionSettings.bloquear_checkout_saldo}
                  />
                  Bloquear el check-out si hay saldo pendiente
                </label>
                <Button>Guardar configuración de Recepción</Button>
              </form>
            </Card>
          </div>
        )}

        {tab === "usuarios" && (
          <Card className="space-y-4">
            <CardTitle>Personal de {hotel.hotelName} ({staff.length})</CardTitle>
            <div className="space-y-2">
              {staff.map((s) => {
                const profile = s.profiles as unknown as { full_name: string | null; email: string | null } | null;
                const role = s.roles as unknown as { name: string; description: string | null } | null;
                return (
                  <div key={s.id} className={`rounded-lg border p-3 ${s.is_active ? "border-border" : "border-border bg-border/40 opacity-60"}`}>
                    <div className="flex items-center justify-between">
                      <b>{profile?.full_name || profile?.email || "Invitación pendiente"}</b>
                      <Badge tone={s.is_active ? "success" : "neutral"}>{s.is_active ? "Activo" : "Inactivo"}</Badge>
                    </div>
                    <p className="text-muted">{profile?.email ?? "—"}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-3">
                      <form action={submitChangeStaffRole} className="flex items-center gap-2">
                        <input type="hidden" name="hotelId" value={hotel.hotelId} />
                        <input type="hidden" name="userHotelRoleId" value={s.id} />
                        <Select name="newRoleId" defaultValue={s.role_id} className="!mt-0 !py-1.5 text-xs">
                          {systemRoles.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                        </Select>
                        <button className="text-brand underline">Cambiar rol</button>
                      </form>
                      <form action={submitSetStaffActive}>
                        <input type="hidden" name="hotelId" value={hotel.hotelId} />
                        <input type="hidden" name="userHotelRoleId" value={s.id} />
                        <input type="hidden" name="isActive" value={(!s.is_active).toString()} />
                        <button className="text-danger underline">{s.is_active ? "Desactivar" : "Reactivar"}</button>
                      </form>
                    </div>
                    {role?.description && <p className="mt-1 text-xs text-muted">{role.name}: {role.description}</p>}
                  </div>
                );
              })}
              {staff.length === 0 && <p className="text-muted">Sin personal registrado todavía.</p>}
            </div>

            <form action={submitAddStaffMember} className="space-y-3 border-t border-border pt-4">
              <input type="hidden" name="hotelId" value={hotel.hotelId} />
              <p className="font-semibold">Agregar usuario</p>
              <p className="text-muted">
                Si el correo ya tiene cuenta en HotelOS, se le asigna el rol en este hotel. Si no, se le envía una
                invitación para crear su cuenta.
              </p>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Correo">
                  <TextInput name="email" type="email" required placeholder="persona@hotel.com" />
                </Field>
                <Field label="Nombre (si es cuenta nueva)">
                  <TextInput name="fullName" placeholder="Opcional" />
                </Field>
                <Field label="Rol">
                  <Select name="roleId" required>
                    <option value="">Selecciona…</option>
                    {systemRoles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Button>Agregar</Button>
            </form>
          </Card>
        )}
      </div>
    </div>
  );
}
