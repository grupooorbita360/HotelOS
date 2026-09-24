"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

/**
 * Popup de edición (P1-11, handoff de demo): editar un tipo de habitación o
 * una habitación física dejó de saltar al formulario "crear nuevo" al final
 * de la lista (perdiendo el scroll de donde estaba el usuario) -- ahora abre
 * como overlay sobre la misma posición de scroll.
 *
 * `<dialog>` nativo en vez de una librería de modales: el estado real sigue
 * viviendo en la URL (`?editRoomTypeId=`, mismo patrón ya establecido en
 * este proyecto), este componente sólo sincroniza open/close del elemento
 * con esa prop -- cerrar (Escape, click fuera, o el botón ✕) navega a
 * `closeHref` (la URL sin el parámetro de edición), nunca borra el
 * parámetro con JS suelto.
 */
export function Modal({
  open,
  title,
  closeHref,
  children,
}: {
  open: boolean;
  title: string;
  closeHref: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={() => router.push(closeHref, { scroll: false })}
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close();
      }}
      // Centrado explícito: el reset de Tailwind (preflight) pone margin:0
      // en todos los elementos, incluido <dialog> -- sin esto pierde el
      // auto-centrado nativo del navegador y queda pegado a la esquina.
      className="fixed top-1/2 left-1/2 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-0 text-sm text-foreground shadow-xl backdrop:bg-black/40"
    >
      <div className="max-h-[85vh] space-y-4 overflow-auto p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-foreground">{title}</h2>
          <button
            type="button"
            onClick={() => ref.current?.close()}
            className="text-lg leading-none text-muted hover:text-foreground"
            aria-label="Cerrar"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
