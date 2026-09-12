"use client";

import { useMemo, useState } from "react";
import { Field, TextInput } from "@/components/ui/Field";

export interface GuestSearchOption {
  id: string;
  guest_name: string;
  guest_email: string | null;
  guest_phone: string | null;
}

/**
 * Campo de nombre del huésped con autocompletado contra leads históricos del
 * hotel (ya cargados en la página, sin ida y vuelta al servidor): buscar por
 * nombre/correo/teléfono y, al elegir uno, rellenar correo/teléfono también.
 * Si no elige ninguna sugerencia, lo que escriba se manda tal cual como
 * huésped nuevo -- mismo campo, sin un modo "buscar" vs "crear" separado.
 */
export function GuestSearchField({
  leads,
  defaultName = "",
  defaultEmail = "",
  defaultPhone = "",
}: {
  leads: GuestSearchOption[];
  defaultName?: string;
  defaultEmail?: string;
  defaultPhone?: string;
}) {
  const [name, setName] = useState(defaultName);
  const [email, setEmail] = useState(defaultEmail);
  const [phone, setPhone] = useState(defaultPhone);
  const [open, setOpen] = useState(false);

  const matches = useMemo(() => {
    const q = name.trim().toLowerCase();
    if (q.length < 2) return [];
    return leads
      .filter(
        (l) =>
          l.guest_name.toLowerCase().includes(q) ||
          (l.guest_phone ?? "").includes(q) ||
          (l.guest_email ?? "").toLowerCase().includes(q),
      )
      .slice(0, 6);
  }, [leads, name]);

  return (
    <div className="relative col-span-2 md:col-span-4">
      <Field label="Nombre del huésped (busca por nombre, correo o teléfono)">
        <TextInput
          name="guestName"
          required
          autoComplete="off"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
      </Field>
      {open && matches.length > 0 && (
        <div className="absolute z-10 mt-1 w-full rounded-lg border border-border bg-surface shadow-lg">
          {matches.map((l) => (
            <button
              key={l.id}
              type="button"
              onMouseDown={() => {
                setName(l.guest_name);
                setEmail(l.guest_email ?? "");
                setPhone(l.guest_phone ?? "");
                setOpen(false);
              }}
              className="block w-full border-b border-border px-3.5 py-2 text-left last:border-0 hover:bg-brand-soft"
            >
              <b>{l.guest_name}</b>
              <p className="text-xs text-muted">
                {[l.guest_phone, l.guest_email].filter(Boolean).join(" · ") || "sin datos de contacto"}
              </p>
            </button>
          ))}
        </div>
      )}
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Field label="Email">
          <TextInput name="guestEmail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Teléfono">
          <TextInput name="guestPhone" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
      </div>
    </div>
  );
}
