const TONES = {
  success: "bg-success-soft text-emerald-800 border-emerald-200",
  danger: "bg-danger-soft text-red-800 border-red-200",
  warning: "bg-warning-soft text-amber-900 border-amber-200",
  info: "bg-info-soft text-blue-800 border-blue-200",
} as const;

export function Banner({ tone, children }: { tone: keyof typeof TONES; children: string }) {
  return <p className={`rounded-lg border px-4 py-2.5 text-sm ${TONES[tone]}`}>{children}</p>;
}
