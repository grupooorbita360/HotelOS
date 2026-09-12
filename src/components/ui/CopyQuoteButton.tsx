"use client";

import { useState } from "react";

/** Copia texto de cotización al portapapeles para pegarlo en WhatsApp/correo -- no hay envío automático todavía. */
export function CopyQuoteButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          // Portapapeles puede fallar sin permisos/HTTPS; no es una accion critica.
        }
      }}
      className="rounded-lg bg-border px-4 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-border-strong"
    >
      {copied ? "¡Copiado!" : "Copiar cotización"}
    </button>
  );
}
