import type { ButtonHTMLAttributes } from "react";

const VARIANTS = {
  primary: "bg-brand text-white hover:bg-brand-dark",
  secondary: "bg-border text-foreground hover:bg-border-strong",
  danger: "bg-danger text-white hover:bg-red-700",
  ghost: "text-muted underline hover:text-foreground",
} as const;

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof VARIANTS }) {
  const base =
    variant === "ghost"
      ? "text-sm font-medium disabled:opacity-50"
      : "rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";

  return <button className={`${base} ${VARIANTS[variant]} ${className}`} {...props} />;
}
