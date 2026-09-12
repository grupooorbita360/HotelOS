export function KpiCard({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <div className="rounded-xl bg-surface p-4 shadow-sm">
      <span className="block text-xs text-muted">{label}</span>
      <b className="mt-1 block text-2xl text-brand">{value}</b>
      {note && <small className="mt-1 block text-muted">{note}</small>}
    </div>
  );
}
