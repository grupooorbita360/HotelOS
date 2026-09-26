const TONES = {
  success: "bg-success-soft text-emerald-700",
  warning: "bg-warning-soft text-amber-800",
  danger: "bg-danger-soft text-red-700",
  info: "bg-info-soft text-blue-700",
  neutral: "bg-border text-muted-strong",
} as const;

/** Estado en lenguaje simple con color, no el nombre técnico crudo (ver CLAUDE.md S5 "experiencia del usuario"). */
export function Badge({ tone, children }: { tone: keyof typeof TONES; children: string }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-semibold ${TONES[tone]}`}>
      {children}
    </span>
  );
}

const RESERVATION_STATUS: Record<string, { label: string; tone: keyof typeof TONES }> = {
  confirmed: { label: "Confirmada", tone: "success" },
  cancelled: { label: "Cancelada", tone: "neutral" },
  no_show: { label: "No-show", tone: "danger" },
  completed: { label: "Completada", tone: "info" },
};

const LEAD_STATUS: Record<string, { label: string; tone: keyof typeof TONES }> = {
  new: { label: "Nuevo", tone: "neutral" },
  contacted: { label: "Contactado", tone: "info" },
  quoted: { label: "Cotizado", tone: "info" },
  negotiating: { label: "Negociando", tone: "warning" },
  waitlisted: { label: "Lista de espera", tone: "warning" },
  converted: { label: "Convertido", tone: "success" },
  lost: { label: "Perdido", tone: "neutral" },
};

const HOLD_STATUS: Record<string, { label: string; tone: keyof typeof TONES }> = {
  active: { label: "Esperando confirmación", tone: "warning" },
  converted: { label: "Convertido en reserva", tone: "success" },
  expired: { label: "Vencido", tone: "danger" },
  released: { label: "Liberado", tone: "neutral" },
  cancelled: { label: "Cancelado", tone: "neutral" },
};

export function ReservationStatusBadge({ status }: { status: string }) {
  const s = RESERVATION_STATUS[status] ?? { label: status, tone: "neutral" as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function LeadStatusBadge({ status }: { status: string }) {
  const s = LEAD_STATUS[status] ?? { label: status, tone: "neutral" as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function HoldStatusBadge({ status }: { status: string }) {
  const s = HOLD_STATUS[status] ?? { label: status, tone: "neutral" as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

const STAY_STATUS: Record<string, { label: string; tone: keyof typeof TONES }> = {
  expected: { label: "Se espera hoy", tone: "neutral" },
  arrived: { label: "Llegó, falta check-in", tone: "warning" },
  checked_in: { label: "Check-in hecho", tone: "info" },
  in_house: { label: "En casa", tone: "success" },
  checked_out: { label: "Check-out hecho", tone: "neutral" },
  no_show: { label: "No se presentó", tone: "danger" },
  walked: { label: "Walked", tone: "danger" },
};

export function StayStatusBadge({ status }: { status: string }) {
  const s = STAY_STATUS[status] ?? { label: status, tone: "neutral" as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

// P2-3 (enrutamiento de solicitudes/incidencias): mismo catálogo de status
// para guest_requests/stay_incidents excepto en sus dos terminales
// distintos (completed/cancelled vs. resolved) -- un solo mapa cubre
// ambos, la clave que no aplica a una tabla simplemente nunca aparece ahí.
const SERVICE_ITEM_STATUS: Record<string, { label: string; tone: keyof typeof TONES }> = {
  open: { label: "Nueva", tone: "neutral" },
  assigned: { label: "Asignada", tone: "info" },
  in_progress: { label: "En curso", tone: "warning" },
  completed: { label: "Completada", tone: "success" },
  resolved: { label: "Resuelta", tone: "success" },
  cancelled: { label: "Cancelada", tone: "neutral" },
};

export function ServiceItemStatusBadge({ status }: { status: string }) {
  const s = SERVICE_ITEM_STATUS[status] ?? { label: status, tone: "neutral" as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

const NEXT_ACTION_LABEL: Record<string, string> = {
  registrar_llegada: "Registrar llegada",
  hacer_checkin: "Hacer check-in",
  asignar_habitacion: "Asignar habitación",
  entregar_habitacion: "Entregar habitación",
  cobrar_saldo: "Cobrar saldo",
  ninguna: "Sin acción pendiente",
};

export function nextActionLabel(action: string): string {
  return NEXT_ACTION_LABEL[action] ?? action;
}
