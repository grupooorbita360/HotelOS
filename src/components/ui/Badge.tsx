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
