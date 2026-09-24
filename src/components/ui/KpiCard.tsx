import Link from "next/link";

/**
 * P1-1 (handoff de demo): un KPI con `href` navega a su lista filtrada
 * correspondiente (ej. "Llegadas esperadas" -> `?filter=expected`) --
 * mismo componente, sólo cambia de `<div>` a `<Link>` cuando se pasa href,
 * para no duplicar el marcado en cada página que lo use.
 */
export function KpiCard({ label, value, note, href }: { label: string; value: string | number; note?: string; href?: string }) {
  const content = (
    <>
      <span className="block text-xs text-muted">{label}</span>
      <b className="mt-1 block text-2xl text-brand">{value}</b>
      {note && <small className="mt-1 block text-muted">{note}</small>}
    </>
  );
  if (href) {
    return (
      <Link href={href} className="block rounded-xl bg-surface p-4 shadow-sm transition-shadow hover:shadow-md">
        {content}
      </Link>
    );
  }
  return <div className="rounded-xl bg-surface p-4 shadow-sm">{content}</div>;
}
