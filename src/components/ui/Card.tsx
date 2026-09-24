import type { ReactNode } from "react";

export function Card({
  children,
  className = "",
  id,
}: {
  children: ReactNode;
  className?: string;
  /** P1-1 (handoff de demo): permite anclar un KPI a esta sección (`href="#id"`). */
  id?: string;
}) {
  return (
    <div id={id} className={`rounded-2xl bg-surface p-6 shadow-sm ${className}`}>{children}</div>
  );
}

export function CardTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-lg font-semibold text-foreground">{children}</h2>;
}
